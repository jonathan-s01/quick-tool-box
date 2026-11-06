// Downloads AI models for llama.cpp and writes the llama-swap settings. Run it with ./models.sh, which
// runs this in a small Node container with the llm folder at /llm.
//
//   ./models.sh                 menu: shows installed and suggested models, asks what to do
//   ./models.sh list            installed and suggested models
//   ./models.sh add KEY         add a suggested model, for example: ./models.sh add qwen3-vl-4b
//   ./models.sh add REPO:QUANT  add any GGUF model from Hugging Face, for example unsloth/Qwen3-8B-GGUF:Q4_K_M
//   ./models.sh remove ID       delete a model
//   ./models.sh recommended     add the recommended model if it is not there yet
//   ./models.sh config          rewrite llm/llama-swap.yaml (after changing tuning in .env)
//   ./models.sh bench [ID]      measure how fast a model answers on this computer
//   ./models.sh tune [ID]       try different numbers of threads and keep the fastest (about 5 minutes)
//
// Settings come from .env: LLM_THREADS, LLM_THREADS_BATCH, LLM_CTX, LLM_TTL, LLM_RAM_GB, HF_TOKEN.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, statfs, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

const LLM = process.env.LLM_DIR || '/llm';
const MODELS_DIR = path.join(LLM, 'models');
const INDEX = path.join(LLM, 'models.json');
const SWAP_CONFIG = path.join(LLM, 'llama-swap.yaml');
const HF = 'https://huggingface.co';

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const THREADS = Number(env('LLM_THREADS', '5'));
const THREADS_BATCH = Number(env('LLM_THREADS_BATCH', String(THREADS)));
const CTX = Number(env('LLM_CTX', '8192'));
const TTL = Number(env('LLM_TTL', '900'));
const RAM_GB = Number(env('LLM_RAM_GB', '0'));
const SERVER = env('LLM_BENCH_URL', 'http://localhost:8091');

// Suggested models. Sizes are rough, for the 4-bit (Q4_K_M) version. Each is checked on Hugging Face
// when you add it, so if one has moved, you get a clear message instead of a broken download.
export const CATALOG = [
  {
    key: 'qwen3-vl-4b', repo: 'unsloth/Qwen3-VL-4B-Instruct-GGUF', quant: 'Q4_K_M', vision: true, recommended: true,
    name: 'Qwen3 VL 4B Instruct', about: 'Recommended. Reads text and sees images, so one model covers every tool. About 3.3 GB.',
  },
  {
    key: 'qwen3-1.7b', repo: 'unsloth/Qwen3-1.7B-GGUF', quant: 'Q4_K_M', thinking: true, fast: true,
    name: 'Qwen3 1.7B', about: 'Fast. Text only. Good for Home Assistant and quick chat; can use tools. About 1.1 GB.',
  },
  {
    key: 'llama3.2-3b', repo: 'unsloth/Llama-3.2-3B-Instruct-GGUF', quant: 'Q4_K_M', fast: true,
    name: 'Llama 3.2 3B Instruct', about: 'Fast. Text only. Reliable with Home Assistant tools. About 2 GB.',
  },
  {
    key: 'gemma3-1b', repo: 'unsloth/gemma-3-1b-it-GGUF', quant: 'Q4_K_M', fast: true,
    name: 'Gemma 3 1B', about: 'Fastest. Text only, short simple answers. About 0.8 GB.',
  },
  {
    key: 'qwen3-4b', repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', quant: 'Q4_K_M',
    name: 'Qwen3 4B Instruct 2507', about: 'Text only. Good quality for its size and quick. About 2.5 GB.',
  },
  {
    key: 'qwen3-8b', repo: 'unsloth/Qwen3-8B-GGUF', quant: 'Q4_K_M', thinking: true,
    name: 'Qwen3 8B', about: 'Text only. Better writing and reasoning, about half the speed of the 4B models. About 5 GB.',
  },
  {
    key: 'qwen3-vl-8b', repo: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', quant: 'Q4_K_M', vision: true,
    name: 'Qwen3 VL 8B Instruct', about: 'Sees images, more accurate than the 4B, slower. About 6 GB.',
  },
  {
    key: 'gemma3-4b', repo: 'unsloth/gemma-3-4b-it-GGUF', quant: 'Q4_K_M', vision: true,
    name: 'Gemma 3 4B', about: 'Google model that sees images. An alternative to Qwen3 VL 4B. About 3.3 GB.',
  },
  {
    key: 'qwen3.5-4b', repo: 'unsloth/Qwen3.5-4B-GGUF', quant: 'Q4_K_M',
    name: 'Qwen3.5 4B', about: 'Newer than Qwen3. If its repository has an image file, it is set up to see images too. About 3 GB.',
  },
  {
    key: 'gemma4-e4b', repo: 'unsloth/gemma-4-E4B-it-GGUF', quant: 'Q4_K_M',
    name: 'Gemma 4 E4B', about: 'Newer Google model built for small computers. Sees images if its repository has an image file. About 5 GB.',
  },
  {
    key: 'phi4-mini', repo: 'unsloth/Phi-4-mini-instruct-GGUF', quant: 'Q4_K_M',
    name: 'Phi 4 mini', about: 'Text only, small and fast. About 2.5 GB.',
  },
];

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;

