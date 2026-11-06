// Quick Tool Box: simple, accessible local web pages for command line tools.
// Start with: npm start   (or: node server.js)
import http from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homePage, toolPage, messagePage } from './lib/pages.js';
import { readOptions } from './lib/options.js';
import { HOST, PORT, LOCAL_ONLY, addressAllowed, hostAllowed, originAllowed } from './lib/access.js';
import { continueJob } from './lib/review.js';
import { menuLibrary } from './lib/menu-library.js';
import { formsAndProfile, loginGate } from './lib/forms.js';
import { statusPage } from './lib/status.js';
import { findRoutes } from './lib/find.js';
import { readFormData, readJson } from './lib/http.js';
import { startJob, getJob, publicJob, resetWorkArea, removeWorkAreaSync, VIEWABLE } from './lib/jobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- Load every tool in the tools folder ----
const tools = new Map();
for (const file of (await readdir(path.join(HERE, 'tools'))).filter((f) => f.endsWith('.js')).sort()) {
  const mod = await import(pathToFileURL(path.join(HERE, 'tools', file)).href);
  const tool = mod.default;
  if (tool?.platforms && !tool.platforms.includes(process.platform)) continue; // for example Mac-only tools on Linux
  if (!tool?.id || !tool?.run || !tool?.setup) {
    console.warn(`Skipping tools/${file}: it needs id, setup and run.`);
    continue;
  }
  tools.set(tool.id, tool);
}

const STATIC = {
  '/static/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/static/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/static/forms.js': ['public/forms.js', 'text/javascript; charset=utf-8'],
  '/static/find.js': ['public/find.js', 'text/javascript; charset=utf-8'],
};

const TYPES = {
  '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.zip': 'application/zip',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.tif': 'image/tiff',
  '.srt': 'application/x-subrip; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.odt': 'application/vnd.oasis.opendocument.text',
  '.epub': 'application/epub+zip', '.rtf': 'application/rtf', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.xml': 'application/xml; charset=utf-8', '.json': 'application/json; charset=utf-8',
};


function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

const json = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');

function shareAllowed(req) {
  if (req.headers.origin) return false; // browsers use the normal route, with its Origin check
  // X-Quick-Tool-Box is the header to use; X-CLI-Wrappers still works for shortcuts made before the rename.
  const shareHeader = req.headers['x-quick-tool-box'] || req.headers['x-cli-wrappers'];
  if (shareHeader !== 'share') return false;
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none' && req.headers['sec-fetch-site'] !== 'same-origin') return false;
  if (process.env.SHARE_TOKEN) return req.headers['x-share-token'] === process.env.SHARE_TOKEN;
  // With REQUIRE_LOGIN on, shares would skip the login, so they need SHARE_TOKEN too.
  return process.env.REQUIRE_LOGIN !== '1';
}

/**
 * Starts a job from an iPhone share (Shortcuts "Get contents of URL", POST, form).
 * Fields with the same name as a tool option are used; everything else gets its default.
 * The file goes in a field called file. Answers with a plain-text address to open in Safari,
 * which follows the job and opens the result page when it is ready.
 */
