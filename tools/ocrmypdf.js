// OCRmyPDF: adds a hidden, searchable text layer to a scanned PDF, keeping how it looks.
import path from 'node:path';
import os from 'node:os';
import { which, missing, userError } from '../lib/system.js';
import { sniff } from '../lib/files.js';
import { languageOption } from '../lib/tesseract-langs.js';

// What OCRmyPDF's exit codes mean, in plain words.
const EXIT = {
  2: 'This file could not be read as a PDF.',
  6: 'This PDF already has text. Choose "Redo the text layer" or "Replace everything" and try again.',
  8: 'This PDF is password protected. Remove the password and try again.',
  130: 'Cancelled.',
};

export default {
  id: 'ocrmypdf',
  name: 'Searchable PDF (OCRmyPDF)',
  summary: 'Add a hidden text layer to a scanned PDF so it can be searched, selected and read by a screen reader. The pages still look the same.',
  submitLabel: 'Make searchable PDF',
  input: { label: 'PDF file', accept: '.pdf,application/pdf' },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await which('ocrmypdf'))) result.missing.push(missing('ocrmypdf'));
    const lang = await languageOption();
    result.notes.push(...lang.notes);
    result.options.push(
      lang.option,
      {
        id: 'mode', type: 'select', label: 'If the PDF already has text', default: 'force',
        help: 'Replace everything is the most thorough, and drops any bad existing text, but turns each page into an image. Redo the text layer keeps the pages as they are and only replaces the hidden text.',
        choices: [
          { value: 'force', label: 'Replace everything (turn pages into images, then read them)' },
          { value: 'redo', label: 'Redo the text layer only' },
          { value: 'skip', label: 'Leave pages that have text alone' },
        ],
      },
      { id: 'rotate', type: 'checkbox', group: 'Page clean-up', label: 'Turn sideways or upside-down pages the right way up', default: true },
      { id: 'deskew', type: 'checkbox', group: 'Page clean-up', label: 'Straighten tilted pages', help: 'Not available with Redo the text layer only.', default: true },
      {
        id: 'output', type: 'select', label: 'PDF type', default: 'pdfa',
        help: 'PDF/A is meant for long-term archiving and is what OCRmyPDF normally makes. Plain PDF keeps the file closer to the original.',
        choices: [
          { value: 'pdfa', label: 'PDF/A (archive)' },
          { value: 'pdf', label: 'Plain PDF' },
        ],
      },
      {
        id: 'optimize', type: 'select', label: 'File size', default: '1',
        choices: [
          { value: '0', label: 'Do not shrink' },
          { value: '1', label: 'Shrink safely, no quality loss' },
          { value: '2', label: 'Shrink more, some image quality loss' },
        ],
      },
      { id: 'sidecar', type: 'checkbox', label: 'Also give me the text as a .txt file', default: false },
    );
    return result;
  },

  validate(o) {
    if (o.mode === 'redo' && o.deskew) {
      throw Object.assign(userError('Straighten tilted pages cannot be used with Redo the text layer only. Turn one of them off.'), { field: 'deskew' });
    }
  },

  async run(ctx) {
    const { input, options: o, outDir } = ctx;
    if ((await sniff(input.path)) !== 'pdf') throw userError('This file is not a PDF.');
    const out = path.join(outDir, `${input.base}-searchable.pdf`);
    const args = ['-l', o.lang, '--output-type', o.output, '--optimize', o.optimize, '--jobs', String(Math.max(1, os.availableParallelism() - 1))];
    args.push(o.mode === 'force' ? '--force-ocr' : o.mode === 'redo' ? '--redo-ocr' : '--skip-text');
    if (o.rotate) args.push('--rotate-pages');
    if (o.deskew) args.push('--deskew');
    let sidecar;
    if (o.sidecar) {
      sidecar = path.join(outDir, `${input.base}.txt`);
      args.push('--sidecar', sidecar);
    }
    args.push(input.path, out);

    ctx.progress(null, null, 'Reading pages. This can take a while for long documents.');
    try {
      await ctx.run('ocrmypdf', args);
    } catch (err) {
      if (EXIT[err.exitCode]) throw userError(EXIT[err.exitCode], err.details);
      throw err;
    }
    ctx.output(out, 'Searchable PDF');
    if (sidecar) ctx.output(sidecar, 'Text file');
  },
};
