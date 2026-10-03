import { describe, expect, it } from 'vitest';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';
import type { EvidenceRecord, FeatureState_, PortfolioGraph } from '../../src/model/types.js';
import { initialState } from '../../src/state/feature-state.js';
import {
  TransitionError,
  accumulateUsage,
  applyNodeTransition,
  recordFailure,
} from '../../src/state/transition.js';

const GRAPH = clone(VALID_GRAPH) as unknown as PortfolioGraph;
const RED_NODE = 'FEAT-101.core.publish.red';
const IMPL = 'FEAT-101.core.publish.impl';

function freshState(): FeatureState_ {
  return initialState(GRAPH, 'a'.repeat(64));
}

function evidence(patch: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    kind: 'green',
    node_id: IMPL,
    command: ['node', '--test', 'tests/publish.test.js'],
    exit_code: 0,
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:00:10.000Z',
    cwd: 'C:/wt/core',
    repository: 'core',
    commit_sha: 'a'.repeat(40),
    output_path: 'evidence/green.log',
    output_sha256: 'b'.repeat(64),
    failure_fingerprint: null,
    ...patch,
  };
}

function at(state: FeatureState_, id: string, to: Parameters<typeof applyNodeTransition>[3]): FeatureState_ {
  return applyNodeTransition(GRAPH, state, id, to, { actor: 'test' });
}

describe('node transitions', () => {
  it('walks the full happy path PLANNED -> DONE', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = at(s, RED_NODE, 'CLAIMED');
    s = at(s, RED_NODE, 'RED_PENDING');

    s.nodes[RED_NODE]!.evidence.red = evidence({
      kind: 'red',
      node_id: RED_NODE,
      exit_code: 1,
      red_reason: 'behaviour-missing',
      failure_fingerprint: 'missing-publish',
    });
    s = at(s, RED_NODE, 'RED_VERIFIED');
    s = at(s, RED_NODE, 'REVIEW_VERIFIED');
    s = at(s, RED_NODE, 'INTEGRATED');
    s = at(s, RED_NODE, 'DONE');
    expect(s.nodes[RED_NODE]!.state).toBe('DONE');
  });

  it('refuses an undeclared edge', () => {
    const s = freshState();
    expect(() => at(s, RED_NODE, 'DONE')).toThrow(TransitionError);
    try {
      at(s, RED_NODE, 'DONE');
    } catch (err) {
      expect((err as TransitionError).code).toBe('ILLEGAL_TRANSITION');
    }
  });

  it('refuses RED_VERIFIED without RED evidence', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = at(s, RED_NODE, 'CLAIMED');
    s = at(s, RED_NODE, 'RED_PENDING');
    expect(() => at(s, RED_NODE, 'RED_VERIFIED')).toThrow(/MISSING_EVIDENCE/);
  });

  it('refuses RED evidence that passed (exit 0 is not a RED)', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = at(s, RED_NODE, 'CLAIMED');
    s = at(s, RED_NODE, 'RED_PENDING');
    s.nodes[RED_NODE]!.evidence.red = evidence({
      kind: 'red',
      node_id: RED_NODE,
      exit_code: 0,
      red_reason: 'behaviour-missing',
    });
    expect(() => at(s, RED_NODE, 'RED_VERIFIED')).toThrow(/INVALID_RED_EVIDENCE/);
  });

  it('refuses RED evidence that failed for a setup or syntax reason', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = at(s, RED_NODE, 'CLAIMED');
    s = at(s, RED_NODE, 'RED_PENDING');
    s.nodes[RED_NODE]!.evidence.red = evidence({
      kind: 'red',
      node_id: RED_NODE,
      exit_code: 1,
      red_reason: 'setup-error',
    });
    expect(() => at(s, RED_NODE, 'RED_VERIFIED')).toThrow(/INVALID_RED_EVIDENCE/);
  });

  it('refuses GREEN_VERIFIED when the green command differs from the red command', () => {
    let s = freshState();
    s = at(s, IMPL, 'READY');
    s = at(s, IMPL, 'CLAIMED');
    s = at(s, IMPL, 'RED_PENDING');
    s.nodes[IMPL]!.evidence.red = evidence({
      kind: 'red',
      exit_code: 1,
      red_reason: 'behaviour-missing',
    });
    s = at(s, IMPL, 'RED_VERIFIED');
    s = at(s, IMPL, 'GREEN_PENDING');
    s.nodes[IMPL]!.evidence.green = evidence({ command: ['node', '--test', 'tests/other.test.js'] });
    expect(() => at(s, IMPL, 'GREEN_VERIFIED')).toThrow(/GREEN_COMMAND_MISMATCH/);
  });

  it('accepts GREEN_VERIFIED when the same targeted command now passes', () => {
    let s = freshState();
    s = at(s, IMPL, 'READY');
    s = at(s, IMPL, 'CLAIMED');
    s = at(s, IMPL, 'RED_PENDING');
    s.nodes[IMPL]!.evidence.red = evidence({ kind: 'red', exit_code: 1, red_reason: 'behaviour-missing' });
    s = at(s, IMPL, 'RED_VERIFIED');
    s = at(s, IMPL, 'GREEN_PENDING');
    s.nodes[IMPL]!.evidence.green = evidence();
    s = at(s, IMPL, 'GREEN_VERIFIED');
    expect(s.nodes[IMPL]!.state).toBe('GREEN_VERIFIED');
  });

  it('refuses DONE until every required evidence kind is present', () => {
    let s = freshState();
    s = at(s, IMPL, 'READY');
    s = at(s, IMPL, 'CLAIMED');
    s = at(s, IMPL, 'RED_PENDING');
    s.nodes[IMPL]!.evidence.red = evidence({ kind: 'red', exit_code: 1, red_reason: 'behaviour-missing' });
    s = at(s, IMPL, 'RED_VERIFIED');
    s = at(s, IMPL, 'GREEN_PENDING');
    s.nodes[IMPL]!.evidence.green = evidence();
    s = at(s, IMPL, 'GREEN_VERIFIED');
    // regression evidence is required but absent
    expect(() => at(s, IMPL, 'REGRESSION_VERIFIED')).toThrow(/MISSING_EVIDENCE/);
  });

  it('refuses BLOCKED -> READY without a changed input or approved decision', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = applyNodeTransition(GRAPH, s, RED_NODE, 'BLOCKED', { actor: 'test', reason: 'same failure twice' });
    expect(() => at(s, RED_NODE, 'READY')).toThrow(/UNBLOCK_REQUIRES_JUSTIFICATION/);

    const unblocked = applyNodeTransition(GRAPH, s, RED_NODE, 'READY', {
      actor: 'test',
      decisionId: 'DEC-1',
    });
    expect(unblocked.nodes[RED_NODE]!.state).toBe('READY');
    expect(unblocked.nodes[RED_NODE]!.blocked_reason).toBeNull();
  });

  it('refuses NEEDS_DECISION -> READY without a decision id', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = applyNodeTransition(GRAPH, s, RED_NODE, 'NEEDS_DECISION', {
      actor: 'test',
      reason: 'contract compatibility',
    });
    expect(() => at(s, RED_NODE, 'READY')).toThrow(/UNBLOCK_REQUIRES_JUSTIFICATION/);
  });

  it('clears the claim when a node is released or terminal', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = at(s, RED_NODE, 'CLAIMED');
    s.nodes[RED_NODE]!.claim = {
      claim_id: 'c1',
      owner: 'worker',
      worktree: 'C:/wt',
      branch: 'feature/FEAT-101/red',
      claimed_at: '2026-01-01T00:00:00.000Z',
    };
    s = applyNodeTransition(GRAPH, s, RED_NODE, 'BLOCKED', { actor: 'test', reason: 'crash' });
    expect(s.nodes[RED_NODE]!.claim).toBeNull();
  });

  it('counts an attempt when a node is claimed', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = at(s, RED_NODE, 'CLAIMED');
    expect(s.nodes[RED_NODE]!.attempts).toBe(1);
  });
});