async function share(req, res, toolId) {
  const base = `${/^https$/i.test(req.headers['x-forwarded-proto'] || '') ? 'https' : 'http'}://${req.headers.host}`;
  const fail = (reason) => send(res, 200, `${base}/share-failed?reason=${encodeURIComponent(reason)}`, 'text/plain; charset=utf-8');
  const tool = tools.get(toolId);
  if (!tool) return fail(`There is no tool called ${toolId}.`);
  const setup = await tool.setup();
  if (setup.missing.length) return fail(`${tool.name} needs setup first: ${setup.missing[0].what}`);
  let incoming;
  try {
    incoming = await readFormData(req);
  } catch (err) {
    if (err.status === 413) return fail(err.message);
    return fail('What was shared could not be read. In the shortcut, set Request Body to Form.');
  }
  const form = new FormData();
  for (const opt of setup.options) {
    const v = incoming.get(opt.id);
    if (v != null && typeof v === 'string') form.append(opt.id, v);
    else if (opt.type === 'checkbox' && opt.default) form.append(opt.id, 'on');
  }
  try {
    const options = readOptions(setup.options, form);
    let upload = tool.input ? incoming.get('file') : null;
    if (!upload || typeof upload === 'string' || upload.size === 0) upload = null;
    if (tool.input && !upload && !tool.input.optional) return fail(`${tool.name} needs a file. Share a file or photo, not text or a link.`);
    if (tool.validate) await tool.validate(options, upload);
    const job = await startJob(tool, options, upload);
    return send(res, 200, `${base}/tools/${tool.id}?job=${job.id}&open=1`, 'text/plain; charset=utf-8');
  } catch (err) {
    if (!err.userFacing) throw err;
    return fail(err.message);
  }
}

