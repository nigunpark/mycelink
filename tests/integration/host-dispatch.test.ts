/**
 * Host-native dispatch (R1): `dispatch` hands the host a ticket, the host's
 * Agent tool does the work, `settle` takes the result back.
 *
 * Nothing here spawns a worker process: in the eval sandbox the nested
 * `claude` executable could not be started at all, so the primary path must
 * not depend on one.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type AgentBehaviour, type DispatchTicket } from '../helpers/host-agent.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { loadState } from '../../src/state/feature-state.js';
import { loadRegistry } from '../../src/sessions/registry.js';
import { featurePaths } from '../../src/workspace/paths.js';

afterAll(() => cleanupTmpRoots());

const CORE = `${FEATURE_ID}.core.publish.impl`;
const API = `${FEATURE_ID}.api.consume.impl`;
const WEB = `${FEATURE_ID}.web.render.impl`;
const CANDIDATE = `${FEATURE_ID}.release.candidate.build`;

export const WORK: Record<string, AgentBehaviour> = {
  [CORE]: { impl: { 'src/publish.js': 'export const JOB_RESULT_V2 = true;\n' } },
  [API]: { impl: { 'src/consume.js': 'export const JOB_RESULT_V2 = true;\n' } },
  [WEB]: { impl: { 'src/view.js': 'export const RENDER_JOB_RESULT = true;\n' } },
};

interface Run {
  code: number;
  out: string;
  err: string;
}

async function cli(p: Portfolio, argv: string[]): Promise<Run> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await main([...argv, '--control-root', p.control], io);
  return { code, out, err };
}

interface DispatchOut {
  status: string;
  ticket?: DispatchTicket;
  controller_reports: { node_id: string; outcome: string }[];
  pending: { node_id: string }[];
}

async function dispatch(p: Portfolio, extra: string[] = []): Promise<DispatchOut> {
  const r = await cli(p, ['dispatch', FEATURE_ID, '--json', ...extra]);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as DispatchOut;
}

async function settle(p: Portfolio, nodeId: string, capability: string): Promise<{ code: number; report: Record<string, unknown>; err: string }> {
  const r = await cli(p, ['settle', FEATURE_ID, nodeId, '--capability', capability, '--json']);
  return { code: r.code, report: r.out.trim() ? (JSON.parse(r.out) as Record<string, unknown>) : {}, err: r.err };
}

/** The fixture graph without the browser E2E node (covered elsewhere). */
function graph(): Record<string, unknown> {
  const g = portfolioGraph() as { nodes: { node_type: string }[] };
  g.nodes = g.nodes.filter((n) => n.node_type !== 'e2e-scenario');
  return g;
}

async function setup(): Promise<Portfolio> {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(graph(), { lineWidth: 0 }));
  // The standalone adapter is pointed at something that cannot run: the host
  // path must not need it.
  const configPath = join(p.control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, session_adapter: 'claude-background', claude_executable: join(p.root, 'no-such-claude') }, null, 2),
  );
  expect((await cli(p, ['feature', 'init', FEATURE_ID])).code).toBe(0);
  commitControl(p, 'feature scaffolding');
  return p;
}

