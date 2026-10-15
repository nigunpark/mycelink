/**
 * CSET-203 r2, model-free, with the acceptance reviewer (every platform).
 *
 * r2: both with arms were matched and trusted; every implementation and
 * verification node settled DONE under strict TDD; C001/C002 delivered;
 * the controller stayed clean — and both failed exactly one hidden check,
 * AC-1's "when a changelog cannot be written, every file is restored". The
 * apply-release-plan worker had tested rollback when a write failed at the
 * package.json boundary; its rollback restored only the changes that had
 * completed, so a changelog left half-written stayed half-written. Its
 * criterion evidence passed mechanically: a test id existed for AC-1.
 *
 * Here, end to end through the plugin's own loop:
 *
 *   1. apply-release-plan as r2's worker wrote it (rollback tested at one
 *      boundary only) and the cli settle DONE; the compatibility node runs;
 *   2. dispatch hands out the acceptance review — no candidate yet; the
 *      stand-in reviewer (read-only, its verdict written through the fence)
 *      finds AC-1's untested partial-write boundary and answers GAP with the
 *      public reproduction "inject changelog writer failure after
 *      package/version writes and assert exact rollback";
 *   3. settle reworks the producer the graph names (apply-release-plan),
 *      reopens its dependents; a hidden-like changelog failure fails on the
 *      reviewed head, as hidden acceptance did in r2;
 *   4. a fresh module-worker writes the focused RED for exactly that gap (the
 *      red gate fails it on r2's code), then the fix; AC-2 keeps the proof of
 *      the work it replaced; the cli re-proves GREEN; the compatibility node
 *      runs again;
 *   5. the review runs again and passes; only then the candidate is cut,
 *      delivered and accepted, and the hidden-like changelog failure passes
 *      on the delivered commit.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
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
  CLI_FAILURE_TEST,
  CLI_FULL_WORK,
  CLI_RECOVERY_TEST,
  COMPAT,
  VER_CANDIDATE,
  VER_CHANGELOG_ACCEPTANCE,
  VER_FEATURE,
  commitVerControl,
  createVer,
  verCli,
  verState,
} from '../helpers/version-fixture.js';
import { commit, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { fulfil } from '../helpers/shop-worker.js';
import { REVIEWER, reviewPacket, verdictFor, type ReviewTicket } from '../helpers/review-agent.js';
import { runLauncher } from '../helpers/launcher-process.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = join(process.cwd(), 'bin', 'mycelink.mjs');
const PUBLIC_REASON = 'inject changelog writer failure after package/version writes and assert exact rollback';
const cliId = (name: string): string => canonicalTestId('junit-xml', 'packages/cli/test/cli.test.mjs', name);

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

/**
 * The stand-in reviewer subagent: it reads the packet and the checkout; its one
 * write is the verdict, a Write tool call the plugin's fence (the shipped
 * launcher's hook, as Claude Code runs it) lets through and attests.
 */
function review(ticket: ReviewTicket, control: string, gaps: Parameters<typeof verdictFor>[1] = {}): Record<string, any> {
  const packet = reviewPacket(ticket);
  // What a reviewer reads to judge AC-1: the rollback test the worker wrote, and the implementation.
  const checkout = packet.repositories[0]!.checkout;
  const tests = readFileSync(join(checkout, ARP_TESTS), 'utf8');
  const impl = readFileSync(join(checkout, ARP_SRC), 'utf8');
  const verdict = verdictFor(packet, gaps, 'stand-in-reviewer');
  const content = JSON.stringify(verdict, null, 2);
  const hook = runLauncher([LAUNCHER, 'hook', 'controller-fence'], {
    input: JSON.stringify({ session_id: 'host-session', agent_id: 'a5e7c0ffee000001', agent_type: REVIEWER, cwd: control, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: ticket.result_slot, content } }),
  });
  if (hook.status !== 0) throw new Error(`the fence refused the verdict: ${hook.stderr}`);
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, content);
  return { verdict, read: { tests, impl } };
}

