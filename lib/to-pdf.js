// Turns an uploaded document into a PDF, and adds a text layer to scanned pages.
// Shared by the redactor, and meant for the later document editor and form filler.
import path from 'node:path';
import { access, copyFile, readdir } from 'node:fs/promises';
import { which, userError } from './system.js';
import { sniff } from './files.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp', '.gif', '.heic', '.heif']);
const OFFICE_EXT = new Set(['.doc', '.docx', '.odt', '.rtf', '.txt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp', '.wpd', '.pages']);

export const DOC_ACCEPT = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.gif,.heic,.heif,.doc,.docx,.odt,.rtf,.txt,application/pdf,image/*';

/** Finds LibreOffice, which turns Word and similar files into PDFs. */
export async function sofficePath() {
  const found = (await which('soffice')) || (await which('libreoffice'));
  if (found) return found;
  const mac = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
  try { await access(mac); return mac; } catch { return null; }
}

/** Returns the path of a PDF version of the input. */
export async function toPdf(ctx) {
  const { input, workDir } = ctx;
  if ((await sniff(input.path)) === 'pdf') return input.path;
  const ext = input.ext.toLowerCase();
  const out = path.join(workDir, 'converted.pdf');
  if (IMAGE_EXT.has(ext)) {
    ctx.progress(null, null, 'Turning the picture into a PDF');
    if (!(await which('magick'))) throw userError('Pictures need ImageMagick to be turned into a PDF first.');
    await ctx.run('magick', [input.path, '-auto-orient', out]);
    return out;
  }
  if (OFFICE_EXT.has(ext)) {
    const soffice = await sofficePath();
    if (!soffice) throw userError('Word and other office files need LibreOffice to be turned into a PDF first. Save the file as a PDF and try again, or install LibreOffice.');
    ctx.progress(null, null, 'Turning the document into a PDF');
    const profile = `file://${path.join(workDir, 'lo-profile')}`;
    await ctx.run(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', workDir, input.path]);
    const made = (await readdir(workDir)).find((n) => n.toLowerCase().endsWith('.pdf') && n !== 'converted.pdf');
    if (!made) throw userError('LibreOffice could not turn this file into a PDF.');
    await copyFile(path.join(workDir, made), out);
    return out;
  }
  throw userError('This type of file is not supported. Use a PDF, a picture, or a Word, OpenDocument, RTF or text file.');
}

/**
 * Adds a hidden text layer to pages that have none (scans and photos), keeping how they look.
 * Pages that already have text are left alone. Returns the path of the PDF to use.
 */
// psm: Tesseract's page layout mode. 6 reads a page as one block of rows, which finds numbers in boxes on forms.
export async function ocrIfNeeded(ctx, pdf, { pagesWithoutText, lang = 'eng', psm = null }) {
  if (!pagesWithoutText) return pdf;
  if (!(await which('ocrmypdf'))) {
    throw userError(`${pagesWithoutText === 1 ? 'One page has' : `${pagesWithoutText} pages have`} no text, only a picture, so nothing on ${pagesWithoutText === 1 ? 'it' : 'them'} can be found. Install OCRmyPDF so scanned pages can be read.`);
  }
  ctx.progress(null, null, `Reading the text on ${pagesWithoutText === 1 ? '1 scanned page' : `${pagesWithoutText} scanned pages`}`);
  const out = path.join(ctx.workDir, 'with-text.pdf');
  const extra = psm ? ['--tesseract-pagesegmode', String(psm)] : [];
  try {
    await ctx.run('ocrmypdf', ['--skip-text', '--output-type', 'pdf', '--rotate-pages', ...extra, '-l', lang, pdf, out], { okCodes: [0, 6] });
    await access(out);
    return out;
  } catch (err) {
    if (err.cancelled) throw err;
    // --rotate-pages needs an extra Tesseract part on some systems; try once more without it.
    await ctx.run('ocrmypdf', ['--skip-text', '--output-type', 'pdf', ...extra, '-l', lang, pdf, out], { okCodes: [0, 6] });
    return out;
  }
}
