import { handleCapture } from './handlers/capture.mjs';

/** Job type -> handler. A job with no handler is dead-lettered. */
export const HANDLERS = {
  'payment.capture': handleCapture,
};

/** Claim and process one job. Returns null when the queue is empty. */
export async function processNext(deps, log = () => {}) {
  const claim = await deps.store.claimJob();
  if (claim === null) return null;
  const handler = HANDLERS[claim.job?.type];
  if (handler === undefined) {
    log({ event: 'dead-letter', reason: 'no-handler', type: claim.job?.type, job_id: claim.job?.job_id });
    await deps.store.finishJob(claim, 'dead');
    return 'dead';
  }
  try {
    const outcome = await handler(claim.job, deps);
    await deps.store.finishJob(claim, 'done');
    log({ event: 'job', type: claim.job.type, job_id: claim.job.job_id, outcome });
    return outcome;
  } catch (error) {
    log({ event: 'dead-letter', reason: String(error?.message ?? error), job_id: claim.job.job_id });
    await deps.store.finishJob(claim, 'dead');
    return 'dead';
  }
}

/** Process jobs until the queue is empty. */
export async function drain(deps, log) {
  const outcomes = [];
  for (;;) {
    const outcome = await processNext(deps, log);
    if (outcome === null) return outcomes;
    outcomes.push(outcome);
  }
}
