/**
 * CSET-203 r8 with-normal, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r8: every product and verification node DONE. R001's reviewer wrote its
 * verdict (and answered the same JSON); it was rightly refused for AC-5's
 * compatibility trace — a compatibility GAP naming no clause no test covers.
 * The correction's fresh reviewer answered the whole corrected verdict as its
 * final message and never called Write: REVIEW_VERDICT_MISSING; two such
 * generations blocked the feature REVIEW_INVALID. Here every reviewer is
 * launched as the host does (the Agent tool, through the shipped plugin's
 * PreToolUse hook), its records are Claude Code's own (the session's
 * transcript, the subagent's transcript and meta), and the host runs each
 * reviewer ticket's own ingest and settle lines through a shell:
 *
 *  1. R001's reviewer writes and answers the same verdict, with AC-5 as r8's:
 *     ingest finds both (the same verdict); settle refuses its form
 *     (REVIEW_TRACE_INCOMPLETE) — one format correction;
 *  2. the correction's prompt says a final answer is taken, exactly one JSON
 *     object; its reviewer answers the corrected verdict and writes nothing:
 *     ingested, attested with its transcript's and answer's hashes, settled
 *     GAPS with no further correction — apply-release-plan (AC-1) and the cli
 *     (AC-3, AC-5) reworked in one write;
 *  3. apply-release-plan's worker finds R001's AC-1 reproduction already
 *     holds and challenges it; the refinement's reviewer answers in one
 *     ```json fence and writes nothing: ingested, REFINE to the boundary the
 *     hidden check names, reworked; the focused RED and the fix;
 *  4. the cli's rework; the compatibility node; R002's reviewer writes its
 *     PASS and answers only that it did (the file is its verdict); the
 *     candidate; C001 delivered and accepted; the hidden-like AC-1, AC-3 and
 *     AC-5 checks pass on the delivery.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  ARP,
  ARP_CHANGELOG_TEST,
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
  type Ver,
} from '../helpers/version-fixture.js';
import { commit, fulfil, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { REVIEWER, refinementFor, reviewPacket, verdictFor, type ReviewTicket } from '../helpers/review-agent.js';
import { ARP_CRITERIA, CLI_CRITERIA, GAP_AC3, GAP_AC5, carriedItems, commitCompat, dispatch, repairArp, settle, status, tddClaim, writeResult } from '../helpers/cset203-rework.js';
import { AC1_REFINED, GAP_AC1_HOLDS, checkLine, writeChallenge } from '../helpers/cset203-challenge.js';
import { agentToolCall, claudeSession, finishAgent, launchAgent, type ClaudeSession, type LaunchedAgent } from '../helpers/claude-session.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = join(process.cwd(), 'bin', 'mycelink.mjs');
const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
type Ticket = ReviewTicket & { attempt: number; ingest_command: string; correction: null | { number: number; code: string; previous_verdict: string; transport?: { accepted: string[]; final_answer: string } }; refinement: null | Record<string, any> };

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

/** The reviewer's Write of its verdict, through the shipped fence as the subagent it is (which attests it), then the write. */
function writeAsReviewer(host: ClaudeSession, a: LaunchedAgent, ticket: ReviewTicket, content: string): void {
  const hook = spawnSync(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], {
    input: JSON.stringify({ session_id: host.sessionId, transcript_path: host.transcript, agent_id: a.agentId, agent_type: REVIEWER, cwd: host.cwd, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: `toolu_write_${a.agentId}`, tool_input: { file_path: ticket.result_slot, content } }),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (hook.status !== 0) throw new Error(`the fence refused the verdict: ${hook.stderr}`);
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, content);
  agentToolCall(host, a, 'Write', { file_path: ticket.result_slot, content }, `File created successfully at: ${ticket.result_slot}`);
}

/** The host's Agent call for a reviewer ticket, as /mycelink:run says: the ticket's prompt unchanged, through the shipped hook. */
async function launchReviewer(host: ClaudeSession, t: Ticket): Promise<LaunchedAgent> {
  const { agent } = await launchAgent(host, { subagent_type: REVIEWER, description: `acceptance review ${t.review_id}`, prompt: t.prompt }, { launcher: LAUNCHER });
  agentToolCall(host, agent, 'Read', { file_path: t.packet_path }, readFileSync(t.packet_path, 'utf8').slice(0, 2000));
  return agent;
}

