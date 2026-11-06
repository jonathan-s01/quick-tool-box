// Find in a document: search a PDF (or scan, photo, Word file) for a line number, an amount or words,
// and get back the whole row it is on, with the amount next to it.
//
// How it works: every word on a page (and every filled-in form field) has a position. Words whose
// vertical middles line up are one row. Inside a row, a wide gap or a run of leader dots (.......)
// starts a new cell. So "Total income ........ 15000   54,321 | 00" becomes the cells
// "Total income", "15000", "54,321.00".
//
// Search modes (you can switch on the search page):
//   auto    tries every mode below and lists the best answers first
//   lines   tax-return style: label, line number and amount on one line
//   boxes   slip style (T4, T5, receipts): a box number with the amount beside it, below it or in the
//           same drawn box, and the label above it
//   nearby  lists what is directly left, right, above and below the match, for odd layouts
import crypto from 'node:crypto';
import { esc, layout } from './html.js';

const KEEP_MS = 60 * 60 * 1000; // a document is forgotten an hour after it was last used
const MAX_DOCS = 20;
const docs = new Map();

setInterval(() => {
  for (const [id, d] of docs) if (Date.now() - d.last > KEEP_MS) docs.delete(id);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------- text helpers

/** Lower case, no accents, single spaces: for comparing words. */
export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[\u2018\u2019]/g, "'").replace(/[^\p{L}\p{N}'$%]+/gu, ' ').trim();
}

const LEADER = /^[._\-–—·…\s]{2,}$|^[.…·]$/;

/**
 * Reads a number the way forms write it: 15000, 15,000, 15 000, 15,000.00, $15,000, (1,234.00),
 * and French 15 000,00. Returns null if the text is not a number.
 */
export function parseNumber(text) {
  let s = String(text || '').replace(/[\u00a0\u202f]/g, ' ').trim();
  if (!s || !/\d/.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/^[-–−]\s*/, () => { negative = true; return ''; });
  s = s.replace(/^\$\s*|\s*\$$|\s*%$/g, '').trim();
  if (!/^[\d][\d\s.,]*$/.test(s)) return null;
  s = s.replace(/\s+/g, ' ');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever comes last is the decimal mark.
    s = lastDot > lastComma ? s.replace(/[ ,]/g, '') : s.replace(/[ .]/g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    // A comma followed by exactly 2 digits at the end is a decimal (French style); otherwise thousands.
    s = /,\d{2}$/.test(s) && !/,\d{3}/.test(s) ? s.replace(/ /g, '').replace(',', '.') : s.replace(/[ ,]/g, '');
  } else {
    s = s.replace(/ /g, '');
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, ''); // 1.234.567
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

function amountLike(text) {
  return /\d/.test(text) && parseNumber(text) !== null;
}

// ---------------------------------------------------------------- building rows

/**
 * Turns the document model from helpers/pdf_doc.py into rows and cells.
 * Returns [{ number, rows: [{ cells: [{ text, field }], text }] }].
 */
export function buildIndex(model) {
  return model.pages.map((page) => {
    const items = [];
    for (const line of page.lines) {
      for (const w of line.words) {
        // OCR often reads the border of a box as a bracket or bar: "[22]", "|". Remove those.
        const text = w.text.replace(/^[[|{]+|[\]|}]+$/g, '').trim();
        if (text) items.push({ text, rect: w.rect, field: false });
      }
    }
    for (const f of page.fields || []) {
      if (!['Text', 'ComboBox', 'ListBox'].includes(f.type) || !String(f.value || '').trim()) continue;
      // A filled-in field's answer can also show up as page text. Keep the field, drop that text.
      const centreIn = (it) => {
        const x = (it.rect[0] + it.rect[2]) / 2;
        const y = (it.rect[1] + it.rect[3]) / 2;
        return x >= f.rect[0] && x <= f.rect[2] && y >= f.rect[1] && y <= f.rect[3];
      };
      for (let i = items.length - 1; i >= 0; i--) if (!items[i].field && centreIn(items[i])) items.splice(i, 1);
      items.push({ text: String(f.value).trim(), rect: f.rect, field: true, label: f.label || f.name || '' });
    }
    // Form fields have their own outline, so they count as boxes too.
    const boxes = [...(page.boxes || []), ...(page.fields || []).map((f) => f.rect)];
    for (const it of items) it.box = smallestBox(boxes, it.rect);
    const rows = rowsOf(items);
    return { number: page.number, rows, boxes: boxes.length };
  });
}

function centre(r) {
  return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
}

/** The smallest drawn box around the middle of a rectangle, as an index into boxes, or -1. */
function smallestBox(boxes, rect) {
  const [x, y] = centre(rect);
  let best = -1;
  let area = Infinity;
  boxes.forEach((b, i) => {
    if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) {
      const a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a < area) { area = a; best = i; }
    }
  });
  return best;
}

function rowsOf(items) {
  const mid = (it) => (it.rect[1] + it.rect[3]) / 2;
  const height = (it) => Math.max(4, Math.min(it.rect[3] - it.rect[1], 40));
  items.sort((a, b) => mid(a) - mid(b) || a.rect[0] - b.rect[0]);
  const rows = [];
  for (const it of items) {
    const row = rows.at(-1);
    // Same row if the middles are within half a text height of each other.
    if (row && Math.abs(mid(it) - row.mid) <= Math.max(3, Math.min(height(it), row.h) * 0.5)) {
      row.items.push(it);
      row.mid = (row.mid * (row.items.length - 1) + mid(it)) / row.items.length;
    } else {
      rows.push({ items: [it], mid: mid(it), h: height(it) });
    }
  }
  return rows.map((r) => {
    r.items.sort((a, b) => a.rect[0] - b.rect[0]);
    const cells = [];
    let cur = null;
    let prev = null;
    for (const it of r.items) {
      const leader = !it.field && LEADER.test(it.text);
      const gap = prev ? it.rect[0] - prev.rect[2] : 0;
      // A new cell starts at a wide gap, dotted leaders, a form field, or a different drawn box.
      const otherBox = cur && it.box !== cur.box && (it.box >= 0 || cur.box >= 0);
      const newCell = !cur || leader || it.field || cur.field || cur.breakAfter || otherBox || gap > r.h * 0.9;
      if (leader) { if (cur) cur.breakAfter = true; prev = it; continue; }
      if (newCell) {
        cur = { parts: [it.text], field: it.field, label: it.label, box: it.box, rect: [...it.rect] };
        cells.push(cur);
      } else {
        cur.parts.push(it.text);
        cur.rect = [Math.min(cur.rect[0], it.rect[0]), Math.min(cur.rect[1], it.rect[1]), Math.max(cur.rect[2], it.rect[2]), Math.max(cur.rect[3], it.rect[3])];
      }
      prev = it;
    }
    // Clean up: trailing leader dots inside words, and cents written in their own box (54,321 | 00).
    const out = [];
    cells.forEach((c, ci) => {
      const text = c.parts.join(' ').replace(/\s*[.…·]{3,}\s*$/, '').replace(/^\s*[.…·]{3,}\s*/, '').trim();
      if (!text) return;
      const last = out.at(-1);
      const next = cells[ci + 1];
      // Only join cents when nothing number-like follows, so box numbers on slips ("14  54,321  16")
      // are not mistaken for cents.
      const nextIsNumber = next && amountLike(next.parts.join(' '));
      if (last && /^\d{2}$/.test(text) && !nextIsNumber && /^\$?\d{1,3}([ ,]\d{3})*$|^\$?\d+$/.test(last.text)
        && !/[.]\d{2}$/.test(last.text) && c.rect[0] - last.rect[2] < r.h * 4) {
        last.text = `${last.text}.${text}`;
        last.rect[2] = c.rect[2];
        return;
      }
      out.push({ text, field: c.field, label: c.label, box: c.box, rect: c.rect });
    });
    return { cells: out, text: out.map((c) => c.text).join('; '), h: r.h, y: r.mid };
  }).filter((r) => r.cells.length);
}

// ---------------------------------------------------------------- searching

/** Understands what is being looked for: a number (any format) or words. */
export function parseQuery(q) {
  const raw = String(q || '').trim().slice(0, 200);
  const stripped = raw.replace(/^(line|ligne|box|case|field|row)\s*#?\s*/i, '');
  const n = parseNumber(stripped);
  if (n !== null && /^[$(\-]?\s*[\d][\d\s,.]*\)?%?$/.test(stripped.replace(/^\$/, ''))) {
    return { raw, kind: 'number', value: n, digits: stripped.replace(/\D/g, '') };
  }
  return { raw, kind: 'text', words: fold(raw) };
}

/**
 * Where the search matches a cell: { whole: true } for the whole cell, or { start, end } as word
 * positions inside it (for example 15000 inside "Refund 48400 15000 1,234.56"). Null if no match.
 */
function cellMatch(cell, query) {
  if (query.kind === 'number') {
    if (parseNumber(cell.text) === query.value) return { whole: true };
    const tokens = cell.text.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      for (let len = 1; len <= 3 && i + len <= tokens.length; len++) {
        if (parseNumber(tokens.slice(i, i + len).join(' ')) === query.value) return { start: i, end: i + len };
      }
    }
    return null;
  }
  return fold(cell.text).includes(query.words) ? { whole: fold(cell.text) === query.words } : null;
}

/** Splits text into numbers and words: "owing 48400 1,234.56" gives ["owing", "48400", "1,234.56"]. */
function pieces(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (parseNumber(tokens[i]) === null) {
      if (out.length && !out.at(-1).num) out.at(-1).text += ` ${tokens[i]}`;
      else out.push({ text: tokens[i], num: false });
    } else {
      out.push({ text: tokens[i], num: true });
    }
  }
  return out.map((p) => ({ text: p.text, field: false, num: p.num }));
}

