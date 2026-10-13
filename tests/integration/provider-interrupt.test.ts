/**
 * A model session the provider failed, reconciled by Mycelink from Claude
 * Code's own records (CSET-203 r10).
 *
 * r10: the cli's rework (its attempt 2) was dispatched at epoch 7; the
 * controller's very next reply was refused by a provider safeguard
 * (`reasoning_extraction`) and the session exited 1. The claim stayed live
 * with its lease until expiry, no worker ever ran, and the run ended with
 * no candidate. That is the provider's failure, not the node's: nothing is
 * charged, nothing BLOCKED.
 *
 * Each dispatch binds the host session that asked for it (the plugin's
 * fence records the session and its transcript when the controller runs
 * `dispatch`), and each worker or reviewer launch binds its subagent. A
 * lease whose holder's transcript ended on a transient provider failure
 * after the lease was issued is `interrupted-provider`: with no progress
 * the claim goes back READY, its attempt refunded, for a fresh worker;
 * with commits or gates made it stays, its capability rotated, for the same
 * generation to resume from exactly where it stands; a review generation is
 * revoked and a fresh one handed out without a format correction or a round
 * spent. Whatever the old generation answers later is stale. Two such
 * failures per ticket (and four per phase) are recovered; past them the
 * feature stops PROVIDER_UNAVAILABLE, never a node BLOCKED.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { ARP, CLI, VER_FEATURE, commitVerControl, createVer, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { fulfil, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { REVIEWER, reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { r6Reviewed, writeChallenge } from '../helpers/cset203-challenge.js';
import { ARP_CRITERIA, CLI_CRITERIA, GAP_AC5, commitCompat, dispatch, reviewed, settle, status, writeResult, type Dispatched } from '../helpers/cset203-rework.js';
import { compatRework, settleReview, writeLateBlocked } from '../helpers/cset203-r7.js';
import { ARP_FIXED_IMPL, ARP_RED, ARP_SRC, ARP_TESTS, CLI_COMPAT_FILE, CLI_COMPAT_TESTS, CLI_FULL_WORK, CLI_JOURNAL_STATUS_TEST } from '../helpers/version-fixture.js';
import { agentEntry, agentToolCall, claudeSession, hostToolHook, launchAgent, notifyCompleted, sessionEntry, type ClaudeSession, type LaunchedAgent } from '../helpers/claude-session.js';

afterAll(() => cleanupTmpRoots());

const toolUse = (): string => `toolu_${randomBytes(12).toString('hex')}`;
const later = (): string => new Date(Date.now() + 1000).toISOString();

/** The controller runs `dispatch` through its Bash tool: the plugin's fence sees the call first and binds the session. */
async function hostDispatch(s: Ver, host: ClaudeSession, argv: string[] = []): Promise<Dispatched> {
  const hook = await hostToolHook(host, 'Bash', { command: `node /plugin/bin/mycelink.mjs dispatch ${VER_FEATURE} ${argv.join(' ')} --control-root ${s.control} --json` }, toolUse());
  expect(hook.code, hook.err).toBe(0);
  sessionEntry(host, { type: 'assistant', message: { model: 'claude-sonnet-5-5', id: `msg_${randomBytes(8).toString('hex')}`, role: 'assistant', content: [{ type: 'text', text: 'dispatching' }], stop_reason: 'tool_use' } });
  return JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, ...argv, '--json'])).out) as Dispatched;
}

