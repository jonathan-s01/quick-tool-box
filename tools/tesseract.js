// Tesseract OCR: reads the text in a scanned PDF or an image.
// PDFs are turned into page images first, which also throws away any existing text layer.
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { which, missing, pool } from '../lib/system.js';
import { languageOption } from '../lib/tesseract-langs.js';
import { sniff, pdfPageCount, listFiles, skewAngle, plural } from '../lib/files.js';
import { aiSetup, cleanChunks, reportHtml } from '../lib/ai-cleanup.js';
import { cropToBase64 } from '../lib/page-images.js';
import { esc } from '../lib/html.js';

export default {
  id: 'tesseract',
  name: 'Tesseract OCR',
  summary: 'Read the text in a scanned PDF or an image, quickly. Download it as a text file and an HTML file. For headings, tables and better reading order, use the Smart document reader.',
  submitLabel: 'Start OCR',
  input: {
    label: 'PDF or image file',
    help: 'PDF, PNG, JPEG, TIFF, BMP, WebP, GIF or HEIC. Any existing text layer in a PDF is ignored; every page is read fresh.',
    accept: '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.gif,.heic,.heif,application/pdf,image/*',
  },

  async setup() {
    const [tess, pdftoppm, pdfinfo, magick] = await Promise.all(['tesseract', 'pdftoppm', 'pdfinfo', 'magick'].map(which));
    const result = { missing: [], notes: [], options: [] };
    if (!tess) result.missing.push(missing('tesseract'));
    if (!pdftoppm || !pdfinfo) result.missing.push(missing('pdftoppm', 'Poppler is not installed. It is needed to read PDFs.'));

    const lang = await languageOption();
    result.notes.push(...lang.notes);

    result.options.push(
      lang.option,
      {
        id: 'psm', type: 'select', label: 'Page layout', default: '3',
        help: 'Automatic works for most documents. Try another setting if the text comes out in the wrong order.',
        choices: [
          { value: '3', label: 'Automatic' },
          { value: '4', label: 'Single column of text' },
          { value: '6', label: 'One block of text' },
          { value: '11', label: 'Scattered text, such as forms, labels or slides' },
        ],
      },
      {
        id: 'dpi', type: 'select', label: 'PDF page resolution', default: '300',
        help: 'Only used for PDFs. 300 works for most documents. Higher can help with very small print but is slower.',
        choices: [
          { value: '200', label: '200 DPI (faster)' },
          { value: '300', label: '300 DPI (recommended)' },
          { value: '400', label: '400 DPI' },
          { value: '600', label: '600 DPI (slowest)' },
        ],
      },
    );

    if (magick) {
      result.options.push(
        { id: 'gray', type: 'checkbox', group: 'Clean up pages before reading', label: 'Convert to greyscale', default: true },
        { id: 'deskew', type: 'checkbox', group: 'Clean up pages before reading', label: 'Straighten tilted pages', default: true },
        { id: 'normalize', type: 'checkbox', group: 'Clean up pages before reading', label: 'Boost contrast', help: 'Helps with faded or low contrast scans.', default: false },
        { id: 'despeckle', type: 'checkbox', group: 'Clean up pages before reading', label: 'Remove specks and noise', help: 'Helps with dusty or grainy scans. Can blur very small print.', default: false },
      );
      const ai = await aiSetup();
      result.options.push(...ai.options);
      result.notes.push(...ai.notes);
    } else {
      result.notes.push({ what: 'Page clean-up options (straighten, greyscale, contrast) need ImageMagick. Without it, pages are read as they are. To add it, run this command, then reload this page.', install: 'brew install imagemagick' });
    }
    return result;
  },

  async run(ctx) {
    const { input, options: o, workDir, outDir } = ctx;
    const hasMagick = Boolean(await which('magick'));
    // Run several pages at once, one CPU thread each.
    const parallel = Math.max(1, Math.min(8, os.availableParallelism() - 1));

    // Optional clean-up of one page image, in place.
    const cleanPage = async (image) => {
      if (!hasMagick) return;
      const args = [];
      if (o.gray) args.push('-colorspace', 'Gray');
      if (o.despeckle) args.push('-despeckle');
      if (o.normalize) args.push('-normalize');
      if (o.deskew) {
        const angle = await skewAngle(ctx.run, image);
        if (angle) args.push('-background', 'white', '-rotate', String(angle), '+repage');
      }
      if (args.length) await ctx.run('magick', [image, ...args, image]);
    };

    // Tesseract's TSV output says which words belong to which line and paragraph, and where they are.
    const ocr = async (image, dpi) => {
      const outBase = image.replace(/\.[^.]+$/, '');
      const args = [image, outBase, '-l', o.lang, '--psm', o.psm];
      if (dpi) args.push('--dpi', String(dpi));
      args.push('tsv');
      await ctx.run('tesseract', args, { env: { OMP_THREAD_LIMIT: '1' } });
      return { image, paragraphs: paragraphsFromTsv(await readFile(`${outBase}.tsv`, 'utf8')) };
    };

    let done = 0;
    const pageDone = (total) => {
      done += 1;
      ctx.progress(done, total, `${done} of ${plural(total, 'page')} done`);
    };

    let pages;
    if ((await sniff(input.path)) === 'pdf') {
      // Turning each page into an image throws away any existing text layer.
      ctx.progress(null, null, 'Counting pages');
      const total = await pdfPageCount(input.path, ctx.signal);
      ctx.progress(0, total, `0 of ${plural(total, 'page')} done`);
      const numbers = Array.from({ length: total }, (_, i) => i + 1);
      pages = await pool(numbers, parallel, async (n) => {
        const base = path.join(workDir, `page-${String(n).padStart(5, '0')}`);
        await ctx.run('pdftoppm', ['-r', o.dpi, '-f', String(n), '-l', String(n), '-png', '-singlefile', input.path, base]);
        await cleanPage(`${base}.png`);
        const text = await ocr(`${base}.png`, o.dpi);
        pageDone(total);
        return text;
      }, ctx.signal);
    } else {
      let images;
      if (hasMagick) {
        // Convert any image type (including HEIC and multi-page TIFF) to one PNG per page.
        ctx.progress(null, null, 'Preparing image');
        await ctx.run('magick', [input.path, '-auto-orient', path.join(workDir, 'page-%05d.png')]);
        images = (await listFiles(workDir)).filter((f) => f.endsWith('.png'));
      } else {
        images = [input.path];
      }
      const total = images.length;
      ctx.progress(0, total, `0 of ${plural(total, 'page')} done`);
      pages = await pool(images, parallel, async (img) => {
        await cleanPage(img);
        const text = await ocr(img);
        pageDone(total);
        return text;
      }, ctx.signal);
    }

    // Optional AI clean-up: each paragraph is checked against its part of the page picture.
    let report = null;
    if (o.aiModel && o.aiModel !== 'off') {
      const chunks = [];
      pages.forEach((pg, pi) => pg.paragraphs.forEach((para, i) => {
        chunks.push({ id: `${pi}:${i}`, page: pi + 1, text: para.text, conf: para.conf, box: para.box, image: pg.image });
      }));
      let n = 0;
      const crop = (c) => cropToBase64(ctx, c.image, c.box, `crop-${n++}.png`);
      const result = await cleanChunks(ctx, chunks, { model: o.aiModel, strictness: o.aiStrictness, crop, english: o.lang === 'eng' });
      for (const [id, text] of result.texts) {
        const [pi, i] = id.split(':').map(Number);
        pages[pi].paragraphs[i].text = text;
      }
      report = result.report;
    }

    ctx.progress(null, null, 'Saving files');
    const texts = pages.map((pg) => pg.paragraphs.map((para) => para.text));
    const txtPath = path.join(outDir, `${input.base}.txt`);
    const htmlPath = path.join(outDir, `${input.base}.html`);
    await writeFile(txtPath, toText(texts));
    await writeFile(htmlPath, toHtml(texts, input.base, o.lang));
    ctx.output(txtPath, 'Text file');
    ctx.output(htmlPath, 'HTML file');
    if (report) {
      const reportPath = path.join(outDir, `${input.base}-ai-changes.html`);
      await writeFile(reportPath, reportHtml(report, input.name));
      ctx.output(reportPath, 'AI changes report');
      ctx.finishMessage(`AI made ${plural(report.applied.reduce((k, e) => k + e.changes.length, 0), 'fix', 'fixes')}.`);
    }
  },
};

