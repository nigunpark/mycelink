/**
 * Append-only run ledger (`RUNS.jsonl`).
 *
 * One record per loop attempt, keyed by an idempotency key so a duplicated
 * hook delivery or a retried controller call is recorded once. The raw ledger
 * is never injected into a model context; `runSummary` produces the small
 * snapshot a session is allowed to see.
 */
import { appendEvent, readEvents } from '../state/event-log.js';
import type { UsageTotals } from '../model/types.js';

export interface RunRecord {
  attempt_id: string;
  idempotency_key: string;
  loop_id: string;
  parent_loop_id: string | null;
  node_id: string | null;
  candidate_sha: string | null;
  input_hash: string;
  started_at: string;
  finished_at: string;
  model_turns: number;
  usage: Readonly<Record<string, number>> | UsageTotals;
  wall_clock_ms: number;
  commands: string[];
  exit_codes: number[];
  failure_fingerprint: string | null;
  evidence_paths: string[];
  transition: string;
}

/** Append one attempt. A repeated idempotency key is a no-op. */
export function appendRun(runsFile: string, record: RunRecord): boolean {
  const { appended } = appendEvent(
    runsFile,
    {
      idempotency_key: record.idempotency_key,
      type: 'loop.attempt',
      actor: 'controller',
      ...(record.node_id ? { node_id: record.node_id } : {}),
      data: {
        attempt_id: record.attempt_id,
        loop_id: record.loop_id,
        parent_loop_id: record.parent_loop_id,
        candidate_sha: record.candidate_sha,
        input_hash: record.input_hash,
        started_at: record.started_at,
        finished_at: record.finished_at,
        model_turns: record.model_turns,
        usage: record.usage,
        wall_clock_ms: record.wall_clock_ms,
        // Commands are stored as joined strings and capped: the ledger is an
        // index, not an archive of output.
        commands: record.commands.slice(0, 12).map((c) => c.slice(0, 200)),
        exit_codes: record.exit_codes.slice(0, 12),
        failure_fingerprint: record.failure_fingerprint,
        evidence_paths: record.evidence_paths.slice(0, 12),
        transition: record.transition,
      },
    },
    { maxEventBytes: 8192 },
  );
  return appended;
}

export interface RunSummary {
  attempts: number;
  last_failure_fingerprint: string | null;
  repeated_failures: Record<string, number>;
  total_model_turns: number;
  total_wall_clock_ms: number;
  last_transition: string | null;
}

/** Bounded summary for a context snapshot. Never returns the raw ledger. */
export function runSummary(runsFile: string, nodeId?: string): RunSummary {
  const events = readEvents(runsFile, { includeRotated: true, type: 'loop.attempt' }).filter(
    (e) => nodeId === undefined || e.node_id === nodeId,
  );
  const repeated: Record<string, number> = {};
  let turns = 0;
  let wall = 0;
  let last: string | null = null;
  let lastFingerprint: string | null = null;

  for (const event of events) {
    const data = event.data as Partial<RunRecord>;
    turns += Number(data.model_turns ?? 0);
    wall += Number(data.wall_clock_ms ?? 0);
    last = (data.transition as string) ?? last;
    const fp = (data.failure_fingerprint as string | null) ?? null;
    if (fp) {
      repeated[fp] = (repeated[fp] ?? 0) + 1;
      lastFingerprint = fp;
    }
  }

  return {
    attempts: events.length,
    last_failure_fingerprint: lastFingerprint,
    repeated_failures: repeated,
    total_model_turns: turns,
    total_wall_clock_ms: wall,
    last_transition: last,
  };
}
