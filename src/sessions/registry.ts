/**
 * Worker session registry.
 *
 * Every dispatched session is recorded before it starts and updated as it
 * progresses, so a crashed controller can still reconcile orphaned claims and
 * leases, and so a replacement session is linked to the one it took over.
 */
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readDoc, writeDocAtomic } from '../state/atomic-json.js';
import { withLock } from '../state/process-lock.js';
import { validateAgainstSchema } from '../schema/registry.js';
import type { SessionHandle, SessionObservation, SessionStatus } from './adapter.js';

export interface SessionRecord {
  session_id: string;
  feature_id: string;
  node_id: string;
  claim_id: string;
  repository: string | null;
  worktree: string | null;
  branch: string | null;
  status: SessionStatus;
  started_at: string;
  last_progress_at: string;
  finished_at: string | null;
  turns: number;
  usage: { model_turns?: number; wall_clock_ms?: number; input_tokens?: number; output_tokens?: number };
  adapter: 'fake-claude' | 'claude-background';
  pid: number | null;
  log_path: string | null;
  result_path: string | null;
  exit_code: number | null;
  replaces_session_id: string | null;
  attempt: number;
}

export interface SessionRegistryFile {
  schema_version: 1;
  sessions: Record<string, SessionRecord>;
}

function lockPath(registryFile: string): string {
  return registryFile + '.lock';
}

export function loadRegistry(file: string): SessionRegistryFile {
  const doc = readDoc<SessionRegistryFile>(file);
  return doc?.data ?? { schema_version: 1, sessions: {} };
}

function save(file: string, data: SessionRegistryFile): void {
  const problems = validateAgainstSchema('session-registry', data);
  if (problems.length > 0) {
    throw new Error('Session registry invalid: ' + problems.map((p) => p.detail).join('; '));
  }
  mkdirSync(dirname(file), { recursive: true });
  writeDocAtomic(file, data);
}

export function recordSpawn(
  file: string,
  handle: SessionHandle,
  info: {
    featureId: string;
    repository: string | null;
    worktree: string | null;
    branch: string | null;
    attempt: number;
    replacesSessionId?: string | null;
  },
): SessionRecord {
  return withLock(
    lockPath(file),
    (): SessionRecord => {
      const registry = loadRegistry(file);
      const record: SessionRecord = {
        session_id: handle.session_id,
        feature_id: info.featureId,
        node_id: handle.node_id,
        claim_id: handle.claim_id,
        repository: info.repository,
        worktree: info.worktree,
        branch: info.branch,
        status: 'spawning',
        started_at: handle.started_at,
        last_progress_at: handle.started_at,
        finished_at: null,
        turns: 0,
        usage: {},
        adapter: handle.adapter,
        pid: handle.pid,
        log_path: handle.log_path,
        result_path: handle.result_path,
        exit_code: null,
        replaces_session_id: info.replacesSessionId ?? null,
        attempt: info.attempt,
      };
      registry.sessions[record.session_id] = record;
      save(file, registry);
      return record;
    },
    { timeoutMs: 15_000, pollMs: 10, purpose: 'session registry' },
  );
}

const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'done',
  'failed',
  'blocked',
  'needs-decision',
  'stopped',
  'budget-exhausted',
]);

export function recordObservation(
  file: string,
  sessionId: string,
  observation: SessionObservation,
): SessionRecord | null {
  return withLock(
    lockPath(file),
    (): SessionRecord | null => {
      const registry = loadRegistry(file);
      const record = registry.sessions[sessionId];
      if (!record) return null;
      record.status = observation.status;
      record.turns = observation.turns;
      record.usage = {
        model_turns: observation.usage.model_turns,
        wall_clock_ms: observation.usage.wall_clock_ms,
        input_tokens: observation.usage.input_tokens,
        output_tokens: observation.usage.output_tokens,
      };
      record.exit_code = observation.exit_code;
      record.last_progress_at = observation.last_progress_at;
      if (TERMINAL.has(observation.status)) {
        record.finished_at = new Date().toISOString();
      }
      save(file, registry);
      return record;
    },
    { timeoutMs: 15_000, pollMs: 10, purpose: 'session registry' },
  );
}

/** Sessions that never reached a terminal state (candidates for recovery). */
export function liveSessions(file: string): SessionRecord[] {
  return Object.values(loadRegistry(file).sessions).filter((s) => !TERMINAL.has(s.status));
}

export function sessionsForNode(file: string, nodeId: string): SessionRecord[] {
  return Object.values(loadRegistry(file).sessions)
    .filter((s) => s.node_id === nodeId)
    .sort((a, b) => a.attempt - b.attempt);
}

/** Force a session to a terminal status during reconciliation. */
export function markTerminal(file: string, sessionId: string, status: SessionStatus): void {
  withLock(
    lockPath(file),
    () => {
      const registry = loadRegistry(file);
      const record = registry.sessions[sessionId];
      if (!record) return;
      record.status = status;
      record.finished_at ??= new Date().toISOString();
      save(file, registry);
    },
    { timeoutMs: 15_000, pollMs: 10, purpose: 'session registry' },
  );
}
