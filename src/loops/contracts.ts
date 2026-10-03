/**
 * Loop contracts.
 *
 * A loop that lacks a trigger, a success condition, stop conditions, a
 * deterministic verifier or a budget is refused before it can run. This is
 * the mechanism that keeps "keep going until it works" out of the harness.
 */
import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { Problem } from '../model/types.js';
import { validateAgainstSchema } from '../schema/registry.js';
import { writeTextAtomic } from '../state/atomic-json.js';

export interface LoopContract {
  loop_id: string;
  loop_type:
    | 'node-agent'
    | 'verification'
    | 'feature-orchestration'
    | 'runtime-e2e'
    | 'review'
    | 'harness-improvement';
  scope: 'feature' | 'node' | 'runtime' | 'review' | 'harness';
  parent_loop_id?: string | null;
  trigger: string;
  authoritative_inputs: string[];
  action: string;
  deterministic_verifier: { kind: 'command' | 'controller'; command: string[]; expect_exit?: number };
  feedback_schema: string;
  success_condition: string;
  stop_conditions: string[];
  max_attempts: number;
  max_same_failure: number;
  max_model_turns: number;
  max_wall_clock_ms: number;
  max_usage_budget: { input_tokens: number; output_tokens: number };
  backoff?: { initial_ms?: number; factor?: number; max_ms?: number };
  required_resource?: string[];
  allowed_tools?: string[];
  human_gate?: boolean;
  on_success: string;
  on_failure: string;
  on_budget_exhausted: string;
  state_path: string;
  evidence_path: string;
}

export interface LoopsFile {
  schema_version: 1;
  loops: LoopContract[];
}

export interface LoopValidationResult {
  ok: boolean;
  problems: Problem[];
  loops: LoopContract[];
}

/** Validate every contract in a LOOPS.yaml. */
export function validateLoops(value: unknown): LoopValidationResult {
  const problems: Problem[] = [];
  const parsed = value as Partial<LoopsFile>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.loops)) {
    return {
      ok: false,
      problems: [{ code: 'SCHEMA', path: '/loops', detail: 'LOOPS.yaml needs a "loops" array.' }],
      loops: [],
    };
  }

  const seen = new Set<string>();
  parsed.loops.forEach((loop, i) => {
    for (const p of validateAgainstSchema('loop-contract', loop)) {
      problems.push({ ...p, path: `/loops/${i}${p.path === '(root)' ? '' : p.path}` });
    }
    const id = (loop as LoopContract)?.loop_id;
    if (typeof id === 'string') {
      if (seen.has(id)) {
        problems.push({
          code: 'DUPLICATE_LOOP_ID',
          path: `/loops/${i}/loop_id`,
          detail: `Loop "${id}" is declared more than once.`,
        });
      }
      seen.add(id);
    }
  });

  // A child loop must point at a parent that exists, so usage can roll up.
  parsed.loops.forEach((loop, i) => {
    const parent = (loop as LoopContract).parent_loop_id;
    if (parent && !seen.has(parent)) {
      problems.push({
        code: 'UNKNOWN_PARENT_LOOP',
        path: `/loops/${i}/parent_loop_id`,
        detail: `Loop "${(loop as LoopContract).loop_id}" names unknown parent "${parent}"; child usage could not be accumulated.`,
      });
    }
  });

  return { ok: problems.length === 0, problems, loops: parsed.loops as LoopContract[] };
}

export function loadLoops(file: string): LoopValidationResult {
  if (!existsSync(file)) {
    return {
      ok: false,
      problems: [{ code: 'MISSING_LOOPS', path: file, detail: `No LOOPS.yaml at ${file}` }],
      loops: [],
    };
  }
  return validateLoops(YAML.parse(readFileSync(file, 'utf8')));
}

/**
 * The default loop set for a feature: node agent, verification, feature
 * orchestration, runtime/E2E and review. Every one carries real stop
 * conditions and budgets.
 */
