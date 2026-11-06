// Loads the ETS schedule (GTFS zip) into compact memory indexes.
import { openZip, parseCsv } from './zip.js';
import { weekday, dayKey } from './time.js';

class Grow {
  constructor(T, size = 1 << 16) { this.T = T; this.a = new T(size); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

function parseTime(s) {
  s = (s || '').trim();
  if (!s) return -1;
  const [h, m, sec] = s.split(':');
  return (+h) * 3600 + (+m) * 60 + (+sec || 0);
}

async function table(zip, name, setup) {
  if (!zip.has(name)) return false;
  let onRow = null;
  for await (const raw of zip.lines(name)) {
    if (!onRow) {
      const head = parseCsv(raw.replace(/^\uFEFF/, '')).map((s) => s.trim());
      const col = Object.fromEntries(head.map((h, i) => [h, i]));
      onRow = setup(col);
      continue;
    }
    if (raw) onRow(parseCsv(raw));
  }
  return true;
}

const v = (row, i) => (i === undefined ? '' : (row[i] || '').trim());

export async function loadGtfs(buf) {
  const zip = openZip(buf);

  // Routes: buses only (no LRT).
  const routes = new Map();
  await table(zip, 'routes.txt', (c) => (r) => {
    const type = +v(r, c.route_type);
    if (type !== 3 && !(type >= 700 && type < 800)) return;
    routes.set(v(r, c.route_id), { id: v(r, c.route_id), short: v(r, c.route_short_name) || v(r, c.route_long_name), long: v(r, c.route_long_name) });
  });

  // Services (which days each trip runs).
  const serviceIndex = new Map();
  const services = [];
  const svc = (id) => {
    if (!serviceIndex.has(id)) { serviceIndex.set(id, services.length); services.push({ days: null, start: 0, end: 0, ex: new Map() }); }
    return serviceIndex.get(id);
  };
  await table(zip, 'calendar.txt', (c) => (r) => {
    const s = services[svc(v(r, c.service_id))];
    s.days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => v(r, c[d]) === '1');
    s.start = +v(r, c.start_date); s.end = +v(r, c.end_date);
  });
  await table(zip, 'calendar_dates.txt', (c) => (r) => {
    services[svc(v(r, c.service_id))].ex.set(+v(r, c.date), +v(r, c.exception_type));
  });

  // Trips.
  const tripIndex = new Map();
  const tripId = [], tripRoute = [], tripService = [], tripHeadsign = [], tripDir = [];
  await table(zip, 'trips.txt', (c) => (r) => {
    const route = v(r, c.route_id);
    if (!routes.has(route)) return;
    tripIndex.set(v(r, c.trip_id), tripId.length);
    tripId.push(v(r, c.trip_id)); tripRoute.push(route); tripService.push(svc(v(r, c.service_id)));
    tripHeadsign.push(v(r, c.trip_headsign)); tripDir.push(v(r, c.direction_id) || '0');
  });

  // Stops.
  const stopIndex = new Map(), codeIndex = new Map();
  const stops = [];
  await table(zip, 'stops.txt', (c) => (r) => {
    const type = v(r, c.location_type);
    if (type && type !== '0') return;
    const i = stops.length;
    const s = { id: v(r, c.stop_id), code: v(r, c.stop_code) || v(r, c.stop_id), name: v(r, c.stop_name), lat: +v(r, c.stop_lat), lon: +v(r, c.stop_lon), bay: v(r, c.platform_code) };
    stops.push(s);
    stopIndex.set(s.id, i);
    codeIndex.set(s.code, i);
  });

  // Stop times: one row per bus per stop.
  const gTrip = new Grow(Int32Array, 1 << 20), gStop = new Grow(Int32Array, 1 << 20), gSeq = new Grow(Int32Array, 1 << 20), gDep = new Grow(Int32Array, 1 << 20);
  await table(zip, 'stop_times.txt', (c) => (r) => {
    const t = tripIndex.get(v(r, c.trip_id));
    if (t === undefined) return;
    const s = stopIndex.get(v(r, c.stop_id));
    if (s === undefined) return;
    gTrip.push(t); gStop.push(s); gSeq.push(+v(r, c.stop_sequence));
    gDep.push(parseTime(v(r, c.departure_time) || v(r, c.arrival_time)));
  });
  const n = gTrip.n;
  const T0 = gTrip.done(), S0 = gStop.done(), Q0 = gSeq.done(), D0 = gDep.done();
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => (T0[a] - T0[b]) || (Q0[a] - Q0[b]));
  const rTrip = new Int32Array(n), rStop = new Int32Array(n), rSeq = new Int32Array(n), rDep = new Int32Array(n);
  for (let i = 0; i < n; i++) { const o = order[i]; rTrip[i] = T0[o]; rStop[i] = S0[o]; rSeq[i] = Q0[o]; rDep[i] = D0[o]; }

