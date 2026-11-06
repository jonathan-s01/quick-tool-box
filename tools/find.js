// Find in a document: reads a document once, then gives you a search page for line numbers,
// amounts and words. The search page is in lib/find.js.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { which, userError } from '../lib/system.js';
import { plural } from '../lib/files.js';
import { languageOption } from '../lib/tesseract-langs.js';
import { pymupdfCommand, pymupdfMissing, pdfDoc } from '../lib/pymupdf.js';
import { toPdf, ocrIfNeeded, sofficePath, DOC_ACCEPT } from '../lib/to-pdf.js';
import { buildIndex, storeDocument, MODES } from '../lib/find.js';

export default {
  id: 'find',
  name: 'Find in a document',
  summary: 'Search a document, such as a tax return, T4 slip or statement, for a line number, box number, amount or words. Each result gives the amount that goes with it and the whole line it is on. 15000, 15,000 and line 15000 all find the same thing. Several ways of reading the page can be tried.',
  submitLabel: 'Read document',
  input: {
    label: 'Document',
    help: 'A PDF (fillable forms too), a scan or photo, or a Word, OpenDocument, RTF or text file.',
    accept: DOC_ACCEPT,
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await pymupdfCommand())) result.missing.push(pymupdfMissing());
    const [ocr, soffice] = await Promise.all([which('ocrmypdf'), sofficePath()]);
    if (!ocr) result.notes.push({ what: 'Scans and photos need OCRmyPDF so their text can be read. PDFs that already have text work without it.', install: process.platform === 'darwin' ? 'brew install ocrmypdf' : 'apt install ocrmypdf' });
    if (!soffice) result.notes.push({ what: 'Word and other office files need LibreOffice.', install: process.platform === 'darwin' ? 'brew install --cask libreoffice' : 'apt install libreoffice-writer-nogui' });
    const lang = await languageOption();
    result.notes.push(...lang.notes);
    result.options.push(
      { id: 'q', type: 'text', label: 'Search for straight away', optional: true, maxLength: 200, help: 'Optional. For example 15000. You can search again as often as you like on the next page.' },
      {
        id: 'mode', type: 'select', label: 'How to read the page', default: 'auto',
        help: 'Automatic works for most documents. You can change it on the search page too.',
        choices: Object.entries(MODES).map(([value, label]) => ({ value, label })),
      },
      {
        id: 'ocr', type: 'select', label: 'How to read scans and photos', default: 'rows',
        help: 'Only used for pages without a text layer. If box numbers or amounts are missing from the results, read the document again with another choice.',
        choices: [
          { value: 'rows', label: 'Row by row (best for tax returns and statements)' },
          { value: 'sparse', label: 'Scattered text (finds small numbers on busy slips, but loses line order)' },
          { value: 'auto', label: 'Automatic layout (often best for slips with small numbered boxes, and for letters)' },
        ],
      },
      { ...lang.option, label: 'Language, for scans and photos' },
    );
    return result;
  },

  async run(ctx) {
    const { input, options: o, workDir } = ctx;
    ctx.progress(null, null, 'Opening the document');
    let pdf = await toPdf(ctx);
    const modelPath = path.join(workDir, 'model.json');
    await pdfDoc(ctx, ['model', pdf, modelPath]);
    let model = JSON.parse(await readFile(modelPath, 'utf8'));
    const bare = model.pages.filter((p) => p.lines.length === 0 && !p.fields.some((f) => f.value)).length;
    if (bare) {
      pdf = await ocrIfNeeded(ctx, pdf, { pagesWithoutText: bare, lang: o.lang, psm: o.ocr === 'auto' ? null : o.ocr === 'sparse' ? 11 : 6 });
      await pdfDoc(ctx, ['model', pdf, modelPath]);
      model = JSON.parse(await readFile(modelPath, 'utf8'));
    }
    ctx.progress(null, null, 'Lining up rows');
    const pages = buildIndex(model);
    const rows = pages.reduce((n, p) => n + p.rows.length, 0);
    if (!rows) throw userError('No text could be found in this document.');
    const id = storeDocument({ name: input.name, pages, mode: o.mode });
    const href = `/find/${id}${o.q ? `?q=${encodeURIComponent(o.q)}` : ''}`;
    ctx.link(href, o.q ? `See results for ${o.q} in ${input.name}` : `Search ${input.name}`);
    ctx.finishMessage(`Read ${plural(pages.length, 'page')}, ${plural(rows, 'line')}. Choose the link below to search.`);
  },
};
