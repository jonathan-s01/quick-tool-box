// Poppler pdftoppm: turns PDF pages into image files.
import os from 'node:os';
import path from 'node:path';
import { rename } from 'node:fs/promises';
import { which, missing, pool, userError } from '../lib/system.js';
import { sniff, pdfPageCount, zipFiles, plural } from '../lib/files.js';

const EXT = { png: 'png', jpeg: 'jpg', tiff: 'tif' };

export default {
  id: 'pdf-to-images',
  name: 'PDF to images',
  summary: 'Turn the pages of a PDF into PNG, JPEG or TIFF images, using Poppler.',
  submitLabel: 'Convert PDF',
  input: { label: 'PDF file', accept: '.pdf,application/pdf' },

  async setup() {
    const [pdftoppm, pdfinfo] = await Promise.all(['pdftoppm', 'pdfinfo'].map(which));
    const result = { missing: [], notes: [], options: [] };
    if (!pdftoppm || !pdfinfo) result.missing.push(missing('pdftoppm', 'Poppler is not installed.'));
    result.options.push(
      {
        id: 'format', type: 'select', label: 'Image format', default: 'png',
        choices: [
          { value: 'png', label: 'PNG (sharp, larger files)' },
          { value: 'jpeg', label: 'JPEG (smaller files)' },
          { value: 'tiff', label: 'TIFF' },
        ],
      },
      {
        id: 'dpi', type: 'select', label: 'Resolution', default: '150',
        choices: [
          { value: '72', label: '72 DPI (screen, smallest)' },
          { value: '150', label: '150 DPI (general use)' },
          { value: '300', label: '300 DPI (print or OCR)' },
          { value: '600', label: '600 DPI (largest)' },
        ],
      },
      { id: 'first', type: 'number', label: 'First page', help: 'Leave blank to start at page 1.', min: 1, max: 100000, optional: true },
      { id: 'last', type: 'number', label: 'Last page', help: 'Leave blank to go to the end.', min: 1, max: 100000, optional: true },
      { id: 'quality', type: 'number', label: 'JPEG quality', help: 'From 1 to 100. Only used for JPEG.', min: 1, max: 100, default: 90 },
      { id: 'gray', type: 'checkbox', label: 'Greyscale', default: false },
    );
    return result;
  },

  async run(ctx) {
    const { input, options: o, outDir, workDir } = ctx;
    if ((await sniff(input.path)) !== 'pdf') throw userError('This file is not a PDF.');
    ctx.progress(null, null, 'Counting pages');
    const count = await pdfPageCount(input.path, ctx.signal);
    const first = o.first ?? 1;
    const last = Math.min(o.last ?? count, count);
    if (first > count) throw userError(`First page is ${first}, but this PDF only has ${plural(count, 'page')}.`);
    if (first > last) throw userError('First page must not be after the last page.');

    const total = last - first + 1;
    const width = String(last).length;
    const numbers = Array.from({ length: total }, (_, i) => first + i);
    const parallel = Math.max(1, Math.min(8, os.availableParallelism() - 1));
    let done = 0;
    ctx.progress(0, total, `0 of ${plural(total, 'page')} done`);
    const files = await pool(numbers, parallel, async (n) => {
      const base = path.join(outDir, `${input.base}-page-${String(n).padStart(width, '0')}`);
      const args = ['-r', o.dpi, '-f', String(n), '-l', String(n), `-${o.format}`, '-singlefile'];
      if (o.format === 'jpeg') args.push('-jpegopt', `quality=${o.quality}`);
      if (o.gray) args.push('-gray');
      await ctx.run('pdftoppm', [...args, input.path, base]);
      done += 1;
      ctx.progress(done, total, `${done} of ${plural(total, 'page')} done`);
      return `${base}.${EXT[o.format]}`;
    }, ctx.signal);

    if (files.length === 1) return ctx.output(files[0], 'Image');
    ctx.progress(total, total, 'Making zip file');
    const zip = await zipFiles(files, path.join(workDir, `${input.base}-pages.zip`), ctx.signal);
    const finalZip = path.join(outDir, path.basename(zip));
    await rename(zip, finalZip);
    ctx.output(finalZip, `All ${files.length} pages as a zip file`);
    if (files.length <= 10) files.forEach((f, i) => ctx.output(f, `Page ${numbers[i]}`));
  },
};