/** r10's ending, in the session's own transcript: the model's reply refused, Claude Code's refusal event and its synthetic API error. */
function refuseHost(host: ClaudeSession, requestId = `req_011${randomBytes(8).toString('hex')}`): string {
  const at = later();
  sessionEntry(host, { type: 'assistant', timestamp: at, requestId, message: { model: 'claude-sonnet-5-5', id: 'msg_refused', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction' } } });
  sessionEntry(host, { type: 'system', subtype: 'model_refusal_no_fallback', timestamp: at, content: '', level: 'warning', originalModel: 'claude-sonnet-5-5', requestId, apiRefusalCategory: 'reasoning_extraction', apiRefusalExplanation: 'blocked' });
  sessionEntry(host, { type: 'assistant', timestamp: at, requestId, error: 'invalid_request', isApiErrorMessage: true, refusedMessageId: 'msg_refused', message: { model: '<synthetic>', id: randomBytes(8).toString('hex'), role: 'assistant', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction' }, content: [{ type: 'text', text: 'API Error: safeguards flagged this message. Details: `[reasoning_extraction]`' }] } });
  return requestId;
}

/** A subagent's request failed for good: Claude Code's synthetic API error ends its transcript. */
function failAgent(host: ClaudeSession, a: LaunchedAgent, error: 'rate_limit' | 'refusal', requestId = `req_011${randomBytes(8).toString('hex')}`): string {
  const refusal = error === 'refusal';
  agentEntry(host, a, { type: 'assistant', timestamp: later(), requestId, error: refusal ? 'invalid_request' : 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', stop_reason: refusal ? 'refusal' : 'stop_sequence', ...(refusal ? { stop_details: { type: 'refusal', category: 'reasoning_extraction' } } : {}), content: [{ type: 'text', text: 'API Error' }] } });
  return requestId;
}

async function providerInterrupt(s: Ver, phase = 'task'): Promise<Record<string, any>> {
  const r = await verCli(s, ['session', 'provider-interrupt', VER_FEATURE, '--phase', phase, '--json']);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out) as Record<string, any>;
}

const leases = (s: Ver): Record<string, any>[] => verState(s).orchestration.leases as Record<string, any>[];

/** R001 reworked the cli for AC-5 alone: the cli is the one node to dispatch, as r10's attempt 2 was. */
async function cliReworked(): Promise<Ver> {
  return reviewed({ 'AC-5': GAP_AC5 });
}

describe("r10: the controller's reply refused right after the cli's ticket was dispatched", () => {
  it('the lease is interrupted-provider, the claim back READY with nothing charged; a fresh worker settles it; the old ticket is stale', async () => {
    const s = await cliReworked();
    const before = verState(s).nodes[CLI];
    const host = claudeSession(s.root);
    const d = await hostDispatch(s, host);
    const t1 = d.ticket!;
    expect(t1.node_id).toBe(CLI);
    expect(verState(s).nodes[CLI].claim.host_session).toMatchObject({ session_id: host.sessionId, transcript_path: host.transcript.replace(/\\/g, '/') });
    // Live, its holder's transcript says nothing yet: the controller waits for it.
    expect((await status(s)).next_action.kind).toBe('await-worker');
    expect(await providerInterrupt(s)).toMatchObject({ outcome: 'NOTHING_INTERRUPTED', interrupted: [] });
    const requestId = refuseHost(host);
    // A fresh controller reading the status sees the interruption at once, with no expiry to wait for.
    expect(await status(s)).toMatchObject({ resumable: true, next_action: { kind: 'reconcile' } });
    const r = await providerInterrupt(s);
    expect(r).toMatchObject({
      outcome: 'RECONCILED',
      interrupted: [{ lease_id: t1.dispatch_id, kind: 'worker', node_id: CLI, action: 'released', failure: { class: 'provider-refusal', category: 'reasoning_extraction', request_id: requestId, source: 'host-transcript', session_id: host.sessionId }, count: { ticket: 1, phase: 1 } }],
    });
    let state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ state: 'READY', claim: null, attempts: before.attempts, failure_counts: before.failure_counts, last_failure_fingerprint: before.last_failure_fingerprint });
    expect(state.nodes[CLI].interruptions ?? 0).toBe(before.interruptions ?? 0);
    expect(leases(s).find((l) => l['lease_id'] === t1.dispatch_id)).toMatchObject({ status: 'interrupted-provider', provider: { class: 'provider-refusal', request_id: requestId } });
    expect(state.orchestration.provider).toMatchObject({ tickets: { [`${CLI}:g${(t1 as any).orchestration.generation}:a${t1.attempt}`]: 1 }, phases: { task: 1 }, unavailable: null });
    expect(JSON.stringify(state.orchestration.provider)).not.toMatch(/safeguards|API Error/);
    expect((await status(s)).next_action).toMatchObject({ kind: 'dispatch', resumable: true });
    // The same failure noticed again (a duplicate notification, a reconcile after it): nothing more changes.
    const snapshot = JSON.stringify(verState(s).nodes);
    expect(await providerInterrupt(s)).toMatchObject({ outcome: 'DUPLICATE', interrupted: [], idempotent: true });
    expect((JSON.parse((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).out) as Record<string, any>).provider_interrupted).toEqual([]);
    expect(JSON.stringify(verState(s).nodes)).toBe(snapshot);
    // A fresh controller, a fresh worker: a new claim and capability on the same attempt.
    const host2 = claudeSession(s.root);
    const t2 = (await hostDispatch(s, host2)).ticket!;
    expect(t2.node_id).toBe(CLI);
    expect(t2.claim_id).not.toBe(t1.claim_id);
    expect(t2.capability).not.toBe(t1.capability);
    expect(t2.attempt).toBe(t1.attempt);
    // The old generation answers late: stale, nothing charged.
    writeLateBlocked(t1);
    expect(await settle(s, t1)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    compatRework(t2, s.control);
    expect(await settle(s, t2)).toMatchObject({ outcome: 'DONE' });
    expect(verState(s).nodes[CLI].attempts).toBe(t1.attempt);
  });

  it('commits made before the failure: the same claim resumes from exactly where it stands, its capability rotated; no result of it is trusted', async () => {
    const s = await cliReworked();
    const host = claudeSession(s.root);
    const t1 = (await hostDispatch(s, host)).ticket!;
    // The worker had committed its compatibility test when its host was refused; it ran no gate and wrote no result.
    writeFiles(t1.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    const head = commitCompat(t1.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    refuseHost(host);
    const r = await providerInterrupt(s);
    expect(r.interrupted).toEqual([expect.objectContaining({ node_id: CLI, action: 'resumable', progress: expect.objectContaining({ head_sha: head, commits: 1 }) })]);
    const claim = verState(s).nodes[CLI].claim;
    expect(claim).toMatchObject({ claim_id: t1.claim_id, provider_interrupted: { class: 'provider-refusal', from_dispatch_id: t1.dispatch_id } });
    expect(claim.dispatch_id).not.toBe(t1.dispatch_id);
    expect((await status(s)).next_action).toMatchObject({ kind: 'reconcile', resumable: true });
    const host2 = claudeSession(s.root);
    const t2 = (await hostDispatch(s, host2)).ticket! as ShopTicket & { resumed: boolean; provider_resume?: Record<string, unknown> };
    expect(t2).toMatchObject({ node_id: CLI, claim_id: t1.claim_id, resumed: true, provider_resume: { class: 'provider-refusal', head_sha: head } });
    expect(t2.capability).not.toBe(t1.capability);
    expect(t2.prompt).toMatch(/model provider interrupted/);
    expect(verState(s).nodes[CLI].claim.provider_interrupted ?? null).toBeNull();
    expect(await settle(s, t1)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    // The resumed worker carries on from its commit: its gates, then its result.
    const green = runGate(t2, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(t2, 'regression', s.control).code).toBe(0);
    const carried = (packOf(t2)['rework']['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
    writeResult(t2, [...carried.map((c) => ({ criterion: c.criterion, test_id: c.test_id, gate: c.gate ?? 'red', output_sha256: c.output_sha256 })), { criterion: 'AC-5', test_id: green.tests.find((x) => x.full_name === CLI_JOURNAL_STATUS_TEST)!.id, gate: 'green', output_sha256: green.sha256 }]);
    expect(await settle(s, t2)).toMatchObject({ outcome: 'DONE' });
  });

  it("a host whose last reply was a model's text about an API error, or a permanent failure, is not interrupted: the lease waits as before", async () => {
    const s = await cliReworked();
    const host = claudeSession(s.root);
    await hostDispatch(s, host);
    sessionEntry(host, { type: 'assistant', timestamp: later(), message: { model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: "API Error: Sonnet 5.5's safeguards flagged this message. Details: `[reasoning_extraction]`" }], stop_reason: 'end_turn' } });
    expect(await providerInterrupt(s)).toMatchObject({ outcome: 'NOTHING_INTERRUPTED' });
    sessionEntry(host, { type: 'assistant', timestamp: later(), error: 'authentication_failed', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 401' }] } });
    const r = await providerInterrupt(s);
    expect(r).toMatchObject({ outcome: 'NOTHING_INTERRUPTED', kept: [expect.objectContaining({ node_id: CLI, why: expect.stringMatching(/auth.*not transient/) })] });
    expect(verState(s).nodes[CLI].claim).not.toBeNull();
    expect((await status(s)).next_action.kind).toBe('await-worker');
  });

  it('two interruptions of one ticket are recovered; the third stops the feature PROVIDER_UNAVAILABLE, the node READY, never BLOCKED', async () => {
    const s = await cliReworked();
    for (const n of [1, 2]) {
      const host = claudeSession(s.root);
      await hostDispatch(s, host);
      refuseHost(host);
      expect(await providerInterrupt(s)).toMatchObject({ outcome: 'RECONCILED', interrupted: [expect.objectContaining({ count: { ticket: n, phase: n } })] });
    }
    const host = claudeSession(s.root);
    await hostDispatch(s, host);
    refuseHost(host);
    const r = await providerInterrupt(s);
    expect(r).toMatchObject({ outcome: 'PROVIDER_UNAVAILABLE', interrupted: [expect.objectContaining({ node_id: CLI, action: 'released', count: { ticket: 3, phase: 3 } })] });
    const state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ state: 'READY', claim: null });
    expect(state.orchestration.provider.unavailable).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await status(s)).toMatchObject({ resumable: false, next_action: { kind: 'stopped', detail: expect.stringMatching(/PROVIDER_UNAVAILABLE/) } });
    expect(await dispatch(s)).toMatchObject({ status: 'PROVIDER_UNAVAILABLE' });
    // A person clears it: the work goes on.
    expect((await verCli(s, ['session', 'provider-reset', VER_FEATURE, '--json'])).code).toBe(0);
    expect((await status(s)).next_action).toMatchObject({ kind: 'dispatch', resumable: true });
  });

  it('four interruptions in one phase are recovered; the fifth, of a fresh ticket, stops the feature', async () => {
    const s = await createVer({ review: {} });
    const interrupt = async (): Promise<{ t: ShopTicket & { kind?: string }; r: Record<string, any> }> => {
      const host = claudeSession(s.root);
      const t = (await hostDispatch(s, host)).ticket!;
      refuseHost(host);
      return { t, r: await providerInterrupt(s, 'rework') };
    };
    for (const n of [1, 2]) expect((await interrupt()).r).toMatchObject({ outcome: 'RECONCILED', interrupted: [expect.objectContaining({ node_id: ARP, count: { ticket: n, phase: n } })] });
    const a = (await dispatch(s)).ticket!;
    fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: ARP_CRITERIA }, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
    for (const n of [1, 2]) expect((await interrupt()).r).toMatchObject({ outcome: 'RECONCILED', interrupted: [expect.objectContaining({ node_id: CLI, count: { ticket: n, phase: n + 2 } })] });
    const c = (await dispatch(s)).ticket!;
    fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
    expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'both producers');
    const fifth = await interrupt();
    expect(fifth.t).toMatchObject({ kind: 'acceptance-review' });
    expect(fifth.r).toMatchObject({ outcome: 'PROVIDER_UNAVAILABLE', interrupted: [expect.objectContaining({ kind: 'review', count: { ticket: 1, phase: 5 } })] });
    expect((await status(s)).next_action).toMatchObject({ kind: 'stopped', resumable: false });
    expect(Object.values(verState(s).nodes as Record<string, any>).map((n) => n.state)).not.toContain('BLOCKED');
  });
});

describe("a dispatched Agent's own request failed while its controller lived", () => {
  it("a worker whose transcript ends on a rate limit settles PROVIDER_INTERRUPTED: no RESULT_MISSING, no attempt, a fresh worker next", async () => {
    const s = await cliReworked();
    const before = verState(s).nodes[CLI];
    const host = claudeSession(s.root);
    const t = (await hostDispatch(s, host)).ticket!;
    const { agent } = await launchAgent(host, { subagent_type: 'mycelink:module-worker', description: CLI, prompt: t.prompt });
    agentToolCall(host, agent, 'Bash', { command: 'git status' }, 'clean');
    const requestId = failAgent(host, agent, 'rate_limit');
    notifyCompleted(host, agent, 'API Error: rate limited', 'failed');
    const r = (await settle(s, t)) as Record<string, any>;
    expect(r, r['detail']).toMatchObject({ outcome: 'PROVIDER_INTERRUPTED', state: 'READY', provider: { class: 'rate-limit', request_id: requestId, source: 'agent-transcript' } });
    expect(verState(s).nodes[CLI]).toMatchObject({ state: 'READY', claim: null, attempts: before.attempts, failure_counts: before.failure_counts });
    // The same settle again: the same answer, nothing more.
    expect(await settle(s, t)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    const t2 = (await hostDispatch(s, host)).ticket!;
    compatRework(t2, s.control);
    expect(await settle(s, t2)).toMatchObject({ outcome: 'DONE' });
  });

  it("a worker that simply wrote nothing is still RESULT_MISSING: only Claude Code's record of a provider failure makes it one", async () => {
    const s = await cliReworked();
    const host = claudeSession(s.root);
    const t = (await hostDispatch(s, host)).ticket!;
    const { agent } = await launchAgent(host, { subagent_type: 'mycelink:module-worker', description: CLI, prompt: t.prompt });
    agentEntry(host, agent, { type: 'assistant', message: { model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'API Error: rate limited (I am a model saying so)' }], stop_reason: 'end_turn' } });
    notifyCompleted(host, agent, 'done');
    expect(await settle(s, t)).not.toMatchObject({ outcome: 'PROVIDER_INTERRUPTED' });
  });
});

/** Both producers DONE and R001 out with its reviewer, not settled. */
async function reviewOut(): Promise<{ s: Ver; r: ReviewTicket; host: ClaudeSession }> {
  const s = await createVer({ review: {} });
  const host = claudeSession(s.root);
  const a = (await dispatch(s)).ticket!;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  const c = (await dispatch(s)).ticket!;
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'both producers');
  const r = (await hostDispatch(s, host)).ticket as unknown as ReviewTicket;
  expect(r).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001` });
  commitVerControl(s, 'R001 out');
  return { s, r, host };
}

describe("the reviewer's final answer refused by the provider", () => {
  it('its generation is revoked and a fresh one handed out: no format correction, no round, no usage spent; its old capability is stale', async () => {
    const { s, r, host } = await reviewOut();
    const { agent } = await launchAgent(host, { subagent_type: REVIEWER, description: 'acceptance review', prompt: r.prompt });
    agentToolCall(host, agent, 'Read', { file_path: r.packet_path }, '5 criteria');
    const requestId = failAgent(host, agent, 'refusal');
    notifyCompleted(host, agent, 'API Error', 'failed');
    const usage = verState(s).acceptance_review.usage;
    const ingest = JSON.parse((await verCli(s, ['review', 'ingest', VER_FEATURE, '--review', r.review_id, '--capability', r.capability, '--json'])).out) as Record<string, any>;
    expect(ingest).toMatchObject({ outcome: 'PROVIDER_INTERRUPTED' });
    const settled = await settleReview(s, r);
    expect(settled).toMatchObject({ outcome: 'PROVIDER_INTERRUPTED', code: null, blocked: false, next: 'dispatch', provider: { class: 'provider-refusal', request_id: requestId, source: 'agent-transcript' } });
    let state = verState(s);
    expect(state.acceptance_review.open).toMatchObject({ dispatch_id: r.dispatch_id, refused: [], provider_interrupted: { class: 'provider-refusal' } });
    expect(state.acceptance_review.reviews).toEqual([]);
    expect(state.acceptance_review.usage).toEqual(usage);
    expect(leases(s).find((l) => l['lease_id'] === r.dispatch_id)).toMatchObject({ status: 'interrupted-provider' });
    expect((await status(s)).next_action).toMatchObject({ kind: 'reconcile', resumable: true });
    // The next dispatch: a fresh reviewer generation of the same review, no correction.
    const r2 = (await hostDispatch(s, host)).ticket as unknown as ReviewTicket;
    expect(r2).toMatchObject({ kind: 'acceptance-review', review_id: r.review_id, attempt: 2, correction: null, resumed: true });
    expect(r2.dispatch_id).not.toBe(r.dispatch_id);
    // The revoked generation answers late: stale, nothing written.
    expect(await settleReview(s, r)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    // The fresh reviewer's verdict settles the review as any would.
    const { agent: a2 } = await launchAgent(host, { subagent_type: REVIEWER, description: 'acceptance review', prompt: r2.prompt });
    const verdict = verdictFor(reviewPacket(r2));
    const { finishAgent } = await import('../helpers/claude-session.js');
    finishAgent(host, a2, JSON.stringify(verdict));
    expect(JSON.parse((await verCli(s, ['review', 'ingest', VER_FEATURE, '--review', r2.review_id, '--capability', r2.capability, '--json'])).out)).toMatchObject({ outcome: 'INGESTED' });
    expect(await settleReview(s, r2)).toMatchObject({ outcome: 'PASS' });
    state = verState(s);
    expect(state.acceptance_review.reviews.map((x: any) => [x.review_id, x.outcome])).toEqual([[r.review_id, 'PASS']]);
    expect(existsSync(r.result_slot)).toBe(false);
  });
});

describe('a correction or a refinement generation whose holder the provider ended', () => {
  it("a format correction's generation: revoked and re-issued as the same correction, none spent", async () => {
    const { s, r, host } = await reviewOut();
    const bad = { ...verdictFor(reviewPacket(r)), overall: 'MAYBE' };
    await writeVerdict(r, bad, { cwd: s.control, agentId: 'reviewer-agent-1', sessionId: host.sessionId });
    const refused = await settleReview(s, r);
    expect(refused, refused['detail']).toMatchObject({ outcome: 'REVIEW_INVALID', blocked: false });
    commitVerControl(s, 'R001 refused for its form');
    const c1 = (await hostDispatch(s, host)).ticket as unknown as ReviewTicket;
    expect(c1.correction).toMatchObject({ number: 1 });
    refuseHost(host);
    expect(await providerInterrupt(s)).toMatchObject({ outcome: 'RECONCILED', interrupted: [expect.objectContaining({ kind: 'review', review_id: r.review_id, action: 'review-reissue', ticket: `${r.review_id}:review` })] });
    const c2 = (await hostDispatch(s, host)).ticket as unknown as ReviewTicket;
    expect(c2).toMatchObject({ review_id: r.review_id, attempt: c1.attempt + 1, correction: { number: 1 } });
    expect(verState(s).acceptance_review.open.refused).toHaveLength(1);
    expect(await settleReview(s, c1)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
  });

  it("a refinement's generation: revoked and re-issued as the same refinement round; the challenge still pending", async () => {
    const s = await r6Reviewed();
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(ARP);
    writeChallenge(t, s.control);
    expect(await settle(s, t)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'R001 AC-1 challenged');
    const host = claudeSession(s.root);
    const f1 = (await hostDispatch(s, host)).ticket as unknown as ReviewTicket;
    expect(f1.refinement).toMatchObject({ round: 1 });
    refuseHost(host);
    expect(await status(s)).toMatchObject({ next_action: { kind: 'reconcile', resumable: true } });
    expect(await providerInterrupt(s)).toMatchObject({ outcome: 'RECONCILED', interrupted: [expect.objectContaining({ kind: 'review', action: 'review-reissue', ticket: `${f1.review_id}:refinement-1` })] });
    const f2 = (await hostDispatch(s, host)).ticket as unknown as ReviewTicket;
    expect(f2).toMatchObject({ review_id: f1.review_id, attempt: f1.attempt + 1, refinement: { round: 1 } });
    expect(verState(s).acceptance_review.challenges.map((c: any) => c.status)).toEqual(['pending']);
    expect(await settleReview(s, f1)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
  });
});
