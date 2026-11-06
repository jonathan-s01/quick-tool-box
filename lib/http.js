// Reading request bodies safely. Every upload goes through here, so there is one size limit
// that also works when the browser does not say the size in advance (chunked uploads).
import { Readable } from 'node:stream';
import { userError } from './system.js';

/** Biggest upload accepted, in bytes. Set MAX_UPLOAD_MB to change it (default 1024, so 1 GB). */
export const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 1024) * 1024 * 1024;

export function sizeText(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 ? 1 : 0)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function tooLarge(max) {
  const err = userError(`That file is too large. The limit is ${sizeText(max)}.`);
  err.status = 413;
  return err;
}

/** The request body as a web stream that fails once it passes max bytes. */
function limitedBody(req, max) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > max) throw tooLarge(max);
  let seen = 0;
  const counted = Readable.toWeb(req).pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) controller.error(tooLarge(max));
      else controller.enqueue(chunk);
    },
  }));
  return counted;
}

/** Reads a form (multipart or URL-encoded). Throws a user-facing error if it is too big or unreadable. */
export async function readFormData(req, max = MAX_UPLOAD) {
  const body = limitedBody(req, max);
  try {
    return await new Request('http://local/', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] || '' },
      body,
      duplex: 'half',
    }).formData();
  } catch (err) {
    if (err?.status === 413 || err?.cause?.status === 413) throw tooLarge(max);
    throw userError('The upload could not be read. Please try again.');
  }
}

/** Reads a small JSON body (at most 1 MB). */
export async function readJson(req, max = 1024 * 1024) {
  try {
    return JSON.parse(await new Response(limitedBody(req, max)).text());
  } catch (err) {
    if (err?.status === 413) throw err;
    throw userError('The request could not be read. Please try again.');
  }
}
