/**
 * Settle counts a worker's usage exactly once, across crashes.
 *
 * A settle used to record the captured result's hash in one STATE.json write
 * and add the worker's usage in the next; a settle that died in between was
 * completed from the captured copy with its usage skipped, so the usage was
 * lost. A settle that died after writing its controller copy but
 * before recording it lost the result itself. Each boundary is
 * crossed here by failing the settle at that point and settling again with
 * the same capability.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { CORE, WORK, dispatch, hostPortfolio } from '../helpers/host-loop.js';
import { loadState } from '../../src/state/feature-state.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';

afterAll(() => cleanupTmpRoots());

function orchestrator(p: Portfolio, crashAt?: SettleFaultPoint): Orchestrator {
  return new Orchestrator({
    controlRoot: p.control,
    featureId: FEATURE_ID,
    adapter: {} as SessionAdapter,
    ...(crashAt ? { settleFault: (point: SettleFaultPoint) => { if (point === crashAt) throw new Error(`CRASH at ${point}`); } } : {}),
  });
}

function usage(p: Portfolio): { sessions: number; model_turns: number; input_tokens?: number; output_tokens?: number } {
  return loadState(p.featureDir)!.data.nodes[CORE]!.usage as never;
}

describe('settle usage is exactly-once', () => {
  let p: Portfolio;
  let t: DispatchTicket;
  beforeEach(async () => {
    p = await hostPortfolio();
    t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control); // reports 3 turns, 300 in, 150 out
  });

  it('without a crash, counts one session with the reported figures', () => {
    expect(orchestrator(p).settle(CORE, t.capability).outcome).toBe('DONE');
    expect(usage(p)).toMatchObject({ sessions: 1, model_turns: 3, input_tokens: 300, output_tokens: 150 });
  });

  for (const point of ['result-captured', 'result-attested', 'attempt-concluded'] as SettleFaultPoint[]) {
    it(`a settle that dies at ${point} completes on retry with the result and the usage counted once`, () => {
      expect(() => orchestrator(p, point).settle(CORE, t.capability)).toThrow(/CRASH/);
      const report = orchestrator(p).settle(CORE, t.capability);
      expect(report.outcome).toBe('DONE');
      expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('DONE');
      expect(usage(p)).toMatchObject({ sessions: 1, model_turns: 3, input_tokens: 300, output_tokens: 150 });
      expect(loadState(p.featureDir)!.data.usage).toMatchObject({ sessions: 1, model_turns: 3 });
      // A third settle is answered from the receipt and changes nothing.
      expect(orchestrator(p).settle(CORE, t.capability).idempotent).toBe(true);
      expect(usage(p)).toMatchObject({ sessions: 1, model_turns: 3 });
    });
  }
});
