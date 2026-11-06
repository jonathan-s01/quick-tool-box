// Renders PDF pages to PNG once, and cuts out parts of them for the AI clean-up.
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';

/**
 * Returns crop(chunk) for chunks with a page number and a box in PDF points ({ l, t, r, b, coord_origin }).
 * pageHeight(page) gives the page height in points.
 */
export function pdfCropper(ctx, pdfPath, pageHeight, dpi = 150) {
  const pages = new Map();
  const scale = dpi / 72;
  let n = 0;
  const render = (page) => {
    if (!pages.has(page)) {
      const base = path.join(ctx.workDir, `crop-page-${page}`);
      pages.set(page, ctx.run('pdftoppm', ['-r', String(dpi), '-f', String(page), '-l', String(page), '-png', '-singlefile', pdfPath, base]).then(() => `${base}.png`));
    }
    return pages.get(page);
  };
  return async (chunk) => {
    const h = pageHeight(chunk.page);
    const bb = chunk.bbox;
    if (!h || !bb) return null;
    const top = bb.coord_origin === 'TOPLEFT' ? bb.t : h - bb.t;
    const bottom = bb.coord_origin === 'TOPLEFT' ? bb.b : h - bb.b;
    const box = {
      left: Math.min(bb.l, bb.r) * scale,
      top: Math.min(top, bottom) * scale,
      width: Math.abs(bb.r - bb.l) * scale,
      height: Math.abs(bottom - top) * scale,
    };
    let image;
    try {
      image = await render(chunk.page);
    } catch (err) {
      if (err.cancelled) throw err;
      return null; // the chunk is reported as "could not check"
    }
    return cropToBase64(ctx, image, box, `crop-${n++}.png`);
  };
}

/** Cuts a box (in pixels) out of an image, with a little margin, and returns it as base64 PNG. */
export async function cropToBase64(ctx, image, box, name) {
  const pad = 10;
  const x = Math.max(0, Math.floor(box.left - pad));
  const y = Math.max(0, Math.floor(box.top - pad));
  const w = Math.ceil(box.width + pad * 2);
  const hgt = Math.ceil(box.height + pad * 2);
  if (w < 4 || hgt < 4) return null;
  const out = path.join(ctx.workDir, name);
  try {
    await ctx.run('magick', [image, '-crop', `${w}x${hgt}+${x}+${y}`, '+repage', out]);
    return (await readFile(out)).toString('base64');
  } catch (err) {
    if (err.cancelled) throw err;
    return null;
  } finally {
    rm(out, { force: true }).catch(() => {});
  }
}