  const nTrips = tripId.length;
  const tripStart = new Int32Array(nTrips + 1);
  for (let i = 0; i < n; i++) tripStart[rTrip[i] + 1]++;
  for (let t = 0; t < nTrips; t++) tripStart[t + 1] += tripStart[t];

  // Fill in any missing times inside a trip.
  for (let t = 0; t < nTrips; t++) {
    const a = tripStart[t], b = tripStart[t + 1];
    let last = -1;
    for (let i = a; i < b; i++) {
      if (rDep[i] < 0) continue;
      if (last >= 0 && i - last > 1) for (let k = last + 1; k < i; k++) rDep[k] = Math.round(rDep[last] + (rDep[i] - rDep[last]) * (k - last) / (i - last));
      last = i;
    }
    for (let i = a; i < b; i++) if (rDep[i] < 0) rDep[i] = last >= 0 ? rDep[last] : 0;
  }

  // Index of rows for each stop, sorted by time.
  const nStops = stops.length;
  const stopStart = new Int32Array(nStops + 1);
  for (let i = 0; i < n; i++) stopStart[rStop[i] + 1]++;
  for (let s = 0; s < nStops; s++) stopStart[s + 1] += stopStart[s];
  const fill = stopStart.slice(0, nStops);
  const stopRows = new Int32Array(n);
  for (let i = 0; i < n; i++) stopRows[fill[rStop[i]]++] = i;
  for (let s = 0; s < nStops; s++) {
    const a = stopStart[s], b = stopStart[s + 1];
    if (b - a > 1) stopRows.subarray(a, b).sort((x, y) => rDep[x] - rDep[y]);
  }

  // Stop patterns: the most common stop list for each route, direction and destination.
  const groups = new Map();
  for (let t = 0; t < nTrips; t++) {
    const key = `${tripRoute[t]}|${tripDir[t]}|${tripHeadsign[t]}`;
    const pat = Array.from(rStop.subarray(tripStart[t], tripStart[t + 1])).join(',');
    if (!groups.has(key)) groups.set(key, new Map());
    const g = groups.get(key);
    g.set(pat, (g.get(pat) || 0) + 1);
  }
  const allPatterns = new Set();
  const routePatterns = new Map(); // route id -> [{dir, headsign, trips, stops}]
  for (const [key, pats] of groups) {
    const [route, dir, headsign] = key.split('|');
    let best = null, bestN = 0, total = 0;
    for (const [p, cnt] of pats) { allPatterns.add(p); total += cnt; if (cnt > bestN) { best = p; bestN = cnt; } }
    if (!routePatterns.has(route)) routePatterns.set(route, []);
    routePatterns.get(route).push({ dir, headsign, trips: total, stops: best.split(',').map(Number) });
  }

  // Routes at each stop, and the way buses travel through it.
  const stopRoutes = Array.from({ length: nStops }, () => new Set());
  const inX = new Float64Array(nStops), inY = new Float64Array(nStops), inN = new Int32Array(nStops);
  const outX = new Float64Array(nStops), outY = new Float64Array(nStops), outN = new Int32Array(nStops);
  const unit = (a, b) => {
    const dx = (stops[b].lon - stops[a].lon) * Math.cos(stops[a].lat * Math.PI / 180), dy = stops[b].lat - stops[a].lat;
    const L = Math.hypot(dx, dy);
    return L < 1e-7 ? null : [dx / L, dy / L];
  };
  for (const [route, list] of routePatterns) {
    const short = routes.get(route).short;
    for (const p of list) for (const s of p.stops) stopRoutes[s].add(short);
  }
  for (const p of allPatterns) {
    const st = p.split(',').map(Number);
    for (let k = 0; k < st.length; k++) {
      if (k > 0) { const u = unit(st[k - 1], st[k]); if (u) { inX[st[k]] += u[0]; inY[st[k]] += u[1]; inN[st[k]]++; } }
      if (k < st.length - 1) { const u = unit(st[k], st[k + 1]); if (u) { outX[st[k]] += u[0]; outY[st[k]] += u[1]; outN[st[k]]++; } }
    }
  }
  for (let s = 0; s < nStops; s++) {
    stops[s].dir = direction(stops[s].name, avg(inX[s], inY[s], inN[s]), avg(outX[s], outY[s], outN[s]));
    stops[s].routes = [...stopRoutes[s]].sort(routeSort);
    stops[s].served = stopRoutes[s].size > 0;
    stops[s].search = normalize(`${stops[s].name} ${stops[s].bay ? 'bay ' + stops[s].bay : ''}`).split(' ').filter(Boolean);
  }

  const routeByShort = new Map();
  for (const r of routes.values()) {
    const k = r.short.toLowerCase();
    if (!routeByShort.has(k)) routeByShort.set(k, []);
    routeByShort.get(k).push(r.id);
  }

