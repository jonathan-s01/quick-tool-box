// Text to speech with Kokoro, a free, high quality voice model that runs without a graphics card.
// Talks to a Kokoro-FastAPI server (OpenAI-compatible) at KOKORO_URL, default http://localhost:8880.
// Long texts are split into pieces at sentence ends, spoken one by one, then joined with ffmpeg.
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { which, userError, cancelledError } from '../lib/system.js';
import { sniff, plural } from '../lib/files.js';

const BASE = (process.env.KOKORO_URL || 'http://localhost:8880').replace(/\/+$/, '');
const CHUNK = 1500; // characters per request; Kokoro handles long text, but smaller pieces give steady progress

const LANGS = {
  a: 'American English', b: 'British English', e: 'Spanish', f: 'French', h: 'Hindi',
  i: 'Italian', j: 'Japanese', p: 'Brazilian Portuguese', z: 'Mandarin Chinese',
};
const LANG_ORDER = 'abfeipjhz';

/** Turns a Kokoro voice id such as af_heart into "Heart, American English, female". */
function describeVoice(id) {
  const m = /^([a-z])([fm])_(.+)$/.exec(id);
  if (!m) return { id, label: id, order: 99 };
  const name = m[3].replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, label: `${name}, ${LANGS[m[1]] || 'other language'}, ${m[2] === 'f' ? 'female' : 'male'}`, order: LANG_ORDER.indexOf(m[1]) };
}

