// Menu reader: turns a messy online menu, a PDF menu or a photo of a printed menu into a simple page.
// h1 restaurant name, h2 category, h3 dish, then one line: price. description. tags.
import path from 'node:path';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { which, userError } from '../lib/system.js';
import { sniff, plural } from '../lib/files.js';
import { textModels, ollamaMissingNote, noModelNote, aiImageSize } from '../lib/ollama.js';
import { chromiumPath, fetchPage, download, htmlToText, priceCount, structureMenu, structureMenuImage, mergeInto, renderMenu, dishCount } from '../lib/menu.js';
import { saveMenu, slug } from '../lib/menu-library.js';

const IMAGE = /^\.(png|jpe?g|tiff?|bmp|webp|gif|heic|heif)$/i;

/** Text from a PDF menu: its text layer, or OCR if it is a scan. */
async function pdfText(ctx, file) {
  const { stdout } = await ctx.run('pdftotext', ['-layout', file, '-']);
  if (stdout.replace(/\s/g, '').length > 80) return stdout;
  ctx.progress(null, null, 'The PDF is a scan. Reading it with OCR');
  const dir = path.join(ctx.workDir, `pages-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await ctx.run('pdftoppm', ['-r', '300', '-png', file, path.join(dir, 'p')]);
  const pages = (await readdir(dir)).filter((n) => n.endsWith('.png')).sort();
  const parts = [];
  for (const [i, pg] of pages.entries()) {
    ctx.progress(i, pages.length, `Reading page ${i + 1} of ${pages.length}`);
    parts.push(await ocrImage(ctx, path.join(dir, pg)));
  }
  return parts.join('\n\n');
}

async function ocrImage(ctx, file) {
  const { stdout } = await ctx.run('tesseract', [file, '-', '-l', ctx.options.lang || 'eng', '--psm', '3']);
  return stdout;
}

/** Makes a smaller JPEG for the vision model, as base64. */
async function imageForAi(ctx, file) {
  const out = path.join(ctx.workDir, `ai-${Date.now()}.jpg`);
  const px = await aiImageSize({ text: true });
  await ctx.run('magick', [file, '-auto-orient', '-resize', `${px}x${px}>`, '-quality', '88', out]);
  return (await readFile(out)).toString('base64');
}

export default {
  id: 'menu',
  name: 'Menu reader',
  summary: 'Turns a restaurant menu from a web page, a PDF or a photo into a simple page you can skim by heading: the restaurant, then each category, then each dish with its price, description and tags. Menus can be saved to your menu library.',
  submitLabel: 'Read menu',
  input: {
    label: 'Menu file',
    optional: true,
    help: 'A PDF, a photo of a printed menu, or a saved web page. Leave this empty if you give a web address below.',
    accept: '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp,.heic,.heif,.html,.htm,application/pdf,image/*,text/html',
  },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    const ai = await textModels();
    if (!ai.running) result.missing.push(ollamaMissingNote('The menu reader'));
    else if (!ai.models.length) result.missing.push(noModelNote('The menu reader'));
    const [pdftotext, tesseract, magick, browser] = await Promise.all([which('pdftotext'), which('tesseract'), which('magick'), chromiumPath()]);
    if (!pdftotext) result.notes.push({ what: 'PDF menus need Poppler.', install: process.platform === 'darwin' ? 'brew install poppler' : 'apt install poppler-utils' });
    if (!tesseract) result.notes.push({ what: 'Photos and scanned menus need Tesseract OCR, unless you use a vision model.', install: process.platform === 'darwin' ? 'brew install tesseract' : 'apt install tesseract-ocr' });
    if (!browser) result.notes.push({ what: 'Many restaurant websites build their menu with scripts. Without Chrome or Chromium, those pages may come back empty.', install: process.platform === 'darwin' ? 'brew install --cask google-chrome' : 'apt install chromium' });
    const models = ai.models || [];
    const vision = models.filter((m) => m.vision);
    result.options.push(
      { id: 'url', type: 'url', label: 'Web address of the menu', optional: true, help: 'For example https://example.com/menu. Leave empty if you chose a file above.' },
      { id: 'name', type: 'text', label: 'Restaurant name', optional: true, maxLength: 120, help: 'Leave empty to use the name found on the menu.' },
      {
        id: 'model', type: 'select', allowAny: true, label: 'AI model', default: models[0]?.name || '',
        help: 'Sorts the menu into categories and dishes. Smaller models are faster. Runs on your own computer or server.',
        choices: models.length ? models.map((m) => ({ value: m.name, label: `${m.name}${m.vision ? ' (can read pictures)' : ''}` })) : [{ value: '', label: 'No models found' }],
      },
      {
        id: 'photo', type: 'select', label: 'For photos of menus', default: 'ocr',
        help: 'Tesseract is fast. A vision model looks at the picture itself, which copes better with columns and fancy fonts, but is slower.',
        choices: [
          { value: 'ocr', label: 'Read the text with Tesseract, then sort it with the AI model' },
          ...(vision.length ? [{ value: 'vision', label: 'Let the AI model look at the photo (the model must be able to read pictures)' }] : []),
        ],
      },
      { id: 'lang', type: 'select', label: 'Language of the menu, for photos', default: 'eng', choices: [{ value: 'eng', label: 'English' }, { value: 'fra', label: 'French' }, { value: 'eng+fra', label: 'English and French' }] },
      { id: 'save', type: 'checkbox', label: 'Save to my menu library', default: true },
    );
    return result;
  },

  async validate(o, upload) {
    if (!o.url && !upload) {
      const err = userError('Choose a menu file or type a web address.');
      err.field = 'file';
      throw err;
    }
  },

  async run(ctx) {
    const { input, options: o, outDir, workDir } = ctx;
    // If the chosen model has gone (for example the Mac went to sleep), the AI layer picks another.
    const { models } = await textModels();
    const info = models.find((m) => m.name === o.model) || { name: o.model, vision: models.some((m) => m.vision) };
    const ai = { model: o.model, signal: ctx.signal, progress: ctx.progress };
    let text = '';
    let title = '';
    let source = '';
    const photos = [];

    if (input) {
      source = `From the file ${input.name}.`;
      const kind = await sniff(input.path);
      if (kind === 'pdf') {
        ctx.progress(null, null, 'Reading the PDF');
        text = await pdfText(ctx, input.path);
      } else if (IMAGE.test(input.ext)) {
        photos.push(input.path);
      } else {
        const page = htmlToText(await readFile(input.path, 'utf8'), 'https://example.invalid/');
        text = page.text;
        title = page.site || page.title;
      }
    } else {
      source = `From ${o.url}`;
      ctx.progress(null, null, 'Opening the web page');
      const page = await fetchPage(o.url, { signal: ctx.signal, workDir });
      if (page.pdf) {
        const file = path.join(workDir, 'menu.pdf');
        await writeFile(file, page.pdf);
        text = await pdfText(ctx, file);
      } else {
        const parsed = htmlToText(page.html, o.url);
        text = parsed.text;
        title = parsed.site || parsed.title.split(/\s[|\-–—]\s/)[0];
        // Many sites only link to a PDF menu, or show the menu as pictures.
        if (priceCount(text) < 5) {
          const pdfLink = parsed.pdfLinks.find((l) => /menu|carte|food|drink|dinner|lunch|brunch/i.test(`${l.href} ${l.text}`)) || parsed.pdfLinks[0];
          if (pdfLink) {
            ctx.progress(null, null, 'Getting the PDF menu linked from the page');
            const file = path.join(workDir, 'menu.pdf');
            await writeFile(file, Buffer.from(await (await download(pdfLink.href, ctx.signal)).arrayBuffer()));
            if ((await sniff(file)) === 'pdf') {
              text = await pdfText(ctx, file);
              source += ` (PDF menu: ${pdfLink.href})`;
            }
          } else if (parsed.images.length) {
            for (const [i, img] of parsed.images.entries()) {
              ctx.progress(i, parsed.images.length, 'Getting the menu pictures from the page');
              const file = path.join(workDir, `img-${i}`);
              await writeFile(file, Buffer.from(await (await download(img, ctx.signal)).arrayBuffer()));
              photos.push(file);
            }
          }
        }
      }
    }

    let menu = { restaurant: '', categories: [] };
    if (photos.length) {
      for (const [i, file] of photos.entries()) {
        ctx.progress(i, photos.length, `Reading picture ${i + 1} of ${photos.length}`);
        if (o.photo === 'vision' && info.vision) {
          mergeInto(menu, await structureMenuImage(await imageForAi(ctx, file), ai));
        } else {
          const png = path.join(workDir, `photo-${i}.png`);
          await ctx.run('magick', [file, '-auto-orient', '-colorspace', 'Gray', png]);
          text += `\n\n${await ocrImage(ctx, png)}`;
        }
      }
    }
    if (text.trim()) {
      mergeInto(menu, await structureMenu(text, ai));
    }
    const dishes = dishCount(menu);
    if (!dishes) throw userError('No dishes could be found. If this is a web page, the menu may be in a picture or behind a button; try downloading the menu as a PDF or taking a screenshot of it.');

    menu.restaurant = o.name || menu.restaurant || title || '';
    const html = renderMenu(menu, { source });
    const name = menu.restaurant || 'Restaurant';
    const file = path.join(outDir, `${slug(name)}-menu.html`);
    await writeFile(file, html);
    ctx.output(file, 'Menu');
    if (o.save) {
      const entry = await saveMenu({ name: `${name} menu`, source: o.url || input?.name || '', html, dishes });
      ctx.link(`/menus/${entry.id}`, `Open ${name} menu in your menu library`);
    }
    ctx.finishMessage(`${name} menu: ${plural(menu.categories.length, 'category', 'categories')}, ${plural(dishes, 'dish', 'dishes')}.${o.save ? ' Saved to your menu library.' : ''}`);
  },
};
