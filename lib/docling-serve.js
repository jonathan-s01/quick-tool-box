// Talks to a Docling Serve container (quay.io/docling-project/docling-serve-cpu), used when Docling
// is not installed on this computer, for example in the Docker image. Set DOCLING_URL, default http://localhost:5001.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { userError, cancelledError } from './system.js';

export const DOCLING_URL = (process.env.DOCLING_URL || 'http://localhost:5001').replace(/\/+$/, '');

let cache = { at: 0, value: null };

/** { reachable, version } of the Docling server. Cached for 20 seconds. */
export async function doclingServeStatus() {
  if (cache.value && Date.now() - cache.at < 20000) return cache.value;
  let value;
  try {
    const res = await fetch(`${DOCLING_URL}/health`, { signal: AbortSignal.timeout(2500) });
    value = { reachable: res.ok };
    try {
      const v = await fetch(`${DOCLING_URL}/version`, { signal: AbortSignal.timeout(2500) });
      if (v.ok) value.version = (await v.json())['docling-serve'] || null;
    } catch { /* older servers have no /version */ }
  } catch (err) {
    value = { reachable: false, error: String(err.cause?.code || err.message || err) };
  }
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Converts one PDF or image with the Docling server and returns the Docling document (the same JSON
 * that docling's export_to_dict() gives), so lib/docling-render.js can turn it into accessible HTML.
 */
export async function convertWithServe(ctx, file, { lang = 'en', forceOcr = false, tables = 'accurate' } = {}) {
  const buf = await readFile(file);
  const form = new FormData();
  form.append('files', new Blob([buf]), path.basename(file));
  form.append('to_formats', 'json');
  form.append('do_ocr', 'true');
  form.append('force_ocr', forceOcr ? 'true' : 'false');
  form.append('table_mode', tables === 'fast' ? 'fast' : 'accurate');
  form.append('image_export_mode', 'placeholder');
  for (const l of lang.split('+')) form.append('ocr_lang', l);
  const timeout = AbortSignal.timeout(20 * 60 * 1000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  let res;
  for (const p of ['/v1/convert/file', '/v1alpha/convert/file']) {
    try {
      res = await fetch(`${DOCLING_URL}${p}`, { method: 'POST', body: form, signal });
    } catch (err) {
      if (ctx.signal?.aborted) throw cancelledError();
      if (err.name === 'TimeoutError') throw userError('The Docling server took more than 20 minutes.');
      throw userError(`The Docling server at ${DOCLING_URL} could not be reached. Check that it is running.`, String(err.cause || err));
    }
    if (res.status !== 404) break;
  }
  const text = await res.text();
  if (!res.ok) throw userError(`The Docling server reported a problem (${res.status}).`, text.slice(0, 4000));
  let data;
  try { data = JSON.parse(text); } catch { throw userError('The Docling server sent an answer that could not be read.', text.slice(0, 2000)); }
  const doc = data.document?.json_content;
  if (data.status && !/success|partial/i.test(data.status)) throw userError('Docling could not read this document.', JSON.stringify(data.errors || data.status).slice(0, 4000));
  if (!doc) throw userError('The Docling server did not send back the document. It may be an old version; update the docling-serve container.', text.slice(0, 2000));
  return doc;
}
