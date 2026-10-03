/**
 * The real-Claude pilot's acceptance rule.
 *
 * The first real pilot "passed" with RESULT_MISSING: the worker never got its
 * brief, wrote nothing, and the pilot accepted READY as a valid ending. For an
 * implementable node, a pilot passes only with a structured worker result and
 * either verified RED/GREEN evidence or a justified product decision.
 */
import { describe, expect, it } from 'vitest';
import { pilotVerdict, type PilotObservation } from '../pilot/verdict.js';

const red = { exit_code: 1, red_reason: 'behaviour-missing', command: ['node', 'tests/run.mjs'] };
const green = { exit_code: 0, command: ['node', 'tests/run.mjs'] };

function obs(overrides: Partial<PilotObservation>): PilotObservation {
  return {
    final_state: 'DONE',
    detail: 'fresh verification passed',
    worker_result: { outcome: 'SUBMITTED', decision_request: null },
    red,
    green,
    ...overrides,
  };
}

describe('real-Claude pilot verdict', () => {
  it('fails the exact first-pilot outcome: READY with RESULT_MISSING and no evidence', () => {
    const v = pilotVerdict(
      obs({ final_state: 'READY', detail: 'RESULT_MISSING', worker_result: null, red: null, green: null }),
    );
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/RESULT_MISSING|structured result/);
  });

  it('fails any ending without a structured worker result, even DONE', () => {
    expect(pilotVerdict(obs({ worker_result: null })).ok).toBe(false);
  });

  it('fails a structured but unfinished ending for an implementable node', () => {
    for (const [final_state, outcome] of [
      ['READY', 'RETRYABLE'],
      ['BLOCKED', 'BLOCKED'],
      ['BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED'],
    ] as const) {
      const v = pilotVerdict(
        obs({ final_state, detail: 'x', worker_result: { outcome, decision_request: null }, red: null, green: null }),
      );
      expect(v.ok, final_state).toBe(false);
    }
  });

  it('passes DONE with a behaviour-missing RED and a GREEN on the same command', () => {
    expect(pilotVerdict(obs({}))).toEqual({ ok: true, reasons: [] });
  });

  it('fails DONE whose RED was a setup error or whose GREEN differs', () => {
    expect(pilotVerdict(obs({ red: { ...red, red_reason: 'setup-error' } })).ok).toBe(false);
    expect(pilotVerdict(obs({ green: { exit_code: 0, command: ['node', 'other.mjs'] } })).ok).toBe(false);
  });

  it('passes a justified product decision: NEEDS_DECISION with a real question and options', () => {
    const v = pilotVerdict(
      obs({
        final_state: 'NEEDS_DECISION',
        worker_result: {
          outcome: 'NEEDS_DECISION',
          decision_request: { question: 'Break v1 or add a v2 field?', options: ['break-v1', 'add-v2'] },
        },
        red: null,
        green: null,
      }),
    );
    expect(v).toEqual({ ok: true, reasons: [] });
  });

  it('fails NEEDS_DECISION without a usable decision request', () => {
    const v = pilotVerdict(
      obs({
        final_state: 'NEEDS_DECISION',
        worker_result: { outcome: 'NEEDS_DECISION', decision_request: { question: '', options: ['only-one'] } },
        red: null,
        green: null,
      }),
    );
    expect(v.ok).toBe(false);
  });
});
