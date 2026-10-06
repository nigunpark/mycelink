/**
 * Interruption and orphan recovery where claims are concerned (item 11).
 *
 * Mycelink is crash-only: whatever a killed host, controller or settle
 * leaves behind must be recoverable from STATE.json, and reconcile must tell
 * an abandoned dispatch (an infrastructure event) from a failed task.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll } from '../helpers/git-fixture.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { CORE, WORK, cli, dispatch, hostGraph, hostPortfolio, settle } from '../helpers/host-loop.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { listLeases } from '../../src/resources/leases.js';
import { recordSpawn } from '../../src/sessions/registry.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { branchExists } from '../../src/git/git.js';
import { workerBranchName } from '../../src/git/worktree.js';

afterAll(() => cleanupTmpRoots());

interface Reconciled {
  pending_dispatches: { node_id: string; result_present: boolean }[];
  abandoned_dispatches: string[];
  interrupted_settles: string[];
  releasedNodes: string[];
  orphanedSessions: string[];
}

async function reconcile(p: Portfolio, extra: string[] = []): Promise<Reconciled> {
  const r = await cli(p, ['session', 'reconcile', FEATURE_ID, '--json', ...extra]);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as Reconciled;
}

function expire(p: Portfolio, nodeId: string): void {
  mutateState(p.featureDir, (s) => {
    s.nodes[nodeId]!.claim!.expires_at = new Date(Date.now() - 1000).toISOString();
    return s;
  });
}

describe('reconcile host dispatch', () => {
  it('keeps a live dispatch pending and lets the host resume it after losing the ticket', async () => {
    const p = await hostPortfolio();
    await dispatch(p); // the host is interrupted here and never sees the ticket again
    const rec = await reconcile(p);
    expect(rec.pending_dispatches).toEqual([{ node_id: CORE, result_present: false, expired: false, claim_id: expect.any(String) }]);
    expect(rec.abandoned_dispatches).toEqual([]);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim).not.toBeNull();

    const resumed = (await dispatch(p, ['--resume', CORE])).ticket!;
    fakeAgent(resumed, WORK[CORE]!, p.control);
    expect(await settle(p, CORE, resumed.capability)).toMatchObject({ outcome: 'DONE' });
  });

  it('abandons an expired dispatch as an interruption, not a task failure', async () => {
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    expire(p, CORE);
    const rec = await reconcile(p);
    expect(rec.abandoned_dispatches).toEqual([CORE]);
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt).toMatchObject({ state: 'READY', attempts: 0, failure_counts: {}, interruptions: 1, claim: null, blocked_reason: null });
    expect(listLeases(p.featureDir)).toEqual([]);
    expect(branchExists(p.core, workerBranchName(FEATURE_ID, CORE))).toBe(true);

    // The abandoned capability is dead; the node is simply dispatched again.
    expect((await cli(p, ['settle', FEATURE_ID, CORE, '--capability', t.capability])).err).toMatch(/NOT_CLAIMED|CAPABILITY_INVALID/);
    const again = (await dispatch(p)).ticket!;
    expect(again).toMatchObject({ node_id: CORE, attempt: 1 });
  });

  it('--abandon-dispatches abandons at once; an expired dispatch with a result is kept for settling', async () => {
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control);
    expire(p, CORE);
    const kept = await reconcile(p);
    expect(kept.abandoned_dispatches).toEqual([]);
    expect(kept.pending_dispatches).toEqual([expect.objectContaining({ node_id: CORE, result_present: true })]);

    const forced = await reconcile(p, ['--abandon-dispatches']);
    expect(forced.abandoned_dispatches).toEqual([CORE]);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('READY');
  });

  it('a node interrupted again and again is parked, so recovery cannot loop forever', async () => {
    const p = await hostPortfolio();
    await dispatch(p);
    mutateState(p.featureDir, (s) => {
      s.nodes[CORE]!.interruptions = 3;
      return s;
    });
    const rec = await reconcile(p, ['--abandon-dispatches']);
    expect(rec.abandoned_dispatches).toEqual([CORE]);
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).toBe('BLOCKED');
    expect(rt.blocked_reason).toMatch(/interrupted 4 times/);
    expect(rt.failure_counts).toEqual({});
  });

  it('an orphaned adapter session is an interruption too, not a BLOCKED task', async () => {
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    mutateState(p.featureDir, (s) => {
      s.nodes[CORE]!.claim!.mode = 'adapter';
      return s;
    });
    recordSpawn(featurePaths(p.control, FEATURE_ID).sessionsRegistry, {
      session_id: 'sess-dead',
      adapter: 'claude-background',
      pid: 2 ** 22 + 12345,
      node_id: CORE,
      claim_id: t.claim_id,
      started_at: new Date().toISOString(),
      log_path: 'x.log',
      result_path: 'x.json',
    }, { featureId: FEATURE_ID, repository: 'core', worktree: t.worktree, branch: t.branch, attempt: 1 });
    const rec = await reconcile(p);
    expect(rec.orphanedSessions).toEqual(['sess-dead']);
    expect(rec.releasedNodes).toEqual([CORE]);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!).toMatchObject({ state: 'READY', attempts: 0, interruptions: 1, failure_counts: {} });
  });
});

describe('an interrupted settle is recoverable', () => {
  it('a settle killed mid-verification leaves a marker reconcile clears; settling again completes', async () => {
    // A verifier that is slow only when SLOW=1, so the first settle can be
    // caught mid-verification and killed.
    const graph = hostGraph() as { nodes: { id: string; verification_commands: unknown[] }[] };
    graph.nodes.find((n) => n.id === CORE)!.verification_commands = [{ id: 'targeted', command: ['node', 'tests/slow-run.mjs'] }];
    const p = await hostPortfolio(graph);
    writeFileSync(
      join(p.core, 'tests', 'slow-run.mjs'),
      "if (process.env.SLOW === '1') await new Promise((r) => setTimeout(r, 60000));\nawait import('./run.mjs');\n",
    );
    commitAll(p.core, 'slow wrapper');

    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control);

    const child = spawn(process.execPath, [p.mycelink, 'settle', FEATURE_ID, CORE, '--capability', t.capability, '--control-root', p.control], {
      env: { ...process.env, SLOW: '1' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !loadState(p.featureDir)!.data.nodes[CORE]!.claim?.settling) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const marker = loadState(p.featureDir)!.data.nodes[CORE]!.claim?.settling;
    expect(marker).toMatchObject({ pid: child.pid, host: hostname() });
    // Give the settle time to enter fresh verification, then kill it hard.
    await new Promise((r) => setTimeout(r, 1500));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    const rec = await reconcile(p);
    expect(rec.interrupted_settles).toEqual([CORE]);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.settling ?? null).toBeNull();

    // The result was already captured by the killed settle or is still in
    // the slot; either way the same capability settles the node now.
    const done = await cli(p, ['settle', FEATURE_ID, CORE, '--capability', t.capability, '--json']);
    const report = JSON.parse(done.out) as { outcome: string; detail: string };
    expect(`${report.outcome}: ${report.detail}`).toMatch(/^DONE/);
    const copies = readdirSync(join(p.featureDir, 'sessions', CORE)).filter((f) => /^result\..*\.json$/.test(f));
    expect(copies.length).toBe(1);
    expect(readFileSync(join(p.featureDir, 'STATE.json'), 'utf8')).not.toContain(t.capability);
  });
});
