/**
 * Stale PID reuse and lock-token mismatch.
 *
 * A PID recorded by a crashed holder may later belong to an unrelated live
 * process. Liveness alone must therefore never keep a lock, lease or session
 * alive forever, and a holder whose token no longer matches must never be able
 * to delete someone else's lock or lease.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { acquireLock, LockTimeoutError } from '../../src/state/process-lock.js';
import {
  acquireResource,
  listLeases,
  recoverLeases,
  releaseResource,
} from '../../src/resources/leases.js';
import { findOrphanedSessions, type SessionRecord } from '../../src/sessions/registry.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

afterEach(() => cleanupTmpRoots());

/** A PID that is certainly alive but is not this process: our parent. */
const FOREIGN_LIVE_PID = process.ppid;

function writeLock(file: string, owner: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(owner));
}

describe('process lock', () => {
  it('does not steal a fresh lock whose PID is alive (possibly reused) on this host', () => {
    const dir = makeTmpDir('pid-');
    const lock = join(dir, 'x.lock');
    writeLock(lock, { pid: FOREIGN_LIVE_PID, host: hostname(), token: 't-live', acquired_at: new Date().toISOString() });
    expect(() => acquireLock(lock, { timeoutMs: 120, pollMs: 10 })).toThrow(LockTimeoutError);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('t-live');
  });

  it('recovers a lock held by a reused live PID once its TTL has passed', () => {
    const dir = makeTmpDir('pid-');
    const lock = join(dir, 'x.lock');
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    writeLock(lock, { pid: FOREIGN_LIVE_PID, host: hostname(), token: 't-reused', acquired_at: old });
    const handle = acquireLock(lock, { timeoutMs: 1000, pollMs: 10, staleMs: 60_000 });
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe(handle.token);
    handle.release();
  });

  it('never treats a dead-looking PID from another host as proof the holder is gone', () => {
    const dir = makeTmpDir('pid-');
    const lock = join(dir, 'x.lock');
    writeLock(lock, { pid: 2147483646, host: 'some-other-host', token: 't-remote', acquired_at: new Date().toISOString() });
    expect(() => acquireLock(lock, { timeoutMs: 120, pollMs: 10 })).toThrow(LockTimeoutError);
  });

  it('a holder whose token was superseded cannot delete the new owner lock', () => {
    const dir = makeTmpDir('pid-');
    const lock = join(dir, 'x.lock');
    const first = acquireLock(lock, { timeoutMs: 500 });
    writeLock(lock, { pid: process.pid, host: hostname(), token: 'new-owner', acquired_at: new Date().toISOString() });
    first.release();
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('new-owner');
  });
});

describe('resource leases', () => {
  const capacities = { 'full-runtime': { capacity: 1 } };

  it('a lease held by a reused live PID is reclaimed after its TTL, not kept forever', () => {
    const dir = makeTmpDir('pid-');
    const t0 = Date.now() - 3 * 60 * 60 * 1000;
    acquireResource(dir, 'full-runtime', { nodeId: 'n1', owner: 'o', capacities, pid: FOREIGN_LIVE_PID, ttlMs: 60_000, now: t0 });
    expect(recoverLeases(dir).map((l) => l.node_id)).toEqual(['n1']);
    expect(listLeases(dir)).toEqual([]);
  });

  it('releasing with a wrong lease id (token mismatch) leaves the real lease in place', () => {
    const dir = makeTmpDir('pid-');
    const lease = acquireResource(dir, 'full-runtime', { nodeId: 'n1', owner: 'o', capacities });
    expect(releaseResource(dir, 'not-' + lease.lease_id)).toBe(false);
    expect(listLeases(dir).map((l) => l.lease_id)).toEqual([lease.lease_id]);
  });
});

describe('worker session reconciliation', () => {
  function session(overrides: Partial<SessionRecord>): SessionRecord {
    const now = new Date().toISOString();
    return {
      session_id: 's',
      feature_id: 'FEAT-1',
      node_id: 'FEAT-1.a.b',
      claim_id: 'c',
      repository: null,
      worktree: null,
      branch: null,
      status: 'working',
      started_at: now,
      last_progress_at: now,
      finished_at: null,
      turns: 0,
      usage: {},
      adapter: 'claude-background',
      pid: FOREIGN_LIVE_PID,
      log_path: null,
      result_path: null,
      exit_code: null,
      replaces_session_id: null,
      attempt: 1,
      ...overrides,
    };
  }

  const alive = (): boolean => true;
  const dead = (): boolean => false;

  it('orphans a session whose PID is dead', () => {
    expect(findOrphanedSessions([session({ session_id: 'd' })], { isAlive: dead, staleAfterMs: 60_000 })).toEqual(['d']);
  });

  it('keeps a live session that made recent progress', () => {
    expect(findOrphanedSessions([session({ session_id: 'l' })], { isAlive: alive, staleAfterMs: 60_000 })).toEqual([]);
  });

  it('orphans a session whose PID is alive but silent past the stale window (PID reuse)', () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const records = [session({ session_id: 'reused', started_at: old, last_progress_at: old })];
    expect(findOrphanedSessions(records, { isAlive: alive, staleAfterMs: 60_000 })).toEqual(['reused']);
  });

  it('orphans a session that never recorded a PID', () => {
    expect(findOrphanedSessions([session({ session_id: 'np', pid: null })], { isAlive: alive, staleAfterMs: 60_000 })).toEqual(['np']);
  });
});
