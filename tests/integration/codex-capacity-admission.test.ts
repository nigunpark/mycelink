import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexCliAdapter } from '../../src/sessions/codex-cli-adapter.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { canSchedule } from '../../src/scheduler/ready.js';
import type { SessionHandle, SessionObservation, SpawnRequest } from '../../src/sessions/adapter.js';
import type { GraphNode } from '../../src/model/types.js';
import { listLeases } from '../../src/resources/leases.js';
import { CORE, hostGraph, hostPortfolio } from '../helpers/host-loop.js';
import { FEATURE_ID } from '../helpers/portfolio-fixture.js';
import { git, headSha } from '../helpers/git-fixture.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { capacityLines, capacityMessage, rejectedCapacityStreams } from '../helpers/codex-capacity.js';

afterAll(() => cleanupTmpRoots());

async function setup(lines = capacityLines, fence = 'clean') {
  // hostGraph wraps portfolioGraph; the schema puts budgets on worker, not the node.
  const graph = hostGraph() as { nodes: GraphNode[] };
  graph.nodes.find((n) => n.id === CORE)!.worker.max_attempts = 1;
  const p = await hostPortfolio(graph);
  const linesPath = join(p.root, 'capacity-lines.json');
  writeFileSync(linesPath, JSON.stringify(lines));
  const adapter = new CodexCliAdapter({ executable: process.execPath, prefixArgs: [resolve('tests/fake-codex/capacity.mjs')] });
  const o = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID, adapter, preflight: () => ({ ok: true }) });
  let request!: SpawnRequest;
  let observation!: SessionObservation;
  let childHandle!: SessionHandle;
  let spawnState!: { claimId: string | undefined; attempts: number; status: string };
  let fenceApplied = false;
  let initialHead = '';
  let initialClaim = '';
  let generation = 0;
  const spawn = adapter.spawn.bind(adapter);
  vi.spyOn(adapter, 'spawn').mockImplementation((r) => {
    request = r;
    initialHead = headSha(r.cwd);
    const rt = o.state().nodes[CORE]!;
    initialClaim = rt.claim!.claim_id;
    generation = rt.lineage ?? 0;
    spawnState = { claimId: rt.claim?.claim_id, attempts: rt.attempts, status: git(r.cwd, ['status', '--porcelain']) };
    r.env = { ...r.env, FAKE_CODEX_CAPACITY_LINES: linesPath };
    r.maxWallClockMs = 5_000;
    r.stallMs = 5_000;
    childHandle = spawn(r);
    return childHandle;
  });
  const wait = adapter.wait.bind(adapter);
  vi.spyOn(adapter, 'wait').mockImplementation(async (handle) => {
    const obs = await wait(handle);
    observation = obs;
    if (fence === 'dirty') writeFileSync(join(request.cwd, 'untracked-capacity.txt'), 'changed');
    if (fence === 'head') git(request.cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'moved HEAD']);
    if (fence === 'claim') mutateState(p.featureDir, (s) => { s.nodes[CORE]!.claim!.claim_id = 'replacement-claim'; return s; });
    if (fence === 'generation') mutateState(p.featureDir, (s) => { s.nodes[CORE]!.lineage = generation + 1; return s; });
    fenceApplied = fence === 'claim'
      ? o.state().nodes[CORE]!.claim?.claim_id === 'replacement-claim'
      : fence === 'generation'
        ? o.state().nodes[CORE]!.lineage === generation + 1
        : fence === 'head'
          ? headSha(request.cwd) !== initialHead
          : fence === 'dirty'
            ? git(request.cwd, ['status', '--porcelain']).includes('untracked-capacity.txt')
            : true;
    return obs;
  });
  // runNode catches adapter exceptions. Assert here, outside that catch, so a
  // failed harness check cannot masquerade as a successful negative case.
  async function assertChildRun() {
    expect(adapter.spawn).toHaveBeenCalledTimes(1);
    expect(adapter.wait).toHaveBeenCalledTimes(1);
    expect(childHandle?.pid).toBeGreaterThan(0);
    expect(spawnState).toEqual({ claimId: request.claimId, attempts: 1, status: '' });
    expect(observation).toBeDefined();
    expect(observation).toMatchObject({ status: 'failed', exit_code: 1, result: null, timed_out: false });
    expect(observation.codex_evidence?.process_session_id).toBe(childHandle.session_id);
    // Process settlement ends the log stream without awaiting its flush.
    await vi.waitFor(() => {
      expect(readFileSync(request.logPath, 'utf8').trim().split(/\r?\n/)).toEqual(lines);
    });
    expect(existsSync(join(request.cwd, '.mycelink-worker/result.json'))).toBe(false);
    expect(fenceApplied).toBe(true);
  }
  return { p, o, adapter, assertChildRun, snapshot: () => ({ request, initialHead, initialClaim, generation, observation }) };
}

