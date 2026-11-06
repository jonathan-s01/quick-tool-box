// Talks to the AI model servers. (The file keeps its old name so nothing else had to change.)
//
// Two kinds of server are supported:
//   ollama    Ollama's own API, for example on the Mac.
//   llamacpp  An OpenAI-compatible server such as llama-swap with llama.cpp, for example on the home server.
//
// Servers are tried in order, and the first one that answers is used (checked every 20 seconds):
//   1. LLM_MAC_URLS     comma separated Ollama addresses for the Mac, for example its Ethernet and Wi-Fi
//                       addresses, for example http://192.168.1.30:11434,http://192.168.1.31:11434
//   2. LLM_SERVER_URL   the llama-swap server, for example http://localhost:8091
// Older settings still work: OLLAMA_MAC_HOST (tried first) and OLLAMA_HOST (an Ollama server).
//
// For llama.cpp servers, which models can see images (and which "think") comes from LLM_MODELS_FILE,
// written by ./models.sh. Without it, names are used to guess (vl, vision, gemma-3 and so on).
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { userError, cancelledError } from './system.js';

function norm(h) {
  if (!h) return null;
  return (/^https?:\/\//.test(h) ? h : `http://${h}`).replace(/\/+$/, '').replace(/\/v1$/, '');
}

function list(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function buildHosts() {
  const hosts = [];
  const add = (label, type, url) => {
    const u = norm(url);
    if (u && !hosts.some((h) => h.url === u)) hosts.push({ label, type, url: u });
  };
  const macs = [...list(process.env.LLM_MAC_URLS), ...list(process.env.OLLAMA_MAC_HOST)];
  macs.forEach((u, i) => add(macs.length > 1 ? `Mac (${new URL(norm(u)).hostname})` : (process.env.OLLAMA_MAC_LABEL || 'Mac'), 'ollama', u));
  if (process.env.LLM_SERVER_URL) add(process.env.LLM_SERVER_LABEL || 'Server', 'llamacpp', process.env.LLM_SERVER_URL);
  if (process.env.OLLAMA_HOST || !hosts.length) {
    add(process.env.OLLAMA_LABEL || (process.platform === 'darwin' ? 'This Mac' : 'Server Ollama'), 'ollama', process.env.OLLAMA_HOST || '127.0.0.1:11434');
  }
  return hosts;
}

/** Every AI server this app knows about, in the order they are tried. */
export const OLLAMA_HOSTS = buildHosts();

async function rawApi(base, pathname, body, { signal, timeoutMs = 5000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${base}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json', authorization: 'Bearer none' } : { authorization: 'Bearer none' },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message || j.error || text; } catch { /* plain text */ }
    throw userError(`The AI server reported a problem: ${String(msg).slice(0, 500)}`);
  }
  return JSON.parse(text);
}

/** Is this server up? Cheap check. */
async function ping(h, timeoutMs) {
  if (h.type === 'ollama') await rawApi(h.url, '/api/version', null, { timeoutMs });
  else await rawApi(h.url, '/v1/models', null, { timeoutMs });
}

let active = { at: 0, host: null };
let checking = null;

/** The first AI server that answers, or the last one in the list if none do. */
export async function activeOllama() {
  if (active.host && Date.now() - active.at < 20000) return active.host;
  checking ??= (async () => {
    // Check all at once, then take the first in order that answered. Asleep Macs cost at most 1.5 seconds.
    const up = await Promise.all(OLLAMA_HOSTS.map((h) => ping(h, OLLAMA_HOSTS.length > 1 ? 1500 : 5000).then(() => true, () => false)));
    const host = OLLAMA_HOSTS[up.indexOf(true)] || OLLAMA_HOSTS[OLLAMA_HOSTS.length - 1];
    if (host !== active.host) cache = { at: 0, value: null };
    active = { at: Date.now(), host };
    checking = null;
    return host;
  })();
  return checking;
}

// ---------------------------------------------------------------- models

const VISION_NAME = /(^|[-_:/ .])(vl|vision|llava|gemma-?3|gemma-?4|minicpm-?v|moondream|pixtral|mmproj)([-_:/ .]|$)/i;

let infoFile = { at: 0, value: null };

/** Extra facts about llama.cpp models from LLM_MODELS_FILE: { id: { vision, thinking, size, name } }. */
async function modelInfo() {
  if (infoFile.value && Date.now() - infoFile.at < 15000) return infoFile.value;
  let value = {};
  const file = process.env.LLM_MODELS_FILE || '/llm/models.json';
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    for (const m of data.models || []) value[m.id] = m;
  } catch { /* no file: guess from names */ }
  infoFile = { at: Date.now(), value };
  return value;
}

/** All models on one server: [{ name, size, vision, thinking }]. */
async function modelsOn(h) {
  if (h.type === 'ollama') {
    const { models = [] } = await rawApi(h.url, '/api/tags');
    const checked = await Promise.all(models.map(async (m) => {
      try {
        const info = await rawApi(h.url, '/api/show', { model: m.name });
        const caps = info.capabilities || ['completion'];
        if (!caps.includes('completion')) return null; // embedding models cannot answer
        return { name: m.name, size: m.size, vision: caps.includes('vision'), thinking: caps.includes('thinking') };
      } catch {
        return null;
      }
    }));
    return checked.filter(Boolean);
  }
  const [{ data = [] }, info] = await Promise.all([rawApi(h.url, '/v1/models'), modelInfo()]);
  return data.filter((m) => m.id !== 'no-models-yet').map((m) => {
    const known = info[m.id] || {};
    if (known.embedding) return null;
    return {
      name: m.id,
      size: known.size || 0,
      vision: known.vision ?? VISION_NAME.test(m.id),
      thinking: Boolean(known.thinking),
    };
  }).filter(Boolean);
}

let cache = { at: 0, value: null };

/**
 * Every model on the AI server in use: { running, models: [{ name, size, vision, thinking }] }, smallest first.
 * running is false if no server answers.
 */
export async function textModels() {
  if (cache.value && Date.now() - cache.at < 15000) return cache.value;
  const h = await activeOllama();
  let value;
  try {
    const models = (await modelsOn(h)).sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
    value = { running: true, models, host: h };
  } catch {
    value = { running: false, models: [], host: h };
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Only the models that can look at images, sorted by name. */
export async function visionModels() {
  const all = await textModels();
  return { ...all, models: all.models.filter((m) => m.vision).sort((a, b) => a.size - b.size || a.name.localeCompare(b.name)) };
}

/** Status of one server, for the status page: { reachable, version, models }. */
export async function ollamaStatus(h) {
  try {
    let version = '';
    if (h.type === 'ollama') version = `Ollama ${(await rawApi(h.url, '/api/version', null, { timeoutMs: 2500 })).version}`;
    else version = 'llama.cpp (OpenAI-compatible)';
    const models = await modelsOn(h);
    return {
      reachable: true,
      version,
      models: models.map((m) => ({ name: m.name, size: m.size, capabilities: [m.vision ? 'vision' : '', m.thinking ? 'thinking' : ''].filter(Boolean) })),
    };
  } catch (err) {
    return { reachable: false, error: String(err.cause?.code || err.message || err) };
  }
}

// ---------------------------------------------------------------- asking

let last = { label: null, model: null };

/** Which computer answered the last AI request, for example "Mac". */
export function lastOllamaLabel() {
  return last.label || OLLAMA_HOSTS[OLLAMA_HOSTS.length - 1].label;
}

/** Which model answered the last AI request. It can differ from the one chosen if that computer went to sleep. */
export function lastModelUsed() {
  return last.model;
}

function imageMime(b64) {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('R0lG')) return 'image/gif';
  if (b64.startsWith('UklG')) return 'image/webp';
  return 'image/jpeg';
}

/** The chosen model if this server has it, otherwise the biggest one that can do the job. */
async function pickModel(wanted, needsVision) {
  const { models } = await textModels();
  const found = models.find((m) => m.name === wanted);
  if (found) return found;
  const usable = models.filter((m) => !needsVision || m.vision).sort((a, b) => b.size - a.size);
  if (!usable.length) {
    throw userError(needsVision
      ? 'The AI server in use has no model that can see pictures. On the home server, add one with ./models.sh.'
      : 'The AI server in use has no models. On the home server, add one with ./models.sh.');
  }
  return usable[0];
}

function cleanAnswer(text) {
  // Some models write their reasoning in <think> tags before the answer.
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  if (fence) t = fence[1];
  return t;
}

/**
 * The job an AI request belongs to, so progress can be shown on its page while the model works.
 * lib/jobs.js sets this around every tool run.
 */
export const aiJob = new AsyncLocalStorage();

// One AI request at a time from this app. On a CPU, two at once are each more than twice as slow,
// and a long one can make the other time out. Others wait their turn, and their page says so.
let aiBusy = Promise.resolve();
let aiActive = 0; // requests started and not finished, including waiting ones

function say(job, text) {
  if (job) job.progress = { ...job.progress, text };
}

/**
 * Streams one request with node:http rather than fetch. fetch gives up when a server takes more
 * than 5 minutes to start answering, which a CPU reading a big picture can. Calls onText with each
 * piece of the answer. Stops after IDLE_MS without anything new, or when signal aborts.
 */
function streamPost(url, body, { signal, onLine, idleMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: 'Bearer none' },
    });
    let idle;
    const fail = (err) => { clearTimeout(idle); req.destroy(); reject(err); };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        const err = new Error('idle');
        err.idle = true;
        fail(err);
      }, idleMs);
    };
    const abort = () => { const e = new Error('Cancelled.'); e.cancelled = true; fail(e); };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    touch();
    req.on('error', fail);
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let msg = text;
          try { const j = JSON.parse(text); msg = j.error?.message || j.error || text; } catch { /* plain */ }
          fail(userError(`The AI server reported a problem: ${String(msg).slice(0, 500)}`));
        });
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        touch();
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) onLine(line);
        }
      });
      res.on('end', () => {
        if (buf.trim()) onLine(buf.trim());
        clearTimeout(idle);
        signal?.removeEventListener('abort', abort);
        resolve();
      });
      res.on('error', fail);
    });
    req.end(data);
  });
}