/** Lines mode: every row that matches, with the amount(s) and label next to the match. */
function lineSearch(doc, query) {
  const results = [];
  for (const page of doc.pages) {
    page.rows.forEach((row, ri) => {
      let at = -1;
      let hit = null;
      for (let i = 0; i < row.cells.length && !hit; i++) {
        hit = cellMatch(row.cells[i], query);
        if (hit) at = i;
      }
      if (!hit && query.kind === 'text' && fold(row.text).includes(query.words)) {
        const first = query.words.split(' ')[0];
        at = Math.max(0, row.cells.findIndex((c) => fold(c.text).includes(first)));
        hit = { whole: false };
      }
      if (!hit) return;
      // Cells before and after the match. A match inside a cell splits that cell into pieces.
      let before = row.cells.slice(0, at);
      let after = row.cells.slice(at + 1);
      let match = row.cells[at].text;
      let mention = false;
      if (hit.start != null) {
        const tokens = row.cells[at].text.split(/\s+/);
        const rest = pieces(tokens.slice(hit.end));
        if (rest.some((p) => !p.num)) {
          // The number is mentioned in a sentence, such as "line 15000 minus line 23300". Keep the sentence whole.
          mention = true;
          before = [...before, row.cells[at]];
        } else {
          match = tokens.slice(hit.start, hit.end).join(' ');
          before = [...before, ...pieces(tokens.slice(0, hit.start))];
          after = [...rest, ...after];
        }
      }
      const isNum = (c) => c.num ?? amountLike(c.text);
      // You searched for an amount (not a line number) and found it: the line's label is the answer.
      const lineNumberLike = /^\d{3,5}$/.test(match) && /^\d{3,5}$/.test(query.raw.replace(/^\D+/, ''));
      const moneyLike = /[.,]\d{2}$/.test(query.raw) || /\d,\d{3}/.test(query.raw);
      const matchIsAmount = query.kind === 'number' && !lineNumberLike
        && ((before.some((c) => !isNum(c) && !c.field) && !after.some(isNum)) || moneyLike);
      let amounts = [];
      for (const c of after) {
        // On slips, a short box number after an amount starts the next box: stop there.
        if (amounts.length && !c.field && /^\d{1,3}[A-Za-z]?$/.test(c.text) && !amounts.every((x) => /^\d{3,5}$/.test(x.text))) break;
        if (isNum(c) || c.field) amounts.push(c);
      }
      if (!amounts.length && !matchIsAmount) amounts = before.filter((c) => isNum(c) || c.field).slice(-2);
      if (matchIsAmount) amounts = [{ text: match, field: false, searched: true }];
      // A plain 3 to 5 digit number followed by another amount is a line number, as on tax forms.
      let lineNo = null;
      if (amounts.length > 1 && /^\d{3,5}$/.test(amounts[0].text) && !amounts[0].field) lineNo = amounts.shift().text;
      if (!lineNo && !mention && query.kind === 'number' && /^\d{3,5}$/.test(match) && !matchIsAmount) lineNo = match;
      const label = before.filter((c) => !isNum(c) && !c.field).map((c) => c.text).join(' ')
        || after.filter((c) => !isNum(c) && !c.field).map((c) => c.text).join(' ')
        || (query.kind === 'text' ? match : '');
      const score = (hit.whole ? (query.kind === 'number' ? 2 : 1) : 0) + (amounts.length ? 2 : 0) + (query.kind === 'number' && !matchIsAmount && !mention ? 1 : 0);
      results.push({
        page: page.number, row: ri, match: mention ? row.cells[at].text : match, label, lineNo, amounts, score,
        cells: row.cells, above: page.rows[ri - 1]?.text || '', below: page.rows[ri + 1]?.text || '',
        method: 'lines', how: 'on the same line',
      });
    });
  }
  return results;
}

