// The saved menu library: a list of menus you kept, to read again or download.
// Menus are kept in DATA_DIR/menus as HTML files, with a small index.json.
import path from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dataPath } from './data.js';
import { esc, layout } from './html.js';

async function dir() {
  return dataPath('menus');
}

async function readIndex() {
  try {
    return JSON.parse(await readFile(path.join(await dir(), 'index.json'), 'utf8'));
  } catch {
    return [];
  }
}

async function writeIndex(list) {
  await writeFile(path.join(await dir(), 'index.json'), JSON.stringify(list, null, 2));
}

export function slug(s) {
  return String(s || 'menu').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'menu';
}

/** Saves a menu and returns its library entry. */
export async function saveMenu({ name, source, html, dishes }) {
  const id = randomUUID().slice(0, 8);
  const file = `${slug(name)}-${id}.html`;
  await writeFile(path.join(await dir(), file), html);
  const list = await readIndex();
  const entry = { id, name, source, file, dishes, savedAt: new Date().toISOString() };
  list.unshift(entry);
  await writeIndex(list);
  return entry;
}

const VIEW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/** Handles /menus pages. Returns false if the address is not one of ours. */
export async function menuLibrary(req, res, p, { send, messagePage }) {
  let m;
  if (req.method === 'GET' && p === '/menus') {
    const list = await readIndex();
    const items = list.map((e) => {
      const when = new Date(e.savedAt).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
      return `<li><h2><a href="/menus/${esc(e.id)}">${esc(e.name)}</a></h2>
<p>${esc(e.dishes)} dishes. Saved ${esc(when)}.${e.source ? ` From ${esc(e.source)}.` : ''}</p>
<p><a href="/menus/${esc(e.id)}/download">Download ${esc(e.name)}</a></p>
<form class="inline-form" method="post" action="/menus/${esc(e.id)}/delete"><button type="submit">Delete ${esc(e.name)}</button></form></li>`;
    }).join('\n');
    return send(res, 200, layout({
      title: 'Saved menus',
      body: `<h1>Saved menus</h1>
${list.length ? `<p>${list.length} saved, newest first. Each menu has its name as a heading.</p><ul class="menu-list">${items}</ul>` : '<p>No saved menus yet. Use the <a href="/tools/menu">Menu reader</a> and leave "Save to my menu library" ticked.</p>'}`,
    }));
  }
  if ((m = p.match(/^\/menus\/([\w-]+)(\/download|\/delete)?$/))) {
    const list = await readIndex();
    const entry = list.find((e) => e.id === m[1]);
    if (!entry) return send(res, 404, messagePage('Not found', 'This saved menu does not exist any more.'));
    const file = path.join(await dir(), entry.file);
    if (req.method === 'POST' && m[2] === '/delete') {
      await rm(file, { force: true });
      await writeIndex(list.filter((e) => e.id !== entry.id));
      res.writeHead(303, { Location: '/menus' });
      return res.end();
    }
    if (req.method === 'GET') {
      const html = await readFile(file);
      if (m[2] === '/download') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${entry.file.replace(/-[\w]{8}\.html$/, '-menu.html')}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(html);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': VIEW_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(html);
    }
  }
  return false;
}
