/**
 * Worker session adapter interface.
 *
 * The controller is the only dispatcher. It never knows whether a worker is a
 * real Claude Code session or a deterministic stand-in: both satisfy this
 * interface, which is what keeps the automated suite free of model usage.
 */
import type { UsageTotals } from '../model/types.js';
import type { CodexTranscriptEvidence } from './codex-transcript.js';
import type { ChannelResponse } from './codex-claim-channel.js';

export type ProviderId = 'claude' | 'codex' | 'fake';
export type AdapterId = 'claude-cli' | 'codex-cli' | 'fake-provider';
export type LegacyAdapterId = 'claude-background' | 'fake-claude';
export type SessionAdapterId = AdapterId | LegacyAdapterId;

export interface NodeResult {
  /** 2: each criterion an acceptance review's rework orders may be answered on its own (outcome CRITERIA). */
  schema_version: 1 | 2;
  node_id: string;
  claim_id: string;
  /** The host dispatch generation the result answers (host-dispatched claims only). */
  dispatch_id?: string;
  /** The orchestration epoch the dispatch was issued at, as its ticket gives it (state/orchestration.ts). */
  orchestration_epoch?: number;
  /**
   * REVIEW_GAP_CHALLENGE: in an acceptance review's rework, the review's exact reproduction passed on the unchanged
   * integrated head; `challenge` says so, structured, for settle to check (engine/review-challenge.ts).
   * CRITERIA (schema_version 2): each criterion the rework orders answered on its own, in `criteria`
   * (engine/criterion-outcomes.ts): some done, some challenged, some unresolved, in one execution.
   */
  outcome: 'SUBMITTED' | 'RETRYABLE' | 'BLOCKED' | 'NEEDS_DECISION' | 'BUDGET_EXHAUSTED' | 'REVIEW_GAP_CHALLENGE' | 'CRITERIA';
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
  /**
   * The worker's own account of its history: the base and head it worked
   * between and, per RED -> GREEN cycle, its test-only and production
   * commits (optionally the RED test files by blob). Settle checks it
   * against the repository; a claim that does not match fails closed.
   */
  tdd?: {
    base_sha: string;
    head_sha: string;
    cycles: { red_commits: string[]; green_commits: string[]; red_tests?: { path: string; blob: string | null }[] }[];
  };
  /**
   * For each acceptance criterion the node serves: the named test that proves
   * it, the gate that ran it and that gate's output hash (engine/criteria.ts).
   */
  criterion_evidence?: CriterionEvidence[];
  /** With outcome REVIEW_GAP_CHALLENGE: the challenge of a review gap (schemas/node-result.schema.json). With outcome CRITERIA: the gaps of its challenged criteria. */
  challenge?: WorkerChallenge;
  /** With outcome CRITERIA: every criterion the rework orders, exactly once, with its own outcome. */
  criteria?: CriterionOutcome[];
}

/** One ordered criterion's own outcome in a per-criterion result (engine/criterion-outcomes.ts). */
export interface CriterionOutcome {
  criterion: string;
  outcome: 'DONE' | 'REVIEW_GAP_CHALLENGE' | 'BLOCKED' | 'NEEDS_DECISION';
  /** BLOCKED or NEEDS_DECISION: why, for this criterion alone. */
  reason?: string;
  /** NEEDS_DECISION: the question a person answers for this criterion. */
  decision_request?: { question: string; options: string[]; category?: string };
  /** DONE: a test named for this criterion and another, traced to this criterion's own clauses. */
  clauses?: { clause: string; test_id: string; assertions: string[]; trace: string }[];
}

/** A review-gap challenge as a worker writes it (engine/review-challenge.ts judges it). */
export interface WorkerChallenge {
  review_id: string;
  reason_sha256: string;
  base_sha: string;
  /** The red gate whose run of the focused tests passed; null when every gap cites a reproduction capsule instead. */
  gate_output_sha256: string | null;
  gaps: {
    criterion: string;
    reproduction_sha256: string;
    /** The passing reproduction capsule of this gap (engine/reproduction-capsule.ts): its id and receipt hash. */
    capsule?: { capsule_id: string; capsule_sha256: string };
    tests: string[];
    clauses: { clause: string; test_id: string; assertions: string[]; trace: string }[];
    explanation: string;
  }[];
}

export interface CriterionEvidence {
  criterion: string;
  /**
   * The canonical id of the test that proves it, as the gate that ran it
   * published it (evidence/test-ids.ts). Absent only for a declaration
   * criterion (or a declaration-only node's), proved by its GREEN alone.
   */
  test_id?: string;
  /**
   * Beside a test_id, display only. Without one (legacy), the path and name
   * count only when they name exactly one test the gate ran.
   */
  test?: { path: string; name: string };
  gate: 'red' | 'green' | 'regression';
  output_sha256: string;
  /**
   * A RED promoted from a failing reproduction capsule of this claim (gate "red" only): the capsule that ran the
   * review's exact reproduction on the unchanged base and failed. Its files must be what the history committed.
   */
  capsule_id?: string;
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
  /**
   * Path to the bounded context pack; the worker's only inherited context.
   * The adapter validates it and hands it to the worker inside the prompt;
   * the worker never reads this path.
   */
  contextPackPath: string;
  /** Worker worktree. The session is confined here. */
  cwd: string;
  /**
   * Controller-owned copy of the worker's validated, redacted result. The
   * worker writes to the result slot inside `cwd` and never sees this path.
   */
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
  /**
   * Controller-built gate commands (`mycelink tdd ...`). Each is offered to
   * the worker verbatim and pre-approved as that exact command line only.
   */
  gateCommands?: { gate: 'red' | 'green' | 'regression'; argv: string[] }[];
  /** Controller-only, per-attempt handler; never serialized into the worker pack. */
  claimChannel?: { handle: (request: unknown) => ChannelResponse; probeEnabled?: boolean; redactEnv?: Record<string, string> };
  env?: Record<string, string>;
  /** Links a replacement session to the one it took over from. */
  replacesSessionId?: string | null;
}

export interface SessionHandle {
  session_id: string;
  adapter: SessionAdapterId;
  pid: number | null;
  node_id: string;
  claim_id: string;
  started_at: string;
  log_path: string;
  result_path: string;
}

export interface SessionObservation {
  /** Provider-process evidence only; not worker result ownership or reviewer verdict authority. */
  codex_evidence?: CodexTranscriptEvidence & { process_session_id: string };
  /** Separate untrusted worker slot; no Codex reviewer verdict is inferred from worker text. */
  codex_provenance?: {
    provider: 'codex';
    process_session_id: string;
    worker_result: { source: 'worktree-result-slot'; attested: false; node_id: string; claim_id: string; sha256: string } | null;
    reviewer_verdict: null;
  };
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
  readonly name: SessionAdapterId;
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
    case 'REVIEW_GAP_CHALLENGE':
      // A claim for settle to judge, like a submission: never a parked node (engine/review-challenge.ts).
      return 'done';
    case 'CRITERIA':
      // Each ordered criterion's own outcome, for settle to judge one by one: never the whole node parked or failed.
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
