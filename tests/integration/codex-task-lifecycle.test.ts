import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { API, CORE, WORK, cli, dispatch, hostPortfolio, settle } from '../helpers/host-loop.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';

afterAll(() => cleanupTmpRoots());

// There is deliberately no TaskCreated, TaskCompleted or PostCompact hook in any of these paths.
describe('task lifecycle at controller-owned transitions, without host task hooks', () => {
  it('refuses an out-of-graph claim even if the caller bypasses dispatch selection', async () => {
    const p = await hostPortfolio();
    const orchestrator = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID, adapter: {} as never });
    expect(() => orchestrator.claim(API, { mode: 'host' })).toThrow(/DEPENDENCIES_NOT_DONE/);
    expect(loadState(p.featureDir)!.data.nodes[API]!.claim).toBeNull();
  });

  it('does not treat an agent completion claim as a settled node', async () => {
    const p = await hostPortfolio();
    const ticket = (await dispatch(p)).ticket!;
    const result = await cli(p, ['settle', FEATURE_ID, CORE, '--capability', ticket.capability, '--json']);
    expect(result.code).not.toBe(0);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).not.toBe('DONE');
  });

  it('refuses a resumed task when its graph dependency is no longer DONE', async () => {
    const p = await hostPortfolio();
    const first = (await dispatch(p)).ticket!;
    fakeAgent(first, WORK[CORE]!, p.control);
    expect(await settle(p, CORE, first.capability)).toMatchObject({ outcome: 'DONE' });
    const dependent = (await dispatch(p)).ticket!;
    expect(dependent.node_id).toBe(API);
    mutateState(p.featureDir, (state) => {
      state.nodes[CORE]!.state = 'INVALIDATED';
      return state;
    });
    const resumed = await cli(p, ['dispatch', FEATURE_ID, '--resume', API, '--json']);
    expect(resumed.code).not.toBe(0);
    expect(resumed.err).toMatch(/DEPENDENCIES_NOT_DONE/);
    expect(loadState(p.featureDir)!.data.nodes[API]!.claim?.dispatch_id).toBe(dependent.dispatch_id);
  });

  it('does not settle a dependent after its graph dependency was invalidated', async () => {
    const p = await hostPortfolio();
    const first = (await dispatch(p)).ticket!;
    fakeAgent(first, WORK[CORE]!, p.control);
    expect(await settle(p, CORE, first.capability)).toMatchObject({ outcome: 'DONE' });
    const dependent = (await dispatch(p)).ticket!;
    fakeAgent(dependent, WORK[API]!, p.control);
    mutateState(p.featureDir, (state) => {
      state.nodes[CORE]!.state = 'INVALIDATED';
      return state;
    });
    const result = await cli(p, ['settle', FEATURE_ID, API, '--capability', dependent.capability, '--json']);
    expect(loadState(p.featureDir)!.data.nodes[API]!.state).not.toBe('DONE');
    expect(result.out + result.err).toMatch(/DEPENDENCIES_NOT_DONE/);
  });

  it('reloads canonical state after compaction without PostCompact before issuing a new generation', async () => {
    const p = await hostPortfolio();
    const first = (await dispatch(p)).ticket!;
    const freshController = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID, adapter: {} as never });
    const next = freshController.resumeDispatch(CORE).ticket as DispatchTicket;
    expect(next.dispatch_id).not.toBe(first.dispatch_id);
    expect(next.result_slot).not.toBe(first.result_slot);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.dispatch_id).toBe(next.dispatch_id);
  });
});
