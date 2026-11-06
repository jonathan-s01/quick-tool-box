// Letters and bills reader: turns a bill, statement or letter (PDF or photo) into an accessible page.
// Docling reads the layout and tables. A local AI model then writes a short summary at the top:
// who it is from, what it is about, amount owing, due date, account number and what you need to do.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { which } from '../lib/system.js';
import { plural } from '../lib/files.js';
import { renderDocling } from '../lib/docling-render.js';
import { esc } from '../lib/html.js';
import { textModels, chatJson, lastOllamaLabel, lastModelUsed } from '../lib/ollama.js';
import { doclingMode, doclingDocument } from './docling.js';
import { DOCLING_URL } from '../lib/docling-serve.js';

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['bill', 'statement', 'letter', 'notice', 'receipt', 'form', 'other'] },
    from: { type: 'string' },
    about: { type: 'string' },
    letterDate: { type: 'string' },
    amountDue: { type: 'string' },
    dueDate: { type: 'string' },
    accountNumber: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
    keyDates: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, what: { type: 'string' } }, required: ['date', 'what'] } },
    amounts: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'string' } }, required: ['label', 'amount'] } },
    contact: { type: 'string' },
  },
  required: ['kind', 'from', 'about', 'letterDate', 'amountDue', 'dueDate', 'accountNumber', 'actions', 'keyDates', 'amounts', 'contact'],
};

const SYSTEM = `You summarise a letter, bill or statement for a blind person, who will read your summary first and the full document after it.
Copy names, amounts, dates and account numbers exactly as they are written in the document. Never guess or calculate; if something is not in the document, use an empty string or an empty list.
kind: what sort of document it is.
from: the company, government office or person who sent it.
about: one plain sentence saying what it is about.
letterDate: the date of the letter or statement.
amountDue: the total amount the reader has to pay now, if any. dueDate: when it must be paid by.
accountNumber: the reader's account, customer, reference or file number.
actions: things the reader has to do, each as one short instruction starting with a verb, including deadlines. Do not include advertising.
keyDates: other important dates, such as a meter reading date or an appointment.
amounts: the main charges, credits and balances, up to 12, with the label used in the document.
contact: how to contact them about this document, such as a phone number.
Answer only with JSON.`;

const digits = (s) => String(s || '').replace(/[^0-9a-z]/gi, '').toLowerCase();

/** True when a value (for example an amount) appears in the document text. */
function inText(value, haystack) {
  const d = digits(value);
  return !d || haystack.includes(d);
}

function summaryHtml(sum, { model, where }, haystack) {
  const check = (v) => (inText(v, haystack) ? '' : ' (not found word for word in the document; check it)');
  const items = [];
  const add = (label, v, verify = false) => { if (v && String(v).trim()) items.push(`<li>${esc(label)}: ${esc(v)}${verify ? esc(check(v)) : ''}</li>`); };
  add('From', sum.from);
  add('About', sum.about);
  add('Amount owing', sum.amountDue, true);
  add('Due date', sum.dueDate, true);
  add('Account number', sum.accountNumber, true);
  add('Date of the document', sum.letterDate);
  add('Contact', sum.contact);
  const parts = [`<section aria-labelledby="summary-h">
<h2 id="summary-h">Summary</h2>
<p>Written by AI: ${esc(model)}, running on: ${esc(where)}. Check important numbers against the full document below.</p>
<ul>
${items.join('\n')}
</ul>`];
  if (sum.actions?.length) parts.push(`<h3>What you need to do</h3>\n<ul>\n${sum.actions.map((a) => `<li>${esc(a)}</li>`).join('\n')}\n</ul>`);
  if (sum.keyDates?.length) parts.push(`<h3>Other important dates</h3>\n<ul>\n${sum.keyDates.map((d) => `<li>${esc(d.date)}: ${esc(d.what)}</li>`).join('\n')}\n</ul>`);
  if (sum.amounts?.length) parts.push(`<h3>Amounts</h3>\n<ul>\n${sum.amounts.map((a) => `<li>${esc(a.label)}: ${esc(a.amount)}${esc(check(a.amount))}</li>`).join('\n')}\n</ul>`);
  parts.push('</section>');
  return parts.join('\n');
}

function summaryMd(sum) {
  const lines = ['## Summary', ''];
  for (const [label, v] of [['From', sum.from], ['About', sum.about], ['Amount owing', sum.amountDue], ['Due date', sum.dueDate], ['Account number', sum.accountNumber], ['Date of the document', sum.letterDate], ['Contact', sum.contact]]) {
    if (v) lines.push(`- ${label}: ${v}`);
  }
  if (sum.actions?.length) lines.push('', '### What you need to do', '', ...sum.actions.map((a) => `- ${a}`));
  return lines.join('\n');
}