// ---------------------------------------------------------------- boxes and nearby

const BOX_NO = /^\d{1,3}[A-Za-z]?$/; // box numbers on slips: 14, 16, 22, 52, 14A

/** A value in a box: a filled-in field, or an amount that is not just a short box number. */
function isValue(c) {
  if (c.field) return true;
  if (!amountLike(c.text)) return false;
  return !BOX_NO.test(c.text) || /[.,]/.test(c.text);
}

function overlapX(a, b, pad = 0) {
  return Math.min(a[2] + pad, b[2] + pad) - Math.max(a[0] - pad, b[0] - pad) > 0;
}

/** Every cell on a page, with the row it is in. */
function cellsOf(page) {
  const out = [];
  page.rows.forEach((row, ri) => row.cells.forEach((c, ci) => out.push({ ...c, ri, ci, h: row.h })));
  return out;
}

/** The cells that match the search: [{ cell, whole }]. */
function anchorsOf(cells, query) {
  const out = [];
  for (const c of cells) {
    const hit = cellMatch(c, query);
    if (!hit) continue;
    if (query.kind === 'number' && hit.start != null) {
      // A box number at the start of a label, as in "14 Employment income", counts; other partial matches do not.
      const tokens = c.text.split(/\s+/);
      if (hit.start !== 0 || hit.end !== 1 || !BOX_NO.test(tokens[0])) continue;
      out.push({ cell: c, whole: false, boxNo: tokens[0], rest: tokens.slice(1).join(' ') });
      continue;
    }
    out.push({ cell: c, whole: Boolean(hit.whole) });
  }
  return out;
}

