// Downloads speech models for the Speech to text (Whisper) tool.
import path from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { which, missing, userError, plainText } from '../lib/system.js';
import { MODELS_DIR, MODEL_URL, KNOWN_MODELS, installedModels } from '../lib/whisper-models.js';

export default {
  id: 'whisper-models',
  name: 'Whisper model download',
  summary: 'Download speech models for the Speech to text (Whisper) tool. You only need to do this once per model.',
  submitLabel: 'Download model',
  input: null,

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await which('curl'))) result.missing.push(missing('curl'));
    const have = new Set(await installedModels());
    result.notes.push({ what: `Models are saved in ${MODELS_DIR}. To remove one, delete its file from that folder.`, install: null });
    result.options.push({
      id: 'model', type: 'select', label: 'Model to download', default: 'small.en',
      help: 'Listed from fastest to most accurate. If you are not sure, start with small.en for English, or large-v3-turbo-q5_0 for French or mixed languages.',
      choices: KNOWN_MODELS.map((m) => ({
        value: m.name,
        label: `${m.name}, ${m.size}. ${m.about}${have.has(m.name) ? ' Already downloaded.' : ''}`,
      })),
    });
    return result;
  },

  async run(ctx) {
    const name = ctx.options.model;
    await mkdir(MODELS_DIR, { recursive: true });
    const final = path.join(MODELS_DIR, `ggml-${name}.bin`);
    const part = `${final}.part`;
    ctx.progress(0, 100, 'Downloading, 0% done');
    try {
      await ctx.run('curl', ['--location', '--fail', '--show-error', '--progress-bar', '--output', part, MODEL_URL(name)], {
        onStderr(chunk) {
          const all = [...chunk.matchAll(/(\d{1,3}(?:\.\d)?)%/g)];
          if (all.length) {
            const pct = Math.floor(Number(all[all.length - 1][1]));
            ctx.progress(pct, 100, `Downloading, ${pct}% done`);
          }
        },
      });
      await rename(part, final);
    } catch (err) {
      await rm(part, { force: true });
      if (err.exitCode != null) throw userError('The download failed. Check your internet connection and try again.', plainText(err.details));
      throw err;
    }
    ctx.finishMessage(`The ${name} model is ready. Reload the Speech to text page to use it.`);
  },
};
