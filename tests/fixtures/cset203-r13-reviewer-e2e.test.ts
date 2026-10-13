/**
 * CSET-203 r13 with-normal, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r13: R001 settled GAPS — apply-release-plan reworked for AC-1, the cli for
 * AC-3 and AC-5. apply-release-plan's rework worker wrote AC-1's exact
 * reproduction as focused tests; they passed on the unchanged head, and it
 * challenged the gap. The refinement went to a background reviewer. The host
 * slept 240 s, then ran the ticket's ingest and settle lines together:
 * ingest said the agent had not completed — Claude Code had enqueued its
 * completion while the host slept (a queue operation, then a queued command
 * absorbed mid-turn, never a user message) — and settle took that for "no
 * verdict" (REVIEW_VERDICT_MISSING) and spent the generation. The second
 * refinement reviewer went the same way: REVIEW_INVALID, the challenge
 * pending, the cli and compatibility nodes INVALIDATED, no candidate.
 *
 * Here, through the shipped launcher's hooks and the tickets' own lines:
 *
 *  1. R001 as r13's (AC-1 on apply-release-plan, AC-3 and AC-5 on the cli);
 *     the apply-release-plan worker challenges AC-1;
 *  2. the refinement's reviewer is launched in the background and runs for
 *     minutes; every poll r13's host made — ingest and settle together after
 *     a sleep, the await line, `feature status`, `dispatch`, `dispatch
 *     --resume` — answers that it runs, and leaves the same generation, no
 *     refusal, no usage, the challenge pending;
 *  3. its completion is enqueued mid-turn, as r13's was: the await line says
 *     COMPLETED, ingest takes its WITHDRAW, settle settles the refinement —
 *     the challenge resolved, the cli's standing rework next;
 *  4. the cli's rework, the compatibility node, R002 PASS (its reviewer's
 *     completion delivered as a turn of its own), C001 delivered and
 *     accepted; the hidden-like AC-3 and AC-5 check passes on the delivery.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { ARP, CLI, CLI_COMPAT_FILE, CLI_COMPAT_TESTS, CLI_COMPAT_TEST_ID, CLI_SRC, CLI_TESTS, CLI_TRUNCATED_IMPL, CLI_TRUNCATED_RED, CLI_TRUNCATED_TEST, COMPAT, VER_CANDIDATE, VER_FEATURE, VER_R3_ACCEPTANCE, commitVerControl, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { commit, runGate, writeFiles } from '../helpers/shop-worker.js';
import { REVIEWER, refinementFor, reviewPacket, verdictFor, type ReviewTicket } from '../helpers/review-agent.js';
import { carriedItems, commitCompat, dispatch, settle, status, tddClaim, writeResult } from '../helpers/cset203-rework.js';
import { checkLine, r6Reviewed, writeChallenge } from '../helpers/cset203-challenge.js';
import { agentToolCall, claudeSession, finishAgent, launchAgent, type ClaudeSession, type LaunchedAgent } from '../helpers/claude-session.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = join(process.cwd(), 'bin', 'mycelink.mjs');
type Ticket = ReviewTicket & { attempt: number; ingest_command: string; await_command: string; settle_command: string; refinement: null | Record<string, any> };

/** The host runs a ticket's line exactly as rendered, as its Bash tool would. */
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

/** The ticket's await line, waiting at most `seconds` (the ticket's own waits 90 s a run). */
const awaitLine = (t: Ticket, seconds: number): string => t.await_command.replace(/--wait-seconds \d+/, `--wait-seconds ${seconds}`);

/** The host's Agent call for a reviewer ticket, as /mycelink:run says: the ticket's prompt unchanged, in the background, through the shipped hook. */
async function launchReviewer(host: ClaudeSession, t: Ticket): Promise<LaunchedAgent> {
  const { agent } = await launchAgent(host, { subagent_type: REVIEWER, description: `acceptance review ${t.review_id}`, prompt: t.prompt }, { launcher: LAUNCHER });
  agentToolCall(host, agent, 'Read', { file_path: t.packet_path }, readFileSync(t.packet_path, 'utf8').slice(0, 2000));
  return agent;
}

