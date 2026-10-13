/**
 * A reviewer Agent's lifecycle, synchronised with the review it answers
 * (engine/review-transport.ts reviewerLifecycle; Orchestrator.awaitReview).
 *
 * CSET-203 r13: the refinement reviewer of R001 was launched in the
 * background; the host slept, then ran the ticket's ingest and settle lines
 * together. Ingest said the agent had not completed (Claude Code had in fact
 * enqueued its completion mid-turn, a record ingest did not know), settle
 * took that for "no verdict" (REVIEW_VERDICT_MISSING) and spent the
 * generation, and a second reviewer of the same refinement went the same
 * way: REVIEW_INVALID, the challenge pending, no candidate.
 *
 * Here, on the version fixture with every product and verification node
 * DONE: a reviewer still running is awaited — settle, ingest, dispatch,
 * `dispatch --resume` and `feature status` all say so (`REVIEWER_RUNNING`,
 * `await-reviewer`) and change nothing, however long it runs and however often
 * they are asked; its generation is never re-issued, corrected or settled
 * while it runs, and the fence refuses a second reviewer for it. A reviewer
 * past its wall-clock, or whose host or task ended before it completed, is
 * interrupted: its generation re-issued with nothing spent, its late answer
 * stale. Only a reviewer that completed without an answer is
 * REVIEW_VERDICT_MISSING.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { ARP_GAPPY_IMPL, ARP_JOURNAL_TEST, ARP_RED, ARP_ROLLBACK_TEST, ARP_SRC, ARP_TESTS, CLI_AC5, CLI_FAILURE_TEST, CLI_FULL_WORK, CLI_RECOVERY_TEST, VER_FEATURE, commitVerControl, createVer, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { fulfil, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';
import { REVIEWER, reviewPacket, verdictFor, type ReviewTicket } from '../helpers/review-agent.js';
import { agentEntry, agentToolCall, claudeSession, finishAgent, hostToolHook, launchAgent, notifyQueued, type ClaudeSession, type LaunchedAgent } from '../helpers/claude-session.js';
import { processIdentity } from '../../src/util/process-identity.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const TIMEOUT_MS = 20 * 60_000;
type Ticket = ReviewTicket & { attempt: number; ingest_command: string; await_command: string; correction: null | Record<string, any>; refinement: null | Record<string, any> };

async function json(s: Ver, argv: string[]): Promise<{ code: number; out: Record<string, any>; raw: string }> {
  const r = await verCli(s, argv);
  let out: Record<string, any> = {};
  try {
    out = JSON.parse(r.out) as Record<string, any>;
  } catch {
    out = {};
  }
  return { code: r.code, out, raw: `${r.out}${r.err}` };
}
const dispatch = async (s: Ver, extra: string[] = []) => (await json(s, ['dispatch', VER_FEATURE, ...extra, '--json'])).out;
const settle = async (s: Ver, t: Pick<ReviewTicket, 'review_id' | 'capability'>) => (await json(s, ['review', 'settle', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json'])).out;
const ingest = async (s: Ver, t: Pick<ReviewTicket, 'review_id' | 'capability'>) => (await json(s, ['review', 'ingest', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json'])).out;
const awaitReview = async (s: Ver, t: Pick<ReviewTicket, 'review_id' | 'capability'> | null, waitSeconds = 0) =>
  (await json(s, ['review', 'await', VER_FEATURE, ...(t !== null ? ['--review', t.review_id, '--capability', t.capability] : []), '--wait-seconds', String(waitSeconds), '--json'])).out;
const status = async (s: Ver) => (await json(s, ['feature', 'status', VER_FEATURE, '--json'])).out;
const events = (s: Ver, type: string): Record<string, any>[] =>
  readFileSync(join(s.featureDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>)
    .filter((e) => e['type'] === type);
const leaseOf = (s: Ver, dispatchId: string): Record<string, any> | undefined => (verState(s).orchestration.leases as Record<string, any>[]).find((l) => l['dispatch_id'] === dispatchId);
const slotDir = (t: ReviewTicket): string => join(t.result_slot, '..');
const launchFile = (t: ReviewTicket, a: LaunchedAgent): string => join(slotDir(t), `launch-${a.toolUseId}.json`);

const earlier = (iso: string, ms: number): string => new Date(Date.parse(iso) - ms).toISOString();

/**
 * The generation and its reviewer's launch as if both were made `ms`
 * earlier: what minutes of a reviewer's run look like to the controller
 * (the generation's issue and expiry, its lease, the launch the fence
 * recorded, and the subagent's first entry, all moved back together).
 */
