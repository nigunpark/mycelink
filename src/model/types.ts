/** Canonical data model shared by the controller, hooks and adapters. */

export type NodeType =
  | 'contract-lock'
  | 'red-test'
  | 'implementation'
  | 'refactor'
  | 'regression'
  | 'review'
  | 'integration'
  | 'candidate-build'
  | 'runtime-deploy'
  | 'e2e-scenario'
  | 'knowledge';

export type EvidenceKind =
  | 'red'
  | 'green'
  | 'refactor'
  | 'regression'
  | 'review'
  | 'e2e'
  | 'candidate';

/** Node lifecycle. Transitions are enforced by `transition.ts`. */
export const NODE_STATES = [
  'PLANNED',
  'READY',
  'CLAIMED',
  'RED_PENDING',
  'RED_VERIFIED',
  'GREEN_PENDING',
  'GREEN_VERIFIED',
  'REFACTOR_VERIFIED',
  'REGRESSION_VERIFIED',
  'REVIEW_VERIFIED',
  'INTEGRATED',
  'DONE',
  'BLOCKED',
  'NEEDS_DECISION',
  'BUDGET_EXHAUSTED',
  'INVALIDATED',
  'PAUSED',
  'EXCLUDED',
] as const;
export type NodeState = (typeof NODE_STATES)[number];

export const FEATURE_STATES = [
  'DRAFT',
  'PRD_APPROVED',
  'PLAN_APPROVED',
  'GRAPH_VALIDATED',
  'RUNNING',
  'CANDIDATE_READY',
  'E2E_RUNNING',
  'VERIFIED',
  'COMPLETED',
  'PAUSED',
  'BLOCKED',
  'NEEDS_DECISION',
  'BUDGET_EXHAUSTED',
  'CANCELLED',
] as const;
export type FeatureState = (typeof FEATURE_STATES)[number];

export interface Argv {
  id: string;
  command: string[];
  cwd?: string;
  expect_exit?: number;
  /** Run command[0] as a shell script; also requires allow_shell_commands. */
  shell?: boolean;
}

export interface WorkerBudget {
  model: string;
  effort?: 'low' | 'medium' | 'high';
  max_turns: number;
  max_wall_clock_minutes: number;
  max_attempts: number;
  max_same_failure?: number;
  nested_delegation: boolean;
}

export interface GraphNode {
  id: string;
  level: 'executable-node';
  repository: string | null;
  capability: string | null;
  node_type: NodeType;
  depends_on: string[];
  allowed_paths: string[];
  forbidden_paths?: string[];
  contract_inputs?: string[];
  contract_outputs?: string[];
  required_resources: string[];
  required_evidence: EvidenceKind[];
  verification_commands: Argv[];
  worker: WorkerBudget;
  invalidation_rules?: { when: string; action: 'INVALIDATE' | 'BLOCK' | 'RERUN_REGRESSION' }[];
  acceptance_criteria?: string[];
  e2e_scenario?: string;
}

export interface Capability {
  id: string;
  repository: string;
  title: string;
  acceptance_criteria?: string[];
}

export interface ResourceDecl {
  capacity: number;
  description?: string;
  exclusive_with?: string[];
}

export interface PortfolioGraph {
  schema_version: 1;
  feature_id: string;
  title: string;
  prd?: string;
  plan?: string;
  acceptance_criteria: { id: string; text: string }[];
  resources: Record<string, ResourceDecl>;
  repositories: string[];
  capabilities: Capability[];
  nodes: GraphNode[];
}

export interface RepositoryDecl {
  name: string;
  path: string;
  base_branch: string;
  role?: string;
  description?: string;
  baseline_failures?: string[];
  commands: {
    build?: string[];
    test: string[];
    lint?: string[];
    regression?: string[];
    start?: string[];
    stop?: string[];
    healthcheck?: string[];
  };
}

export interface RepositoryManifest {
  schema_version: 1;
  repositories: RepositoryDecl[];
}

