// Keeps track of running and finished jobs. Each job gets its own temporary folder.
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { aiJob } from './ollama.js';
import { rmSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { run, userError } from './system.js';
import { safeBaseName } from './files.js';

export const ROOT = process.env.WORK_DIR || path.join(os.tmpdir(), 'quick-tool-box');

// How many jobs may run at the same time. Others wait their turn, so a few big jobs at once
// cannot use up all the memory. Set MAX_JOBS to change it.
const MAX_JOBS = Math.max(1, Number(process.env.MAX_JOBS) || 2);
let runningJobs = 0;
const waiting = [];

async function takeSlot(job, signal) {
  if (runningJobs < MAX_JOBS) { runningJobs++; return; }
  job.progress = { value: null, max: null, text: 'Waiting for another job to finish' };
  await new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    waiting.push(entry);
    signal.addEventListener('abort', () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      const err = new Error('Cancelled.');
      err.cancelled = true;
      reject(err);
    }, { once: true });
  });
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next.resolve(); // hand the slot straight to the next job
  else runningJobs--;
}
const KEEP_FINISHED_MS = 60 * 60 * 1000; // finished jobs and their files are deleted after 1 hour

const jobs = new Map();

/** File types that can also be opened in the browser, not just downloaded. */
export const VIEWABLE = new Set(['.html', '.txt', '.srt', '.vtt', '.md', '.json', '.xml']);

export async function resetWorkArea() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
}

export function removeWorkAreaSync() {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function getJob(id) {
  return jobs.get(id);
}

/** What the browser is allowed to see about a job. */
export function publicJob(job) {
  return {
    id: job.id,
    tool: job.toolName,
    state: job.state, // running | done | failed | cancelled
    progress: job.progress,
    message: job.message,
    details: job.details,
    outputs: job.outputs.map((o, index) => ({ index, name: o.name, label: o.label, size: o.size, viewable: VIEWABLE.has(path.extname(o.name).toLowerCase()) })),
    review: job.state === 'done' ? job.review || null : null,
    links: job.links || [],
  };
}

/**
 * Starts a tool in the background.
 * upload is a web File (from FormData) or null for tools that take no file.
 */
export async function startJob(tool, options, upload, from = null) {
  const id = randomUUID();
  const dir = path.join(ROOT, id);
  // A second step (see lib/review.js) keeps working in the first step's folders.
  const inDir = from ? from.inDir : path.join(dir, 'in');
  const workDir = from ? from.workDir : path.join(dir, 'work');
  const outDir = path.join(dir, 'out');
  await Promise.all([inDir, workDir, outDir].map((d) => mkdir(d, { recursive: true })));

  let input = from ? from.input : null;
  if (upload) {
    const ext = (path.extname(upload.name || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [''])[0];
    const inputPath = path.join(inDir, `input${ext}`);
    await pipeline(Readable.fromWeb(upload.stream()), createWriteStream(inputPath));
    input = { path: inputPath, name: upload.name || 'file', base: safeBaseName(upload.name), ext };
  }

  const controller = new AbortController();
  const job = {
    id,
    toolName: tool.name,
    toolId: tool.id,
    state: 'running',
    progress: { value: null, max: null, text: 'Starting' },
    message: '',
    details: '',
    outputs: [],
    controller,
    dir,
    inDir,
    workDir,
    input,
    options,
    review: null, // choices to show the user before a second step
    reviewState: null, // private data the second step needs
    links: [],
  };
  jobs.set(id, job);

  const ctx = {
    input,
    options,
    workDir,
    outDir,
    signal: controller.signal,
    /** Update the progress bar. Leave value/max null for "working, amount unknown". */
    progress(value, max, text) {
      job.progress = { value: value ?? null, max: max ?? null, text: text ?? '' };
    },
    /** Offer a finished file for download. */
    output(filePath, label) {
      job.outputs.push({ path: filePath, name: path.basename(filePath), label });
    },
    /** Set the message read out when the job finishes (for example a short result summary). */
    finishMessage(text) {
      job.finishText = text;
    },
    /** Ask the user to choose before finishing. tool.continue() runs with their choices. */
    review(publicData, privateState) {
      job.review = publicData;
      job.reviewState = privateState;
    },
    /** Add a link to show with the results, for example to a saved copy. */
    link(href, text) {
      job.links.push({ href, text });
    },
    /** Run a command; it is stopped automatically if the job is cancelled. */
    run: (cmd, args, opts = {}) => run(cmd, args, { ...opts, signal: controller.signal }),
  };

  (async () => {
    let slot = false;
    try {
      await takeSlot(job, controller.signal);
      slot = true;
      job.progress = { value: null, max: null, text: 'Starting' };
      await aiJob.run({ job }, () => (from ? tool.continue(ctx, from.reviewState, from.choices) : tool.run(ctx)));
      if (!job.outputs.length && !job.finishText && !job.review) throw userError('The tool finished but did not produce any files.');
      for (const o of job.outputs) o.size = (await stat(o.path)).size;
      job.state = 'done';
      const files = job.outputs.length ? `${job.outputs.length} ${job.outputs.length === 1 ? 'file' : 'files'} ready.` : '';
      job.message = [job.finishText, files].filter(Boolean).join(' ');
    } catch (err) {
      job.outputs = [];
      if (err.cancelled || controller.signal.aborted) {
        job.state = 'cancelled';
        job.message = 'Cancelled.';
      } else {
        job.state = 'failed';
        job.message = err.userFacing ? err.message : 'Something went wrong.';
        job.details = err.details || (err.userFacing ? '' : String(err.stack || err));
      }
    } finally {
      if (slot) releaseSlot();
      // Delete the input and working files now, and everything else later.
      // If the user still has to choose (review), keep them until the second step or the hour is up.
      const waiting = job.state === 'done' && job.review;
      if (!waiting) {
        rm(inDir, { recursive: true, force: true }).catch(() => {});
        rm(workDir, { recursive: true, force: true }).catch(() => {});
      } else {
        setTimeout(() => {
          rm(inDir, { recursive: true, force: true }).catch(() => {});
          rm(workDir, { recursive: true, force: true }).catch(() => {});
        }, KEEP_FINISHED_MS).unref();
      }
      setTimeout(() => {
        jobs.delete(id);
        rm(dir, { recursive: true, force: true }).catch(() => {});
      }, KEEP_FINISHED_MS).unref();
    }
  })();

  return job;
}
