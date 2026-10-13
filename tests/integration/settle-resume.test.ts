/**
 * A settle killed at any boundary is finished by a fresh host session, and
 * the feature is delivered.
 *
 * Second PCM-101 pilot, with-faults arm: the host session was killed (the
 * fault plan's interrupt) while `settle` of the gateway node was running
 * its fresh verification. STATE.json kept the node at REGRESSION_VERIFIED
 * with its claim, the captured result, a settle marker naming pid 5853 and
 * a PENDING receipt; the visits node was DONE; no candidate, no delivery.
 * The resumed session had no controller key and no ticket capability, asked
 * a user who was not there, and exited 0 after 18.5 s.
 *
 * Here every boundary of a settle is crossed by killing the settling CLI
 * process there (MYCELINK_CRASH_AT), then killing its host session. A fresh
 * host session recovers controller authority, reconciles, and the ordinary
 * host loop finishes the interrupted settlement inside `dispatch` without
 * re-running the worker or needing the lost capability, dispatches the
 * rest, builds the candidate and delivers. Usage is counted once, the node
 * is integrated once, and a replay of the lost capability changes nothing.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { FEATURE_ID, commitControl, createPortfolio, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { CANDIDATE, CORE, WORK, hostGraph } from '../helpers/host-loop.js';
import { FakeHost } from '../helpers/fake-host.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { loadCandidate } from '../../src/git/candidate.js';
import { integrationBranchName, workerBranchName } from '../../src/git/worktree.js';

afterAll(() => cleanupTmpRoots());

const hosts: FakeHost[] = [];
const hostsCleanup: (() => void)[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.kill();
  for (const done of hostsCleanup.splice(0)) done();
});

async function host(): Promise<FakeHost> {
  const h = await FakeHost.start();
  hosts.push(h);
  return h;
}

interface Dispatched {
  status: string;
  detail: string;
  ticket?: DispatchTicket;
  settled?: { node_id: string; outcome: string; state: string; idempotent: boolean };
  controller_reports: { node_id: string; outcome: string; state: string }[];
}

async function json<T>(h: FakeHost, argv: string[], env: Record<string, string> = {}): Promise<{ code: number | null; err: string; out: T | null }> {
  const r = await h.run(argv, { env });
  let out: T | null = null;
  try {
    out = JSON.parse(r.out) as T;
  } catch {
    out = null;
  }
  return { code: r.code, err: r.err, out };
}

/** A committed control repository whose first key host `a` opened, the feature initialised. */
async function setup(a: FakeHost): Promise<{ p: Portfolio; key: string }> {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(hostGraph(), { lineWidth: 0 }));
  const configPath = join(p.control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, session_adapter: 'claude-background', claude_executable: join(p.root, 'no-such-claude') }, null, 2) + '\n');
  commitControl(p, 'control plane');
  const opened = await json<{ authority: string }>(a, ['controller', 'open', '--control-root', p.control, '--json']);
  const key = opened.out!.authority;
  expect((await a.run(['feature', 'init', FEATURE_ID, '--control-root', p.control, '--authority', key])).code).toBe(0);
  commitControl(p, 'feature initialised');
  return { p, key };
}

/** The first session: dispatch CORE, the worker fulfils it, the settle is killed at `point`, then the session dies. */
async function interrupted(point: string): Promise<{ p: Portfolio; ticket: DispatchTicket }> {
  const a = await host();
  const { p, key } = await setup(a);
  const d = await json<Dispatched>(a, ['dispatch', FEATURE_ID, '--control-root', p.control, '--authority', key, '--json']);
  const ticket = d.out!.ticket!;
  expect(ticket.node_id).toBe(CORE);
  fakeAgent(ticket, WORK[CORE]!, p.control);
  const s = await a.run(['settle', FEATURE_ID, CORE, '--control-root', p.control, '--capability', ticket.capability, '--json'], { env: { MYCELINK_CRASH_AT: point } });
  // Killed at the boundary: no report.
  expect(`${point}: ${s.out.trim() === '' ? 'no report' : 'report'}`).toBe(`${point}: no report`);
  await a.kill();
  return { p, ticket };
}