/** Run the hidden-like changelog failure, from outside, against a checkout of `sha`. */
function changelogAcceptance(repo: string, sha: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const script = join(makeTmpDir('cset203-hidden-like-script-'), 'acceptance.mjs');
    writeFileSync(script, VER_CHANGELOG_ACCEPTANCE);
    const r = spawnSync(process.execPath, [script, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

describe('CSET-203 r2, model-free: the acceptance reviewer finds the untested changelog boundary before any candidate', () => {
  it('GAP on AC-1, the producer reworked with a focused RED, the review passes, then the candidate is delivered and the changelog failure is rolled back', async () => {
    const s = await createVer({ review: {} });

    // 1. The producers, as r2's workers settled them.
    const a = (await dispatch(s)).ticket!;
    expect(a.node_id).toBe(ARP);
    fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST }, { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST }] }, s.control);
    expect(runLine(a.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'apply-release-plan');
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    fulfil(c, { ...CLI_FULL_WORK, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST }, CLI_AC5] }, s.control);
    expect(runLine(c.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli');

    // 2. The compatibility node runs inside dispatch, then the review — not the candidate.
    const d = await dispatch(s);
    expect(d.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([[COMPAT, 'DONE']]);
    expect(d.status).toBe('DISPATCHED');
    const t = d.ticket as unknown as ReviewTicket;
    expect(t).toMatchObject({ kind: 'acceptance-review', agent: REVIEWER, review_id: `${VER_FEATURE}-R001` });
    expect(verState(s).current_candidate).toBeNull();
    const reviewed = review(t, s.control, {
      'AC-1': {
        gap: {
          missing: 'rollback is tested only for a formatter crash after every write completed; no test makes the changelog write itself fail after the package/version writes, where a half-written changelog must be restored too',
          reproduction: PUBLIC_REASON,
          producer: { node_id: ARP, module: 'changesets:packages/apply-release-plan' },
        },
      },
    });
    // The reviewer saw why: the only failure the test injects is a formatter crash; the rollback restores the completed changes.
    expect(reviewed.read.tests).toContain("throw failure");
    expect(reviewed.read.impl).toContain('restore(files, changed)');
    const settled = runLine(t.settle_command, s.control);
    expect(settled.out, settled.raw).toMatchObject({ review_id: t.review_id, outcome: 'GAPS', reworked: [ARP] });
    commitVerControl(s, 'review R001: AC-1 gap');

    // 3. The producer is reworked with the reviewer's public reason; the gap is real on the reviewed head.
    let state = verState(s);
    expect(state.nodes[ARP]).toMatchObject({ state: 'INVALIDATED', rework_brief: { acceptance_criteria: ['AC-1'], origin: { kind: 'acceptance-review', review_id: t.review_id } } });
    expect(state.nodes[ARP].rework_brief.reason).toContain(PUBLIC_REASON);
    expect(state.nodes[CLI].state).toBe('INVALIDATED');
    expect(state.nodes[COMPAT].state).toBe('INVALIDATED');
    const reviewedHead = reviewPacket(t).repositories[0]!.head_sha;
    const before = changelogAcceptance(s.repo, reviewedHead);
    expect(before.code, before.out).not.toBe(0);
    expect(before.out).toMatch(/AC-1 every file restored/);

    // 4. A fresh module-worker: the focused RED for exactly the gap, red fails it on r2's code; then the fix.
    const r = (await dispatch(s)).ticket!;
    expect(r.node_id).toBe(ARP);
    const pack = packOf(r);
    expect(pack['rework']).toMatchObject({ acceptance_criteria: ['AC-1'], origin: { review_id: t.review_id } });
    expect(pack['rework'].reason).toContain(PUBLIC_REASON);
    const carried = (pack['rework'].carried_criteria as { criterion: string; test_id: string; output_sha256: string }[]).find((x) => x.criterion === 'AC-2')!;
    writeFiles(r.worktree, { [ARP_TESTS]: ARP_REVIEW_RED });
    const red = runGate(r, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    expect(red.tests.find((x) => x.full_name === ARP_CHANGELOG_TEST)).toMatchObject({ status: 'failed' });
    expect(verState(s).nodes[ARP].evidence.red).toMatchObject({ red_reason: 'behaviour-missing', red_category: 'assertion' });
    commit(r.worktree, [ARP_TESTS], 'test(apply-release-plan): AC-1 a changelog that fails part-way is rolled back');
    writeFiles(r.worktree, { [ARP_SRC]: ARP_FIXED_IMPL });
    expect(runGate(r, 'green', s.control).code).toBe(0);
    commit(r.worktree, [ARP_SRC], 'fix(apply-release-plan): restore every planned file, the failed write included');
    expect(runGate(r, 'regression', s.control).code).toBe(0);
    const changelogId = red.tests.find((x) => x.full_name === ARP_CHANGELOG_TEST)!.id;
    const result = {
      schema_version: 1, node_id: ARP, claim_id: r.claim_id, dispatch_id: r.dispatch_id, outcome: 'SUBMITTED', commands: [], evidence_paths: [], failure_fingerprint: null, decision_request: null,
      commit_sha: git(r.worktree, ['rev-parse', 'HEAD']),
      criterion_evidence: [
        { criterion: 'AC-1', test_id: changelogId, gate: 'red', output_sha256: red.sha256 },
        { criterion: 'AC-2', test_id: carried.test_id, gate: 'red', output_sha256: carried.output_sha256 },
      ],
    };
    mkdirSync(dirname(r.result_slot), { recursive: true });
    writeFileSync(r.result_slot, JSON.stringify(result));
    expect(runLine(r.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    expect(verState(s).nodes[ARP]).toMatchObject({ state: 'DONE', tdd_history: { cycles: 1 } });
    commitVerControl(s, 'apply-release-plan repaired');
    const c2 = (await dispatch(s)).ticket!;
    expect(c2.node_id).toBe(CLI);
    fulfil(c2, { ...CLI_FULL_WORK, criteria: [{ criterion: 'AC-3', gate: 'red', test_id: cliId(CLI_RECOVERY_TEST) }, { criterion: 'AC-4', gate: 'red', test_id: cliId(CLI_FAILURE_TEST) }, CLI_AC5] }, s.control);
    expect(runLine(c2.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli re-verified');

    // 5. The review again: it passes; only then the candidate.
    const d2 = await dispatch(s);
    expect(d2.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const t2 = d2.ticket as unknown as ReviewTicket;
    expect(t2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    expect(reviewPacket(t2).criterion_evidence.filter((e) => e.criterion === 'AC-1').map((e) => e.test?.name)).toEqual([ARP_CHANGELOG_TEST]);
    review(t2, s.control);
    expect(runLine(t2.settle_command, s.control).out).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'review R002: PASS');
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect(built.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    state = verState(s);
    expect(state.current_candidate).toBe(`${VER_FEATURE}-C001`);
    expect(state.acceptance_review.reviews.map((x: { review_id: string; overall: string }) => [x.review_id, x.overall])).toEqual([[`${VER_FEATURE}-R001`, 'GAPS'], [`${VER_FEATURE}-R002`, 'PASS']]);
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });

    // The hidden-like changelog failure now rolls back on the delivered commit.
    const delivered = git(s.repo, ['rev-parse', 'main']);
    const after = changelogAcceptance(s.repo, delivered);
    expect(after.code, after.out).toBe(0);
    expect(after.out).toContain('changelog acceptance: ok');
  }, 300_000);
});
