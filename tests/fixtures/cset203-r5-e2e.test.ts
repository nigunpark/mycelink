/**
 * CSET-203 r5 with-normal, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r5: every implementation and verification node DONE; two independent
 * reviewer sessions found the public AC-1, AC-3 and AC-5 gaps. The first
 * verdict was refused REVIEW_TRACE_INCOMPLETE (a clause traced to code
 * alone); the second, a fresh session that redid the whole review, was
 * refused REVIEW_VERDICT_INVALID because AC-1.clauses[0].trace was 653
 * characters, over 600. Two refusals blocked the feature REVIEW_INVALID:
 * no rework, no candidate. Here, through the shipped launcher's fence and
 * settle lines:
 *
 *  1. R001's first verdict cites a requirement clause by a file location
 *     alone: refused with that field's pointer and the evidence ids the
 *     packet offers for it;
 *  2. the next generation is a correction of that verdict, not a new review:
 *     it mends the one field and carries r5's own 653-character AC-1 trace;
 *     settle cuts and marks the trace, records both hashes, and settles GAPS
 *     with no further reviewer session: apply-release-plan (AC-1) and the
 *     cli (AC-3, AC-5) are reworked in one write;
 *  3. their workers repair them (AC-1's focused RED and fix; AC-3's RED
 *     cycle and AC-5's compatibility-regression unit);
 *  4. the compatibility node again; R002 PASS; C001 delivered and accepted;
 *     the hidden-like AC-1, AC-3 and AC-5 checks pass on the delivery.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  ARP,
  ARP_GAPPY_IMPL,
  ARP_RED,
  ARP_SRC,
  ARP_TESTS,
  CLI,
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_COMPAT_TEST_ID,
  CLI_FULL_WORK,
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
import { commit, fulfil, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { REVIEWER, reviewPacket, verdictFor, type ReviewTicket } from '../helpers/review-agent.js';
import { ARP_CRITERIA, CLI_CRITERIA, GAP_AC1, GAP_AC3, GAP_AC5, carriedItems, commitCompat, dispatch, repairArp, status, tddClaim, writeResult } from '../helpers/cset203-rework.js';
import { TRUNCATION_MARK, VERDICT_LIMITS } from '../../src/engine/acceptance-review.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = join(process.cwd(), 'bin', 'mycelink.mjs');
/** r5's own AC-1.1 trace from R001's second verdict: 653 characters. */
const R5_TRACE = (JSON.parse(readFileSync(join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r5', 'R001-g2.verdict.json'), 'utf8')) as { criteria: { clauses: { trace: string }[] }[] }).criteria[0]!.clauses[0]!.trace;

type V = Record<string, unknown> & { dispatch_id: string; criteria: { criterion: string; clauses: { clause: string; evidence: string[]; trace: string }[] }[] };
type Ticket = ReviewTicket & { correction: null | { number: number; of_dispatch_id: string; previous_verdict: string; problems: { code: string; pointer: string; candidates?: string[] }[] } };

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

/** The stand-in reviewer subagent: reads what it likes; its one write, the verdict, through the shipped fence that attests it. */
function review(ticket: ReviewTicket, control: string, verdict: unknown): void {
  const content = JSON.stringify(verdict, null, 2);
  const hook = spawnSync(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], {
    input: JSON.stringify({ session_id: 'host-session', agent_id: 'a5e7c0ffee000005', agent_type: REVIEWER, cwd: control, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: ticket.result_slot, content } }),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (hook.status !== 0) throw new Error(`the fence refused the verdict: ${hook.stderr}`);
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, content);
}

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r5-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r5-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

describe('CSET-203 r5, model-free: a verdict refused for its form is corrected, its over-long trace canonicalised, to an accepted delivery', () => {
  it("R001 refused for a file-only clause, corrected with r5's 653-character trace, settles GAPS; both producers repaired; R002 PASS; C001 delivered; the hidden-like checks pass", async () => {
    const s = await createVer({ review: {} });
    const a = (await dispatch(s)).ticket!;
    fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
    expect(runLine(a.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'apply-release-plan');
    const c = (await dispatch(s)).ticket!;
    fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
    expect(runLine(c.settle_command ?? '', s.control).out).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli');
    const d = await dispatch(s);
    expect((d.controller_reports ?? []).map((r) => [r.node_id, r.outcome])).toEqual([[COMPAT, 'DONE']]);
    const t = d.ticket as unknown as Ticket;
    expect(t).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001`, correction: null });
    const reviewedHead = reviewPacket(t).repositories[0]!.head_sha;

    // 1. The first verdict: the real gaps, but AC-4's last clause cited by a file location alone (r5's first refusal).
    const first = verdictFor(reviewPacket(t), { 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 }) as V;
    const ac4 = first.criteria.findIndex((x) => x.criterion === 'AC-4');
    const lastClause = first.criteria[ac4]!.clauses.length - 1;
    first.criteria[ac4]!.clauses[lastClause]!.evidence = first.criteria[ac4]!.clauses[lastClause]!.evidence.filter((e) => e.startsWith('file:'));
    review(t, s.control, first);
    const refused = runLine(t.settle_command, s.control);
    expect(refused.out, refused.raw).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_TRACE_INCOMPLETE', blocked: false, corrections: { used: 1, max: 3 } });
    expect(refused.out['problems']).toEqual([expect.objectContaining({ pointer: `/criteria/${ac4}/clauses/${lastClause}/evidence` })]);
    commitVerControl(s, 'review R001 generation 1 refused');

    // 2. The correction: the same review, the refused verdict mended in that one field, r5's 653-character AC-1 trace in it.
    const t2 = (await dispatch(s)).ticket as unknown as Ticket;
    expect(t2).toMatchObject({ review_id: t.review_id, correction: { number: 1, of_dispatch_id: t.dispatch_id, previous_verdict: t.result_slot } });
    const offered = t2.correction!.problems[0]!.candidates!.find((x) => x.startsWith('test:'))!;
    expect(offered).toMatch(/^test:[0-9a-f]{16}$/);
    const mended = JSON.parse(readFileSync(t2.correction!.previous_verdict, 'utf8')) as V;
    mended.dispatch_id = t2.dispatch_id;
    mended.criteria[ac4]!.clauses[lastClause]!.evidence.unshift(offered);
    mended.criteria[0]!.clauses[0]!.trace = R5_TRACE;
    review(t2, s.control, mended);
    const settled = runLine(t2.settle_command, s.control);
    expect(settled.out, settled.raw).toMatchObject({ review_id: t.review_id, outcome: 'GAPS', reworked: [CLI, ARP], blocked: false, next: 'dispatch' });
    expect(settled.out['normalized']).toEqual([expect.objectContaining({ pointer: '/criteria/0/clauses/0/trace', action: 'truncated', original_length: 653 })]);
    let state = verState(s);
    expect(state.acceptance_review.usage.sessions).toBe(2);
    expect(state.nodes[ARP].rework_brief.acceptance_criteria).toEqual(['AC-1']);
    expect(state.nodes[CLI].rework_brief.acceptance_criteria).toEqual(['AC-3', 'AC-5']);
    const receipt = JSON.parse(readFileSync(join(s.control, settled.out['receipt_path'] as string), 'utf8')) as Record<string, any>;
    const trace = receipt['criteria'][0]['clauses'][0]['trace'] as string;
    expect(Array.from(trace).length).toBeLessThanOrEqual(VERDICT_LIMITS.trace);
    expect(trace.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(receipt['rework_rounds']).toEqual({ used: 0, max: 2 });
    expect(receipt['canonical_verdict_sha256']).not.toBe(receipt['verdict_sha256']);
    commitVerControl(s, 'review R001: AC-1, AC-3, AC-5');
    expect(acceptance(s.repo, reviewedHead, VER_CHANGELOG_ACCEPTANCE).code).not.toBe(0);
    expect(acceptance(s.repo, reviewedHead, VER_R3_ACCEPTANCE).code).not.toBe(0);

    // 3. The reworked producers' workers: apply-release-plan, then the cli.
    await repairArp(s);
    const rc = (await dispatch(s)).ticket as ShopTicket;
    expect(rc.node_id).toBe(CLI);
    writeFiles(rc.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red = runGate(rc, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(rc.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
    writeFiles(rc.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(rc, 'green', s.control).code).toBe(0);
    commit(rc.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill changed nothing yet; remove it');
    writeFiles(rc.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(rc.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    const green = runGate(rc, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(rc, 'regression', s.control).code).toBe(0);
    writeResult(rc, [
      { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
      ...carriedItems(rc),
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 },
    ], tddClaim(rc, [{ red: [0], green: [1] }]));
    const cli = runLine(rc.settle_command ?? '', s.control);
    expect(cli.out, cli.raw).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli repaired');

    // 4. The compatibility node again, R002 PASS, the candidate, the delivery.
    const d2 = await dispatch(s);
    expect((d2.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r2 = d2.ticket as unknown as Ticket;
    expect(r2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002`, correction: null });
    review(r2, s.control, verdictFor(reviewPacket(r2)));
    expect(runLine(r2.settle_command, s.control).out).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'review R002: PASS');
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect((built.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    state = verState(s);
    expect(state.acceptance_review.reviews.map((x: { review_id: string; outcome: string }) => [x.review_id, x.outcome])).toEqual([[`${VER_FEATURE}-R001`, 'GAPS'], [`${VER_FEATURE}-R002`, 'PASS']]);
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
    expect(await status(s)).toMatchObject({ resumable: false, next_action: { kind: 'none', resumable: false } });
    const delivered = git(s.repo, ['rev-parse', 'main']);
    const changelog = acceptance(s.repo, delivered, VER_CHANGELOG_ACCEPTANCE);
    expect(changelog.code, changelog.out).toBe(0);
    const r3 = acceptance(s.repo, delivered, VER_R3_ACCEPTANCE);
    expect(r3.code, r3.out).toBe(0);
  });
});
