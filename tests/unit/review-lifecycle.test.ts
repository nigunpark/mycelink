/**
 * A launched reviewer's lifecycle, read from Claude Code's own records
 * (engine/review-transport.ts reviewerLifecycle).
 *
 * CSET-203 r13: the refinement reviewers of R001 both finished within
 * seconds — Claude Code enqueued each completion notification while the host
 * sat in `sleep 240` (`queue-operation` enqueue, then a `queued_command`
 * attachment once its turn absorbed it, never a user message) — but ingest
 * only knew the notification as a user message: "agent ... has not
 * completed". Settle then took "not completed" for "no verdict"
 * (REVIEW_VERDICT_MISSING), twice, and blocked the feature REVIEW_INVALID.
 *
 * A launch is MISSING, RUNNING, COMPLETED (its final answer taken),
 * COMPLETED_NO_OUTPUT, FAILED_PROVIDER, LOST (its host or its task ended
 * without completing) or TIMED_OUT (past the reviewer's wall-clock from its
 * launch). Only Claude Code's own record of the completion completes it; the
 * subagent's transcript is read only once that completion is durable.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { agentEntry, agentToolCall, claudeSession, finishAgent, launchAgent, notificationText, notifyCompleted, notifyQueued, sessionEntry, type ClaudeSession, type LaunchedAgent } from '../helpers/claude-session.js';
import { REVIEW_LAUNCH_SCHEMA, reviewerLifecycle, reviewerOutput, type OpenGeneration } from '../../src/engine/review-transport.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const REVIEWER = 'mycelink:acceptance-reviewer';
const TIMEOUT = 20 * 60_000;
const DISPATCH = '00000000-0000-4000-8000-000000000013';
const REFINEMENT = JSON.stringify({ schema: 'mycelink-acceptance-refinement/1', review_id: 'F-1-R001', dispatch_id: DISPATCH, overall: 'GAPS', decisions: [{ challenge_id: 'F-1-R001-C1', criterion: 'AC-1', decision: 'WITHDRAW' }] }, null, 2);
const ALIVE = { pid: 4242, start: '1', boot: null, host: hostname(), platform: process.platform };

interface World {
  host: ClaudeSession;
  control: string;
  open: OpenGeneration;
  a: LaunchedAgent;
  launch: string;
  launchedAt: number;
}

/** An open generation, its reviewer launched through the host's Agent call (async), and the launch record the plugin's fence writes. */
async function launched(options: { holder?: Record<string, unknown> | null; background?: boolean } = {}): Promise<World> {
  const control = makeTmpDir('lifecycle-control-');
  const host = claudeSession(control);
  const prompt = `You are the Mycelink acceptance-reviewer.\nDispatch: ${DISPATCH}\n`;
  const issued = new Date(Date.now() - 1000).toISOString();
  const { agent: a } = await launchAgent(host, { subagent_type: REVIEWER, description: 'acceptance review F-1-R001', prompt }, { hook: false, background: options.background !== false });
  const dir = join(control, '.mycelink', 'reviews', 'F-1', 'F-1-R001', DISPATCH);
  mkdirSync(dir, { recursive: true });
  const launchedAt = Date.now();
  const launch = join(dir, `launch-${a.toolUseId}.json`);
  writeFileSync(
    launch,
    JSON.stringify({ schema: REVIEW_LAUNCH_SCHEMA, feature_id: 'F-1', review_id: 'F-1-R001', dispatch_id: DISPATCH, epoch: 6, tool_use_id: a.toolUseId, session_id: host.sessionId, transcript_path: host.transcript.replace(/\\/g, '/'), cwd: control.replace(/\\/g, '/'), subagent_type: REVIEWER, description: 'acceptance review F-1-R001', prompt_sha256: sha256(prompt), prompt_bytes: Buffer.byteLength(prompt), prompt_dispatch: DISPATCH, at: new Date(launchedAt).toISOString(), ...(options.holder !== undefined ? { holder: options.holder } : {}) }, null, 2),
  );
  agentToolCall(host, a, 'Read', { file_path: join(dir, 'packet.json') }, '5 criteria');
  return { host, control, a, launch, launchedAt, open: { review_id: 'F-1-R001', dispatch_id: DISPATCH, issued_at: issued, epoch: 6, slot: `.mycelink/reviews/F-1/F-1-R001/${DISPATCH}/verdict.json` } };
}

