// Profile and form filler pages: /profile and /forms.
// Everything personal is stored encrypted in the unlocked profile (see lib/vault.js).
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { esc, layout } from './html.js';
import { run, userError } from './system.js';
import { readFormData } from './http.js';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  listProfiles, createProfile, unlockProfile, changePassword, deleteProfile,
  newSession, sessionFor, endSession, cookieFor, clearCookie,
} from './vault.js';
import { PROFILE_FIELDS, ALL_FIELDS, FIELD_BY_ID, matchQuestion, shapeValue, profileValue, splitAcrossBoxes, dateFormat, formatDate } from './profile-fields.js';
import { runHelper } from './pyrun.js';
import { cleanSignature } from './signature.js';
import { toPdf } from './to-pdf.js';
import { textModels, visionModels, chatJson } from './ollama.js';

const MAX_UPLOAD = 100 * 1024 * 1024;

// ---------------------------------------------------------------- small helpers

function redirect(res, to, cookie) {
  const headers = { Location: to, 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(303, headers);
  res.end();
}

function page(res, title, body, { status = 200, cookie } = {}) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(layout({ title, body, extraScript: '/static/forms.js' }));
}

function readForm(req) {
  return readFormData(req, MAX_UPLOAD);
}

/** Saves an uploaded file to disk without holding a second copy in memory. */
function saveUpload(file, to) {
  return pipeline(Readable.fromWeb(file.stream()), createWriteStream(to));
}

function str(form, name, max = 5000) {
  const v = form.get(name);
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function safeNext(n) {
  return typeof n === 'string' && /^\/(?!\/)[\w\-/.?=&%#]*$/.test(n) ? n : '/profile';
}

function flash(session, text) {
  if (session) session.flash = text;
}

function takeFlash(session) {
  const f = session?.flash;
  if (session) session.flash = null;
  return f ? `<p id="flash" class="flash" tabindex="-1">${esc(f)}</p>` : '';
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'cw-forms-'));
}

function today(fmt = 'YYYY-MM-DD') {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return formatDate(iso, fmt);
}

// ---------------------------------------------------------------- profile pages

async function lockedPage(res, req, error = '') {
  const profiles = await listProfiles();
  const next = safeNext(new URL(req.url, 'http://x').searchParams.get('next') || '/profile');
  const choices = profiles.map((p, i) => `<div class="field check"><input type="radio" name="profile" id="p-${esc(p.id)}" value="${esc(p.id)}"${i === 0 ? ' checked' : ''}><label for="p-${esc(p.id)}">${esc(p.name)}</label></div>`).join('');
  const unlock = profiles.length ? `<section aria-labelledby="unlock-h">
<h2 id="unlock-h">Unlock a profile</h2>
<form method="post" action="/profile/unlock">
<input type="hidden" name="next" value="${esc(next)}">
<fieldset><legend>Profile</legend>${choices}</fieldset>
<div class="field"><label for="pw">Password</label><input type="password" id="pw" name="password" autocomplete="current-password" required></div>
<button type="submit">Unlock</button>
</form>
</section>` : '<p>There are no profiles yet. Make one below.</p>';
  const create = `<section aria-labelledby="create-h">
<h2 id="create-h">Make a new profile</h2>
<p>A profile keeps your details, signature and forms, encrypted with its own password. Each person can have their own profile.</p>
<form method="post" action="/profile/create">
<div class="field"><label for="c-name">Profile name, for example your first name</label><input id="c-name" name="name" required maxlength="60" autocomplete="off"></div>
<div class="field"><label for="c-pw">Password, at least 10 characters</label><p class="help" id="c-pw-help">A few random words works well. If you forget it, only the recovery code you get next can open the profile.</p><input type="password" id="c-pw" name="password" autocomplete="new-password" required minlength="10" aria-describedby="c-pw-help"></div>
<div class="field"><label for="c-pw2">Type the password again</label><input type="password" id="c-pw2" name="password2" autocomplete="new-password" required minlength="10"></div>
<button type="submit">Make profile</button>
</form>
</section>`;
  const recover = profiles.length ? `<section aria-labelledby="rec-h">
<h2 id="rec-h">Forgot the password</h2>
<form method="post" action="/profile/recover">
<div class="field"><label for="r-p">Profile</label><select id="r-p" name="profile">${profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
<div class="field"><label for="r-code">Recovery code</label><input id="r-code" name="code" autocomplete="off" spellcheck="false" required></div>
<div class="field"><label for="r-pw">New password</label><input type="password" id="r-pw" name="password" autocomplete="new-password" required minlength="10"></div>
<div class="field"><label for="r-pw2">Type the new password again</label><input type="password" id="r-pw2" name="password2" autocomplete="new-password" required minlength="10"></div>
<button type="submit">Set new password and unlock</button>
</form>
</section>` : '';
  page(res, 'Profile', `<h1>Profile</h1>
${error ? `<p id="flash" class="error" tabindex="-1">${esc(error)}</p>` : ''}
${unlock}
${create}
${recover}`, { status: error ? 400 : 200 });
}

function profileHome(res, s) {
  const v = s.vault;
  page(res, `Profile: ${v.name}`, `<h1>Profile: ${esc(v.name)}</h1>
${takeFlash(s)}
<p>Unlocked in this browser. It locks by itself after 15 minutes without use.</p>
<form method="post" action="/profile/lock"><button type="submit">Lock now</button></form>
<h2>Your profile</h2>
<ul>
<li><a href="/profile/edit">Edit my details</a></li>
<li><a href="/profile/signature">My signature</a></li>
<li><a href="/forms">My forms</a></li>
</ul>
<h2>Change password</h2>
<form method="post" action="/profile/password">
<div class="field"><label for="n-pw">New password</label><input type="password" id="n-pw" name="password" autocomplete="new-password" required minlength="10"></div>
<div class="field"><label for="n-pw2">Type the new password again</label><input type="password" id="n-pw2" name="password2" autocomplete="new-password" required minlength="10"></div>
<button type="submit">Change password</button>
</form>
<h2>Delete this profile</h2>
<p>This deletes the details, signature and every saved form in it. It cannot be undone.</p>
<form method="post" action="/profile/delete">
<div class="field"><label for="d-name">Type the profile name, ${esc(v.name)}, to confirm</label><input id="d-name" name="confirm" autocomplete="off" required></div>
<button type="submit">Delete profile</button>
</form>`);
}

