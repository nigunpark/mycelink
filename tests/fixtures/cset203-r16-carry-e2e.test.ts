/**
 * CSET-203 r16 with-faults, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r16 (fault arm; trusted, controller authority recovered): a teammate's
 * commit landed on main while apply-release-plan's first worker worked and the
 * integration merged it; the cli's first generation settled AC-3 with its RED
 * and fix (AC-4 and AC-5 beside it); R001's first reviewer was lost with its
 * host when the session was killed and re-issued; R001 found AC-1 on
 * apply-release-plan (its code already held the reproduction) and AC-3 (its
 * tests too narrow) and AC-5 on the cli; apply-release-plan challenged AC-1,
 * the refinement withdrew it and rebased the cli's order, untouched, to
 * revision 1; the cli's continuation found R001's AC-3 reproduction passing on
 * its first generation's head, kept it out of the branch and committed AC-5's
 * compatibility unit — and settle demanded a RED of that generation for the
 * whole node: INVALID_RED_EVIDENCE charged twice, the cli BLOCKED, no
 * candidate. Duplicate and stale replays of a settle were idempotent; the late
 * defect never applied (nothing was delivered).
 *
 * Here, the same faults in the same order:
 *
 *  1. the teammate's commit on main during apply-release-plan's first work,
 *     merged by its integration; the cli's first generation completes AC-3
 *     (RED, fix), AC-4 and AC-5;
 *  2. R001's reviewer lost with its host, re-issued, finding r16's gaps;
 *  3. apply-release-plan's challenge of AC-1, withdrawn by the refinement; the
 *     cli's order rebased to revision 1;
 *  4. the cli's continuation — R001's AC-3 reproduction passing (its red gate
 *     refused: "all pass on the unchanged base"), kept out of the branch;
 *     AC-5's unit committed — its host restarted mid-way (dispatch --resume),
 *     answered on the new ticket: AC-3 DONE by its completed proof and that
 *     re-proof, AC-5 by its unit; settled DONE, nothing charged; the old
 *     ticket's late answer stale;
 *  5. R002 PASS; C001 delivered; duplicate and stale settle replays change
 *     nothing;
 *  6. the late defect (apply-release-plan's delivered code reverted on main),
 *     QA's report reworking it from the delivery: its completions no longer
 *     hold there; its RED and fix; the cli re-proved on the repaired head by
 *     its carried RED, never run again; R003 PASS; C002 delivered;
 *  7. trusted and verified: the teammate's commit in the delivered history,
 *     the hidden-like AC-1, AC-3 and AC-5 checks pass, AC-3 completed by one
 *     product attempt's RED and only carried after it, nothing charged for the
 *     carry anywhere.
 *
 * The second test: after C001, a teammate's edit on main breaks AC-3's
 * recovery (not AC-4's failure reporting, in the same file). A later rework of
 * the cli for AC-5 alone revalidates what it carries on the adopted head
 * before its worker runs: AC-3's test fails there, so AC-3 alone is reopened
 * (ordered by its own RED), AC-4 stays carried; its RED, its fix, AC-5's
 * unit; nothing charged; C002 delivered with AC-3 restored and the teammate's
 * commit kept.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  ARP,
  ARP_FIXED_IMPL,
  ARP_SRC,
  BASE_FILES,
  CLI,
  CLI_COMPAT_TEST_ID,
  CLI_COMPAT_TESTS,
  CLI_FAILURE_TEST,
  CLI_JOURNAL_STATUS_TEST,
  CLI_RECOVERY_TEST,
  CLI_SRC,
  CLI_TRUNCATED_IMPL,
  COMPAT,
  VER_CANDIDATE,
  VER_CHANGELOG_ACCEPTANCE,
  VER_FEATURE,
  VER_R3_ACCEPTANCE,
  commitVerControl,
  verCli,
  verCliTestId,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { commit, fulfil, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { commitCompat, dispatch, settle, status, writeResult } from '../helpers/cset203-rework.js';
import { settleReview } from '../helpers/cset203-r7.js';
import { R001, R002, TEAM_NOTES, cite, compatContinuation, eventsOf, ledgerOf, nothingCharged, r16Reviewed, reproofAnswer, reworkOf, teammateCommit, withdrawSibling, type R16 } from '../helpers/cset203-r16.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
/** The product state a settle may change: every node, the review, the candidate, the integration heads (never a lease's bookkeeping). */
const stateHash = (s: Ver): string => {
  const d = verState(s);
  return sha256(JSON.stringify({ nodes: d.nodes, review: { ...(d.acceptance_review ?? {}), usage: undefined }, candidate: d.current_candidate, heads: d.integration_heads, feature: d.feature_state }));
};