async function handle(req, res) {
  // Block other websites from talking to this server through your browser.
  if (!addressAllowed(req.socket.remoteAddress)) return send(res, 403, 'Forbidden', 'text/plain');
  if (!hostAllowed(req.headers.host)) return send(res, 403, 'Forbidden: this address is not on the allowed list. Add it to ALLOWED_HOSTNAMES.', 'text/plain');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  let m;

  // For Docker's health check: answers without checking anything slow.
  if (req.method === 'GET' && p === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');

  // Shares from iPhone Shortcuts have no Origin header. They must send X-Quick-Tool-Box: share instead,
  // which a web page on another site cannot send without this server's permission.
  if (req.method === 'POST' && (m = p.match(/^\/api\/share\/([\w-]+)$/)) && shareAllowed(req)) {
    return share(req, res, m[1]);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'Forbidden' });
  }

  if (!p.startsWith('/static/') && loginGate(req, res, p)) return;

  if (req.method === 'GET' && p === '/status') return send(res, 200, await statusPage(tools));
  if (req.method === 'GET' && p === '/share-failed') {
    return send(res, 400, messagePage('Could not start', (url.searchParams.get('reason') || 'Something went wrong.').slice(0, 500)));
  }

  if (p === '/profile' || p.startsWith('/profile/') || p === '/forms' || p.startsWith('/forms/')) {
    const handled = await formsAndProfile(req, res, p);
    if (handled !== false) return;
  }

  if (req.method === 'GET' && p === '/') {
    const list = await Promise.all([...tools.values()].sort((a, b) => a.name.localeCompare(b.name)).map(async (tool) => ({ tool, setup: await tool.setup() })));
    return send(res, 200, homePage(list));
  }

  if (p === '/favicon.ico') return send(res, 204, '');

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    return send(res, 200, await readFile(path.join(HERE, file)), type);
  }

  if (req.method === 'GET' && (m = p.match(/^\/tools\/([\w-]+)$/))) {
    const tool = tools.get(m[1]);
    if (!tool) return send(res, 404, messagePage('Not found', 'There is no tool at this address.'));
    return send(res, 200, toolPage(tool, await tool.setup()));
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/tools\/([\w-]+)\/jobs$/))) {
    const tool = tools.get(m[1]);
    if (!tool) return json(res, 404, { error: 'Unknown tool.' });
    const setup = await tool.setup();
    if (setup.missing.length) return json(res, 400, { error: 'This tool needs setup first. Reload the page for details.' });
    let form;
    try {
      form = await readFormData(req);
    } catch (err) {
      return json(res, err.status || 400, { error: err.message, field: err.status === 413 ? 'file' : undefined });
    }
    let options;
    try {
      options = readOptions(setup.options, form);
    } catch (err) {
      if (!err.userFacing) throw err;
      return json(res, 400, { error: err.message, field: err.field ? `opt-${err.field}` : undefined });
    }
    let upload = null;
    if (tool.input) {
      upload = form.get('file');
      if (!upload || typeof upload === 'string' || upload.size === 0) upload = null;
      if (!upload && !tool.input.optional) return json(res, 400, { error: 'Please choose a file.', field: 'file' });
    }
    if (tool.validate) {
      try {
        await tool.validate(options, upload);
      } catch (err) {
        if (!err.userFacing) throw err;
        return json(res, 400, { error: err.message, field: err.field ? (err.field === 'file' ? 'file' : `opt-${err.field}`) : undefined });
      }
    }
    const job = await startJob(tool, options, upload);
    return json(res, 202, publicJob(job));
  }

  // Second step of tools that ask you to choose before finishing (for example the redactor).
  if (req.method === 'POST' && (m = p.match(/^\/api\/jobs\/([\w-]+)\/continue$/))) {
    const job = getJob(m[1]);
    const tool = job && tools.get(job.toolId);
    if (!job || !tool) return json(res, 404, { error: 'This job no longer exists. Please start again.' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, err.status || 400, { error: err.message });
    }
    try {
      const next = await continueJob(tool, job, body);
      return json(res, 202, publicJob(next));
    } catch (err) {
      if (!err.userFacing) throw err;
      return json(res, 400, { error: err.message });
    }
  }

  if (p.startsWith('/find/')) {
    const handled = findRoutes(req, res, url, { send, messagePage });
    if (handled !== false) return;
  }

  if (p === '/menus' || p.startsWith('/menus/')) {
    const handled = await menuLibrary(req, res, p, { send, json, messagePage });
    if (handled !== false) return;
  }

  if (req.method === 'GET' && (m = p.match(/^\/api\/jobs\/([\w-]+)$/))) {
    const job = getJob(m[1]);
    if (!job) return json(res, 404, { error: 'This job no longer exists.' });
    return json(res, 200, publicJob(job));
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/))) {
    const job = getJob(m[1]);
    if (!job) return json(res, 404, { error: 'This job no longer exists.' });
    if (job.state === 'running') job.controller.abort();
    return json(res, 200, publicJob(job));
  }

  if (req.method === 'GET' && (m = p.match(/^\/api\/jobs\/([\w-]+)\/(files|view)\/(\d+)$/))) {
    const job = getJob(m[1]);
    const out = job?.state === 'done' ? job.outputs[Number(m[3])] : null;
    if (!out) return send(res, 404, messagePage('Not found', 'This file is no longer available. Files are deleted an hour after a job finishes.'));
    const ext = path.extname(out.name).toLowerCase();
    if (m[2] === 'view' && VIEWABLE.has(ext)) {
      // Open in the browser. HTML is shown in a locked-down sandbox: no scripts, no outside requests.
      res.writeHead(200, {
        'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Length': out.size,
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:",
      });
      return createReadStream(out.path).pipe(res);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(out.name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': out.size,
      'Content-Disposition': `attachment; filename="${out.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(out.name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return createReadStream(out.path).pipe(res);
  }

  return send(res, 404, messagePage('Not found', 'There is nothing at this address.'));
}

await resetWorkArea();
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, messagePage('Error', 'Something went wrong. Details are in the server log (the Terminal window, or docker compose logs).'));
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const address = `http://localhost:${PORT}`;
  console.log(`Quick Tool Box is running at ${address}`);
  if (!LOCAL_ONLY) console.log(`Listening on ${HOST}:${PORT} for your home network and Tailscale.`);
  console.log('Press Control+C to stop it.');
  if (process.platform === 'darwin' && !process.env.NO_OPEN) spawn('open', [address], { stdio: 'ignore', detached: true }).unref();
});

// Keep running if something unexpected goes wrong in the background; the log says what happened.
process.on('unhandledRejection', (err) => console.error('Unhandled error (the server keeps running):', err));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    removeWorkAreaSync();
    process.exit(0);
  });
}
