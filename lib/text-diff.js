// Word-level comparison of two versions of a paragraph, used for the AI changes report.

/** Splits text into words, keeping punctuation attached, so changes are reported per word. */
export function tokens(text) {
  return String(text).split(/\s+/).filter(Boolean);
}

/**
 * Returns a list of changes: { before: 'w1 w2', after: 'w3', at: index in the original words }.
 * Uses a longest-common-subsequence match, which is fine for paragraph-sized text.
 */
export function wordChanges(beforeText, afterText) {
  const a = tokens(beforeText);
  const b = tokens(afterText);
  const n = a.length;
  const m = b.length;
  // For very long paragraphs fall back to a simple whole-paragraph comparison to stay fast.
  if (n * m > 4_000_000) {
    return a.join(' ') === b.join(' ') ? [] : [{ before: a.join(' '), after: b.join(' '), at: 0 }];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const changes = [];
  let i = 0;
  let j = 0;
  let cur = null;
  const flush = () => {
    if (cur) changes.push({ before: cur.before.join(' '), after: cur.after.join(' '), at: cur.at });
    cur = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      cur ??= { before: [], after: [], at: i };
      cur.after.push(b[j++]);
    } else {
      cur ??= { before: [], after: [], at: i };
      cur.before.push(a[i++]);
    }
  }
  flush();
  return changes;
}

/** Share of the original words that were changed, from 0 to 1. */
export function changeRatio(beforeText, changes) {
  const total = Math.max(1, tokens(beforeText).length);
  const changed = changes.reduce((sum, c) => sum + Math.max(tokens(c.before).length, tokens(c.after).length), 0);
  return changed / total;
}

/** A few words around a change, so the report shows where it was. */
export function context(beforeText, change, width = 4) {
  const a = tokens(beforeText);
  const len = tokens(change.before).length;
  const start = Math.max(0, change.at - width);
  const end = Math.min(a.length, change.at + len + width);
  return {
    pre: (start > 0 ? '… ' : '') + a.slice(start, change.at).join(' '),
    post: a.slice(change.at + len, end).join(' ') + (end < a.length ? ' …' : ''),
  };
}

/** Number of single-character edits needed to turn a into b. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** How alike two strings are, from 0 (nothing in common) to 1 (the same). */
export function similarity(a, b) {
  const len = Math.max(a.length, b.length);
  return len ? 1 - editDistance(a, b) / len : 1;
}

/** Rebuilds the text from the original words, applying only the given changes. */
export function applyChanges(beforeText, changes) {
  const a = tokens(beforeText);
  const out = [];
  const byAt = new Map(changes.map((c) => [c.at, c]));
  for (let i = 0; i <= a.length; i++) {
    const c = byAt.get(i);
    if (c) {
      if (c.after) out.push(c.after);
      i += tokens(c.before).length;
      if (i < a.length) out.push(a[i]);
      continue;
    }
    if (i < a.length) out.push(a[i]);
  }
  return out.join(' ');
}
