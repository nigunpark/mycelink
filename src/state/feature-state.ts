/**
 * STATE.json lifecycle: creation, load/save with schema validation, and the
 * compare-and-swap wrapper every mutation must go through.
 */
import { join } from 'node:path';
import type {
  FeatureBudget,
  FeatureState_,
  NodeRuntime,
  PortfolioGraph,
  UsageTotals,
} from '../model/types.js';
import { casUpdate, readDoc, writeDocAtomic, type AtomicDoc } from './atomic-json.js';
import { withLock } from './process-lock.js';
import { validateAgainstSchema } from '../schema/registry.js';

export const DEFAULT_BUDGET: FeatureBudget = {
  // Conservative pilot defaults, as required before any measured expansion.
  max_total_model_turns: 400,
  max_total_wall_clock_ms: 6 * 60 * 60 * 1000,
  max_total_sessions: 40,
  max_writer_concurrency: 2,
  max_same_failure: 2,
};

export function zeroUsage(): UsageTotals {
  return { model_turns: 0, wall_clock_ms: 0, input_tokens: 0, output_tokens: 0, sessions: 0 };
}

export function addUsage(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    model_turns: a.model_turns + (b.model_turns ?? 0),
    wall_clock_ms: a.wall_clock_ms + (b.wall_clock_ms ?? 0),
    input_tokens: a.input_tokens + (b.input_tokens ?? 0),
    output_tokens: a.output_tokens + (b.output_tokens ?? 0),
    sessions: a.sessions + (b.sessions ?? 0),
  };
}

export function newNodeRuntime(now = new Date().toISOString()): NodeRuntime {
  return {
    state: 'PLANNED',
    attempts: 0,
    claim: null,
    evidence: {},
    failure_counts: {},
    last_failure_fingerprint: null,
    integrated_sha: null,
    blocked_reason: null,
    usage: zeroUsage(),
    updated_at: now,
  };
}

/** Build a fresh STATE.json for a validated graph. */
export function initialState(
  graph: PortfolioGraph,
  graphHash: string,
  budget: FeatureBudget = DEFAULT_BUDGET,
  now = new Date().toISOString(),
): FeatureState_ {
  const nodes: Record<string, NodeRuntime> = {};
  for (const node of graph.nodes) nodes[node.id] = newNodeRuntime(now);
  return {
    schema_version: 1,
    feature_id: graph.feature_id,
    feature_state: 'GRAPH_VALIDATED',
    graph_hash: graphHash,
    created_at: now,
    updated_at: now,
    nodes,
    usage: zeroUsage(),
    budget: { ...budget },
    blocked_reason: null,
    pending_decisions: [],
    candidates: [],
    current_candidate: null,
  };
}

export function stateFilePath(featureDir: string): string {
  return join(featureDir, 'STATE.json');
}

export function stateLockPath(featureDir: string): string {
  return join(featureDir, 'STATE.json.lock');
}

export class StateSchemaError extends Error {
  constructor(problems: { detail: string }[]) {
    super('STATE.json failed schema validation: ' + problems.map((p) => p.detail).join('; '));
    this.name = 'StateSchemaError';
  }
}

export function loadState(featureDir: string): AtomicDoc<FeatureState_> | null {
  const doc = readDoc<FeatureState_>(stateFilePath(featureDir));
  if (doc === null) return null;
  const problems = validateAgainstSchema('state', doc.data);
  if (problems.length > 0) throw new StateSchemaError(problems);
  return doc;
}

export function saveState(featureDir: string, state: FeatureState_): AtomicDoc<FeatureState_> {
  const problems = validateAgainstSchema('state', state);
  if (problems.length > 0) throw new StateSchemaError(problems);
  return writeDocAtomic(stateFilePath(featureDir), state);
}

/**
 * Mutate STATE.json under a process lock with compare-and-swap.
 *
 * This is the only supported write path: it serialises concurrent hook and CLI
 * invocations, validates the result against the schema before it lands, and
 * refuses to write a state that another process changed underneath us.
 */
export function mutateState(
  featureDir: string,
  mutate: (state: FeatureState_) => FeatureState_,
  options: { lockTimeoutMs?: number } = {},
): FeatureState_ {
  return withLock(
    stateLockPath(featureDir),
    () => {
      const doc = loadState(featureDir);
      if (doc === null) throw new Error(`No STATE.json under ${featureDir}`);
      const next = mutate(structuredClone(doc.data));
      next.updated_at = new Date().toISOString();
      const problems = validateAgainstSchema('state', next);
      if (problems.length > 0) throw new StateSchemaError(problems);
      return casUpdate<FeatureState_>(stateFilePath(featureDir), doc.revision, () => next).data;
    },
    { timeoutMs: options.lockTimeoutMs ?? 15_000, pollMs: 10, purpose: 'STATE.json mutation' },
  );
}