/**
 * Reads Tesseract's TSV output into paragraphs: [{ text, box }].
 * Lines are joined with spaces, and words broken with a hyphen at the end of a line are joined back.
 */
export function paragraphsFromTsv(tsv) {
  const paras = new Map();
  for (const line of tsv.split('\n').slice(1)) {
    const f = line.split('\t');
    if (f.length < 12) continue;
    const [level, , block, par, ln, , left, top, width, height, conf] = f.map(Number);
    const key = `${block}.${par}`;
    if (level === 3) {
      paras.set(key, { box: { left, top, width, height }, lines: new Map() });
    } else if (level === 5) {
      const word = f.slice(11).join('\t').trim();
      if (!word) continue;
      const p = paras.get(key);
      if (!p) continue;
      if (!p.lines.has(ln)) p.lines.set(ln, []);
      p.lines.get(ln).push({ word, conf: Number.isFinite(conf) && conf >= 0 ? conf : null });
    }
  }
  const out = [];
  for (const p of paras.values()) {
    // One entry per word in the final text, so word confidences stay lined up with the text.
    const words = [];
    for (const line of p.lines.values()) {
      line.forEach((w, i) => {
        const prev = words[words.length - 1];
        if (i === 0 && prev && /\p{L}-$/u.test(prev.word) && /^\p{Ll}/u.test(w.word)) {
          prev.word = prev.word.slice(0, -1) + w.word;
          prev.conf = prev.conf == null || w.conf == null ? null : Math.min(prev.conf, w.conf);
        } else {
          words.push({ ...w });
        }
      });
    }
    if (words.length) out.push({ text: words.map((w) => w.word).join(' '), conf: words.map((w) => w.conf), box: p.box });
  }
  return out;
}

function toText(pages) {
  const one = (paras) => (paras.length ? paras.join('\n\n') : '(No text found on this page.)');
  if (pages.length === 1) return `${one(pages[0])}\n`;
  return pages.map((p, i) => `[Page ${i + 1} of ${pages.length}]\n\n${one(p)}`).join('\n\n') + '\n';
}

function paragraphs(paras) {
  if (!paras.length) return '<p>(No text found on this page.)</p>';
  return paras.map((p) => `<p>${esc(p)}</p>`).join('\n');
}

function toHtml(pages, title, lang) {
  const htmlLang = lang === 'fra' ? 'fr' : 'en';
  const body = pages.length === 1
    ? paragraphs(pages[0])
    : pages.map((t, i) => `<section aria-labelledby="page-${i + 1}">\n<h2 id="page-${i + 1}">Page ${i + 1}</h2>\n${paragraphs(t)}\n</section>`).join('\n');
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { font-family: system-ui, sans-serif; font-size: 1.125rem; line-height: 1.5; max-width: 70ch; margin: 2rem auto; padding: 0 1rem; }
h2 { margin-top: 2.5rem; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>
`;
}
