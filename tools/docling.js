// Smart document reader: Docling finds the layout (reading order, paragraphs, headings, tables),
// then this tool writes an accessible HTML version with a table of contents.
// Optional AI clean-up fixes OCR mistakes using a local AI model.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { which, missing, run, userError, plainText } from '../lib/system.js';
import { sniff, pdfPageCount, plural } from '../lib/files.js';
import { renderDocling, cleanupChunks, applyCleanup } from '../lib/docling-render.js';
import { aiSetup, cleanChunks, reportHtml } from '../lib/ai-cleanup.js';
import { pdfCropper } from '../lib/page-images.js';
import { doclingServeStatus, convertWithServe, DOCLING_URL } from '../lib/docling-serve.js';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'docling_convert.py');

/** Finds the Python that Docling is installed in, by reading the first line of the docling command. */
async function doclingPython() {
  if (process.env.DOCLING_PYTHON) return process.env.DOCLING_PYTHON;
  const cmd = await which('docling');
  if (!cmd) return null;
  try {
    const first = (await readFile(cmd, 'utf8')).split('\n', 1)[0];
    const m = /^#!\s*(\S+)/.exec(first);
    if (m && /python/i.test(path.basename(m[1]))) return m[1];
  } catch { /* fall through */ }
  return null;
}

let versions = { at: 0, value: null };
async function installed() {
  if (versions.value && Date.now() - versions.at < 30000) return versions.value;
  const python = await doclingPython();
  let value = { python, docling: null, ocrmac: null };
  if (python) {
    try {
      const code = 'import importlib.metadata as m, json\nout = {}\nfor p in ("docling", "ocrmac"):\n    try:\n        out[p] = m.version(p)\n    except Exception:\n        out[p] = None\nprint(json.dumps(out))';
      const { stdout } = await run(python, ['-c', code]);
      value = { python, ...JSON.parse(stdout) };
    } catch { /* not usable */ }
  }
  versions = { at: Date.now(), value };
  return value;
}

/** How Docling can run here: 'local' (installed), 'serve' (Docling server container) or null. */
export async function doclingMode() {
  if ((await installed()).docling) return 'local';
  if ((await doclingServeStatus()).reachable) return 'serve';
  return null;
}

/**
 * Reads a PDF or image with Docling (installed, or the Docling server) and returns
 * { doc, pdf, pages }: the Docling document, a PDF version of the input, and its page count.
 */
