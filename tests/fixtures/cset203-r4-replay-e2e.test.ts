/**
 * CSET-203 r4 with-normal, model-free, exactly as it went — and on to the
 * delivery it should have reached (every platform).
 *
 * r4: the task controller's own edit of the approved criteria was fenced;
 * the corrective controller ran the real reviewer, R001 found AC-1, AC-3 and
 * AC-5 and both producers were reworked in one settle; apply-release-plan
 * settled DONE; the cli's rework worker appended AC-5's regression test,
 * after the code, to the test file AC-3's RED bound (CHANGED_RED_BLOBS); the
 * controller exited 0 with the cli READY and the compatibility node
 * INVALIDATED. Here:
 *
 *  1. the controller's write of ACCEPTANCE.json is refused by the fence;
 *  2. the producers settle as r2/r3's workers left them; the compatibility
 *     node runs; R001 finds AC-1, AC-3, AC-5; one settle reworks both;
 *  3. apply-release-plan: AC-1's RED and fix, AC-2 carried and re-run;
 *  4. the cli's first rework worker's history is refused (CHANGED_RED_BLOBS),
 *     its attempt charged, nothing of it kept as evidence;
 *  5. the controller exits there: `feature status` says the feature is
 *     resumable and names the READY cli, its generation, its attempts and the
 *     refusal; a fresh controller recovers the key and dispatches;
 *  6. the corrected worker: AC-3's RED cycle, AC-5's test alone in a new test
 *     file after the code; AC-4's carried proof re-run at the new head;
 *  7. the compatibility node again; R002 PASS on the new test; C001
 *     delivered and accepted; the hidden-like AC-1, AC-3 and AC-5 checks pass;
 *     no evidence of a replaced generation or the refused attempt is active.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  ARP,
  CLI,
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_COMPAT_TEST_BODY,
  CLI_COMPAT_TEST_ID,
  CLI_JOURNAL_STATUS_TEST,
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
  verCli,
  verState,
} from '../helpers/version-fixture.js';
import { commit, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { REVIEWER, reviewPacket, verdictFor, type ReviewTicket } from '../helpers/review-agent.js';
import { GAP_AC1, GAP_AC3, GAP_AC5, carriedItems, commitCompat, dispatch, repairArp, reviewed, status, tddClaim, writeResult } from '../helpers/cset203-rework.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = join(process.cwd(), 'bin', 'mycelink.mjs');

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

/** One tool call through the shipped launcher's fence, as `who` (the controller: no agent): null when allowed, else the reason. */
function fence(cwd: string, tool: string, input: Record<string, unknown>, who: Record<string, string> = {}): string | null {
  const r = spawnSync(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], { input: JSON.stringify({ session_id: 'host-session', cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...who }), encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? null : r.stderr.trim();
}

/** The stand-in reviewer subagent: its one write, the verdict, through the fence that attests it. */
function review(ticket: ReviewTicket, control: string, verdict: Record<string, unknown>): void {
  const content = JSON.stringify(verdict, null, 2);
  expect(fence(control, 'Write', { file_path: ticket.result_slot, content }, { agent_id: 'a5e7c0ffee000004', agent_type: REVIEWER })).toBeNull();
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, content);
}

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r4-replay-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r4-replay-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

