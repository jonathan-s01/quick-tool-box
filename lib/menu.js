// Menu reader helpers: get a web page, turn HTML into plain text, ask the AI to sort a menu into
// categories and dishes, and write the simple HTML version.
import { access } from 'node:fs/promises';
import { which, run, userError, cancelledError } from './system.js';
import { esc } from './html.js';
import { chatJson } from './ollama.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** Finds a Chromium-based browser that can run without a window. */
export async function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const p = await which(name);
    if (p) return p;
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) {
    try { await access(p); return p; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Gets the HTML of a web page after its scripts have run (many restaurant sites build the menu with scripts).
 * Falls back to a plain download if no browser is installed.
 */
export async function fetchPage(url, { signal, workDir }) {
  const browser = await chromiumPath();
  if (browser) {
    const timeout = AbortSignal.timeout(90000);
    try {
      const { stdout } = await run(browser, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
        '--no-first-run', '--no-default-browser-check', `--user-data-dir=${workDir}/chromium-profile`,
        `--user-agent=${UA}`, '--virtual-time-budget=15000', '--dump-dom', url,
      ], { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (stdout.trim().length > 200) return { html: stdout, how: 'browser' };
    } catch (err) {
      if (signal?.aborted) throw cancelledError();
      // fall through to a plain download
    }
  }
  const res = await download(url, signal);
  const type = res.headers.get('content-type') || '';
  if (/pdf/i.test(type)) return { pdf: Buffer.from(await res.arrayBuffer()), how: 'download' };
  return { html: await res.text(), how: 'download' };
}

export async function download(url, signal) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/pdf,image/*,*/*' }, redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
  } catch (err) {
    if (signal?.aborted) throw cancelledError();
    throw userError(`Could not open ${url}. Check the address and that the server can reach the internet.`, String(err.cause || err));
  }
  if (!res.ok) throw userError(`The website answered with an error (${res.status}) for ${url}.`);
  return res;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ocirc: 'ô', icirc: 'î', ucirc: 'û', middot: '·', bull: '•', reg: '®', trade: '™', copy: '©', frac12: '½', deg: '°' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Turns web page HTML into plain text lines, and collects the title, PDF links and likely menu pictures. */
export function htmlToText(html, baseUrl) {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim());
  const ogSite = decodeEntities(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] || '');
  const links = [];
  const images = [];
  const abs = (href) => { try { return new URL(decodeEntities(href), baseUrl).href; } catch { return null; } };
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = abs(m[1]);
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (href && /\.pdf(\?|#|$)/i.test(href)) links.push({ href, text });
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc=["']([^"']+)["']/i.exec(m[0])?.[1];
    const alt = /\balt=["']([^"']*)["']/i.exec(m[0])?.[1] || '';
    const href = src && abs(src);
    if (href && /menu/i.test(`${src} ${alt}`) && !/\.svg(\?|$)/i.test(href)) images.push(href);
  }
  let body = html
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|dl|dt|dd|table|figure|figcaption|blockquote|nav|aside|main)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, '\t')
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean);
  // Drop lines repeated many times (menus, footers) after the first copy.
  const seen = new Map();
  const lines = [];
  for (const l of body) {
    const n = (seen.get(l) || 0) + 1;
    seen.set(l, n);
    if (n <= 2 || l.length > 60) lines.push(l);
  }
  return { title, site: ogSite, text: lines.join('\n'), pdfLinks: links, images: [...new Set(images)].slice(0, 8) };
}

/** Rough check: does this text look like it has a menu in it (several prices)? */
export function priceCount(text) {
  return (text.match(/(?:[$€£]\s?\d{1,3}(?:[.,]\d{2})?|\b\d{1,3}[.,]\d{2}\b|\b\d{1,3}\s?\$)/g) || []).length;
}

/** Splits long text into pieces on line breaks, so each fits in one AI request. */
export function chunkText(text, size = 3000) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > size && cur.length) {
      chunks.push(cur.join('\n'));
      cur = [];
      len = 0;
    }
    cur.push(l.slice(0, size));
    len += l.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

const MENU_SYSTEM = `You turn the text of a restaurant menu into structured data for a blind reader who wants to skim it quickly.
Rules:
- Copy dish names, prices and descriptions exactly as written. Fix only obvious OCR slips and ALL CAPS (use normal capitals).
- Never invent dishes, prices, descriptions or tags. Leave a field empty if the menu does not say it.
- Keep the menu's own categories and their order (for example Appetizers, Mains, Drinks). Dishes that come before any category heading go in a category with an empty name.
- price: as printed, including every size or option price, for example "Small $8, Large $12". Empty if there is no price.
- description: the dish description. Put add-ons and choices for the dish at the end of the description with their prices, for example "Add chicken $4".
- tags: dietary and spice markers only, such as Vegetarian, Vegan, Gluten free, Dairy free, Spicy, Contains nuts. Write them in words. If the menu uses symbols or letters (like V or GF) and explains them, use the explanation.
- Skip anything that is not a dish: opening hours, address, phone, ordering and delivery instructions, website navigation, social links, legal notes, allergy disclaimers.
- restaurant: the restaurant's name if the text shows it, otherwise empty.
Answer only with JSON.`;

