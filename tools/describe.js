// Image description: a local vision model describes a photo or screenshot, copies any text in it,
// and answers your questions about it. After the first answer you can keep asking questions.
// Everything stays on your own computers (the Mac first if it is awake, otherwise the server).
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { which, userError } from '../lib/system.js';
import { esc } from '../lib/html.js';
import { visionModels, chatJson, aiImageSize, lastOllamaLabel, lastModelUsed, ollamaMissingNote, noModelNote } from '../lib/ollama.js';

const SCHEMA = {
  type: 'object',
  properties: { description: { type: 'string' }, text: { type: 'string' }, answer: { type: 'string' } },
  required: ['description', 'text', 'answer'],
};

const SYSTEM = `You describe images for a blind person.
description: describe what is in the image. Start with one sentence saying what kind of image it is (photo, screenshot, document, sign, chart and so on) and its main subject. Then describe the important details in a sensible order. Be concrete: colours, positions, people's expressions and actions, any warnings or error messages. Do not guess things you cannot see, and do not say "the image shows" over and over.
text: copy every piece of readable text in the image, exactly, in reading order, one item per line. Empty if there is none.
answer: if the person asked a question, answer it directly and honestly, saying if the image does not show enough to be sure. Empty if there was no question.
Answer only with JSON.`;

const FOLLOW_SYSTEM = `You answer questions about an image for a blind person. You described it earlier; the conversation so far is given.
answer: answer the new question directly and honestly, saying if the image does not show enough to be sure.
description and text: leave empty unless the question asks you to describe again or read text again.
Answer only with JSON.`;

