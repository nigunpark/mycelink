/* Experimental opt-in cross-process Codex lifecycle gate. This is a mutex,
 * NOT authorization to dispatch: preflight remains unconditionally DENY.
 * Never reclaim on age: the STATE.json lock's TTL is unsafe for long operations.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isPidAlive } from './process-lock.js';
import { processIdentity, type ProcessIdentity } from '../util/process-identity.js';

interface Owner { pid: number; host: string; token: string; acquired_at: string; identity?: ProcessIdentity | null }
const held = new Set<string>();
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
export const codexLifecycleLockPath = (featureDir: string): string => join(featureDir, 'CODEX-LIFECYCLE.lock');
const enabledPath = (featureDir: string): string => join(featureDir, 'CODEX-LIFECYCLE.enabled');
export const codexLifecycleEnabled = (featureDir: string): boolean => existsSync(enabledPath(featureDir));

/** Only the trusted controller may opt a feature into this gate, before WSL launch. */
export function enableCodexLifecycle(featureDir: string): void {
  const file = enabledPath(featureDir);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'wx');
  try { writeSync(fd, 'experimental; no dispatch authorization\n'); } finally { closeSync(fd); }
}

function ownerOf(file: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as Owner;
    if (!Number.isSafeInteger(o.pid) || typeof o.host !== 'string' || typeof o.token !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(o.token)) return null;
    return o;
  } catch { return null; }
}

function create(file: string, owner: Owner): boolean {
  let fd: number;
  try { fd = openSync(file, 'wx'); }
  catch (err) {
    if (['EEXIST', 'EACCES', 'EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
  try { writeSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
  return true;
}

function ownerGone(owner: Owner, host: string): boolean {
  if (owner.host !== host) return false;
  if (!isPidAlive(owner.pid)) return true;
  const identity = owner.identity;
  if (!identity || identity.host !== owner.host || identity.pid !== owner.pid ||
      typeof identity.start !== 'string' || identity.platform !== process.platform) return false;
  // OS identity unavailable => retain the lock. An unrelated live process with
  // a reused PID must not strand a crashed owner forever when identity is known.
  const now = processIdentity(owner.pid);
  return now !== null && (now.start !== identity.start || now.boot !== identity.boot);
}

/**
 * All mutations of an opted-in feature take this mutex before STATE.json.
 * The recovery guard serializes competing dead-owner reclamations. An unreadable,
 * foreign-host or unknown owner fails closed; no age-based takeover is possible.
 */
export function withCodexLifecycleLock<T>(featureDir: string, fn: () => T, options: { timeoutMs?: number } = {}): T {
  const file = resolve(codexLifecycleLockPath(featureDir));
  const syncResult = (): T => {
    const result = fn();
    if (result !== null && typeof result === 'object' && 'then' in result) {
      throw new Error('CODEX_LIFECYCLE_ASYNC_FORBIDDEN');
    }
    return result;
  };
  if (held.has(file)) return syncResult(); // synchronous nested mutateState in this process
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const me: Owner = { pid: process.pid, host: hostname(), token: randomBytes(16).toString('hex'),
    acquired_at: new Date().toISOString(), identity: processIdentity(process.pid) };
  for (;;) {
    if (create(file, me)) break;
    const owner = ownerOf(file);
    if (owner && ownerGone(owner, me.host)) {
      const recovery = `${file}.recovery`;
      if (create(recovery, me)) {
        try {
          const again = ownerOf(file);
          if (again?.token === owner.token && again.pid === owner.pid && ownerGone(again, me.host)) {
            // The old owner is provably gone; the recovery guard serializes
            // other reclaimers. Never reclaim merely because a lock aged out.
            rmSync(file);
          }
        } finally {
          if (ownerOf(recovery)?.token === me.token) rmSync(recovery);
        }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error(`CODEX_LIFECYCLE_LOCK_BUSY: ${file}`);
    sleep(10);
  }
  held.add(file);
  try { return syncResult(); }
  finally {
    held.delete(file);
    if (ownerOf(file)?.token === me.token) rmSync(file);
  }
}
