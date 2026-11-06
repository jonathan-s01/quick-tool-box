// Quick self-check after changing code: npm run check
// 1. Every JavaScript file parses and every Python helper compiles.
// 2. The server starts on a spare port, and every page answers without a server error.
// Nothing outside this folder is changed; saved data goes to a temporary folder that is removed after.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const fail = (msg) => { failed++; console.log(`FAIL ${msg}`); };
const pass = (msg) => console.log(`ok   ${msg}`);

const js = ['server.js', ...['lib', 'tools', 'public', 'scripts'].flatMap((d) => readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).map((f) => path.join(d, f)))];
for (const f of js) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  if (r.status) fail(`${f} does not parse:\n${r.stderr}`);
}
pass(`${js.length} JavaScript files parse`);
const py = readdirSync(path.join(ROOT, 'helpers')).filter((f) => f.endsWith('.py'));
const pyBin = ['python3', 'python'].find((b) => spawnSync(b, ['--version']).status === 0);
if (pyBin) {
  for (const f of py) {
    const r = spawnSync(pyBin, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(ROOT, 'helpers', f)], { encoding: 'utf8' });
    if (r.status) fail(`helpers/${f} does not compile:\n${r.stderr}`);
  }
  pass(`${py.length} Python helpers compile`);
}

const port = 30000 + Math.floor(Math.random() * 20000);
const data = mkdtempSync(path.join(os.tmpdir(), 'cw-check-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, WORK_DIR: path.join(data, 'work'), NO_OPEN: '1', OLLAMA_HOST: '127.0.0.1:9', OLLAMA_MAC_HOST: '', LLM_MAC_URLS: '', LLM_SERVER_URL: '', LLM_MODELS_FILE: '/nonexistent', KOKORO_URL: 'http://127.0.0.1:9', DOCLING_URL: 'http://127.0.0.1:9' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${port}`;
const origin = { origin: base };

async function get(p, expect = [200]) {
  const res = await fetch(base + p, { redirect: 'manual' });
  if (!expect.includes(res.status)) fail(`GET ${p} answered ${res.status}`);
  return res;
}

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await get('/healthz');
  const home = await (await get('/')).text();
  const toolIds = [...home.matchAll(/href="\/tools\/([\w-]+)"/g)].map((m) => m[1]);
  if (!toolIds.length) fail('home page lists no tools');
  for (const id of toolIds) await get(`/tools/${id}`);
  pass(`home page and ${toolIds.length} tool pages`);
  for (const p of ['/status', '/menus', '/profile']) await get(p);
  await get('/forms', [303]);
  await get('/no-such-page', [404]);
  await get('/api/jobs/does-not-exist', [404]);
  pass('status, menus, profile, forms and not-found pages');

  let r = await fetch(`${base}/api/tools/${toolIds[0]}/jobs`, { method: 'POST', body: new FormData() });
  if (r.status !== 403) fail(`POST without Origin answered ${r.status}, expected 403`);
  r = await fetch(`${base}/api/share/no-such-tool`, { method: 'POST', headers: { 'x-quick-tool-box': 'share' }, body: new FormData() });
  if (!(await r.text()).includes('/share-failed')) fail('share to an unknown tool did not give a share-failed address');
  r = await fetch(`${base}/api/jobs/x/continue`, { method: 'POST', headers: { ...origin, 'content-type': 'application/json' }, body: '{' });
  if (r.status !== 404) fail(`continue on unknown job answered ${r.status}`);
  const big = new FormData();
  big.append('file', new Blob([new Uint8Array(2 * 1024 * 1024)]), 'big.pdf');
  r = await fetch(`${base}/profile/signature`, { method: 'POST', headers: origin, body: big, redirect: 'manual' });
  if (r.status >= 500) fail(`signature upload without a profile answered ${r.status}`);
  pass('safety checks on posts and shares');

  r = await fetch(`${base}/profile/create`, { method: 'POST', headers: origin, body: new URLSearchParams({ name: 'Check', password: 'check-password-1', password2: 'check-password-1' }), redirect: 'manual' });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('cw_session=')) fail('making a profile did not unlock it');
  else {
    for (const p of ['/profile', '/profile/edit', '/profile/signature', '/forms']) {
      const res = await fetch(base + p, { headers: { cookie }, redirect: 'manual' });
      if (res.status !== 200) fail(`GET ${p} with an unlocked profile answered ${res.status}`);
    }
    pass('profile pages when unlocked');
  }
} catch (err) {
  fail(`check stopped: ${err.stack || err}`);
} finally {
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
if (/Error|Unhandled/.test(log)) fail(`the server log has errors:\n${log}`);
console.log(failed ? `\n${failed} problem(s) found.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
