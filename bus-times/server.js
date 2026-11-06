// Bus times: scheduled and estimated ETS bus times for saved stops. Start with: node server.js
import http from 'node:http';
import { readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGtfs, stopInfo, searchStops, nearStops, routeDetail } from './lib/gtfs.js';
import { getRealtime } from './lib/rt.js';
import { arrivals } from './lib/arrivals.js';
import { localToUtc } from './lib/time.js';
import { addressAllowed } from './lib/access.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3220;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || path.join(HERE, 'data');
const GTFS_URL = process.env.GTFS_URL || 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip';
const RT_URL = process.env.TRIP_UPDATES_URL || 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/TripUpdate/TripUpdates.pb';
const ZIP = path.join(DATA, 'gtfs.zip');
const SAVED = path.join(DATA, 'saved.json');
// Identifies this app to the schedule and address search services, as OpenStreetMap's Nominatim policy asks.
const UA = process.env.USER_AGENT || 'QuickToolBox-BusTimes/1.13 (+https://github.com/jonathan-s01/quick-tool-box)';
// Address search. Can be pointed at another Nominatim server without changing the code.
const GEOCODE_URL = process.env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search';

await mkdir(DATA, { recursive: true });

// ---------------------------------------------------------------- schedule
let gtfs = null;
let scheduleError = null;
let updating = false;

async function useZip(buf, from) {
  const t = Date.now();
  const g = await loadGtfs(buf);
  if (!g.rows) throw new Error('The schedule file had no bus times');
  gtfs = g;
  scheduleError = null;
  console.log(`Schedule loaded from ${from}: ${g.stops.length} stops, ${g.tripId.length} trips, ${g.rows} stop times, ${Date.now() - t} ms`);
}

async function updateSchedule() {
  if (updating) return;
  updating = true;
  try {
    const res = await fetch(GTFS_URL, { signal: AbortSignal.timeout(120000), headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Schedule download answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await useZip(buf, 'download');
    await writeFile(ZIP + '.tmp', buf);
    await rename(ZIP + '.tmp', ZIP);
  } catch (err) {
    scheduleError = err.message || String(err);
    console.error('Schedule update failed:', scheduleError);
  } finally {
    updating = false;
  }
}

async function zipAgeHours() {
  try { return (Date.now() - (await stat(ZIP)).mtimeMs) / 3600e3; } catch { return Infinity; }
}

try { await useZip(await readFile(ZIP), 'saved copy'); } catch { /* no saved copy yet */ }
if ((await zipAgeHours()) > 20) updateSchedule();
setInterval(async () => { if ((await zipAgeHours()) > 20) updateSchedule(); }, 3600e3).unref();

// ---------------------------------------------------------------- saved stops
async function readSaved() {
  try { return JSON.parse(await readFile(SAVED, 'utf8')); } catch { return []; }
}
async function writeSaved(list) {
  await writeFile(SAVED + '.tmp', JSON.stringify(list, null, 2));
  await rename(SAVED + '.tmp', SAVED);
}
const withInfo = (s) => {
  const i = gtfs?.codeIndex.get(s.code);
  return i === undefined ? { code: s.code, nick: s.nick, label: `Stop ${s.code}`, routes: [] } : { ...stopInfo(gtfs, i), nick: s.nick };
};

// ---------------------------------------------------------------- geocoding (OpenStreetMap)
// OpenStreetMap's server allows at most one request a second, so searches wait their turn,
// and recent answers are reused.
let lastGeocode = 0;
const geocodeCache = new Map();
async function geocode(q) {
  const key = q.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const wait = lastGeocode + 1100 - Date.now();
  lastGeocode = Math.max(Date.now(), lastGeocode + 1100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const u = new URL(GEOCODE_URL);
  u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '8', countrycodes: 'ca', viewbox: '-113.80,53.75,-113.20,53.35', bounded: '1' });
  const res = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`Address search answered ${res.status}`);
  const places = (await res.json()).map((r) => ({ name: r.display_name.split(', ').slice(0, 3).join(', '), lat: +r.lat, lon: +r.lon }));
  if (geocodeCache.size > 200) geocodeCache.delete(geocodeCache.keys().next().value);
  geocodeCache.set(key, places);
  return places;
}

