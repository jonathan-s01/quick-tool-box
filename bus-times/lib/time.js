// Time helpers fixed to Edmonton time, whatever the computer's own time zone is.
export const TZ = 'America/Edmonton';
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function parts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

function offset(ms) {
  const p = parts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// Edmonton wall-clock time to a real moment (milliseconds).
export function localToUtc(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}

// GTFS times count from "noon minus 12 hours" of the service day, which keeps DST days right.
export const serviceBase = (day) => localToUtc(day.y, day.m, day.d, 12) - 12 * 3600e3;

export function addDays(day, n) {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export const dayKey = (day) => day.y * 10000 + day.m * 100 + day.d;
export const weekday = (day) => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay(); // 0 = Sunday
