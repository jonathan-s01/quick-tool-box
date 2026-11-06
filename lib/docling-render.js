// Turns Docling's JSON (a DoclingDocument) into accessible HTML and Markdown.
// Docling finds the layout: reading order, paragraphs, headings, lists and tables.
// This file adds what Docling leaves out or gets wrong for reading:
// - joins paragraphs split across columns, pages and figures, and words split across lines
// - removes repeated page headers and footers, and stops small or long text being used as a heading
// - works out heading levels (if Docling did not) from numbering and size
// - builds a table of contents from the top third of the heading levels
// - writes real table markup with header cells
import { esc } from './html.js';

const TERMINAL = /[.!?:;…"”’)\]]$/;
const TOP_WORDS = /^(abstract|summary|introduction|background|conclusions?|discussion|results|methods?|methodology|references|bibliography|works cited|acknowledge?ments?|appendix|appendices|keywords|contents|preface|foreword|notes|endnotes|glossary|index|résumé|conclusion|bibliographie|remerciements|annexes?)\b/i;

// ---------- Reading the Docling document ----------

function resolver(doc) {
  return (ref) => {
    const m = /^#\/(\w+)\/(\d+)$/.exec(ref?.$ref || ref || '');
    if (!m) return null;
    return doc[m[1]]?.[Number(m[2])] || null;
  };
}

function prov(item) {
  const p = item?.prov?.[0];
  return p ? { page: p.page_no, bbox: p.bbox } : { page: null, bbox: null };
}

/** Height of a box in page units, and whether it sits near the top or bottom edge of its page. */
function geometry(doc, item) {
  const { page, bbox } = prov(item);
  if (!bbox) return { page, height: null, edge: null };
  const pageH = doc.pages?.[String(page)]?.size?.height || null;
  const top = bbox.coord_origin === 'TOPLEFT' ? bbox.t : pageH != null ? pageH - bbox.t : null;
  const bottom = bbox.coord_origin === 'TOPLEFT' ? bbox.b : pageH != null ? pageH - bbox.b : null;
  const height = Math.abs(bbox.t - bbox.b);
  let edge = null;
  if (pageH && top != null && bottom != null) {
    if (bottom > pageH * 0.94) edge = 'bottom';
    else if (top < pageH * 0.06) edge = 'top';
  }
  return { page, height, edge, width: Math.abs(bbox.r - bbox.l) };
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Joins words broken with a hyphen at the end of a line ("infor- mation" becomes "information"). */
function joinBrokenWords(s) {
  return s.replace(/(\p{Ll})[-\u00ad] (\p{Ll})/gu, '$1$2').replace(/\u00ad/g, '');
}

function tableModel(item, resolve) {
  const data = item.data || {};
  const rows = data.num_rows || 0;
  const cols = data.num_cols || 0;
  if (!rows || !cols || !data.table_cells?.length) return null;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(null));
  for (const c of data.table_cells) {
    const r0 = c.start_row_offset_idx ?? 0;
    const c0 = c.start_col_offset_idx ?? 0;
    const r1 = Math.max(r0 + 1, c.end_row_offset_idx ?? r0 + 1);
    const c1 = Math.max(c0 + 1, c.end_col_offset_idx ?? c0 + 1);
    if (r0 >= rows || c0 >= cols || grid[r0][c0]) continue;
    const cell = {
      text: cleanText(c.text),
      rowspan: Math.min(r1, rows) - r0,
      colspan: Math.min(c1, cols) - c0,
      colHeader: Boolean(c.column_header),
      rowHeader: Boolean(c.row_header),
    };
    for (let r = r0; r < Math.min(r1, rows); r++) {
      for (let k = c0; k < Math.min(c1, cols); k++) grid[r][k] = r === r0 && k === c0 ? cell : 'covered';
    }
  }
  // Header rows are the rows at the top where every cell is a column header.
  let headRows = 0;
  while (headRows < rows && grid[headRows].every((c) => c === 'covered' || c?.colHeader)) headRows++;
  if (headRows === rows) headRows = 0;
  const caption = (item.captions || []).map((r) => cleanText(resolve(r)?.text)).filter(Boolean).join(' ');
  const notes = (item.footnotes || []).map((r) => cleanText(resolve(r)?.text)).filter(Boolean);
  return { grid, headRows, caption, notes };
}

/**
 * Walks the document in reading order and returns a flat list of blocks.
 * options.keepFurniture: keep page headers and footers.
 */
function collectBlocks(doc, options) {
  const resolve = resolver(doc);
  const owned = new Set(); // captions and notes that belong to a table or figure
  for (const item of [...(doc.tables || []), ...(doc.pictures || [])]) {
    for (const r of [...(item.captions || []), ...(item.footnotes || [])]) owned.add(r.$ref);
  }
  const seen = new Set();
  const blocks = [];

  const isBody = (item) => (item.content_layer || 'body') === 'body';

  function textOf(item) {
    let t = cleanText(item.text);
    if (item.label === 'list_item' && item.marker && t.startsWith(item.marker)) t = t.slice(item.marker.length).trim();
    return t;
  }

  function listBlock(group) {
    const items = [];
    let ordered = group.label === 'ordered_list';
    let allEnumerated = true;
    for (const ref of group.children || []) {
      const child = resolve(ref);
      if (!child || seen.has(child.self_ref)) continue;
      if (child.self_ref) seen.add(child.self_ref);
      if (child.label === 'list' || child.label === 'ordered_list') {
        const nested = listBlock(child);
        if (items.length) items[items.length - 1].nested.push(nested);
        else items.push({ text: '', nested: [nested], ref: null });
        continue;
      }
      if (!isBody(child)) continue;
      if (!child.enumerated) allEnumerated = false;
      const entry = { text: textOf(child), nested: [], ref: child.self_ref, page: prov(child).page };
      for (const sub of child.children || []) {
        const s = resolve(sub);
        if (s && (s.label === 'list' || s.label === 'ordered_list')) {
          seen.add(s.self_ref);
          entry.nested.push(listBlock(s));
        }
      }
      items.push(entry);
    }
    if (items.length && allEnumerated) ordered = true;
    return { type: 'list', ordered, items, page: items.find((i) => i.page)?.page ?? null };
  }

  function visit(ref) {
    const item = resolve(ref);
    if (!item || seen.has(item.self_ref)) return;
    seen.add(item.self_ref);
    if (owned.has(item.self_ref)) return;

    // Groups: lists become lists, "inline" groups become one paragraph, others are just walked.
    if (item.self_ref?.startsWith('#/groups/')) {
      if (item.label === 'list' || item.label === 'ordered_list') {
        const list = listBlock(item);
        if (list.items.length) blocks.push(list);
        return;
      }
      if (item.label === 'inline') {
        const parts = (item.children || []).map((r) => resolve(r)).filter(Boolean);
        parts.forEach((p) => seen.add(p.self_ref));
        const text = cleanText(parts.map((p) => p.text).join(' '));
        const g = geometry(doc, parts[0]);
        if (text) blocks.push({ type: 'p', label: 'text', text, page: g.page, refs: parts.map((p) => p.self_ref) });
        return;
      }
      for (const c of item.children || []) visit(c);
      return;
    }

    const g = geometry(doc, item);
    const furniture = !isBody(item) || item.label === 'page_header' || item.label === 'page_footer';
    if (furniture && !options.keepFurniture) return;

    if (item.self_ref?.startsWith('#/tables/')) {
      const model = tableModel(item, resolve);
      blocks.push(model ? { type: 'table', ...model, page: g.page } : { type: 'note', text: 'A table here could not be read.', page: g.page });
      return;
    }
    if (item.self_ref?.startsWith('#/pictures/')) {
      const caption = (item.captions || []).map((r) => cleanText(resolve(r)?.text)).filter(Boolean).join(' ');
      blocks.push({ type: 'figure', caption, page: g.page });
      return;
    }

    const text = textOf(item);
    switch (item.label) {
      case 'title':
        if (text) blocks.push({ type: 'heading', title: true, text, page: g.page, height: g.height, edge: g.edge, dlLevel: 0, ref: item.self_ref });
        break;
      case 'section_header':
        if (text) blocks.push({ type: 'heading', text, page: g.page, height: g.height, edge: g.edge, dlLevel: item.level || 1, ref: item.self_ref });
        break;
      case 'footnote':
        if (text) blocks.push({ type: 'footnote', text, page: g.page, ref: item.self_ref });
        break;
      case 'code':
        if (text) blocks.push({ type: 'code', text: item.text || '', page: g.page });
        break;
      case 'formula':
        blocks.push({ type: 'formula', text, page: g.page });
        break;
      case 'list_item':
        if (text) blocks.push({ type: 'list', ordered: Boolean(item.enumerated), items: [{ text, nested: [], ref: item.self_ref }], page: g.page });
        break;
      case 'checkbox_selected':
      case 'checkbox_unselected':
        blocks.push({ type: 'p', label: 'text', text: `${item.label === 'checkbox_selected' ? '[Checked]' : '[Not checked]'} ${text}`, page: g.page, refs: [item.self_ref] });
        break;
      default:
        if (text) {
          blocks.push({
            type: 'p',
            label: furniture ? 'furniture' : item.label === 'caption' ? 'caption' : 'text',
            text,
            page: g.page,
            edge: g.edge,
            refs: [item.self_ref],
          });
        }
    }
    // Some documents nest content under headings; walk any children too.
    if (!item.self_ref?.startsWith('#/tables/') && !item.self_ref?.startsWith('#/pictures/')) {
      for (const c of item.children || []) visit(c);
    }
  }

  for (const c of doc.body?.children || []) visit(c);
  if (options.keepFurniture) for (const c of doc.furniture?.children || []) visit(c);
  return blocks;
}

// ---------- Fixing the structure ----------

/** Removes short text that repeats on 3 or more pages: running heads, journal names, page footers. */
function removeRunningText(blocks) {
  const norm = (t) => t.toLowerCase().replace(/[\d\s.,:;|•·–—-]+/g, ' ').trim();
  const pagesFor = new Map();
  for (const b of blocks) {
    if ((b.type !== 'p' && b.type !== 'heading') || !b.page || b.text.length > 150) continue;
    const key = norm(b.text);
    if (key.length < 3) continue;
    if (!pagesFor.has(key)) pagesFor.set(key, new Set());
    pagesFor.get(key).add(b.page);
  }
  let removed = 0;
  const out = blocks.filter((b) => {
    if ((b.type !== 'p' && b.type !== 'heading') || b.text.length > 150) return true;
    const pages = pagesFor.get(norm(b.text));
    if (pages && pages.size >= 3 && b.label !== 'furniture') {
      removed++;
      return false;
    }
    // Lone page numbers, such as "12" or "Page 12" or "iv".
    if (b.type === 'p' && /^(page\s*)?(\d{1,4}|[ivxlc]{1,6})(\s*(of|\/)\s*\d+)?$/i.test(b.text) && b.label !== 'caption') {
      removed++;
      return false;
    }
    return true;
  });
  return { blocks: out, removed };
}

function numbering(text) {
  let m;
  if ((m = /^(part|chapter|chapitre|partie)\s+([\divxlc]+|[a-z]+)\b/i.exec(text))) return { kind: 'chapter', depth: 1 };
  if ((m = /^(\d{1,2}(?:\.\d{1,2})*)\.?(?=\s|$)/.exec(text))) return { kind: 'arabic', depth: m[1].split('.').length };
  if ((m = /^([IVXLC]{1,6})[.)](?=\s|$)/.exec(text)) || (m = /^([IVXLC]{2,6})(?=\s)/.exec(text))) return { kind: 'roman', depth: 1 };
  if ((m = /^(?:appendix|annexe?)\s+([A-Z])(?:\.(\d+(?:\.\d+)*))?/i.exec(text))) return { kind: 'alpha', depth: 1 + (m[2] ? m[2].split('.').length : 0) };
  if ((m = /^([A-Z])((?:\.\d{1,2})+)\.?(?=\s)/.exec(text))) return { kind: 'alpha', depth: 1 + m[2].split('.').length - 1 };
  if ((m = /^([A-Z])[.)](?=\s)/.exec(text))) return { kind: 'alpha', depth: 1 };
  if ((m = /^\(?([a-z]|[ivx]{1,4})\)(?=\s)/.exec(text))) return { kind: 'sub', depth: null };
  return null;
}

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

