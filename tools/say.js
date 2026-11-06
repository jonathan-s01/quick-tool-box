// macOS text to speech: turns text into an audio file with the built-in "say" command.
import path from 'node:path';
import { copyFile, writeFile } from 'node:fs/promises';
import { which, run, userError } from '../lib/system.js';

// Files macOS's textutil can turn into plain text.
const TEXTUTIL = new Set(['.rtf', '.rtfd', '.doc', '.docx', '.odt', '.html', '.htm', '.webarchive', '.wordml']);

/** Lists installed voices, for example { name: 'Samantha', locale: 'en_US' }. */
async function voices() {
  try {
    const { stdout } = await run('say', ['-v', '?']);
    const list = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/);
      if (m) list.push({ name: m[1].trim(), locale: m[2].replace('-', '_') });
    }
    return list;
  } catch {
    return [];
  }
}

const LANG_ORDER = (locale) => (locale.startsWith('en_CA') ? 0 : locale.startsWith('fr_CA') ? 1 : locale.startsWith('en') ? 2 : locale.startsWith('fr') ? 3 : 4);

export default {
  id: 'say',
  platforms: ['darwin'], // uses the voices built into macOS
  name: 'Text to speech',
  summary: 'Turn text into an audio file using the voices built into macOS.',
  submitLabel: 'Make audio file',
  input: {
    label: 'Text file',
    optional: true,
    help: 'Plain text, Word, RTF, OpenDocument or HTML. If you choose a file, the typed text below is ignored.',
    accept: '.txt,.md,.rtf,.doc,.docx,.odt,.html,.htm',
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await which('say')) || !(await which('afconvert'))) {
      result.missing.push({ what: 'This tool only works on a Mac. It uses the say and afconvert commands built into macOS.', install: null });
    }
    const list = (await voices()).sort((a, b) => LANG_ORDER(a.locale) - LANG_ORDER(b.locale) || a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
    result.notes.push({ what: 'To get more or better voices, open System Settings, go to Accessibility, then Spoken Content, then System voice, then Manage Voices. Reload this page after adding voices.', install: null });
    result.options.push(
      { id: 'text', type: 'textarea', label: 'Text to read', optional: true, rows: 10, maxLength: 2000000 },
      {
        id: 'voice', type: 'select', label: 'Voice', default: '',
        choices: [{ value: '', label: 'System voice (set in System Settings)' }, ...list.map((v) => ({ value: v.name, label: `${v.name}, ${v.locale.replace('_', ' ')}` }))],
      },
      { id: 'rate', type: 'number', label: 'Speed in words per minute', help: 'Leave blank for the voice\'s normal speed. Normal is about 175 to 200.', min: 50, max: 700, optional: true },
      {
        id: 'format', type: 'select', label: 'Audio format', default: 'm4a',
        choices: [
          { value: 'm4a', label: 'M4A (AAC, small files, plays almost anywhere)' },
          { value: 'wav', label: 'WAV (large files, best for editing)' },
        ],
      },
    );
    return result;
  },

  validate(o, upload) {
    if (!upload && !o.text.trim()) throw Object.assign(userError('Type some text or choose a text file.'), { field: 'text' });
  },

  async run(ctx) {
    const { input, options: o, workDir, outDir } = ctx;
    const textFile = path.join(workDir, 'text.txt');
    let base = 'speech';
    if (input) {
      base = input.base;
      if (TEXTUTIL.has(input.ext)) {
        ctx.progress(null, null, 'Reading document');
        await ctx.run('textutil', ['-convert', 'txt', '-encoding', 'UTF-8', '-output', textFile, input.path]);
      } else {
        await copyFile(input.path, textFile);
      }
    } else {
      await writeFile(textFile, o.text);
    }

    const aiff = path.join(workDir, 'speech.aiff');
    const args = ['-o', aiff, '-f', textFile];
    if (o.voice) args.push('-v', o.voice);
    if (o.rate) args.push('-r', String(o.rate));
    ctx.progress(null, null, 'Speaking into a file. Long texts can take a few minutes.');
    await ctx.run('say', args);

    ctx.progress(null, null, 'Saving audio');
    const out = path.join(outDir, `${base}.${o.format}`);
    const conv = o.format === 'm4a' ? ['-f', 'm4af', '-d', 'aac'] : ['-f', 'WAVE', '-d', 'LEI16'];
    await ctx.run('afconvert', [...conv, aiff, out]);
    ctx.output(out, 'Audio file');
  },
};
