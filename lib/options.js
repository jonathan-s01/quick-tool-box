// Turns a tool's option list into form fields, and reads/validates submitted values.
// remember: true keeps a text or textarea value in this browser (localStorage) for next time.
// Option types: select, checkbox, number, text, url, textarea. Options with the same "group" share a fieldset.
import { esc } from './html.js';
import { userError } from './system.js';

function fieldId(opt) {
  return `opt-${opt.id}`;
}

function helpAttr(opt) {
  return opt.help ? ` aria-describedby="${fieldId(opt)}-help"` : '';
}

function helpText(opt) {
  return opt.help ? `<p class="help" id="${fieldId(opt)}-help">${esc(opt.help)}</p>` : '';
}

function renderOne(opt) {
  const id = fieldId(opt);
  if (opt.type === 'select') {
    const choices = opt.choices
      .map((c) => `<option value="${esc(c.value)}"${c.value === opt.default ? ' selected' : ''}>${esc(c.label)}</option>`)
      .join('');
    return `<div class="field"><label for="${id}">${esc(opt.label)}</label>${helpText(opt)}<select id="${id}" name="${esc(opt.id)}"${helpAttr(opt)}>${choices}</select></div>`;
  }
  if (opt.type === 'checkbox') {
    return `<div class="field check"><input type="checkbox" id="${id}" name="${esc(opt.id)}"${opt.default ? ' checked' : ''}${helpAttr(opt)}><label for="${id}">${esc(opt.label)}</label>${helpText(opt)}</div>`;
  }
  if (opt.type === 'number') {
    const attrs = [
      opt.min != null ? `min="${opt.min}"` : '',
      opt.max != null ? `max="${opt.max}"` : '',
      opt.default != null ? `value="${esc(opt.default)}"` : '',
    ].filter(Boolean).join(' ');
    return `<div class="field"><label for="${id}">${esc(opt.label)}</label>${helpText(opt)}<input type="number" inputmode="numeric" step="1" id="${id}" name="${esc(opt.id)}" ${attrs}${opt.optional ? '' : ' required'}${helpAttr(opt)}></div>`;
  }
  if (opt.type === 'text' || opt.type === 'url') {
    const attrs = [
      `type="${opt.type === 'url' ? 'url' : 'text'}"`,
      opt.type === 'url' ? 'inputmode="url" autocomplete="url" spellcheck="false"' : '',
      opt.maxLength ? `maxlength="${opt.maxLength}"` : '',
      opt.default ? `value="${esc(opt.default)}"` : '',
      opt.optional ? '' : 'required',
    ].filter(Boolean).join(' ');
    return `<div class="field"><label for="${id}">${esc(opt.label)}${opt.optional ? ' (optional)' : ''}</label>${helpText(opt)}<input id="${id}" name="${esc(opt.id)}" class="wide"${opt.remember ? ' data-remember="1"' : ''} ${attrs}${helpAttr(opt)}></div>`;
  }
  if (opt.type === 'textarea') {
    return `<div class="field"><label for="${id}">${esc(opt.label)}${opt.optional ? ' (optional)' : ''}</label>${helpText(opt)}<textarea id="${id}" name="${esc(opt.id)}"${opt.remember ? ' data-remember="1"' : ''} rows="${opt.rows || 8}"${opt.maxLength ? ` maxlength="${opt.maxLength}"` : ''}${opt.optional ? '' : ' required'}${helpAttr(opt)}>${esc(opt.default || '')}</textarea></div>`;
  }
  throw new Error(`Unknown option type: ${opt.type}`);
}

export function renderOptions(options) {
  let html = '';
  let i = 0;
  while (i < options.length) {
    const group = options[i].group;
    if (!group) {
      html += renderOne(options[i++]);
      continue;
    }
    let inner = '';
    while (i < options.length && options[i].group === group) inner += renderOne(options[i++]);
    html += `<fieldset><legend>${esc(group)}</legend>${inner}</fieldset>`;
  }
  return html;
}

/** Reads options from submitted FormData. Throws a user-facing error if something is invalid. */
export function readOptions(options, form) {
  const values = {};
  for (const opt of options) {
    try {
      readOne(opt);
    } catch (err) {
      if (err.userFacing && !err.field) err.field = opt.id;
      throw err;
    }
  }
  return values;

  function readOne(opt) {
    const raw = form.get(opt.id);
    if (opt.type === 'checkbox') {
      values[opt.id] = raw != null;
    } else if (opt.type === 'select') {
      const v = raw == null ? opt.default : String(raw);
      // allowAny: AI model lists can change between loading the page and starting (for example the Mac
      // went to sleep). Accept any model name; the AI layer then uses the best model that is available.
      const anyOk = opt.allowAny && /^[\w.:/@+-]{1,160}$/.test(v);
      if (!opt.choices.some((c) => c.value === v) && !anyOk) throw userError(`${opt.label}: please choose one of the listed options.`);
      values[opt.id] = v;
    } else if (opt.type === 'number') {
      const s = raw == null ? '' : String(raw).trim();
      if (s === '') {
        if (opt.optional) { values[opt.id] = null; return; }
        if (opt.default == null) throw userError(`${opt.label} is required.`);
        values[opt.id] = opt.default;
        return;
      }
      const n = Number(s);
      const range = `${opt.min ?? ''}${opt.max != null ? ` to ${opt.max}` : ''}`;
      if (!Number.isInteger(n) || (opt.min != null && n < opt.min) || (opt.max != null && n > opt.max)) {
        throw userError(`${opt.label} must be a whole number${range ? ` from ${range}` : ''}.`);
      }
      values[opt.id] = n;
    } else if (opt.type === 'text' || opt.type === 'url' || opt.type === 'textarea') {
      let v = raw == null || typeof raw !== 'string' ? '' : raw;
      if (opt.type !== 'textarea') v = v.trim();
      if (!v.trim()) {
        if (!opt.optional) throw userError(`${opt.label} is required.`);
        values[opt.id] = '';
        return;
      }
      if (opt.maxLength && v.length > opt.maxLength) throw userError(`${opt.label} is too long. The limit is ${opt.maxLength.toLocaleString('en-CA')} characters.`);
      if (opt.type === 'url') {
        let u;
        try { u = new URL(v); } catch { throw userError(`${opt.label} must be a full web address starting with https:// or http://.`); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw userError(`${opt.label} must start with https:// or http://.`);
        v = u.href;
      }
      values[opt.id] = v;
    }
  }
}
