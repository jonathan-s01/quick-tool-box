// ImageMagick: convert, resize and tidy up images.
import path from 'node:path';
import { rename } from 'node:fs/promises';
import { which, missing, userError } from '../lib/system.js';
import { sniff, listFiles, zipFiles, skewAngle } from '../lib/files.js';

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', tiff: 'tif', pdf: 'pdf' };

export default {
  id: 'image-convert',
  name: 'Image converter',
  summary: 'Convert, shrink, straighten or greyscale an image, using ImageMagick. Can also turn an image into a PDF.',
  submitLabel: 'Convert image',
  input: {
    label: 'Image file',
    help: 'PNG, JPEG, HEIC, WebP, TIFF, GIF, BMP and most other image types. For PDFs, use PDF to images instead.',
    accept: 'image/*,.heic,.heif',
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await which('magick'))) result.missing.push(missing('magick', 'ImageMagick is not installed.'));
    result.options.push(
      {
        id: 'format', type: 'select', label: 'Convert to', default: 'png',
        choices: [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
          { value: 'tiff', label: 'TIFF' },
          { value: 'pdf', label: 'PDF' },
        ],
      },
      {
        id: 'size', type: 'select', label: 'Maximum width and height', default: 'keep',
        help: 'Larger images are shrunk to fit, keeping their shape. Smaller images are never enlarged.',
        choices: [
          { value: 'keep', label: 'Keep original size' },
          { value: '3000', label: '3000 pixels' },
          { value: '2000', label: '2000 pixels' },
          { value: '1600', label: '1600 pixels' },
          { value: '1200', label: '1200 pixels' },
          { value: '800', label: '800 pixels' },
        ],
      },
      { id: 'quality', type: 'number', label: 'Quality', help: 'From 1 to 100. Used for JPEG and WebP. Lower means smaller files.', min: 1, max: 100, default: 85 },
      { id: 'gray', type: 'checkbox', group: 'Adjustments', label: 'Greyscale', default: false },
      { id: 'deskew', type: 'checkbox', group: 'Adjustments', label: 'Straighten a tilted scan', default: false },
      { id: 'normalize', type: 'checkbox', group: 'Adjustments', label: 'Boost contrast', default: false },
      { id: 'strip', type: 'checkbox', group: 'Adjustments', label: 'Remove metadata', help: 'Removes hidden details such as camera model and location.', default: false },
    );
    return result;
  },

  async run(ctx) {
    const { input, options: o, outDir, workDir } = ctx;
    if ((await sniff(input.path)) === 'pdf') throw userError('This is a PDF. Use the PDF to images tool instead.');
    const args = [input.path, '-auto-orient'];
    if (o.size !== 'keep') args.push('-resize', `${o.size}x${o.size}>`);
    if (o.gray) args.push('-colorspace', 'Gray');
    if (o.normalize) args.push('-normalize');
    if (o.deskew) {
      ctx.progress(null, null, 'Measuring tilt');
      const angle = await skewAngle(ctx.run, input.path);
      if (angle) args.push('-background', 'white', '-rotate', String(angle), '+repage');
    }
    if (o.strip) args.push('-strip');
    if (o.format === 'jpeg' || o.format === 'webp') args.push('-quality', String(o.quality));
    if (o.format === 'jpeg') args.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off'); // JPEG has no transparency
    args.push(path.join(outDir, `${input.base}.${EXT[o.format]}`));

    ctx.progress(null, null, 'Converting');
    await ctx.run('magick', args);

    // Multi-frame images (animated GIFs, multi-page TIFFs) can produce several files.
    const files = await listFiles(outDir);
    if (o.format === 'pdf' && files.length === 1 && (await sniff(files[0])) !== 'pdf') {
      throw userError('ImageMagick did not create a real PDF. Its security settings may block PDF output on this computer.');
    }
    if (files.length === 1) return ctx.output(files[0], 'Converted image');
    ctx.progress(null, null, 'Making zip file');
    const zip = await zipFiles(files, path.join(workDir, `${input.base}-images.zip`), ctx.signal);
    const finalZip = path.join(outDir, path.basename(zip));
    await rename(zip, finalZip);
    ctx.output(finalZip, `All ${files.length} images as a zip file`);
    if (files.length <= 10) files.forEach((f, i) => ctx.output(f, `Image ${i + 1}`));
  },
};