function backdate(t: ReviewTicket, a: LaunchedAgent, ms: number, s?: Ver): void {
  if (ms <= 0) return;
  const file = launchFile(t, a);
  const r = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  r['at'] = earlier(r['at'] as string, ms);
  writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  const lines = readFileSync(a.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  writeFileSync(a.transcript, lines.map((e) => JSON.stringify({ ...e, timestamp: earlier(e['timestamp'] as string, ms) })).join('\n') + '\n');
  const world = s ?? current;
  if (world === null) throw new Error('backdate: no fixture');
  mutateState(world.featureDir, (st) => {
    const open = st.acceptance_review?.open;
    if (open && open.dispatch_id === t.dispatch_id) {
      open.issued_at = earlier(open.issued_at, ms);
      open.expires_at = earlier(open.expires_at, ms);
    }
    for (const l of st.orchestration?.leases ?? []) if (l.dispatch_id === t.dispatch_id) l.issued_at = earlier(l.issued_at, ms);
    return st;
  });
}
let current: Ver | null = null;

/** A holder whose process is gone: what a launch record says of a host session that ended. */
function deadHolder(): Record<string, unknown> {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  return { pid: Number(r.stdout), start: 'ended', boot: null, host: hostname(), platform: process.platform };
}
function setHolder(t: ReviewTicket, a: LaunchedAgent, holder: Record<string, unknown>): void {
  const file = launchFile(t, a);
  writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), holder }, null, 2) + '\n');
}

const ARP_CRITERIA: CriterionItem[] = [
  { criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST },
  { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST },
];
const CLI_CRITERIA: CriterionItem[] = [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST }, CLI_AC5];

/** Both producers DONE, the compatibility node run: the review ticket, and a host session. */
async function untilReview(review: Record<string, unknown> = {}): Promise<{ s: Ver; t: Ticket; host: ClaudeSession }> {
  const s = await createVer({ review });
  const a = (await dispatch(s))['ticket'] as ShopTicket;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect((await json(s, ['settle', VER_FEATURE, a.node_id, '--capability', a.capability, '--json'])).out).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s))['ticket'] as ShopTicket;
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect((await json(s, ['settle', VER_FEATURE, c.node_id, '--capability', c.capability, '--json'])).out).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  const t = (await dispatch(s))['ticket'] as Ticket;
  expect(t).toMatchObject({ kind: 'acceptance-review', correction: null });
  commitVerControl(s, 'review out');
  current = s;
  return { s, t, host: claudeSession(s.control) };
}

/** The host launches the reviewer with the ticket's prompt, as /mycelink:run says: the Agent tool, in the background, through the plugin's hook. */
async function launchReviewer(host: ClaudeSession, t: ReviewTicket): Promise<LaunchedAgent> {
  const { agent, hook } = await launchAgent(host, { subagent_type: REVIEWER, description: `acceptance review ${t.review_id}`, prompt: t.prompt });
  expect(hook?.code, hook?.err).toBe(0);
  agentToolCall(host, agent, 'Read', { file_path: t.packet_path }, readFileSync(t.packet_path, 'utf8').slice(0, 400));
  return agent;
}

/** What must not move while a reviewer runs: the open generation, its refusals, the review's usage, its events. */
function frozen(s: Ver): Record<string, unknown> {
  const r = verState(s).acceptance_review;
  return { open: r.open.dispatch_id, attempt: r.open.attempt, refused: r.open.refused, usage: r.usage, reviews: r.reviews.length, blocked: r.blocked, refusedEvents: events(s, 'review.refused').length, reissued: events(s, 'review.reissued').length };
}