const earlier = (iso: string, ms: number): string => new Date(Date.parse(iso) - ms).toISOString();
/** The generation and its reviewer's launch as if made `ms` earlier: minutes of a reviewer's run, without waiting them out. */
function age(s: Ver, t: Ticket, a: LaunchedAgent, ms: number): void {
  const file = join(t.result_slot, '..', `launch-${a.toolUseId}.json`);
  const r = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  writeFileSync(file, JSON.stringify({ ...r, at: earlier(r['at'] as string, ms) }, null, 2) + '\n');
  const lines = readFileSync(a.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  writeFileSync(a.transcript, lines.map((e) => JSON.stringify({ ...e, timestamp: earlier(e['timestamp'] as string, ms) })).join('\n') + '\n');
  mutateState(s.featureDir, (st) => {
    const open = st.acceptance_review?.open;
    if (open && open.dispatch_id === t.dispatch_id) {
      open.issued_at = earlier(open.issued_at, ms);
      open.expires_at = earlier(open.expires_at, ms);
    }
    for (const l of st.orchestration?.leases ?? []) if (l.dispatch_id === t.dispatch_id) l.issued_at = earlier(l.issued_at, ms);
    return st;
  });
}

const events = (s: Ver, type: string): Record<string, any>[] =>
  readFileSync(join(s.featureDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>)
    .filter((e) => e['type'] === type);

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r13-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r13-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

describe('CSET-203 r13, replayed model-free to the delivery it should have reached', () => {
  it("the refinement's reviewer runs for minutes and every poll r13's host made leaves its generation as it was; its completion, enqueued mid-turn, is ingested; the challenge resolves; the cli's rework, R002 PASS, C001 delivered", async () => {
    // 1. R001 as r13's, and the apply-release-plan worker's challenge of AC-1.
    const s = await r6Reviewed();
    const host = claudeSession(s.control);
    const w = (await dispatch(s)).ticket!;
    expect(w.node_id).toBe(ARP);
    const challenge = writeChallenge(w, s.control);
    expect(challenge.red.code).not.toBe(0);
    expect(checkLine(w, s.control).out).toMatchObject({ ok: true });
    expect(await settle(s, w)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R001 AC-1 challenged');
    expect(await status(s)).toMatchObject({ next_action: { kind: 'review-refine' } });

    // 2. The refinement, launched in the background; it runs for minutes.
    const r = (await dispatch(s)).ticket as unknown as Ticket;
    expect(r).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001`, refinement: { round: 1 } });
    expect(r.await_command).toContain('review await');
    const a = await launchReviewer(host, r);
    const before = verState(s).acceptance_review;
    let ran = 0;
    // r13's host: a sleep of 240 s, then ingest and settle together; another sleep of 120 s, the same; between them, status and dispatch.
    for (const at of [60_000, 190_000, 240_000, 360_000, 500_000]) {
      age(s, r, a, at - ran);
      ran = at;
      const ingest = runLine(r.ingest_command, s.control);
      expect(ingest.out, `ingest after ${at / 1000} s: ${ingest.raw}`).toMatchObject({ outcome: 'REVIEWER_RUNNING', written: false, lifecycle: 'RUNNING' });
      const settled = runLine(r.settle_command, s.control);
      expect(settled.out, `settle after ${at / 1000} s: ${settled.raw}`).toMatchObject({ outcome: 'REVIEWER_RUNNING', code: null, next: 'wait', lifecycle: 'RUNNING' });
      const waited = runLine(awaitLine(r, 1), s.control);
      expect(waited.out, `await after ${at / 1000} s`).toMatchObject({ state: 'RUNNING', next: 'await', dispatch_id: r.dispatch_id });
      expect(waited.out['reviewer']['elapsed_ms']).toBeGreaterThanOrEqual(at);
      expect((await status(s))['next_action']).toMatchObject({ kind: 'await-reviewer', reviewer: { dispatch_id: r.dispatch_id, refinement: true, state: 'RUNNING' } });
      const d = await dispatch(s);
      expect(d.status).toBe('WAITING');
      expect(JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', r.review_id, '--json'])).out)).toMatchObject({ status: 'WAITING' });
      const now = verState(s).acceptance_review;
      expect(now.open).toMatchObject({ dispatch_id: r.dispatch_id, attempt: 1, refused: [] });
      expect(now.usage).toEqual(before.usage);
      expect(now.challenges.map((c: { status: string }) => c.status)).toEqual(['pending']);
    }
    expect(events(s, 'review.refused')).toEqual([]);
    expect(events(s, 'review.reissued')).toEqual([]);

    // 3. Its completion is enqueued while the host sleeps, then absorbed: the refinement WITHDRAWs AC-1.
    const refinement = refinementFor(reviewPacket(r), { 'AC-1': { decision: 'WITHDRAW' } });
    finishAgent(host, a, JSON.stringify(refinement, null, 2), { notify: 'queued' });
    expect(runLine(awaitLine(r, 1), s.control).out).toMatchObject({ state: 'COMPLETED', next: 'ingest' });
    const ingested = runLine(r.ingest_command, s.control);
    expect(ingested.out, ingested.raw).toMatchObject({ outcome: 'INGESTED', transport: 'agent-result', agent_id: a.agentId });
    const refined = runLine(r.settle_command, s.control);
    expect(refined.out, refined.raw).toMatchObject({ refinement: { round: 1, decisions: [{ criterion: 'AC-1', decision: 'WITHDRAW' }] }, transport: { kind: 'agent-result', agent_id: a.agentId } });
    expect(['GAPS', 'PASS', 'WITHDRAWN']).toContain(refined.out['outcome']);
    commitVerControl(s, 'R001 AC-1 withdrawn');
    let state = verState(s);
    expect(state.acceptance_review.challenges.map((c: { status: string }) => c.status)).not.toContain('pending');
    expect(state.acceptance_review.usage.sessions).toBe(before.usage.sessions + 1);
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE' });

    // 4. The cli's standing rework: AC-3's RED cycle, AC-5's compatibility unit.
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    writeFiles(c.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red = runGate(c, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(c.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
    writeFiles(c.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(c, 'green', s.control).code).toBe(0);
    commit(c.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill changed nothing yet; remove it');
    writeFiles(c.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(c.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    const green = runGate(c, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(c, 'regression', s.control).code).toBe(0);
    writeResult(c, [
      { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
      ...carriedItems(c),
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 },
    ], tddClaim(c, [{ red: [0], green: [1] }]));
    expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli repaired');

    // The compatibility node, then R002: its reviewer answers its PASS, delivered as a turn of its own.
    const d2 = (await dispatch(s)) as unknown as { controller_reports: { node_id: string; outcome: string }[]; ticket: Ticket };
    expect(d2.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const t2 = d2.ticket;
    expect(t2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    const a2 = await launchReviewer(host, t2);
    expect(runLine(awaitLine(t2, 0), s.control).out).toMatchObject({ state: 'RUNNING' });
    finishAgent(host, a2, JSON.stringify(verdictFor(reviewPacket(t2))));
    expect(runLine(awaitLine(t2, 1), s.control).out).toMatchObject({ state: 'COMPLETED' });
    expect(runLine(t2.ingest_command, s.control).out).toMatchObject({ outcome: 'INGESTED' });
    expect(runLine(t2.settle_command, s.control).out).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'review R002: PASS');

    // The candidate and the delivery.
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect((built.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });

    state = verState(s);
    expect(state.acceptance_review).toMatchObject({ blocked: null });
    expect(state.acceptance_review.usage.sessions).toBe(before.usage.sessions + 2);
    expect(state.acceptance_review.reviews.map((x: { review_id: string; outcome: string }) => [x.review_id, x.outcome]).at(-1)).toEqual([`${VER_FEATURE}-R002`, 'PASS']);
    expect(events(s, 'review.refused')).toEqual([]);
    const delivered = git(s.repo, ['rev-parse', 'main']);
    const r3 = acceptance(s.repo, delivered, VER_R3_ACCEPTANCE);
    expect(r3.code, r3.out).toBe(0);
  }, 300_000);
});
