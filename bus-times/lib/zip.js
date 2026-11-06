// Reads text files line by line out of a zip file held in memory. No extra packages needed.
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';

export function openZip(buf) {
  let i = buf.length - 22;
  const stop = Math.max(0, buf.length - 65557);
  while (i >= stop && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < stop) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Damaged zip file');
    const method = buf.readUInt16LE(off + 10);
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen).split('/').pop();
    entries.set(name, { method, size, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => entries.has(name),
    lines(name) {
      const e = entries.get(name);
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const src = Readable.from([buf.subarray(start, start + e.size)]);
      const input = e.method === 8 ? src.pipe(zlib.createInflateRaw()) : src;
      return readline.createInterface({ input, crlfDelay: Infinity });
    },
  };
}

export function parseCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
