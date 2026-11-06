// The status page: is everything this app uses reachable, which AI models are there, and how much space is left.
import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { esc, layout } from './html.js';
import { which } from './system.js';
import { OLLAMA_HOSTS, ollamaStatus, activeOllama } from './ollama.js';
import { doclingServeStatus, DOCLING_URL } from './docling-serve.js';
import { pymupdfCommand } from './pymupdf.js';
import { chromiumPath } from './menu.js';
import { sofficePath } from './to-pdf.js';
import { dataPath } from './data.js';
import { ROOT } from './jobs.js';

const KOKORO_URL = (process.env.KOKORO_URL || 'http://localhost:8880').replace(/\/+$/, '');

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;

async function space(dir) {
  try {
    const s = await statfs(dir);
    return `${gb(s.bavail * s.bsize)} free of ${gb(s.blocks * s.bsize)}`;
  } catch {
    return 'could not be checked';
  }
}

async function kokoroStatus() {
  try {
    const res = await fetch(`${KOKORO_URL}/v1/audio/voices`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { reachable: false, error: `answered ${res.status}` };
    const data = await res.json();
    return { reachable: true, voices: (data.voices || data || []).length };
  } catch (err) {
    return { reachable: false, error: String(err.cause?.code || err.message || err) };
  }
}

const ok = (b) => (b ? 'Working' : 'Not reachable');

export async function statusPage(tools) {
  const where = process.platform === 'darwin' ? 'This Mac' : 'This server';
  const [dataSpace, tmpSpace, ollamas, active, docling, kokoro, programs, setups] = await Promise.all([
    dataPath().then(space).catch(() => 'could not be checked'),
    space(ROOT),
    Promise.all(OLLAMA_HOSTS.map(async (h) => ({ h, s: await ollamaStatus(h) }))),
    activeOllama(),
    doclingServeStatus(),
    kokoroStatus(),
    Promise.all([
      ['Chromium (menu reader web pages)', chromiumPath()],
      ['PyMuPDF (redactor, form filler)', pymupdfCommand()],
      ['LibreOffice (Word files)', sofficePath()],
      ['Poppler (PDF text)', which('pdftotext')],
      ['Tesseract (OCR)', which('tesseract')],
      ['OCRmyPDF', which('ocrmypdf')],
      ['ImageMagick', which('magick')],
      ['ffmpeg (audio and video)', which('ffmpeg')],
      ['Pandoc (documents)', which('pandoc')],
      ['Docling installed here', which('docling')],
    ].map(async ([name, p]) => ({ name, found: Boolean(await p.catch(() => null)) }))),
    Promise.all([...tools.values()].map(async (t) => ({ t, s: await t.setup().catch(() => ({ missing: [{ what: 'Its setup check failed.' }] })) }))),
  ]);

  const mem = `${gb(os.freemem())} free of ${gb(os.totalmem())}`;
  const ollamaHtml = ollamas.map(({ h, s }) => {
    const head = `<h2>AI models: ${esc(h.label)}</h2>\n<p>${esc(h.url)}. ${ok(s.reachable)}${s.reachable ? `, ${esc(s.version)}` : `: ${esc(s.error)}`}.${h === active ? ' In use now.' : ''}</p>`;
    if (!s.reachable) return head;
    if (!s.models.length) return `${head}\n<p>No models installed.</p>`;
    return `${head}\n<ul>\n${s.models.sort((a, b) => a.size - b.size).map((m) => {
      const caps = [m.capabilities.includes('vision') ? 'can see images' : '', m.capabilities.includes('embedding') && !m.capabilities.includes('completion') ? 'for search only' : ''].filter(Boolean);
      return `<li>${esc(m.name)}${m.size ? `, ${gb(m.size)}` : ''}${caps.length ? `, ${caps.join(', ')}` : ''}</li>`;
    }).join('\n')}\n</ul>`;
  }).join('\n');

  const needs = setups.filter(({ s }) => s.missing?.length);
  const body = `<h1>Status</h1>
<p>Checked: ${esc(new Date().toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
<p>Reload the page to check again.</p>
<h2>${esc(where)}</h2>
<ul>
<li>Free space for saved data: ${esc(dataSpace)}</li>
<li>Free space for jobs in progress: ${esc(tmpSpace)}</li>
<li>Memory: ${esc(mem)}</li>
<li>Processor load, last minute: ${os.loadavg()[0].toFixed(1)} on ${os.cpus().length} cores</li>
</ul>
<h3>Programs</h3>
<ul>
${programs.map((p) => `<li>${esc(p.name)}: ${p.found ? 'found' : 'not installed'}</li>`).join('\n')}
</ul>
${ollamaHtml}
<h2>Kokoro voice server</h2>
<p>${esc(KOKORO_URL)}. ${ok(kokoro.reachable)}${kokoro.reachable ? `, ${kokoro.voices} voices` : `: ${esc(kokoro.error)}`}.</p>
<h2>Docling server</h2>
<p>${esc(DOCLING_URL)}. ${ok(docling.reachable)}${docling.reachable ? (docling.version ? `, version ${esc(docling.version)}` : '') : `: ${esc(docling.error)}`}.</p>
<h2>Tools that need setup</h2>
${needs.length ? `<ul>\n${needs.map(({ t, s }) => `<li><a href="/tools/${esc(t.id)}">${esc(t.name)}</a>: ${esc(s.missing[0].what)}</li>`).join('\n')}\n</ul>` : '<p>None. Every tool is ready.</p>'}`;
  return layout({ title: 'Status', body });
}