async function loadIndex() {
  try {
    return JSON.parse(await readFile(INDEX, 'utf8'));
  } catch {
    return { models: [] };
  }
}

async function saveIndex(index) {
  index.models.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`);
}

// ---------------------------------------------------------------- Hugging Face

function hfHeaders() {
  const t = env('HF_TOKEN', '');
  return t ? { authorization: `Bearer ${t}` } : {};
}

async function repoFiles(repo) {
  const res = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=true`, { headers: hfHeaders() });
  if (res.status === 401 || res.status === 403) throw new Error(`${repo} needs a Hugging Face login. Accept its licence on huggingface.co, make a read token, and put it in .env as HF_TOKEN.`);
  if (res.status === 404) throw new Error(`${repo} was not found on Hugging Face. It may have been renamed. Search huggingface.co for a GGUF version and use ./models.sh add REPO:QUANT.`);
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${repo}.`);
  return (await res.json()).filter((f) => f.type === 'file').map((f) => ({ path: f.path, size: f.lfs?.size ?? f.size ?? 0 }));
}

/** Picks the model file(s) for a quantisation, and the best image file (mmproj) if there is one. */
export function choose(files, quant) {
  const ggufs = files.filter((f) => f.path.toLowerCase().endsWith('.gguf'));
  const mmprojs = ggufs.filter((f) => /mmproj/i.test(path.basename(f.path)));
  const weights = ggufs.filter((f) => !/mmproj/i.test(path.basename(f.path)));
  const q = quant.toLowerCase();
  const hits = weights.filter((f) => {
    const p = f.path.toLowerCase();
    return p.includes(`-${q}.`) || p.includes(`.${q}.`) || p.includes(`_${q}.`) || p.includes(`-${q}-`) || p.includes(`/${q}/`) || p.includes(`-${q}/`);
  });
  if (!hits.length) {
    const available = [...new Set(weights.map((f) => (/(I?Q\d[\w]*|BF16|F16|F32)/i.exec(path.basename(f.path)) || [])[1]).filter(Boolean))];
    throw new Error(`No ${quant} file in this repository. Available: ${available.join(', ') || 'none'}.`);
  }
  // A big model can be split into parts (-00001-of-00003). Use all parts of one set.
  const single = hits.filter((f) => !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path));
  const parts = single.length ? [single.sort((a, b) => a.path.length - b.path.length)[0]] : hits.sort((a, b) => a.path.localeCompare(b.path));
  const order = ['f16', 'bf16', 'f32', 'q8_0'];
  const rank = (f) => {
    const tokens = path.basename(f.path).toLowerCase().replace(/\.gguf$/, '').split(/[-_.]/);
    const r = order.findIndex((o) => tokens.includes(o) || tokens.includes(o.replace('_', '')));
    return r < 0 ? 9 : r;
  };
  const mmproj = [...mmprojs].sort((a, b) => rank(a) - rank(b))[0] || null;
  return { parts, mmproj };
}

async function download(repo, file, to) {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    if ((await stat(to)).size === file.size) { console.log(`  Already have ${path.basename(to)}.`); return; }
  } catch { /* not there yet */ }
  const part = `${to}.part`;
  let have = 0;
  try { have = (await stat(part)).size; } catch { /* fresh */ }
  const url = `${HF}/${repo}/resolve/main/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { headers: { ...hfHeaders(), ...(have ? { range: `bytes=${have}-` } : {}) }, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error(`Download failed (${res.status}) for ${file.path}.`);
  if (have && res.status !== 206) have = 0; // the server would not resume; start again
  const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
  let done = have;
  let lastPrint = 0;
  const started = Date.now();
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    done += chunk.length;
    if (Date.now() - lastPrint > 3000) {
      lastPrint = Date.now();
      const rate = (done - have) / Math.max(1, (Date.now() - started) / 1000);
      const left = rate ? Math.round((file.size - done) / rate / 60) : 0;
      console.log(`  ${path.basename(to)}: ${Math.floor((done / file.size) * 100)}% of ${gb(file.size)}${left ? `, about ${left} min left` : ''}`);
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if ((await stat(part)).size !== file.size) throw new Error(`${path.basename(to)} did not download completely. Run the same command again to continue.`);
  await rename(part, to);
  console.log(`  Saved ${path.basename(to)}.`);
}

// ---------------------------------------------------------------- commands

function slug(s) {
  return s.toLowerCase().replace(/-gguf$/i, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

async function add(spec) {
  let entry = CATALOG.find((c) => c.key === spec);
  if (!entry) {
    const m = /^([\w.-]+\/[\w.-]+?)(?::([\w.]+))?$/.exec(spec || '');
    if (!m) throw new Error(`"${spec}" is not a suggested model or a Hugging Face REPO:QUANT. Run ./models.sh list.`);
    entry = { key: slug(`${m[1].split('/')[1]}-${m[2] || 'Q4_K_M'}`), repo: m[1], quant: m[2] || 'Q4_K_M', name: m[1].split('/')[1].replace(/-GGUF$/i, '') };
  }
  const index = await loadIndex();
  if (index.models.some((x) => x.id === entry.key)) { console.log(`${entry.name} is already installed as ${entry.key}.`); return false; }
  console.log(`Checking ${entry.repo} on Hugging Face...`);
  const { parts, mmproj } = choose(await repoFiles(entry.repo), entry.quant);
  const vision = entry.vision ?? Boolean(mmproj);
  const useMmproj = vision ? mmproj : null;
  if (vision && !useMmproj) throw new Error(`${entry.repo} has no image file (mmproj), so it cannot see images here.`);
  const total = parts.reduce((n, f) => n + f.size, 0) + (useMmproj?.size || 0);
  const fs = await statfs(LLM);
  const free = fs.bavail * fs.bsize;
  console.log(`${entry.name}: ${gb(total)} to download, ${gb(free)} free.`);
  if (total > free - 2e9) throw new Error('Not enough free disk space. Remove a model first, or make the disk bigger.');
  if (RAM_GB && total / 1e9 + 1.5 > RAM_GB) {
    console.log(`Warning: this model needs about ${(total / 1e9 + 1.5).toFixed(1)} GB of memory while running, and LLM_RAM_GB in .env says ${RAM_GB} GB are set aside. It may be very slow or fail to load.`);
  }
  const dir = path.join(MODELS_DIR, entry.key);
  for (const f of parts) await download(entry.repo, f, path.join(dir, path.basename(f.path)));
  if (useMmproj) await download(entry.repo, useMmproj, path.join(dir, path.basename(useMmproj.path)));
  index.models.push({
    id: entry.key,
    name: entry.name,
    repo: entry.repo,
    quant: entry.quant,
    file: `${entry.key}/${path.basename(parts[0].path)}`,
    mmproj: useMmproj ? `${entry.key}/${path.basename(useMmproj.path)}` : null,
    size: total,
    vision,
    thinking: Boolean(entry.thinking),
    added: new Date().toISOString(),
  });
  await saveIndex(index);
  console.log(`Added ${entry.name} as "${entry.key}".`);
  return true;
}

async function remove(id) {
  const index = await loadIndex();
  const m = index.models.find((x) => x.id === id);
  if (!m) throw new Error(`No installed model called ${id}. Run ./models.sh list.`);
  await rm(path.join(MODELS_DIR, id), { recursive: true, force: true });
  index.models = index.models.filter((x) => x.id !== id);
  await saveIndex(index);
  console.log(`Removed ${m.name}.`);
}

function yamlString(s) {
  return JSON.stringify(String(s)); // JSON strings are valid YAML strings
}

/** Writes llm/llama-swap.yaml from the installed models and the tuning in .env. */
export async function writeConfig({ tune = null } = {}) {
  const index = await loadIndex();
  const lines = [
    '# Made by ./models.sh from llm/models.json and the LLM_ settings in .env.',
    '# Do not edit this by hand: change .env, then run ./models.sh config and docker compose restart llama-swap.',
    `# Tuning: ${THREADS} threads for writing, ${THREADS_BATCH} for reading the prompt, ${CTX} tokens of context.`,
    'healthCheckTimeout: 600',
    'logLevel: info',
    'startPort: 10001',
    'models:',
  ];
  if (!index.models.length) {
    // llama-swap needs at least one entry. This one explains itself if someone tries to use it.
    lines.push('  "no-models-yet":', '    name: "No models installed. Run ./models.sh on the server."', '    cmd: /app/llama-server --port ${PORT} --help');
  }
  const entries = [...index.models.map((m) => ({ m, id: m.id, threads: THREADS, batch: THREADS_BATCH }))];
  // While tuning: extra copies of one model with different numbers of threads.
  if (tune) for (const t of tune.candidates) entries.push({ m: tune.model, id: `${tune.model.id}@t${t}`, threads: t, batch: t });
  for (const { m, id, threads, batch } of entries) {
    const args = [
      '/app/llama-server --port ${PORT} --host 127.0.0.1',
      `--model /models/${m.file}`,
      ...(m.mmproj ? [`--mmproj /models/${m.mmproj}`] : []),
      `--threads ${threads} --threads-batch ${batch}`,
      `--ctx-size ${CTX} --parallel 1 --jinja`,
      // Reuse the start of the previous request (system prompt, Home Assistant's device list) instead of
      // reading it again, which is the slow part on a processor.
      '--cache-reuse 256',
      // Models that "think" first write hundreds of hidden words before answering. Turn that off.
      ...(m.thinking ? ['--reasoning-budget 0'] : []),
    ];
    lines.push(
      `  ${yamlString(id)}:`,
      `    name: ${yamlString(`${m.name}${m.vision ? ' (sees images)' : ''}`)}`,
      '    cmd: >-',
      ...args.map((a) => `      ${a}`),
      `    ttl: ${TTL}`,
    );
  }
  await writeFile(SWAP_CONFIG, `${lines.join('\n')}\n`);
  console.log(`Wrote llm/llama-swap.yaml with ${index.models.length} ${index.models.length === 1 ? 'model' : 'models'}.`);
}

async function listAll() {
  const index = await loadIndex();
  console.log('\nInstalled:');
  if (!index.models.length) console.log('  none');
  for (const m of index.models) console.log(`  ${m.id}: ${m.name}, ${gb(m.size)}${m.vision ? ', sees images' : ''}`);
  console.log('\nSuggested (add with ./models.sh add KEY):');
  CATALOG.forEach((c, i) => console.log(`  ${i + 1}. ${c.key}: ${c.name}. ${c.about}${index.models.some((m) => m.id === c.key) ? ' (installed)' : ''}`));
  console.log('\nOn the server\'s processor, models of 1 to 3 billion (B) answer in seconds; 4B in tens of seconds; 8B is slow.');
  console.log('\nAny other GGUF model: ./models.sh add REPO:QUANT, for example unsloth/Qwen3-8B-GGUF:Q4_K_M');
}

async function ask(id, prompt, max, thinking) {
  const res = await fetch(`${SERVER}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: id, max_tokens: max, temperature: 0, cache_prompt: false, messages: [{ role: 'user', content: prompt }], ...(thinking ? { chat_template_kwargs: { enable_thinking: false } } : {}) }),
  });
  if (!res.ok) throw new Error(`The server answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const BENCH_PROMPT = `Here is a short document.\n\n${'The quarterly report shows steady growth in all regions, with costs held flat and customer numbers rising. '.repeat(25)}\n\nWrite a 100 word summary.`;

/** Speeds for one model: { pp, tg } tokens per second for reading and writing. */
async function measure(id, thinking) {
  await ask(id, 'Say OK.', 5, thinking); // load the model
  const r = await ask(id, BENCH_PROMPT, 120, thinking);
  const t = r.timings || {};
  return { pp: t.prompt_per_second || 0, tg: t.predicted_per_second || 0, ppN: t.prompt_n || 0 };
}

async function bench(id) {
  const index = await loadIndex();
  const m = id ? index.models.find((x) => x.id === id) : index.models[0];
  if (!m) throw new Error('No model to test. Add one first.');
  console.log(`Loading ${m.name} and measuring (about a minute)...`);
  const s = await measure(m.id, m.thinking);
  console.log(`\nResults for ${m.name}, ${THREADS} threads writing, ${THREADS_BATCH} reading:`);
  console.log(`  Reading: ${s.pp.toFixed(1)} tokens per second. A Home Assistant request (about 2,000 tokens) would take about ${Math.round(2000 / Math.max(s.pp, 0.1))} seconds to read the first time.`);
  console.log(`  Writing: ${s.tg.toFixed(1)} tokens per second, about ${(s.tg * 0.75).toFixed(1)} words per second.`);
  console.log('\nTo find the best number of threads by itself, run ./models.sh tune');
}

/** Step 1 of tuning: add copies of a model with different thread counts. models.sh then restarts llama-swap. */
async function tunePrepare(id) {
  const index = await loadIndex();
  const fast = index.models.filter((m) => !m.vision).sort((a, b) => a.size - b.size)[0];
  const m = id ? index.models.find((x) => x.id === id) : (fast || index.models[0]);
  if (!m) throw new Error('No model to tune with. Add one first.');
  const cores = Number(env('LLM_CORES', '0')) || THREADS_BATCH;
  const low = Math.max(2, Math.floor(cores / 2));
  const candidates = [];
  for (let t = low; t <= cores; t++) candidates.push(t);
  await writeFile(path.join(LLM, 'tune.json'), JSON.stringify({ model: m.id, candidates }));
  await writeConfig({ tune: { model: m, candidates } });
  console.log(`Will test ${m.name} with ${candidates.join(', ')} threads. Each takes about a minute; nothing else should use the AI meanwhile.`);
}

/** Step 2 of tuning: measure each copy and write the best to llm/tune-result.json. */
async function tuneRun() {
  const plan = JSON.parse(await readFile(path.join(LLM, 'tune.json'), 'utf8'));
  const index = await loadIndex();
  const m = index.models.find((x) => x.id === plan.model);
  const results = [];
  for (const t of plan.candidates) {
    process.stdout.write(`  ${t} threads: `);
    try {
      const r = await measure(`${m.id}@t${t}`, m.thinking);
      // A typical request here: read about 1,000 tokens, write about 150.
      const secs = 1000 / Math.max(r.pp, 0.1) + 150 / Math.max(r.tg, 0.1);
      results.push({ t, ...r, secs });
      console.log(`reading ${r.pp.toFixed(1)}, writing ${r.tg.toFixed(1)} tokens per second (typical request about ${Math.round(secs)} seconds)`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }
  if (!results.length) throw new Error('Every test failed. Check docker compose logs llama-swap.');
  const bestWrite = results.reduce((a, b) => (b.tg > a.tg ? b : a));
  const bestRead = results.reduce((a, b) => (b.pp > a.pp ? b : a));
  await writeFile(path.join(LLM, 'tune-result.json'), JSON.stringify({ threads: bestWrite.t, threadsBatch: bestRead.t }));
  console.log(`\nFastest: ${bestWrite.t} threads for writing, ${bestRead.t} for reading. Saving these in .env.`);
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      await listAll();
      const a = (await rl.question('\nType a number or KEY to add, "remove ID", REPO:QUANT, or press Enter to finish: ')).trim();
      if (!a) return;
      try {
        if (a.startsWith('remove ')) await remove(a.slice(7).trim());
        else if (/^\d+$/.test(a) && CATALOG[Number(a) - 1]) await add(CATALOG[Number(a) - 1].key);
        else await add(a);
      } catch (err) {
        console.log(`\n${err.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  await mkdir(MODELS_DIR, { recursive: true });
  // Clean up downloads that were interrupted more than a day ago.
  for (const d of await readdir(MODELS_DIR).catch(() => [])) {
    for (const f of await readdir(path.join(MODELS_DIR, d)).catch(() => [])) {
      const p = path.join(MODELS_DIR, d, f);
      if (f.endsWith('.part') && Date.now() - (await stat(p)).mtimeMs > 86400000) await rm(p, { force: true });
    }
  }
  const [cmd = '', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case '': if (process.stdin.isTTY) await menu(); else await listAll(); break;
    case 'list': await listAll(); return;
    case 'add': if (!rest[0]) throw new Error('Say which model, for example: ./models.sh add qwen3-vl-4b'); await add(rest[0]); break;
    case 'remove': await remove(rest[0]); break;
    case 'recommended': {
      const index = await loadIndex();
      if (!index.models.length) await add(CATALOG.find((c) => c.recommended).key);
      else console.log('A model is already installed, so nothing was added.');
      break;
    }
    case 'config': break;
    case 'bench': await bench(rest[0]); return;
    case 'tune-prepare': await tunePrepare(rest[0]); return;
    case 'tune-run': await tuneRun(); return;
    default: throw new Error(`Unknown command "${cmd}". Run ./models.sh list.`);
  }
  await writeConfig();
}

if (process.argv[1] && process.argv[1].endsWith('models.mjs')) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