function pageHtml(state) {
  const qa = state.history.filter((h) => h.question);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Image description: ${esc(state.name)}</title>
<style>body { font-family: system-ui, sans-serif; font-size: 1.125rem; line-height: 1.6; max-width: 72ch; margin: 2rem auto; padding: 0 1rem; } @media (prefers-color-scheme: dark) { body { background: #121212; color: #f2f2f2; } }</style>
</head>
<body>
<main>
<h1>Image description: ${esc(state.name)}</h1>
<p>Described by ${esc(state.model)}, running on: ${esc(state.where)}. AI can be wrong, especially about small text and people.</p>
<h2>Description</h2>
${state.description.split(/\n+/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('\n')}
<h2>Text in the image</h2>
${state.text.trim() ? `<ul>\n${state.text.split(/\n+/).filter((l) => l.trim()).map((l) => `<li>${esc(l.trim())}</li>`).join('\n')}\n</ul>` : '<p>No readable text was found.</p>'}
${qa.length ? `<h2>Questions and answers</h2>\n${qa.map((h) => `<h3>${esc(h.question)}</h3>\n${h.answer.split(/\n+/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('\n')}`).join('\n')}` : ''}
</main>
</body>
</html>
`;
}

function reviewData() {
  return {
    heading: 'Ask about this image',
    intro: 'Type a question and choose Ask. The answer appears above, and is added to the description page.',
    groups: [],
    extraLabel: 'Your question',
    extraRequired: true,
    extraHelp: 'For example: what does the error message say? Is there a total at the bottom? What colour is the shirt?',
    submitLabel: 'Ask',
  };
}

async function write(ctx, state) {
  const out = path.join(ctx.outDir, `${state.base}-description.html`);
  await writeFile(out, pageHtml(state));
  ctx.output(out, 'Description page');
}

export default {
  id: 'describe',
  name: 'Describe an image',
  summary: 'A local AI model describes a photo or screenshot, copies any text in it, and answers your questions about it. You can keep asking follow-up questions.',
  submitLabel: 'Describe image',
  input: {
    label: 'Image',
    help: 'A photo or screenshot: JPEG, PNG, HEIC, WebP and others.',
    accept: 'image/*,.heic,.heif',
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    const vm = await visionModels();
    if (!vm.running) result.missing.push(ollamaMissingNote('Image description'));
    else if (!vm.models.length) result.missing.push(noModelNote('Image description', true));
    if (!(await which('magick'))) result.missing.push({ what: 'ImageMagick is needed.', install: process.platform === 'darwin' ? 'brew install imagemagick' : 'apt install imagemagick' });
    const models = vm.models || [];
    result.options.push(
      { id: 'question', type: 'textarea', label: 'Question about the image', optional: true, rows: 3, maxLength: 2000, help: 'Leave empty for a general description. You can ask more questions afterwards.' },
      {
        id: 'detail', type: 'select', label: 'Description length', default: 'normal',
        choices: [{ value: 'short', label: 'Short, a few sentences' }, { value: 'normal', label: 'Normal' }, { value: 'long', label: 'Detailed' }],
      },
      {
        id: 'model', type: 'select', allowAny: true, label: 'AI model', default: models.length ? models[models.length - 1].name : '',
        help: 'The largest one available is chosen by default. Bigger is more accurate but slower.',
        choices: models.length ? [...models].reverse().map((m) => ({ value: m.name, label: `${m.name}${m.size ? `, ${(m.size / 1e9).toFixed(1)} GB` : ''}` })) : [{ value: '', label: 'No models' }],
      },
    );
    return result;
  },

  async run(ctx) {
    const { input, options: o, workDir } = ctx;
    ctx.progress(null, null, 'Preparing the image');
    const jpg = path.join(workDir, 'image.jpg');
    try {
      const px = await aiImageSize();
      await ctx.run('magick', [`${input.path}[0]`, '-auto-orient', '-resize', `${px}x${px}>`, '-quality', '88', jpg]);
    } catch (err) {
      throw userError('This image could not be opened. If it is a HEIC photo, try converting it to JPEG first.', err.details);
    }
    const image = (await readFile(jpg)).toString('base64');
    const info = (await visionModels()).models.find((m) => m.name === o.model);
    const length = { short: 'Keep the description to 2 or 3 sentences.', normal: 'Keep the description to one or two short paragraphs.', long: 'Give a thorough description, several paragraphs if needed.' }[o.detail];
    ctx.progress(null, null, 'Looking at the image. The first time a model is used, loading it can take a minute.');
    const ans = await chatJson({
      model: o.model, system: `${SYSTEM}\n${length}`, imageBase64: image, schema: SCHEMA, signal: ctx.signal, thinking: info?.thinking,
      prompt: o.question.trim() ? `My question: ${o.question.trim()}` : 'Describe this image. I have no question.',
    });
    if (!ans) throw userError('The AI answer could not be read. Try again, or choose another model.');
    const state = {
      name: input.name, base: input.base, model: lastModelUsed() || o.model, where: lastOllamaLabel(), image, thinking: info?.thinking,
      description: ans.description || '', text: ans.text || '',
      history: o.question.trim() ? [{ question: o.question.trim(), answer: ans.answer || '' }] : [],
    };
    await write(ctx, state);
    ctx.finishMessage(o.question.trim() && ans.answer ? `Answer: ${ans.answer} Description: ${ans.description}` : ans.description);
    ctx.review(reviewData(), state);
  },

  async continue(ctx, state, choices) {
    const question = choices.extra.trim();
    const convo = state.history.map((h) => `Question: ${h.question}\nYour answer: ${h.answer}`).join('\n\n');
    ctx.progress(null, null, 'Thinking about your question');
    const ans = await chatJson({
      model: state.model, system: FOLLOW_SYSTEM, imageBase64: state.image, schema: SCHEMA, signal: ctx.signal, thinking: state.thinking,
      prompt: `Your earlier description: ${state.description}\n\nText you read in the image: ${state.text || '(none)'}\n\n${convo ? `${convo}\n\n` : ''}New question: ${question}`,
    });
    if (!ans) throw userError('The AI answer could not be read. Try asking again.');
    const next = { ...state, model: lastModelUsed() || state.model, where: lastOllamaLabel(), history: [...state.history, { question, answer: ans.answer || '' }] };
    await write(ctx, next);
    ctx.finishMessage(`Answer: ${ans.answer}`);
    ctx.review(reviewData(), next);
  },
};
