// Runs a Python helper that needs PyMuPDF, outside of a tool job.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, userError } from './system.js';
import { pymupdfCommand } from './pymupdf.js';

const HELPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers');

/** Runs helpers/<script> with args. Returns the RESULT line as an object, if there is one. */
export async function runHelper(script, args, { signal } = {}) {
  const py = await pymupdfCommand();
  if (!py) throw userError('PyMuPDF is not installed. See the Setup part of the README.');
  try {
    const { stdout } = await run(py.cmd, [...py.pre, path.join(HELPERS, script), ...args], { signal });
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    return line ? JSON.parse(line.slice(7)) : null;
  } catch (err) {
    const m = /WRAPPER_ERROR: (.*)/.exec(`${err.details || ''}${err.stderr || ''}`);
    if (m) throw userError(m[1], err.details);
    throw err;
  }
}