export async function doclingDocument(ctx, inputPath, { lang = 'en', engine = 'auto', tables = 'accurate', forceOcr = false } = {}) {
  let pdf = inputPath;
  if ((await sniff(inputPath)) !== 'pdf') {
    ctx.progress(null, null, 'Preparing image');
    pdf = path.join(ctx.workDir, `input-${Date.now()}.pdf`);
    await ctx.run('magick', [`${inputPath}[0]`, '-auto-orient', pdf]);
  }
  const pages = await pdfPageCount(pdf, ctx.signal);
  const mode = await doclingMode();
  if (!mode) throw userError(`Docling is not installed here, and the Docling server at ${DOCLING_URL} could not be reached.`);
  ctx.progress(null, null, `Reading the layout of ${plural(pages, 'page')}. This takes a few seconds per page, longer the first time.`);
  if (mode === 'serve') return { doc: await convertWithServe(ctx, pdf, { lang, forceOcr, tables }), pdf, pages };
  const have = await installed();
  const jsonPath = path.join(ctx.workDir, `docling-${Date.now()}.json`);
  const args = [HELPER, pdf, jsonPath, '--ocr-engine', engine, '--lang', lang, '--tables', tables];
  if (forceOcr) args.push('--force-ocr');
  try {
    await ctx.run(have.python, args, { env: { PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false' } });
  } catch (err) {
    const wrapper = (err.stderr || '').split('\n').find((l) => l.startsWith('WRAPPER_ERROR:'));
    if (wrapper) throw userError(wrapper.replace('WRAPPER_ERROR:', '').trim(), plainText(err.details));
    if (err.exitCode != null) throw userError('Docling stopped with an error.', plainText(err.details));
    throw err;
  }
  return { doc: JSON.parse(await readFile(jsonPath, 'utf8')), pdf, pages };
}

export default {
  id: 'docling',
  name: 'Smart document reader (Docling)',
  summary: 'Make an accessible HTML version of a PDF or scanned page: proper paragraphs in reading order, heading levels, a table of contents and real tables. Works well on academic papers. Optional AI clean-up fixes OCR mistakes.',
  submitLabel: 'Read document',
  input: {
    label: 'PDF or image file',
    help: 'PDFs with or without a text layer, and scanned pages (PNG, JPEG, TIFF, HEIC and others).',
    accept: '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.heic,.heif,application/pdf,image/*',
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    const have = await installed();
    const mode = await doclingMode();
    if (!mode) {
      result.missing.push({ what: `Docling is not installed, and no Docling server answered at ${DOCLING_URL}. On a Mac, install uv first (brew install uv), then run the command below. On the home server, start the docling service in docker-compose.yml. The first document you read downloads Docling's layout models, which takes a few minutes.`, install: 'uv tool install docling --with ocrmac' });
    } else if (mode === 'serve') {
      result.notes.push({ what: `Using the Docling server at ${DOCLING_URL}. It chooses its own OCR engine.`, install: null });
    }
    const [pdftoppm, pdfinfo, magick] = await Promise.all(['pdftoppm', 'pdfinfo', 'magick'].map(which));
    if (!pdftoppm || !pdfinfo) result.missing.push(missing('pdftoppm', 'Poppler is not installed.'));
    if (!magick) result.missing.push(missing('magick', 'ImageMagick is not installed. It is needed for images and the AI clean-up.'));

    const engines = [];
    if (have.ocrmac) engines.push({ value: 'mac', label: 'Apple Vision (built into macOS, recommended)' });
    engines.push({ value: 'tesseract', label: 'Tesseract' }, { value: 'auto', label: 'Let Docling choose' });
    if (have.docling && !have.ocrmac) {
      result.notes.push({ what: 'Apple Vision OCR is usually more accurate than Tesseract on a Mac. To add it, run this command, then reload this page.', install: 'uv tool install docling --with ocrmac --force' });
    }

    result.options.push(
      {
        id: 'lang', type: 'select', label: 'Language of the text', default: 'en',
        choices: [{ value: 'en', label: 'English' }, { value: 'fr', label: 'French' }, { value: 'en+fr', label: 'English and French' }],
      },
      {
        id: 'textLayer', type: 'select', label: 'Text in the PDF', default: 'auto',
        help: 'Using the text already in the PDF is faster, and exact when that text is good. If text copied from the PDF comes out garbled, choose to ignore it.',
        choices: [
          { value: 'auto', label: 'Use it, and only read pictures of text with OCR' },
          { value: 'force', label: 'Ignore it and read every page with OCR' },
        ],
      },
      ...(mode === 'serve' ? [] : [{ id: 'engine', type: 'select', label: 'OCR engine', default: engines[0].value, choices: engines }]),
      {
        id: 'tables', type: 'select', label: 'Tables', default: 'accurate',
        choices: [{ value: 'accurate', label: 'Accurate (slower)' }, { value: 'fast', label: 'Fast' }],
      },
      { id: 'furniture', type: 'checkbox', group: 'Reading layout', label: 'Remove page headers, footers and page numbers', help: 'Also removes short text that repeats on 3 or more pages, such as a journal name.', default: true },
      {
        id: 'footnotes', type: 'select', group: 'Reading layout', label: 'Footnotes', default: 'end',
        choices: [{ value: 'end', label: 'Move to the end, under a Footnotes heading' }, { value: 'inline', label: 'Leave where they are on the page' }],
      },
      { id: 'pageMarks', type: 'checkbox', group: 'Reading layout', label: 'Mark where each page starts', help: 'Adds short markers such as [Page 4], useful for citing.', default: true },
      { id: 'joinWords', type: 'checkbox', group: 'Reading layout', label: 'Join words split across lines', help: 'For example, infor- mation becomes information.', default: true },
    );
    if (magick && pdftoppm) {
      const ai = await aiSetup();
      result.options.push(...ai.options);
      result.notes.push(...ai.notes);
    }
    return result;
  },

  async run(ctx) {
    const { input, options: o, outDir } = ctx;
    const { doc, pdf } = await doclingDocument(ctx, input.path, { lang: o.lang, engine: o.engine || 'auto', tables: o.tables, forceOcr: o.textLayer === 'force' });

    let report = null;
    if (o.aiModel && o.aiModel !== 'off') {
      const pageHeight = (p) => doc.pages?.[String(p)]?.size?.height;
      const crop = pdfCropper(ctx, pdf, pageHeight);
      const result = await cleanChunks(ctx, cleanupChunks(doc), { model: o.aiModel, strictness: o.aiStrictness, crop, english: o.lang === 'en' });
      applyCleanup(doc, result.texts);
      report = result.report;
    }

    ctx.progress(null, null, 'Writing files');
    const { html, markdown, stats } = renderDocling(doc, {
      name: input.base,
      lang: o.lang === 'fr' ? 'fr' : 'en',
      keepFurniture: !o.furniture,
      footnotes: o.footnotes,
      pageMarks: o.pageMarks,
      joinWords: o.joinWords,
    });
    const htmlPath = path.join(outDir, `${input.base}.html`);
    const mdPath = path.join(outDir, `${input.base}.md`);
    await writeFile(htmlPath, html);
    await writeFile(mdPath, markdown);
    ctx.output(htmlPath, 'Accessible HTML');
    ctx.output(mdPath, 'Markdown');
    const summary = [`${plural(stats.headings, 'heading')}, ${plural(stats.tables, 'table')}.`];
    if (o.furniture && stats.removed) summary.push(`Removed ${plural(stats.removed, 'repeated header, footer or page number', 'repeated headers, footers or page numbers')}.`);
    if (report) {
      const reportPath = path.join(outDir, `${input.base}-ai-changes.html`);
      await writeFile(reportPath, reportHtml(report, input.name));
      ctx.output(reportPath, 'AI changes report');
      const fixes = report.applied.reduce((n, e) => n + e.changes.length, 0);
      summary.push(`AI made ${plural(fixes, 'fix', 'fixes')}.`);
    }
    ctx.finishMessage(summary.join(' '));
  },
};
