/**
 * `feature status` says what the next host invocation does, machine-readably
 * (CSET-203 r4: the corrective controller exited 0 with the cli READY in its
 * rework generation, one attempt of it refused, and nothing said the run
 * could go on). `next_action.kind` is one of dispatch, reconcile, deliver,
 * decision, none or stopped; `resumable` is true exactly when a controller
 * invoked again (`/mycelink:run`) has work it can do without a person.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { mutateState } from '../../src/state/feature-state.js';
import { CLI, CLI_SRC, CLI_TESTS, CLI_TRUNCATED_IMPL, CLI_TRUNCATED_RED, CLI_COMPAT_TEST_BODY, VER_FEATURE, commitVerControl, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { commit, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { GAP_AC1, GAP_AC3, GAP_AC5, carriedItems, commitCompat, dispatch, repairArp, reviewed, settle, status, tddClaim, writeResult } from '../helpers/cset203-rework.js';

afterAll(() => cleanupTmpRoots());

/** r4's corrective session up to its exit: the cli's first rework attempt refused as CHANGED_RED_BLOBS. */
async function refusedOnce(): Promise<{ s: Ver; t: ShopTicket }> {
  const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
  await repairArp(s);
  const t = (await dispatch(s)).ticket!;
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
  const red = runGate(t, 'red', s.control);
  commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3');
  writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
  const green = runGate(t, 'green', s.control);
  commit(t.worktree, [CLI_SRC], 'fix(cli): AC-3');
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED + CLI_COMPAT_TEST_BODY });
  commitCompat(t.worktree, [CLI_TESTS], 'AC-5');
  const again = runGate(t, 'green', s.control);
  runGate(t, 'regression', s.control);
  writeResult(t, [{ criterion: 'AC-3', test_id: red.tests[0]?.id, gate: 'red', output_sha256: red.sha256 }, ...carriedItems(t), { criterion: 'AC-5', test_id: again.tests[0]?.id, gate: 'green', output_sha256: green.sha256 }], tddClaim(t, [{ red: [0], green: [1] }]));
  expect((await settle(s, t)).outcome).toBe('TDD_HISTORY_INVALID');
  commitVerControl(s, 'refused');
  return { s, t };
}

describe('feature status --json: next_action and resumable', () => {
  it("after r4's refusal: dispatch, resumable, naming the READY cli, its generation, the attempts left and the refusal", async () => {
    const { s } = await refusedOnce();
    const st = await status(s);
    expect(st['resumable']).toBe(true);
    expect(st['next_action']).toMatchObject({ kind: 'dispatch', resumable: true, command: `dispatch ${VER_FEATURE}` });
    const cli = (st['next_action']['nodes'] as Record<string, any>[]).find((n) => n['node_id'] === CLI);
    expect(cli).toMatchObject({ state: 'READY', rework_generation: 1, attempts_used: 1, max_attempts: 2, last_refusal: { code: 'TDD_HISTORY_INVALID:CHANGED_RED_BLOBS', commit: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    expect(st['next_action']['detail']).toContain(CLI);
    // The human form says it too.
    const text = (await verCli(s, ['feature', 'status', VER_FEATURE])).out;
    expect(text).toMatch(/^next: dispatch \(resumable\)/m);
  });

  it('a generation whose attempts are spent needs a person: decision, not resumable', async () => {
    const { s } = await refusedOnce();
    // The second attempt refused the same way.
    const t = (await dispatch(s)).ticket!;
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    runGate(t, 'red', s.control);
    commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3');
    writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    runGate(t, 'green', s.control);
    commit(t.worktree, [CLI_SRC], 'fix(cli): AC-3');
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED + CLI_COMPAT_TEST_BODY });
    commitCompat(t.worktree, [CLI_TESTS], 'AC-5');
    writeResult(t, [], tddClaim(t, [{ red: [0], green: [1] }]));
    const second = await settle(s, t);
    expect(['TDD_HISTORY_INVALID', 'BLOCKED']).toContain(second.outcome);
    commitVerControl(s, 'refused twice');
    const st = await status(s);
    expect(st['resumable']).toBe(false);
    expect(st['next_action']).toMatchObject({ kind: 'decision', resumable: false });
    expect(st['next_action']['detail']).toMatch(/ATTEMPTS_EXHAUSTED|attempts|BLOCKED/);
  });

  it('a dispatched node holds a live lease: await-worker, resumable; once it expires (its worker gone with its session): reconcile', async () => {
    const s = await reviewed({ 'AC-3': GAP_AC3 });
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    commitVerControl(s, 'dispatched');
    let st = await status(s);
    expect(st['next_action']).toMatchObject({ kind: 'await-worker', resumable: true, command: null });
    expect(st['next_action']['nodes'].map((n: { node_id: string }) => n.node_id)).toEqual([CLI]);
    expect(st['orchestration']['active_leases']).toEqual([expect.objectContaining({ node_id: CLI, dispatch_id: t.dispatch_id })]);
    mutateState(s.featureDir, (x) => {
      x.nodes[CLI]!.claim!.expires_at = new Date(Date.now() - 1000).toISOString();
      return x;
    });
    st = await status(s);
    expect(st['next_action']).toMatchObject({ kind: 'reconcile', resumable: true, command: `session reconcile ${VER_FEATURE}` });
    expect(st['next_action']['nodes'].map((n: { node_id: string }) => n.node_id)).toEqual([CLI]);
  });

  it('a review that reworked a producer: dispatch, resumable, the reworked node named (the delivered end is none: cset203-r4-replay-e2e)', async () => {
    const s = await reviewed({ 'AC-3': GAP_AC3 });
    const st = await status(s);
    expect(st['next_action']).toMatchObject({ kind: 'dispatch', resumable: true });
    expect(st['next_action']['nodes'].map((n: { node_id: string }) => n.node_id)).toContain(CLI);
    expect(verState(s).feature_state).not.toBe('COMPLETED');
  });
});