// ---------------------------------------------------------------- http
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 10000) throw new Error('Too much data'); }
  return JSON.parse(s || '{}');
}

function needSchedule(res) {
  if (gtfs) return false;
  send(res, 503, { error: scheduleError ? `The schedule could not be downloaded: ${scheduleError}` : 'The schedule is still loading. Try again in a minute.' });
  return true;
}

// "2026-10-23T18:30" in Edmonton time, or nothing for now.
function parseAt(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s || '');
  return m ? localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}

async function handle(req, res) {
  if (!addressAllowed(req.socket.remoteAddress)) return send(res, 403, 'Forbidden', 'text/plain');
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === 'GET' && FILES[p]) {
    const [file, type] = FILES[p];
    return send(res, 200, await readFile(path.join(HERE, 'public', file)), type);
  }
  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');

  if (p.startsWith('/api/stop/')) {
    if (needSchedule(res)) return;
    const code = decodeURIComponent(p.slice(10));
    const i = gtfs.codeIndex.get(code);
    if (i === undefined) return send(res, 404, { error: `There is no stop number ${code}.` });
    const now = Date.now();
    const chosen = parseAt(q.get('at'));
    const at = chosen ?? now;
    const live = at < now + 3 * 3600e3; // the live feed only covers the next few hours
    const rt = live ? await getRealtime(RT_URL) : null;
    const saved = (await readSaved()).find((s) => s.code === code);
    return send(res, 200, {
      stop: { ...stopInfo(gtfs, i), saved: !!saved, nick: saved?.nick || '' },
      at, now, lookAhead: chosen !== null,
      arrivals: arrivals(gtfs, rt, i, at, chosen === null || Math.abs(at - now) < 15 * 60e3),
      liveError: rt?.error || null,
    });
  }
  if (p === '/api/search') { if (needSchedule(res)) return; return send(res, 200, searchStops(gtfs, q.get('q') || '')); }
  if (p === '/api/near') {
    if (needSchedule(res)) return;
    const lat = +q.get('lat'), lon = +q.get('lon');
    if (!isFinite(lat) || !isFinite(lon)) return send(res, 400, { error: 'Missing location' });
    return send(res, 200, nearStops(gtfs, lat, lon));
  }
  if (p === '/api/route') { if (needSchedule(res)) return; return send(res, 200, routeDetail(gtfs, q.get('q') || '')); }
  if (p === '/api/geocode') return send(res, 200, await geocode(q.get('q') || ''));

  if (p === '/api/saved' && req.method === 'GET') return send(res, 200, (await readSaved()).map(withInfo));
  if (p === '/api/saved' && req.method === 'POST') {
    const b = await readBody(req);
    const list = await readSaved();
    const code = String(b.code || '');
    const at = list.findIndex((s) => s.code === code);
    const nick = String(b.nick || '').trim().slice(0, 60);
    if (b.action === 'add' && at < 0) list.push({ code, nick });
    if ((b.action === 'add' || b.action === 'rename') && at >= 0) list[at].nick = nick;
    if (b.action === 'remove' && at >= 0) list.splice(at, 1);
    if (b.action === 'move' && at >= 0) {
      const to = at + (b.by < 0 ? -1 : 1);
      if (to >= 0 && to < list.length) [list[at], list[to]] = [list[to], list[at]];
    }
    await writeSaved(list);
    return send(res, 200, list.map(withInfo));
  }
  send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message || 'Something went wrong' });
  });
}).listen(PORT, HOST, () => console.log(`Bus times on http://${HOST}:${PORT}`));
