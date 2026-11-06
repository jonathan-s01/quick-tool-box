// Builds the home page and each tool page.
import { esc, layout } from './html.js';
import { renderOptions } from './options.js';

function setupList(items) {
  return `<ul>${items.map((m) => `<li>${esc(m.what)}${m.install ? ` Install command: <code>${esc(m.install)}</code>` : ''}</li>`).join('')}</ul>`;
}

export function homePage(tools) {
  const items = tools.map(({ tool, setup }) => {
    const status = setup.missing.length ? '<p class="warn">Needs setup before it can be used.</p>' : '';
    return `<li><h2><a href="/tools/${esc(tool.id)}">${esc(tool.name)}</a></h2><p>${esc(tool.summary)}</p>${status}</li>`;
  }).join('');
  return layout({
    title: 'All tools',
    body: `<h1>Command line tools</h1>
<p>Simple pages for command line programs. Files stay on this ${process.platform === 'darwin' ? 'Mac' : 'server'} and are deleted an hour after a job finishes.</p>
<ul class="tools">${items}</ul>`,
  });
}

export function toolPage(tool, setup) {
  const ready = setup.missing.length === 0;
  const setupHtml = ready ? '' : `<section aria-labelledby="setup-h" class="setup">
<h2 id="setup-h">Setup needed</h2>
<p>This tool cannot run yet. Sort out the items below, then reload this page. Install commands go in Terminal.</p>
${setupList(setup.missing)}
</section>`;
  const notesHtml = setup.notes.length ? `<section aria-labelledby="notes-h">
<h2 id="notes-h">Notes and extras</h2>
${setupList(setup.notes)}
</section>` : '';

  const fileField = tool.input ? `<div class="field">
<label for="file">${esc(tool.input.label)}${tool.input.optional ? ' (optional)' : ''}</label>
${tool.input.help ? `<p class="help" id="file-help">${esc(tool.input.help)}</p>` : ''}
<input type="file" id="file" name="file"${tool.input.optional ? '' : ' required'}${tool.input.accept ? ` accept="${esc(tool.input.accept)}"` : ''}${tool.input.help ? ' aria-describedby="file-help"' : ''}>
</div>` : '';

  const form = ready ? `<form id="tool-form" data-tool="${esc(tool.id)}" data-tool-name="${esc(tool.name)}" novalidate>
<h2>Start a job</h2>
${fileField}
${renderOptions(setup.options)}
<p id="form-error" class="error" tabindex="-1" hidden></p>
<button type="submit" id="start">${esc(tool.submitLabel || 'Start')}</button>
</form>` : '';

  // The status area is always on the page so screen readers pick up changes to it.
  // Only "started" and "finished" messages are put in it. The progress bar is not announced.
  const job = ready ? `<div role="status" id="status" class="status"></div>
<section aria-labelledby="job-h" id="job" hidden>
<h2 id="job-h" tabindex="-1">Current job</h2>
<div class="field">
<label for="progress" id="progress-label">Progress</label>
<progress id="progress" aria-labelledby="progress-label" aria-describedby="progress-text"></progress>
<p id="progress-text"></p>
</div>
<button type="button" id="cancel" hidden>Cancel job</button>
<div id="results" hidden>
<p id="result-message"></p>
<ul id="result-links" hidden></ul>
<h3 id="downloads-h">Downloads</h3>
<ul id="result-list"></ul>
<form id="review" hidden novalidate></form>
</div>
<details id="details" hidden>
<summary>Technical details</summary>
<pre id="details-text"></pre>
</details>
</section>` : '';

  return layout({
    title: tool.name,
    script: ready,
    body: `<h1>${esc(tool.name)}</h1>
<p>${esc(tool.summary)}</p>
${setupHtml}
${notesHtml}
${form}
${job}`,
  });
}

export function messagePage(title, text) {
  return layout({ title, body: `<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Go to all tools</a></p>` });
}