describe('host dispatch protocol', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await setup();
  });

  it('emits a complete ticket for the first READY node and spawns nothing', async () => {
    const d = await dispatch(p);
    expect(d.status).toBe('DISPATCHED');
    const t = d.ticket!;
    expect(t).toMatchObject({
      schema: 'mycelink-dispatch-ticket/1',
      feature_id: FEATURE_ID,
      node_id: CORE,
      attempt: 1,
      agent: 'mycelink:module-worker',
      repository: 'core',
      allowed_paths: ['src/**', 'tests/**'],
    });
    expect(t.capability).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(t.worktree!)).toBe(true);
    expect(t.result_slot).toBe(join(t.worktree!, '.mycelink-worker', 'result.json'));
    expect(t.verification_commands).toEqual([{ id: 'targeted', command: ['node', 'tests/run.mjs'] }]);
    expect(t.gate_commands.map((g) => g.gate)).toEqual(['red', 'green', 'regression']);
    for (const g of t.gate_commands) expect(g.command).toContain(`--capability ${t.capability}`);
    expect(t.settle_command).toContain(`settle ${FEATURE_ID} ${CORE}`);

    // The prompt is bounded and carries everything the subagent needs.
    expect(Buffer.byteLength(t.prompt)).toBeLessThanOrEqual(48 * 1024);
    expect(t.prompt).toContain(t.worktree!.replace(/\\/g, '/'));
    expect(t.prompt).toContain(t.result_slot.replace(/\\/g, '/'));
    expect(t.prompt).toContain('<mycelink-context-pack>');

    // Nothing was spawned, and the raw capability was not persisted.
    const paths = featurePaths(p.control, FEATURE_ID);
    expect(Object.keys(loadRegistry(paths.sessionsRegistry).sessions)).toEqual([]);
    expect(loadState(p.featureDir)!.data.usage.sessions).toBe(0);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.mode).toBe('host');
    for (const file of ['STATE.json', 'events.jsonl', join('context-packs', `${CORE}.json`)]) {
      expect(readFileSync(join(p.featureDir, file), 'utf8')).not.toContain(t.capability);
    }
  });

  it('does not hand out a node that is already dispatched; dependents wait', async () => {
    await dispatch(p);
    const again = await dispatch(p);
    expect(again.status).toBe('WAITING');
    expect(again.ticket).toBeUndefined();
    expect(again.pending.map((x) => x.node_id)).toEqual([CORE]);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.attempts).toBe(1);
  });

  it('settles a fulfilled ticket through fresh verification to DONE and makes dependents ready', async () => {
    const t = (await dispatch(p)).ticket!;
    const run = fakeAgent(t, WORK[CORE]!, p.control);
    expect(run.gates).toEqual([
      { gate: 'red', exit: 0 },
      { gate: 'green', exit: 0 },
      { gate: 'regression', exit: 0 },
    ]);
    const s = await settle(p, CORE, t.capability);
    expect(s.err).toBe('');
    expect(s.code).toBe(0);
    expect(s.report).toMatchObject({ node_id: CORE, outcome: 'DONE', state: 'DONE', idempotent: false });
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).toBe('DONE');
    expect(rt.claim).toBeNull();
    expect(rt.integrated_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(rt.usage.sessions).toBe(1);

    const next = await dispatch(p);
    expect(next.status).toBe('DISPATCHED');
    expect(next.ticket!.node_id).toBe(API);
  });

  it('fails closed on a wrong, stale or foreign capability and changes nothing', async () => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control);
    for (const cap of ['0'.repeat(64), 'not-hex', t.capability.slice(0, 63) + (t.capability.endsWith('a') ? 'b' : 'a')]) {
      const s = await settle(p, CORE, cap);
      expect(s.code).not.toBe(0);
      expect(s.err).toMatch(/CAPABILITY_INVALID/);
    }
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('REGRESSION_VERIFIED');
    // The worker's result is still in its slot, untouched by the refusals.
    expect(existsSync(t.result_slot)).toBe(true);
  });

  it('never persists the capability, even when the worker echoes its gate lines in the result', async () => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(
      t,
      { ...WORK[CORE]!, resultOverrides: { commands: t.gate_commands.map((g) => ({ command: [g.command], exit_code: 0 })), notes: t.capability } },
      p.control,
    );
    expect((await settle(p, CORE, t.capability)).code).toBe(0);
    for (const file of ['STATE.json', 'events.jsonl', 'RUNS.jsonl', join('sessions', CORE, 'result.attempt-1.json')]) {
      const full = join(p.featureDir, file);
      expect(`${file}:${existsSync(full)}`).toBe(`${file}:true`);
      expect(readFileSync(full, 'utf8')).not.toContain(t.capability);
    }
  });

  it('answers a duplicate settle from its receipt', async () => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control);
    expect((await settle(p, CORE, t.capability)).code).toBe(0);
    const again = await settle(p, CORE, t.capability);
    expect(again.code).toBe(0);
    expect(again.report).toMatchObject({ outcome: 'DONE', idempotent: true });
  });

  it('treats a missing result as a failed attempt, not as success', async () => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, { ...WORK[CORE]!, omitResult: true }, p.control);
    const s = await settle(p, CORE, t.capability);
    expect(s.code).not.toBe(0);
    expect(String(s.report['detail'])).toMatch(/RESULT_MISSING/);
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).toBe('READY');
    expect(rt.failure_counts['RESULT_MISSING']).toBe(1);
  });

  it('refuses a result naming another claim, and a result slot swapped for a link', async (ctx) => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, { ...WORK[CORE]!, resultOverrides: { claim_id: 'someone-else' } }, p.control);
    const s = await settle(p, CORE, t.capability);
    expect(String(s.report['detail'])).toMatch(/RESULT_IDENTITY_MISMATCH/);

    const t2 = (await dispatch(p)).ticket!;
    expect(t2.node_id).toBe(CORE);
    const outside = join(p.root, 'outside-slot');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'result.json'), JSON.stringify({ schema_version: 1, node_id: CORE, claim_id: t2.claim_id, outcome: 'SUBMITTED', commands: [], evidence_paths: [] }));
    rmSync(dirname(t2.result_slot), { recursive: true, force: true });
    try {
      symlinkSync(outside, dirname(t2.result_slot), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      ctx.skip();
    }
    const s2 = await settle(p, CORE, t2.capability);
    expect(String(s2.report['detail'])).toMatch(/RESULT_PATH_ESCAPE/);
    expect(existsSync(join(outside, 'result.json'))).toBe(true);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).not.toBe('DONE');
  });

  it('ignores a forged controller copy of the result: only what settle itself captured counts', async () => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, { ...WORK[CORE]!, omitResult: true }, p.control);
    // The worker writes straight into the controller's session directory
    // instead of its slot, with the (public) claim id and the capability.
    const forged = join(p.featureDir, 'sessions', CORE, 'result.attempt-1.json');
    mkdirSync(dirname(forged), { recursive: true });
    writeFileSync(
      forged,
      JSON.stringify({ schema_version: 1, node_id: CORE, claim_id: t.claim_id, outcome: 'BLOCKED', commands: [{ command: [t.capability], exit_code: 0 }], evidence_paths: [], failure_fingerprint: 'forged' }),
    );
    const s = await settle(p, CORE, t.capability);
    expect(String(s.report['detail'])).toMatch(/RESULT_MISSING/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('READY');
    expect(readFileSync(join(p.featureDir, 'RUNS.jsonl'), 'utf8')).not.toContain(t.capability);
  });

  it('a worker that only claims success is not believed', async () => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, { skipGates: true, impl: {}, outcome: 'SUBMITTED' }, p.control);
    const s = await settle(p, CORE, t.capability);
    expect(s.code).not.toBe(0);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).not.toBe('DONE');
  });

  it('parks the node on BLOCKED and NEEDS_DECISION results', async () => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(
      t,
      { skipGates: true, outcome: 'NEEDS_DECISION', decision_request: { question: 'v2 or v3?', options: ['v2', 'v3'] } },
      p.control,
    );
    const s = await settle(p, CORE, t.capability);
    expect(s.report).toMatchObject({ outcome: 'NEEDS_DECISION' });
    const state = loadState(p.featureDir)!.data;
    expect(state.nodes[CORE]!.state).toBe('NEEDS_DECISION');
    expect(state.pending_decisions.length).toBe(1);
    expect((await dispatch(p)).status).toBe('NEEDS_DECISION');
  });

  it('rotates the capability on --resume; the old one stops working', async () => {
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control);
    const resumed = await dispatch(p, ['--resume', CORE]);
    expect(resumed.status).toBe('DISPATCHED');
    const r = resumed.ticket!;
    expect(r).toMatchObject({ node_id: CORE, claim_id: t.claim_id, resumed: true, result_present: true });
    expect(r.capability).not.toBe(t.capability);
    expect((await settle(p, CORE, t.capability)).err).toMatch(/CAPABILITY_INVALID/);
    expect((await settle(p, CORE, r.capability)).report).toMatchObject({ outcome: 'DONE' });
    // A rotated-away capability never becomes valid again, not even as a receipt.
    expect((await settle(p, CORE, t.capability)).err).toMatch(/CAPABILITY_INVALID|NOT_CLAIMED/);
  });

  it('runs controller nodes inline and drives the whole feature with tickets', async () => {
    for (let i = 0; i < 10; i++) {
      const d = await dispatch(p);
      if (d.status === 'ALL_SETTLED') break;
      expect(`${d.status}: ${(d as { detail?: string }).detail}`).toMatch(/^DISPATCHED/);
      const t = d.ticket!;
      fakeAgent(t, WORK[t.node_id]!, p.control);
      expect((await settle(p, t.node_id, t.capability)).report['outcome']).toBe('DONE');
    }
    const state = loadState(p.featureDir)!.data;
    for (const id of [CORE, API, WEB, CANDIDATE]) expect(`${id}=${state.nodes[id]!.state}`).toBe(`${id}=DONE`);
    expect(state.current_candidate).toBe(`${FEATURE_ID}-C001`);
    expect((await cli(p, ['feature', 'verify', FEATURE_ID])).code).toBe(0);
  });

  it('dispatch and settle are refused to a worker for controller roles where they apply', async () => {
    const t = (await dispatch(p)).ticket!;
    const r = await cli(p, ['dispatch', FEATURE_ID, '--capability', t.capability]);
    expect(r.err).toMatch(/ROLE_DENIED/);
  });
});
