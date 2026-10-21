export async function continueController(options: {
  maxNodes: number;
  open: () => string;
  prepare?: (authority: string) => Promise<void> | void;
  run: (authority: string) => Promise<{ outcome: string; node_id?: string }>;
}): Promise<{ stop_reason: string; nodes: string[] }> {
  if (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > 8) {
    throw new Error('CODEX_CONTINUATION_BOUND: --max-nodes must be an integer from 1 to 8.');
  }
  // The key lives only in this host call stack, never in a worker environment,
  // serialized report, credential file or result slot.
  const authority = options.open();
  await options.prepare?.(authority);
  const nodes: string[] = [];
  for (let i = 0; i < options.maxNodes; i++) {
    const result = await options.run(authority);
    if (!result.node_id || nodes.includes(result.node_id)) return { stop_reason: 'NO_PROGRESS', nodes };
    nodes.push(result.node_id);
    if (result.outcome !== 'DONE') return { stop_reason: 'NODE_NOT_DONE', nodes };
  }
  return { stop_reason: 'BOUND_REACHED', nodes };
}

/** One held host authority across bounded workers and fresh review generations. */
export async function continueReviewedController(options: {
  maxNodes: number; maxReviews: number;
  open: () => string;
  prepare?: (authority: string) => Promise<void> | void;
  run: (authority: string) => Promise<{ outcome: string; node_id?: string }>;
  review: (authority: string) => Promise<{ outcome: string }>;
}): Promise<{ stop_reason: string; nodes: string[]; reviews: string[] }> {
  if (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > 8 ||
      !Number.isSafeInteger(options.maxReviews) || options.maxReviews < 1 || options.maxReviews > 3) {
    throw new Error('CODEX_REVIEW_CONTINUATION_BOUND: max-nodes must be 1..8 and max-reviews must be 1..3.');
  }
  const authority = options.open();
  await options.prepare?.(authority);
  const nodes: string[] = [];
  const reviews: string[] = [];
  let sinceReview = new Set<string>();
  for (;;) {
    while (nodes.length < options.maxNodes) {
      const result = await options.run(authority);
      if (!result.node_id) break;
      if (sinceReview.has(result.node_id)) return { stop_reason: 'NO_PROGRESS', nodes, reviews };
      nodes.push(result.node_id);
      sinceReview.add(result.node_id);
      // A challenge restores its DONE generation and orders a separate
      // refinement reviewer, not another worker or a candidate.
      if (result.outcome === 'REVIEW_CHALLENGED') break;
      if (result.outcome !== 'DONE') return { stop_reason: 'NODE_NOT_DONE', nodes, reviews };
    }
    if (reviews.length >= options.maxReviews) return { stop_reason: 'REVIEW_GAPS_UNRESOLVED', nodes, reviews };
    // The controller's dispatch validates readiness, not the worker's claim.
    const verdict = await options.review(authority);
    reviews.push(verdict.outcome);
    if (verdict.outcome === 'PASS') return { stop_reason: 'REVIEW_PASS', nodes, reviews };
    if (verdict.outcome !== 'GAPS') return { stop_reason: 'REVIEW_NOT_SETTLED', nodes, reviews };
    if (nodes.length >= options.maxNodes || reviews.length >= options.maxReviews) return { stop_reason: 'REVIEW_GAPS_UNRESOLVED', nodes, reviews };
    sinceReview = new Set();
  }
}
