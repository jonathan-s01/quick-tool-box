// Finds which OCR languages Tesseract has installed. Shared by the OCR tools.
import { run } from './system.js';

export async function installedLanguages() {
  try {
    const { stdout, stderr } = await run('tesseract', ['--list-langs']);
    return new Set(`${stdout}\n${stderr}`.split('\n').slice(1).map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Builds the language dropdown and, if French is missing, a note on how to add it. */
export async function languageOption() {
  const langs = await installedLanguages();
  const choices = [];
  if (langs.has('eng') || !langs.size) choices.push({ value: 'eng', label: 'English' });
  if (langs.has('fra')) choices.push({ value: 'fra', label: 'French' }, { value: 'eng+fra', label: 'English and French' });
  const notes = [];
  if (langs.size && !langs.has('fra')) {
    notes.push({ what: 'French is not installed. To add French and other languages, run this command, then reload this page.', install: 'brew install tesseract-lang' });
  }
  return { option: { id: 'lang', type: 'select', label: 'Language of the text', choices, default: 'eng' }, notes };
}