async function api(p, body, signal) {
  const timeout = AbortSignal.timeout(body ? 10 * 60 * 1000 : 2500);
  let res;
  try {
    res = await fetch(`${BASE}${p}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw cancelledError();
    throw userError(`The Kokoro voice server at ${BASE} could not be reached. Check that it is running.`, String(err.cause || err));
  }
  if (!res.ok) throw userError(`The Kokoro voice server answered with an error (${res.status}).`, await res.text().catch(() => ''));
  return res;
}

let voiceCache = { at: 0, value: undefined };

/** The voices the Kokoro server has, or null if it is not reachable. Remembered for 30 seconds. */
async function voiceList() {
  if (voiceCache.value !== undefined && Date.now() - voiceCache.at < 30000) return voiceCache.value;
  voiceCache = { at: Date.now(), value: await fetchVoices() };
  return voiceCache.value;
}

async function fetchVoices() {
  try {
    const data = await (await api('/v1/audio/voices')).json();
    const ids = (data.voices || data || []).map((v) => (typeof v === 'string' ? v : v.id || v.name)).filter(Boolean);
    return ids.map(describeVoice).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  } catch {
    return null;
  }
}

/** Splits text into pieces of about CHUNK characters, at paragraph or sentence ends where possible. */
export function splitText(text) {
  const pieces = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) pieces.push(cur.trim());
    cur = '';
  };
  const sentences = text.replace(/\r\n?/g, '\n').split(/(?<=[.!?…:;])\s+|\n{2,}/);
  for (let s of sentences) {
    s = s.replace(/\s*\n\s*/g, ' ').trim();
    if (!s) continue;
    while (s.length > CHUNK) {
      // A very long sentence: cut at the last comma or space before the limit.
      let cut = Math.max(s.lastIndexOf(', ', CHUNK), s.lastIndexOf(' ', CHUNK));
      if (cut < CHUNK / 2) cut = CHUNK;
      if (cur) push();
      pieces.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (cur.length + s.length + 1 > CHUNK) push();
    cur += (cur ? ' ' : '') + s;
  }
  push();
  return pieces;
}

const SPEEDS = ['0.7', '0.8', '0.9', '1', '1.1', '1.2', '1.3', '1.5', '1.75', '2'];

export default {
  id: 'kokoro',
  name: 'Text to speech (Kokoro)',
  summary: 'Turns text or a document into a natural sounding audio file with Kokoro, a free voice model that runs on your own server without a graphics card.',
  submitLabel: 'Make audio file',
  input: {
    label: 'Document',
    optional: true,
    help: 'Plain text, Markdown, PDF, Word, OpenDocument, RTF, EPUB or HTML. If you choose a file, the typed text below is ignored.',
    accept: '.txt,.md,.pdf,.doc,.docx,.odt,.rtf,.epub,.html,.htm',
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    const voices = await voiceList();
    if (!voices) {
      result.missing.push({
        what: `The Kokoro voice server at ${BASE} is not running. Start it with Docker (it is in docker-compose.yml), or set KOKORO_URL to where it runs.`,
        install: 'docker run -d --restart=always -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest',
      });
    }
    const [ffmpeg, pdftotext, pandoc] = await Promise.all([which('ffmpeg'), which('pdftotext'), which('pandoc')]);
    if (!ffmpeg) result.notes.push({ what: 'Long texts and the M4A format need ffmpeg to join and convert the audio.', install: process.platform === 'darwin' ? 'brew install ffmpeg' : 'apt install ffmpeg' });
    if (!pdftotext) result.notes.push({ what: 'PDF documents need Poppler.', install: process.platform === 'darwin' ? 'brew install poppler' : 'apt install poppler-utils' });
    if (!pandoc) result.notes.push({ what: 'Word, OpenDocument, RTF, EPUB and HTML documents need Pandoc.', install: process.platform === 'darwin' ? 'brew install pandoc' : 'apt install pandoc' });
    const list = voices?.length ? voices : [describeVoice('af_heart')];
    result.options.push(
      { id: 'text', type: 'textarea', label: 'Text to read', optional: true, rows: 10, maxLength: 2000000 },
      {
        id: 'voice', type: 'select', label: 'Voice', default: list.some((v) => v.id === 'af_heart') ? 'af_heart' : list[0].id,
        help: 'Each voice speaks one language best. Heart and Bella are among the most natural English voices.',
        choices: list.map((v) => ({ value: v.id, label: v.label })),
      },
      {
        id: 'speed', type: 'select', label: 'Speed', default: '1',
        choices: SPEEDS.map((s) => ({ value: s, label: s === '1' ? 'Normal' : `${s} times normal` })),
      },
      {
        id: 'format', type: 'select', label: 'Audio format', default: 'mp3',
        choices: [
          { value: 'mp3', label: 'MP3 (small files, plays anywhere)' },
          { value: 'm4a', label: 'M4A (AAC, small files, good for Apple devices)' },
          { value: 'wav', label: 'WAV (large files, best for editing)' },
        ],
      },
    );
    return result;
  },

  validate(o, upload) {
    if (!upload && !o.text.trim()) throw Object.assign(userError('Type some text or choose a document.'), { field: 'text' });
  },

  async run(ctx) {
    const { input, options: o, workDir, outDir } = ctx;
    let text = o.text;
    let base = 'speech';
    if (input) {
      base = input.base;
      const ext = input.ext.toLowerCase();
      ctx.progress(null, null, 'Reading the document');
      if ((await sniff(input.path)) === 'pdf') {
        const { stdout } = await ctx.run('pdftotext', ['-enc', 'UTF-8', input.path, '-']);
        text = stdout.replace(/\f/g, '\n\n');
      } else if (ext === '.txt' || ext === '') {
        text = await readFile(input.path, 'utf8');
      } else {
        const from = { '.md': 'markdown', '.docx': 'docx', '.odt': 'odt', '.rtf': 'rtf', '.epub': 'epub', '.html': 'html', '.htm': 'html' }[ext];
        if (!from) throw userError('This type of file is not supported. Use text, Markdown, PDF, Word (.docx), OpenDocument, RTF, EPUB or HTML.');
        const { stdout } = await ctx.run('pandoc', ['-f', from, '-t', 'plain', '--wrap=none', input.path]);
        text = stdout;
      }
    }
    text = text.replace(/\u00ad/g, '').replace(/[ \t]+/g, ' ');
    if (!text.trim()) throw userError('No text was found to read. If this is a scanned PDF, run it through OCR first.');

    const pieces = splitText(text);
    const ffmpeg = await which('ffmpeg');
    if ((pieces.length > 1 || o.format === 'm4a') && !ffmpeg) {
      throw userError('This needs ffmpeg, to join the pieces of a long text or to make M4A. Install ffmpeg, or choose MP3 or WAV with a shorter text.');
    }
    const speed = SPEEDS.includes(o.speed) ? Number(o.speed) : 1;
    const out = path.join(outDir, `${base}.${o.format}`);

    if (pieces.length === 1 && o.format !== 'm4a') {
      ctx.progress(null, null, 'Speaking the text');
      const res = await api('/v1/audio/speech', { model: 'kokoro', input: pieces[0], voice: o.voice, speed, response_format: o.format }, ctx.signal);
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
    } else {
      const list = [];
      for (const [i, piece] of pieces.entries()) {
        ctx.progress(i, pieces.length, `Speaking part ${i + 1} of ${pieces.length}`);
        const res = await api('/v1/audio/speech', { model: 'kokoro', input: piece, voice: o.voice, speed, response_format: 'wav' }, ctx.signal);
        const f = path.join(workDir, `part-${String(i).padStart(5, '0')}.wav`);
        await writeFile(f, Buffer.from(await res.arrayBuffer()));
        list.push(`file '${f.replace(/'/g, "'\\''")}'`);
      }
      ctx.progress(null, null, 'Joining the audio');
      const listFile = path.join(workDir, 'parts.txt');
      await writeFile(listFile, `${list.join('\n')}\n`);
      const codec = { mp3: ['-c:a', 'libmp3lame', '-q:a', '3'], m4a: ['-c:a', 'aac', '-b:a', '128k'], wav: ['-c:a', 'pcm_s16le'] }[o.format];
      await ctx.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...codec, out]);
    }
    ctx.output(out, 'Audio file');
    const words = text.trim().split(/\s+/).length;
    ctx.finishMessage(`Made ${o.format.toUpperCase()} audio of ${plural(words, 'word')}${pieces.length > 1 ? `, in ${plural(pieces.length, 'part')} joined together` : ''}.`);
  },
};
