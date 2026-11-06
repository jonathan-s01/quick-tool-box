// Helpers for finding and running command line programs.
// Commands are always run directly (no shell), so form input can never be run as a command.
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Make sure Homebrew locations are on PATH even if the server was started from somewhere unusual.
// ~/.local/bin is where uv and pipx put tools such as Docling.
for (const dir of ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')]) {
  const parts = (process.env.PATH || '').split(':');
  if (!parts.includes(dir)) process.env.PATH = [dir, ...parts].filter(Boolean).join(':');
}

// Which Homebrew package provides each command. Used for install hints.
export const BREW = {
  tesseract: 'tesseract',
  pdftoppm: 'poppler',
  pdfinfo: 'poppler',
  pdftotext: 'poppler',
  magick: 'imagemagick',
  ffmpeg: 'ffmpeg',
  'whisper-cli': 'whisper-cpp',
  ocrmypdf: 'ocrmypdf',
  pandoc: 'pandoc',
  exiftool: 'exiftool',
  'yt-dlp': 'yt-dlp',
  curl: null, // built into macOS
  say: null, // built into macOS
  afconvert: null, // built into macOS
  textutil: null, // built into macOS
  zip: null, // built into macOS
  ollama: 'ollama',
  uv: 'uv',
};

/** Returns the full path of a command, or null if it is not installed. */
export async function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      await access(full, constants.X_OK);
      return full;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Builds a "missing" entry with an install hint. */
export function missing(cmd, extra) {
  const pkg = BREW[cmd];
  return {
    what: extra || `${cmd} is not installed.`,
    install: pkg ? `brew install ${pkg}` : null,
  };
}

/**
 * Runs a command and resolves with { stdout, stderr, code }.
 * Rejects with a readable message if it fails, is cancelled, or is not installed.
 * okCodes lists exit codes that count as success (default: only 0).
 * onStdout / onStderr receive output as it arrives, for progress tracking.
 */
export function run(cmd, args, { signal, cwd, env, onStdout, onStderr, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      });
    } catch (err) {
      return reject(err);
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      onStdout?.(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-20000); // keep the last 20 KB only
      onStderr?.(s);
    });
    child.on('error', (err) => {
      if (err.name === 'AbortError') return reject(cancelledError());
      if (err.code === 'ENOENT') {
        const pkg = BREW[cmd];
        return reject(userError(`${cmd} is not installed.${pkg ? ` Install it with: brew install ${pkg}` : ''}`));
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (signal?.aborted) return reject(cancelledError());
      if (okCodes.includes(code)) return resolve({ stdout, stderr, code });
      const err = userError(`${path.basename(cmd)} stopped with an error (exit code ${code}).`);
      err.exitCode = code;
      err.stderr = stderr;
      err.details = `Command: ${cmd} ${args.join(' ')}\n\n${stderr.trim() || stdout.trim().slice(-5000)}`;
      reject(err);
    });
  });
}

/** An error whose message is safe and useful to show to the user. */
export function userError(message, details) {
  const err = new Error(message);
  err.userFacing = true;
  if (details) err.details = details;
  return err;
}

export function cancelledError() {
  const err = new Error('Cancelled.');
  err.cancelled = true;
  return err;
}

/** Runs fn over items with at most `limit` running at once. Results keep input order.
 *  Stops starting new items as soon as one fails or the job is cancelled. */
export async function pool(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  let stop = false;
  async function worker() {
    while (!stop && next < items.length) {
      if (signal?.aborted) throw cancelledError();
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        stop = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Removes terminal colour codes and carriage-return redraws from program output. */
export function plainText(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .split('\n')
    .map((line) => line.split('\r').filter(Boolean).pop() ?? '')
    .join('\n');
}
