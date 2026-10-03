/**
 * Deterministic node/feature state machine.
 *
 * Every rule here exists because a natural-language claim, a saved file or an
 * exited process must never move a node forward. Only declared edges, with
 * schema-valid evidence that actually ran, change state.
 */
import type {
  EvidenceKind,
  EvidenceRecord,
  FeatureState_,
  GraphNode,
  NodeState,
  PortfolioGraph,
  UsageTotals,
} from '../model/types.js';
import { addUsage } from './feature-state.js';

export class TransitionError extends Error {
  readonly code: string;
  readonly nodeId: string;
  constructor(code: string, nodeId: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'TransitionError';
    this.code = code;
    this.nodeId = nodeId;
  }
}

/** The only legal node edges. Anything absent here is refused. */
const EDGES: Record<NodeState, readonly NodeState[]> = {
  PLANNED: ['READY', 'EXCLUDED', 'INVALIDATED', 'PAUSED'],
  READY: ['CLAIMED', 'PLANNED', 'BLOCKED', 'NEEDS_DECISION', 'EXCLUDED', 'INVALIDATED', 'PAUSED'],
  CLAIMED: [
    'RED_PENDING',
    'GREEN_PENDING',
    'REVIEW_VERIFIED',
    'READY',
    'BLOCKED',
    'NEEDS_DECISION',
    'BUDGET_EXHAUSTED',
    'PAUSED',
    'INVALIDATED',
  ],
  RED_PENDING: ['RED_VERIFIED', 'READY', 'BLOCKED', 'NEEDS_DECISION', 'BUDGET_EXHAUSTED', 'PAUSED'],
  // Mid-flight verified states may fall back to READY when an attempt ends
  // without reaching DONE. Nothing was integrated and the evidence already
  // recorded is kept, so the next attempt resumes at its real next gate.
  RED_VERIFIED: [
    'GREEN_PENDING',
    'REVIEW_VERIFIED',
    'READY',
    'BLOCKED',
    'NEEDS_DECISION',
    'BUDGET_EXHAUSTED',
    'INVALIDATED',
    'PAUSED',
  ],
  GREEN_PENDING: [
    'GREEN_VERIFIED',
    'READY',
    'BLOCKED',
    'NEEDS_DECISION',
    'BUDGET_EXHAUSTED',
    'PAUSED',
  ],
  GREEN_VERIFIED: [
    'REFACTOR_VERIFIED',
    'REGRESSION_VERIFIED',
    'READY',
    'BLOCKED',
    'NEEDS_DECISION',
    'INVALIDATED',
    'PAUSED',
  ],
  REFACTOR_VERIFIED: ['REGRESSION_VERIFIED', 'READY', 'BLOCKED', 'NEEDS_DECISION', 'INVALIDATED', 'PAUSED'],
  REGRESSION_VERIFIED: ['REVIEW_VERIFIED', 'READY', 'BLOCKED', 'NEEDS_DECISION', 'INVALIDATED', 'PAUSED'],
  REVIEW_VERIFIED: ['INTEGRATED', 'READY', 'BLOCKED', 'NEEDS_DECISION', 'INVALIDATED', 'PAUSED'],
  INTEGRATED: ['DONE', 'BLOCKED', 'INVALIDATED', 'PAUSED'],
  DONE: ['INVALIDATED'],
  BLOCKED: ['READY', 'INVALIDATED', 'EXCLUDED', 'PAUSED'],
  NEEDS_DECISION: ['READY', 'INVALIDATED', 'EXCLUDED', 'PAUSED'],
  BUDGET_EXHAUSTED: ['READY', 'INVALIDATED', 'EXCLUDED', 'PAUSED'],
  INVALIDATED: ['PLANNED', 'READY', 'EXCLUDED'],
  PAUSED: ['READY', 'CLAIMED', 'PLANNED', 'BLOCKED', 'EXCLUDED', 'INVALIDATED'],
  EXCLUDED: ['PLANNED'],
};

/** States you may only leave with an explicit, recorded justification. */
const JUSTIFIED_EXITS: ReadonlySet<NodeState> = new Set<NodeState>([
  'BLOCKED',
  'NEEDS_DECISION',
  'BUDGET_EXHAUSTED',
]);

/** States that terminate an attempt and must therefore drop claims/leases. */
const CLAIM_RELEASING: ReadonlySet<NodeState> = new Set<NodeState>([
  'READY',
  'PLANNED',
  'BLOCKED',
  'NEEDS_DECISION',
  'BUDGET_EXHAUSTED',
  'INVALIDATED',
  'EXCLUDED',
  'DONE',
  'PAUSED',
]);

/** Evidence that each verified state requires before it may be entered. */
const EVIDENCE_GATE: Partial<Record<NodeState, EvidenceKind>> = {
  RED_VERIFIED: 'red',
  GREEN_VERIFIED: 'green',
  REFACTOR_VERIFIED: 'refactor',
  REGRESSION_VERIFIED: 'regression',
};

