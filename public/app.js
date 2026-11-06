// Runs a tool job without leaving the page.
// Screen readers hear only two messages: when a job starts and when it finishes.
// The progress bar is never announced, but you can move to it at any time.
(() => {
  const form = document.getElementById('tool-form');
  if (!form) return;

  const $ = (id) => document.getElementById(id);
  const toolId = form.dataset.tool;
  const toolName = form.dataset.toolName;
  const statusEl = $('status');
  const jobEl = $('job');
  const progress = $('progress');
  const progressText = $('progress-text');
  const cancelBtn = $('cancel');
  const results = $('results');
  const resultList = $('result-list');
  const resultMessage = $('result-message');
  const details = $('details');
  const detailsText = $('details-text');
  const formError = $('form-error');
  const startBtn = $('start');
  const baseTitle = document.title;

  let jobId = null;
  let running = false;
  const params = new URLSearchParams(location.search);
  const openWhenDone = params.get('open') === '1';
  const reviewForm = $('review');
  const resultLinks = $('result-links');

  // Fields marked "remember" keep their value in this browser only.
  const rememberKey = (el) => `quick-tool-box:${toolId}:${el.name}`;
  for (const el of form.querySelectorAll('[data-remember]')) {
    try {
      const saved = localStorage.getItem(rememberKey(el));
      if (saved != null && !el.value) el.value = saved;
    } catch { /* storage blocked */ }
  }
  function saveRemembered() {
    for (const el of form.querySelectorAll('[data-remember]')) {
      try {
        if (el.value.trim()) localStorage.setItem(rememberKey(el), el.value);
        else localStorage.removeItem(rememberKey(el));
      } catch { /* storage blocked */ }
    }
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') node.textContent = v;
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v);
    }
    node.append(...children.filter(Boolean));
    return node;
  }

  /** Shows the list of choices for tools with a second step (for example the redactor). */
  function showReview(review) {
    reviewForm.replaceChildren();
    reviewForm.append(el('h3', { id: 'review-h', text: review.heading }), el('p', { text: review.intro }));
    for (const group of review.groups) {
      const fs = el('fieldset', {}, el('legend', { text: `${group.name}, ${group.items.length}` }));
      for (const item of group.items) {
        const id = `rv-${item.id}`;
        const box = el('input', { type: 'checkbox', id, value: item.id });
        box.checked = item.checked;
        const wrap = el('div', { class: 'field check item' }, box, el('label', { for: id, text: item.label }));
        if (item.detail) {
          wrap.append(el('p', { class: 'help', id: `${id}-d`, text: item.detail }));
          box.setAttribute('aria-describedby', `${id}-d`);
        }
        fs.append(wrap);
      }
      reviewForm.append(fs);
    }
    reviewForm.append(
      el('div', { class: 'field' },
        el('label', { for: 'rv-extra', text: review.extraRequired ? review.extraLabel : `${review.extraLabel} (optional)` }),
        el('p', { class: 'help', id: 'rv-extra-help', text: review.extraHelp }),
        el('textarea', { id: 'rv-extra', rows: '3', 'aria-describedby': 'rv-extra-help' })),
      el('p', { id: 'review-error', class: 'error', tabindex: '-1', hidden: true }),
      el('button', { type: 'submit', id: 'review-go', text: review.submitLabel }),
    );
    reviewForm.hidden = false;
  }

  reviewForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running) return;
    const errEl = $('review-error');
    errEl.hidden = true;
    const selected = [...reviewForm.querySelectorAll('input[type=checkbox]:checked')].map((b) => b.value);
    const extra = $('rv-extra').value;
    let res;
    let data;
    try {
      res = await fetch(`/api/jobs/${jobId}/continue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected, extra }) });
      data = await res.json();
    } catch {
      res = { ok: false };
      data = { error: 'Could not reach the server.' };
    }
    if (!res.ok) {
      errEl.textContent = data.error;
      errEl.hidden = false;
      errEl.focus();
      return;
    }
    reviewForm.hidden = true;
    results.hidden = true;
    setBusy(true);
    jobId = data.id;
    cancelBtn.hidden = false;
    document.title = `Running: ${baseTitle}`;
    announce('Started.');
    showProgress(data.progress);
    $('job-h').focus();
    setTimeout(poll, 500);
  });

  function announce(message) {
    // Clear first so the same message is still read if it repeats.
    statusEl.textContent = '';
    setTimeout(() => { statusEl.textContent = message; }, 150);
  }

  function setBusy(busy) {
    running = busy;
    if (busy) startBtn.setAttribute('aria-disabled', 'true');
    else startBtn.removeAttribute('aria-disabled');
  }

  function clearFormError() {
    formError.hidden = true;
    formError.textContent = '';
    for (const el of form.querySelectorAll('[aria-invalid]')) {
      el.removeAttribute('aria-invalid');
      const ids = (el.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== 'form-error');
      if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
      else el.removeAttribute('aria-describedby');
    }
  }

  function showFieldError(field, message) {
    formError.textContent = message;
    formError.hidden = false;
    field.setAttribute('aria-invalid', 'true');
    const ids = (field.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
    field.setAttribute('aria-describedby', ['form-error', ...ids].join(' '));
    field.focus();
  }

  function showFormError(message) {
    formError.textContent = message;
    formError.hidden = false;
    formError.focus();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showProgress(p) {
    if (p.value == null || !p.max) {
      progress.removeAttribute('value'); // "working" with no known amount
    } else {
      progress.max = p.max;
      progress.value = p.value;
    }
    progressText.textContent = p.text || '';
  }

  function finish(data) {
    setBusy(false);
    const cancelHadFocus = document.activeElement === cancelBtn;
    cancelBtn.hidden = true;
    cancelBtn.removeAttribute('aria-disabled');
    if (cancelHadFocus) startBtn.focus();

    if (data.state === 'done' && openWhenDone && !data.review) {
      // Opened from a phone share: go straight to the page it made, if it made one.
      const page = data.outputs.find((o) => o.viewable && /\.html$/i.test(o.name));
      if (page) {
        location.replace(`/api/jobs/${data.id}/view/${page.index}`);
        return;
      }
      if (data.links?.length) {
        location.replace(data.links[0].href); // for example the search page of Find in a document
        return;
      }
    }
    if (data.state === 'done') {
      progress.max = 1;
      progress.value = 1;
      progressText.textContent = 'Finished';
      resultList.replaceChildren(...data.outputs.map((o) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `/api/jobs/${data.id}/files/${o.index}`;
        a.download = o.name;
        a.textContent = `${o.label}: ${o.name}, ${formatSize(o.size)}`;
        li.append(a);
        if (o.viewable) {
          const view = document.createElement('a');
          view.href = `/api/jobs/${data.id}/view/${o.index}`;
          view.target = '_blank';
          view.rel = 'noopener';
          view.textContent = `Open ${o.name} in a new tab`;
          li.append(' ', view);
        }
        return li;
      }));
      resultMessage.textContent = data.message;
      resultLinks.replaceChildren(...(data.links || []).map((l) => el('li', {}, el('a', { href: l.href, text: l.text }))));
      resultLinks.hidden = !(data.links || []).length;
      if (data.review) showReview(data.review);
      else reviewForm.hidden = true;
      const hasFiles = data.outputs.length > 0;
      $('downloads-h').hidden = !hasFiles;
      resultList.hidden = !hasFiles;
      results.hidden = false;
      document.title = `Finished: ${baseTitle}`;
      announce(`Finished. ${data.message}`.trim());
    } else {
      progress.max = 1;
      progress.value = 0;
      progressText.textContent = data.state === 'cancelled' ? 'Cancelled' : 'Failed';
      if (data.details) {
        detailsText.textContent = data.details;
        details.hidden = false;
      }
      document.title = `${data.state === 'cancelled' ? 'Cancelled' : 'Failed'}: ${baseTitle}`;
      announce(data.state === 'cancelled' ? 'Cancelled.' : `Failed. ${data.message}`);
    }
  }

  async function poll() {
    let data;
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error);
    } catch (err) {
      finish({ state: 'failed', message: err.message || 'Lost contact with the server. Is it still running in Terminal?' });
      return;
    }
    if (data.state === 'running') {
      showProgress(data.progress);
      setTimeout(poll, 700);
    } else {
      finish(data);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running) return;
    clearFormError();

    const invalid = [...form.elements].find((el) => el.willValidate && !el.checkValidity());
    if (invalid) {
      const label = form.querySelector(`label[for="${invalid.id}"]`)?.textContent || 'This field';
      const message = invalid.type === 'file' ? 'Please choose a file.' : invalid.validationMessage;
      showFieldError(invalid, `${label}: ${message}`);
      return;
    }

    const fileName = $('file')?.files[0]?.name;
    saveRemembered();
    reviewForm.hidden = true;
    setBusy(true);
    jobEl.hidden = false;
    results.hidden = true;
    resultList.replaceChildren();
    details.hidden = true;
    detailsText.textContent = '';
    showProgress({ value: null, text: 'Uploading' });
    document.title = `Running: ${baseTitle}`;
    announce(`Started ${toolName}${fileName ? ` on ${fileName}` : ''}.`);

    let res;
    let data;
    try {
      res = await fetch(`/api/tools/${toolId}/jobs`, { method: 'POST', body: new FormData(form) });
      data = await res.json();
    } catch {
      res = { ok: false };
      data = { error: 'Could not reach the server. Is it still running in Terminal?' };
    }
    if (!res.ok) {
      setBusy(false);
      jobEl.hidden = true;
      document.title = baseTitle;
      statusEl.textContent = '';
      const field = data.field ? $(data.field) : null;
      if (field) showFieldError(field, data.error);
      else showFormError(`Could not start. ${data.error}`);
      return;
    }

    jobId = data.id;
    cancelBtn.hidden = false;
    showProgress(data.progress);
    setTimeout(poll, 500);
  });

  cancelBtn.addEventListener('click', async () => {
    if (!running || !jobId || cancelBtn.getAttribute('aria-disabled')) return;
    cancelBtn.setAttribute('aria-disabled', 'true');
    progressText.textContent = 'Cancelling';
    try { await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' }); } catch { /* the next poll will report it */ }
  });

  // Opened with ?job=ID (for example from an iPhone share): follow that job here.
  const resumeId = params.get('job');
  if (resumeId && /^[\w-]+$/.test(resumeId)) {
    jobId = resumeId;
    setBusy(true);
    jobEl.hidden = false;
    cancelBtn.hidden = false;
    showProgress({ value: null, text: 'Working' });
    document.title = `Running: ${baseTitle}`;
    $('job-h').focus();
    announce(`Working on what you shared${openWhenDone ? '. The result opens by itself when it is ready' : ''}.`);
    poll();
  }
})();
