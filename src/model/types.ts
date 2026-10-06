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