/** r16's own AC-3 reproduction as hidden acceptance would check it, from outside, on a checkout: a journal restored before anything else, one versioning committed. */
const VER_R16_AC3_ACCEPTANCE = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const cli = await import(pathToFileURL(join(root, 'packages/cli/src/index.mjs')).href);
const journal = JSON.stringify({ before: [{ path: 'packages/d/package.json', content: '{"version":"3.0.0"}' }, { path: '.changeset/four.md', content: 'four' }] });
const files = new Map([['packages/d/package.json', '{"version":"3.1.0"}'], ['.changeset/.version-journal.json', journal]]);
const warnings = [];
const calls = [];
const code = await cli.version({ files, changes: [{ path: 'packages/d/package.json', content: '{"version":"3.1.0"}' }, { path: '.changeset/four.md', content: null }], config: { commit: true }, io: { log() {}, warn: (m) => warnings.push(m), error() {} }, git: { add: (p) => calls.push(['add', p]), commit: (m) => calls.push(['commit', m]) } });
assert.equal(code, 0, 'AC-3 versions after recovering');
assert.ok(warnings.some((w) => /interrupted/.test(w)), 'AC-3 warns interrupted');
assert.deepEqual([...files], [['packages/d/package.json', '{"version":"3.1.0"}']], 'AC-3 the journal restored before anything else, then versioned once');
assert.deepEqual(calls, [['add', ['packages/d/package.json', '.changeset/four.md']], ['commit', 'Version Packages']], 'AC-3 exactly one versioning committed');
console.log('r16 AC-3 acceptance: ok');
`;

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r16-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r16-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

/**
 * Every review dispatch hands out answered PASS, controller nodes run inside dispatch, until the feature is settled:
 * then the candidate is delivered and accepted. Product tickets are the caller's: none may come out here.
 */
async function reviewAndDeliver(s: Ver, expected: { review: string; candidate: string }): Promise<void> {
  let reviewed = false;
  for (let i = 0; i < 6; i++) {
    const d = await dispatch(s);
    if (d.status === 'ALL_SETTLED') {
      expect(reviewed, `${expected.review} was never handed out`).toBe(true);
      expect((d.controller_reports ?? []).map((x) => x.node_id)).toContain(VER_CANDIDATE);
      commitVerControl(s, 'settled');
      const delivered = JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out) as Record<string, unknown>;
      expect(delivered).toMatchObject({ status: 'ACCEPTED', candidate_id: expected.candidate });
      commitVerControl(s, `delivered ${expected.candidate}`);
      return;
    }
    const t = d.ticket as unknown as ReviewTicket & { kind?: string; refinement?: unknown };
    expect(t?.kind, `dispatch ${i}: ${d.status} ${d.detail}`).toBe('acceptance-review');
    expect(t.review_id).toBe(expected.review);
    await writeVerdict(t, verdictFor(reviewPacket(t)), { cwd: s.control });
    expect(await settleReview(s, t)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, `${expected.review} PASS`);
    reviewed = true;
  }
  throw new Error('the feature never settled');
}

/** Steps 1–4: R001 (its reviewer lost and re-issued), the sibling's challenge withdrawn, the cli's continuation restarted mid-way and settled. */
async function continued(): Promise<{ s: R16; attempts: number; stale: ShopTicket; t: ShopTicket }> {
  const s = await r16Reviewed();
  expect(eventsOf(s).filter((e) => e.type === 'review.reviewer_interrupted').map((e) => e.data['reason'])).toEqual(['host-ended']);
  await withdrawSibling(s);
  const attempts = verState(s).nodes[CLI].attempts as number;
  const t1 = (await dispatch(s)).ticket!;
  expect(t1.node_id).toBe(CLI);
  expect(reworkOf(t1)).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-5'], completed_criteria: [expect.objectContaining({ criterion: 'AC-3' })], carried_criteria: [expect.objectContaining({ criterion: 'AC-4' })] });
  const run = compatContinuation(t1, s.control);
  // The host is killed with the worker's gates run and its unit committed: the same generation resumes from where it stands.
  const resumed = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', CLI, '--json'])).out) as { ticket?: ShopTicket; status: string; detail: string };
  expect(resumed.ticket, resumed.detail).toBeDefined();
  const t2 = resumed.ticket as ShopTicket;
  expect(t2).toMatchObject({ node_id: CLI, claim_id: t1.claim_id, worktree: t1.worktree });
  expect(t2.dispatch_id).not.toBe(t1.dispatch_id);
  reproofAnswer(t2, run);
  const done = await settle(s, t2);
  expect(done, done.detail).toMatchObject({ outcome: 'DONE', state: 'DONE' });
  commitVerControl(s, 'cli: compatibility-only continuation, AC-3 re-proved');
  // The killed generation's late answer: stale, archived, nothing judged or changed.
  const before = stateHash(s);
  reproofAnswer(t1, run);
  const late = await settle(s, t1);
  // Archive-only: its lease marked stale, its answer kept apart; nothing of the product moved.
  expect(late, late.detail).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
  expect(late.detail).toMatch(/archived/);
  expect(stateHash(s)).toBe(before);
  return { s, attempts, stale: t1, t: t2 };
}

/** The ledger's records of a criterion on a node, oldest first, as [generation, basis]. */
const lineage = (s: Ver, node: string, criterion: string): [number, string][] => ledgerOf(s, node).filter((r) => r.criterion === criterion).map((r) => [r.generation as number, r.basis as string]);

describe('CSET-203 r16 fault arm, replayed model-free to the delivery it should have reached', () => {
  it("the concurrent commit, the lost reviewer, the sibling's withdrawn challenge, a restarted compatibility-only continuation whose passing RED re-proves AC-3, duplicate and stale replays, the late defect repaired: C002 delivered, trusted and verified — AC-3 completed by one RED, carried after it, nothing charged", async () => {
    const { s, attempts, t } = await continued();
    let state = verState(s);
    // One product attempt for the continuation, nothing charged for its carry; AC-3's completion stands on its first RED.
    expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', attempts: attempts + 1, failure_counts: {} });
    expect(lineage(s, CLI, 'AC-3')).toEqual([[0, 'red'], [1, 'reproved']]);
    expect(state.nodes[CLI].evidence.red).toMatchObject({ carried_from: { criterion: 'AC-3', generation: 0 } });
    nothingCharged(s);

    // 5. R002 PASS, C001.
    await reviewAndDeliver(s, { review: R002, candidate: `${VER_FEATURE}-C001` });
    const c001 = git(s.repo, ['rev-parse', 'main']);
    expect(git(s.repo, ['merge-base', '--is-ancestor', s.teammate, c001])).toBe('');
    // The fault arm's session-end replays: a settle the host ran (its spent capability), and the first one seen.
    const before = stateHash(s);
    // r16's records: both answered STALE_ORCHESTRATION_EPOCH (or the stored receipt), idempotent, the state unchanged.
    for (const replay of [t, s.first.arp]) expect(['DONE', 'STALE_ORCHESTRATION_EPOCH']).toContain((await settle(s, replay)).outcome);
    expect(stateHash(s)).toBe(before);

    // 6. The late defect: apply-release-plan's delivered production change reverted on main; QA reports what broke.
    writeFiles(s.repo, { [ARP_SRC]: BASE_FILES[ARP_SRC] as string });
    git(s.repo, ['add', '--', ARP_SRC]);
    git(s.repo, ['commit', '-q', '-m', 'chore: sync platform changes']);
    const report = '[AC-1] when the formatter crashes after files were changed, every file is restored and the original error is the cause (failed: assertion); [AC-2] the journal is kept while applying and removed afterwards (failed: assertion)';
    const qa = JSON.parse((await verCli(s, ['feature', 'rework', VER_FEATURE, '--reason', `QA on the delivered commit: ${report}`, '--since-delivery', '--json'])).out) as Record<string, any>;
    expect(qa, JSON.stringify(qa)).toMatchObject({ targets: [ARP] });
    commitVerControl(s, 'QA rework');
    // apply-release-plan: its RED (QA's reproduction fails on the reverted code) and the fix.
    const a = (await dispatch(s)).ticket!;
    expect(a.node_id).toBe(ARP);
    const qaTests = 'packages/apply-release-plan/test/qa.test.mjs';
    const fixed = fulfil(a, {
      tests: {
        [qaTests]: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyReleasePlan } from '../src/index.mjs';\n\ntest('QA: a crash after a change restores every file, the cause kept', async () => {\n  const files = new Map([['packages/q/package.json', '{"version":"1.0.0"}']]);\n  const failure = new Error('formatter crashed');\n  const error = await applyReleasePlan(files, [{ path: 'packages/q/package.json', content: '{"version":"2.0.0"}' }], { format: async () => { throw failure; } }).then(() => null, (e) => e);\n  assert.equal(error.cause, failure);\n  assert.deepEqual([...files], [['packages/q/package.json', '{"version":"1.0.0"}']]);\n});\n\ntest('QA: a journal is kept while applying and removed afterwards', async () => {\n  const files = new Map([['packages/q/package.json', '{"version":"1.0.0"}']]);\n  const seen = [];\n  await applyReleasePlan(files, [{ path: 'packages/q/package.json', content: '{"version":"2.0.0"}' }], { format: async () => seen.push([...files.keys()].some((p) => p.startsWith('.changeset/.'))) });\n  assert.deepEqual(seen, [true]);\n  assert.deepEqual([...files.keys()], ['packages/q/package.json']);\n});\n`,
      },
      impl: { [ARP_SRC]: ARP_FIXED_IMPL },
      criteria: [
        { criterion: 'AC-1', gate: 'red', full_name: 'QA: a crash after a change restores every file, the cause kept' },
        { criterion: 'AC-2', gate: 'red', full_name: 'QA: a journal is kept while applying and removed afterwards' },
      ],
    }, s.control);
    expect(fixed.result['outcome'], JSON.stringify(fixed.gates.map((g) => [g.gate, g.code, g.out.slice(-300)]))).toBe('SUBMITTED');
    const arpDone = await settle(s, a);
    expect(arpDone, arpDone.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'apply-release-plan repaired');
    // The cli, reopened by its upstream's rework, re-proved on the repaired head: green and regression, its carried RED cited, never run again.
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    fulfil(c, {
      criteria: [
        { criterion: 'AC-3', gate: 'red', test_id: verCliTestId(CLI_RECOVERY_TEST) },
        { criterion: 'AC-4', gate: 'red', test_id: verCliTestId(CLI_FAILURE_TEST) },
        { criterion: 'AC-5', gate: 'green', test_id: CLI_COMPAT_TEST_ID },
      ],
    }, s.control);
    const reverified = await settle(s, c);
    expect(reverified, reverified.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli re-proved');
    await reviewAndDeliver(s, { review: `${VER_FEATURE}-R003`, candidate: `${VER_FEATURE}-C002` });

    // 7. Trusted and verified.
    state = verState(s);
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
    const delivered = git(s.repo, ['rev-parse', 'main']);
    expect(git(s.repo, ['merge-base', '--is-ancestor', s.teammate, delivered])).toBe('');
    expect(git(s.repo, ['show', `${delivered}:${TEAM_NOTES}`])).toContain('Release freeze');
    for (const script of [VER_R3_ACCEPTANCE, VER_CHANGELOG_ACCEPTANCE, VER_R16_AC3_ACCEPTANCE]) {
      const r = acceptance(s.repo, delivered, script);
      expect(r.code, r.out).toBe(0);
    }
    // AC-3: one RED ever ran for it (the first generation's); every later generation carried or re-proved it.
    const ac3 = lineage(s, CLI, 'AC-3');
    expect(ac3.filter(([, b]) => b === 'red')).toEqual([[0, 'red']]);
    expect(ac3.slice(1).every(([, b]) => b === 'carried' || b === 'reproved')).toBe(true);
    // Nothing administrative charged anywhere; no person asked.
    nothingCharged(s);
    expect(eventsOf(s).filter((e) => e.type === 'node.settled' && e.data['outcome'] === 'BLOCKED')).toEqual([]);
    expect(await status(s)).toMatchObject({ next_action: { kind: 'none' } });
  }, 600_000);

  it("a teammate's edit on main that breaks AC-3 (and not AC-4, in the same file) after C001: a later rework of the cli for AC-5 reopens AC-3 alone before its worker runs; its RED and fix; AC-4 carried; nothing charged; C002 delivered with the teammate's commit", async () => {
    const { s } = await continued();
    await reviewAndDeliver(s, { review: R002, candidate: `${VER_FEATURE}-C001` });
    // The teammate's edit: the recovery warning reworded without "interrupted" (AC-3), the failure reporting untouched (AC-4).
    const broken = CLI_TRUNCATED_IMPL.replace('A previous changeset version run was interrupted', 'A previous changeset version run did not finish');
    expect(broken).not.toBe(CLI_TRUNCATED_IMPL);
    const edit = teammateCommit(s, { [CLI_SRC]: broken }, 'chore(cli): reword the recovery notice');
    // A later rework of the cli for AC-5 alone.
    const reason = 'QA on the delivered commit: AC-5 status beside a journal written by an older release is not shown by any regression test';
    const r = JSON.parse((await verCli(s, ['node', 'rework', VER_FEATURE, CLI, '--reason', reason, '--acceptance', 'AC-5', '--json'])).out) as Record<string, any>;
    expect(r, JSON.stringify(r)).toMatchObject({ node_id: CLI, idempotent: false });
    commitVerControl(s, 'rework the cli for AC-5');
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    // Revalidated on the adopted head before the worker ran: AC-3's test fails there — reopened alone; AC-4 still holds — carried.
    const rework = reworkOf(t);
    expect(rework['acceptance_criteria']).toEqual(['AC-5', 'AC-3']);
    expect(rework['reopened']).toEqual([expect.objectContaining({ criterion: 'AC-3', code: 'COMPLETION_TEST_FAILED' })]);
    expect(rework['carried_criteria']).toEqual([expect.objectContaining({ criterion: 'AC-4' })]);
    expect(eventsOf(s).filter((e) => e.type === 'node.criterion_reopened').map((e) => [e.data['criterion'], e.data['code']])).toEqual([['AC-3', 'COMPLETION_TEST_FAILED']]);
    expect(verState(s).nodes[CLI].claim.revalidation.verdicts.map((v: { criterion: string; ok: boolean }) => [v.criterion, v.ok]).sort()).toEqual([['AC-3', false], ['AC-4', true]]);
    // The worker: AC-3's RED (a focused test of the notice), its fix; AC-5's regression unit; AC-4's carried proof cited.
    const notice = 'packages/cli/test/recovery-notice.test.mjs';
    const NOTICE_TEST = 'version warns that the previous run was interrupted when it recovers one';
    writeFiles(t.worktree, { [notice]: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { version } from '../src/index.mjs';\n\ntest('${NOTICE_TEST}', async () => {\n  const journal = JSON.stringify({ before: [{ path: 'packages/n/package.json', content: '{"version":"1.0.0"}' }] });\n  const files = new Map([['packages/n/package.json', '{"version":"1.1.0"}'], ['.changeset/.version-journal.json', journal]]);\n  const warnings = [];\n  await version({ files, changes: [], io: { log() {}, warn: (m) => warnings.push(m), error() {} }, git: { add() {}, commit() {} } });\n  assert.ok(warnings.some((w) => /interrupted/.test(w)));\n});\n` });
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(t.worktree, [notice], 'test(cli): the recovery notice says interrupted');
    writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(t, 'green', s.control).code).toBe(0);
    commit(t.worktree, [CLI_SRC], 'fix(cli): the recovery notice says the run was interrupted');
    const compatTests = 'packages/cli/test/journal-legacy.test.mjs';
    const LEGACY_TEST = 'status is unaffected by a journal an older release wrote';
    writeFiles(t.worktree, { [compatTests]: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { status } from '../src/index.mjs';\n\ntest('${LEGACY_TEST}', () => {\n  const lines = [];\n  status({ files: new Map([['.changeset/c.md', 'c'], ['.changeset/.version-journal.json', '[]']]), io: { log: (l) => lines.push(l) } });\n  assert.deepEqual(lines, ['.changeset/c.md']);\n});\n` });
    commitCompat(t.worktree, [compatTests], 'AC-5');
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    const carried = (rework['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
    writeResult(t, [
      { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === NOTICE_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
      ...carried.map(cite),
      { criterion: 'AC-5', test_id: green.tests.find((x) => x.full_name === LEGACY_TEST)!.id, gate: 'green', output_sha256: green.sha256 },
    ]);
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: AC-3 reopened and repaired, AC-5');
    // AC-3: a new RED of its own; AC-4: carried, its root the first generation's RED.
    expect(lineage(s, CLI, 'AC-3').at(-1)).toEqual([2, 'red']);
    expect(lineage(s, CLI, 'AC-4').at(-1)).toEqual([2, 'carried']);
    nothingCharged(s);
    await reviewAndDeliver(s, { review: `${VER_FEATURE}-R003`, candidate: `${VER_FEATURE}-C002` });
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
    const delivered = git(s.repo, ['rev-parse', 'main']);
    expect(git(s.repo, ['merge-base', '--is-ancestor', edit, delivered])).toBe('');
    for (const script of [VER_R3_ACCEPTANCE, VER_R16_AC3_ACCEPTANCE]) {
      const res = acceptance(s.repo, delivered, script);
      expect(res.code, res.out).toBe(0);
    }
    void COMPAT;
  }, 600_000);
});
