// ExifTool: shows or removes hidden details (metadata) in photos, documents and media files.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { which, missing, userError } from '../lib/system.js';
import { plural } from '../lib/files.js';
import { esc } from '../lib/html.js';

/** Reads ExifTool's normal text output into groups of { name, value }. */
export function parseExif(text) {
  const groups = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\[([^\]]+)\]\s+(.+?)\s*: (.*)$/);
    if (!m) continue;
    const [, group, name, value] = m;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ name, value });
  }
  return groups;
}

// Groups that describe the file itself rather than hidden details inside it.
const FILE_GROUPS = new Set(['ExifTool', 'System', 'File', 'Composite']);

function countHidden(groups) {
  let n = 0;
  for (const [g, rows] of groups) if (!FILE_GROUPS.has(g)) n += rows.length;
  return n;
}

/** Hidden details first, basic file information last. */
function ordered(groups) {
  const all = [...groups];
  return [...all.filter(([g]) => !FILE_GROUPS.has(g)), ...all.filter(([g]) => FILE_GROUPS.has(g))];
}

function toHtml(groups, title, intro) {
  const sections = ordered(groups).map(([group, rows], i) => `<section aria-labelledby="g${i}">
<h2 id="g${i}">${esc(group)} (${rows.length})</h2>
<table>
<thead><tr><th scope="col">Detail</th><th scope="col">Value</th></tr></thead>
<tbody>
${rows.map((r) => `<tr><th scope="row">${esc(r.name)}</th><td>${esc(r.value)}</td></tr>`).join('\n')}
</tbody>
</table>
</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { font-family: system-ui, sans-serif; font-size: 1.125rem; line-height: 1.5; max-width: 80ch; margin: 2rem auto; padding: 0 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #888; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
tbody th { font-weight: 600; width: 35%; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${intro}
${sections}
</main>
</body>
</html>
`;
}

function toText(groups) {
  return ordered(groups).map(([g, rows]) => `${g}\n${rows.map((r) => `  ${r.name}: ${r.value}`).join('\n')}`).join('\n\n') + '\n';
}

export default {
  id: 'exiftool',
  name: 'Hidden file details (ExifTool)',
  summary: 'See or remove the hidden details in a file, such as location, camera, author and editing software. Works with photos, PDFs, Office documents, audio and video.',
  submitLabel: 'Start',
  input: { label: 'File' },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await which('exiftool'))) result.missing.push(missing('exiftool'));
    result.options.push(
      {
        id: 'mode', type: 'select', label: 'What to do', default: 'show',
        choices: [
          { value: 'show', label: 'Show hidden details' },
          { value: 'remove', label: 'Remove hidden details (gives you a cleaned copy)' },
        ],
      },
      { id: 'orientation', type: 'checkbox', group: 'When removing', label: 'Keep photo rotation', help: 'Without it, some photos can show up sideways.', default: true },
      { id: 'icc', type: 'checkbox', group: 'When removing', label: 'Keep colour profile', help: 'Without it, colours in some photos can look slightly off.', default: true },
    );
    result.notes.push({ what: 'For PDFs, ExifTool hides old details rather than deleting them, so they can be recovered. Do not rely on it to remove sensitive details from a PDF.', install: null });
    return result;
  },

  async run(ctx) {
    const { input, options: o, outDir } = ctx;
    const read = async (file) => parseExif((await ctx.run('exiftool', ['-a', '-G1', '-charset', 'filename=utf8', '-api', 'largefilesupport=1', file])).stdout);

    if (o.mode === 'show') {
      ctx.progress(null, null, 'Reading details');
      const groups = await read(input.path);
      for (const rows of groups.values()) for (const r of rows) if (r.name === 'File Name') r.value = input.name;
      const n = countHidden(groups);
      const htmlPath = path.join(outDir, `${input.base}-details.html`);
      const txtPath = path.join(outDir, `${input.base}-details.txt`);
      await writeFile(htmlPath, toHtml(groups, `Hidden details: ${input.name}`, `<p>${plural(n, 'hidden detail')} found, plus basic file information. Each group has its own heading.</p>`));
      await writeFile(txtPath, toText(groups));
      ctx.output(htmlPath, 'Report');
      ctx.output(txtPath, 'Report as text');
      ctx.finishMessage(`${plural(n, 'hidden detail')} found.`);
      return;
    }

    ctx.progress(null, null, 'Removing details');
    if (!input.ext) throw userError('This file has no extension, such as .jpg or .pdf, so ExifTool cannot tell how to clean it. Rename it and try again.');
    const before = countHidden(await read(input.path));
    const out = path.join(outDir, `${input.base}-cleaned${input.ext}`);
    const args = ['-all='];
    const keep = [];
    if (o.orientation) keep.push('-Orientation');
    if (o.icc) keep.push('-ICC_Profile');
    if (keep.length) args.push('-tagsFromFile', '@', ...keep);
    args.push('-o', out, input.path);
    try {
      await ctx.run('exiftool', args);
    } catch (err) {
      throw userError('ExifTool could not clean this file. It may not support writing this file type.', err.details);
    }
    ctx.progress(null, null, 'Checking the cleaned copy');
    const groups = await read(out);
    const after = countHidden(groups);
    const reportPath = path.join(outDir, `${input.base}-cleaned-details.html`);
    await writeFile(reportPath, toHtml(groups, `Details left in the cleaned copy: ${input.name}`, `<p>Before: ${plural(before, 'hidden detail')}. After: ${plural(after, 'hidden detail')}. Anything left is needed for the file to work, or was kept on purpose.</p>`));
    ctx.output(out, 'Cleaned copy');
    ctx.output(reportPath, 'What is left');
    ctx.finishMessage(`Removed ${before - after} of ${plural(before, 'hidden detail')}.`);
  },
};
