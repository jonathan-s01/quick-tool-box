// pandoc: converts documents between Word, HTML, Markdown, EPUB, plain text and more.
import path from 'node:path';
import { copyFile } from 'node:fs/promises';
import { which, missing, userError } from '../lib/system.js';
import { sniff } from '../lib/files.js';

// Input types pandoc reads, by file extension.
const READERS = {
  '.docx': 'docx', '.odt': 'odt', '.rtf': 'rtf', '.epub': 'epub',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html',
  '.md': 'markdown', '.markdown': 'markdown', '.txt': 'markdown',
  '.rst': 'rst', '.org': 'org', '.tex': 'latex', '.ipynb': 'ipynb', '.csv': 'csv', '.tsv': 'tsv',
};

const WRITERS = {
  docx: { ext: 'docx', label: 'Word document' },
  html: { ext: 'html', label: 'HTML web page' },
  md: { ext: 'md', label: 'Markdown', to: 'gfm' },
  txt: { ext: 'txt', label: 'Plain text', to: 'plain' },
  epub: { ext: 'epub', label: 'EPUB e-book', to: 'epub3' },
  odt: { ext: 'odt', label: 'OpenDocument text' },
  rtf: { ext: 'rtf', label: 'Rich text' },
};

export default {
  id: 'pandoc',
  name: 'Document converter (pandoc)',
  summary: 'Convert documents between Word, HTML, Markdown, EPUB, plain text and more. For a PDF, convert to HTML and print it to PDF from your browser.',
  submitLabel: 'Convert document',
  input: {
    label: 'Document',
    help: 'Word (.docx), HTML, Markdown, plain text, EPUB, OpenDocument (.odt), RTF, reStructuredText, Org, LaTeX, Jupyter notebook, CSV or TSV. Old .doc files and PDFs are not supported.',
    accept: Object.keys(READERS).join(','),
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await which('pandoc'))) result.missing.push(missing('pandoc'));
    result.options.push(
      {
        id: 'to', type: 'select', label: 'Convert to', default: 'html',
        choices: Object.entries(WRITERS).map(([value, w]) => ({ value, label: `${w.label} (.${w.ext})` })),
      },
      {
        id: 'lang', type: 'select', label: 'Document language', default: 'keep',
        help: 'Sets the language so screen readers use the right voice. Keep as is uses whatever the document already says.',
        choices: [
          { value: 'keep', label: 'Keep as is' },
          { value: 'en-CA', label: 'English (Canada)' },
          { value: 'fr-CA', label: 'French (Canada)' },
        ],
      },
      { id: 'toc', type: 'checkbox', label: 'Add a table of contents', help: 'Built from the headings. Used for Word, HTML, EPUB and OpenDocument.', default: false },
      { id: 'embed', type: 'checkbox', label: 'Put images inside the HTML file', help: 'Only used for HTML. Makes one self-contained file instead of losing the images.', default: true },
    );
    return result;
  },

  async run(ctx) {
    const { input, options: o, outDir, workDir } = ctx;
    if ((await sniff(input.path)) === 'pdf') throw userError('pandoc cannot read PDFs. For scanned PDFs, use Tesseract OCR to get HTML first.');
    const from = READERS[input.ext];
    if (!from) throw userError(`pandoc cannot read ${input.ext || 'files without an extension'}. Supported types are listed under the file field.`);
    const w = WRITERS[o.to];
    let outName = `${input.base}.${w.ext}`;
    if (`.${w.ext}` === input.ext) outName = `${input.base}-converted.${w.ext}`;
    const out = path.join(outDir, outName);

    const args = ['--from', from, '--to', w.to || o.to, '--output', out, '--wrap', 'none'];
    if (from === 'docx' || from === 'odt' || from === 'epub') args.push('--extract-media', path.join(workDir, 'media'));
    if (o.to === 'html') {
      args.push('--standalone');
      if (o.embed) args.push('--embed-resources');
    }
    if (o.toc && ['docx', 'html', 'epub', 'odt'].includes(o.to)) args.push('--toc');
    if (o.lang !== 'keep') args.push('--metadata', `lang=${o.lang}`);
    // Use a copy named after the original file: pandoc uses the file name as the page title when the document has none.
    const named = path.join(workDir, `${input.base}${input.ext}`);
    await copyFile(input.path, named);
    args.push(named);

    ctx.progress(null, null, 'Converting');
    // Run from the work folder so any extracted images are found when embedding.
    await ctx.run('pandoc', args, { cwd: workDir });
    ctx.output(out, w.label);
  },
};
