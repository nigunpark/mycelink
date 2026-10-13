/**
 * Who is settling a claim right now.
 *
 * A settle marks the claim it settles, so a second settle (or a resume)
 * cannot run concurrently, and a settle that died leaves a marker a later
 * settle, reconcile or resume must see through. The marker names the
 * settling process by its identity (pid and start, see
 * util/process-identity.ts): a pid alone names someone else after a crash,
 * in another PID namespace or after a reboot. A marker written before
 * identities were recorded is judged by the pid and its own time: a
 * process that started after the marker was written cannot have written it.
 */
import { hostname } from 'node:os';
import { isPidAlive } from '../state/process-lock.js';
import { isProcessAlive, processIdentity, processStartedAt } from '../util/process-identity.js';

export interface SettlerMarker {
  pid: number;
  host: string;
  started_at: string;
  /** The settling process's start (see ProcessIdentity.start). */
  start?: string;
  /** Its boot (Linux), when starts are relative to one. */
  boot?: string | null;
}

/** A settle that started over this long ago is presumed dead even on another host. */
export const SETTLE_STALE_MS = 2 * 60 * 60 * 1000;

/** The marker for a settle run by this process. */
export function settlerMarker(): SettlerMarker {
  const me = processIdentity(process.pid);
  return {
    pid: process.pid,
    host: hostname(),
    started_at: new Date().toISOString(),
    ...(me !== null ? { start: me.start, boot: me.boot } : {}),
  };
}

/** Whether the settle a marker names may still be running. */
export function settlerAlive(marker: SettlerMarker): boolean {
  const written = Date.parse(marker.started_at);
  if (Number.isNaN(written) || Date.now() - written > SETTLE_STALE_MS) return false;
  if (marker.host !== hostname()) return true;
  if (marker.pid === process.pid && marker.start === undefined) return true;
  if (marker.start !== undefined) {
    return isProcessAlive({ pid: marker.pid, start: marker.start, boot: marker.boot ?? null, host: marker.host, platform: process.platform }) === true;
  }
  if (!isPidAlive(marker.pid)) return false;
  const started = processStartedAt(marker.pid);
  // The pid's current process started after the marker was written: a reused pid.
  return started === null || started <= written + 1000;
}