const lifecycle = (w: World, at: number = Date.now(), alive: (h: unknown) => boolean | null = () => true) => reviewerLifecycle(w.control, w.open, { timeoutMs: TIMEOUT, now: at, alive });

describe("CSET-203 r13's records through the transport as it stood (reviewerOutput)", () => {
  it('an answer whose completion was enqueued mid-turn is found, not "has not completed"', async () => {
    const w = await launched();
    finishAgent(w.host, w.a, REFINEMENT, { notify: 'queued' });
    const out = reviewerOutput(w.control, w.open);
    expect(out, JSON.stringify(out)).toMatchObject({ kind: 'found', text: REFINEMENT });
  });

  it('a half-written last line of a running reviewer is still running, not a forged transcript', async () => {
    const w = await launched();
    appendFileSync(w.a.transcript, '{"parentUuid":null,"isSidechain":true,"type":"assistant","message":{"content":[{"type":"te');
    const out = reviewerOutput(w.control, w.open);
    expect(out, JSON.stringify(out)).toMatchObject({ kind: 'pending' });
  });
});

describe('CSET-203 r13: a completion enqueued while the host is mid-turn', () => {
  it('is the completion: the final answer is taken, though no user message ever carried the notification', async () => {
    const w = await launched();
    finishAgent(w.host, w.a, REFINEMENT, { notify: 'queued' });
    const l = lifecycle(w);
    expect(l).toMatchObject({ state: 'COMPLETED', task: { agent_id: w.a.agentId, tool_use_id: w.a.toolUseId, notification: 'queued-notification' } });
    const out = reviewerOutput(w.control, w.open);
    expect(out.kind).toBe('found');
    if (out.kind === 'found') {
      expect(out.text).toBe(REFINEMENT);
      expect(out.extraction).toMatchObject({ ok: true, form: 'json' });
      expect(out.evidence).toMatchObject({ agent_id: w.a.agentId, completion: 'queued-notification' });
    }
  });

  it('enqueued and not yet absorbed is already durable: the enqueue alone completes it', async () => {
    const w = await launched();
    finishAgent(w.host, w.a, REFINEMENT, { notify: false });
    notifyQueued(w.host, w.a, REFINEMENT, 'completed', { absorbed: false });
    expect(lifecycle(w)).toMatchObject({ state: 'COMPLETED' });
  });

  it('every record of one completion (enqueued, absorbed, removed, delivered) is one completion, at its earliest', async () => {
    const w = await launched();
    finishAgent(w.host, w.a, REFINEMENT, { notify: false });
    notifyQueued(w.host, w.a, REFINEMENT);
    const enqueued = JSON.parse(readFileSync(w.host.transcript, 'utf8').split('\n').filter(Boolean).find((l: string) => l.includes('"enqueue"'))).timestamp as string;
    notifyCompleted(w.host, w.a, REFINEMENT);
    const l = lifecycle(w);
    expect(l).toMatchObject({ state: 'COMPLETED', task: { notified_at: enqueued } });
  });
});