export interface EvidenceRecord {
  kind: EvidenceKind;
  node_id: string;
  command: string[];
  exit_code: number;
  started_at: string;
  finished_at: string;
  cwd: string;
  repository: string | null;
  commit_sha: string | null;
  output_path: string;
  output_sha256: string;
  failure_fingerprint: string | null;
  /** RED evidence is only valid when the failure is a behaviour gap. */
  red_reason?: 'behaviour-missing' | 'setup-error' | 'syntax-error' | 'environment-error';
  /** Known-broken tests excluded so a baseline failure is not charged here. */
  baseline_excluded?: string[];
  candidate_id?: string | null;
  scenario_id?: string | null;
}

export interface NodeRuntime {
  state: NodeState;
  attempts: number;
  claim: NodeClaim | null;
  evidence: Partial<Record<EvidenceKind, EvidenceRecord>>;
  failure_counts: Record<string, number>;
  last_failure_fingerprint: string | null;
  integrated_sha: string | null;
  blocked_reason: string | null;
  usage: UsageTotals;
  updated_at: string;
  /** Attempts ended by infrastructure (adapter missing, host interrupted), not by the task. */
  interruptions?: number;
  /** Receipt of the last settled claim, so a repeated settle is answered, not re-run. */
  last_settlement?: SettlementReceipt | null;
  /**
   * The exact commit the node's worker branch was created from (the
   * repository's integration head, or its base branch before anything was
   * integrated). Kept while the branch lives, so a later claim on the same
   * branch fences the same delta.
   */
  branch_base_sha?: string | null;
  /**
   * Set by a rework: the next claim archives the node's old branch and
   * starts a new one from the current integration head.
   */
  fresh_branch_required?: boolean;
  /** Each controller-authorized rework of this node, oldest first: what it replaced and why. */
  rework_history?: ReworkHistoryEntry[];
  /**
   * The brief of the rework the node is in, handed to its next workers
   * (see engine/rework-brief.ts). Cleared when the node is DONE again.
   */
  rework_brief?: ReworkBrief | null;
}

/**
 * Why a controller-authorized rework reopened the node, for its workers.
 * Each approved rework is a generation with its own attempt allowance
 * (worker.max_attempts, counted from attempt_base); lifetime attempts and
 * failure fingerprints carry on, and the number of generations is bounded.
 */
export interface ReworkBrief {
  /** 1 for the node's first rework. */
  generation: number;
  /** How many reworks the node may have in all. */
  limit: number;
  at: string;
  /** The controller's reason: bounded, redacted, free of control characters. */
  reason: string;
  reason_sha256: string;
  decision_id: string | null;
  acceptance_criteria: string[];
  /** Relative references to the evidence of the failure. */
  evidence: string[];
  replaced: { integrated_sha: string | null; candidate_id: string | null; archived_ref: string | null };
  /** Lifetime attempts when the generation began. */
  attempt_base: number;
}

/** The DONE work a rework reopened, kept as history. */
export interface ReworkHistoryEntry {
  at: string;
  reason: string;
  decision_id: string | null;
  /** The node's attempts and failure fingerprints at the rework; both carry on. */
  attempts: number;
  failure_counts: Record<string, number>;
  integrated_sha: string | null;
  /** The worker branch head the rework archived, and the ref it was archived to. */
  branch_head: string | null;
  archived_ref: string | null;
  /** The candidate that stopped being current. */
  candidate_id: string | null;
  evidence: Partial<Record<EvidenceKind, { output_path: string; output_sha256: string; exit_code: number; commit_sha: string | null }>>;
}

/** One rework of a feature, as recorded in STATE.json. */
export interface ReworkRecord {
  node_id: string;
  reason: string;
  decision_id: string | null;
  at: string;
  /** Every node the rework moved out of DONE (or a parked state), target first. */
  reopened: string[];
  invalidated_candidate: string | null;
  /** Whether the feature had already been delivered when it was reworked. */
  delivered: boolean;
}

export type ClaimMode = 'adapter' | 'host' | 'manual' | 'controller';

