/**
 * Cutting a candidate and making it current is serialized with delivery
 * and rework on the feature's delivery lock.
 *
 * Delivery reads current_candidate and rework clears it, each under
 * deliveries/deliver.lock; a candidate cut outside that lock could become
 * current in the middle of a delivery, or right after a rework reopened the
 * work it binds.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { API, CANDIDATE, CORE, WEB, WORK, cli, dispatch, hostLoop, hostPortfolio, settle } from '../helpers/host-loop.js';
import { asController } from '../helpers/authority.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { acquireLock, type LockHandle } from '../../src/state/process-lock.js';

afterAll(() => cleanupTmpRoots());

const BIN = resolve('bin', 'mycelink.mjs');

/** Hold the feature's delivery lock, as a running delivery or rework does. */
function holdDeliveryLock(p: Portfolio): LockHandle {
  const dir = join(p.featureDir, 'deliveries');
  mkdirSync(dir, { recursive: true });
  return acquireLock(join(dir, 'deliver.lock'), { purpose: 'test: delivery in progress' });
}

async function settleProducers(p: Portfolio): Promise<void> {
  for (const id of [CORE, API, WEB]) {
    const t = (await dispatch(p)).ticket!;
    expect(t.node_id).toBe(id);
    fakeAgent(t, WORK[id]!, p.control);
    expect(await settle(p, id, t.capability)).toMatchObject({ outcome: 'DONE' });
  }
}

function runCli(p: Portfolio, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...asController(argv, p.control), '--control-root', p.control], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => done({ code: code ?? 1, out, err }));
  });
}

describe('candidate creation holds the feature delivery lock', () => {
  it('`candidate create` does not change the current candidate while a delivery holds the lock', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    const before = loadState(p.featureDir)!.data;
    const lock = holdDeliveryLock(p);
    try {
      const r = await cli(p, ['candidate', 'create', FEATURE_ID]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('FEATURE_BUSY');
    } finally {
      lock.release();
    }
    const after = loadState(p.featureDir)!.data;
    expect(after.current_candidate).toBe(before.current_candidate);
    expect(after.candidates).toEqual(before.candidates);
    // Once the delivery is over, the same command cuts the next candidate.
    expect((await cli(p, ['candidate', 'create', FEATURE_ID])).code).toBe(0);
    expect(loadState(p.featureDir)!.data.candidates.length).toBe(before.candidates.length + 1);
  });

  it('the candidate node does not bind while the lock is held, and is handed back unspent', async () => {
    const p = await hostPortfolio();
    await settleProducers(p);
    const lock = holdDeliveryLock(p);
    let d;
    try {
      d = await dispatch(p);
    } finally {
      lock.release();
    }
    expect(d.status).not.toBe('ALL_SETTLED');
    expect(d.detail).toContain('FEATURE_BUSY');
    const s = loadState(p.featureDir)!.data;
    expect(s.current_candidate).toBeNull();
    expect(s.candidates).toEqual([]);
    expect(s.nodes[CANDIDATE]!.state).toBe('READY');
    expect(s.nodes[CANDIDATE]!.attempts).toBe(0);
    expect(Object.keys(s.nodes[CANDIDATE]!.failure_counts)).toEqual([]);
    // Afterwards it proceeds normally.
    expect((await dispatch(p)).status).toBe('ALL_SETTLED');
    expect(loadState(p.featureDir)!.data.current_candidate).not.toBeNull();
  });

  it('a `candidate create` waiting on the lock re-checks the work it binds once it has it', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    const before = loadState(p.featureDir)!.data;
    const lock = holdDeliveryLock(p);
    const pending = runCli(p, ['candidate', 'create', FEATURE_ID]);
    try {
      // The candidate command is now blocked on the lock (or not yet started).
      await new Promise((r) => setTimeout(r, 2_500));
      // A rework, holding the lock, reopens api and drops the current candidate.
      mutateState(p.featureDir, (s) => {
        s.nodes[API]!.state = 'INVALIDATED';
        s.current_candidate = null;
        return s;
      });
    } finally {
      lock.release();
    }
    const r = await pending;
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('NODES_NOT_DONE');
    const after = loadState(p.featureDir)!.data;
    expect(after.current_candidate).toBeNull();
    expect(after.candidates).toEqual(before.candidates);
  }, 30_000);
});
