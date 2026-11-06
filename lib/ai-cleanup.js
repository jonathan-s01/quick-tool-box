// AI clean-up of OCR text. Each paragraph is sent to a local vision model (Ollama or llama.cpp)
// together with a picture of that part of the page, so the model checks against what is printed.
// The model's answer is never trusted blindly: it is compared word by word with the original,
// and only changes that look like OCR fixes are applied. Everything else is listed as a suggestion.
import { visionModels, chatJson, ollamaMissingNote, noModelNote } from './ollama.js';
import { pool, userError } from './system.js';
import { wordChanges, changeRatio, similarity, applyChanges, context, tokens } from './text-diff.js';
import { esc } from './html.js';
import { loadDictionary, isKnown, bareWord } from './dictionary.js';
import { plural } from './files.js';

export const STRICTNESS = [
  { value: '1', label: '1: Very technical (code, formulas, data). Only fix obvious mistakes in ordinary words' },
  { value: '2', label: '2' },
  { value: '3', label: '3: Technical, many numbers, names and symbols' },
  { value: '4', label: '4' },
  { value: '5', label: '5: Mixed. Mostly prose with some numbers, names and references' },
  { value: '6', label: '6' },
  { value: '7', label: '7: Mostly prose' },
  { value: '8', label: '8' },
  { value: '9', label: '9' },
  { value: '10', label: '10: Plain prose only. Fix anything that is not a normal word' },
];


/** Options and notes to add to a tool's setup. */
export async function aiSetup({ group = 'AI clean-up' } = {}) {
  const notes = [];
  const options = [];
  const { running, models } = await visionModels();
  if (!running) {
    notes.push(ollamaMissingNote('AI clean-up'));
    return { options, notes };
  }
  if (!models.length) {
    notes.push(noModelNote('AI clean-up', true));
    return { options, notes };
  }
  options.push(
    {
      id: 'aiModel', type: 'select', allowAny: true, group, label: 'Model', default: 'off',
      help: 'Checks each paragraph against a picture of the page and fixes OCR mistakes, such as 1 read instead of l. Runs on this Mac. Adds a few seconds per paragraph.',
      choices: [{ value: 'off', label: 'Off' }, ...models.map((m) => ({ value: m.name, label: `On, using ${m.name}` }))],
    },
    {
      id: 'aiStrictness', type: 'select', group, label: 'What kind of text is it', default: '7',
      help: 'Higher numbers let the AI fix more. Lower numbers make it leave unusual words, codes and symbols alone. For English, changes are also checked against the dictionary built into macOS. Every change is listed in a separate report.',
      choices: STRICTNESS,
    },
  );
  return { options, notes };
}

function strictnessText(s) {
  if (s <= 2) return 'This is very technical text with code, formulas, identifiers or data. Only fix ordinary words that are clearly misread. Leave every number, code, symbol, name, abbreviation and unusual spelling exactly as it is.';
  if (s <= 4) return 'This is technical text with many numbers, names, references and symbols. Fix clearly misread ordinary words. Only change numbers, symbols or names when the image clearly shows something different.';
  if (s <= 6) return 'This is mostly prose with some numbers, names and references. Fix misread words and stray symbols. Change numbers or names only when the image clearly shows something different.';
  if (s <= 8) return 'This is mostly ordinary prose. Fix misread words, stray symbols and broken words.';
  return 'This is plain prose. Every word should be a normal word: fix anything that is not, and remove stray symbols that are not part of the text.';
}

const SYSTEM = `You correct OCR errors. You get a picture of part of a printed page and the OCR text of that part.
Return the OCR text with OCR mistakes fixed so it matches what is printed in the picture.
OCR mistakes include: wrong look-alike characters (1 for l or I, 0 for O, rn for m, cl for d), stray symbols or specks read as characters, missing or extra spaces inside or between words, and broken accents.
Rules:
- Do not rephrase, reorder, summarise, translate or shorten anything.
- Do not fix the author's own spelling, grammar, punctuation style or word choice.
- Do not add text that is not in the OCR text, except to complete a word that is clearly cut off.
- Keep the same language.
- If you are not sure, leave the text as it is.
Answer only with JSON: {"text": "<corrected text>"}.`;

const SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };

function looksLikeCode(t) {
  return (/\d/.test(t) && !/\p{L}{3,}/u.test(t)) || /[_=<>{}\\|^~]/.test(t);
}

/** True if before and after only differ by characters OCR often mixes up, such as 1 and l, 0 and O, rn and m. */
function lookAlikeOnly(before, after) {
  const norm = (t) => t
    .replace(/[1lIi|!]/g, 'l').replace(/[0Oo]/g, 'o').replace(/[5Ss]/g, 's').replace(/[8B]/g, 'b')
    .replace(/rn/g, 'm').replace(/cl/g, 'd').replace(/vv/g, 'w')
    .toLowerCase();
  return before !== after && norm(before) === norm(after);
}

// Tesseract confidence (0 to 100) below which a word is treated as probably misread, and above which it is treated as sure.
export const LOW_CONF = 75;
export const HIGH_CONF = 92;

/** How sure the OCR was about the words a change touches: 'low', 'mid', 'high', or null if unknown. */
function confidenceOf(chunk, change) {
  if (!chunk.conf) return null;
  const n = Math.max(1, tokens(change.before).length);
  const values = chunk.conf.slice(change.at, change.at + n).filter((c) => c != null);
  if (!values.length) return null;
  const min = Math.min(...values);
  return min < LOW_CONF ? 'low' : min >= HIGH_CONF ? 'high' : 'mid';
}

const sameLetters = (a, b) => a.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() === b.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/**
 * Decides whether one of the model's word changes is applied.
 * Returns { ok, why } for rejected changes, or { ok, note } with a short reason for the report.
 * dict is the English word list, or null when it is not available or the text is not English.
 */
