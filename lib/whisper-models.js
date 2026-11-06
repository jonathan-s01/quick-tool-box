// Where whisper.cpp model files live, and which ones can be downloaded.
import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

/** Models are kept outside the app folder so they survive app updates. */
export const MODELS_DIR = process.env.WHISPER_MODELS || path.join(os.homedir(), 'whisper-models');

export const MODEL_URL = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

// Listed from fastest and least accurate to slowest and most accurate.
export const KNOWN_MODELS = [
  { name: 'base.en', size: '142 MB', about: 'English only. Fast, fine for clear speech.' },
  { name: 'base', size: '142 MB', about: 'Many languages. Fast, fine for clear speech.' },
  { name: 'small.en', size: '466 MB', about: 'English only. Good balance of speed and accuracy.' },
  { name: 'small', size: '466 MB', about: 'Many languages. Good balance of speed and accuracy.' },
  { name: 'large-v3-turbo-q5_0', size: '547 MB', about: 'Many languages. Very accurate, a compressed copy of large-v3-turbo.' },
  { name: 'medium.en', size: '1.5 GB', about: 'English only. Accurate but slow.' },
  { name: 'large-v3-turbo', size: '1.5 GB', about: 'Many languages. Most accurate here. Slow without Apple Silicon.' },
];

/** Model names (like "base.en") that are downloaded and ready. */
export async function installedModels() {
  try {
    return (await readdir(MODELS_DIR))
      .filter((f) => /^ggml-.+\.bin$/.test(f))
      .map((f) => f.slice(5, -4))
      .sort((a, b) => {
        const ia = KNOWN_MODELS.findIndex((m) => m.name === a);
        const ib = KNOWN_MODELS.findIndex((m) => m.name === b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      });
  } catch {
    return [];
  }
}

export function modelLabel(name) {
  const known = KNOWN_MODELS.find((m) => m.name === name);
  return known ? `${name}: ${known.about}` : name;
}
