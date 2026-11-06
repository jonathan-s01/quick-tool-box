// Cleans up a photo or scan of a signature: keeps only the ink, removes the paper,
// makes the background see-through, and crops to the signature.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { run, which, userError } from './system.js';

/**
 * Returns { png, description }. png is a Buffer of a transparent PNG with dark ink.
 * Works for black on white images, phone photos and scans: lighting is evened out first.
 */
export async function cleanSignature(inputPath, workDir) {
  if (!(await which('magick'))) throw userError('Cleaning signatures needs ImageMagick.');
  const out = path.join(workDir, 'signature.png');
  // 1. Turn upright, greyscale, shrink very large photos.
  // 2. Even out shadows: divide by a heavily blurred copy (the paper), so the paper becomes white.
  // 3. Stretch contrast so ink is dark and paper is white.
  // 4. Use the darkness as see-through-ness: white paper disappears, ink stays, edges stay smooth.
  // 5. Crop to the ink, with a small margin.
  await run('magick', [
    `${inputPath}[0]`, '-auto-orient', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-colorspace', 'Gray', '-resize', '2400x2400>',
    '(', '+clone', '-blur', '0x25', ')', '-compose', 'Divide_Src', '-composite',
    '-level', '45%,92%',
    '(', '+clone', '-negate', ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
    '-fill', '#101010', '-colorize', '100',
    '-channel', 'A', '-level', '22%,100%', '+channel',
    '-fuzz', '3%', '-trim', '+repage', '-bordercolor', 'none', '-border', '12', '-resize', '1600x600>',
    out,
  ]);
  const { stdout } = await run('magick', [out, '-format', '%w %h %[fx:mean.a]', 'info:']);
  const [w, h, ink] = stdout.trim().split(/\s+/).map(Number);
  const notes = [];
  if (!w || !h || w < 40 || h < 15) throw userError('No signature could be found in that picture. Try a photo closer to the signature, on plain paper.');
  const ratio = w / h;
  notes.push(`Signature saved. It is about ${ratio.toFixed(1)} times as wide as it is tall.`);
  if (ink > 0.35) notes.push('Warning: a lot of the picture is still dark, so some of the background may not have been removed. A brighter photo of the signature on plain white paper works best.');
  else if (ink < 0.01) notes.push('Warning: the ink looks very faint. Try a darker pen or a closer photo.');
  else notes.push('The background was removed cleanly.');
  if (ratio > 12) notes.push('Warning: it is very long and thin. Check that only the signature was in the photo.');
  if (ratio < 1.2) notes.push('Warning: it is almost square. Signatures are usually wider. Check that only the signature was in the photo.');
  return { png: await readFile(out), description: notes.join(' ') };
}
