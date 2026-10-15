/**
 * CSET-203 r3, model-free, through the plugin's own loop (every platform):
 * the acceptance review's three gaps reworked at once, to delivery.
 *
 * r3 with-normal: every implementation node and the compatibility
 * verification node were DONE; the read-only reviewer found public GAPs on
 * AC-1 (rollback tested at one boundary), AC-3 (a journal cut short by a
 * kill never recovered from) and AC-5 (status beside a journal untested)
 * before any candidate. AC-5 belonged to the verification node alone, so
 * settle found no producer for it, reworked nothing and blocked; the
 * controller exited with the feature incomplete.
 *
 * Here, with r4's graph (the cli produces AC-5, the verification node proves
 * it again):
 *
 *  1. the producers settle as r2/r3's workers left them; the compatibility
 *     node runs; R001 finds AC-1, AC-3 and AC-5 — the reviewer naming the
 *     verification node for AC-5, as r3's did;
 *  2. one settle reworks apply-release-plan (AC-1) and the cli (AC-3, AC-5);
 *     the next dispatch is a worker ticket, not a stop;
 *  3. apply-release-plan: AC-1's focused RED, the fix; AC-2 carried;
 *  4. the cli: AC-3's focused RED and fix, then AC-5's regression test alone in a
 *     new test file after the code, as a compatibility-regression unit; AC-4 carried;
 *  5. the compatibility node runs again; R002's packet carries R001's
 *     untested AC-5 clause: a PASS standing on the receipt alone is refused,
 *     one citing the new test the gates passed is taken;
 *  6. the candidate, delivered and accepted; the hidden-like AC-1, AC-3 and
 *     AC-5 checks, failing on R001's reviewed head, pass on the delivery.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  ARP,
  ARP_CHANGELOG_TEST,
  ARP_FIXED_IMPL,
  ARP_GAPPY_IMPL,
  ARP_JOURNAL_TEST,
  ARP_RED,
  ARP_REVIEW_RED,
  ARP_ROLLBACK_TEST,
  ARP_SRC,
  ARP_TESTS,
  CLI,
  CLI_AC5,
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_COMPAT_TEST_ID,
  CLI_FAILURE_TEST,
  CLI_FULL_WORK,
  CLI_JOURNAL_STATUS_TEST,
  CLI_RECOVERY_TEST,
  CLI_SRC,
  CLI_TESTS,
  CLI_TRUNCATED_IMPL,
  CLI_TRUNCATED_RED,
  CLI_TRUNCATED_TEST,
  COMPAT,
  VER_CANDIDATE,
  VER_CHANGELOG_ACCEPTANCE,
  VER_FEATURE,
  VER_R3_ACCEPTANCE,
  commitVerControl,
  createVer,
  verCli,
  verState,
} from '../helpers/version-fixture.js';
import { commit, fulfil, packOf, runGate, writeFiles, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';
import { REVIEWER, reviewPacket, verdictFor, type ReviewTicket, type VerdictOverride } from '../helpers/review-agent.js';
import { runWithInput } from '../../src/util/child-stdin.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = join(process.cwd(), 'bin', 'mycelink.mjs');

type Dispatched = { status: string; detail: string; ticket?: ShopTicket & { kind?: string; agent: string }; controller_reports: { node_id: string; outcome: string }[] };
async function dispatch(s: { control: string }): Promise<Dispatched> {
  return JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out) as Dispatched;
}

/** The host runs a ticket's settle line exactly as rendered, as its Bash tool would. */
function runLine(line: string, cwd: string): { code: number; out: Record<string, any>; raw: string } {
  try {
    const raw = execSync(line, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: JSON.parse(raw) as Record<string, any>, raw };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    let out: Record<string, any> = {};
    try {
      out = JSON.parse(e.stdout ?? '{}') as Record<string, any>;
    } catch {
      // not JSON
    }
    return { code: e.status ?? 1, out, raw: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The stand-in reviewer subagent: its one write is the verdict, a Write the plugin's fence (the shipped launcher's hook) lets through and attests. */
function review(ticket: ReviewTicket, control: string, verdict: Record<string, unknown>): void {
  const content = JSON.stringify(verdict, null, 2);
  const hook = runWithInput(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], {
    input: JSON.stringify({ session_id: 'host-session', agent_id: 'a5e7c0ffee000004', agent_type: REVIEWER, cwd: control, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: ticket.result_slot, content } }),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (hook.status !== 0) throw new Error(`the fence refused the verdict: ${hook.stderr}`);
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, content);
}

/** Run a hidden-like acceptance script, from outside, against a checkout of `sha`. */
function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r4-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r4-hidden-like-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

/** r3's three gaps in this fixture's words; the reviewer names AC-5's verification node, as r3's did. */
const R001: Record<string, VerdictOverride> = {
  'AC-1': { gap: { missing: 'rollback is tested only for a formatter crash after every file was written; no test fails the changelog write after the package/version writes', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback', producer: { node_id: ARP } } },
  'AC-3': { gap: { missing: 'recovery is tested with a complete journal only; a journal cut short by a kill is never recovered from', reproduction: 'leave a truncated, unparseable journal in .changeset, run version, and assert it warns interrupted, removes the journal and versions once', producer: { node_id: CLI } } },
  'AC-5': { gap: { missing: 'no regression evidence runs status with a journal present in .changeset', reproduction: 'put .changeset/.version-journal.json beside a changeset, run status, and assert the journal is not listed and the output is the same as without it', producer: { node_id: COMPAT } }, untested: ['AC-5.2'] },
};

const ARP_FIRST: CriterionItem[] = [
  { criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST },
  { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST },
];
const CLI_FIRST: CriterionItem[] = [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST }, CLI_AC5];

function writeResult(t: ShopTicket, evidence: Record<string, unknown>[]): void {
  const result = { schema_version: 1, node_id: t.node_id, claim_id: t.claim_id, dispatch_id: t.dispatch_id, outcome: 'SUBMITTED', commands: [], evidence_paths: [], failure_fingerprint: null, decision_request: null, commit_sha: git(t.worktree, ['rev-parse', 'HEAD']), criterion_evidence: evidence };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
}

describe('CSET-203 r3, model-free: every gap of the review reworked at once, to an accepted delivery', () => {
  it('R001 GAPs on AC-1, AC-3 and AC-5 rework both producers in one settle; their workers repair them; R002 passes; C001 is delivered and the hidden-like checks pass', async () => {
    const s = await createVer({ review: {} });

    // 1. The producers, as the earlier runs' workers settled them; the compatibility node; R001.
    const a = (await dispatch(s)).ticket!;
    fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_FIRST }, s.control);
    expect(runLine(a.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'apply-release-plan');
    const c = (await dispatch(s)).ticket!;
    fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_FIRST }, s.control);
    expect(runLine(c.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli');
    const d = await dispatch(s);
    expect(d.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([[COMPAT, 'DONE']]);
    const t = d.ticket as unknown as ReviewTicket;
    expect(t).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001` });
    const reviewedHead = reviewPacket(t).repositories[0]!.head_sha;
    review(t, s.control, verdictFor(reviewPacket(t), R001));

    // 2. One settle: every gap mapped by the graph, both producers reworked, the loop goes on.
    const settled = runLine(t.settle_command, s.control);
    expect(settled.out, settled.raw).toMatchObject({ review_id: t.review_id, outcome: 'GAPS', reworked: [CLI, ARP], blocked: false, next: 'dispatch' });
    let state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([expect.objectContaining({ outcome: 'GAPS', reworks: [CLI, ARP], reworks_applied: true })]);
    expect(state.nodes[CLI].rework_brief.acceptance_criteria).toEqual(['AC-3', 'AC-5']);
    expect(state.nodes[ARP].rework_brief.acceptance_criteria).toEqual(['AC-1']);
    commitVerControl(s, 'review R001: AC-1, AC-3, AC-5');
    // The gaps are real on the reviewed head.
    expect(acceptance(s.repo, reviewedHead, VER_CHANGELOG_ACCEPTANCE).code).not.toBe(0);
    const r3Before = acceptance(s.repo, reviewedHead, VER_R3_ACCEPTANCE);
    expect(r3Before.code, r3Before.out).not.toBe(0);
    expect(r3Before.out).toMatch(/AC-3 a truncated journal is recovered from/);

    // 3. apply-release-plan: AC-1's focused RED, then the fix; AC-2 keeps its proof.
    const ra = (await dispatch(s)).ticket!;
    expect(ra.node_id).toBe(ARP);
    const ac2 = (packOf(ra)['rework']['carried_criteria'] as { criterion: string; test_id: string; output_sha256: string }[]).find((x) => x.criterion === 'AC-2')!;
    const arpRun = fulfil(ra, { tests: { [ARP_TESTS]: ARP_REVIEW_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_CHANGELOG_TEST }] }, s.control);
    (arpRun.result['criterion_evidence'] as Record<string, unknown>[]).push({ criterion: 'AC-2', test_id: ac2.test_id, gate: 'red', output_sha256: ac2.output_sha256 });
    writeFileSync(ra.result_slot, JSON.stringify(arpRun.result, null, 2));
    expect(runLine(ra.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'apply-release-plan repaired');

    // 4. The cli: AC-3's RED cycle, then AC-5's regression test alone as a compatibility-regression unit; AC-4 carried.
    const rc = (await dispatch(s)).ticket!;
    expect(rc.node_id).toBe(CLI);
    const pack = packOf(rc);
    expect(pack['rework']).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-5'], compatibility: ['AC-5'] });
    expect(rc.prompt).toContain('Mycelink-Compatibility: AC-5');
    writeFiles(rc.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red = runGate(rc, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(rc.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
    writeFiles(rc.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(rc, 'green', s.control).code).toBe(0);
    commit(rc.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill changed nothing yet; remove it');
    // In a test file of its own: AC-3's RED bound cli.test.mjs, which stays byte-identical (CSET-203 r4).
    writeFiles(rc.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    git(rc.worktree, ['add', '--', CLI_COMPAT_TESTS]);
    git(rc.worktree, ['commit', '-q', '-m', 'test(cli): AC-5 status is unaffected by a journal', '-m', 'Mycelink-Compatibility: AC-5']);
    const green = runGate(rc, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(rc, 'regression', s.control).code).toBe(0);
    const ac4 = (pack['rework']['carried_criteria'] as { criterion: string; test_id: string; output_sha256: string }[]).find((x) => x.criterion === 'AC-4')!;
    writeResult(rc, [
      { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
      { criterion: 'AC-4', test_id: ac4.test_id, gate: 'red', output_sha256: ac4.output_sha256 },
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 },
    ]);
    const cli = runLine(rc.settle_command ?? '', s.control);
    expect(cli.out, cli.raw).toMatchObject({ outcome: 'DONE' });
    expect(verState(s).nodes[CLI].tdd_history).toMatchObject({ ok: true, cycles: 1, compatibility_units: 1 });
    commitVerControl(s, 'cli repaired');

    // 5. The compatibility node again, then R002: R001's untested AC-5 clause now needs the test the gates passed.
    const d2 = await dispatch(s);
    expect(d2.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const t2 = d2.ticket as unknown as ReviewTicket;
    expect(t2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    const packet2 = reviewPacket(t2) as ReturnType<typeof reviewPacket> & { prior_gaps?: unknown };
    expect(packet2.prior_gaps).toEqual([{ review_id: t.review_id, criterion: 'AC-5', untested: ['AC-5.2'] }]);
    expect(t2.prompt).toMatch(/AC-5\.2/);
    // A PASS of AC-5 on the receipt alone, as R001 had it, is refused; the fresh generation's PASS cites the new test.
    const receiptOnly = verdictFor(packet2) as { criteria: { criterion: string; clauses: { evidence: string[] }[] }[] };
    for (const clause of receiptOnly.criteria.find((x) => x.criterion === 'AC-5')!.clauses) clause.evidence = clause.evidence.filter((e) => !e.startsWith('test:'));
    review(t2, s.control, receiptOnly);
    expect(runLine(t2.settle_command, s.control).out).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_TRACE_INCOMPLETE' });
    const t3 = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(t3).toMatchObject({ review_id: t2.review_id, resumed: true });
    const passing = verdictFor(reviewPacket(t3)) as { criteria: { criterion: string; clauses: { clause: string; evidence: string[] }[] }[] };
    const compatTest = reviewPacket(t3).criterion_evidence.find((e) => e.criterion === 'AC-5' && e.test?.name === CLI_JOURNAL_STATUS_TEST);
    expect(compatTest, JSON.stringify(reviewPacket(t3).criterion_evidence.filter((e) => e.criterion === 'AC-5'))).toBeDefined();
    expect(passing.criteria.find((x) => x.criterion === 'AC-5')!.clauses.find((x) => x.clause === 'AC-5.2')!.evidence).toContain(`test:${compatTest!.test_id}`);
    review(t3, s.control, passing);
    expect(runLine(t3.settle_command, s.control).out).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'review R002: PASS');

    // 6. Only now the candidate, delivered and accepted.
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect(built.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    state = verState(s);
    expect(state.current_candidate).toBe(`${VER_FEATURE}-C001`);
    expect(state.acceptance_review.reviews.map((x: { review_id: string; outcome: string }) => [x.review_id, x.outcome])).toEqual([[`${VER_FEATURE}-R001`, 'GAPS'], [`${VER_FEATURE}-R002`, 'PASS']]);
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
    const delivered = git(s.repo, ['rev-parse', 'main']);
    const changelog = acceptance(s.repo, delivered, VER_CHANGELOG_ACCEPTANCE);
    expect(changelog.code, changelog.out).toBe(0);
    const r3After = acceptance(s.repo, delivered, VER_R3_ACCEPTANCE);
    expect(r3After.code, r3After.out).toBe(0);
    expect(r3After.out).toContain('r3 acceptance: ok');
  }, 300_000);
});