export function defaultLoops(featureId: string, mycelink: string): LoopsFile {
  const base = {
    max_attempts: 2,
    max_same_failure: 2,
    max_model_turns: 60,
    max_wall_clock_ms: 45 * 60 * 1000,
    max_usage_budget: { input_tokens: 2_000_000, output_tokens: 400_000 },
    feedback_schema: 'schemas/node-result.schema.json',
    state_path: `features/${featureId}/STATE.json`,
    evidence_path: `features/${featureId}/evidence`,
  };

  const feature: LoopContract = {
    ...base,
    loop_id: `feature-orchestration:${featureId}`,
    loop_type: 'feature-orchestration',
    scope: 'feature',
    parent_loop_id: null,
    trigger: 'A validated graph exists and the feature is RUNNING.',
    authoritative_inputs: [
      `features/${featureId}/PRD.md`,
      `features/${featureId}/PORTFOLIO-GRAPH.yaml`,
      `features/${featureId}/STATE.json`,
      `features/${featureId}/DECISIONS.md`,
    ],
    action: 'Compute READY, remove conflicts, claim and dispatch one worker per node.',
    deterministic_verifier: { kind: 'controller', command: [mycelink, 'feature', 'verify', featureId] },
    success_condition: 'mycelink feature verify exits 0.',
    stop_conditions: [
      'feature verify exits 0',
      'any node BLOCKED',
      'any node NEEDS_DECISION',
      'feature BUDGET_EXHAUSTED',
      'user cancellation',
    ],
    max_model_turns: 400,
    max_wall_clock_ms: 6 * 60 * 60 * 1000,
    on_success: 'Mark the feature VERIFIED and report evidence.',
    on_failure: 'Stop and report the blocking node with its fingerprint.',
    on_budget_exhausted: 'Checkpoint, report remaining READY/BLOCKED nodes and cost options.',
  };

  const node: LoopContract = {
    ...base,
    loop_id: `node-agent:${featureId}`,
    loop_type: 'node-agent',
    scope: 'node',
    parent_loop_id: feature.loop_id,
    trigger: 'The controller claimed a READY node for this feature.',
    authoritative_inputs: [`features/${featureId}/context-packs/<node-id>.json`],
    action: 'Implement exactly one vertical slice inside the node worktree.',
    deterministic_verifier: { kind: 'controller', command: [mycelink, 'node', 'verify', '<node-id>'] },
    success_condition: 'Fresh verification passes on a clean checkout of the node branch.',
    stop_conditions: [
      'fresh verification passes',
      'same failure fingerprint twice',
      'max_attempts reached',
      'worker returns NEEDS_DECISION',
      'turn or wall-clock budget reached',
    ],
    on_success: 'Integrate the node branch and transition to DONE.',
    on_failure: 'Record the fingerprint and retry within budget, else BLOCKED.',
    on_budget_exhausted: 'Transition the node to BUDGET_EXHAUSTED and checkpoint.',
  };

  const verification: LoopContract = {
    ...base,
    loop_id: `verification:${featureId}`,
    loop_type: 'verification',
    scope: 'node',
    parent_loop_id: node.loop_id,
    trigger: 'A worker submitted a node result.',
    authoritative_inputs: [`features/${featureId}/evidence`],
    action: 'Re-run the node verifiers on a clean worktree and check the ownership fence.',
    deterministic_verifier: { kind: 'controller', command: [mycelink, 'evidence', 'validate', '<node-id>'] },
    success_condition: 'All declared verifiers exit 0 and no path escaped the fence.',
    stop_conditions: ['verifiers pass', 'verifier fails twice with the same fingerprint'],
    max_model_turns: 1,
    on_success: 'Advance the node through its verified gates.',
    on_failure: 'Return a fingerprint, exit code and evidence path only.',
    on_budget_exhausted: 'Report BUDGET_EXHAUSTED; never pass a node on a timeout.',
  };

  const runtime: LoopContract = {
    ...base,
    loop_id: `runtime-e2e:${featureId}`,
    loop_type: 'runtime-e2e',
    scope: 'runtime',
    parent_loop_id: feature.loop_id,
    trigger: 'A candidate manifest is ready and verified.',
    authoritative_inputs: [`features/${featureId}/candidates`],
    action: 'Lease the single runtime, deploy the candidate, reset fixtures, run scenario shards.',
    deterministic_verifier: { kind: 'controller', command: [mycelink, 'e2e', 'run', featureId] },
    success_condition: 'Every scheduled scenario passes against the candidate.',
    stop_conditions: [
      'all scenarios pass',
      'a scenario fails (attribute, do not blind retry)',
      'runtime lease cannot be acquired',
    ],
    max_attempts: 1,
    required_resource: ['full-runtime', 'deploy-slot'],
    on_success: 'Mark the candidate E2E-verified.',
    on_failure: 'Attribute the failure to a node, invalidate it and require a new candidate.',
    on_budget_exhausted: 'Release the runtime lease and checkpoint.',
  };

  const review: LoopContract = {
    ...base,
    loop_id: `review:${featureId}`,
    loop_type: 'review',
    scope: 'review',
    parent_loop_id: feature.loop_id,
    trigger: 'A node reached REGRESSION_VERIFIED.',
    authoritative_inputs: [`features/${featureId}/evidence`],
    action: 'A reviewer with no implementation context inspects the diff and evidence.',
    deterministic_verifier: { kind: 'controller', command: [mycelink, 'node', 'verify', '<node-id>'] },
    success_condition: 'No blocker findings remain.',
    stop_conditions: ['no blockers', 'max review attempts reached'],
    max_attempts: 2,
    max_model_turns: 20,
    on_success: 'Transition the node to REVIEW_VERIFIED.',
    on_failure: 'Return bounded blockers to the original node; the reviewer does not fix them.',
    on_budget_exhausted: 'Escalate to the user with the outstanding blockers.',
  };

  return { schema_version: 1, loops: [feature, node, verification, runtime, review] };
}

export function writeLoops(file: string, loops: LoopsFile): void {
  writeTextAtomic(file, YAML.stringify(loops, { lineWidth: 0 }));
}