export interface NodeClaim {
  claim_id: string;
  owner: string;
  worktree: string | null;
  branch: string | null;
  claimed_at: string;
  /** SHA-256 of the claim capability. The raw capability is never stored. */
  capability_sha256?: string;
  /** Who executes the attempt: a spawned adapter session, the host's Agent tool, a person, or the controller. */
  mode?: ClaimMode;
  attempt?: number;
  /** After this, an unsettled host dispatch counts as abandoned. */
  expires_at?: string;
  /** SHA-256 of the controller copy a settle (or a resume) captured for this claim. */
  result_captured_sha256?: string;
  /** File name, in the node's sessions directory, of that controller copy. */
  result_captured_file?: string;
  /** The dispatch generation the captured copy answers. */
  result_captured_dispatch_id?: string;
  /** When the current dispatch generation was issued (a resume resets it). */
  dispatched_at?: string;
  /** Host dispatch generation: a resume issues a new one, revoking the old worker's result. */
  dispatch_id?: string;
  /** The current generation's result file name inside the worktree's result slot. */
  result_file?: string;
  /** The dispatch generation whose worker usage has been counted (exactly once). */
  usage_counted_for?: string;
  /** Failure fingerprints already counted for this claim (each counts once per claim). */
  counted_fingerprints?: string[];
  /**
   * The commit this claim's worktree branch started from. Fresh verification
   * fences only what the node changed since it: work integrated by an
   * upstream node is base, not this node's.
   */
  base_sha?: string;
  /** A capture that started: the controller copy it writes, so a settle that dies after writing it can finish. */
  capture_pending?: { file: string; dispatch_id: string } | null;
  /** Set while a settle is verifying, so a second settle cannot run concurrently. */
  settling?: { pid: number; host: string; started_at: string } | null;
}

export interface SettlementReceipt {
  capability_sha256: string;
  claim_id: string;
  outcome: string;
  state: NodeState;
  detail: string;
  settled_at: string;
}

export interface UsageTotals {
  model_turns: number;
  wall_clock_ms: number;
  input_tokens: number;
  output_tokens: number;
  sessions: number;
}

export interface FeatureBudget {
  max_total_model_turns: number;
  max_total_wall_clock_ms: number;
  max_total_sessions: number;
  max_writer_concurrency: number;
  max_same_failure: number;
}

export interface PendingIntegration {
  node_id: string;
  /** The node commit fresh verification checked. */
  verified_sha: string;
  /** The recorded integration head the plan starts from. */
  from: string;
  /** The exact commit the integration branch is moved to. */
  to: string;
  strategy: 'fast-forward' | 'merge';
}

export interface FeatureState_ {
  schema_version: 1;
  feature_id: string;
  feature_state: FeatureState;
  graph_hash: string;
  created_at: string;
  updated_at: string;
  nodes: Record<string, NodeRuntime>;
  usage: UsageTotals;
  budget: FeatureBudget;
  blocked_reason: string | null;
  pending_decisions: string[];
  candidates: string[];
  current_candidate: string | null;
  /** SHA-256 of each ACCEPTED delivery manifest, by candidate id, recorded when acceptance passed. */
  accepted_deliveries?: Record<string, string>;
  /** Controller-authorized reworks within this feature, oldest first. */
  reworks?: ReworkRecord[];
  /**
   * Where the controller left each repository's integration branch after
   * its last integration. Survives invalidation; the branch is trusted only
   * at this head.
   */
  integration_heads?: Record<string, string>;
  /**
   * An integration the controller planned and is carrying out, by
   * repository: written before the integration branch moves, cleared once
   * its head is recorded. A resume accepts the branch at exactly `to`.
   */
  pending_integrations?: Record<string, PendingIntegration>;
  /**
   * The feature that replaced this one (`feature supersede`). A superseded
   * feature is quiescent history: never the delivered feature.
   */
  superseded_by?: string | null;
  superseded_reason?: string;
  superseded_at?: string;
}

export interface Problem {
  code: string;
  path: string;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: Problem[];
  graphHash: string;
}
