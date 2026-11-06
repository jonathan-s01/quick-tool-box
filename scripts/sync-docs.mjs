// Copies the documents folder into Open WebUI as knowledge collections. Run it with ./docs.sh.
//
// Each folder inside documents becomes one knowledge collection with the same name. Files directly
// in documents go into a collection called "Documents". New and changed files are uploaded, and files you
// deleted are taken out of the collection. In a chat, type # and choose the collection to use it.
//
// Needs OPEN_WEBUI_API_KEY in .env (Open WebUI: Settings, Account, API keys).
// Uses Open WebUI's documented API: /api/v1/files/ and /api/v1/knowledge/.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.DOCS_DIR || '/documents';
const STATE = path.join(ROOT, '.openwebui-sync.json');
const BASE = (process.env.OPEN_WEBUI_URL || 'http://localhost:8080').replace(/\/+$/, '');
const KEY = process.env.OPEN_WEBUI_API_KEY || '';
const TYPES = new Set(['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.html', '.htm', '.csv', '.xlsx', '.xls', '.pptx', '.epub', '.json', '.xml']);

if (!KEY) {
  console.error('Add OPEN_WEBUI_API_KEY to .env first. In Open WebUI: Settings, Account, API keys, then make a key.');
  console.error('If you do not see API keys, an administrator has to turn them on: Admin Panel, Settings, General.');
  process.exit(1);
}

async function api(method, p, body, isForm = false) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(`${method} ${p}: ${res.status} ${data?.detail || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (TYPES.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE, 'utf8')); } catch { return { knowledge: {}, files: {} }; }
}

async function knowledgeId(state, name) {
  const known = state.knowledge[name];
  if (known) {
    try {
      await api('GET', `/api/v1/knowledge/${known}`);
      return known;
    } catch (err) {
      if (err.status !== 404) throw err; // deleted in Open WebUI: make it again
    }
  }
  const made = await api('POST', '/api/v1/knowledge/create', { name, description: `Synced from the documents folder: ${name}` });
  state.knowledge[name] = made.id;
  console.log(`Made knowledge collection "${name}".`);
  return made.id;
}

async function waitProcessed(fileId) {
  for (let i = 0; i < 120; i++) {
    try {
      const s = await api('GET', `/api/v1/files/${fileId}/process/status`);
      if (!s || s.status === 'completed') return true;
      if (s.status === 'failed') throw new Error(s.error || 'Open WebUI could not read this file.');
    } catch (err) {
      if (err.status === 404) return true; // older Open WebUI: processed during upload
      throw err;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('Open WebUI took more than 5 minutes to read this file.');
}

async function main() {
  const state = await loadState();
  const files = await walk(ROOT);
  const seen = new Set();
  let added = 0;
  let removed = 0;
  let failed = 0;
  for (const full of files) {
    const rel = path.relative(ROOT, full);
    seen.add(rel);
    const top = rel.includes(path.sep) ? rel.split(path.sep)[0] : 'Documents';
    const st = await stat(full);
    const prev = state.files[rel];
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs && prev.kb === top) continue;
    try {
      const kb = await knowledgeId(state, top);
      if (prev?.fileId) {
        await api('POST', `/api/v1/knowledge/${state.knowledge[prev.kb] || kb}/file/remove`, { file_id: prev.fileId }).catch(() => {});
      }
      process.stdout.write(`Adding ${rel}... `);
      const form = new FormData();
      form.append('file', new Blob([await readFile(full)]), path.basename(full));
      const up = await api('POST', '/api/v1/files/', form, true);
      await waitProcessed(up.id);
      await api('POST', `/api/v1/knowledge/${kb}/file/add`, { file_id: up.id });
      state.files[rel] = { size: st.size, mtime: st.mtimeMs, fileId: up.id, kb: top };
      added++;
      console.log('done');
      await writeFile(STATE, JSON.stringify(state, null, 2));
    } catch (err) {
      failed++;
      console.log(`failed: ${err.message}`);
    }
  }
  for (const [rel, info] of Object.entries(state.files)) {
    if (seen.has(rel)) continue;
    try {
      await api('POST', `/api/v1/knowledge/${state.knowledge[info.kb]}/file/remove`, { file_id: info.fileId });
    } catch { /* already gone */ }
    delete state.files[rel];
    removed++;
    console.log(`Removed ${rel} (no longer in the folder).`);
  }
  await writeFile(STATE, JSON.stringify(state, null, 2));
  console.log(`\n${added} added or updated, ${removed} removed, ${failed} failed, ${files.length - added - failed} unchanged.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nCould not sync: ${err.message}`);
  console.error(`Check that Open WebUI is running at ${BASE} and that the API key is right.`);
  process.exit(1);
});