/**
 * Boxes mode, for slips such as the T4. For each match it looks for the value
 *   1. in the same drawn box,
 *   2. to the right on the same line, before the next box number,
 *   3. directly below, overlapping the match,
 * and for the label in the same box or on the line just above.
 */
function boxSearch(doc, query) {
  const results = [];
  for (const page of doc.pages) {
    const cells = cellsOf(page);
    for (const { cell: a, whole, boxNo: prefixNo, rest } of anchorsOf(cells, query)) {
      const h = a.h || 8;
      const others = cells.filter((c) => c !== a);
      // You searched for an amount: say which box it is in, instead of looking for another amount.
      const valueRight = others.some((c) => c.ri === a.ri && c.ci > a.ci && isValue(c));
      const lineNoLike = /^\d{3,5}$/.test(a.text) && valueRight;
      const moneyLike = query.kind === 'number' && !prefixNo && !lineNoLike && isValue(a) && (/[.,]/.test(a.text) || !BOX_NO.test(a.text));
      if (moneyLike) {
        const leftNo = others.filter((c) => c.ri === a.ri && c.ci < a.ci).sort((x, y) => y.ci - x.ci)[0];
        const sameBox = a.box >= 0 ? others.find((c) => c.box === a.box && BOX_NO.test(c.text) && !isValue(c)) : null;
        const no = sameBox?.text || (leftNo && BOX_NO.test(leftNo.text) && !isValue(leftNo) ? leftNo.text : null);
        const anchorRect = no && leftNo && leftNo.text === no ? [leftNo.rect[0], a.rect[1], a.rect[2], a.rect[3]] : a.rect;
        const above = others.filter((c) => !amountLike(c.text) && !c.field && c.rect[3] <= anchorRect[1] + 1 && anchorRect[1] - c.rect[3] < h * 3 && overlapX(c.rect, anchorRect, h))
          .sort((x, y) => y.rect[3] - x.rect[3]);
        const inBox = a.box >= 0 ? others.filter((c) => c.box === a.box && !amountLike(c.text) && !c.field).map((c) => c.text).join(' ') : '';
        const label = inBox.replace(/^\d{1,3}[A-Za-z]?\s+/, '') || above[0]?.text || '';
        if (!no && !label) continue;
        results.push({
          page: page.number, row: a.ri, match: a.text, label, boxNo: no, lineNo: null, score: 3 + (no ? 2 : 0) + (label ? 1 : 0),
          amounts: [{ text: a.text, searched: true }],
          cells: page.rows[a.ri].cells, above: page.rows[a.ri - 1]?.text || '', below: page.rows[a.ri + 1]?.text || '',
          method: 'boxes', how: no ? 'is in this box' : 'is under this label',
        });
        continue;
      }
      let values = [];
      let how = '';
      let lineNo = null;
      if (a.box >= 0) {
        values = others.filter((c) => c.box === a.box && isValue(c));
        if (values.length) how = 'in the same box';
      }
      if (!values.length) {
        const right = others.filter((c) => c.ri === a.ri && c.ci > a.ci).sort((x, y) => x.ci - y.ci);
        for (const [k, c] of right.entries()) {
          if (BOX_NO.test(c.text) && !isValue(c)) break; // reached the next box
          if (c.rect[0] - a.rect[2] > h * 30) break;
          // On tax-return lines a 3 to 5 digit number followed by an amount is a line number.
          if (!c.field && /^\d{3,5}$/.test(c.text) && right.slice(k + 1).some(isValue)) { lineNo = c.text; continue; }
          if (isValue(c)) { values = [c]; how = 'beside it'; break; }
        }
      }
      if (!values.length) {
        const below = others.filter((c) => c.rect[1] >= a.rect[3] - 1 && c.rect[1] - a.rect[3] < h * 4 && overlapX(c.rect, a.rect, h * 2) && isValue(c))
          .sort((x, y) => x.rect[1] - y.rect[1] || Math.abs(x.rect[0] - a.rect[0]) - Math.abs(y.rect[0] - a.rect[0]));
        if (below.length) { values = [below[0]]; how = 'below it'; }
      }
      // The label: words in the same box, else the line just above the match (or above the value).
      const words = (c) => !amountLike(c.text) && !c.field;
      let label = '';
      let textNo = null;
      if (query.kind === 'text') {
        const m = /^(\d{1,3}[A-Za-z]?)\s+(\D.*)$/.exec(a.text);
        if (m) { textNo = m[1]; label = m[2]; } else label = a.text;
      } else if (prefixNo) {
        label = rest;
      } else {
        if (a.box >= 0) label = others.filter((c) => c.box === a.box && words(c)).map((c) => c.text).join(' ');
        if (!label) {
          const span = values[0] ? [Math.min(a.rect[0], values[0].rect[0]), a.rect[1], Math.max(a.rect[2], values[0].rect[2]), a.rect[3]] : a.rect;
          const above = others.filter((c) => words(c) && c.rect[3] <= a.rect[1] + 1 && a.rect[1] - c.rect[3] < h * 3 && overlapX(c.rect, span, h))
            .sort((x, y) => y.rect[3] - x.rect[3]);
          if (above.length) {
            const lineY = above[0].rect[3];
            label = above.filter((c) => lineY - c.rect[3] < h * 0.6).sort((x, y) => x.rect[0] - y.rect[0]).map((c) => c.text).join(' ');
          }
        }
        if (!label) label = others.filter((c) => c.ri === a.ri && words(c) && c.ci > a.ci).slice(0, 1).map((c) => c.text).join(' ');
      }
      // For a word search, the box number is a short number in the same box or beside the label.
      let boxNo = prefixNo || textNo || (query.kind === 'number' && BOX_NO.test(a.text) ? a.text : null);
      if (!boxNo && query.kind === 'text') {
        const near = others.find((c) => (c.box === a.box && a.box >= 0) || (c.ri === a.ri && Math.abs(c.ci - a.ci) === 1));
        if (near && BOX_NO.test(near.text) && !isValue(near)) boxNo = near.text;
      }
      if (query.kind === 'number' && !boxNo && !values.length) continue; // an amount with nothing around it
      if (lineNoLike && !boxNo) lineNo = a.text;
      const score = (values.length ? 3 : 0) + (whole ? 1 : 0) + (boxNo ? 1 : 0) + (label ? 1 : 0);
      results.push({
        page: page.number, row: a.ri, match: prefixNo || a.text, label, boxNo, lineNo, score,
        amounts: values.map((v) => ({ text: v.text, field: v.field })),
        cells: page.rows[a.ri].cells, above: page.rows[a.ri - 1]?.text || '', below: page.rows[a.ri + 1]?.text || '',
        method: 'boxes', how: how || 'no value found nearby',
      });
    }
  }
  return results;
}