  return {
    routes, services, tripId, tripIndex, tripRoute, tripService, tripHeadsign, stops, stopIndex, codeIndex,
    rTrip, rStop, rSeq, rDep, tripStart, stopStart, stopRows, routePatterns, routeByShort, rows: n,
  };
}

// Average travel direction, or null when buses go different ways (for example a loop).
function avg(x, y, n) {
  if (!n) return null;
  const L = Math.hypot(x, y);
  if (L / n < 0.7) return null;
  return [x / L, y / L];
}

const cardinal = (v) => (Math.abs(v[0]) > Math.abs(v[1]) ? (v[0] > 0 ? 'EB' : 'WB') : (v[1] > 0 ? 'NB' : 'SB'));

// Direction label such as "WB". A star means it is a best guess.
// ETS names stops "Street the stop is on & cross street", and in Edmonton Streets run north-south and
// Avenues run east-west. When that agrees with the way buses travel in and out of the stop, there is no star.
export function direction(name, vin, vout) {
  const vecs = [vin, vout].filter(Boolean);
  if (!vecs.length) return '';
  const comb = vecs.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  const L = Math.hypot(comb[0], comb[1]);
  if (L < 1e-6) return '';
  const first = name.split('&')[0];
  const axis = /\b(street|st)\b/i.test(first) ? 1 : /\b(avenue|ave)\b/i.test(first) ? 0 : -1;
  if (axis >= 0) {
    const sign = Math.sign(comb[axis]);
    const label = axis === 1 ? (sign > 0 ? 'NB' : 'SB') : (sign > 0 ? 'EB' : 'WB');
    const sure = vecs.length === 2 && vecs.every((x) => Math.abs(x[axis]) >= 0.5 && Math.sign(x[axis]) === sign);
    if (sure) return label;
    if (Math.abs(comb[axis]) / L > 0.35) return label + '*';
    return cardinal(comb) + '*';
  }
  const d = cardinal(comb);
  const strong = (x) => cardinal(x) === d && Math.max(Math.abs(x[0]), Math.abs(x[1])) >= 0.8;
  return vecs.length === 2 && vecs.every(strong) ? d : d + '*';
}

export function routeSort(a, b) {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

const WORDS = { st: 'street', str: 'street', ave: 'avenue', av: 'avenue', rd: 'road', dr: 'drive', blvd: 'boulevard', tc: 'transit centre', center: 'centre', ctr: 'centre', trl: 'trail', wy: 'way', cres: 'crescent' };
export function normalize(s) {
  return s.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).map((w) => WORDS[w] || w).join(' ').trim();
}

export function stopInfo(g, i) {
  const s = g.stops[i];
  const label = s.bay ? `${s.name}, bay ${s.bay}` : `${s.name}${s.dir ? ' ' + s.dir : ''}`;
  return { code: s.code, label, routes: s.routes, lat: s.lat, lon: s.lon };
}

export function searchStops(g, q) {
  q = q.trim();
  if (g.codeIndex.has(q)) return [stopInfo(g, g.codeIndex.get(q))];
  const words = normalize(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (let i = 0; i < g.stops.length && out.length < 40; i++) {
    const s = g.stops[i];
    if (!s.served) continue;
    if (words.every((w) => s.search.some((t) => t.startsWith(w)))) out.push(stopInfo(g, i));
  }
  return out;
}

export function nearStops(g, lat, lon, limit = 15) {
  const k = Math.cos(lat * Math.PI / 180);
  const list = [];
  for (let i = 0; i < g.stops.length; i++) {
    const s = g.stops[i];
    if (!s.served) continue;
    const d = Math.hypot((s.lon - lon) * k, s.lat - lat) * 111320;
    if (d <= 1500) list.push([d, i]);
  }
  list.sort((a, b) => a[0] - b[0]);
  return list.slice(0, limit).map(([d, i]) => ({ ...stopInfo(g, i), distance: Math.round(d) }));
}

export function routeDetail(g, q) {
  const ids = g.routeByShort.get(q.trim().toLowerCase()) || [];
  const out = [];
  for (const id of ids) for (const p of g.routePatterns.get(id) || []) {
    out.push({ route: g.routes.get(id).short, headsign: p.headsign, dir: p.dir, trips: p.trips, stops: p.stops.map((s) => stopInfo(g, s)) });
  }
  out.sort((a, b) => a.dir.localeCompare(b.dir) || b.trips - a.trips);
  return out;
}

export function serviceRuns(g, si, day) {
  const s = g.services[si];
  const k = dayKey(day);
  const ex = s.ex.get(k);
  if (ex === 1) return true;
  if (ex === 2) return false;
  return !!s.days && k >= s.start && k <= s.end && s.days[weekday(day)];
}
