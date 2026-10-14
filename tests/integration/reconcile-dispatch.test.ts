/**
 * Interruption and orphan recovery where claims are concerned (item 11).
 *
 * Mycelink is crash-only: whatever a killed host, controller or settle
 * leaves behind must be recoverable from STATE.json, and reconcile must tell
 * an abandoned dispatch (an infrastructure event) from a failed task.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { CORE, WORK, cli, dispatch, hostPortfolio, settle } from '../helpers/host-loop.js';
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
    expect(rec.pending_dispatches).toEqual([{ node_id: CORE, result_present: false, expired: false, claim_id: expect.any(String), state: 'CLAIMED', settlement: 'none' }]);
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
    const dead = await cli(p, ['settle', FEATURE_ID, CORE, '--capability', t.capability, '--json']);
    expect(dead.code).not.toBe(0);
    expect(JSON.parse(dead.out)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', stale: { status: 'abandoned' } });
    expect(loadState(p.featureDir)!.data.nodes[CORE]).toMatchObject({ state: 'READY', attempts: 0, claim: null });
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
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control);

    // Killed at the boundary itself, never after a guessed wait: MYCELINK_CRASH_AT ends the settling process the
    // moment its fresh verification has run the targeted verifiers, before the regression. A fixed sleep after the
    // marker fell inside the capture on a slow runner (CI 38510332461), before any result was the controller's.
    const child = spawn(process.execPath, [p.mycelink, 'settle', FEATURE_ID, CORE, '--capability', t.capability, '--control-root', p.control, '--json'], {
      env: { ...process.env, MYCELINK_CRASH_AT: 'fresh-targeted' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let printed = '';
    child.stdout.on('data', (chunk) => (printed += chunk));
    await new Promise((r) => child.once('close', r));
    // It died there: no report, its marker left naming it, the result captured, the targeted run recorded, not the regression.
    expect(printed).toBe('');
    const killed = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(killed.claim?.settling).toMatchObject({ pid: child.pid, host: hostname() });
    expect(killed.claim).toMatchObject({ result_captured_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), capture_pending: null });
    expect(killed.last_settlement).toMatchObject({ outcome: 'PENDING' });
    const evidence = readdirSync(join(p.featureDir, 'evidence', CORE));
    expect(evidence.some((n) => n.startsWith('fresh-targeted.'))).toBe(true);
    expect(evidence.some((n) => n.startsWith('fresh-regression.'))).toBe(false);

    const rec = await reconcile(p);
    expect(rec.interrupted_settles).toEqual([CORE]);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.settling ?? null).toBeNull();
    // Killed mid-verification, after the result was captured: the controller holds it, so
    // dispatch (or dispatch --resume) finishes this settlement itself.
    expect(rec.pending_dispatches).toEqual([expect.objectContaining({ node_id: CORE, result_present: true, settlement: 'held' })]);

    // The same capability settles the node now, from the result the killed settle captured.
    const done = await cli(p, ['settle', FEATURE_ID, CORE, '--capability', t.capability, '--json']);
    const report = JSON.parse(done.out) as { outcome: string; detail: string; idempotent: boolean };
    expect(`${report.outcome}: ${report.detail}`).toMatch(/^DONE/);
    expect(report.idempotent).toBe(false);
    // Settled once: nothing left settling, one copy of the result, one attempt, one settlement, the usage counted once.
    const once = () => {
      const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
      expect(rt).toMatchObject({ state: 'DONE', last_settlement: { outcome: 'DONE' } });
      expect(rt.claim?.settling ?? null).toBeNull();
      expect(rt.usage).toMatchObject({ sessions: 1, model_turns: 3, input_tokens: 300, output_tokens: 150 });
      expect(readdirSync(join(p.featureDir, 'sessions', CORE)).filter((f) => /^result\..*\.json$/.test(f)).length).toBe(1);
      const lines = (file: string) => readFileSync(join(p.featureDir, file), 'utf8').split('\n').filter((l) => l.includes(`"node_id":"${CORE}"`));
      expect(lines('RUNS.jsonl').length).toBe(1);
      expect(lines('events.jsonl').filter((l) => l.includes('"type":"node.settled"')).length).toBe(1);
    };
    once();
    // Presented again, the capability is answered from the receipt: nothing is settled twice.
    const replay = await cli(p, ['settle', FEATURE_ID, CORE, '--capability', t.capability, '--json']);
    expect(JSON.parse(replay.out)).toMatchObject({ outcome: 'DONE', idempotent: true });
    once();
    expect(readFileSync(join(p.featureDir, 'STATE.json'), 'utf8')).not.toContain(t.capability);
  });
});