/** Nearby mode: the closest text in each direction from every match. */
function nearbySearch(doc, query) {
  const results = [];
  for (const page of doc.pages) {
    const cells = cellsOf(page);
    for (const { cell: a, whole } of anchorsOf(cells, query)) {
      const h = a.h || 8;
      const others = cells.filter((c) => c !== a);
      const [ax, ay] = centre(a.rect);
      const dist = (c) => Math.hypot(centre(c.rect)[0] - ax, centre(c.rect)[1] - ay);
      const pick = (list) => list.sort((x, y) => dist(x) - dist(y))[0]?.text || '';
      const sameRow = (c) => Math.abs(centre(c.rect)[1] - ay) < h * 0.7;
      const near = {
        left: pick(others.filter((c) => sameRow(c) && c.rect[2] <= a.rect[0] + 1)),
        right: pick(others.filter((c) => sameRow(c) && c.rect[0] >= a.rect[2] - 1)),
        above: pick(others.filter((c) => c.rect[3] <= a.rect[1] + 1 && overlapX(c.rect, a.rect, h * 3) && a.rect[1] - c.rect[3] < h * 6)),
        below: pick(others.filter((c) => c.rect[1] >= a.rect[3] - 1 && overlapX(c.rect, a.rect, h * 3) && c.rect[1] - a.rect[3] < h * 6)),
      };
      const values = ['right', 'below', 'left', 'above'].map((k) => near[k]).filter((t) => t && amountLike(t) && !(BOX_NO.test(t) && !/[.,]/.test(t)));
      results.push({
        page: page.number, row: a.ri, match: a.text, label: '', lineNo: null, boxNo: null, near,
        amounts: values.slice(0, 1).map((t) => ({ text: t })), score: (whole ? 1 : 0) + (values.length ? 1 : 0),
        cells: page.rows[a.ri].cells, above: '', below: '', method: 'nearby', how: 'nearest text around it',
      });
    }
  }
  return results;
}