function noAcceptance(o: Orchestrator) {
  const rt = o.state().nodes[CORE]!;
  expect(rt.evidence).toEqual({});
  expect(rt.criteria ?? []).toEqual([]);
  expect(rt.criterion_ledger ?? []).toEqual([]);
  expect(rt.integrated_sha).toBeNull();
}

describe('native Codex capacity admission at runNode', () => {
  it('refunds only untouched current work and can schedule the same max_attempts=1 graph after recovery', async () => {
    const h = await setup();
    const graphBefore = readFileSync(join(h.p.featureDir, 'PORTFOLIO-GRAPH.yaml'), 'utf8');
    const report = await h.o.runNode(CORE);
    await h.assertChildRun();
    const { request, initialHead, initialClaim, generation } = h.snapshot();
    expect.soft(h.snapshot().observation.codex_evidence).toMatchObject({ terminal: 'failed', turns: 0, final: null, failure: { transient: true } });
    expect.soft(h.snapshot().observation).toMatchObject({ status: 'failed', exit_code: 1, result: null, turns: 0 });
    expect.soft(report.outcome).toBe('INFRASTRUCTURE_FAILURE');
    expect.soft(h.o.state().nodes[CORE]).toMatchObject({ state: 'READY', attempts: 0, claim: null, failure_counts: {}, blocked_reason: null });
    expect.soft(h.o.state().usage.sessions).toBe(0);
    const runs = join(h.p.featureDir, 'RUNS.jsonl');
    expect.soft(existsSync(runs) ? readFileSync(runs, 'utf8').trim() : '').toBe('');
    noAcceptance(h.o);
    expect(headSha(request.cwd)).toBe(initialHead);
    expect(git(request.cwd, ['status', '--porcelain'])).toBe('');
    expect(h.o.state().nodes[CORE]!.lineage ?? 0).toBe(generation);
    expect(listLeases(h.p.featureDir)).toEqual([]);
    expect(JSON.stringify({ report, state: loadState(h.p.featureDir)!.data })).not.toContain(capacityMessage);
    expect(readFileSync(join(h.p.featureDir, 'PORTFOLIO-GRAPH.yaml'), 'utf8')).toBe(graphBefore);
    expect.soft(canSchedule(h.o.graph(), h.o.state(), CORE, { writerConcurrency: 1 }).ok).toBe(true);
    // Provider recovery: a fresh controller claim must be possible without raising the graph budget.
    {
      // Only exercise recovery after the expected refund exists; otherwise
      // claim() throws ATTEMPTS_EXHAUSTED and obscures the semantic RED above.
      if (!canSchedule(h.o.graph(), h.o.state(), CORE, { writerConcurrency: 1 }).ok) return;
      const next = h.o.claim(CORE, { mode: 'adapter' });
      expect(next.claimId).not.toBe(initialClaim);
      expect(h.o.state().nodes[CORE]!.attempts).toBe(1);
      expect(h.o.codexClaimScope(CORE, initialClaim, next.capability, next.worktree!)).toBeNull();
      expect(headSha(next.worktree!)).toBe(initialHead);
    }
  });

  it.each(rejectedCapacityStreams)('does not refund %s', async (_name, lines) => {
    const h = await setup(lines);
    const report = await h.o.runNode(CORE);
    await h.assertChildRun();
    expect(['RETRY', 'BLOCKED']).toContain(report.outcome);
    expect(h.o.state().nodes[CORE]!.attempts).toBe(1);
    expect(h.o.state().nodes[CORE]!.interruptions ?? 0).toBe(0);
    noAcceptance(h.o);
    const persisted = JSON.stringify({ report, state: h.o.state() });
    expect(persisted).not.toContain(capacityMessage);
    expect(persisted).not.toContain('TOKEN-private-4839');
  });

  it.each(['dirty', 'head', 'claim', 'generation'])('refuses refund across the %s fence', async (fence) => {
    const h = await setup(capacityLines, fence);
    const report = await h.o.runNode(CORE);
    await h.assertChildRun();
    expect(['RETRY', 'BLOCKED']).toContain(report.outcome);
    const rt = h.o.state().nodes[CORE]!;
    expect(rt.attempts).toBe(1);
    expect(rt.interruptions ?? 0).toBe(0);
    // failAttempt transitions to READY/BLOCKED, clearing the claim. Its
    // presence before settlement is checked by assertChildRun above.
    if (fence === 'generation') expect(rt.lineage).toBe(h.snapshot().generation + 1);
    if (fence === 'head') expect(headSha(h.snapshot().request.cwd)).not.toBe(h.snapshot().initialHead);
    if (fence === 'dirty') expect(git(h.snapshot().request.cwd, ['status', '--porcelain'])).toContain('untracked-capacity.txt');
    noAcceptance(h.o);
  });
});
