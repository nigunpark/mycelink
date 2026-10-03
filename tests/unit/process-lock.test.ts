import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import {
  LockTimeoutError,
  acquireLock,
  isLockHeld,
  withLock,
} from '../../src/state/process-lock.js';

afterAll(() => cleanupTmpRoots());

// Child processes load the per-module tsc output, not the single runtime bundle.
const DIST = resolve(process.cwd(), 'build');

describe('process-lock', () => {
  it('acquires an uncontended lock and reports it held', () => {
    const dir = makeTmpDir('lock-');
    const lock = join(dir, 'state.lock');
    const handle = acquireLock(lock, { timeoutMs: 500 });
    expect(existsSync(lock)).toBe(true);
    expect(isLockHeld(lock)).toBe(true);
    handle.release();
    expect(isLockHeld(lock)).toBe(false);
  });

  it('times out instead of blocking forever when the lock is held', () => {
    const dir = makeTmpDir('lock-');
    const lock = join(dir, 'state.lock');
    const held = acquireLock(lock, { timeoutMs: 500 });
    expect(() => acquireLock(lock, { timeoutMs: 150, pollMs: 10 })).toThrow(LockTimeoutError);
    held.release();
  });

  it('re-acquires after release', () => {
    const dir = makeTmpDir('lock-');
    const lock = join(dir, 'state.lock');
    acquireLock(lock, { timeoutMs: 500 }).release();
    const second = acquireLock(lock, { timeoutMs: 500 });
    expect(isLockHeld(lock)).toBe(true);
    second.release();
  });

  it('recovers a lock whose owning process is gone', () => {
    const dir = makeTmpDir('lock-');
    const lock = join(dir, 'state.lock');
    // PID 0x7FFFFFFF is not a live process on Windows or POSIX.
    writeFileSync(
      lock,
      JSON.stringify({
        pid: 2147483646,
        host: hostname(),
        token: 'dead',
        acquired_at: new Date().toISOString(),
      }),
    );
    const handle = acquireLock(lock, { timeoutMs: 1000, pollMs: 10 });
    const body = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
    expect(body.pid).toBe(process.pid);
    handle.release();
  });

  it('recovers a lock older than its stale TTL even if the pid is alive', () => {
    const dir = makeTmpDir('lock-');
    const lock = join(dir, 'state.lock');
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        host: 'self',
        token: 'old',
        acquired_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const handle = acquireLock(lock, { timeoutMs: 1000, pollMs: 10, staleMs: 1000 });
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).not.toBe('old');
    handle.release();
  });

  it('release is a no-op when another holder has taken over (token mismatch)', () => {
    const dir = makeTmpDir('lock-');
    const lock = join(dir, 'state.lock');
    const first = acquireLock(lock, { timeoutMs: 500 });
    // Simulate a stale-recovery takeover by a different process.
    writeFileSync(
      lock,
      JSON.stringify({ pid: 1234, host: 'other', token: 'other-token', acquired_at: new Date().toISOString() }),
    );
    first.release();
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('other-token');
  });

  it('withLock releases on throw', () => {
    const dir = makeTmpDir('lock-');
    const lock = join(dir, 'state.lock');
    expect(() =>
      withLock(lock, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(isLockHeld(lock)).toBe(false);
  });

  it('survives rapid lock/unlock contention across many processes', async () => {
    // On Windows, a lock file in the NTFS "delete pending" state makes an
    // exclusive create fail with EPERM rather than EEXIST. That is still just
    // "someone else has it", and must never crash a holder.
    const dir = makeTmpDir('lock-churn-');
    const lock = join(dir, 'churn.lock');
    const lockUrl = pathToFileURL(join(DIST, 'state', 'process-lock.js')).href;
    const script = join(dir, 'churn.mjs');
    writeFileSync(
      script,
      `
import { withLock } from ${JSON.stringify(lockUrl)};
const [lock, iterations] = process.argv.slice(2);
for (let i = 0; i < Number(iterations); i++) {
  // No work inside the lock: maximise the create/delete race window.
  withLock(lock, () => {}, { timeoutMs: 60000, pollMs: 1 });
}
`,
    );

    const procs = 10;
    const failures: string[] = [];
    await Promise.all(
      Array.from(
        { length: procs },
        (_, i) =>
          new Promise<void>((done) => {
            const child = spawn(process.execPath, [script, lock, '40'], {
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (c: Buffer) => {
              stderr += c.toString();
            });
            child.on('exit', (code) => {
              if (code !== 0) failures.push(`child ${i} exit ${code}: ${stderr.slice(0, 400)}`);
              done();
            });
          }),
      ),
    );

    expect(failures).toEqual([]);
    expect(isLockHeld(lock)).toBe(false);
  });

  it('serialises mutations across concurrent OS processes', async () => {
    const dir = makeTmpDir('lock-mp-');
    const lock = join(dir, 'counter.lock');
    const counter = join(dir, 'counter.json');
    writeFileSync(counter, JSON.stringify({ revision: 1, data: { n: 0 } }));

    const lockUrl = pathToFileURL(join(DIST, 'state', 'process-lock.js')).href;
    const atomicUrl = pathToFileURL(join(DIST, 'state', 'atomic-json.js')).href;
    const script = join(dir, 'bump.mjs');
    writeFileSync(
      script,
      `
import { withLock } from ${JSON.stringify(lockUrl)};
import { readDoc, writeDocAtomic } from ${JSON.stringify(atomicUrl)};
const [lock, counter, iterations] = process.argv.slice(2);
for (let i = 0; i < Number(iterations); i++) {
  withLock(lock, () => {
    const doc = readDoc(counter);
    // Deliberate read-modify-write window: without a real lock this loses updates.
    const n = doc.data.n;
    const until = Date.now() + 1;
    while (Date.now() < until) { /* widen the race window */ }
    writeDocAtomic(counter, { n: n + 1 });
  }, { timeoutMs: 60000, pollMs: 5 });
}
`,
    );

    const procs = 4;
    const iterations = 15;
    await Promise.all(
      Array.from(
        { length: procs },
        () =>
          new Promise<void>((ok, fail) => {
            const child = spawn(process.execPath, [script, lock, counter, String(iterations)], {
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (c: Buffer) => {
              stderr += c.toString();
            });
            child.on('error', fail);
            child.on('exit', (code) =>
              code === 0 ? ok() : fail(new Error(`child exit ${code}: ${stderr}`)),
            );
          }),
      ),
    );

    const final = JSON.parse(readFileSync(counter, 'utf8')) as { data: { n: number } };
    expect(final.data.n).toBe(procs * iterations);
    expect(isLockHeld(lock)).toBe(false);
  });
});
