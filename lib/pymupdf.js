// Runs helpers/pdf_doc.py, which uses PyMuPDF to read PDFs and remove text for real.
// Uses PYMUPDF_PYTHON if set, then python3 if it has PyMuPDF, then "uv run --with pymupdf".
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which, run, userError } from './system.js';

export const PDF_DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'pdf_doc.py');

let cache = { at: 0, value: undefined };

/** Returns the command and first arguments to run Python with PyMuPDF, or null. */
export async function pymupdfCommand() {
  if (cache.value !== undefined && Date.now() - cache.at < 30000) return cache.value;
  let value = null;
  const candidates = [process.env.PYMUPDF_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const py of candidates) {
    try {
      await run(py, ['-c', 'import fitz']);
      value = { cmd: py, pre: [] };
      break;
    } catch { /* try the next one */ }
  }
  if (!value && (await which('uv'))) {
    try {
      await run('uv', ['run', '--quiet', '--no-project', '--with', 'pymupdf', 'python', '-c', 'import fitz']);
      value = { cmd: 'uv', pre: ['run', '--quiet', '--no-project', '--with', 'pymupdf', 'python'] };
    } catch { /* not available */ }
  }
  cache = { at: Date.now(), value };
  return value;
}

export function pymupdfMissing() {
  return process.platform === 'darwin'
    ? { what: 'PyMuPDF is needed to read PDFs and remove text for real. The easiest way is to install uv; PyMuPDF is then downloaded automatically the first time.', install: 'brew install uv' }
    : { what: 'PyMuPDF is needed to read PDFs and remove text for real.', install: 'pip install pymupdf' };
}

/**
 * Runs pdf_doc.py. onProgress(done, total) is called per page.
 * Returns the RESULT line as an object, if there is one.
 */
export async function pdfDoc(ctx, args, onProgress) {
  const py = await pymupdfCommand();
  if (!py) throw userError('PyMuPDF is not installed. Reload the page for setup details.');
  let result = null;
  let buffer = '';
  try {
    await ctx.run(py.cmd, [...py.pre, PDF_DOC, ...args], {
      onStdout(s) {
        buffer += s;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const m = /^PROGRESS (\d+) (\d+)/.exec(line);
          if (m) onProgress?.(Number(m[1]), Number(m[2]));
          if (line.startsWith('RESULT ')) result = JSON.parse(line.slice(7));
        }
      },
    });
  } catch (err) {
    const m = /WRAPPER_ERROR: (.*)/.exec(`${err.details || ''}`) || /WRAPPER_ERROR: (.*)/.exec(buffer);
    if (m) throw userError(m[1], err.details);
    throw err;
  }
  if (buffer.startsWith('RESULT ')) result = JSON.parse(buffer.slice(7));
  return result;
}