const MENU_SCHEMA = {
  type: 'object',
  properties: {
    restaurant: { type: 'string' },
    categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                price: { type: 'string' },
                description: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['name', 'price', 'description', 'tags'],
            },
          },
        },
        required: ['name', 'items'],
      },
    },
  },
  required: ['restaurant', 'categories'],
};

/** Merges a new piece of menu into what we have so far. */
function mergeMenu(menu, part) {
  if (!part || !Array.isArray(part.categories)) return;
  if (!menu.restaurant && part.restaurant) menu.restaurant = String(part.restaurant).trim();
  for (const cat of part.categories) {
    const items = (cat.items || []).filter((i) => i && String(i.name || '').trim());
    if (!items.length) continue;
    const name = String(cat.name || '').trim();
    let target = name
      ? menu.categories.find((c) => c.name.toLowerCase() === name.toLowerCase())
      : menu.categories.at(-1); // dishes continuing from the previous piece
    if (!target) {
      target = { name, items: [] };
      menu.categories.push(target);
    }
    for (const i of items) {
      const dish = {
        name: String(i.name).trim(),
        price: String(i.price || '').trim(),
        description: String(i.description || '').trim(),
        tags: (Array.isArray(i.tags) ? i.tags : []).map((t) => String(t).trim()).filter(Boolean),
      };
      const dup = target.items.find((d) => d.name.toLowerCase() === dish.name.toLowerCase() && d.price === dish.price);
      if (!dup) target.items.push(dish);
    }
  }
}

/** Sends the menu text to the AI, piece by piece. */
export async function structureMenu(text, { model, thinking, signal, progress }) {
  const menu = { restaurant: '', categories: [] };
  const chunks = chunkText(text);
  for (const [i, chunk] of chunks.entries()) {
    progress?.(i, chunks.length, `AI is sorting part ${i + 1} of ${chunks.length} of the menu`);
    const prev = menu.categories.at(-1)?.name;
    const prompt = `${chunks.length > 1 ? `This is part ${i + 1} of ${chunks.length} of the menu.${prev ? ` The previous part ended in the category "${prev}".` : ''}\n\n` : ''}Menu text:\n\n${chunk}`;
    const part = await chatJson({ model, system: MENU_SYSTEM, prompt, schema: MENU_SCHEMA, signal, thinking });
    mergeMenu(menu, part);
  }
  return menu;
}

/** Reads a photo of a menu directly with a vision model. */
export async function structureMenuImage(imageBase64, { model, thinking, signal }) {
  const menu = { restaurant: '', categories: [] };
  const part = await chatJson({ model, system: MENU_SYSTEM, prompt: 'This picture is a page of a restaurant menu. Read every dish on it.', imageBase64, schema: MENU_SCHEMA, signal, thinking });
  mergeMenu(menu, part);
  return menu;
}

export function mergeInto(menu, part) {
  mergeMenu(menu, part);
}

/** One sentence piece, ending in a full stop so the screen reader pauses. */
function sentence(s) {
  const t = String(s).trim().replace(/[\s.;,:]+$/, '');
  return t ? `${t}.` : '';
}

export function dishCount(menu) {
  return menu.categories.reduce((n, c) => n + c.items.length, 0);
}

/** The simple menu page: h1 restaurant, h2 category, h3 dish, then one line with price, description and tags. */
export function renderMenu(menu, { source }) {
  const title = `${menu.restaurant || 'Restaurant'} menu`;
  const body = menu.categories.map((c) => {
    const dishes = c.items.map((d) => {
      const line = [sentence(d.price), sentence(d.description), ...d.tags.map(sentence)].filter(Boolean).join(' ');
      return `<h3>${esc(d.name)}</h3>\n${line ? `<p>${esc(line)}</p>\n` : ''}`;
    }).join('');
    return `${c.name ? `<h2>${esc(c.name)}</h2>\n` : (menu.categories.length > 1 ? '<h2>Other dishes</h2>\n' : '')}${dishes}`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; font-size: 1.125rem; line-height: 1.5; max-width: 42rem; margin: 0 auto; padding: 1rem; }
@media (prefers-color-scheme: dark) { body { background: #121212; color: #f2f2f2; } }
h2 { margin-top: 2rem; } h3 { margin: 1.25rem 0 0.25rem; font-size: 1.15rem; } p { margin: 0; }
.source { margin-top: 3rem; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${body}
<p class="source">${esc(source)}</p>
</body>
</html>
`;
}
