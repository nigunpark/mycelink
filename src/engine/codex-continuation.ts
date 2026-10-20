export async function continueController(options: {
  maxNodes: number;
  open: () => string;
  run: (authority: string) => Promise<{ outcome: string; node_id?: string }>;
}): Promise<{ stop_reason: string; nodes: string[] }> {
  if (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > 8) {
    throw new Error('CODEX_CONTINUATION_BOUND: --max-nodes must be an integer from 1 to 8.');
  }
  // The key lives only in this host call stack, never in a worker environment,
  // serialized report, credential file or result slot.
  const authority = options.open();
  const nodes: string[] = [];
  for (let i = 0; i < options.maxNodes; i++) {
    const result = await options.run(authority);
    if (!result.node_id || nodes.includes(result.node_id)) return { stop_reason: 'NO_PROGRESS', nodes };
    nodes.push(result.node_id);
    if (result.outcome !== 'DONE') return { stop_reason: 'NODE_NOT_DONE', nodes };
  }
  return { stop_reason: 'BOUND_REACHED', nodes };
}
