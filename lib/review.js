// The second step of tools that show a list of choices first (for example the redactor).
// The browser sends back which items were ticked, plus any extra text to find.
import { startJob } from './jobs.js';
import { userError } from './system.js';

export async function continueJob(tool, job, body) {
  if (!tool.continue) throw userError('This tool has no second step.');
  if (job.state !== 'done' || !job.review) throw userError('This job is not waiting for your choices.');
  if (job.continued) throw userError('These choices were already used. Start again to make a new copy.');
  const known = new Set(job.review.groups.flatMap((g) => g.items.map((i) => i.id)));
  const selected = Array.isArray(body?.selected) ? body.selected.filter((id) => typeof id === 'string' && known.has(id)) : [];
  const extra = typeof body?.extra === 'string' ? body.extra.slice(0, 20000) : '';
  if (!selected.length && !extra.trim()) {
    throw userError(job.review.groups.length ? 'Nothing is ticked. Tick at least one item, or type some text to remove.' : `Type something in ${job.review.extraLabel} first.`);
  }
  job.continued = true;
  return startJob(tool, job.options, null, {
    inDir: job.inDir,
    workDir: job.workDir,
    input: job.input,
    reviewState: job.reviewState,
    choices: { selected, extra },
  });
}
