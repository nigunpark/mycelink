/**
 * BLOCKED must not be laundered through INVALIDATED (root cause A3).
 *
 * Entering INVALIDATED used to need no justification and reset the attempt
 * count and every failure fingerprint, so BLOCKED -> INVALIDATED -> READY
 * erased the very history that blocked the node.
 */
import { describe, expect, it } from 'vitest';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';
import type { FeatureState_, PortfolioGraph } from '../../src/model/types.js';
import { initialState } from '../../src/state/feature-state.js';
import { applyNodeTransition, recordFailure } from '../../src/state/transition.js';

const GRAPH = clone(VALID_GRAPH) as unknown as PortfolioGraph;
const NODE = 'FEAT-101.core.publish.red';

function blockedTwice(): FeatureState_ {
  let s = initialState(GRAPH, 'a'.repeat(64));
  s = applyNodeTransition(GRAPH, s, NODE, 'READY', { actor: 't' });
  s = applyNodeTransition(GRAPH, s, NODE, 'CLAIMED', { actor: 't' });
  s = recordFailure(GRAPH, s, NODE, 'fp-same', { actor: 't', maxSameFailure: 2 });
  s = applyNodeTransition(GRAPH, s, NODE, 'READY', { actor: 't' });
  s = applyNodeTransition(GRAPH, s, NODE, 'CLAIMED', { actor: 't' });
  s = recordFailure(GRAPH, s, NODE, 'fp-same', { actor: 't', maxSameFailure: 2 });
  expect(s.nodes[NODE]!.state).toBe('BLOCKED');
  return s;
}

describe('leaving BLOCKED through INVALIDATED', () => {
  it('refuses BLOCKED -> INVALIDATED without a recorded justification', () => {
    const s = blockedTwice();
    expect(() => applyNodeTransition(GRAPH, s, NODE, 'INVALIDATED', { actor: 't', reason: 'retry' })).toThrow(
      /UNBLOCK_REQUIRES_JUSTIFICATION/,
    );
  });

  it('refuses the same laundering from NEEDS_DECISION and BUDGET_EXHAUSTED', () => {
    for (const parked of ['NEEDS_DECISION', 'BUDGET_EXHAUSTED'] as const) {
      let s = initialState(GRAPH, 'a'.repeat(64));
      s = applyNodeTransition(GRAPH, s, NODE, 'READY', { actor: 't' });
      s = applyNodeTransition(GRAPH, s, NODE, 'CLAIMED', { actor: 't' });
      s = applyNodeTransition(GRAPH, s, NODE, parked, { actor: 't', reason: parked });
      expect(() => applyNodeTransition(GRAPH, s, NODE, 'INVALIDATED', { actor: 't' })).toThrow(
        /UNBLOCK_REQUIRES_JUSTIFICATION/,
      );
    }
  });

  it('refuses the sibling routes out of BLOCKED: PAUSED and EXCLUDED', () => {
    for (const via of ['PAUSED', 'EXCLUDED'] as const) {
      const s = blockedTwice();
      expect(() => applyNodeTransition(GRAPH, s, NODE, via, { actor: 't' })).toThrow(/UNBLOCK_REQUIRES_JUSTIFICATION/);
      const ok = applyNodeTransition(GRAPH, s, NODE, via, { actor: 't', decisionId: 'DEC-2' });
      expect(ok.nodes[NODE]!.failure_counts).toEqual({ 'fp-same': 2 });
    }
  });

  it('keeps attempts and failure counts when a justified exit goes through INVALIDATED', () => {
    let s = blockedTwice();
    s = applyNodeTransition(GRAPH, s, NODE, 'INVALIDATED', { actor: 't', decisionId: 'DEC-1' });
    expect(s.nodes[NODE]!.failure_counts).toEqual({ 'fp-same': 2 });
    expect(s.nodes[NODE]!.attempts).toBe(2);
    expect(s.nodes[NODE]!.last_failure_fingerprint).toBe('fp-same');

    s = applyNodeTransition(GRAPH, s, NODE, 'READY', { actor: 't' });
    expect(s.nodes[NODE]!.failure_counts).toEqual({ 'fp-same': 2 });

    // The identical failure re-blocks at once instead of buying fresh retries.
    s = applyNodeTransition(GRAPH, s, NODE, 'CLAIMED', { actor: 't' });
    s = recordFailure(GRAPH, s, NODE, 'fp-same', { actor: 't', maxSameFailure: 2 });
    expect(s.nodes[NODE]!.state).toBe('BLOCKED');
  });

  it('keeps history for a cascade invalidation of a blocked dependent (input changed)', () => {
    let s = blockedTwice();
    s = applyNodeTransition(GRAPH, s, NODE, 'INVALIDATED', { actor: 't', inputChanged: true, reason: 'upstream' });
    expect(s.nodes[NODE]!.state).toBe('INVALIDATED');
    expect(s.nodes[NODE]!.failure_counts).toEqual({ 'fp-same': 2 });
  });

  it('still resets a DONE node invalidated by an upstream change', () => {
    let s = initialState(GRAPH, 'a'.repeat(64));
    s = applyNodeTransition(GRAPH, s, NODE, 'READY', { actor: 't' });
    s = applyNodeTransition(GRAPH, s, NODE, 'CLAIMED', { actor: 't' });
    s.nodes[NODE]!.failure_counts = { 'fp-old': 1 };
    s.nodes[NODE]!.state = 'DONE';
    s = applyNodeTransition(GRAPH, s, NODE, 'INVALIDATED', { actor: 't', reason: 'upstream changed' });
    expect(s.nodes[NODE]!.attempts).toBe(0);
    expect(s.nodes[NODE]!.failure_counts).toEqual({});
  });
});