describe('CSET-203 r13: a reviewer still running is awaited, never settled, corrected or re-issued', () => {
  it('settle, ingest, await, dispatch, dispatch --resume and feature status all say it runs, for minutes, and change nothing; once Claude Code enqueues its completion mid-turn, it is ingested and settled once', async () => {
    const { s, t, host } = await untilReview();
    expect(t.await_command).toContain(`review await ${VER_FEATURE} --review ${t.review_id}`);
    expect(t.await_command).toContain(`--capability ${t.capability}`);
    const a = await launchReviewer(host, t);
    const before = frozen(s);

    let ran = 0;
    for (const elapsed of [0, 60_000, 4 * 60_000, 6 * 60_000]) {
      backdate(t, a, elapsed - ran);
      ran = elapsed;
      // r13's host ran ingest and settle together after its sleep: both now say the reviewer runs.
      const ing = await ingest(s, t);
      expect(ing, `ingest at ${elapsed}`).toMatchObject({ outcome: 'REVIEWER_RUNNING', written: false, next: 'wait', lifecycle: 'RUNNING' });
      const set = await settle(s, t);
      expect(set, `settle at ${elapsed}`).toMatchObject({ outcome: 'REVIEWER_RUNNING', code: null, blocked: false, next: 'wait', lifecycle: 'RUNNING' });
      const w = await awaitReview(s, t);
      expect(w, `await at ${elapsed}`).toMatchObject({ review_id: t.review_id, dispatch_id: t.dispatch_id, state: 'RUNNING', next: 'await', reviewer: { agent_id_sha256: sha256(a.agentId), timeout_ms: TIMEOUT_MS } });
      expect(w['reviewer']['elapsed_ms']).toBeGreaterThanOrEqual(elapsed);
      expect(w['reviewer']['remaining_ms']).toBe(TIMEOUT_MS - w['reviewer']['elapsed_ms']);
      const d = await dispatch(s);
      expect(d, `dispatch at ${elapsed}`).toMatchObject({ status: 'WAITING', pending_review: { dispatch_id: t.dispatch_id } });
      expect(d['detail']).toMatch(/await-reviewer/);
      expect(d['ticket']).toBeUndefined();
      const resumed = await dispatch(s, ['--resume', t.review_id]);
      expect(resumed, `resume at ${elapsed}`).toMatchObject({ status: 'WAITING' });
      expect(resumed['detail']).toMatch(/REVIEWER_RUNNING/);
      const st = await status(s);
      expect(st['next_action'], `status at ${elapsed}`).toMatchObject({ kind: 'await-reviewer', resumable: true, reviewer: { review_id: t.review_id, dispatch_id: t.dispatch_id, state: 'RUNNING', agent_id_sha256: sha256(a.agentId), timeout_ms: TIMEOUT_MS } });
      // Its id is given by hash only; nothing of its prompt or answer.
      expect(JSON.stringify(st)).not.toContain(a.agentId);
      expect(JSON.stringify(st)).not.toContain(t.prompt.slice(0, 80));
      expect(frozen(s), `nothing moved at ${elapsed}`).toEqual(before);
    }
    expect(leaseOf(s, t.dispatch_id)).toMatchObject({ status: 'active' });

    // The verdict, its completion enqueued while the host sat in a sleep (r13's record), then absorbed.
    const verdict = verdictFor(reviewPacket(t));
    const answer = JSON.stringify(verdict, null, 2);
    finishAgent(host, a, answer, { notify: 'queued' });
    expect(await awaitReview(s, t)).toMatchObject({ state: 'COMPLETED', next: 'ingest' });
    expect(await ingest(s, t)).toMatchObject({ outcome: 'INGESTED', transport: 'agent-result', agent_id: a.agentId, written: true });
    expect(await ingest(s, t)).toMatchObject({ outcome: 'ALREADY_INGESTED', idempotent: true });
    const settled = await settle(s, t);
    expect(settled).toMatchObject({ outcome: 'PASS', transport: { kind: 'agent-result', agent_id: a.agentId } });
    expect(await settle(s, t)).toMatchObject({ outcome: 'PASS', idempotent: true });
    const state = verState(s);
    expect(state.acceptance_review.usage.sessions).toBe((before['usage'] as { sessions: number }).sessions + 1);
    expect(state.acceptance_review.reviews.map((r: { review_id: string; outcome: string }) => [r.review_id, r.outcome])).toEqual([[t.review_id, 'PASS']]);
    expect(events(s, 'review.refused')).toEqual([]);
    expect(events(s, 'review.ingested')).toHaveLength(1);
  });

  it('the fence refuses a second reviewer for a generation whose reviewer runs, or has answered', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    const again = await hostToolHook(host, 'Agent', { subagent_type: REVIEWER, description: `acceptance review ${t.review_id}`, prompt: t.prompt }, 'toolu_second_launch');
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/already running/);
    expect(again.err).toMatch(/review await/);
    expect(readdirSync(slotDir(t)).filter((n) => n.startsWith('launch-'))).toEqual([`launch-${a.toolUseId}.json`]);
    finishAgent(host, a, JSON.stringify(verdictFor(reviewPacket(t))), { notify: 'queued' });
    const after = await hostToolHook(host, 'Agent', { subagent_type: REVIEWER, description: `acceptance review ${t.review_id}`, prompt: t.prompt }, 'toolu_third_launch');
    expect(after.code).toBe(2);
    expect(after.err).toMatch(/answered/);
    expect(await settle(s, t)).toMatchObject({ outcome: 'PASS' });
  });
});