export interface TransitionOptions {
  actor: string;
  reason?: string;
  /** Required to leave BLOCKED / NEEDS_DECISION / BUDGET_EXHAUSTED. */
  decisionId?: string;
  /** Alternative justification: the node's inputs genuinely changed. */
  inputChanged?: boolean;
  /** Recorded on INTEGRATED. */
  integratedSha?: string;
  now?: string;
}

function sameCommand(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function requireNode(graph: PortfolioGraph, nodeId: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new TransitionError('UNKNOWN_NODE', nodeId, `Node "${nodeId}" is not in the graph.`);
  return node;
}

/**
 * Check the evidence gates for entering `to`. Throws with a specific code so
 * hooks can surface a short, actionable block reason.
 */
function checkEvidenceGate(
  node: GraphNode,
  runtime: { evidence: Partial<Record<EvidenceKind, EvidenceRecord>> },
  to: NodeState,
): void {
  const kind = EVIDENCE_GATE[to];
  if (kind !== undefined) {
    const record = runtime.evidence[kind];
    if (!record) {
      throw new TransitionError(
        'MISSING_EVIDENCE',
        node.id,
        `Entering ${to} requires "${kind}" evidence; none is recorded.`,
      );
    }
    if (kind === 'red') {
      if (record.exit_code === 0) {
        throw new TransitionError(
          'INVALID_RED_EVIDENCE',
          node.id,
          'RED evidence exited 0; a passing test is not a RED.',
        );
      }
      if (record.red_reason !== 'behaviour-missing') {
        throw new TransitionError(
          'INVALID_RED_EVIDENCE',
          node.id,
          `RED failed for "${record.red_reason ?? 'unclassified'}"; only a missing behaviour is a valid RED.`,
        );
      }
    } else if (record.exit_code !== 0) {
      throw new TransitionError(
        'VERIFIER_FAILED',
        node.id,
        `${kind} evidence exited ${record.exit_code}; it must exit 0.`,
      );
    }

    if (kind === 'green') {
      const red = runtime.evidence.red;
      if (!red) {
        throw new TransitionError(
          'MISSING_EVIDENCE',
          node.id,
          'GREEN requires a prior RED on the same targeted command.',
        );
      }
      if (!sameCommand(red.command, record.command)) {
        throw new TransitionError(
          'GREEN_COMMAND_MISMATCH',
          node.id,
          `GREEN ran "${record.command.join(' ')}" but RED ran "${red.command.join(' ')}".`,
        );
      }
    }
  }

  // Terminal gates: every declared evidence kind must be present and passing.
  if (to === 'REGRESSION_VERIFIED' || to === 'REVIEW_VERIFIED' || to === 'DONE') {
    const needed = node.required_evidence.filter((k) => {
      if (to === 'REGRESSION_VERIFIED') return k === 'red' || k === 'green' || k === 'regression';
      if (to === 'REVIEW_VERIFIED') return k !== 'e2e' && k !== 'candidate';
      return true;
    });
    for (const kindNeeded of needed) {
      if (kindNeeded === 'review' && to !== 'DONE') continue;
      const rec = runtime.evidence[kindNeeded];
      if (!rec) {
        throw new TransitionError(
          'MISSING_EVIDENCE',
          node.id,
          `Entering ${to} requires "${kindNeeded}" evidence; none is recorded.`,
        );
      }
      if (kindNeeded !== 'red' && rec.exit_code !== 0) {
        throw new TransitionError(
          'VERIFIER_FAILED',
          node.id,
          `${kindNeeded} evidence exited ${rec.exit_code}.`,
        );
      }
    }
  }
}

/**
 * Apply a node transition to a cloned state. Pure: never touches disk.
 * Callers persist the result through `mutateState`.
 */
export function applyNodeTransition(
  graph: PortfolioGraph,
  state: FeatureState_,
  nodeId: string,
  to: NodeState,
  options: TransitionOptions,
): FeatureState_ {
  const node = requireNode(graph, nodeId);
  const next = structuredClone(state);
  const runtime = next.nodes[nodeId];
  if (!runtime) {
    throw new TransitionError('UNKNOWN_NODE', nodeId, `Node "${nodeId}" has no runtime state.`);
  }

  const from = runtime.state;
  if (from === to) return next;

  if (!EDGES[from].includes(to)) {
    throw new TransitionError(
      'ILLEGAL_TRANSITION',
      nodeId,
      `${from} -> ${to} is not a declared edge.`,
    );
  }

  if (JUSTIFIED_EXITS.has(from) && to === 'READY') {
    if (!options.decisionId && options.inputChanged !== true) {
      throw new TransitionError(
        'UNBLOCK_REQUIRES_JUSTIFICATION',
        nodeId,
        `Leaving ${from} needs an approved decision id or a recorded input change.`,
      );
    }
  }

  checkEvidenceGate(node, runtime, to);

  const now = options.now ?? new Date().toISOString();
  runtime.state = to;
  runtime.updated_at = now;

  if (to === 'CLAIMED') runtime.attempts += 1;
  if (CLAIM_RELEASING.has(to)) runtime.claim = null;

  if (to === 'BLOCKED' || to === 'NEEDS_DECISION' || to === 'BUDGET_EXHAUSTED') {
    runtime.blocked_reason = options.reason ?? to;
  } else if (to === 'READY' || to === 'PLANNED') {
    runtime.blocked_reason = null;
    if (JUSTIFIED_EXITS.has(from)) {
      // An approved decision or a changed input makes this a different
      // problem. Carrying the old attempt count and fingerprints forward
      // would block the new attempt before it ran.
      runtime.attempts = 0;
      runtime.failure_counts = {};
      runtime.last_failure_fingerprint = null;
    }
  }

  if (to === 'INTEGRATED' && options.integratedSha) {
    runtime.integrated_sha = options.integratedSha;
  }
  if (to === 'INVALIDATED') {
    // RED is a historical fact: a test once proved the behaviour was missing,
    // and an upstream change does not undo that. Everything downstream of it
    // was proven against inputs that have since changed, so it is discarded.
    // Keeping RED also means a node whose behaviour still holds can be
    // re-verified without manufacturing a fake failing test.
    const red = runtime.evidence.red;
    runtime.evidence = red ? { red } : {};
    runtime.integrated_sha = null;
    // Invalidation means the inputs changed, so this is a different problem.
    // Carrying the old attempt count and fingerprints forward would exhaust
    // the budget before the new problem had a single attempt.
    runtime.attempts = 0;
    runtime.failure_counts = {};
    runtime.last_failure_fingerprint = null;
  }

  return next;
}

export interface FailureOptions {
  actor: string;
  now?: string;
  /** Overrides the feature-level max_same_failure for this node. */
  maxSameFailure?: number;
}

/**
 * Record a verifier failure under its fingerprint.
 *
 * Fingerprints are keyed on the failure itself, never on the actor, so
 * re-running the same failing attempt under a different model or agent name
 * cannot disguise it as fresh progress.
 */
export function recordFailure(
  graph: PortfolioGraph,
  state: FeatureState_,
  nodeId: string,
  fingerprint: string,
  options: FailureOptions,
): FeatureState_ {
  const node = requireNode(graph, nodeId);
  const next = structuredClone(state);
  const runtime = next.nodes[nodeId];
  if (!runtime) throw new TransitionError('UNKNOWN_NODE', nodeId, `No runtime state.`);

  const count = (runtime.failure_counts[fingerprint] ?? 0) + 1;
  runtime.failure_counts[fingerprint] = count;
  runtime.last_failure_fingerprint = fingerprint;
  runtime.updated_at = options.now ?? new Date().toISOString();

  const limit =
    options.maxSameFailure ?? node.worker.max_same_failure ?? next.budget.max_same_failure;

  if (count >= limit && runtime.state !== 'BLOCKED') {
    return applyNodeTransition(graph, next, nodeId, 'BLOCKED', {
      actor: options.actor,
      reason: `Same failure fingerprint "${fingerprint}" reached the limit of ${limit}.`,
      ...(options.now ? { now: options.now } : {}),
    });
  }
  return next;
}

/**
 * Add child usage to both the node and the parent feature total, then enforce
 * the feature budget. A child loop can never mint fresh headroom: the parent
 * total is the authority and is only ever incremented.
 */
export function accumulateUsage(
  state: FeatureState_,
  nodeId: string,
  usage: Partial<UsageTotals>,
): FeatureState_ {
  const next = structuredClone(state);
  const runtime = next.nodes[nodeId];
  if (runtime) runtime.usage = addUsage(runtime.usage, usage);
  next.usage = addUsage(next.usage, usage);

  const overruns: string[] = [];
  if (next.usage.model_turns > next.budget.max_total_model_turns) {
    overruns.push(`model_turns ${next.usage.model_turns} > ${next.budget.max_total_model_turns}`);
  }
  if (next.usage.wall_clock_ms > next.budget.max_total_wall_clock_ms) {
    overruns.push(
      `wall_clock_ms ${next.usage.wall_clock_ms} > ${next.budget.max_total_wall_clock_ms}`,
    );
  }
  if (next.usage.sessions > next.budget.max_total_sessions) {
    overruns.push(`sessions ${next.usage.sessions} > ${next.budget.max_total_sessions}`);
  }

  if (overruns.length > 0 && next.feature_state !== 'BUDGET_EXHAUSTED') {
    next.feature_state = 'BUDGET_EXHAUSTED';
    next.blocked_reason = `Feature budget exhausted: ${overruns.join('; ')}`;
  }
  return next;
}

/** True when every node has reached a terminal, accepted state. */
export function allNodesSettled(state: FeatureState_): boolean {
  return Object.values(state.nodes).every((n) => n.state === 'DONE' || n.state === 'EXCLUDED');
}