/** A fresh host session: recover authority, reconcile, run the host loop to delivery. */
async function resume(p: Portfolio, options: { resumeNode?: string } = {}): Promise<{ key: string; dispatches: Dispatched[]; delivered: Record<string, unknown> }> {
  const b = await host();
  const recovered = await json<{ authority: string; recovered: boolean }>(b, ['controller', 'open', '--recover', '--control-root', p.control, '--json']);
  expect(recovered.err).toBe('');
  const key = recovered.out!.authority;
  const ctl = (argv: string[]) => [...argv, '--control-root', p.control, '--authority', key, '--json'];
  expect((await b.run(ctl(['session', 'reconcile', FEATURE_ID]))).code).toBe(0);
  const dispatches: Dispatched[] = [];
  if (options.resumeNode !== undefined) {
    const r = await json<Dispatched>(b, ctl(['dispatch', FEATURE_ID, '--resume', options.resumeNode]));
    expect(r.err).toBe('');
    dispatches.push(r.out!);
  }
  for (let i = 0; i < 10; i++) {
    const r = await json<Dispatched>(b, ctl(['dispatch', FEATURE_ID]));
    expect(r.err).toBe('');
    dispatches.push(r.out!);
    if (r.out!.status !== 'DISPATCHED') break;
    const t = r.out!.ticket!;
    fakeAgent(t, WORK[t.node_id]!, p.control);
    const s = await json<{ outcome: string }>(b, ['settle', FEATURE_ID, t.node_id, '--control-root', p.control, '--capability', t.capability, '--json']);
    expect(s.out).toMatchObject({ outcome: 'DONE' });
  }
  expect(dispatches.at(-1)!.status).toBe('ALL_SETTLED');
  commitControl(p, 'settled');
  const delivered = await json<Record<string, unknown>>(b, ctl(['deliver', FEATURE_ID]));
  expect(delivered.err).toBe('');
  return { key, dispatches, delivered: delivered.out! };
}