describe('a reviewer past its wall-clock', () => {
  it('is interrupted: its generation re-issued with nothing spent, its late answer stale', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    const before = frozen(s);
    backdate(t, a, TIMEOUT_MS + 5_000);
    const w = await awaitReview(s, t);
    expect(w).toMatchObject({ state: 'TIMED_OUT', next: 'dispatch', reviewer: { agent_id_sha256: sha256(a.agentId), remaining_ms: 0 } });
    expect(events(s, 'review.reviewer_interrupted')).toEqual([expect.objectContaining({ data: expect.objectContaining({ review_id: t.review_id, dispatch_id: t.dispatch_id, reason: 'timeout', agent_id_sha256: sha256(a.agentId) }) })]);
    expect(leaseOf(s, t.dispatch_id)).toMatchObject({ status: 'interrupted-agent' });
    expect(verState(s).acceptance_review.open).toMatchObject({ dispatch_id: t.dispatch_id, refused: [], agent_interrupted: { reason: 'timeout' } });
    // The same capability again: the same answer, nothing more.
    expect(await settle(s, t)).toMatchObject({ outcome: 'REVIEWER_INTERRUPTED', code: null, blocked: false, next: 'dispatch' });
    expect(await ingest(s, t)).toMatchObject({ outcome: 'REVIEWER_INTERRUPTED', written: false });
    expect((await status(s))['next_action']).toMatchObject({ kind: 'reconcile', resumable: true });
    // The next dispatch: the same review, a fresh generation, nothing spent.
    const t2 = (await dispatch(s))['ticket'] as Ticket;
    expect(t2).toMatchObject({ kind: 'acceptance-review', review_id: t.review_id, attempt: 2, correction: null, resumed: true });
    expect(t2.dispatch_id).not.toBe(t.dispatch_id);
    const after = verState(s).acceptance_review;
    expect(after.open.refused).toEqual([]);
    expect(after.usage).toEqual(before['usage']);
    // The interrupted reviewer answers late: stale, nothing written anywhere it counts.
    finishAgent(host, a, JSON.stringify(verdictFor(reviewPacket(t))), { notify: 'queued' });
    expect(await ingest(s, t)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', written: false });
    expect(await settle(s, t)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    expect(existsSync(t2.result_slot)).toBe(false);
    expect(await awaitReview(s, t2)).toMatchObject({ state: 'MISSING', next: 'launch' });
    // The fresh reviewer settles the review as any would.
    const a2 = await launchReviewer(host, t2);
    finishAgent(host, a2, JSON.stringify(verdictFor(reviewPacket(t2))), { notify: 'queued' });
    expect(await settle(s, t2)).toMatchObject({ outcome: 'PASS', transport: { agent_id: a2.agentId } });
    expect(verState(s).acceptance_review.usage.sessions).toBe((before['usage'] as { sessions: number }).sessions + 1);
  });

  it('past the bound of interruptions, the review stops for a person instead of re-issuing forever', async () => {
    const { s, t, host } = await untilReview();
    let ticket: Ticket = t;
    for (let n = 1; n <= 3; n++) {
      const a = await launchReviewer(host, ticket);
      backdate(ticket, a, TIMEOUT_MS + 1_000);
      expect(await awaitReview(s, ticket), `interruption ${n}`).toMatchObject({ state: 'TIMED_OUT', next: 'dispatch' });
      ticket = (await dispatch(s))['ticket'] as Ticket;
      expect(ticket, `re-issue ${n}`).toMatchObject({ review_id: t.review_id, attempt: n + 1 });
    }
    const a = await launchReviewer(host, ticket);
    backdate(ticket, a, TIMEOUT_MS + 1_000);
    expect(await awaitReview(s, ticket)).toMatchObject({ state: 'TIMED_OUT', next: 'stop' });
    const d = await dispatch(s);
    expect(d).toMatchObject({ status: 'BLOCKED' });
    expect(d['detail']).toMatch(/REVIEW_INVALID: .*interrupted 4 times/);
    expect((await status(s))['next_action']).toMatchObject({ kind: 'decision', resumable: false });
  });
});

describe('a reviewer whose host or task ended before it completed', () => {
  it('whose host session ended (its process gone) is LOST: interrupted, re-issued, nothing spent', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    setHolder(t, a, deadHolder());
    const before = frozen(s);
    expect((await status(s))['next_action']).toMatchObject({ kind: 'reconcile', resumable: true });
    const set = await settle(s, t);
    expect(set).toMatchObject({ outcome: 'REVIEWER_INTERRUPTED', lifecycle: 'LOST', code: null, blocked: false, next: 'dispatch' });
    expect(events(s, 'review.reviewer_interrupted')).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: 'host-ended' }) })]);
    const t2 = (await dispatch(s))['ticket'] as Ticket;
    expect(t2).toMatchObject({ review_id: t.review_id, attempt: 2, correction: null });
    expect(verState(s).acceptance_review.usage).toEqual(before['usage']);
    expect(verState(s).acceptance_review.open.refused).toEqual([]);
  });

  it('whose last request the provider refused, its end enqueued mid-turn, is a provider interruption: revoked, nothing spent', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    const before = frozen(s);
    agentEntry(host, a, { type: 'assistant', requestId: 'req_011r13refused', error: 'invalid_request', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction' }, content: [{ type: 'text', text: 'API Error' }] } });
    notifyQueued(host, a, 'API Error', 'failed');
    expect(await awaitReview(s, t)).toMatchObject({ state: 'FAILED_PROVIDER', next: 'dispatch' });
    expect(await settle(s, t)).toMatchObject({ outcome: 'PROVIDER_INTERRUPTED', code: null, blocked: false });
    expect((await dispatch(s))['ticket']).toMatchObject({ review_id: t.review_id, attempt: 2, correction: null });
    expect(verState(s).acceptance_review.usage).toEqual(before['usage']);
    expect(verState(s).acceptance_review.open.refused).toEqual([]);
  });

  it('whose task was killed is LOST, the same', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    notifyQueued(host, a, 'stopped', 'killed');
    expect(await awaitReview(s, t)).toMatchObject({ state: 'LOST', next: 'dispatch' });
    expect(await settle(s, t)).toMatchObject({ outcome: 'REVIEWER_INTERRUPTED' });
    expect((await dispatch(s))['ticket']).toMatchObject({ review_id: t.review_id, attempt: 2 });
  });

  it('a controller that exits while its reviewer runs on: the next controller finds the same task, waits for it and settles its answer, never a second reviewer', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    // The host process lives on (this one), the controller's conversation ended: a fresh controller resumes.
    setHolder(t, a, processIdentity(process.pid) as unknown as Record<string, unknown>);
    const resumed = await dispatch(s, ['--resume', t.review_id]);
    expect(resumed).toMatchObject({ status: 'WAITING' });
    expect(resumed['detail']).toMatch(/REVIEWER_RUNNING/);
    expect(verState(s).acceptance_review.open.dispatch_id).toBe(t.dispatch_id);
    // Without the old ticket's capability: the await line by review alone.
    expect(await awaitReview(s, null)).toMatchObject({ dispatch_id: t.dispatch_id, state: 'RUNNING' });
    finishAgent(host, a, JSON.stringify(verdictFor(reviewPacket(t))), { notify: 'queued' });
    expect(await awaitReview(s, null)).toMatchObject({ dispatch_id: t.dispatch_id, state: 'COMPLETED' });
    const d = await dispatch(s);
    expect(d['review_reports']).toEqual([expect.objectContaining({ outcome: 'PASS' })]);
  });

  it('a completion made durable before its host ended is still ingested: a crash between completion and ingest loses nothing', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    finishAgent(host, a, JSON.stringify(verdictFor(reviewPacket(t))), { notify: 'queued' });
    setHolder(t, a, deadHolder());
    const resumed = await dispatch(s, ['--resume', t.review_id]);
    expect(resumed).toMatchObject({ status: 'SETTLED', review_reports: [expect.objectContaining({ outcome: 'PASS' })] });
    expect(events(s, 'review.reissued')).toEqual([]);
  });
});

