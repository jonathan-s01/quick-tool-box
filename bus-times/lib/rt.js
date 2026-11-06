// Reads the ETS live "trip updates" feed (GTFS-realtime protocol buffers) without extra packages.

function varint(buf, pos) {
  let lo = 0, hi = 0, shift = 0, b;
  for (let i = 0; i < 10; i++) {
    b = buf[pos++];
    if (shift < 28) lo |= (b & 0x7f) << shift;
    else if (shift === 28) { lo |= (b & 0x0f) << 28; hi |= (b & 0x7f) >> 4; }
    else hi |= (b & 0x7f) << (shift - 32);
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [(hi >>> 0) * 4294967296 + (lo >>> 0), lo | 0, pos];
}

// Calls fn(field, wireType, a, b) for each field. Numbers: a = value, b = signed 32-bit value.
// Text and messages: a = start, b = end.
function each(buf, pos, end, fn) {
  while (pos < end) {
    let key; [key, , pos] = varint(buf, pos);
    const field = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { const [n, s, p] = varint(buf, pos); pos = p; fn(field, 0, n, s); }
    else if (wt === 2) { const [len, , p] = varint(buf, pos); fn(field, 2, p, p + len); pos = p + len; }
    else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else throw new Error('Unexpected data in live feed');
  }
}

const text = (buf, a, b) => buf.toString('utf8', a, b);

function event(buf, a, b) {
  const e = { delay: null, time: null };
  each(buf, a, b, (f, wt, x, s) => { if (wt !== 0) return; if (f === 1) e.delay = s; if (f === 2) e.time = x; });
  return e;
}

export function decodeTripUpdates(buf) {
  const trips = new Map();
  let feedTime = 0;
  each(buf, 0, buf.length, (f, wt, a, b) => {
    if (f === 1 && wt === 2) each(buf, a, b, (f2, w2, x) => { if (f2 === 3 && w2 === 0) feedTime = x; });
    if (f !== 2 || wt !== 2) return;
    each(buf, a, b, (fe, we, ea, eb) => {
      if (fe !== 3 || we !== 2) return;
      const tu = { id: '', date: '', canceled: false, stus: [] };
      each(buf, ea, eb, (ft, wtt, ta, tb) => {
        if (ft === 1 && wtt === 2) {
          each(buf, ta, tb, (fd, wd, da, db) => {
            if (fd === 1 && wd === 2) tu.id = text(buf, da, db);
            if (fd === 3 && wd === 2) tu.date = text(buf, da, db);
            if (fd === 4 && wd === 0 && da === 3) tu.canceled = true;
          });
        }
        if (ft === 2 && wtt === 2) {
          const u = { seq: null, stopId: '', arr: null, dep: null, skipped: false, noData: false };
          each(buf, ta, tb, (fs, ws, sa, sb) => {
            if (fs === 1 && ws === 0) u.seq = sa;
            if (fs === 2 && ws === 2) u.arr = event(buf, sa, sb);
            if (fs === 3 && ws === 2) u.dep = event(buf, sa, sb);
            if (fs === 4 && ws === 2) u.stopId = text(buf, sa, sb);
            if (fs === 5 && ws === 0) { u.skipped = sa === 1; u.noData = sa === 2; }
          });
          tu.stus.push(u);
        }
      });
      if (tu.id) trips.set(tu.id, tu);
    });
  });
  return { trips, feedTime };
}

const cache = { fetchedAt: 0, trips: new Map(), feedTime: 0, error: null };
let inflight = null;

export async function getRealtime(url) {
  if (Date.now() - cache.fetchedAt < 20000) return cache;
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'bus-times-home/1.0' } });
        if (!res.ok) throw new Error(`Live feed answered ${res.status}`);
        const { trips, feedTime } = decodeTripUpdates(Buffer.from(await res.arrayBuffer()));
        Object.assign(cache, { trips, feedTime, error: null, fetchedAt: Date.now() });
      } catch (err) {
        cache.error = err.message || String(err);
        cache.fetchedAt = Date.now() - 10000; // try again in about 10 seconds
      }
    })().finally(() => { inflight = null; });
  }
  await inflight;
  return cache;
}
