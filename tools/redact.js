// Redactor: finds private information in a document, lets you choose what to remove,
// then makes a PDF with that text truly removed (not just covered).
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { which, userError } from '../lib/system.js';
import { plural } from '../lib/files.js';
import { languageOption } from '../lib/tesseract-langs.js';
import { textModels, chatJson, ollamaMissingNote, noModelNote } from '../lib/ollama.js';
import { pymupdfCommand, pymupdfMissing, pdfDoc } from '../lib/pymupdf.js';
import { toPdf, ocrIfNeeded, sofficePath, DOC_ACCEPT } from '../lib/to-pdf.js';

const AI_SYSTEM = `You find private information about people in the text of one page of a document, such as a tax slip, bank statement or letter.
Find:
- names: the names of people (not companies, banks, government departments or form titles).
- addresses: home or mailing addresses of people. Give each line of an address separately, exactly as it appears (street line, then city, province and postal code line).
- birth_dates: dates of birth only.
Copy every item exactly as it is written in the text, with the same spelling, capitals and punctuation, so it can be searched for.
If a name appears in more than one form (for example "SMITH, JANE" and "Jane Smith"), list each form.
Do not list form labels, headings or instructions. If there is nothing, use empty lists.
Answer only with JSON.`;

const AI_SCHEMA = {
  type: 'object',
  properties: {
    names: { type: 'array', items: { type: 'string' } },
    addresses: { type: 'array', items: { type: 'string' } },
    birth_dates: { type: 'array', items: { type: 'string' } },
  },
  required: ['names', 'addresses', 'birth_dates'],
};

function lines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