function titleFor(sum, fallback) {
  if (!sum?.from) return fallback;
  const kind = { bill: 'Bill', statement: 'Statement', letter: 'Letter', notice: 'Notice', receipt: 'Receipt', form: 'Form' }[sum.kind] || 'Document';
  return `${kind} from ${sum.from}${sum.letterDate ? `, ${sum.letterDate}` : ''}`;
}

export default {
  id: 'letters',
  name: 'Letters and bills reader',
  summary: 'Turns a bill, statement or letter (a PDF or a photo) into a page you can browse by heading: a short summary at the top with who it is from, the amount owing, due date, account number and what you need to do, then the full document with real tables.',
  submitLabel: 'Read letter',
  input: {
    label: 'Letter, bill or statement',
    help: 'A PDF, or a photo or scan of a paper letter. For several photos of one letter, put them into one PDF first.',
    accept: '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.heic,.heif,application/pdf,image/*',
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    const mode = await doclingMode();
    if (!mode) result.missing.push({ what: `This needs Docling: either installed on this computer (see the Smart document reader) or the Docling server, which no answer came from at ${DOCLING_URL}. On the home server, start the docling service in docker-compose.yml.`, install: null });
    if (!(await which('magick'))) result.missing.push({ what: 'ImageMagick is needed for photos.', install: process.platform === 'darwin' ? 'brew install imagemagick' : 'apt install imagemagick' });
    const ai = await textModels();
    // Largest first, text-only models before vision models of a similar job.
    const models = [...(ai.models || [])].sort((a, b) => (a.vision - b.vision) || (b.size - a.size));
    if (!ai.running || !models.length) result.notes.push({ what: 'No AI model is available, so the summary at the top will be left out. The full document still works.', install: null });
    result.options.push(
      {
        id: 'lang', type: 'select', label: 'Language of the letter', default: 'en',
        choices: [{ value: 'en', label: 'English' }, { value: 'fr', label: 'French' }, { value: 'en+fr', label: 'English and French' }],
      },
      {
        id: 'model', type: 'select', allowAny: true, label: 'AI model for the summary', default: models.length ? models[0].name : 'off',
        help: 'Bigger models make fewer mistakes. The largest one available is chosen by default.',
        choices: [...models.map((m) => ({ value: m.name, label: `${m.name}${m.size ? `, ${(m.size / 1e9).toFixed(1)} GB` : ''}` })), { value: 'off', label: 'No summary' }],
      },
    );
    return result;
  },

  async run(ctx) {
    const { input, options: o, outDir } = ctx;
    const { doc, pages } = await doclingDocument(ctx, input.path, { lang: o.lang, tables: 'accurate' });
    const plain = renderDocling(doc, { name: input.base, lang: 'en', footnotes: 'inline', pageMarks: pages > 1, joinWords: true });

    let sum = null;
    let where = '';
    if (o.model && o.model !== 'off') {
      ctx.progress(null, null, 'Writing the summary');
      const info = (await textModels()).models.find((m) => m.name === o.model);
      const text = plain.markdown.slice(0, 24000);
      sum = await chatJson({ model: o.model, system: SYSTEM, prompt: `The document:\n\n${text}`, schema: SCHEMA, signal: ctx.signal, thinking: info?.thinking });
      where = lastOllamaLabel();
      if (!sum) ctx.progress(null, null, 'The AI answer could not be read, so there is no summary');
    }

    ctx.progress(null, null, 'Writing the page');
    const haystack = digits(plain.markdown);
    const title = titleFor(sum, input.base);
    const { html, markdown, stats } = renderDocling(doc, {
      name: input.base,
      title,
      lang: o.lang === 'fr' ? 'fr' : 'en',
      footnotes: 'inline',
      pageMarks: pages > 1,
      joinWords: true,
      headingShift: 1,
      bodyHeading: 'Full document',
      prepend: sum ? summaryHtml(sum, { model: lastModelUsed() || o.model, where }, haystack) : '',
      prependMd: sum ? summaryMd(sum) : '',
    });
    const htmlPath = path.join(outDir, `${input.base}.html`);
    const mdPath = path.join(outDir, `${input.base}.md`);
    await writeFile(htmlPath, html);
    await writeFile(mdPath, markdown);
    ctx.output(htmlPath, 'Accessible page');
    ctx.output(mdPath, 'Markdown');
    const bits = [`${title}.`];
    if (sum?.amountDue) bits.push(`Amount owing ${sum.amountDue}${sum.dueDate ? `, due ${sum.dueDate}` : ''}.`);
    if (sum?.actions?.length) bits.push(`${plural(sum.actions.length, 'thing')} to do.`);
    bits.push(`${plural(pages, 'page')}, ${plural(stats.tables, 'table')}.`);
    ctx.finishMessage(bits.join(' '));
  },
};