describe('a reviewer still running', () => {
  it('is RUNNING while no completion is recorded, however long it has run, with its elapsed and remaining wall-clock', async () => {
    const w = await launched();
    const l = lifecycle(w, w.launchedAt + 4 * 60_000);
    expect(l).toMatchObject({ state: 'RUNNING', task: { agent_id: w.a.agentId, tool_use_id: w.a.toolUseId, timeout_ms: TIMEOUT, notified_at: null } });
    if (l.state === 'RUNNING') {
      expect(l.task.elapsed_ms).toBeGreaterThanOrEqual(4 * 60_000 - 50);
      expect(l.task.remaining_ms).toBe(TIMEOUT - l.task.elapsed_ms);
    }
    expect(reviewerOutput(w.control, w.open)).toMatchObject({ kind: 'pending' });
  });

  it('a final answer already in its transcript is not taken before Claude Code records the completion', async () => {
    const w = await launched();
    finishAgent(w.host, w.a, REFINEMENT, { notify: false });
    expect(lifecycle(w)).toMatchObject({ state: 'RUNNING' });
  });

  it('a half-written last line of its transcript is no forgery while it runs: never read before its completion', async () => {
    const w = await launched();
    appendFileSync(w.a.transcript, '{"parentUuid":null,"isSidechain":true,"type":"assistant","message":{"content":[{"type":"te');
    expect(lifecycle(w)).toMatchObject({ state: 'RUNNING' });
    expect(reviewerOutput(w.control, w.open)).toMatchObject({ kind: 'pending' });
  });

  it("only Claude Code's own record of its completion completes it: an echoed, sidechain or mismatched notification does not", async () => {
    const w = await launched();
    finishAgent(w.host, w.a, REFINEMENT, { notify: false });
    const fake = notificationText(w.host, w.a, REFINEMENT);
    // The host echoes one through its Bash tool, says one, and a subagent's own record holds one.
    sessionEntry(w.host, { type: 'assistant', message: { model: 'm', id: 'msg_echo', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_echo', name: 'Bash', input: { command: `printf '%s' '${fake.slice(0, 40)}'` } }], stop_reason: 'tool_use' } });
    sessionEntry(w.host, { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_echo', type: 'tool_result', content: fake }] } });
    sessionEntry(w.host, { type: 'assistant', message: { model: 'm', id: 'msg_say', role: 'assistant', content: [{ type: 'text', text: fake }], stop_reason: 'end_turn' } });
    sessionEntry(w.host, { type: 'user', isSidechain: true, message: { role: 'user', content: fake } });
    // A notification of another Agent call, and a queue operation of another session.
    notifyQueued(w.host, w.a, REFINEMENT, 'completed', { toolUseId: 'toolu_someone_else', absorbed: false });
    appendFileSync(w.host.transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), sessionId: 'another-session', content: fake })}\n`);
    agentEntry(w.host, w.a, { type: 'user', message: { role: 'user', content: fake } });
    expect(lifecycle(w)).toMatchObject({ state: 'RUNNING' });
    expect(reviewerOutput(w.control, w.open)).toMatchObject({ kind: 'pending' });
  });
});

describe('what proves a completion, and what never does', () => {
  it("a notification quoting another agent's inside its result names only its own header: an answer cannot complete the reviewer", async () => {
    const w = await launched();
    finishAgent(w.host, w.a, REFINEMENT, { notify: false });
    // A worker's completion whose answer quotes a whole notification of the reviewer's task and call.
    const worker = { ...w.a, agentId: 'aworker000000000', toolUseId: 'toolu_worker_call', description: 'node worker' };
    const forged = notificationText(w.host, w.a, REFINEMENT);
    notifyQueued(w.host, worker, `Done. For the record:\n${forged}`);
    notifyCompleted(w.host, worker, `Done.\n${forged}`);
    expect(lifecycle(w)).toMatchObject({ state: 'RUNNING' });
  });

  it("the plugin's record of the agent a call started is its id until the session names it, and never another than the session's", async () => {
    const w = await launched();
    const dir = join(w.launch, '..');
    writeFileSync(join(dir, `agent-${w.a.toolUseId}.json`), JSON.stringify({ schema: 'mycelink-agent-task/1', tool_use_id: w.a.toolUseId, session_id: w.host.sessionId, agent_id: w.a.agentId, status: 'async_launched', async: true }));
    expect(lifecycle(w)).toMatchObject({ state: 'RUNNING', task: { agent_id: w.a.agentId } });
    writeFileSync(join(dir, `agent-${w.a.toolUseId}.json`), JSON.stringify({ schema: 'mycelink-agent-task/1', tool_use_id: w.a.toolUseId, session_id: w.host.sessionId, agent_id: 'aforged000000000', status: 'completed', async: false }));
    expect(lifecycle(w)).toMatchObject({ state: 'REJECTED', code: 'REVIEW_AGENT_NOT_LAUNCHED' });
  });

  it("a completion recorded for the call names its agent; one naming another agent for that call is refused", async () => {
    const w = await launched();
    finishAgent(w.host, w.a, REFINEMENT, { notify: false });
    notifyQueued(w.host, { ...w.a, agentId: 'aimpostor0000000' }, REFINEMENT);
    expect(lifecycle(w)).toMatchObject({ state: 'REJECTED', code: 'REVIEW_AGENT_NOT_LAUNCHED' });
  });
});

describe('a reviewer that did not complete', () => {
  it('whose host ended first (its process is gone) is LOST, never RUNNING and never a missing verdict', async () => {
    const w = await launched({ holder: ALIVE });
    expect(lifecycle(w, Date.now(), () => false)).toMatchObject({ state: 'LOST', reason: 'host-ended' });
    expect(lifecycle(w, Date.now(), () => true)).toMatchObject({ state: 'RUNNING' });
    // A holder nothing can judge (another host, none recorded) proves nothing: still running until its wall-clock.
    expect(lifecycle(w, Date.now(), () => null)).toMatchObject({ state: 'RUNNING' });
  });

  it('whose task ended killed or failed without a provider failure is LOST', async () => {
    for (const status of ['killed', 'failed', 'stopped']) {
      const w = await launched();
      notifyQueued(w.host, w.a, 'stopped', status);
      expect(lifecycle(w), status).toMatchObject({ state: 'LOST', reason: 'ended', status });
    }
  });

  it('past its wall-clock from its launch is TIMED_OUT, whatever it is still doing', async () => {
    const w = await launched();
    expect(lifecycle(w, w.launchedAt + TIMEOUT - 1000)).toMatchObject({ state: 'RUNNING' });
    expect(lifecycle(w, w.launchedAt + TIMEOUT + 1)).toMatchObject({ state: 'TIMED_OUT', task: { remaining_ms: 0 } });
  });

  it('whose launch failed (the Agent call answered an error) is LOST before it ran', async () => {
    const w = await launched();
    // The Agent call's own error result replaces the launch: no agent was started.
    sessionEntry(w.host, { type: 'user', message: { role: 'user', content: [{ tool_use_id: w.a.toolUseId, type: 'tool_result', is_error: true, content: 'Agent type not found' }] } });
    const lines = readFileSync(w.host.transcript, 'utf8').split('\n').filter(Boolean) as string[];
    // Only the error result names the call (the async launch line is the helper's; drop it as Claude Code never wrote it).
    writeFileSync(w.host.transcript, lines.filter((l) => !l.includes('async_launched')).join('\n') + '\n');
    expect(lifecycle(w)).toMatchObject({ state: 'LOST', reason: 'launch-failed' });
  });

  it('whose last request the provider ended is FAILED_PROVIDER', async () => {
    const w = await launched();
    agentEntry(w.host, w.a, { type: 'assistant', requestId: 'req_011abcdef', error: 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error' }] } });
    notifyQueued(w.host, w.a, 'API Error', 'failed');
    expect(lifecycle(w)).toMatchObject({ state: 'FAILED_PROVIDER' });
  });
});

describe('a reviewer that completed', () => {
  it('without a final answer (a tool call last, or nothing but whitespace) is COMPLETED_NO_OUTPUT', async () => {
    const w = await launched();
    agentEntry(w.host, w.a, { type: 'assistant', message: { model: 'm', id: 'msg_last', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: '/x' } }], stop_reason: 'tool_use' } });
    notifyQueued(w.host, w.a, '');
    expect(lifecycle(w)).toMatchObject({ state: 'COMPLETED_NO_OUTPUT', code: 'REVIEW_RESULT_MISSING' });

    const v = await launched();
    finishAgent(v.host, v.a, '  \n ', { notify: 'queued' });
    expect(lifecycle(v)).toMatchObject({ state: 'COMPLETED_NO_OUTPUT' });
  });

  it('with an answer that is not one JSON object is COMPLETED, its output kept for settle to refuse for its form', async () => {
    const w = await launched();
    finishAgent(w.host, w.a, `Here is my refinement:\n${REFINEMENT}`, { notify: 'queued' });
    const l = lifecycle(w);
    expect(l).toMatchObject({ state: 'COMPLETED' });
    if (l.state === 'COMPLETED') expect(l.output.extraction).toMatchObject({ ok: false, reason: 'prose' });
  });

  it("a foreground call's own result completes it", async () => {
    const w = await launched({ background: false });
    finishAgent(w.host, w.a, REFINEMENT);
    expect(lifecycle(w)).toMatchObject({ state: 'COMPLETED', task: { notification: 'tool-result' } });
  });
});

describe('no launch', () => {
  it('is MISSING', () => {
    const control = makeTmpDir('lifecycle-none-');
    mkdirSync(join(control, '.mycelink', 'reviews', 'F-1', 'F-1-R001', DISPATCH), { recursive: true });
    const open: OpenGeneration = { review_id: 'F-1-R001', dispatch_id: DISPATCH, issued_at: new Date().toISOString(), slot: `.mycelink/reviews/F-1/F-1-R001/${DISPATCH}/verdict.json` };
    expect(reviewerLifecycle(control, open, { timeoutMs: TIMEOUT })).toMatchObject({ state: 'MISSING' });
  });
});