export const MODES = {
  auto: 'Automatic (tries every way, best answers first)',
  lines: 'Lines, for tax returns (label, line number and amount on one line)',
  boxes: 'Boxes, for slips such as T4, T5 and receipts (box number with the amount beside or below it)',
  nearby: 'Nearby (what is left, right, above and below the match)',
};

/** Finds matches using the chosen mode, best first. */
export function search(doc, q, mode = 'auto') {
  const query = parseQuery(q);
  if (!query.raw) return { query, results: [], close: [] };
  if (!MODES[mode]) mode = 'auto';
  let results;
  if (mode === 'lines') results = lineSearch(doc, query);
  else if (mode === 'boxes') results = boxSearch(doc, query);
  else if (mode === 'nearby') results = nearbySearch(doc, query);
  else {
    // Automatic: answers from lines and boxes together. Where both found the same value on the same
    // line, keep the better one. Slip-shaped numbers (1 to 3 digits) favour boxes, longer ones lines.
    const slipLike = query.kind === 'number' && /^\d{1,3}[a-z]?$/i.test(query.raw.replace(/^\D+/, ''));
    const all = [...lineSearch(doc, query).map((r) => ({ ...r, score: r.score + (slipLike ? 0 : 1) })),
      ...boxSearch(doc, query).map((r) => ({ ...r, score: r.score + (slipLike ? 1 : 0) }))];
    const best = new Map();
    for (const r of all) {
      const key = `${r.page}|${r.row}|${r.match}|${r.amounts.map((a) => a.text).join(',')}`;
      if (!best.has(key) || best.get(key).score < r.score) best.set(key, r);
    }
    results = [...best.values()];
    if (!results.length) results = nearbySearch(doc, query);
  }
  results.sort((a, b) => b.score - a.score || a.page - b.page || a.row - b.row);
  let close = [];
  if (!results.length && query.kind === 'number' && query.digits.length >= 3) {
    // Nothing exact: rows that contain those digits somewhere, for example 15000 inside 150000.
    for (const page of doc.pages) {
      page.rows.forEach((row, ri) => {
        if (close.length < 15 && row.text.replace(/\D/g, '').includes(query.digits)) close.push({ page: page.number, row: ri, text: row.text });
      });
    }
  } else if (!results.length && query.kind === 'text') {
    const words = query.words.split(' ').filter((w) => w.length > 2);
    for (const page of doc.pages) {
      page.rows.forEach((row, ri) => {
        const t = fold(row.text);
        if (close.length < 15 && words.length && words.every((w) => t.includes(w))) close.push({ page: page.number, row: ri, text: row.text });
      });
    }
  }
  return { query, results: results.slice(0, 50), more: Math.max(0, results.length - 50), close };
}

// ---------------------------------------------------------------- storing