/**
 * How big (in pixels, longest side) to make pictures sent to the AI. Every extra pixel is work for
 * the model before it can answer, which matters on the server's processor. Text needs more detail.
 * Change with LLM_IMAGE_MAX and LLM_IMAGE_MAX_TEXT.
 */
export async function aiImageSize({ text = false } = {}) {
  const h = await activeOllama();
  if (h.type === 'ollama') return 1800; // the Mac is fast enough for full detail
  return Number(text ? process.env.LLM_IMAGE_MAX_TEXT || 1400 : process.env.LLM_IMAGE_MAX || 1024);
}

/** Sends one request (optionally with an image) and returns the model's JSON answer, or null. */
export async function chatJson({ model, system, prompt, imageBase64, schema, signal }) {
  const job = aiJob.getStore()?.job;
  const before = job?.progress?.text || '';
  const lead = before ? `${before.replace(/[.\s]+$/, '')}. ` : '';
  // Wait for our turn.
  const turn = aiBusy;
  let release;
  aiBusy = new Promise((r) => { release = r; });
  if (aiActive > 0) say(job, `${lead}Waiting for the AI model: another job is using it`);
  aiActive++;
  await turn;
  const started = Date.now();
  let words = 0;
  let firstAt = 0;
  const tick = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    say(job, firstAt
      ? `${lead}AI is writing: about ${words} words so far`
      : `${lead}AI is reading the request (${secs} seconds). On the server's processor this can take a few minutes, longer with pictures`);
  }, 2000);
  try {
    const h = await activeOllama();
    const info = await pickModel(model, Boolean(imageBase64));
    let content = '';
    const onPiece = (piece) => {
      if (!piece) return;
      if (!firstAt) firstAt = Date.now();
      content += piece;
      words = content.split(/\s+/).filter(Boolean).length;
    };
    try {
      if (h.type === 'ollama') {
        await streamPost(`${h.url}/api/chat`, {
          model: info.name,
          stream: true,
          // Turn off "thinking" for models that support it: it is slow and not needed here.
          ...(info.thinking ? { think: false } : {}),
          keep_alive: '15m',
          format: schema,
          options: { temperature: 0, num_ctx: 8192 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt, images: imageBase64 ? [imageBase64] : undefined },
          ],
        }, {
          signal,
          idleMs: 15 * 60 * 1000,
          onLine: (line) => {
            try { onPiece(JSON.parse(line)?.message?.content); } catch { /* ignore partial lines */ }
          },
        });
      } else {
        const user = imageBase64
          ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${imageMime(imageBase64)};base64,${imageBase64}` } }]
          : prompt;
        await streamPost(`${h.url}/v1/chat/completions`, {
          model: info.name,
          temperature: 0,
          stream: true,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } } : {}),
          ...(info.thinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        }, {
          signal,
          idleMs: 15 * 60 * 1000,
          onLine: (line) => {
            if (!line.startsWith('data:')) return;
            const d = line.slice(5).trim();
            if (d === '[DONE]') return;
            try { onPiece(JSON.parse(d)?.choices?.[0]?.delta?.content); } catch { /* ignore */ }
          },
        });
      }
    } catch (err) {
      if (err.cancelled || signal?.aborted) throw cancelledError();
      if (err.userFacing) throw err;
      if (err.idle) throw userError('The AI server stopped answering for 15 minutes, so the request was stopped. Check the Status page; a smaller model or picture may help.');
      active = { at: 0, host: null }; // check again which server is up next time
      throw userError(`Could not reach the AI server (${h.label}). Check the Status page, then try again.`, String(err.cause || err.message || err));
    }
    last = { label: h.label, model: info.name };
    try {
      return JSON.parse(cleanAnswer(content));
    } catch {
      return null; // the caller treats this as "no usable answer"
    }
  } finally {
    clearInterval(tick);
    say(job, before);
    aiActive--;
    release();
  }
}

/** Where the AI servers are expected, in words, for setup notes. */
export function ollamaWhere() {
  return OLLAMA_HOSTS.map((h) => `${h.label} (${h.url})`).join(', then ');
}

/** A setup note for when no AI server can be reached. */
export function ollamaMissingNote(feature) {
  if (process.platform === 'darwin' && OLLAMA_HOSTS.length === 1 && /127\.0\.0\.1|localhost/.test(OLLAMA_HOSTS[0].url)) {
    return { what: `${feature} uses Ollama, which is not running or not installed. Start the Ollama app and reload this page.`, install: 'brew install ollama' };
  }
  return { what: `${feature} needs an AI server, and none answered. Tried: ${ollamaWhere()}. Check the Status page.`, install: null };
}

/** A setup note for when the server is up but has no suitable model. */
export function noModelNote(feature, vision = false) {
  return {
    what: `${feature} needs an AI model${vision ? ' that can see pictures' : ''}. On the home server, run ./models.sh and choose one${vision ? ' marked "sees images", such as Qwen3 VL 4B' : ', such as Qwen3 VL 4B'}. On the Mac, use Ollama, for example ollama pull ${vision ? 'qwen3-vl:8b' : 'qwen3:8b'}.`,
    install: null,
  };
}
