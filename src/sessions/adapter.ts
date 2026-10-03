/**
 * Worker session adapter interface.
 *
 * The controller is the only dispatcher. It never knows whether a worker is a
 * real Claude Code session or a deterministic stand-in: both satisfy this
 * interface, which is what keeps the automated suite free of model usage.
 */
import type { UsageTotals } from '../model/types.js';

export interface NodeResult {
  schema_version: 1;
  node_id: string;
  claim_id: string;
  outcome: 'SUBMITTED' | 'RETRYABLE' | 'BLOCKED' | 'NEEDS_DECISION' | 'BUDGET_EXHAUSTED';
  commands: { command: string[]; exit_code: number; cwd?: string }[];
  commit_sha?: string | null;
  branch?: string | null;
  changed_paths?: string[];
  evidence_paths: string[];
  failure_fingerprint?: string | null;
  decision_request?: {
    question: string;
    options: string[];
    category?: string;
  } | null;
  usage?: Partial<UsageTotals>;
  notes?: string;
}

export type SessionStatus =
  | 'spawning'
  | 'working'
  | 'stalled'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'needs-decision'
  | 'stopped'
  | 'budget-exhausted';

export interface SpawnRequest {
  featureId: string;
  nodeId: string;
  claimId: string;
  attempt: number;
  /** Path to the bounded context pack; the worker's only inherited context. */
  contextPackPath: string;
  /** Worker worktree. The session is confined here. */
  cwd: string;
  /** Where the worker must write its structured result. */
  resultPath: string;
  /** Where the raw session stream is captured (pointer, never inlined). */
  logPath: string;
  model: string;
  /**
   * Turn ceiling from the node budget. Claude Code 2.1.274 has no
   * `--max-turns` flag, so the controller enforces this from the observed
   * stream rather than delegating it to the CLI.
   */
  maxTurns: number;
  maxWallClockMs: number;
  /** Kill the session after this long with no new output. */
  stallMs: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  env?: Record<string, string>;
  /** Links a replacement session to the one it took over from. */
  replacesSessionId?: string | null;
}

export interface SessionHandle {
  session_id: string;
  adapter: 'fake-claude' | 'claude-background';
  pid: number | null;
  node_id: string;
  claim_id: string;
  started_at: string;
  log_path: string;
  result_path: string;
}

export interface SessionObservation {
  status: SessionStatus;
  exit_code: number | null;
  turns: number;
  usage: UsageTotals;
  result: NodeResult | null;
  failure_reason: string | null;
  timed_out: boolean;
  last_progress_at: string;
}

export interface SessionAdapter {
  readonly name: 'fake-claude' | 'claude-background';
  spawn(request: SpawnRequest): SessionHandle;
  /** Current observation without blocking. */
  poll(handle: SessionHandle): SessionObservation;
  /** Resolve once the session reaches a terminal state. */
  wait(handle: SessionHandle): Promise<SessionObservation>;
  /** Terminate the session and reclaim its process. */
  stop(handle: SessionHandle): void;
}

/** Map a worker's self-reported outcome onto a session status. */
export function statusForOutcome(outcome: NodeResult['outcome']): SessionStatus {
  switch (outcome) {
    case 'SUBMITTED':
      return 'done';
    case 'BLOCKED':
      return 'blocked';
    case 'NEEDS_DECISION':
      return 'needs-decision';
    case 'BUDGET_EXHAUSTED':
      return 'budget-exhausted';
    case 'RETRYABLE':
      // The session ended cleanly but produced no submission. That is not
      // progress, so it must not read as success to the scheduler.
      return 'failed';
    default:
      return 'failed';
  }
}

export function zeroObservationUsage(): UsageTotals {
  return { model_turns: 0, wall_clock_ms: 0, input_tokens: 0, output_tokens: 0, sessions: 0 };
}