function stateDigest(p: Portfolio): string {
  const doc = JSON.parse(readFileSync(join(p.featureDir, 'STATE.json'), 'utf8')) as { data: { updated_at?: string } };
  const { updated_at: _u, ...rest } = doc.data;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

async function assertDelivered(p: Portfolio, ticket: DispatchTicket, delivered: Record<string, unknown>): Promise<void> {
  const state = loadState(p.featureDir)!.data;
  for (const [id, rt] of Object.entries(state.nodes)) expect(`${id}=${rt.state}`).toBe(`${id}=DONE`);
  expect(state.current_candidate).toBe(`${FEATURE_ID}-C001`);
  expect(delivered).toMatchObject({ status: 'ACCEPTED', candidate_id: `${FEATURE_ID}-C001` });
  expect(state.feature_state).toBe('COMPLETED');
  const candidate = loadCandidate(p.featureDir, state.current_candidate!);
  for (const [name, repo] of [['core', p.core], ['api', p.api], ['web', p.app]] as const) {
    expect(`${name}@${git(repo, ['rev-parse', 'main'])}`).toBe(`${name}@${candidate.repositories[name]!.sha}`);
  }
  // CORE: integrated once, exactly the history its worker submitted and settle judged.
  const core = state.nodes[CORE]!;
  expect(git(p.core, ['rev-parse', integrationBranchName(FEATURE_ID)])).toBe(core.integrated_sha);
  expect(core.integrated_sha).toBe(git(p.core, ['rev-parse', workerBranchName(FEATURE_ID, CORE)]));
  expect(core.tdd_history).toMatchObject({ ok: true, cycles: 1 });
  // The worker's usage, counted exactly once.
  expect(core.usage).toMatchObject({ sessions: 1, model_turns: 3, input_tokens: 300, output_tokens: 150 });
  const runs = readFileSync(join(p.featureDir, 'RUNS.jsonl'), 'utf8').split('\n').filter((l) => l.includes(`"node_id":"${CORE}"`));
  expect(runs.length).toBe(1);
  // The lost capability, replayed: an explicit refusal or the stored receipt, and no effect.
  const before = stateDigest(p);
  const replay = await (await host()).run(['settle', FEATURE_ID, CORE, '--control-root', p.control, '--capability', ticket.capability, '--json']);
  if (replay.out.trim() !== '') expect(JSON.parse(replay.out)).toMatchObject({ idempotent: true });
  else expect(replay.err).toMatch(/^(NOT_CLAIMED|CAPABILITY_INVALID): /m);
  expect(stateDigest(p)).toBe(before);
}

const BOUNDARIES = [
  'result-captured',
  'result-attested',
  'history-sealed',
  'fresh-targeted',
  'fresh-verified',
  'gates-advanced',
  'integration-journaled',
  'integration-moved',
  'integrated',
  'attempt-concluded',
];

describe('a settle killed at any boundary is finished by a fresh host session', () => {
  for (const point of BOUNDARIES) {
    it(`killed at ${point}: recovered, finished in dispatch, delivered`, async () => {
      const { p, ticket } = await interrupted(point);
      const { dispatches, delivered } = await resume(p);
      // The interrupted settlement was finished by the controller, not re-dispatched.
      const ticketsForCore = dispatches.filter((d) => d.ticket?.node_id === CORE);
      expect(ticketsForCore).toEqual([]);
      const resumed = dispatches.flatMap((d) => d.controller_reports).filter((r) => r.node_id === CORE);
      expect(resumed.map((r) => r.outcome)).toEqual(point === 'attempt-concluded' ? [] : ['DONE']);
      expect(dispatches.flatMap((d) => d.controller_reports).map((r) => r.node_id)).toContain(CANDIDATE);
      await assertDelivered(p, ticket, delivered);
      const events = readFileSync(join(p.featureDir, 'events.jsonl'), 'utf8');
      if (point !== 'attempt-concluded') expect(events).toContain('"type":"settlement.resumed"');
    });
  }

  it('the pilot artifact: REGRESSION_VERIFIED, a captured result, a dead settler marker from another PID namespace, a PENDING receipt — dispatch --resume finishes it', async () => {
    const { p, ticket } = await interrupted('fresh-targeted');
    // Rewrite the claim to exactly what the pilot's Mycelink left: no seal, and a marker with a bare
    // pid that, as in the resumed session's fresh PID namespace, now names another, younger process.
    const younger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    hostsCleanup.push(() => younger.kill('SIGKILL'));
    mutateState(p.featureDir, (s) => {
      const rt = s.nodes[CORE]!;
      const claim = rt.claim!;
      delete claim.seal;
      claim.settling = { pid: younger.pid!, host: hostname(), started_at: new Date(Date.now() - 10 * 60_000).toISOString() };
      return s;
    });
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).toBe('REGRESSION_VERIFIED');
    expect(rt.claim).toMatchObject({ result_captured_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), usage_counted_for: ticket.dispatch_id });
    expect(rt.last_settlement).toMatchObject({ outcome: 'PENDING', state: 'REGRESSION_VERIFIED' });
    const evidence = join(p.featureDir, 'evidence', CORE);
    expect(readdirSync(evidence).some((n) => /^fresh-targeted\.[0-9a-f]{16}\.log$/.test(n))).toBe(true);
    expect(readdirSync(evidence).some((n) => n.startsWith('fresh-regression.'))).toBe(false);

    const { dispatches, delivered } = await resume(p, { resumeNode: CORE });
    expect(dispatches[0]).toMatchObject({ status: 'SETTLED', settled: { node_id: CORE, outcome: 'DONE', state: 'DONE' } });
    expect(dispatches[0]!.ticket).toBeUndefined();
    await assertDelivered(p, ticket, delivered);
  });

  it('a host that died after its worker wrote the result, before any settle: dispatch --resume settles it, no new worker', async () => {
    const a = await host();
    const { p, key } = await setup(a);
    const d = await json<Dispatched>(a, ['dispatch', FEATURE_ID, '--control-root', p.control, '--authority', key, '--json']);
    const ticket = d.out!.ticket!;
    fakeAgent(ticket, WORK[CORE]!, p.control);
    await a.kill();
    const { dispatches, delivered } = await resume(p, { resumeNode: CORE });
    expect(dispatches[0]).toMatchObject({ status: 'SETTLED', settled: { node_id: CORE, outcome: 'DONE' } });
    await assertDelivered(p, ticket, delivered);
  });
});
