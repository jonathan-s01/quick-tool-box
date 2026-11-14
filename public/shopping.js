// Shopping list page. The rules are in shopping-core.js (shared with the server).
// The page keeps the last list from the server plus any changes not sent yet, in this browser,
// so it keeps working without a connection and catches up when it is back.
import { applyOp, compute, parseDoc, checkDoc, DEFAULT_TEXT, emptyState, UNASSIGNED } from './shopping-core.js';

const LS_SERVER = 'shop.server';
const LS_PENDING = 'shop.pending';
const LS_HIDE = 'shop.hide';
const POLL_MS = 15000;

const $ = (id) => document.getElementById(id);
const read = (k, fallback) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: still works until the page closes */ } };

let server = read(LS_SERVER, null); // { rev, state }
let pending = read(LS_PENDING, []); // ops not yet confirmed by the server
let online = true;
let busy = false;
let lastSync = null;
let textDirty = false;
let focusFallback = null;

const say = (m) => { $('sh-status').textContent = ''; setTimeout(() => { $('sh-status').textContent = m; }, 50); };
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const idFor = (prefix, s) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${prefix}-${(h >>> 0).toString(36)}`;
};

function current() {
  let st = server?.state || emptyState();
  for (const op of pending) st = applyOp(st, op);
  return st;
}

/** Makes a change: shows it straight away, then sends it. */
function change(op, message) {
  pending.push({ ...op, id: newId() });
  write(LS_PENDING, pending);
  render();
  if (message) say(message);
  sync();
}

// ---------------------------------------------------------------- drawing

function checkbox(box, id, label, checked, onchange) {
  const d = document.createElement('div');
  d.className = 'field check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = id;
  cb.checked = checked;
  cb.addEventListener('change', () => onchange(cb.checked, cb));
  const lb = document.createElement('label');
  lb.htmlFor = id;
  lb.textContent = label;
  d.append(cb, lb);
  box.append(d);
  return cb;
}

function render() {
  const active = document.activeElement?.id;
  const st = current();
  const v = compute(st);
  const hide = read(LS_HIDE, false);
  $('sh-hide').checked = hide;

  // To buy, one list per store.
  const stores = $('sh-stores');
  stores.replaceChildren();
  if (!v.stores.length) {
    const p = document.createElement('p');
    p.textContent = 'Nothing to buy. Tick some meals below, or add an item.';
    stores.append(p);
  }
  for (const s of v.stores) {
    const h = document.createElement('h3');
    h.id = idFor('st', s.name);
    h.tabIndex = -1;
    h.textContent = `${s.name}: ${s.left} of ${s.items.length} left`;
    const box = document.createElement('div');
    const shown = hide ? s.items.filter((i) => !i.checked) : s.items;
    shown.forEach((it, n) => {
      checkbox(box, idFor('it', it.key), it.label, it.checked, (on) => {
        const next = shown[n + 1] || shown[n - 1];
        focusFallback = next ? idFor('it', next.key) : h.id;
        change({ type: 'check', item: it.key, on });
      });
    });
    if (hide && !shown.length) {
      const p = document.createElement('p');
      p.textContent = 'Everything here is ticked.';
      box.append(p);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = `Copy ${s.name} list`;
    copy.id = idFor('cp', s.name);
    copy.addEventListener('click', () => copyText(s.items.filter((i) => !i.checked).map((i) => i.label).join('\n'), `${s.name} list`));
    const p = document.createElement('p');
    p.append(copy);
    stores.append(h, box, p);
  }
  $('sh-done').hidden = !v.total;

  // Add an item.
  const sel = $('sh-store');
  const keep = sel.value;
  sel.replaceChildren(new Option('Automatic', ''), ...v.storeNames.map((n) => new Option(n, n)));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
  $('sh-known').replaceChildren(...[...new Set(v.d.stores.flatMap((g) => g.items))].sort().map((i) => new Option(i)));
  const ex = $('sh-extras');
  ex.replaceChildren();
  if (!st.extras.length) {
    const li = document.createElement('li');
    li.textContent = 'None.';
    ex.append(li);
  }
  st.extras.forEach((e, n) => {
    const li = document.createElement('li');
    li.append(`${e.item}${e.store ? ` (${e.store})` : ''} `);
    const b = document.createElement('button');
    b.type = 'button';
    b.id = idFor('rm', e.id);
    b.textContent = `Remove ${e.item}`;
    b.addEventListener('click', () => {
      const next = st.extras[n + 1] || st.extras[n - 1];
      focusFallback = next ? idFor('rm', next.id) : 'sh-item';
      change({ type: 'removeExtra', id: e.id }, `Removed ${e.item}.`);
    });
    li.append(b);
    ex.append(li);
  });

  // Plan.
  const mb = $('sh-meals');
  mb.querySelectorAll('.field').forEach((e) => e.remove());
  v.meals.forEach((m) => checkbox(mb, idFor('ml', m.name), m.name, m.on, (on) => change({ type: 'meal', name: m.name, on })));
  $('sh-common').replaceChildren();
  v.common.forEach((c) => checkbox($('sh-common'), idFor('cm', c.key), c.label, !c.out, (have) => change({ type: 'common', item: c.key, out: !have })));
  const nOut = v.common.filter((c) => c.out).length;
  $('sh-common-sum').textContent = `Common items (${nOut ? `${nOut} need buying` : 'all in stock'})`;
  $('sh-house').replaceChildren();
  v.house.forEach((c) => checkbox($('sh-house'), idFor('hs', c.key), c.label, c.on, (on) => change({ type: 'house', item: c.key, on })));
  const nHouse = v.house.filter((c) => c.on).length;
  $('sh-house-sum').textContent = `Household and extras (${nHouse ? `${nHouse} selected` : 'none selected'})`;

  // Lists editor: never overwrite what someone is typing.
  if (!textDirty) $('sh-text').value = st.text;

  syncLine();

  // Put focus back where it was, or on the next item if that one is gone.
  if (active && !document.getElementById(active) && focusFallback) document.getElementById(focusFallback)?.focus();
  else if (active && document.activeElement?.id !== active) document.getElementById(active)?.focus();
  focusFallback = null;
}

function syncLine() {
  const time = lastSync ? lastSync.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : null;
  let t;
  if (!server) t = online ? 'Loading the list.' : 'Offline, and this phone has no copy of the list yet.';
  else if (!online) t = `Offline.${pending.length ? ` ${pending.length} change${pending.length === 1 ? '' : 's'} waiting to send.` : ''}${time ? ` Last updated ${time}.` : ''}`;
  else if (pending.length) t = 'Saving.';
  else t = `Up to date${time ? `, checked ${time}` : ''}.`;
  $('sh-sync').textContent = t.replace(/\.\.$/, '.'); // times like 3:33 a.m. already end in a full stop
}

// ---------------------------------------------------------------- talking to the server

async function sync() {
  if (busy) return;
  busy = true;
  let redraw = false;
  try {
    if (pending.length) {
      const sent = pending.slice(0, 500);
      const res = await fetch('/api/shopping/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: sent }),
      });
      if (!res.ok) throw new Error(`Server answered ${res.status}`);
      server = await res.json();
      const done = new Set(sent.map((o) => o.id));
      pending = pending.filter((o) => !done.has(o.id));
      write(LS_PENDING, pending);
      write(LS_SERVER, server);
      redraw = true;
    } else {
      const res = await fetch(`/api/shopping${server ? `?rev=${server.rev}` : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Server answered ${res.status}`);
      const got = await res.json();
      if (!got.same) { server = got; write(LS_SERVER, server); redraw = true; }
    }
    online = true;
    lastSync = new Date();
  } catch {
    online = false;
  } finally {
    busy = false;
  }
  // Only redraw when the list changed, so a screen reader is not moved around every 15 seconds.
  if (redraw) render(); else syncLine();
  if (online && pending.length) sync();
}

// ---------------------------------------------------------------- buttons

function copyText(text, what) {
  const done = () => say(`Copied the ${what}.`);
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('aria-hidden', 'true');
    ta.className = 'offscreen';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { say('Could not copy.'); }
    ta.remove();
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

$('sh-hide').addEventListener('change', () => { write(LS_HIDE, $('sh-hide').checked); render(); });
$('sh-refresh').addEventListener('click', async () => { await sync(); say(online ? 'List refreshed.' : 'Could not reach the server. Changes are kept on this phone.'); });

$('sh-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const item = $('sh-item').value.trim();
  if (!item) { say('Type an item first.'); $('sh-item').focus(); return; }
  const store = $('sh-store').value;
  change({ type: 'addExtra', id: newId(), item, store }, `Added ${item}.`);
  $('sh-item').value = '';
  $('sh-item').focus();
});

$('sh-done').addEventListener('click', () => {
  if (!confirm('Done shopping? Ticked items are cleared. Anything not ticked stays on the list.')) return;
  const before = compute(current());
  const kept = before.stores.flatMap((s) => s.items).filter((i) => !i.checked && i.source !== 'common').length;
  change({ type: 'done' }, `Done shopping.${kept ? ` ${kept} item${kept === 1 ? '' : 's'} kept for next time.` : ''}`);
  $('sh-list-h').tabIndex = -1;
  $('sh-list-h').focus();
});

$('sh-stockall').addEventListener('click', () => change({ type: 'stockAll' }, 'All common items marked as in stock.'));
$('sh-clear').addEventListener('click', () => {
  if (!confirm('Clear all meals, household picks, one-off items and ticks? Common items are left as they are.')) return;
  change({ type: 'clearSel' }, 'List cleared.');
});

$('sh-text').addEventListener('input', () => { textDirty = true; });
$('sh-default').addEventListener('click', () => {
  $('sh-text').value = DEFAULT_TEXT;
  textDirty = true;
  say('Built-in lists loaded into the editor. Press Save lists to use them.');
});
$('sh-save').addEventListener('click', () => {
  const text = $('sh-text').value;
  const { d, warn } = parseDoc(text);
  if (!d.stores.some((g) => g.items.length)) { say('Not saved. Add a section called # Stores with at least one ## store and some - items.'); return; }
  textDirty = false;
  const { missing, dup } = checkDoc(d);
  let msg = 'Lists saved.';
  if (missing.length) msg += ` Not in any store list, so they go under ${UNASSIGNED}: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? `, and ${missing.length - 10} more` : ''}.`;
  if (dup.length) msg += ` In more than one store, first one used: ${dup.slice(0, 10).join(', ')}.`;
  if (warn.length) msg += ` ${warn.slice(0, 3).join(' ')}`;
  change({ type: 'setText', text }, msg);
});

// ---------------------------------------------------------------- start

render();
sync();
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
window.addEventListener('online', () => sync());
window.addEventListener('offline', () => { online = false; syncLine(); });

// Lets the page open with no connection. Browsers only allow this on https (or localhost).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/shopping/sw.js', { scope: '/shopping' }).catch(() => {});
}
