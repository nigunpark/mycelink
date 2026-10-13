/**
 * A worker still running is no missing result.
 *
 * Claude Code runs a host's Agent call for a module-worker in the
 * background by default: the call answers "Async agent launched" at once and
 * the session records the agent's completion later, as a task notification.
 * A host that runs the ticket's settle line before that notification found
 * the slot empty, and settle charged the worker's attempt RESULT_MISSING —
 * an orchestration slip of the host's, paid for with a product attempt,
 * while the worker went on working on a claim that was gone. The reviewer
 * had the same hole and got REVIEWER_RUNNING (CSET-203 r13); a worker gets
 * WORKER_RUNNING: nothing settled, written or charged, while the session's
 * own records show its launch and no completion, its host lives and it is
 * within the session wall-clock. A worker that completed and wrote nothing
 * is still RESULT_MISSING.
 *
 * Likewise a verified, sealed submission whose integration lock another
 * process held past its wait was charged as a failed attempt: contention, not
 * the work. It is held (PRECONDITION_FAILED, nothing charged) and the next
 * dispatch finishes the settlement.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { ERRORS, SHOP_CRITERIA, SHOP_FEATURE, SHOP_WORK, createShop as baseShop, moduleVerifier, shopCli, shopGraph, type Shop } from '../helpers/shop-fixture.js';
import { fulfil, type ShopTicket } from '../helpers/shop-worker.js';
import { claudeSession, launchAgent, notifyCompleted, type ClaudeSession, type LaunchedAgent } from '../helpers/claude-session.js';
import { loadState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const WORKER = 'mycelink:module-worker';
const createShop = () => baseShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });

async function dispatch(s: Shop): Promise<ShopTicket> {
  const r = await shopCli(s, ['dispatch', SHOP_FEATURE, '--json']);
  return (JSON.parse(r.out) as { ticket: ShopTicket }).ticket;
}

async function settle(s: Shop, t: ShopTicket): Promise<Record<string, any>> {
  const r = await shopCli(s, ['settle', SHOP_FEATURE, t.node_id, '--capability', t.capability, '--json']);
  return JSON.parse(r.out) as Record<string, any>;
}

const node = (s: Shop, id: string) => loadState(s.featureDir)!.data.nodes[id]!;

/** A dispatched ticket and its worker launched in the background, through the plugin's hook: running, nothing written yet. */
async function launched(): Promise<{ s: Shop; t: ShopTicket; host: ClaudeSession; agent: LaunchedAgent }> {
  const s = await createShop();
  const t = await dispatch(s);
  expect(t.node_id).toBe(ERRORS);
  const host = claudeSession(s.root);
  const { agent } = await launchAgent(host, { subagent_type: WORKER, description: t.node_id, prompt: t.prompt });
  return { s, t, host, agent };
}