/** Turns headings that are not really headings back into paragraphs, and sets a level (1 = top section) on the rest. */
function fixHeadings(blocks, { docHasLevels }) {
  let demoted = 0;
  const words = (t) => t.split(/\s+/).length;
  for (const b of blocks) {
    if (b.type !== 'heading' || b.title) continue;
    const num = numbering(b.text);
    const tooLong = words(b.text) > 20 || b.text.length > 200;
    const sentence = /[.!?]$/.test(b.text) && words(b.text) > 10 && !num;
    const footer = b.edge === 'bottom';
    const noLetters = !/\p{L}{2,}/u.test(b.text);
    if (tooLong || sentence || footer || noLetters) {
      b.type = 'p';
      b.label = 'text';
      b.refs = [b.ref];
      demoted++;
    }
  }

  const titles = blocks.filter((b) => b.type === 'heading' && b.title);
  titles.slice(1).forEach((b) => { b.title = false; b.dlLevel = 1; });
  const heads = blocks.filter((b) => b.type === 'heading' && !b.title);
  if (!heads.length) return { demoted, source: 'none' };

  // 1. Docling worked the levels out (from bookmarks, numbering or font size): use them.
  const dlLevels = new Set(heads.map((h) => h.dlLevel));
  if (docHasLevels && dlLevels.size > 1) {
    heads.forEach((h) => { h.level = h.dlLevel; });
    return { demoted, source: 'docling' };
  }

  // 2. Numbering, such as 2, 2.1, 2.1.3, IV., Appendix A.
  const nums = heads.map((h) => numbering(h.text));
  const hasRoman = nums.some((n) => n?.kind === 'roman');
  const hasNumbers = nums.some((n) => n && n.depth);
  const sizeOfTop = median(heads.filter((h, i) => nums[i] && nums[i].depth === 1).map((h) => h.height));

  // 3. Size, for headings without numbers: bigger text means a higher level.
  const unnumbered = heads.filter((h, i) => !nums[i] || !nums[i].depth).map((h) => h.height).filter((x) => x);
  const sizeGroups = [];
  for (const hgt of [...unnumbered].sort((a, b) => b - a)) {
    if (!sizeGroups.length || hgt < sizeGroups[sizeGroups.length - 1] * 0.9) sizeGroups.push(hgt);
  }
  const sizeLevel = (hgt) => {
    if (!hgt || !sizeGroups.length) return 1;
    let best = 0;
    sizeGroups.forEach((g, i) => { if (Math.abs(g - hgt) < Math.abs(sizeGroups[best] - hgt)) best = i; });
    return Math.min(best + 1, 4);
  };

  let last = 1;
  heads.forEach((h, i) => {
    const n = nums[i];
    if (n?.depth) {
      h.level = n.kind === 'arabic' && hasRoman ? n.depth + 1 : n.depth;
    } else if (n?.kind === 'sub') {
      h.level = last + 1;
    } else if (TOP_WORDS.test(h.text)) {
      h.level = 1;
    } else if (hasNumbers) {
      h.level = sizeOfTop && h.height && h.height >= sizeOfTop * 0.92 ? 1 : last + 1;
    } else {
      h.level = sizeLevel(h.height);
    }
    h.level = Math.max(1, Math.min(h.level, 5));
    if (n?.depth || TOP_WORDS.test(h.text)) last = h.level;
  });
  return { demoted, source: hasNumbers ? 'numbering' : 'size' };
}