describe("the plugin's own records of a reviewer's launch", () => {
  it("records the host's Claude Code process with the launch and the Agent task it started once the call returns; once that process is gone, a reviewer that never completed is LOST", async () => {
    const { s, t, host } = await untilReview();
    const launcher = join(process.cwd(), 'bin', 'mycelink.mjs');
    const toolUseId = 'toolu_r13_host_process_launch';
    const input = { subagent_type: REVIEWER, description: `acceptance review ${t.review_id}`, prompt: t.prompt };
    const hookPayload = (event: string, extra: Record<string, unknown>): string => JSON.stringify({ session_id: host.sessionId, transcript_path: host.transcript, cwd: host.cwd, hook_event_name: event, tool_name: 'Agent', tool_input: input, tool_use_id: toolUseId, ...extra });
    // The host session's process runs the hook as Claude Code does (its own pid as CLAUDE_PID), then ends.
    const host_ = `const { spawnSync } = require('node:child_process'); const r = spawnSync(process.execPath, [process.argv[1], 'hook', 'controller-fence'], { input: process.argv[2], env: { ...process.env, CLAUDE_PID: String(process.pid) }, encoding: 'utf8', windowsHide: true }); process.stdout.write(JSON.stringify({ pid: process.pid, status: r.status, err: r.stderr }));`;
    const ran = spawnSync(process.execPath, ['-e', host_, launcher, hookPayload('PreToolUse', {})], { cwd: host.cwd, encoding: 'utf8', windowsHide: true });
    const hostRun = JSON.parse(ran.stdout) as { pid: number; status: number; err: string };
    expect(hostRun.status, hostRun.err).toBe(0);
    const { agent: a } = await launchAgent(host, input, { hook: false, toolUseId });
    const launch = JSON.parse(readFileSync(launchFile(t, a), 'utf8')) as Record<string, any>;
    expect(launch['holder']).toMatchObject({ pid: hostRun.pid, host: hostname(), platform: process.platform });
    // The Agent call returned (a background agent): the plugin binds the task it started to the launch.
    const post = spawnSync(process.execPath, [launcher, 'hook', 'tool-end'], { input: hookPayload('PostToolUse', { tool_response: { isAsync: true, status: 'async_launched', agentId: a.agentId, prompt: t.prompt, outputFile: '/tmp/x.output' } }), cwd: host.cwd, encoding: 'utf8', windowsHide: true });
    expect(post.status).toBe(0);
    const bound = JSON.parse(readFileSync(join(slotDir(t), `agent-${toolUseId}.json`), 'utf8')) as Record<string, any>;
    expect(bound).toEqual(expect.objectContaining({ schema: 'mycelink-agent-task/1', tool_use_id: toolUseId, session_id: host.sessionId, agent_id: a.agentId, status: 'async_launched', async: true }));
    expect(JSON.stringify(bound)).not.toContain(t.prompt.slice(0, 60));
    // The host process is gone and the reviewer never completed: LOST, interrupted, nothing spent.
    expect(await awaitReview(s, t)).toMatchObject({ state: 'LOST', next: 'dispatch' });
    expect(events(s, 'review.reviewer_interrupted')).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: 'host-ended', agent_id_sha256: sha256(a.agentId) }) })]);
  });
});

