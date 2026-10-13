/**
 * Whether the module-worker launched for a host dispatch is still running.
 *
 * Claude Code runs a host's Agent call in the background by default: the
 * call answers at once, and the session records the agent's completion later
 * as a task notification. A host that settles before it arrives finds the
 * result slot empty — its own orchestration slip, never the worker's failure,
 * so settle answers WORKER_RUNNING and charges nothing (as a reviewer still
 * running answers REVIEWER_RUNNING: engine/review-transport.ts). A worker is
 * running only on positive evidence, from records only Claude Code and the
 * plugin's hooks write: a launch the fence recorded for this claim and
 * dispatch (hooks/provider-binding.ts), the host session's transcript holding
 * that Agent call and no completion of it (agentCallStanding), its host
 * session's process alive when the hook could name it, and its launch within
 * the session wall-clock. Anything else — no launch, an unreadable
 * transcript, a completion of any status, a dead host, the wall-clock past —
 * is no running worker, and the settle is judged as it always was.
 */
import { readRegular } from '../security/paths.js';
import { basename, isAbsolute } from 'node:path';
import { agentCallStanding } from './review-transport.js';
import { launchFiles } from './provider-interrupt.js';
import { WORKER_LAUNCH_SCHEMA, workerLaunchDir } from '../hooks/provider-binding.js';
import { isProcessAlive, type ProcessIdentity } from '../util/process-identity.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RECORD_BYTES = 64 * 1024;
/** Launch records one dispatch is read for. */
const MAX_LAUNCHES = 16;

export interface RunningWorker {
  tool_use_id: string;
  session_id: string;
  agent_id: string | null;
  launched_at: string;
  elapsed_ms: number;
  timeout_ms: number;
}

export interface WorkerLifecycleOptions {
  /** The session wall-clock (the control repository's session_timeout_ms). */
  timeoutMs: number;
  now?: number;
  /** Whether a recorded holder lives: null when nothing can tell. */
  alive?: (holder: ProcessIdentity) => boolean | null;
}

const defaultAlive = (holder: ProcessIdentity): boolean | null => {
  try {
    return isProcessAlive(holder);
  } catch {
    return null;
  }
};

const wellFormedHolder = (h: unknown): h is ProcessIdentity => {
  if (h === null || typeof h !== 'object') return false;
  const p = h as Record<string, unknown>;
  return Number.isInteger(p['pid']) && (p['pid'] as number) > 0 && typeof p['start'] === 'string' && typeof p['host'] === 'string' && typeof p['platform'] === 'string' && (p['boot'] === null || typeof p['boot'] === 'string');
};

function readRecord(file: string): Record<string, unknown> | null {
  const read = readRegular(file, MAX_RECORD_BYTES);
  if (read === null) return null;
  try {
    const v = JSON.parse(read.bytes.toString('utf8')) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The worker launched for `claim`'s current dispatch that is still running, or null when none is provably running. */
export function runningWorker(controlRoot: string, featureId: string, claim: { claim_id: string; dispatch_id: string }, options: WorkerLifecycleOptions): RunningWorker | null {
  const now = options.now ?? Date.now();
  for (const file of launchFiles(workerLaunchDir(controlRoot, featureId, claim.dispatch_id)).slice(0, MAX_LAUNCHES)) {
    const l = readRecord(file);
    if (l === null || l['schema'] !== WORKER_LAUNCH_SCHEMA || l['dispatch_id'] !== claim.dispatch_id || l['claim_id'] !== claim.claim_id) continue;
    const U = l['tool_use_id'];
    const S = l['session_id'];
    const tx = l['transcript_path'];
    if (typeof U !== 'string' || !ID.test(U) || typeof S !== 'string' || !ID.test(S) || typeof tx !== 'string' || !isAbsolute(tx) || basename(tx) !== `${S}.jsonl`) continue;
    const at = typeof l['at'] === 'string' ? Date.parse(l['at']) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    const elapsed = Math.max(0, now - at);
    if (elapsed > options.timeoutMs) continue;
    if (wellFormedHolder(l['holder']) && (options.alive ?? defaultAlive)(l['holder']) === false) continue;
    const standing = agentCallStanding(tx, U, S);
    if (standing === null || !standing.recorded || standing.finished) continue;
    return { tool_use_id: U, session_id: S, agent_id: standing.agent, launched_at: new Date(at).toISOString(), elapsed_ms: elapsed, timeout_ms: options.timeoutMs };
  }
  return null;
}