/**
 * Joins paragraphs that were split by a column break, a page break, or a figure or table in the middle.
 * A paragraph is joined to the next one when it does not end a sentence and the next starts in lower case.
 */
function joinParagraphs(blocks, { joinWords, pageMarks }) {
  const out = [];
  let lastP = null; // the last paragraph, if only figures, tables or footnotes came after it
  for (const b of blocks) {
    if (b.type === 'p' && b.label === 'text') {
      if (joinWords) b.text = joinBrokenWords(b.text);
      const prev = lastP;
      const continues = prev && !TERMINAL.test(prev.text) && /^[\p{Ll}(]/u.test(b.text);
      if (continues) {
        const hyphen = /\p{Ll}-$/u.test(prev.text) && joinWords;
        const mark = pageMarks && b.page && prev.lastPage && b.page !== prev.lastPage ? ` [Page ${b.page}]` : '';
        prev.text = hyphen ? `${prev.text.slice(0, -1)}${mark ? `${mark} ` : ''}${b.text}` : `${prev.text}${mark} ${b.text}`;
        prev.refs = [...(prev.refs || []), ...(b.refs || [])];
        prev.lastPage = b.page || prev.lastPage;
        continue;
      }
      b.lastPage = b.page;
      out.push(b);
      lastP = b;
      continue;
    }
    out.push(b);
    if (!['figure', 'table', 'footnote', 'note'].includes(b.type) && !(b.type === 'p' && b.label === 'caption')) lastP = null;
  }
  return out;
}

// ---------- Writing HTML ----------

function tableHtml(t) {
  const cell = (c, inHead) => {
    if (c === 'covered') return '';
    if (!c) return inHead ? '<th></th>' : '<td></td>';
    const span = `${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}`;
    if (inHead || c.colHeader) return `<th scope="${c.colspan > 1 ? 'colgroup' : 'col'}"${span}>${esc(c.text)}</th>`;
    if (c.rowHeader) return `<th scope="${c.rowspan > 1 ? 'rowgroup' : 'row'}"${span}>${esc(c.text)}</th>`;
    return `<td${span}>${esc(c.text)}</td>`;
  };
  const rows = (from, to, inHead) => t.grid.slice(from, to).map((r) => `<tr>${r.map((c) => cell(c, inHead)).join('')}</tr>`).join('\n');
  const head = t.headRows ? `<thead>\n${rows(0, t.headRows, true)}\n</thead>\n` : '';
  const notes = t.notes.length ? `\n${t.notes.map((n) => `<p class="table-note">${esc(n)}</p>`).join('\n')}` : '';
  return `<table>\n${t.caption ? `<caption>${esc(t.caption)}</caption>\n` : ''}${head}<tbody>\n${rows(t.headRows, t.grid.length, false)}\n</tbody>\n</table>${notes}`;
}

function listHtml(l) {
  const tag = l.ordered ? 'ol' : 'ul';
  return `<${tag}>\n${l.items.map((i) => `<li>${esc(i.text)}${i.nested.map(listHtml).join('')}</li>`).join('\n')}\n</${tag}>`;
}

function tocHtml(heads) {
  const levels = [...new Set(heads.map((h) => h.level))].sort((a, b) => a - b);
  const keep = new Set(levels.slice(0, Math.max(1, Math.ceil(levels.length / 3))));
  const entries = heads.filter((h) => keep.has(h.level));
  if (entries.length < 3) return '';
  // Build nested lists by level.
  let html = '';
  const stack = [];
  for (const h of entries) {
    while (stack.length && stack[stack.length - 1] > h.level) { html += '</li></ol>'; stack.pop(); }
    if (stack.length && stack[stack.length - 1] === h.level) html += '</li>';
    else if (!stack.length || stack[stack.length - 1] < h.level) { html += '<ol>'; stack.push(h.level); }
    html += `<li><a href="#${h.id}">${esc(h.text)}</a>`;
  }
  while (stack.length) { html += '</li></ol>'; stack.pop(); }
  return `<nav aria-labelledby="toc-h">\n<h2 id="toc-h">Contents</h2>\n${html}\n</nav>`;
}

/**
 * Builds the reading version of a Docling document.
 * options: { name, lang, keepFurniture, footnotes: 'end' | 'inline', pageMarks, joinWords }
 * Returns { html, markdown, stats }.
 */
export function renderDocling(doc, options) {
  let blocks = collectBlocks(doc, options);
  const running = removeRunningText(blocks);
  blocks = running.blocks;
  const headingInfo = fixHeadings(blocks, { docHasLevels: Boolean(doc._wrapper?.heading_levels) });
  blocks = joinParagraphs(blocks, options);

  // Footnotes at the end, if asked.
  const footnotes = [];
  if (options.footnotes === 'end') {
    blocks = blocks.filter((b) => {
      if (b.type !== 'footnote') return true;
      footnotes.push(b);
      return false;
    });
  }

  const titleBlock = blocks.find((b) => b.type === 'heading' && b.title);
  const title = options.title || titleBlock?.text || options.name;
  const heads = blocks.filter((b) => b.type === 'heading' && !b.title);
  // Levels: 1 = h2 (h1 is the document title). Never skip a level going down.
  const minLevel = Math.min(...heads.map((h) => h.level), 99);
  if (minLevel > 1 && minLevel < 99) heads.forEach((h) => { h.level -= minLevel - 1; });
  let prevLevel = 0;
  heads.forEach((h, i) => {
    h.id = `h${i + 1}`;
    if (h.level > prevLevel + 1) h.level = prevLevel + 1;
    prevLevel = h.level;
  });

  const body = [];
  const md = [`# ${title}`, '', ...(options.prependMd ? [options.prependMd, ''] : [])];
  let page = null;
  const pageMark = (p) => {
    // Only mark forward moves: a figure placed after text from the next page should not jump back.
    if (!options.pageMarks || !p || (page !== null && p <= page)) return;
    if (page !== null) {
      body.push(`<p class="page">[Page ${p}]</p>`);
      md.push(`[Page ${p}]`, '');
    }
    page = p;
  };
  for (const b of blocks) {
    if (b === titleBlock && !options.title) { page = b.page; continue; }
    if (b === titleBlock) { b.level = 1; b.id = b.id || 'doc-title'; }
    pageMark(b.page);
    switch (b.type) {
      case 'heading': {
        const n = Math.min(b.level + 1 + (options.headingShift || 0), 6);
        body.push(`<h${n} id="${b.id}">${esc(b.text)}</h${n}>`);
        md.push(`${'#'.repeat(n)} ${b.text}`, '');
        break;
      }
      case 'p':
        body.push(b.label === 'caption' ? `<p class="caption">${esc(b.text)}</p>` : `<p>${esc(b.text)}</p>`);
        md.push(b.text, '');
        if (b.lastPage && options.pageMarks) page = b.lastPage; // the paragraph already marked its page breaks
        break;
      case 'list':
        body.push(listHtml(b));
        md.push(...b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${it.text}`), '');
        break;
      case 'table':
        body.push(tableHtml(b));
        if (b.caption) md.push(`Table: ${b.caption}`, '');
        md.push(...b.grid.map((r, ri) => {
          const line = `| ${r.map((c) => (c && c !== 'covered' ? c.text.replace(/\|/g, '\\|') : '')).join(' | ')} |`;
          return ri === Math.max(0, b.headRows - 1) && b.headRows ? `${line}\n|${r.map(() => ' --- ').join('|')}|` : line;
        }), '');
        break;
      case 'figure':
        body.push(b.caption ? `<figure>\n<p>[Figure]</p>\n<figcaption>${esc(b.caption)}</figcaption>\n</figure>` : `<p>[Figure${b.page ? ` on page ${b.page}` : ''}]</p>`);
        md.push(b.caption ? `[Figure] ${b.caption}` : '[Figure]', '');
        break;
      case 'code':
        body.push(`<pre><code>${esc(b.text)}</code></pre>`);
        md.push('```', b.text, '```', '');
        break;
      case 'formula':
        body.push(`<p class="formula">[Formula]${b.text ? ` ${esc(b.text)}` : ''}</p>`);
        md.push(`[Formula]${b.text ? ` ${b.text}` : ''}`, '');
        break;
      case 'footnote':
        body.push(`<aside aria-label="Footnote"><p class="footnote">${esc(b.text)}</p></aside>`);
        md.push(`> ${b.text}`, '');
        break;
      default:
        body.push(`<p>${esc(b.text)}</p>`);
        md.push(b.text, '');
    }
  }
  if (footnotes.length) {
    body.push('<h2 id="footnotes">Footnotes</h2>');
    body.push(`<ol class="footnotes">\n${footnotes.map((f) => `<li>${f.page ? `Page ${f.page}: ` : ''}${esc(f.text)}</li>`).join('\n')}\n</ol>`);
    md.push('## Footnotes', '', ...footnotes.map((f) => `- ${f.page ? `Page ${f.page}: ` : ''}${f.text}`), '');
  }

  const toc = tocHtml(heads);
  const html = `<!doctype html>
<html lang="${esc(options.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { font-family: system-ui, sans-serif; font-size: 1.125rem; line-height: 1.6; max-width: 72ch; margin: 2rem auto; padding: 0 1rem; }
p { margin: 0 0 1em; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #888; padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; }
caption { text-align: left; font-weight: 600; padding-bottom: 0.25rem; }
.page { color: #555; font-size: 0.9em; }
.caption, .table-note, .footnote { font-size: 0.95em; }
nav ol { padding-left: 1.5rem; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${options.prepend || ''}
${toc}
${options.bodyHeading ? `<h2 id="document">${esc(options.bodyHeading)}</h2>` : ''}
${body.join('\n')}
</main>
</body>
</html>
`;
  return {
    html,
    markdown: md.join('\n').replace(/\n{3,}/g, '\n\n'),
    stats: {
      headings: heads.length,
      headingSource: headingInfo.source,
      demoted: headingInfo.demoted,
      removed: running.removed,
      tables: blocks.filter((b) => b.type === 'table').length,
      paragraphs: blocks.filter((b) => b.type === 'p').length,
    },
  };
}

/** Text items that the AI clean-up can check, with where they are on the page. */
export function cleanupChunks(doc) {
  const out = [];
  const labels = new Set(['text', 'paragraph', 'section_header', 'title', 'list_item', 'caption', 'footnote', 'reference']);
  for (const t of doc.texts || []) {
    if (!labels.has(t.label) || (t.content_layer || 'body') !== 'body') continue;
    const p = t.prov?.[0];
    if (!p?.bbox) continue;
    out.push({ id: t.self_ref, page: p.page_no, bbox: p.bbox, text: cleanText(t.text), label: t.label });
  }
  return out;
}

/** Puts AI-corrected text back into the document before it is rendered. */
export function applyCleanup(doc, texts) {
  for (const t of doc.texts || []) {
    if (texts.has(t.self_ref)) t.text = texts.get(t.self_ref);
  }
}