describe('a reviewer that completed', () => {
  it('with no final answer is REVIEW_VERDICT_MISSING, a reviewer attempt, never a correction', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    agentEntry(host, a, { type: 'assistant', message: { model: 'm', id: 'msg_last', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: t.packet_path } }], stop_reason: 'tool_use' } });
    notifyQueued(host, a, '');
    expect(await awaitReview(s, t)).toMatchObject({ state: 'COMPLETED_NO_OUTPUT', next: 'settle' });
    expect(await settle(s, t)).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_VERDICT_MISSING', lifecycle: 'COMPLETED_NO_OUTPUT', blocked: false, corrections: { used: 0 } });
    const t2 = (await dispatch(s))['ticket'] as Ticket;
    expect(t2).toMatchObject({ review_id: t.review_id, attempt: 2, correction: null });
  });

  it('with an answer that is not one JSON object is refused for its form and corrected', async () => {
    const { s, t, host } = await untilReview();
    const a = await launchReviewer(host, t);
    finishAgent(host, a, `Here is my verdict:\n${JSON.stringify(verdictFor(reviewPacket(t)))}`, { notify: 'queued' });
    expect(await ingest(s, t)).toMatchObject({ outcome: 'REVIEW_RESULT_INVALID' });
    expect(await settle(s, t)).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_RESULT_INVALID', corrections: { used: 1 } });
    expect((await dispatch(s))['ticket']).toMatchObject({ review_id: t.review_id, correction: { number: 1, code: 'REVIEW_RESULT_INVALID' } });
  });
});
