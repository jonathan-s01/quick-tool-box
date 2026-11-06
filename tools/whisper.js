// whisper.cpp: turns speech in an audio or video file into a transcript or captions.
import os from 'node:os';
import path from 'node:path';
import { which, missing, userError } from '../lib/system.js';
import { MODELS_DIR, installedModels, modelLabel } from '../lib/whisper-models.js';

async function whisperCommand() {
  // Homebrew's whisper-cpp installs "whisper-cli". Older versions used "whisper-cpp".
  for (const name of ['whisper-cli', 'whisper-cpp']) if (await which(name)) return name;
  return null;
}

const FORMATS = [
  { id: 'txt', label: 'Plain text transcript (.txt)', flag: '-otxt', ext: 'txt', default: true },
  { id: 'srt', label: 'SRT captions (.srt)', flag: '-osrt', ext: 'srt', default: true },
  { id: 'vtt', label: 'WebVTT captions (.vtt)', flag: '-ovtt', ext: 'vtt', default: false },
];

export default {
  id: 'whisper',
  name: 'Speech to text (Whisper)',
  summary: 'Make a transcript or captions from an audio or video file, using whisper.cpp. Everything runs on this computer.',
  submitLabel: 'Start transcribing',
  input: {
    label: 'Audio or video file',
    help: 'Most audio and video types work, such as MP3, M4A, WAV, MP4, MOV and WebM.',
    accept: 'audio/*,video/*,.m4a,.mp3,.wav,.aac,.flac,.ogg,.opus,.mp4,.mov,.m4v,.mkv,.webm,.avi',
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await whisperCommand())) result.missing.push(missing('whisper-cli', 'whisper.cpp is not installed.'));
    if (!(await which('ffmpeg'))) result.missing.push(missing('ffmpeg', 'ffmpeg is not installed. It is needed to read audio and video files.'));
    const models = await installedModels();
    if (!models.length) {
      result.missing.push({ what: `No speech models are downloaded yet. Use the "Whisper model download" tool to get one, or put ggml model files in ${MODELS_DIR}.`, install: null });
    }
    result.options.push(
      {
        id: 'model', type: 'select', label: 'Model',
        help: 'Larger models are more accurate but slower. Models ending in .en only understand English. To get more models, use the Whisper model download tool.',
        choices: models.map((m) => ({ value: m, label: modelLabel(m) })),
        default: models.includes('small.en') ? 'small.en' : models[0],
      },
      {
        id: 'lang', type: 'select', label: 'Spoken language', default: 'en',
        choices: [
          { value: 'en', label: 'English' },
          { value: 'fr', label: 'French' },
          { value: 'auto', label: 'Detect automatically' },
        ],
      },
      { id: 'translate', type: 'checkbox', label: 'Translate to English', help: 'Writes the transcript in English, whatever language is spoken. Needs a model without .en at the end.', default: false },
      ...FORMATS.map((f) => ({ id: f.id, type: 'checkbox', group: 'Files to make', label: f.label, default: f.default })),
    );
    return result;
  },

  validate(o) {
    if (!FORMATS.some((f) => o[f.id])) throw Object.assign(userError('Choose at least one file to make.'), { field: FORMATS[0].id });
    const englishOnly = o.model.endsWith('.en');
    if (englishOnly && o.lang !== 'en') throw Object.assign(userError(`The ${o.model} model only understands English. Choose English, or a model without .en at the end.`), { field: 'model' });
    if (englishOnly && o.translate) throw Object.assign(userError(`Translating needs a model without .en at the end. ${o.model} is English only.`), { field: 'model' });
  },

  async run(ctx) {
    const { input, options: o, workDir, outDir } = ctx;
    const cmd = await whisperCommand();

    // whisper.cpp needs 16 kHz mono WAV audio.
    ctx.progress(null, null, 'Preparing audio');
    const wav = path.join(workDir, 'audio.wav');
    try {
      await ctx.run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input.path, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    } catch (err) {
      if (err.exitCode != null) throw userError('Could not read any audio from this file.', err.details);
      throw err;
    }

    const outBase = path.join(outDir, input.base);
    const threads = String(Math.max(1, Math.min(8, os.availableParallelism())));
    const args = ['-m', path.join(MODELS_DIR, `ggml-${o.model}.bin`), '-f', wav, '-l', o.lang, '-t', threads, '-pp', '-of', outBase];
    if (o.translate) args.push('-tr');
    for (const f of FORMATS) if (o[f.id]) args.push(f.flag);

    ctx.progress(0, 100, 'Transcribing, 0% done');
    await ctx.run(cmd, args, {
      onStderr(chunk) {
        const all = [...chunk.matchAll(/progress\s*=\s*(\d+)%/g)];
        if (all.length) {
          const pct = Number(all[all.length - 1][1]);
          ctx.progress(pct, 100, `Transcribing, ${pct}% done`);
        }
      },
    });

    for (const f of FORMATS) {
      if (o[f.id]) ctx.output(`${outBase}.${f.ext}`, f.label.replace(/ \(.*\)$/, ''));
    }
  },
};