export default {
  id: 'redact',
  name: 'Redactor (remove private information)',
  summary: 'Finds private information in a document, such as social insurance numbers, account numbers, names, addresses and birth dates. You choose what to remove, and get back a PDF with that text truly removed and blacked out. The rest of the document keeps its text, so a screen reader can still read it.',
  submitLabel: 'Find private information',
  input: {
    label: 'Document',
    help: 'A PDF, a scan or photo, or a Word, OpenDocument, RTF or text file. You always get a PDF back.',
    accept: DOC_ACCEPT,
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await pymupdfCommand())) result.missing.push(pymupdfMissing());
    const [ocr, magick, soffice] = await Promise.all([which('ocrmypdf'), which('magick'), sofficePath()]);
    if (!ocr) result.notes.push({ what: 'Scanned pages and photos need OCRmyPDF so their text can be found. Without it, only documents that already have text work.', install: process.platform === 'darwin' ? 'brew install ocrmypdf' : 'apt install ocrmypdf' });
    if (!magick) result.notes.push({ what: 'Photos need ImageMagick to be turned into a PDF.', install: process.platform === 'darwin' ? 'brew install imagemagick' : 'apt install imagemagick' });
    if (!soffice) result.notes.push({ what: 'Word and other office files need LibreOffice. PDFs and pictures work without it.', install: process.platform === 'darwin' ? 'brew install --cask libreoffice' : 'apt install libreoffice-writer-nogui' });

    const ai = await textModels();
    const aiChoices = [{ value: 'off', label: 'Off (patterns and your own words only)' }];
    if (!ai.running) result.notes.push(ollamaMissingNote('Finding names and addresses'));
    else if (!ai.models.length) result.notes.push(noModelNote('Finding names and addresses'));
    else aiChoices.push(...ai.models.map((m) => ({ value: m.name, label: `On, using ${m.name}` })));

    const lang = await languageOption();
    result.notes.push(...lang.notes);
    result.options.push(
      {
        id: 'aiModel', type: 'select', allowAny: true, label: 'Find names and addresses with AI', default: aiChoices[1]?.value || 'off',
        help: 'Numbers, email addresses, phone numbers, postal codes, dates and most street addresses are found with patterns. Names need the AI. It runs on your own computer or server, and nothing is sent to the internet.',
        choices: aiChoices,
      },
      {
        id: 'terms', type: 'textarea', label: 'Always look for these', optional: true, rows: 4, maxLength: 5000, remember: true,
        help: 'One per line, for example your name, your address or an account number. Kept only in this browser, on this device.',
      },
      { ...lang.option, label: 'Language, for scanned pages' },
      { id: 'labels', type: 'checkbox', label: 'Write what was removed inside each black box, for example "SIN removed"', help: 'Your screen reader then reads these labels where the text used to be, so you can check the result.', default: true },
    );
    return result;
  },

  async run(ctx) {
    const { options: o, workDir } = ctx;
    ctx.progress(null, null, 'Opening the document');
    let pdf = await toPdf(ctx);

    // Find pages that are only a picture, and give them a text layer first.
    const modelPath = path.join(workDir, 'model.json');
    await pdfDoc(ctx, ['model', pdf, modelPath]);
    let model = JSON.parse(await readFile(modelPath, 'utf8'));
    const bare = model.pages.filter((p) => p.lines.length === 0 && !p.fields.some((f) => f.value)).length;
    if (bare) {
      pdf = await ocrIfNeeded(ctx, pdf, { pagesWithoutText: bare, lang: o.lang });
      await pdfDoc(ctx, ['model', pdf, modelPath]);
      model = JSON.parse(await readFile(modelPath, 'utf8'));
    }
    const pageCount = model.pages.length;
    if (!model.pages.some((p) => p.lines.length || p.fields.some((f) => f.value))) {
      throw userError('No text could be found in this document, so there is nothing to look through.');
    }

    // Names, addresses and birth dates with the AI, one page at a time.
    const ai = [];
    if (o.aiModel !== 'off') {
      const info = (await textModels()).models.find((m) => m.name === o.aiModel);
      for (const [i, page] of model.pages.entries()) {
        ctx.progress(i, pageCount, `AI is reading page ${i + 1} of ${pageCount}`);
        const text = [...page.lines.map((l) => l.text), ...page.fields.filter((f) => f.value).map((f) => `${f.label || f.name}: ${f.value}`)].join('\n').slice(0, 12000);
        if (!text.trim()) continue;
        const answer = await chatJson({ model: o.aiModel, system: AI_SYSTEM, prompt: `Page ${i + 1} text:\n\n${text}`, schema: AI_SCHEMA, signal: ctx.signal, thinking: info?.thinking });
        if (!answer) continue;
        for (const n of answer.names || []) ai.push({ group: 'name', text: n });
        for (const a of answer.addresses || []) ai.push({ group: 'address', text: a });
        for (const d of answer.birth_dates || []) ai.push({ group: 'birth', text: d });
      }
    }

    ctx.progress(null, null, 'Looking for private information');
    const extraPath = path.join(workDir, 'extra.json');
    const foundPath = path.join(workDir, 'found.json');
    await writeFile(extraPath, JSON.stringify({ ai, terms: lines(o.terms) }));
    await pdfDoc(ctx, ['find', pdf, extraPath, foundPath], (d, t) => ctx.progress(d, t, `Checking page ${d} of ${t}`));
    const found = JSON.parse(await readFile(foundPath, 'utf8'));

    const total = found.groups.reduce((n, g) => n + g.items.length, 0);
    const ticked = found.groups.reduce((n, g) => n + g.items.filter((i) => i.checked).length, 0);
    const pageWord = (pages) => (pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.slice(0, -1).join(', ')} and ${pages.at(-1)}`);
    ctx.review({
      heading: 'Found items',
      intro: total
        ? `Found ${plural(total, 'item')} in ${plural(found.groups.length, 'group')}. ${ticked} ${ticked === 1 ? 'is' : 'are'} ticked. Untick anything you want to keep, then choose Make redacted PDF.`
        : 'Nothing was found automatically. You can still type text to remove below.',
      groups: found.groups.map((g) => ({
        id: g.id,
        name: g.name,
        items: g.items.map((it) => ({
          id: it.id,
          checked: it.checked,
          label: `${it.text}. ${it.count > 1 ? `${it.count} times, ` : ''}${pageWord(it.pages)}.`,
          detail: `Around it: ${it.context}`,
        })),
      })),
      extraLabel: 'Other text to remove',
      extraHelp: 'Optional. One per line. Every place it appears is removed.',
      submitLabel: 'Make redacted PDF',
    }, { pdf, found });
    ctx.finishMessage(total ? `Found ${plural(total, 'item')}. Review them under the Found items heading.` : 'Nothing found automatically.');
  },

  async continue(ctx, state, choices) {
    const { input, options: o, outDir, workDir } = ctx;
    const chosen = new Set(choices.selected);
    const items = state.found.groups.flatMap((g) => g.items.filter((i) => chosen.has(i.id)));
    const planPath = path.join(workDir, 'plan.json');
    await writeFile(planPath, JSON.stringify({ labels: o.labels, items, extra: lines(choices.extra) }));
    const out = path.join(outDir, `${input.base}-redacted.pdf`);
    const result = await pdfDoc(ctx, ['redact', state.pdf, planPath, out], (d, t) => ctx.progress(d, t, `Removing from page ${d} of ${t}`));
    ctx.output(out, 'Redacted PDF');
    const removed = plural(items.length + lines(choices.extra).length, 'item');
    if (result?.left?.length) {
      ctx.finishMessage(`Removed ${removed} with ${plural(result.boxes, 'black box', 'black boxes')}. Warning: ${plural(result.left.length, 'item')} can still be found in the new PDF's text: ${result.left.join('; ')}. Check the PDF before sharing it.`);
    } else {
      ctx.finishMessage(`Removed ${removed} with ${plural(result?.boxes ?? 0, 'black box', 'black boxes')}. Check passed: none of the removed text can be found in the new PDF.`);
    }
  },
};
