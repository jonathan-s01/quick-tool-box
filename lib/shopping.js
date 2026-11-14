// Shared shopping list. One list for everyone on the allowed networks, kept in DATA_DIR/shopping/state.json.
// The rules for what goes on the list are in public/shopping-core.js, shared with the page.
//   GET  /shopping              the page
//   GET  /shopping/sw.js        lets the page open without a connection (https only)
//   GET  /api/shopping          { rev, state }   (?rev=N answers { rev, same: true } if nothing changed)
//   POST /api/shopping/ops      { ops: [{ id, type, ... }] }  ->  { rev, state }
import path from 'node:path';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dataPath } from './data.js';
import { readJson } from './http.js';
import { layout } from './html.js';
import { applyOp, emptyState } from '../public/shopping-core.js';

let doc = null; // { rev, state, seen: [op ids] }
let saving = Promise.resolve();
const MAX_SEEN = 2000;

async function file() {
  return path.join(await dataPath('shopping'), 'state.json');
}

async function load() {
  if (doc) return doc;
  try {
    const saved = JSON.parse(await readFile(await file(), 'utf8'));
    doc = { rev: saved.rev || 1, state: { ...emptyState(), ...saved.state }, seen: saved.seen || [] };
  } catch {
    doc = { rev: 1, state: emptyState(), seen: [] };
  }
  return doc;
}

function save() {
  const snapshot = JSON.stringify(doc);
  saving = saving.then(async () => {
    const f = await file();
    await writeFile(`${f}.tmp`, snapshot);
    await rename(`${f}.tmp`, f);
  }).catch((err) => console.error('Shopping list could not be saved:', err));
  return saving;
}

const OP_TYPES = new Set(['meal', 'house', 'common', 'check', 'addExtra', 'removeExtra', 'stockAll', 'clearSel', 'done', 'setText']);

function page() {
  return layout({
    title: 'Shopping list',
    module: '/static/shopping.js',
    body: `<h1>Shopping list</h1>
<p>One list shared by everyone at home. Ticks and changes are saved on the server and show up on other phones within about 15 seconds. Changes made without a connection are kept and sent when you are back online.</p>
<div role="status" id="sh-status" class="status"></div>
<p id="sh-sync" class="note">Loading.</p>
<p><button type="button" id="sh-refresh">Refresh now</button></p>
<section aria-labelledby="sh-list-h">
<h2 id="sh-list-h">To buy</h2>
<div class="field check"><input type="checkbox" id="sh-hide"><label for="sh-hide">Hide ticked items</label></div>
<div id="sh-stores"></div>
<p><button type="button" id="sh-done">Done shopping</button></p>
<p class="help">Done shopping clears ticked items, this week's meals and household picks. Ticked common items go back to in stock. Anything not ticked stays on the list as a one-off item.</p>
</section>
<section aria-labelledby="sh-add-h">
<h2 id="sh-add-h">Add an item</h2>
<form id="sh-add" novalidate>
<div class="field"><label for="sh-item">Item</label><input type="text" id="sh-item" class="wide" autocomplete="off" list="sh-known"></div>
<datalist id="sh-known"></datalist>
<div class="field"><label for="sh-store">Store</label><select id="sh-store"></select><p class="help">Automatic uses the store the item is listed under.</p></div>
<button type="submit">Add item</button>
</form>
<h3>One-off items</h3>
<ul id="sh-extras"></ul>
</section>
<section aria-labelledby="sh-plan-h">
<h2 id="sh-plan-h">Plan</h2>
<fieldset id="sh-meals"><legend>Meals this week</legend></fieldset>
<details><summary id="sh-common-sum">Common items</summary>
<p class="help">Checked means you have it. Uncheck an item when it runs out and it goes on the list.</p>
<div id="sh-common"></div>
<p><button type="button" id="sh-stockall">Mark all as in stock</button></p>
</details>
<details><summary id="sh-house-sum">Household and extras</summary>
<p class="help">Check anything to buy this trip.</p>
<div id="sh-house"></div>
</details>
<p><button type="button" id="sh-clear">Clear everything on the list</button></p>
</section>
<section aria-labelledby="sh-edit-h">
<h2 id="sh-edit-h">Edit lists</h2>
<details><summary>Stores, meals and items</summary>
<p class="help">Plain text. A line starting with # is a section: Stores, Meals, Common items, Household and extras. A line starting with ## is a store or a meal. A line starting with - is an item. Meal ingredients must be spelled the same as in the store lists. Edits are shared with everyone.</p>
<label for="sh-text">Lists</label>
<textarea id="sh-text" rows="24" spellcheck="false"></textarea>
<p><button type="button" id="sh-save">Save lists</button> <button type="button" id="sh-default">Load built-in lists</button></p>
</details>
</section>`,
  });
}

const SW = `// Keeps the shopping page available without a connection. Lists themselves are kept by the page.
const CACHE = 'shopping-v1';
const FILES = ['/shopping', '/static/style.css', '/static/shopping.js', '/static/shopping-core.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !FILES.includes(u.pathname)) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(u.pathname, copy)); }
    return r;
  }).catch(() => caches.match(u.pathname)));
});
`;

/** Handles /shopping and /api/shopping. Returns false if the address is not one of ours. */
export async function shoppingRoutes(req, res, url, { send, json }) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/shopping') return send(res, 200, page());
  if (req.method === 'GET' && p === '/shopping/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/', 'X-Content-Type-Options': 'nosniff' });
    return res.end(SW);
  }
  if (req.method === 'GET' && p === '/api/shopping') {
    const d = await load();
    if (Number(url.searchParams.get('rev')) === d.rev) return json(res, 200, { rev: d.rev, same: true });
    return json(res, 200, { rev: d.rev, state: d.state });
  }
  if (req.method === 'POST' && p === '/api/shopping/ops') {
    let body;
    try { body = await readJson(req); } catch (err) { return json(res, err.status || 400, { error: err.message }); }
    const ops = Array.isArray(body?.ops) ? body.ops.slice(0, 500) : [];
    const d = await load();
    const seen = new Set(d.seen);
    let changed = false;
    for (const op of ops) {
      if (!op || typeof op !== 'object' || !OP_TYPES.has(op.type) || typeof op.id !== 'string') continue;
      if (seen.has(op.id)) continue; // already applied: a retry after a dropped connection
      seen.add(op.id);
      d.seen.push(op.id);
      d.state = applyOp(d.state, op);
      changed = true;
    }
    if (changed) {
      if (d.seen.length > MAX_SEEN) d.seen = d.seen.slice(-MAX_SEEN);
      d.rev += 1;
      await save();
    }
    return json(res, 200, { rev: d.rev, state: d.state });
  }
  return false;
}
