// English word list, used to judge AI clean-up changes. Uses the list built into macOS.
// It is only ever used to trust a fix more or less. It never forces a change by itself.
import { readFile } from 'node:fs/promises';

const DICT_FILE = process.env.DICT_FILE || '/usr/share/dict/words';
let loading = null;

/** Loads the word list once. Returns null if it is not available. */
export function loadDictionary() {
  loading ??= readFile(DICT_FILE, 'utf8')
    .then((text) => {
      const set = new Set();
      for (const w of text.split('\n')) if (w) set.add(w.trim().toLowerCase());
      return set.size > 1000 ? set : null;
    })
    .catch(() => null);
  return loading;
}

/** Removes quotes, brackets and punctuation around a word, and a possessive 's. */
export function bareWord(token) {
  return token
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/['’]s$/i, '')
    .toLowerCase();
}

// The macOS list is old and has few word endings (plurals, -ed, -ing), so also try removing them.
const ENDINGS = [
  ['ies', 'y'], ['ied', 'y'], ['ier', 'y'], ['iest', 'y'], ['ily', 'y'],
  ['es', ''], ['s', ''], ['ed', ''], ['ed', 'e'], ['d', ''], ['ing', ''], ['ing', 'e'],
  ['ly', ''], ['er', ''], ['er', 'e'], ['ers', ''], ['ers', 'e'], ['est', ''], ['ment', ''], ['ments', ''], ['ness', ''], ['ity', ''], ['ation', 'e'], ['ations', 'e'],
];

function knownBare(dict, w) {
  if (dict.has(w)) return true;
  for (const [end, add] of ENDINGS) {
    if (w.length > end.length + 2 && w.endsWith(end)) {
      const stem = w.slice(0, -end.length) + add;
      if (dict.has(stem)) return true;
      // Doubled last letter: "stopped" -> "stop", "running" -> "run".
      if (/(.)\1$/.test(stem) && dict.has(stem.slice(0, -1))) return true;
    }
  }
  return false;
}

/**
 * Is every word in this text in the dictionary?
 * Returns true, false, or null when there is nothing to check (numbers and symbols only).
 */
export function isKnown(dict, text) {
  const words = text.split(/\s+/).map(bareWord).filter((w) => /\p{L}/u.test(w));
  if (!words.length) return null;
  return words.every((w) => {
    if (/\d/.test(w)) return false; // letters mixed with digits, like 1t, are never dictionary words
    return w.split(/[-–]/).filter(Boolean).every((part) => knownBare(dict, part));
  });
}
