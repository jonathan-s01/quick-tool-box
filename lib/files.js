// File helpers shared by tools.
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { run, userError } from './system.js';

/** Turns an uploaded file name into a safe base name (no folder, no extension). */
export function safeBaseName(name) {
  const base = path.basename(name || 'file').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^\p{L}\p{N} ._-]+/gu, '_').replace(/^[ .]+|[ .]+$/g, '');
  return (cleaned || 'file').slice(0, 100);
}

/** Looks at the first bytes of a file to tell what it really is. */
export async function sniff(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    await fh.read(buf, 0, 16, 0);
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    return 'other';
  } finally {
    await fh.close();
  }
}

/** Number of pages in a PDF, using pdfinfo from poppler. */
export async function pdfPageCount(file, signal) {
  let out;
  try {
    out = await run('pdfinfo', [file], { signal });
  } catch (err) {
    if (/password|encrypt/i.test(err.details || '')) {
      throw userError('This PDF is password protected. Remove the password and try again.', err.details);
    }
    throw err;
  }
  const m = out.stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) throw userError('Could not read the number of pages in this PDF.', out.stdout);
  return Number(m[1]);
}

/** Lists files in a folder, sorted by name, as full paths. */
export async function listFiles(dir) {
  const names = (await readdir(dir)).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.map((n) => path.join(dir, n));
}

/** Zips files into zipPath (flat, no folders) using the zip command built into macOS. */
export async function zipFiles(files, zipPath, signal) {
  await run('zip', ['-j', '-q', zipPath, ...files], { signal });
  return zipPath;
}

/**
 * Finds how far a scanned page is tilted, in degrees, using ImageMagick.
 * Works on a small copy so it is fast; rotate the full image by the returned angle to straighten it.
 * Returns 0 if the tilt is too small to bother with.
 */
export async function skewAngle(runFn, file) {
  const { stdout } = await runFn('magick', [`${file}[0]`, '-resize', '1200x1200>', '-deskew', '40%', '-format', '%[deskew:angle]', 'info:']);
  const angle = Number.parseFloat(stdout.trim());
  return Number.isFinite(angle) && Math.abs(angle) >= 0.1 ? Number(angle.toFixed(2)) : 0;
}

export function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}