export function storeDocument({ name, pages, mode = 'auto' }) {
  while (docs.size >= MAX_DOCS) {
    const oldest = [...docs.entries()].sort((a, b) => a[1].last - b[1].last)[0];
    docs.delete(oldest[0]);
  }
  const id = crypto.randomBytes(12).toString('base64url');
  docs.set(id, { name, pages, mode: MODES[mode] ? mode : 'auto', last: Date.now() });
  return id;
}

function getDoc(id) {
  const d = docs.get(id);
  if (d) d.last = Date.now();
  return d;
}

// ---------------------------------------------------------------- pages

function searchForm(id, q, mode) {
  const options = Object.entries(MODES).map(([v, label]) => `<option value="${v}"${v === mode ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<form method="get" action="/find/${esc(id)}" role="search">
<div class="field"><label for="q">Search for a line number, box number, amount or words</label>
<p class="help" id="q-help">For example 15000, line 15000, box 14, 54,321 or employment income. Numbers match however they are written.</p>
<input type="search" id="q" name="q" value="${esc(q)}" class="wide" autocomplete="off" aria-describedby="q-help"></div>
<div class="field"><label for="mode">How to read the page</label>
<p class="help" id="mode-help">If an answer looks wrong, try another way. Each result says how it was found.</p>
<select id="mode" name="mode" aria-describedby="mode-help">${options}</select></div>
<button type="submit">Find</button>
</form>`;
}

function titleOf(r) {
  if (r.method === 'boxes') {
    const parts = [r.boxNo ? `Box ${r.boxNo}` : '', r.label, r.lineNo ? `line ${r.lineNo}` : ''];
    if (!r.boxNo && !r.lineNo && r.match !== r.label && !r.amounts.some((a) => a.searched)) parts.push(r.match);
    return parts.filter(Boolean).join(', ') || r.match;
  }
  if (r.method === 'nearby') return r.match;
  const parts = [r.label];
  if (r.lineNo) parts.push(`line ${r.lineNo}`);
  else if (r.match !== r.label && !r.amounts.some((a) => a.searched)) parts.push(r.match);
  return parts.filter(Boolean).join(', ') || r.match;
}

const HOW = { lines: 'Found as a line', boxes: 'Found as a box', nearby: 'Found by looking around' };

function howText(r) {
  if (r.method === 'nearby') return 'Found by looking around the match.';
  if (!r.amounts.length) return `${HOW[r.method]}, but no amount was found.`;
  if (r.amounts.some((a) => a.searched)) return `${HOW[r.method]}: the amount you searched for ${r.how}.`;
  return `${HOW[r.method]}, with the amount ${r.how}.`;
}

function resultHtml(id, r, i) {
  const title = titleOf(r);
  const items = [];
  if (r.amounts.length) {
    items.push(`<li>${r.amounts.length === 1 ? 'Amount' : 'Amounts'}: ${r.amounts.map((a) => esc(a.searched ? `${a.text} (what you searched for)` : a.text)).join('; ')}</li>`);
  } else {
    items.push(`<li>No amount found ${r.method === 'lines' ? 'on this line' : 'nearby'}.</li>`);
  }
  if (r.method === 'nearby') {
    for (const [k, label] of [['right', 'Right'], ['below', 'Below'], ['left', 'Left'], ['above', 'Above']]) {
      items.push(`<li>${label}: ${esc(r.near[k] || 'nothing')}</li>`);
    }
  } else {
    items.push(`<li>Whole line: ${esc(r.cells.map((c) => c.text).join('; '))}</li>`);
    if (r.above) items.push(`<li>Line above: ${esc(r.above)}</li>`);
    if (r.below) items.push(`<li>Line below: ${esc(r.below)}</li>`);
  }
  items.push(`<li>${esc(howText(r))}</li>`);
  items.push(`<li><a href="/find/${esc(id)}/page/${esc(r.page)}#r${esc(r.row)}">Read page ${esc(r.page)} from this line</a></li>`);
  return `<h3 id="res${i}">Page ${esc(r.page)}: ${esc(title)}</h3>\n<ul>\n${items.join('\n')}\n</ul>`;
}

function searchPage(id, doc, q, mode) {
  const rows = doc.pages.reduce((n, p) => n + p.rows.length, 0);
  const boxes = doc.pages.reduce((n, p) => n + (p.boxes || 0), 0);
  let body = `<h1>Find in ${esc(doc.name)}</h1>
<p>${doc.pages.length} ${doc.pages.length === 1 ? 'page' : 'pages'}, ${rows} lines${boxes ? `, ${boxes} drawn boxes or form fields` : ', no drawn boxes'}. Forgotten an hour after you last use it.</p>
${searchForm(id, q, mode)}`;
  if (q) {
    const { query, results, more, close } = search(doc, q, mode);
    const what = query.kind === 'number' ? `the number ${query.value.toLocaleString('en-CA')}` : `"${query.raw}"`;
    const modeName = mode === 'auto' ? '' : ` Reading the page as: ${MODES[mode].split(' (')[0].split(',')[0].toLowerCase()}.`;
    if (results.length) {
      const first = results[0];
      const lead = first.amounts.length ? ` First: page ${first.page}, ${titleOf(first)}: ${first.amounts.map((a) => a.text).join('; ')}.` : '';
      body += `<h2>Results</h2>\n<p id="flash" tabindex="-1">${results.length + more} ${results.length + more === 1 ? 'match' : 'matches'} for ${esc(what)}.${esc(lead)}${esc(modeName)}</p>
${results.map((r, i) => resultHtml(id, r, i)).join('\n')}${more ? `<p>${more} more not shown. Try a longer search.</p>` : ''}`;
    } else {
      body += `<h2>Results</h2>\n<p id="flash" tabindex="-1">No match for ${esc(what)}.${esc(modeName)}${close.length ? ` ${close.length} ${close.length === 1 ? 'line is' : 'lines are'} close.` : ''}${mode !== 'auto' ? ' Try Automatic.' : ''}</p>`;
      if (close.length) {
        body += `<h3>Close matches</h3>\n<ul>\n${close.map((c) => `<li><a href="/find/${esc(id)}/page/${esc(c.page)}#r${esc(c.row)}">Page ${esc(c.page)}</a>: ${esc(c.text)}</li>`).join('\n')}\n</ul>`;
      }
    }
  }
  body += `<h2>Pages</h2>
<ul>${doc.pages.map((p) => `<li><a href="/find/${esc(id)}/page/${esc(p.number)}">Read page ${esc(p.number)} line by line</a></li>`).join('')}</ul>
<form method="post" action="/find/${esc(id)}/forget"><button type="submit">Forget this document now</button></form>`;
  return layout({ title: q ? `${q}: Find in ${doc.name}` : `Find in ${doc.name}`, body, extraScript: '/static/forms.js' });
}

function pageView(id, doc, n) {
  const page = doc.pages.find((p) => p.number === n);
  const nav = [
    doc.pages.some((p) => p.number === n - 1) ? `<li><a href="/find/${esc(id)}/page/${n - 1}">Previous page</a></li>` : '',
    doc.pages.some((p) => p.number === n + 1) ? `<li><a href="/find/${esc(id)}/page/${n + 1}">Next page</a></li>` : '',
    `<li><a href="/find/${esc(id)}">Back to search</a></li>`,
  ].join('');
  const body = `<h1>Page ${n} of ${doc.pages.length}: ${esc(doc.name)}</h1>
<ul class="nav">${nav}</ul>
<h2>Lines</h2>
${page.rows.length ? `<ol>\n${page.rows.map((r, i) => `<li id="r${i}" tabindex="-1">${esc(r.text)}</li>`).join('\n')}\n</ol>` : '<p>No text on this page.</p>'}`;
  return layout({ title: `Page ${n}: ${doc.name}`, body, extraScript: '/static/find.js' });
}

/** Handles /find/... Returns false if the address is not one of ours. */
export function findRoutes(req, res, url, { send, messagePage }) {
  const m = url.pathname.match(/^\/find\/([\w-]{16})(?:\/page\/(\d+)|\/(forget))?$/);
  if (!m) return false;
  const doc = getDoc(m[1]);
  if (!doc) return send(res, 404, messagePage('Not found', 'This document is no longer here. Documents are forgotten an hour after they were last used. Use Find in a document again.'));
  if (req.method === 'POST' && m[3]) {
    docs.delete(m[1]);
    res.writeHead(303, { Location: '/tools/find' });
    return res.end();
  }
  if (req.method !== 'GET') return false;
  if (m[2]) {
    const n = Number(m[2]);
    if (!doc.pages.some((p) => p.number === n)) return send(res, 404, messagePage('Not found', 'There is no such page.'));
    return send(res, 200, pageView(m[1], doc, n));
  }
  const mode = url.searchParams.get('mode');
  if (MODES[mode]) doc.mode = mode; // remember the last mode used for this document
  return send(res, 200, searchPage(m[1], doc, (url.searchParams.get('q') || '').trim().slice(0, 200), doc.mode));
}
