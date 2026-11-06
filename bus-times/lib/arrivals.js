// Next buses at a stop: scheduled time from the timetable, estimated time from the live feed.
import { parts, addDays, serviceBase, dayKey } from './time.js';
import { serviceRuns } from './gtfs.js';

const LATE_WINDOW = 2 * 3600; // look this far back in the timetable, for late buses

export function arrivals(g, rt, stopIdx, atMs, live, limit = 25) {
  const a = g.stopStart[stopIdx], b = g.stopStart[stopIdx + 1];
  const rows = g.stopRows;
  const today = parts(atMs);
  const runs = new Map();
  const cands = [];
  let after = 0;

  for (let off = -1; off <= 8; off++) {
    if (off >= 1 && after >= limit + 15) break;
    const day = addDays(today, off);
    const base = serviceBase(day);
    const minDep = Math.floor((atMs - base) / 1000) - (live ? LATE_WINDOW : 0);
    let lo = a, hi = b;
    while (lo < hi) { const m = (lo + hi) >> 1; if (g.rDep[rows[m]] < minDep) lo = m + 1; else hi = m; }
    for (let i = lo; i < b; i++) {
      const r = rows[i];
      const trip = g.rTrip[r];
      if (r === g.tripStart[trip + 1] - 1) continue; // bus ends here; nobody can board
      const si = g.tripService[trip];
      const rk = si * 100000000 + dayKey(day);
      if (!runs.has(rk)) runs.set(rk, serviceRuns(g, si, day));
      if (!runs.get(rk)) continue;
      const sched = base + g.rDep[r] * 1000;
      cands.push({ r, trip, sched, base, day });
      if (sched >= atMs && ++after >= limit + 15 && off >= 0) break;
    }
  }

  const out = [];
  for (const c of cands) {
    const est = estimate(g, rt, c, stopIdx);
    if (est === 'passed') continue;
    const item = {
      route: g.routes.get(g.tripRoute[c.trip]).short,
      headsign: g.tripHeadsign[c.trip],
      scheduled: c.sched,
      estimated: typeof est === 'number' ? est : null,
      status: est === 'cancelled' || est === 'skipped' ? est : null,
    };
    const when = item.estimated ?? item.scheduled;
    if (live ? when < atMs - 30000 : item.scheduled < atMs) continue;
    item.sortTime = when;
    out.push(item);
  }
  out.sort((x, y) => x.sortTime - y.sortTime || x.route.localeCompare(y.route));
  return out.slice(0, limit).map(({ sortTime, ...x }) => x);
}

function dateString(day) {
  return `${day.y}${String(day.m).padStart(2, '0')}${String(day.d).padStart(2, '0')}`;
}

// Returns a time (ms), 'cancelled', 'skipped', 'passed', or null when there is no live information.
function estimate(g, rt, c, stopIdx) {
  const tu = rt?.trips.get(g.tripId[c.trip]);
  if (!tu || (tu.date && tu.date !== dateString(c.day))) return null;
  if (tu.canceled) return 'cancelled';
  const ts = g.tripStart[c.trip], te = g.tripStart[c.trip + 1];
  const mySeq = g.rSeq[c.r];
  const stopId = g.stops[stopIdx].id;
  const seqOf = (u) => {
    if (u.seq !== null) return u.seq;
    const k = g.stopIndex.get(u.stopId);
    for (let i = ts; i < te; i++) if (g.rStop[i] === k) return g.rSeq[i];
    return null;
  };
  const schedOf = (seq) => {
    for (let i = ts; i < te; i++) if (g.rSeq[i] === seq) return c.base + g.rDep[i] * 1000;
    return null;
  };
  let before = null, beforeSeq = -1, anyAfter = false;
  for (const u of tu.stus) {
    const seq = seqOf(u);
    if (seq === null) continue;
    if (seq === mySeq || (u.seq === null && u.stopId === stopId)) {
      if (u.skipped) return 'skipped';
      if (u.noData) return null;
      const ev = u.dep || u.arr;
      if (ev?.time) return ev.time * 1000;
      if (ev?.delay !== null && ev?.delay !== undefined) return c.sched + ev.delay * 1000;
    } else if (seq < mySeq) {
      if (seq > beforeSeq && !u.skipped) { before = u; beforeSeq = seq; }
    } else anyAfter = true;
  }
  if (before) {
    if (before.noData) return null;
    const ev = before.dep || before.arr;
    if (ev?.delay !== null && ev?.delay !== undefined) return c.sched + ev.delay * 1000;
    if (ev?.time) { const s = schedOf(beforeSeq); if (s !== null) return c.sched + (ev.time * 1000 - s); }
    return null;
  }
  // Live updates only cover stops after this one: the bus has already gone by.
  if (anyAfter) return 'passed';
  return null;
}