export function judge(change, s, { dict, conf }) {
  const { before, after } = change;
  if (!before && after) return { ok: false, why: 'The AI added words that were not in the OCR text.' };
  if (before && !after) {
    if (/[\p{L}\p{N}]/u.test(before)) return { ok: false, why: 'The AI removed words.' };
    return s >= 3 ? { ok: true, note: 'Removed a stray symbol.' } : { ok: false, why: 'Removes a symbol, and the strictness setting leaves symbols alone.' };
  }
  // A number that turns into a different number is the most harmful mistake an AI can make, so it needs the highest settings.
  const digitsBefore = before.replace(/\D/g, '');
  const digitsAfter = after.replace(/\D/g, '');
  if (digitsBefore && digitsAfter && digitsBefore !== digitsAfter && !lookAlikeOnly(before, after) && s < 9) {
    return { ok: false, why: 'Changes a number. Only allowed at strictness 9 or 10.' };
  }
  const plainWord = /^[\p{L}'’-]+[.,;:!?)"”’]*$/u.test(after);
  const lookAlike = lookAlikeOnly(before, after);
  if (s <= 3 && looksLikeCode(before) && !(plainWord && lookAlike)) {
    return { ok: false, why: 'Looks like a number, code or symbol, and the strictness setting leaves those alone.' };
  }
  const unsure = conf === 'low' ? ' The OCR was unsure about this word.' : '';
  const sim = Math.max(similarity(before, after), similarity(before.replace(/\s/g, ''), after.replace(/\s/g, '')));
  let minSim = 0.65 - 0.035 * (s - 1);
  if (conf === 'low') minSim -= 0.15;

  // Only punctuation or capital letters changed.
  if (sameLetters(before, after)) {
    if (conf === 'high' && s < 9) return { ok: false, why: 'Only changes spacing, punctuation or capitals, and the OCR was sure about this word.' };
    return { ok: true, note: `Spacing, punctuation or capitals.${unsure}` };
  }

  // ALL CAPS or mixed capitals (TCP, mRNA, iPhone) usually means an abbreviation or term, not a misread word.
  const bare = before.replace(/[^\p{L}]/gu, '');
  const abbreviation = bare.length >= 2 && (/^\p{Lu}+$/u.test(bare) || /\p{Ll}\p{Lu}/u.test(bare));
  if (abbreviation && !lookAlike && conf !== 'low' && s < 9) {
    return { ok: false, why: 'Looks like an abbreviation or term. Only changed if the OCR was unsure about it, or at strictness 9 or 10.' };
  }

  const kb = dict ? isKnown(dict, before) : null;
  const ka = dict ? isKnown(dict, after) : null;

  if (dict && kb === false && ka === true) {
    // Not a word becomes a word: the strongest sign of a real OCR fix.
    if (lookAlike) return { ok: true, note: `Look-alike letters. Now a dictionary word.${unsure}` };
    // Technical terms and abbreviations (mRNA, TCP) are often not in the dictionary but look close to a word, so low settings need more evidence.
    if (s <= 3 && conf !== 'low') return { ok: false, why: 'Not a dictionary word, but it could be a technical term or abbreviation, so it is left alone at this strictness unless the OCR was unsure.' };
    if (conf === 'high' && s < 7) return { ok: false, why: 'The OCR was sure about this word. Allowed at strictness 7 or higher.' };
    const bonus = s >= 7 || conf === 'low' ? 0.15 : 0;
    if (sim < minSim - bonus) return { ok: false, why: 'Too different from the original to be an OCR fix, even though the result is a dictionary word.' };
    return { ok: true, note: `Now a dictionary word.${unsure}` };
  }
  if (dict && kb === true && ka === true) {
    // A real word becomes another real word, like form to from. OCR does this, but so does an AI "improving" the author.
    const singleLetter = bareWord(before).length === 1 && bareWord(after).length === 1;
    if (conf === 'high') return { ok: false, why: 'Changes one real word into another, and the OCR was sure about the original.' };
    const needed = lookAlike ? (singleLetter ? 3 : 5) : conf === 'low' ? 5 : 8;
    if (s < needed) {
      const kind = lookAlike ? ' using look-alike letters' : conf === 'low' ? ', where the OCR was unsure' : '';
      return { ok: false, why: `Changes one real word into another${kind}. Allowed at strictness ${needed} or higher${!lookAlike && conf !== 'low' ? ', or 5 if the OCR was unsure' : ''}.` };
    }
    if (!lookAlike && sim < minSim) return { ok: false, why: 'Too different from the original to be an OCR fix.' };
    return { ok: true, note: `${lookAlike ? 'Look-alike letters. ' : ''}One real word to another.${unsure}` };
  }
  if (dict && kb === true && ka === false) {
    return { ok: false, why: 'Would turn a dictionary word into one that is not in the dictionary.' };
  }
  if (dict && kb === false && ka === false) {
    // Neither is in the dictionary: names, jargon, chemical names. Be careful.
    if (conf === 'high' && !(lookAlike && s >= 7)) return { ok: false, why: 'Not a dictionary word (could be a name or technical term), and the OCR was sure about it.' };
    if (s <= 5 && conf !== 'low' && !lookAlike) return { ok: false, why: 'Not a dictionary word (could be a name or technical term), so it is left alone at this strictness.' };
  }

  // No dictionary help: the original rules, made stricter for words the OCR was sure about.
  if (lookAlike) {
    if (conf === 'high' && s < 7) return { ok: false, why: 'The OCR was sure about this word.' };
    return { ok: true, note: `Look-alike letters.${unsure}` };
  }
  if (conf === 'high' && s < 9) return { ok: false, why: 'The OCR was sure about this word.' };
  if (sim < minSim) return { ok: false, why: 'Too different from the original to be an OCR fix.' };
  return { ok: true, note: unsure.trim() || undefined };
}

/** Splits a change like "TCP form" to "TOP from" into one change per word, so each word is judged on its own. */
function splitChanges(changes) {
  const out = [];
  for (const c of changes) {
    const b = tokens(c.before);
    const a = tokens(c.after);
    if (b.length > 1 && b.length === a.length) {
      b.forEach((w, i) => { if (w !== a[i]) out.push({ before: w, after: a[i], at: c.at + i }); });
    } else {
      out.push(c);
    }
  }
  return out;
}

/** Tells the model which words the OCR was unsure about, so it looks at those most carefully. */
function unsureHint(chunk) {
  if (!chunk.conf) return '';
  const words = [...new Set(tokens(chunk.text).filter((w, i) => chunk.conf[i] != null && chunk.conf[i] < LOW_CONF))].slice(0, 30);
  if (!words.length) return '\nThe OCR was confident about every word in this text, so only change something if the picture clearly shows a mistake.';
  return `\nThe OCR was unsure about these words, so check them most carefully against the picture: ${words.map((w) => `"${w}"`).join(', ')}. Other words were read with more confidence.`;
}

/**
 * Cleans a list of chunks: [{ id, page, text, label }].
 * crop(chunk) must return a base64 PNG of the chunk's area of the page, or null.
 * Returns { texts: Map(id -> new text), report }.
 */
export async function cleanChunks(ctx, chunks, { model, strictness, crop, english = false }) {
  const s = Number(strictness);
  const dict = english ? await loadDictionary() : null;
  const { models } = await visionModels();
  // If the chosen model is gone (for example the Mac went to sleep), chatJson uses the best one available.
  const info = models.find((m) => m.name === model) || models.at(-1);
  if (!info) throw userError('No AI model that can see pictures is available now. Check the Status page.');

  const todo = chunks.filter((c) => (c.text.match(/\p{L}/gu) || []).length >= 2 && c.text.length <= 6000);
  const texts = new Map();
  const report = { model, strictness: s, dictionary: Boolean(dict), english, confidence: chunks.some((c) => c.conf), checked: 0, skipped: chunks.length - todo.length, failed: [], applied: [], suggested: [] };
  let done = 0;
  ctx.progress(0, todo.length, `AI clean-up: 0 of ${plural(todo.length, 'paragraph')} checked`);

  await pool(todo, 2, async (chunk) => {
    const image = await crop(chunk);
    let answer = null;
    if (image) {
      answer = await chatJson({
        model,
        thinking: info.thinking,
        system: SYSTEM,
        prompt: `${strictnessText(s)}${unsureHint(chunk)}\n\nOCR text:\n<<<\n${chunk.text}\n>>>`,
        imageBase64: image,
        schema: SCHEMA,
        signal: ctx.signal,
      });
    }
    done += 1;
    ctx.progress(done, todo.length, `AI clean-up: ${done} of ${plural(todo.length, 'paragraph')} checked`);
    if (!answer || typeof answer.text !== 'string' || !answer.text.trim()) {
      report.failed.push(chunk);
      return;
    }
    report.checked += 1;
    const proposed = answer.text.replace(/\s+/g, ' ').trim();
    const original = tokens(chunk.text).join(' ');
    const changes = splitChanges(wordChanges(original, proposed));
    if (!changes.length) return;

    if (changeRatio(original, changes) > 0.5 + 0.02 * s) {
      report.suggested.push({ chunk, changes, why: 'The AI changed too much of this paragraph, so none of its changes were used.' });
      return;
    }
    const good = [];
    const rejected = [];
    for (const c of changes) {
      const verdict = judge(c, s, { dict, conf: confidenceOf(chunk, c) });
      if (verdict.ok) good.push(verdict.note ? { ...c, note: verdict.note } : c);
      else rejected.push({ ...c, why: verdict.why });
    }
    if (good.length) {
      texts.set(chunk.id, applyChanges(original, good));
      report.applied.push({ chunk, original, changes: good });
    }
    if (rejected.length) report.suggested.push({ chunk, original, changes: rejected });
  }, ctx.signal);

  return { texts, report };
}

function changeItem(original, c) {
  const { pre, post } = context(original, c);
  const what = !c.after ? `Removed “${esc(c.before)}”` : !c.before ? `Added “${esc(c.after)}”` : `“${esc(c.before)}” changed to “${esc(c.after)}”`;
  const where = `${pre ? `${esc(pre)} ` : ''}[${c.before ? esc(c.before) : 'added here'}]${post ? ` ${esc(post)}` : ''}`;
  return `<li>${what}. In: ${where}${c.note ? `<br>Why: ${esc(c.note)}` : ''}${c.why ? `<br>Not applied: ${esc(c.why)}` : ''}</li>`;
}

function byPage(entries) {
  const pages = new Map();
  for (const e of entries) {
    const p = e.chunk.page ?? 0;
    if (!pages.has(p)) pages.set(p, []);
    pages.get(p).push(e);
  }
  return [...pages].sort((a, b) => a[0] - b[0]);
}

function section(entries, idPrefix) {
  return byPage(entries).map(([page, list]) => {
    const items = list.map((e) => {
      const original = e.original || tokens(e.chunk.text).join(' ');
      if (!e.why) return e.changes.map((c) => changeItem(original, c)).join('\n');
      // Whole paragraph rejected: one item with the reason, and its suggestions nested inside.
      const start = tokens(original).slice(0, 8).join(' ');
      return `<li>Paragraph starting “${esc(start)}…”. ${esc(e.why)}\n<ul>\n${e.changes.map((c) => changeItem(original, c)).join('\n')}\n</ul></li>`;
    }).join('\n');
    const count = list.reduce((n, e) => n + e.changes.length, 0);
    return `<h3 id="${idPrefix}-p${page}">${page ? `Page ${page}` : 'Document'} (${plural(count, 'change')})</h3>\n<ol>\n${items}\n</ol>`;
  }).join('\n');
}

/** The separate changes report, as an HTML page with headings per page. */
export function reportHtml(report, fileName) {
  const appliedCount = report.applied.reduce((n, e) => n + e.changes.length, 0);
  const suggestedCount = report.suggested.reduce((n, e) => n + e.changes.length, 0);
  const title = `AI clean-up report: ${fileName}`;
  const failed = report.failed.length
    ? `<h2>Paragraphs the AI could not check (${report.failed.length})</h2>
<p>These were left exactly as the OCR read them.</p>
<ol>${report.failed.map((c) => `<li>${c.page ? `Page ${c.page}: ` : ''}${esc(tokens(c.text).slice(0, 12).join(' '))}…</li>`).join('')}</ol>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { font-family: system-ui, sans-serif; font-size: 1.125rem; line-height: 1.5; max-width: 75ch; margin: 2rem auto; padding: 0 1rem; }
li { margin: 0.5rem 0; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p>Model: ${esc(report.model)}. Strictness: ${report.strictness} of 10. ${plural(report.checked, 'paragraph')} checked. ${plural(appliedCount, 'change')} made in ${plural(report.applied.length, 'paragraph')}. ${plural(suggestedCount, 'suggestion')} not applied.${report.skipped ? ` ${plural(report.skipped, 'short or empty item')} skipped.` : ''}</p>
<p>${report.dictionary ? 'Changes were checked against the English dictionary built into macOS.' : report.english ? 'The English dictionary built into macOS was not found, so changes were judged without it.' : 'The dictionary check only works for English, so it was not used.'} ${report.confidence ? 'Words the OCR was unsure about could be changed more freely than words it was sure about.' : 'The OCR did not say how sure it was about each word, so all words were treated the same.'}</p>
<p>Each change shows the words around it, with the original OCR text in square brackets.</p>
<h2>Changes made (${appliedCount})</h2>
${appliedCount ? section(report.applied, 'a') : '<p>None.</p>'}
<h2>Suggestions not applied (${suggestedCount})</h2>
<p>The AI suggested these, but they did not look like OCR fixes, so the original text was kept.</p>
${suggestedCount ? section(report.suggested, 's') : '<p>None.</p>'}
${failed}
</main>
</body>
</html>
`;
}