async function editPage(res, s) {
  const prof = await s.vault.getJson('profile', { fields: {}, custom: [] });
  const groups = PROFILE_FIELDS.map((g) => {
    const items = g.items.map((f) => {
      const id = `pf-${f.id}`;
      const val = prof.fields?.[f.id] || '';
      const help = f.type === 'date' ? '<p class="help" id="' + id + '-help">Use year-month-day, for example 1990-04-12. It is changed to the format each form asks for.</p>' : '';
      const control = f.type === 'textarea'
        ? `<textarea id="${id}" name="${esc(f.id)}" rows="3">${esc(val)}</textarea>`
        : `<input id="${id}" name="${esc(f.id)}" value="${esc(val)}" autocomplete="off"${help ? ` aria-describedby="${id}-help"` : ''}>`;
      return `<div class="field"><label for="${id}">${esc(f.label)}</label>${help}${control}</div>`;
    }).join('');
    return `<fieldset><legend>${esc(g.group)}</legend>${items}</fieldset>`;
  }).join('');
  const custom = (prof.custom || []).map((c) => `${c.label}: ${c.value}`).join('\n');
  page(res, 'Edit my details', `<h1>Edit my details</h1>
${takeFlash(s)}
<p>Leave anything blank that you do not want filled in automatically. Everything here is encrypted with your password.</p>
<form method="post" action="/profile/edit">
${groups}
<fieldset><legend>Your own items</legend>
<div class="field"><label for="pf-custom">One per line, as name colon value</label><p class="help" id="pf-custom-help">For example: Student ID: 1234567. A form question that contains the name, such as "Student ID number", is filled with the value.</p>
<textarea id="pf-custom" name="custom" rows="6" aria-describedby="pf-custom-help">${esc(custom)}</textarea></div>
</fieldset>
<button type="submit">Save my details</button>
</form>`);
}

function parseCustom(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(':');
    return i > 0 ? { label: l.slice(0, i).trim().slice(0, 80), value: l.slice(i + 1).trim().slice(0, 500) } : null;
  }).filter((c) => c && c.label && c.value).slice(0, 100);
}

async function signaturePage(res, s) {
  const has = Boolean(await s.vault.get('signature'));
  const meta = await s.vault.getJson('signature-meta', {});
  page(res, 'My signature', `<h1>My signature</h1>
${takeFlash(s)}
${has ? `<p>You have a saved signature. ${esc(meta.description || '')}</p>
<p><img src="/profile/signature.png" alt="Your saved signature" class="sig"></p>
<form method="post" action="/profile/signature/delete"><button type="submit">Delete my signature</button></form>` : '<p>No signature saved yet.</p>'}
<h2>${has ? 'Replace' : 'Add'} my signature</h2>
<p>Sign on plain white paper with a dark pen, then take a photo or scan it. A black signature on a white image made on a computer works too. The paper is removed so only the ink is kept, and the background becomes see-through so it sits on the form like ink.</p>
<form method="post" action="/profile/signature" enctype="multipart/form-data">
<div class="field"><label for="sig-file">Photo or scan of your signature</label><input type="file" id="sig-file" name="file" accept="image/*,.heic,.heif,.pdf" capture="environment" required></div>
<button type="submit">Clean up and save</button>
</form>
<p>A signature is never put on a form by itself. Each form lists every place to sign, with the words you are agreeing to, and you choose each one.</p>`);
}