/** The host's two lines once the reviewer's Agent call returned: ingest, then settle. */
function ingestThenSettle(t: Ticket, cwd: string): { ingest: ReturnType<typeof runLine>; settle: ReturnType<typeof runLine> } {
  const ingest = runLine(t.ingest_command, cwd);
  const settled = runLine(t.settle_command, cwd);
  return { ingest, settle: settled };
}

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r8-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r8-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

const receiptOf = (s: Ver, rel: string): Record<string, any> => JSON.parse(readFileSync(join(s.control, rel), 'utf8')) as Record<string, any>;

describe('CSET-203 r8, replayed model-free to the delivery it should have reached', () => {
  it("R001 refused for AC-5's trace; its correction answered without a Write is ingested and settles GAPS; a challenge refined through a fenced answer; R002 written; C001 delivered; the hidden-like checks pass", async () => {
    const s = await createVer({ review: {} });
    const host = claudeSession(s.control);
    const a = (await dispatch(s)).ticket as ShopTicket;
    fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'apply-release-plan');
    const c = (await dispatch(s)).ticket as ShopTicket;
    fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
    expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli');

    // 1. R001: written and answered the same, AC-5 a compatibility GAP naming no untested clause (r8's).
    const t1 = (await dispatch(s)).ticket as unknown as Ticket;
    expect(t1).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001`, correction: null });
    const r1 = await launchReviewer(host, t1);
    const v1 = JSON.stringify(verdictFor(reviewPacket(t1), { 'AC-1': GAP_AC1_HOLDS, 'AC-3': GAP_AC3, 'AC-5': { ...GAP_AC5, untested: [] } }), null, 2);
    writeAsReviewer(host, r1, t1, v1);
    finishAgent(host, r1, JSON.stringify(JSON.parse(v1)));
    const g1 = ingestThenSettle(t1, s.control);
    expect(g1.ingest, g1.ingest.raw).toMatchObject({ code: 0, out: { outcome: 'WRITTEN', transport: 'both', agent_id: r1.agentId } });
    expect(g1.settle.out, g1.settle.raw).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_TRACE_INCOMPLETE', blocked: false, corrections: { used: 1 } });
    expect((g1.settle.out['problems'] as { pointer: string }[]).map((p) => p.pointer)).toEqual(['/criteria/4/clauses']);
    commitVerControl(s, 'R001 refused for its form');

    // 2. The correction: answered, never written.
    const t2 = (await dispatch(s)).ticket as unknown as Ticket;
    expect(t2).toMatchObject({ review_id: t1.review_id, correction: { number: 1, code: 'REVIEW_TRACE_INCOMPLETE', transport: { accepted: ['agent-result', 'file'] } } });
    expect(t2.prompt).toContain('Format correction 1 of 3');
    expect(t2.prompt).toMatch(/return it again, whole — as your final answer/);
    expect(t2.prompt).toMatch(/exactly one JSON object and nothing else: no text before or after it/);
    const r2 = await launchReviewer(host, t2);
    const corrected = verdictFor(reviewPacket(t2), { 'AC-1': GAP_AC1_HOLDS, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
    const answer2 = JSON.stringify(corrected, null, 2);
    finishAgent(host, r2, answer2);
    const g2 = ingestThenSettle(t2, s.control);
    expect(g2.ingest, g2.ingest.raw).toMatchObject({ code: 0, out: { outcome: 'INGESTED', transport: 'agent-result', written: true, agent_id: r2.agentId, result_sha256: sha256(answer2), extraction: { ok: true, form: 'json' } } });
    expect(readFileSync(t2.result_slot, 'utf8')).toBe(answer2);
    expect(g2.settle.out, g2.settle.raw).toMatchObject({ outcome: 'GAPS', reworked: expect.arrayContaining([ARP, CLI]), transport: { kind: 'agent-result', agent_id: r2.agentId } });
    let state = verState(s);
    expect(state.acceptance_review.reviews).toHaveLength(1);
    expect(state.acceptance_review.usage.sessions).toBe(2);
    const r001 = receiptOf(s, g2.settle.out['receipt_path'] as string);
    expect(r001['transport']).toMatchObject({ kind: 'agent-result', agent_id: r2.agentId, session_id: host.sessionId, tool_use_id: r2.toolUseId, result_sha256: sha256(answer2), transcript_sha256: sha256(readFileSync(r2.transcript)), extraction: 'json' });
    commitVerControl(s, 'R001 GAPS');

    // 3. apply-release-plan's worker: R001's AC-1 reproduction already holds — a challenge.
    const w = (await dispatch(s)).ticket as ShopTicket;
    expect(w.node_id).toBe(ARP);
    const challenge = writeChallenge(w, s.control);
    expect(challenge.red.code).not.toBe(0);
    expect(checkLine(w, s.control).out).toMatchObject({ ok: true });
    expect(await settle(s, w)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R001 AC-1 challenged');
    expect(await status(s)).toMatchObject({ next_action: { kind: 'review-refine' } });

    // The refinement: one fenced JSON answer, nothing written.
    const t3 = (await dispatch(s)).ticket as unknown as Ticket;
    expect(t3).toMatchObject({ review_id: t1.review_id, refinement: { round: 1 } });
    expect(t3.prompt).toMatch(/exactly one JSON object and nothing else/);
    const r3 = await launchReviewer(host, t3);
    const refinement = refinementFor(reviewPacket(t3), { 'AC-1': { decision: 'REFINE', gap: AC1_REFINED, producer: { module: 'changesets:packages/apply-release-plan/src/index.mjs' } } });
    finishAgent(host, r3, `\`\`\`json\n${JSON.stringify(refinement, null, 2)}\n\`\`\``);
    const g3 = ingestThenSettle(t3, s.control);
    expect(g3.ingest, g3.ingest.raw).toMatchObject({ code: 0, out: { outcome: 'INGESTED', extraction: { ok: true, form: 'fenced-json' } } });
    expect(g3.settle.out, g3.settle.raw).toMatchObject({ outcome: 'GAPS', refinement: { decisions: [{ criterion: 'AC-1', decision: 'REFINE' }] }, transport: { kind: 'agent-result', agent_id: r3.agentId, extraction: 'fenced-json' } });
    commitVerControl(s, 'R001 AC-1 refined');
    await repairArp(s);
    state = verState(s);
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE' });
    expect(state.nodes[ARP].criteria.find((x: { criterion: string }) => x.criterion === 'AC-1')).toMatchObject({ gate: 'red', test: { name: ARP_CHANGELOG_TEST } });

    // 4. The cli's rework: AC-3's RED cycle, AC-5's compatibility unit.
    const cw = (await dispatch(s)).ticket as ShopTicket;
    expect(cw.node_id).toBe(CLI);
    writeFiles(cw.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red = runGate(cw, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(cw.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
    writeFiles(cw.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(cw, 'green', s.control).code).toBe(0);
    commit(cw.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill changed nothing yet; remove it');
    writeFiles(cw.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(cw.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    const green = runGate(cw, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(cw, 'regression', s.control).code).toBe(0);
    writeResult(cw, [
      { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
      ...carriedItems(cw),
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 },
    ], tddClaim(cw, [{ red: [0], green: [1] }]));
    expect(await settle(s, cw)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli repaired');

    // The compatibility node, then R002: written, its final answer only saying so — the file is its verdict.
    const d4 = (await dispatch(s)) as unknown as { controller_reports: { node_id: string; outcome: string }[]; ticket: Ticket };
    expect(d4.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const t4 = d4.ticket;
    expect(t4).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    const r4 = await launchReviewer(host, t4);
    writeAsReviewer(host, r4, t4, JSON.stringify(verdictFor(reviewPacket(t4)), null, 2));
    finishAgent(host, r4, `I wrote the verdict to ${t4.result_slot}: every criterion PASS.`);
    const g4 = ingestThenSettle(t4, s.control);
    expect(g4.ingest, g4.ingest.raw).toMatchObject({ code: 0, out: { outcome: 'WRITTEN', transport: 'file', agent_id: r4.agentId } });
    expect(g4.settle.out, g4.settle.raw).toMatchObject({ outcome: 'PASS', transport: { kind: 'file', agent_id: r4.agentId } });
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
    expect(state.acceptance_review).toMatchObject({ blocked: null, usage: { sessions: 4 } });
    expect(state.acceptance_review.reviews.map((x: { review_id: string; outcome: string }) => [x.review_id, x.outcome])).toEqual([[`${VER_FEATURE}-R001`, 'GAPS'], [`${VER_FEATURE}-R002`, 'PASS']]);
    expect(state.acceptance_review.challenges.map((x: { status: string }) => x.status)).toEqual(['refined']);
    const delivered = git(s.repo, ['rev-parse', 'main']);
    const changelog = acceptance(s.repo, delivered, VER_CHANGELOG_ACCEPTANCE);
    expect(changelog.code, changelog.out).toBe(0);
    const r3check = acceptance(s.repo, delivered, VER_R3_ACCEPTANCE);
    expect(r3check.code, r3check.out).toBe(0);
  });
});