describe('a settle while the dispatched worker still runs', () => {
  it('answers WORKER_RUNNING: nothing settled, charged or written; once it completes with its result, settle takes it', async () => {
    const { s, t, host, agent } = await launched();
    const before = node(s, ERRORS);
    const stateBytes = readFileSync(join(s.featureDir, 'STATE.json'), 'utf8');
    const r = await settle(s, t);
    expect(r, r['detail']).toMatchObject({ outcome: 'WORKER_RUNNING', next: 'await', idempotent: false });
    expect(r['detail']).toMatch(/nothing was settled, written or charged/i);
    expect(readFileSync(join(s.featureDir, 'STATE.json'), 'utf8')).toBe(stateBytes);
    expect(node(s, ERRORS)).toMatchObject({ state: before.state, attempts: before.attempts, failure_counts: before.failure_counts, claim: { claim_id: t.claim_id } });
    // It completes, its result in its slot: the same capability settles it.
    fulfil(t, { ...SHOP_WORK[ERRORS]!, criteria: SHOP_CRITERIA[ERRORS]!.map((c) => ({ criterion: c.criterion, gate: c.gate, full_name: c.name })) }, s.control);
    notifyCompleted(host, agent, 'done');
    expect(await settle(s, t)).toMatchObject({ outcome: 'DONE' });
    expect(node(s, ERRORS).failure_counts).toEqual(before.failure_counts);
  });

  it('a worker that completed and wrote nothing is still RESULT_MISSING, charged as its attempt', async () => {
    const { s, t, host, agent } = await launched();
    notifyCompleted(host, agent, 'I am done');
    const r = await settle(s, t);
    expect(String(r['detail'])).toMatch(/RESULT_MISSING/);
    expect(node(s, ERRORS)).toMatchObject({ state: 'READY', claim: null });
    expect(node(s, ERRORS).failure_counts['RESULT_MISSING']).toBe(1);
  });

  it('a worker whose launch failed, or one past the session wall-clock, is no running worker', async () => {
    const failed = await launched();
    notifyCompleted(failed.host, failed.agent, 'killed', 'killed');
    expect(String((await settle(failed.s, failed.t))['detail'])).toMatch(/RESULT_MISSING/);

    const late = await launched();
    const dir = join(late.s.control, '.mycelink', 'launches', SHOP_FEATURE, late.t.dispatch_id as string);
    const file = join(dir, `launch-${late.agent.toolUseId}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, at: new Date(Date.now() - 24 * 3_600_000).toISOString() }));
    expect(String((await settle(late.s, late.t))['detail'])).toMatch(/RESULT_MISSING/);
  });

  it('a launch nobody recorded (no plugin hook) proves nothing: the settle is judged as before', async () => {
    const s = await createShop();
    const t = await dispatch(s);
    const host = claudeSession(s.root);
    await launchAgent(host, { subagent_type: WORKER, description: t.node_id, prompt: t.prompt }, { hook: false });
    expect(String((await settle(s, t))['detail'])).toMatch(/RESULT_MISSING/);
  });

  it('a worker launch whose host session ended is no running worker', async () => {
    const { s, t, agent } = await launched();
    const file = join(s.control, '.mycelink', 'launches', SHOP_FEATURE, t.dispatch_id as string, `launch-${agent.toolUseId}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    // A holder on this host that cannot be alive: a pid no process has, with a start time no process has.
    writeFileSync(file, JSON.stringify({ ...record, holder: { pid: 2147483646, start: 'never', host: hostname(), platform: process.platform, boot: null } }));
    expect(String((await settle(s, t))['detail'])).toMatch(/RESULT_MISSING/);
  });
});

describe('integration-lock contention is no failure of the worker', () => {
  it('a verified, sealed submission whose integration lock another process holds is held, not charged; the next dispatch finishes it DONE', async () => {
    const s = await createShop();
    const t = await dispatch(s);
    const before = node(s, ERRORS);
    fulfil(t, { ...SHOP_WORK[ERRORS]!, criteria: SHOP_CRITERIA[ERRORS]!.map((c) => ({ criterion: c.criterion, gate: c.gate, full_name: c.name })) }, s.control);
    // Another live process holds the repository's integration lock (a concurrent settle): it outlasts the 30 s wait.
    const lock = join(s.featureDir, 'integration', 'shop.lock');
    mkdirSync(join(s.featureDir, 'integration'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: 'another-settle', acquired_at: new Date().toISOString(), purpose: 'integration' }));
    const r = await settle(s, t);
    expect(r, r['detail']).toMatchObject({ outcome: 'PRECONDITION_FAILED' });
    expect(r['detail']).toMatch(/lock/i);
    expect(node(s, ERRORS)).toMatchObject({ attempts: before.attempts, failure_counts: before.failure_counts, claim: { claim_id: t.claim_id } });
    rmSync(lock, { force: true });
    const d = JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as Record<string, any>;
    expect(JSON.stringify(d)).toMatch(/"outcome":"DONE"/);
    expect(node(s, ERRORS)).toMatchObject({ state: 'DONE', attempts: before.attempts, failure_counts: before.failure_counts });
  }, 120_000);
});