async function profileRoutes(req, res, p) {
  const s = sessionFor(req);
  if (req.method === 'GET' && p === '/profile') return s ? profileHome(res, s) : lockedPage(res, req);

  if (req.method === 'POST' && p === '/profile/unlock') {
    const f = await readForm(req);
    try {
      const v = await unlockProfile(str(f, 'profile', 40), str(f, 'password', 500));
      endSession(req);
      return redirect(res, safeNext(str(f, 'next', 300)), cookieFor(newSession(v)));
    } catch (err) {
      if (!err.userFacing) throw err;
      return lockedPage(res, req, err.message);
    }
  }
  if (req.method === 'POST' && p === '/profile/create') {
    const f = await readForm(req);
    try {
      if (str(f, 'password', 500) !== str(f, 'password2', 500)) throw userError('The two passwords are not the same.');
      const { recovery, vault } = await createProfile(str(f, 'name', 60), str(f, 'password', 500));
      endSession(req);
      return page(res, 'Save your recovery code', `<h1>Save your recovery code</h1>
<p>Profile ${esc(vault.name)} is made and unlocked. If you forget the password, this code is the only way to open the profile. Save it somewhere safe, such as a password manager. It is only shown now.</p>
<p>Recovery code:</p>
<p><code class="code">${esc(recovery)}</code></p>
<p>Letters and numbers only. The dashes are optional.</p>
<p><a href="/profile/edit">I have saved it. Go to my details</a></p>`, { cookie: cookieFor(newSession(vault)) });
    } catch (err) {
      if (!err.userFacing) throw err;
      return lockedPage(res, req, err.message);
    }
  }
  if (req.method === 'POST' && p === '/profile/recover') {
    const f = await readForm(req);
    try {
      if (str(f, 'password', 500) !== str(f, 'password2', 500)) throw userError('The two new passwords are not the same.');
      const v = await unlockProfile(str(f, 'profile', 40), str(f, 'code', 100), { recovery: true, newPassword: str(f, 'password', 500) });
      const token = newSession(v);
      return redirect(res, '/profile', cookieFor(token));
    } catch (err) {
      if (!err.userFacing) throw err;
      return lockedPage(res, req, err.message);
    }
  }
  if (req.method === 'POST' && p === '/profile/lock') {
    endSession(req);
    return redirect(res, '/profile', clearCookie);
  }

  if (!s) return redirect(res, `/profile?next=${encodeURIComponent(p)}`);
  const v = s.vault;

  if (req.method === 'POST' && p === '/profile/password') {
    const f = await readForm(req);
    try {
      if (str(f, 'password', 500) !== str(f, 'password2', 500)) throw userError('The two passwords are not the same.');
      await changePassword(v, str(f, 'password', 500));
      flash(s, 'Password changed. Your recovery code still works.');
    } catch (err) {
      if (!err.userFacing) throw err;
      flash(s, err.message);
    }
    return redirect(res, '/profile');
  }
  if (req.method === 'POST' && p === '/profile/delete') {
    const f = await readForm(req);
    if (str(f, 'confirm', 100).trim() !== v.name) {
      flash(s, 'The name did not match, so nothing was deleted.');
      return redirect(res, '/profile');
    }
    await deleteProfile(v);
    endSession(req);
    return redirect(res, '/profile', clearCookie);
  }
  if (req.method === 'GET' && p === '/profile/edit') return editPage(res, s);
  if (req.method === 'POST' && p === '/profile/edit') {
    const f = await readForm(req);
    const prof = await v.getJson('profile', { fields: {}, custom: [] });
    for (const item of ALL_FIELDS) {
      const val = str(f, item.id, 2000).trim();
      if (val) prof.fields[item.id] = val;
      else delete prof.fields[item.id];
    }
    prof.custom = parseCustom(str(f, 'custom', 20000));
    await v.putJson('profile', prof);
    flash(s, 'Your details are saved.');
    return redirect(res, '/profile/edit');
  }
  if (req.method === 'GET' && p === '/profile/signature') return signaturePage(res, s);
  if (req.method === 'GET' && p === '/profile/signature.png') {
    const png = await v.get('signature');
    if (!png) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(png);
  }
  if (req.method === 'POST' && p === '/profile/signature') {
    const f = await readForm(req);
    const file = f.get('file');
    const dir = await tempDir();
    try {
      if (!file || typeof file === 'string' || !file.size) throw userError('Choose a photo or scan of your signature.');
      const ext = (path.extname(file.name || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.img'])[0];
      const inPath = path.join(dir, `in${ext}`);
      await saveUpload(file, inPath);
      const { png, description } = await cleanSignature(inPath, dir);
      await v.put('signature', png);
      await v.putJson('signature-meta', { description, saved: new Date().toISOString() });
      flash(s, description);
    } catch (err) {
      if (!err.userFacing) throw err;
      flash(s, err.message);
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return redirect(res, '/profile/signature');
  }
  if (req.method === 'POST' && p === '/profile/signature/delete') {
    await v.remove('signature');
    await v.remove('signature-meta');
    flash(s, 'Signature deleted.');
    return redirect(res, '/profile/signature');
  }
  return false;
}

// ---------------------------------------------------------------- matching with AI (optional, local)

async function aiMatch(fields, profile) {
  const models = await textModels();
  const model = process.env.FORM_TEXT_MODEL || models.models?.find((m) => !m.vision)?.name || models.models?.[0]?.name;
  if (!models.running || !model) return 0;
  const info = models.models.find((m) => m.name === model);
  const open = fields.filter((f) => !f.match && ['text', 'select', 'radio'].includes(f.kind) && !f.readonly);
  if (!open.length) return 0;
  const keys = [
    ...ALL_FIELDS.map((f) => ({ key: f.id, label: `${f.label}${f.whose !== 'self' ? ` (${f.whose})` : ''}` })),
    ...(profile.custom || []).map((c, i) => ({ key: `custom:${i}`, label: c.label })),
  ];
  const system = `You match the questions on a form to items in a person's saved profile.
Only match when the question clearly asks for that item about the person filling in the form (or their spouse, employer or emergency contact when the item says so).
Questions about other people, such as a witness, child, doctor or landlord, get no match.
Answer only with JSON: {"matches":[{"id":"question id","key":"profile key"}]}. Leave out questions with no match.`;
  let n = 0;
  for (let i = 0; i < open.length; i += 40) {
    const batch = open.slice(i, i + 40).map((f) => ({ id: f.id, question: f.label, nearby: f.context || '', section: f.section || '' }));
    const prompt = `Profile items:\n${JSON.stringify(keys)}\n\nQuestions:\n${JSON.stringify(batch)}`;
    const ans = await chatJson({ model, system, prompt, schema: { type: 'object', properties: { matches: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, key: { type: 'string' } }, required: ['id', 'key'] } } }, required: ['matches'] }, thinking: info?.thinking });
    for (const m of ans?.matches || []) {
      const f = open.find((x) => x.id === m.id);
      if (f && keys.some((k) => k.key === m.key) && !f.match) {
        f.match = { key: m.key };
        f.aiMatched = true;
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- forms

async function formsIndex(v) {
  return v.getJson('forms-index', []);
}

async function saveIndex(v, list) {
  await v.putJson('forms-index', list);
}

async function loadForm(v, id) {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  return v.getJson(`form-${id}`);
}

async function saveForm(v, state) {
  state.updated = new Date().toISOString();
  await v.putJson(`form-${state.id}`, state);
  const list = await formsIndex(v);
  const entry = { id: state.id, name: state.name, updated: state.updated, status: state.result ? (state.result.ok ? 'Filled, check passed' : 'Filled, check found problems') : 'Draft' };
  const i = list.findIndex((e) => e.id === state.id);
  if (i >= 0) list[i] = entry;
  else list.unshift(entry);
  await saveIndex(v, list);
}

/** Reads the form and fills in what it can from the profile. */
async function analyzeInto(v, state, pdfBuffer, { useAi }) {
  const dir = await tempDir();
  try {
    const inPath = path.join(dir, 'form.pdf');
    await writeFile(inPath, pdfBuffer);
    await runHelper('form_tool.py', ['analyze', inPath, path.join(dir, 'a.json')]);
    const a = JSON.parse(await readFile(path.join(dir, 'a.json'), 'utf8'));
    const prof = await v.getJson('profile', { fields: {}, custom: [] });
    for (const f of a.fields) f.match = matchQuestion(f, prof);
    state.aiMatched = useAi ? await aiMatch(a.fields, prof).catch(() => 0) : 0;
    const answers = {};
    const sources = {};
    for (const f of a.fields) {
      if (f.kind === 'signature') continue;
      const existing = f.value;
      if (existing !== '' && existing !== false && existing != null) {
        answers[f.id] = existing;
        sources[f.id] = 'form';
        continue;
      }
      if (f.match) {
        const val = shapeValue(f, f.match, prof);
        if (val) {
          answers[f.id] = val;
          sources[f.id] = f.aiMatched ? 'ai' : 'profile';
        }
      }
    }
    splitAcrossBoxes(a.fields.filter((f) => sources[f.id] === 'profile' || sources[f.id] === 'ai'), answers);
    state.analysis = a;
    state.answers = answers;
    state.sources = sources;
    state.signed = {};
    state.result = null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sectionsOf(fields) {
  const order = [];
  const map = new Map();
  for (const f of fields) {
    if (f.kind === 'signature') continue;
    const k = f.section || '';
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k).push(f);
  }
  return order.map((k) => ({ name: k, fields: map.get(k) }));
}

function fieldHelp(f, state) {
  const parts = [];
  const src = state.sources?.[f.id];
  const def = f.match && (FIELD_BY_ID[f.match.key] || (f.match.key.startsWith('custom:') ? { label: 'one of your own items' } : null));
  if (src === 'profile' && def) parts.push(`Filled from your profile: ${def.label}.`);
  if (src === 'ai' && def) parts.push(`Matched by AI to your ${def.label}. Check it.`);
  if (src === 'form') parts.push('This was already filled in on the form.');
  if (f.context && f.context !== f.label) parts.push(`Wording near it: ${f.context}.`);
  if (f.match && FIELD_BY_ID[f.match.key]?.type === 'date' && !f.match.part) parts.push(`Date format: ${dateFormat(`${f.label} ${f.context || ''}`)}.`);
  if (f.maxlen) parts.push(`Up to ${f.maxlen} characters.`);
  parts.push(`Page ${f.page}.`);
  return parts.join(' ');
}

function control(f, state) {
  const id = `q-${f.id}`;
  const name = `f_${f.id}`;
  const val = state.answers?.[f.id];
  const help = fieldHelp(f, state);
  const req = f.required ? ' (required)' : '';
  const ro = f.readonly ? ' (read only)' : '';
  const helpHtml = `<p class="help" id="${id}-help">${esc(help)}</p>`;
  if (f.kind === 'checkbox') {
    return `<div class="field check"><input type="checkbox" id="${id}" name="${name}" value="1"${val === true ? ' checked' : ''}${f.readonly ? ' disabled' : ''} aria-describedby="${id}-help"><label for="${id}">${esc(f.label)}${req}${ro}</label>${helpHtml}</div>`;
  }
  if (f.kind === 'radio') {
    const opts = f.options.map((o, i) => `<div class="field check"><input type="radio" id="${id}-${i}" name="${name}" value="${esc(o.value)}"${String(val) === String(o.value) ? ' checked' : ''}${f.readonly ? ' disabled' : ''}><label for="${id}-${i}">${esc(o.label)}</label></div>`).join('');
    const none = `<div class="field check"><input type="radio" id="${id}-none" name="${name}" value=""${!val ? ' checked' : ''}><label for="${id}-none">No answer</label></div>`;
    return `<fieldset aria-describedby="${id}-help"><legend>${esc(f.label)}${req}</legend>${helpHtml}${opts}${none}</fieldset>`;
  }
  if (f.kind === 'select') {
    const opts = ['', ...f.options].map((o) => `<option value="${esc(o)}"${String(val || '') === o ? ' selected' : ''}>${o ? esc(o) : 'No answer'}</option>`).join('');
    return `<div class="field"><label for="${id}">${esc(f.label)}${req}${ro}</label>${helpHtml}<select id="${id}" name="${name}" aria-describedby="${id}-help"${f.readonly ? ' disabled' : ''}>${opts}</select></div>`;
  }
  const max = f.maxlen ? ` maxlength="${f.maxlen}"` : '';
  const input = f.multiline
    ? `<textarea id="${id}" name="${name}" rows="4"${max} aria-describedby="${id}-help"${f.readonly ? ' readonly' : ''}>${esc(val || '')}</textarea>`
    : `<input id="${id}" name="${name}" value="${esc(val || '')}"${max} autocomplete="off" class="wide" aria-describedby="${id}-help"${f.readonly ? ' readonly' : ''}>`;
  return `<div class="field"><label for="${id}">${esc(f.label)}${req}${ro}</label>${helpHtml}${input}</div>`;
}

function counts(state) {
  const q = state.analysis.fields.filter((f) => f.kind !== 'signature');
  const filled = q.filter((f) => { const v = state.answers?.[f.id]; return v !== undefined && v !== '' && v !== false; });
  return {
    total: q.length,
    profile: q.filter((f) => state.sources?.[f.id] === 'profile' || state.sources?.[f.id] === 'ai').length,
    form: q.filter((f) => state.sources?.[f.id] === 'form').length,
    empty: q.length - filled.length,
    requiredEmpty: q.filter((f) => f.required && !filled.includes(f)).length,
    sigs: state.analysis.fields.filter((f) => f.kind === 'signature').length,
  };
}

function resultHtml(state) {
  const r = state.result;
  if (!r) return '';
  const checks = r.checks.map((c) => `<li>${c.ok ? 'Passed' : 'Failed'}: ${esc(c.name)}.</li>`).join('');
  const changed = r.pagesChanged?.length ? `<p>Pages with changes outside your answers: ${esc(r.pagesChanged.join(', '))}. Do not send this file before checking those pages.</p>` : '';
  const mism = r.mismatch?.length ? `<h3>Answers that did not save correctly</h3><ul>${r.mismatch.map((m) => `<li>${esc(m.label)}: should be ${esc(m.want)}, the file has ${esc(m.got)}.</li>`).join('')}</ul>` : '';
  const reqEmpty = r.requiredEmpty?.length ? `<h3>Required questions still empty</h3><ul>${r.requiredEmpty.map((m) => `<li>Page ${esc(m.page)}: ${esc(m.name)}.</li>`).join('')}</ul>` : '';
  const xfa = state.xfaRemoved ? '<p>Note: this was checked against the form after its XFA part was removed, because you chose to remove it.</p>' : '';
  const weak = r.incremental === false ? '<p>Note: the answers could not be added on to the original file, so the file was saved as a whole. The page check still compares how every page looks.</p>' : '';
  return `<section aria-labelledby="result-h" id="result">
<h2 id="result-h" tabindex="-1">Filled PDF</h2>
<p>${r.ok ? 'Check passed. Only your answers and signatures were added.' : 'The check found problems. Details are below.'}</p>
<ul>${checks}</ul>
${changed}${mism}${reqEmpty}${xfa}${weak}
<ul>
<li><a href="/forms/${esc(state.id)}/filled.pdf">Download the filled PDF</a></li>
<li><a href="/forms/${esc(state.id)}/summary.html">Open a summary of every question and answer</a></li>
</ul>
${saveToProfileHtml(state)}
</section>`;
}

function saveToProfileCandidates(state) {
  const out = [];
  const dateFields = new Set(state.analysis.fields.map((f) => f.dateField).filter(Boolean));
  for (const f of state.analysis.fields) {
    if (dateFields.has(f.id) || /\bdate\b|\bdated\b/i.test(f.label)) continue;
    const val = state.answers?.[f.id];
    if (typeof val !== 'string' || !val.trim() || state.sources?.[f.id] === 'form') continue;
    if (f.match && !f.match.part && !f.match.key.startsWith('custom:') && FIELD_BY_ID[f.match.key]) {
      const now = state.profileSnapshot?.[f.match.key] || '';
      if (now.replace(/\s/g, '') !== val.replace(/\s/g, '') && FIELD_BY_ID[f.match.key].type !== 'date') out.push({ fid: f.id, key: f.match.key, label: FIELD_BY_ID[f.match.key].label, val, now });
    } else if (!f.match && f.kind === 'text' && val.length <= 200) {
      out.push({ fid: f.id, key: '', label: f.label, val, now: '' });
    }
  }
  return out.slice(0, 40);
}

function saveToProfileHtml(state) {
  const c = saveToProfileCandidates(state);
  if (!c.length) return '';
  const items = c.map((x, i) => `<div class="field check"><input type="checkbox" id="sp-${i}" name="save" value="${esc(x.fid)}"${x.key && !x.now ? ' checked' : ''}><label for="sp-${i}">${x.key
    ? `Save "${esc(x.val)}" as your ${esc(x.label)}${x.now ? `, replacing "${esc(x.now)}"` : ''}`
    : `Save "${esc(x.val)}" as a new item named ${esc(x.label)}`}</label></div>`).join('');
  return `<h3>Save answers to your profile</h3>
<p>These answers are not in your profile yet, or are different. Tick the ones to keep for next time.</p>
<form method="post" action="/forms/${esc(state.id)}/profile-save">${items}<button type="submit">Save ticked answers</button></form>`;
}

async function formPage(res, s, state) {
  const a = state.analysis;
  const c = counts(state);
  const hasSig = Boolean(await s.vault.get('signature'));
  const xfa = a.xfa ? `<section aria-labelledby="xfa-h"><h2 id="xfa-h">This form has an XFA part</h2>
<p>XFA forms are built for Adobe Reader. ${a.hasWidgets ? 'This one also has normal form fields, which are what you fill in here. Other programs may still show the XFA version, which would not show your answers.' : 'This one has no normal form fields, so it cannot be filled here. Ask for a fillable PDF or use the online version if there is one.'}</p>
<p>You can remove the XFA part so every program shows the normal form fields. This changes the file a little, and the check afterwards compares against the changed file. The original is kept.</p>
<form method="post" action="/forms/${esc(state.id)}/remove-xfa"><button type="submit">Remove the XFA part</button></form></section>` : '';
  const flat = a.flat ? '<p>This form has no real form fields, so the blanks were found from lines and boxes on the page. Your answers are written on top of the page in those places. Check the filled PDF, because blanks can be missed or misplaced.</p>' : '';
  const existing = a.existing.length ? `<section aria-labelledby="ex-h"><h2 id="ex-h">Already on the form</h2>
<ul>${a.existing.map((e) => `<li>Page ${esc(e.page)}: ${esc(e.text)}${state.readings?.[e.id] ? ` AI reading: ${esc(state.readings[e.id])}` : ''}</li>`).join('')}</ul>
${a.existing.some((e) => e.kind !== 'answer' && e.kind !== 'note') ? `<form method="post" action="/forms/${esc(state.id)}/read"><button type="submit">Read handwriting and pictures with AI</button></form><p>Uses a vision model in Ollama on your own computer or server. Nothing is sent to the internet.</p>` : ''}
</section>` : '';
  const sections = sectionsOf(a.fields).map((sec) => {
    const note = sec.name && a.notes?.[sec.name] ? `<p class="note">${esc(a.notes[sec.name])}</p>` : '';
    return `<h2>${esc(sec.name || 'Start of the form')}</h2>\n${note}\n${sec.fields.map((f) => control(f, state)).join('\n')}`;
  }).join('\n');
  const sigFields = a.fields.filter((f) => f.kind === 'signature');
  const sigs = sigFields.length ? `<h2>Signatures</h2>
${hasSig ? '<p>Tick each place you want your signature. Nothing is signed unless you tick it.</p>' : '<p>You have no saved signature. <a href="/profile/signature">Add your signature</a> first, then come back.</p>'}
${sigFields.map((f) => {
    const dateF = f.dateField && a.fields.find((g) => g.id === f.dateField);
    return `<fieldset><legend>${esc(f.label)}, page ${esc(f.page)}</legend>
${f.attestation ? `<p>What you are signing:</p><blockquote>${esc(f.attestation)}</blockquote>` : '<p>No wording was found above this spot. Check the PDF to see what it is for.</p>'}
<div class="field check"><input type="checkbox" id="sig-${esc(f.id)}" name="sign_${esc(f.id)}" value="1"${state.signed?.[f.id] ? ' checked' : ''}${hasSig ? '' : ' disabled'}><label for="sig-${esc(f.id)}">Sign here: ${esc(f.label)}</label></div>
${dateF ? `<p>The date next to it, ${esc(dateF.label)}, is filled with today's date if you leave it empty.</p>` : ''}
</fieldset>`;
  }).join('\n')}` : '';
  page(res, state.name, `<h1>${esc(state.name)}</h1>
${takeFlash(s)}
<p>${c.total} questions. ${c.profile} filled from your profile, ${c.form} already filled on the form, ${c.empty} empty${c.requiredEmpty ? `, of which ${c.requiredEmpty} required` : ''}. ${c.sigs ? `${c.sigs} ${c.sigs === 1 ? 'place' : 'places'} to sign.` : ''}${state.aiMatched ? ` ${state.aiMatched} were matched by AI, so check those.` : ''}</p>
${flat}
${xfa}
${resultHtml(state)}
${existing}
<form method="post" action="/forms/${esc(state.id)}/save" id="fill-form">
${sections}
${sigs}
<h2>Finish</h2>
<p>Save keeps your answers so you can come back. Make filled PDF also saves, then makes the PDF and checks it.</p>
<button type="submit" name="action" value="save">Save answers</button>
<button type="submit" name="action" value="build">Make filled PDF</button>
</form>
<h2>This form</h2>
<ul><li><a href="/forms/${esc(state.id)}/original.pdf">Download the blank original</a></li></ul>
<form method="post" action="/forms/${esc(state.id)}/delete"><button type="submit">Delete this form and its answers</button></form>`);
}

function readAnswers(form, state) {
  for (const f of state.analysis.fields) {
    if (f.kind === 'signature' || f.readonly) continue;
    const raw = form.get(`f_${f.id}`);
    const old = state.answers[f.id];
    let val;
    if (f.kind === 'checkbox') val = raw != null;
    else val = typeof raw === 'string' ? raw.slice(0, 5000) : '';
    if (f.kind === 'radio' && val && !f.options.some((o) => o.value === val)) val = '';
    if (f.kind === 'select' && val && !f.options.includes(val)) val = '';
    if (val !== old && !(old === undefined && (val === '' || val === false))) {
      if (state.sources[f.id] && String(old) !== String(val)) state.sources[f.id] = 'you';
      state.answers[f.id] = val;
    }
  }
  state.signed = {};
  for (const f of state.analysis.fields) {
    if (f.kind === 'signature' && form.get(`sign_${f.id}`) != null) state.signed[f.id] = true;
  }
}

async function buildAndCheck(v, state) {
  // Fill the form, then check that nothing else changed.
  const pdf = await v.get(`form-${state.id}-pdf`);
  const sig = await v.get('signature');
  const dir = await tempDir();
  try {
    const inPath = path.join(dir, 'form.pdf');
    const outPath = path.join(dir, 'filled.pdf');
    const sigPath = path.join(dir, 'sig.png');
    const planPath = path.join(dir, 'plan.json');
    await writeFile(inPath, pdf);
    if (sig) await writeFile(sigPath, sig);
    const a = state.analysis;
    const plan = { fields: [], signatures: [], signaturePng: sigPath };
    const answers = { ...state.answers };
    for (const f of a.fields) {
      if (f.kind !== 'signature' || !state.signed?.[f.id]) continue;
      if (!sig) throw userError('You ticked a place to sign, but there is no saved signature. Add your signature first.');
      plan.signatures.push({ page: f.page, rect: f.rect, flat: Boolean(f.flat || f.textSignature) });
      const d = f.dateField && a.fields.find((g) => g.id === f.dateField);
      if (d && !answers[d.id]) {
        answers[d.id] = today(dateFormat(`${d.label} ${d.context || ''}`));
        state.answers[d.id] = answers[d.id];
      }
    }
    for (const f of a.fields) {
      if (f.kind === 'signature' || f.readonly) continue;
      const val = answers[f.id];
      const orig = f.value;
      if (val === undefined || val === '' || val === orig) continue;
      if (f.kind === 'checkbox' && !val && !orig) continue;
      const base = { kind: f.kind, value: val, label: f.label };
      if (f.flat) plan.fields.push({ ...base, flat: true, page: f.page, rect: f.rect, multiline: f.multiline });
      else if (f.kind === 'radio') plan.fields.push({ ...base, widgets: f.widgets });
      else plan.fields.push({ ...base, xref: f.xref });
    }
    await writeFile(planPath, JSON.stringify(plan));
    const filled = await runHelper('form_tool.py', ['fill', inPath, planPath, outPath]);
    plan.touched = filled?.touched || [];
    await writeFile(planPath, JSON.stringify(plan));
    const reportPath = path.join(dir, 'report.json');
    await runHelper('form_tool.py', ['verify', inPath, outPath, planPath, reportPath]);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    report.incremental = filled?.incremental;
    await v.put(`form-${state.id}-filled`, await readFile(outPath));
    state.result = report;
    state.profileSnapshot = Object.fromEntries(ALL_FIELDS.map((f) => [f.id, '']));
    const prof = await v.getJson('profile', { fields: {}, custom: [] });
    for (const f of ALL_FIELDS) state.profileSnapshot[f.id] = profileValue(prof, f.id);
    return report;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function summaryHtml(state) {
  const a = state.analysis;
  const secs = sectionsOf(a.fields).map((sec) => `<h2>${esc(sec.name || 'Start of the form')}</h2>
<ul>${sec.fields.map((f) => {
    const v = state.answers?.[f.id];
    let shown = v === true ? 'Ticked' : v === false || v === undefined || v === '' ? 'Empty' : String(v);
    if (f.kind === 'radio' && v) shown = f.options.find((o) => o.value === v)?.label || shown;
    return `<li>${esc(f.label)}: ${esc(shown)}</li>`;
  }).join('')}</ul>`).join('\n');
  const sigs = a.fields.filter((f) => f.kind === 'signature');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(state.name)}: answers</title>
<style>body{font-family:system-ui,sans-serif;font-size:1.125rem;line-height:1.5;max-width:46rem;margin:0 auto;padding:1rem}@media (prefers-color-scheme: dark){body{background:#121212;color:#f2f2f2}}</style></head>
<body><h1>${esc(state.name)}: answers</h1>
${secs}
${sigs.length ? `<h2>Signatures</h2><ul>${sigs.map((f) => `<li>${esc(f.label)}, page ${esc(f.page)}: ${state.signed?.[f.id] ? 'Signed' : 'Not signed'}</li>`).join('')}</ul>` : ''}
</body></html>`;
}

async function readExisting(v, state) {
  const vm = await visionModels();
  const model = process.env.FORM_VISION_MODEL || vm.models?.[0]?.name;
  if (!vm.running || !model) throw userError('Reading handwriting needs an AI model that can see pictures. Check the Status page, or add one with ./models.sh on the server.');
  const info = vm.models.find((m) => m.name === model);
  const pdf = await v.get(`form-${state.id}-pdf`);
  const dir = await tempDir();
  try {
    const inPath = path.join(dir, 'form.pdf');
    await writeFile(inPath, pdf);
    state.readings = state.readings || {};
    for (const e of state.analysis.existing.filter((x) => x.kind !== 'answer' && x.kind !== 'note').slice(0, 20)) {
      const png = path.join(dir, `${e.id}.png`);
      await runHelper('form_tool.py', ['crop', inPath, String(e.page), ...e.rect.map(String), png]);
      const ans = await chatJson({
        model, thinking: info?.thinking,
        system: 'You read what is written or drawn in a picture cut from a form, for a blind person. Copy handwriting and printed text exactly. If it is a signature, say whose name it seems to be if readable. If part is unreadable, write [unreadable]. Do not guess beyond what is visible. Answer only with JSON.',
        prompt: 'What is in this picture?',
        imageBase64: (await readFile(png)).toString('base64'),
        schema: { type: 'object', properties: { kind: { type: 'string', enum: ['handwriting', 'signature', 'printed text', 'check mark', 'drawing or logo', 'blank'] }, text: { type: 'string' } }, required: ['kind', 'text'] },
      });
      if (ans) state.readings[e.id] = `${ans.kind}${ans.text ? `: ${ans.text}` : ''}.`;
    }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function formsList(res, s) {
  const list = await formsIndex(s.vault);
  const ai = await textModels();
  page(res, 'My forms', `<h1>My forms</h1>
${takeFlash(s)}
<h2>Fill in a new form</h2>
<form method="post" action="/forms" enctype="multipart/form-data">
<div class="field"><label for="form-file">Form</label><p class="help" id="form-file-help">A PDF works best, especially a fillable one. Pictures and Word files are turned into a PDF first.</p><input type="file" id="form-file" name="file" required aria-describedby="form-file-help" accept=".pdf,application/pdf,image/*,.doc,.docx,.odt,.rtf"></div>
<div class="field check"><input type="checkbox" id="ai" name="ai" value="1"${ai.running && ai.models.length ? ' checked' : ' disabled'}><label for="ai">Also use AI to match questions to your profile</label><p class="help">Only the wording of the questions is sent to the AI, which runs on your own computer or server. Your answers are not.${ai.running && ai.models.length ? '' : ' Not available: Ollama is not running or has no models.'}</p></div>
<button type="submit">Read the form</button>
</form>
<h2>Saved forms</h2>
${list.length ? `<ul class="menu-list">${list.map((e) => `<li><a href="/forms/${esc(e.id)}">${esc(e.name)}</a>. ${esc(e.status)}. Last changed ${esc(new Date(e.updated).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }))}.</li>`).join('')}</ul>` : '<p>None yet.</p>'}`);
}

async function formRoutes(req, res, p) {
  const s = sessionFor(req);
  if (!s) return redirect(res, `/profile?next=${encodeURIComponent(p)}`);
  const v = s.vault;
  let m;
  if (req.method === 'GET' && p === '/forms') return formsList(res, s);
  if (req.method === 'POST' && p === '/forms') {
    const f = await readForm(req);
    const file = f.get('file');
    const dir = await tempDir();
    try {
      if (!file || typeof file === 'string' || !file.size) throw userError('Choose a form to fill in.');
      const ext = (path.extname(file.name || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [''])[0];
      const inPath = path.join(dir, `input${ext}`);
      await saveUpload(file, inPath);
      const ctx = { input: { path: inPath, ext, name: file.name }, workDir: dir, progress() {}, run: (c, a, o) => run(c, a, o) };
      const pdfPath = await toPdf(ctx);
      const pdf = await readFile(pdfPath);
      const id = crypto.randomBytes(6).toString('hex');
      const state = { id, name: (file.name || 'Form').replace(/\.[^.]+$/, '').slice(0, 120), created: new Date().toISOString(), answers: {}, sources: {}, signed: {} };
      await v.put(`form-${id}-pdf`, pdf);
      await analyzeInto(v, state, pdf, { useAi: f.get('ai') != null });
      if (state.analysis.title) state.name = state.analysis.title.slice(0, 120);
      await saveForm(v, state);
      const c = counts(state);
      flash(s, `Read ${state.name}: ${c.total} questions, ${c.profile} filled from your profile.`);
      return redirect(res, `/forms/${id}`);
    } catch (err) {
      if (!err.userFacing) throw err;
      flash(s, err.message);
      return redirect(res, '/forms');
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!(m = p.match(/^\/forms\/([a-f0-9]{12})(\/[\w.-]+)?$/))) return false;
  const state = await loadForm(v, m[1]);
  if (!state) {
    flash(s, 'That form no longer exists.');
    return redirect(res, '/forms');
  }
  const action = m[2] || '';
  if (req.method === 'GET' && action === '') return formPage(res, s, state);
  if (req.method === 'POST' && action === '/save') {
    const f = await readForm(req);
    readAnswers(f, state);
    if (str(f, 'action') === 'build') {
      try {
        const r = await buildAndCheck(v, state);
        await saveForm(v, state);
        flash(s, r.ok ? 'Filled PDF made. Check passed. The download link is under the Filled PDF heading.' : 'Filled PDF made, but the check found problems. Details are under the Filled PDF heading.');
        return redirect(res, `/forms/${state.id}`);
      } catch (err) {
        if (!err.userFacing) throw err;
        await saveForm(v, state);
        flash(s, `Your answers are saved, but the PDF could not be made. ${err.message}`);
        return redirect(res, `/forms/${state.id}`);
      }
    }
    await saveForm(v, state);
    flash(s, 'Answers saved.');
    return redirect(res, `/forms/${state.id}`);
  }
  if (req.method === 'POST' && action === '/remove-xfa') {
    const pdf = await v.get(`form-${state.id}-pdf`);
    const dir = await tempDir();
    try {
      await writeFile(path.join(dir, 'in.pdf'), pdf);
      await runHelper('form_tool.py', ['remove-xfa', path.join(dir, 'in.pdf'), path.join(dir, 'out.pdf')]);
      if (!(await v.get(`form-${state.id}-xfa`))) await v.put(`form-${state.id}-xfa`, pdf);
      const out = await readFile(path.join(dir, 'out.pdf'));
      await v.put(`form-${state.id}-pdf`, out);
      const keep = state.answers;
      await analyzeInto(v, state, out, { useAi: false });
      for (const [k, val] of Object.entries(keep)) if (state.analysis.fields.some((x) => x.id === k)) state.answers[k] = val;
      state.xfaRemoved = true;
      await saveForm(v, state);
      flash(s, 'The XFA part was removed. The original is kept and can still be downloaded.');
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return redirect(res, `/forms/${state.id}`);
  }
  if (req.method === 'POST' && action === '/read') {
    try {
      await readExisting(v, state);
      await saveForm(v, state);
      flash(s, 'AI readings added under the Already on the form heading. AI can misread handwriting, so treat them as a guide.');
    } catch (err) {
      if (!err.userFacing) throw err;
      flash(s, err.message);
    }
    return redirect(res, `/forms/${state.id}`);
  }
  if (req.method === 'POST' && action === '/profile-save') {
    const f = await readForm(req);
    const chosen = new Set(f.getAll('save').map(String));
    const prof = await v.getJson('profile', { fields: {}, custom: [] });
    let n = 0;
    for (const c of saveToProfileCandidates(state)) {
      if (!chosen.has(c.fid)) continue;
      if (c.key) prof.fields[c.key] = c.val;
      else prof.custom = [...(prof.custom || []).filter((x) => x.label.toLowerCase() !== c.label.toLowerCase()), { label: c.label.slice(0, 80), value: c.val }];
      n++;
    }
    await v.putJson('profile', prof);
    for (const fdef of ALL_FIELDS) state.profileSnapshot[fdef.id] = profileValue(prof, fdef.id);
    await saveForm(v, state);
    flash(s, n ? `Saved ${n} ${n === 1 ? 'answer' : 'answers'} to your profile.` : 'Nothing was ticked, so nothing was saved.');
    return redirect(res, `/forms/${state.id}`);
  }
  if (req.method === 'POST' && action === '/delete') {
    for (const item of ['', '-pdf', '-xfa', '-filled']) await v.remove(`form-${state.id}${item}`);
    await saveIndex(v, (await formsIndex(v)).filter((e) => e.id !== state.id));
    flash(s, `Deleted ${state.name}.`);
    return redirect(res, '/forms');
  }
  const sendFile = (buf, name, type, inline = false) => {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(inline ? { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
    });
    res.end(buf);
  };
  if (req.method === 'GET' && action === '/filled.pdf') {
    const b = await v.get(`form-${state.id}-filled`);
    if (!b) return redirect(res, `/forms/${state.id}`);
    return sendFile(b, `${state.name}-filled.pdf`, 'application/pdf');
  }
  if (req.method === 'GET' && action === '/original.pdf') {
    const b = (await v.get(`form-${state.id}-xfa`)) || (await v.get(`form-${state.id}-pdf`));
    return sendFile(b, `${state.name}.pdf`, 'application/pdf');
  }
  if (req.method === 'GET' && action === '/summary.html') return sendFile(Buffer.from(summaryHtml(state)), `${state.name}-answers.html`, 'text/html; charset=utf-8', true);
  return false;
}

/** Handles /profile and /forms. Returns false if the address is not one of ours. */
export async function formsAndProfile(req, res, p) {
  try {
    if (p === '/profile' || p.startsWith('/profile/')) return await profileRoutes(req, res, p);
    if (p === '/forms' || p.startsWith('/forms/')) return await formRoutes(req, res, p);
    return false;
  } catch (err) {
    if (!err.userFacing || res.headersSent) throw err;
    const back = p.startsWith('/forms') ? '/forms' : '/profile';
    return page(res, 'Could not do that', `<h1>Could not do that</h1>\n<p id="flash" tabindex="-1">${esc(err.message)}</p>\n<p><a href="${back}">Go back</a></p>`, { status: err.status || 400 });
  }
}

/** With REQUIRE_LOGIN=1, every page except /profile needs an unlocked profile. */
export function loginGate(req, res, p) {
  if (process.env.REQUIRE_LOGIN !== '1') return false;
  if (p === '/profile' || p.startsWith('/profile/') || p.startsWith('/static/') || p === '/favicon.ico') return false;
  if (sessionFor(req)) return false;
  redirect(res, `/profile?next=${encodeURIComponent(p)}`);
  return true;
}
