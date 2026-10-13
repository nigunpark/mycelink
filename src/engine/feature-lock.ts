/**
 * The feature's delivery lock (deliveries/deliver.lock): delivery, rework,
 * supersede and every candidate cut take it, so the current candidate never
 * changes under a delivery, and a candidate never becomes current across a
 * rework that reopened the work it binds.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, LockTimeoutError, type LockHandle } from '../state/process-lock.js';

/** Another delivery, rework, supersede or candidate cut of the feature holds its lock. */
export class FeatureBusyError extends Error {
  readonly code = 'FEATURE_BUSY';
  constructor(purpose: string, cause: LockTimeoutError) {
    super(`FEATURE_BUSY: ${purpose} waits for a delivery, rework, supersede or candidate cut of this feature already running (${cause.message}); try again once it has finished.`);
    this.name = 'FeatureBusyError';
  }
}

/** Run `fn` holding the feature's delivery lock. */
export function withFeatureLock<T>(featureDir: string, purpose: string, fn: () => T, timeoutMs = 2_000): T {
  const dir = join(featureDir, 'deliveries');
  mkdirSync(dir, { recursive: true });
  let handle: LockHandle;
  try {
    handle = acquireLock(join(dir, 'deliver.lock'), { timeoutMs, pollMs: 50, purpose });
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new FeatureBusyError(purpose, err);
    throw err;
  }
  try {
    return fn();
  } finally {
    handle.release();
  }
}