describe('failure fingerprints', () => {
  it('blocks a node after the same fingerprint repeats to the limit', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s.budget.max_same_failure = 2;

    s = recordFailure(GRAPH, s, RED_NODE, 'assert:publish-missing', { actor: 'test' });
    expect(s.nodes[RED_NODE]!.state).not.toBe('BLOCKED');
    expect(s.nodes[RED_NODE]!.failure_counts['assert:publish-missing']).toBe(1);

    s = recordFailure(GRAPH, s, RED_NODE, 'assert:publish-missing', { actor: 'test' });
    expect(s.nodes[RED_NODE]!.state).toBe('BLOCKED');
    expect(s.nodes[RED_NODE]!.blocked_reason).toMatch(/assert:publish-missing/);
  });

  it('does not block on two different fingerprints', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s = recordFailure(GRAPH, s, RED_NODE, 'fp-a', { actor: 'test' });
    s = recordFailure(GRAPH, s, RED_NODE, 'fp-b', { actor: 'test' });
    expect(s.nodes[RED_NODE]!.state).not.toBe('BLOCKED');
  });

  it('dedupes a retry that merely swapped the model or agent name', () => {
    let s = freshState();
    s = at(s, RED_NODE, 'READY');
    s.budget.max_same_failure = 2;
    s = recordFailure(GRAPH, s, RED_NODE, 'fp-x', { actor: 'worker-sonnet' });
    s = recordFailure(GRAPH, s, RED_NODE, 'fp-x', { actor: 'worker-opus' });
    expect(s.nodes[RED_NODE]!.state).toBe('BLOCKED');
  });
});

describe('budget accumulation', () => {
  it('accumulates child usage into the parent feature total', () => {
    let s = freshState();
    s = accumulateUsage(s, RED_NODE, { model_turns: 5, wall_clock_ms: 1000, sessions: 1 });
    s = accumulateUsage(s, IMPL, { model_turns: 7, wall_clock_ms: 2000, sessions: 1 });
    expect(s.usage.model_turns).toBe(12);
    expect(s.usage.sessions).toBe(2);
    expect(s.nodes[RED_NODE]!.usage.model_turns).toBe(5);
  });

  it('flips the feature to BUDGET_EXHAUSTED when a total is exceeded', () => {
    let s = freshState();
    s.budget.max_total_model_turns = 10;
    s = accumulateUsage(s, RED_NODE, { model_turns: 6 });
    expect(s.feature_state).not.toBe('BUDGET_EXHAUSTED');
    s = accumulateUsage(s, IMPL, { model_turns: 6 });
    expect(s.feature_state).toBe('BUDGET_EXHAUSTED');
    expect(s.blocked_reason).toMatch(/model_turns/);
  });

  it('a child loop cannot create fresh headroom by resetting its own counter', () => {
    let s = freshState();
    s.budget.max_total_sessions = 2;
    s = accumulateUsage(s, RED_NODE, { sessions: 1 });
    s.nodes[RED_NODE]!.usage.sessions = 0; // simulate a child resetting itself
    s = accumulateUsage(s, RED_NODE, { sessions: 1 });
    s = accumulateUsage(s, RED_NODE, { sessions: 1 });
    expect(s.feature_state).toBe('BUDGET_EXHAUSTED');
  });
});
