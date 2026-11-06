// veraPDF: checks a PDF against the PDF/UA accessibility standard and writes an accessible HTML report.
import os from 'node:os';
import path from 'node:path';
import { access, constants, writeFile } from 'node:fs/promises';
import { which, run, userError } from '../lib/system.js';
import { sniff, plural } from '../lib/files.js';
import { esc } from '../lib/html.js';

async function veraCommand() {
  const found = await which('verapdf');
  if (found) return found;
  // Places the veraPDF installer usually puts it.
  for (const p of [path.join(os.homedir(), 'verapdf', 'verapdf'), '/Applications/verapdf/verapdf']) {
    try { await access(p, constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

async function hasJava() {
  if (process.platform === 'darwin') {
    // /usr/bin/java exists on every Mac, even without Java, so ask macOS whether a real one is installed.
    try { await run('/usr/libexec/java_home', []); return true; } catch { return false; }
  }
  return Boolean(await which('java'));
}

const PROFILES = {
  ua1: 'PDF/UA-1',
  ua2: 'PDF/UA-2',
};

// ---- Reading the veraPDF XML report ----
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = unxml(m[2]);
  return out;
}
function unxml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
}
function inner(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? unxml(m[1].trim()) : '';
}

export function parseReport(xml) {
  const exception = inner(xml, 'exceptionMessage');
  const vr = xml.match(/<validationReport\b[^>]*>/);
  if (!vr) return { error: exception || 'veraPDF did not produce a validation report.' };
  const report = attrs(vr[0]);
  const details = attrs((xml.match(/<details\b[^>]*>/) || [''])[0]);
  const rules = [];
  for (const m of xml.matchAll(/<rule\b([^>]*)>([\s\S]*?)<\/rule>/g)) {
    const a = attrs(m[1]);
    if (a.status !== 'failed') continue;
    const checks = [];
    for (const c of m[2].matchAll(/<check\b[^>]*>([\s\S]*?)<\/check>/g)) {
      const context = inner(c[1], 'context');
      const page = context.match(/pages\[(\d+)\]/);
      checks.push({ context, page: page ? Number(page[1]) + 1 : null, message: inner(c[1], 'errorMessage') });
    }
    rules.push({
      clause: a.clause || '',
      test: a.testNumber || '',
      spec: a.specification || '',
      failed: Number(a.failedChecks || checks.length),
      description: inner(m[2], 'description'),
      object: inner(m[2], 'object'),
      checks,
    });
  }
  const clauseKey = (r) => r.clause.split('.').map((n) => n.padStart(4, '0')).join('.') + `-${r.test.padStart(4, '0')}`;
  rules.sort((x, y) => clauseKey(x).localeCompare(clauseKey(y)));
  return {
    compliant: report.isCompliant === 'true',
    profile: report.profileName || '',
    statement: report.statement || '',
    failedRules: Number(details.failedRules || rules.length),
    passedRules: Number(details.passedRules || 0),
    failedChecks: Number(details.failedChecks || 0),
    passedChecks: Number(details.passedChecks || 0),
    rules,
  };
}

function pagesSummary(checks) {
  const pages = [...new Set(checks.map((c) => c.page).filter(Boolean))].sort((a, b) => a - b);
  if (!pages.length) return '';
  const ranges = [];
  for (const p of pages) {
    const last = ranges[ranges.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else ranges.push([p, p]);
  }
  const text = ranges.map(([a, b]) => (a === b ? `${a}` : `${a} to ${b}`)).join(', ');
  return `${pages.length === 1 ? 'Page' : 'Pages'} ${text}`;
}

function toHtml(r, fileName, profileLabel, shown) {
  const title = `${profileLabel} check: ${fileName}`;
  const result = r.compliant
    ? `<p><strong>Passed.</strong> No machine-checkable ${esc(profileLabel)} problems were found.</p>`
    : `<p><strong>Failed.</strong> ${plural(r.failedRules, 'rule')} failed, with ${plural(r.failedChecks, 'failed check')} in total. ${plural(r.passedRules, 'rule')} passed.</p>`;
  const reminder = '<p>veraPDF only checks what a computer can check. A pass does not mean the document is accessible: reading order, alt text quality, headings that make sense and similar things still need a person to review them.</p>';
  const contents = r.rules.length
    ? `<nav aria-labelledby="toc-h"><h2 id="toc-h">Failed rules</h2><ol>${r.rules.map((x, i) => `<li><a href="#rule-${i + 1}">${esc(x.clause)}${x.test ? ` test ${esc(x.test)}` : ''}: ${esc(x.description)} (${x.failed})</a></li>`).join('')}</ol></nav>`
    : '';
  const sections = r.rules.map((x, i) => {
    const where = pagesSummary(x.checks);
    const more = x.failed > x.checks.length ? `<p>Only the first ${x.checks.length} of ${x.failed} are listed.</p>` : '';
    const messages = [...new Set(x.checks.map((c) => c.message).filter(Boolean))];
    const list = x.checks.length
      ? `<details><summary>Locations (${x.checks.length})</summary><ol>${x.checks.map((c) => `<li>${c.page ? `Page ${c.page}. ` : ''}${c.message && messages.length > 1 ? `${esc(c.message)} ` : ''}<code>${esc(c.context)}</code></li>`).join('')}</ol></details>`
      : '';
    return `<section aria-labelledby="rule-${i + 1}">
<h3 id="rule-${i + 1}">${esc(x.clause)}${x.test ? ` test ${esc(x.test)}` : ''}: ${esc(x.description)}</h3>
<p>${plural(x.failed, 'failure')}.${where ? ` ${esc(where)}.` : ''}</p>
${messages.length === 1 ? `<p>${esc(messages[0])}</p>` : ''}
<p>Standard: ${esc(x.spec)}, clause ${esc(x.clause)}. Checked object: ${esc(x.object)}.</p>
${more}
${list}
</section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { font-family: system-ui, sans-serif; font-size: 1.125rem; line-height: 1.5; max-width: 75ch; margin: 2rem auto; padding: 0 1rem; }
code { overflow-wrap: anywhere; font-size: 0.95em; }
section { border-top: 1px solid #888; margin-top: 1.5rem; }
li { margin: 0.3rem 0; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<h2>Result</h2>
${result}
${reminder}
${contents}
${r.rules.length ? `<h2>Details</h2>\n${sections}` : ''}
<p>Locations shown per rule: up to ${shown}. Report made by veraPDF.</p>
</main>
</body>
</html>
`;
}

export default {
  id: 'verapdf',
  name: 'PDF/UA checker (veraPDF)',
  summary: 'Check a PDF against the PDF/UA accessibility standard, using veraPDF. Gives you a report with headings and a list of failed rules.',
  submitLabel: 'Check PDF',
  input: { label: 'PDF file', accept: '.pdf,application/pdf' },

  async setup() {
    const result = { missing: [], notes: [], options: [] };
    if (!(await hasJava())) result.missing.push({ what: 'Java is not installed. veraPDF needs it.', install: 'brew install --cask temurin' });
    if (!(await veraCommand())) {
      result.missing.push({ what: 'veraPDF is not installed. Download the installer from verapdf.org (Software, then Download), run it, and keep the suggested install folder (a folder called verapdf in your home folder).', install: null });
    }
    result.options.push(
      {
        id: 'profile', type: 'select', label: 'Standard', default: 'ua1',
        help: 'PDF/UA-1 is the version most PDFs are checked against today. PDF/UA-2 is for PDF 2.0 files.',
        choices: Object.entries(PROFILES).map(([value, label]) => ({ value, label })),
      },
      {
        id: 'shown', type: 'select', label: 'Locations to list per rule', default: '20',
        choices: [{ value: '5', label: '5' }, { value: '20', label: '20' }, { value: '100', label: '100' }, { value: '-1', label: 'All' }],
      },
      { id: 'xml', type: 'checkbox', label: 'Also give me veraPDF\'s original XML report', default: false },
    );
    return result;
  },

  async run(ctx) {
    const { input, options: o, outDir } = ctx;
    if ((await sniff(input.path)) !== 'pdf') throw userError('This file is not a PDF.');
    const cmd = await veraCommand();
    ctx.progress(null, null, 'Checking');
    // veraPDF exits with 1 when the PDF fails the check, which is a normal result here.
    const { stdout } = await ctx.run(cmd, ['--flavour', o.profile, '--format', 'xml', '--maxfailuresdisplayed', o.shown, input.path], { okCodes: [0, 1] });
    const report = parseReport(stdout);
    if (report.error) throw userError(`veraPDF could not check this file. ${report.error}`);

    const label = PROFILES[o.profile];
    const htmlPath = path.join(outDir, `${input.base}-${o.profile}-report.html`);
    await writeFile(htmlPath, toHtml(report, input.name, label, o.shown === '-1' ? 'all' : o.shown));
    ctx.output(htmlPath, 'Report');
    if (o.xml) {
      const xmlPath = path.join(outDir, `${input.base}-${o.profile}-report.xml`);
      await writeFile(xmlPath, stdout);
      ctx.output(xmlPath, 'veraPDF XML report');
    }
    ctx.finishMessage(report.compliant ? `${label} check passed.` : `${label} check failed: ${plural(report.failedRules, 'rule')}, ${plural(report.failedChecks, 'failed check')}.`);
  },
};