describe('CSET-203 r4, replayed model-free to the delivery it should have reached', () => {
  it('fence, R001 GAPs, both reworks, the refused cli history, an incomplete exit the next controller resumes, the corrected worker, R002 PASS, C001 delivered and the hidden-like checks pass', async () => {
    // 2. (after 1, below) the producers, the compatibility node and R001, reworking both producers in one settle.
    const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
    const reviewedHead = git(s.repo, ['rev-parse', `refs/heads/feature/${VER_FEATURE}`]);

    // 1. r4 session 1: the controller writes the approved criteria itself — the fence refuses, by file tool and by shell.
    const acceptanceFile = join(s.featureDir, 'ACCEPTANCE.json');
    expect(fence(s.control, 'Write', { file_path: acceptanceFile, content: '{}' })).toMatch(/^Blocked: the Mycelink controller never writes a feature's evidence, state or approved criteria/);
    expect(fence(s.control, 'Bash', { command: `cd "${s.control.replace(/\\/g, '/')}" && cat > features/${VER_FEATURE}/ACCEPTANCE.json <<'EOF'\n{}\nEOF` })).toMatch(/^Blocked/);

    let state = verState(s);
    expect(state.nodes[CLI].rework_brief.acceptance_criteria).toEqual(['AC-3', 'AC-5']);
    expect(state.nodes[ARP].rework_brief.acceptance_criteria).toEqual(['AC-1']);
    expect(acceptance(s.repo, reviewedHead, VER_CHANGELOG_ACCEPTANCE).code).not.toBe(0);
    expect(acceptance(s.repo, reviewedHead, VER_R3_ACCEPTANCE).code).not.toBe(0);

    // 3. apply-release-plan repaired; AC-2 carried and re-run at its new head.
    await repairArp(s);
    expect(verState(s).nodes[ARP].criteria.find((c: { criterion: string }) => c.criterion === 'AC-2')).toMatchObject({ carried: true, carried_from: { generation: 0 } });

    // 4. The cli's first rework worker, as r4's: AC-3's cycle, then AC-5 appended to the RED-bound file after the code.
    const first = (await dispatch(s)).ticket!;
    expect(first.node_id).toBe(CLI);
    writeFiles(first.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red1 = runGate(first, 'red', s.control);
    expect(red1.code, red1.out).toBe(0);
    commit(first.worktree, [CLI_TESTS], 'test(cli): AC-3');
    writeFiles(first.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(first, 'green', s.control).code).toBe(0);
    commit(first.worktree, [CLI_SRC], 'fix(cli): AC-3');
    writeFiles(first.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED + CLI_COMPAT_TEST_BODY });
    commitCompat(first.worktree, [CLI_TESTS], 'AC-5');
    const green1 = runGate(first, 'green', s.control);
    expect(runGate(first, 'regression', s.control).code).toBe(0);
    writeResult(first, [
      { criterion: 'AC-3', test_id: red1.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red1.sha256 },
      ...carriedItems(first),
      { criterion: 'AC-5', test_id: green1.tests.find((x) => x.full_name === CLI_JOURNAL_STATUS_TEST)!.id, gate: 'green', output_sha256: green1.sha256 },
    ], tddClaim(first, [{ red: [0], green: [1] }]));
    const refused = runLine(first.settle_command ?? '', s.control);
    expect(refused.out, refused.raw).toMatchObject({ outcome: 'TDD_HISTORY_INVALID' });
    expect(refused.out['detail']).toMatch(/CHANGED_RED_BLOBS/);
    commitVerControl(s, 'cli: first rework attempt refused');
    const refusedOutputs = new Set([red1.sha256, green1.sha256]);

    // 5. The controller exits here, as r4's did. Nothing about the feature is final: it says so, and what comes next.
    state = verState(s);
    expect(state.nodes[CLI].state).toBe('READY');
    expect(state.nodes[COMPAT].state).toBe('INVALIDATED');
    const st = await status(s);
    expect(st).toMatchObject({ resumable: true, next_action: { kind: 'dispatch', resumable: true } });
    expect(st['next_action']['nodes'].find((n: { node_id: string }) => n.node_id === CLI)).toMatchObject({ state: 'READY', rework_generation: 1, attempts_used: 1, max_attempts: 2, last_refusal: { code: 'TDD_HISTORY_INVALID:CHANGED_RED_BLOBS' } });
    // The refused worker's capability settles nothing again.
    const again = runLine(first.settle_command ?? '', s.control);
    expect(again.out['outcome'] ?? 'refused').not.toBe('DONE');

    // A fresh controller session: reconcile, then /mycelink:run's loop — dispatch hands the cli to a fresh worker. (This
    // fixture's key was opened in-process, never by a verifiable host session, so it is taken over as an operator would;
    // `controller open --recover` from a real host process is settle-resume's and the benchmark continuation's.)
    expect((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).code).toBe(0);
    const second = (await dispatch(s)).ticket!;
    expect(second.node_id).toBe(CLI);
    const pack = packOf(second);
    expect(pack['tdd']['rejection']).toMatchObject({ code: 'CHANGED_RED_BLOBS' });
    expect(pack['budget']).toMatchObject({ attempt: 2, max_attempts: 2 });
    expect(pack['latest_evidence']).toEqual([]);
    expect(second.prompt).toMatch(/new test file/);

    // 6. The corrected worker: AC-3's cycle, AC-5 alone in a new test file after the code, green again, regression.
    writeFiles(second.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red2 = runGate(second, 'red', s.control);
    expect(red2.code, red2.out).toBe(0);
    commit(second.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
    writeFiles(second.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(second, 'green', s.control).code).toBe(0);
    commit(second.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill changed nothing yet; remove it');
    writeFiles(second.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(second.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    const green2 = runGate(second, 'green', s.control);
    expect(green2.code, green2.out).toBe(0);
    expect(runGate(second, 'regression', s.control).code).toBe(0);
    writeResult(second, [
      { criterion: 'AC-3', test_id: red2.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red2.sha256 },
      ...carriedItems(second),
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green2.sha256 },
    ], tddClaim(second, [{ red: [0], green: [1] }]));
    const settled = runLine(second.settle_command ?? '', s.control);
    expect(settled.out, settled.raw).toMatchObject({ outcome: 'DONE' });
    state = verState(s);
    const cli = state.nodes[CLI];
    expect(cli.tdd_history).toMatchObject({ ok: true, cycles: 1, compatibility_units: 1 });
    expect(cli.criteria.find((c: { criterion: string }) => c.criterion === 'AC-4')).toMatchObject({ carried: true, carried_from: { generation: 0, gate: 'red' } });
    // Old evidence claims never reused: no accepted criterion cites the replaced generation's or the refused attempt's outputs.
    const replaced = new Set(cli.rework_history.flatMap((h: { evidence: Record<string, { output_sha256: string }> }) => Object.values(h.evidence).map((e) => e.output_sha256)));
    for (const c of cli.criteria as { criterion: string; output_sha256: string }[]) {
      expect(replaced.has(c.output_sha256), `${c.criterion} cites a replaced output`).toBe(false);
      expect(refusedOutputs.has(c.output_sha256), `${c.criterion} cites the refused attempt`).toBe(false);
    }
    expect(cli.tdd_red_bindings.every((b: { evidence_sha256: string }) => b.evidence_sha256 === red2.sha256)).toBe(true);
    commitVerControl(s, 'cli repaired');

    // 7. The compatibility node again, R002 on the new test, the candidate, the delivery.
    const d2 = (await dispatch(s)) as unknown as { controller_reports: { node_id: string; outcome: string }[]; ticket: ReviewTicket };
    expect(d2.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const t2 = d2.ticket;
    expect(t2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    const compatTest = reviewPacket(t2).criterion_evidence.find((e) => e.criterion === 'AC-5' && e.test_id === CLI_COMPAT_TEST_ID);
    expect(compatTest, JSON.stringify(reviewPacket(t2).criterion_evidence.filter((e) => e.criterion === 'AC-5'))).toBeDefined();
    review(t2, s.control, verdictFor(reviewPacket(t2)));
    expect(runLine(t2.settle_command, s.control).out).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'review R002: PASS');
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect((built.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
    expect(await status(s)).toMatchObject({ resumable: false, next_action: { kind: 'none', resumable: false } });
    const delivered = git(s.repo, ['rev-parse', 'main']);
    const changelog = acceptance(s.repo, delivered, VER_CHANGELOG_ACCEPTANCE);
    expect(changelog.code, changelog.out).toBe(0);
    const r3 = acceptance(s.repo, delivered, VER_R3_ACCEPTANCE);
    expect(r3.code, r3.out).toBe(0);
  }, 300_000);
});
