/** Canonical data model shared by the controller, hooks and adapters. */
import type { TestIdentity } from '../evidence/test-identity.js';

export type { TestIdentity };

/**
 * A test published before canonical identities (PCM-101 final: results with a JUnit full name and no identity), mapped
 * to its identity at a head — never by rewriting the evidence it was published in: its raw name, the declaration it
 * resolved to, and the receipt settle writes of it (immutable, content-addressed).
 */
export interface TestIdentityAlias {
  schema: 'mycelink-test-identity-alias/1';
  raw: { test_id: string; path: string; full_name: string; classname: string | null };
  canonical: TestIdentity;
  head_sha: string;
  declaration: { path: string; method: string; classes: string[]; line: number | null; blob: string | null };
  receipt?: { path: string; sha256: string } | null;
}

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
  | 'knowledge'
  /**
   * Proves criteria by existing tests on a repository's integrated state and
   * changes nothing: the controller runs its commands itself in a fresh,
   * set-up checkout (engine/verification-node.ts); never a worker.
   */
  | 'verification';

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
  /** The repository module this verifier runs (engine/modules.ts): its steps, then exactly `command`. */
  module?: string;
  /** The module descriptor's hash the graph was planned against. */
  module_sha256?: string;
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

export interface ReadonlyFixture {
  manifest: string;
  baseline: string;
  sha256: string;
}

export interface GraphNode {
  readonly_fixture?: ReadonlyFixture;
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
  /**
   * The approved criteria, verbatim (engine/acceptance.ts), each with its kind: a new behavior (default; also
   * spelled behaviour/behavior) needs a test its RED failed, a compatibility criterion an existing test a gate
   * passed, a declaration its GREEN.
   */
  acceptance_criteria: { id: string; text: string; kind?: CriterionKindSpelling }[];
  resources: Record<string, ResourceDecl>;
  repositories: string[];
  capabilities: Capability[];
  nodes: GraphNode[];
}

/** How a graph may spell a criterion kind; engine/criteria.ts normalises it. */
export type CriterionKindSpelling = 'new-behavior' | 'behaviour' | 'behavior' | 'compatibility' | 'declaration';

/** A criterion kind, normalised. */
export type CriterionKind = 'new-behavior' | 'compatibility' | 'declaration';

export interface RepositoryDecl {
  name: string;
  path: string;
  base_branch: string;
  role?: string;
  description?: string;
  baseline_failures?: string[];
  /**
   * Which paths are tests, for the test-first history check (see
   * engine/tdd-history.ts). Absent: the conservative defaults.
   */
  tdd?: {
    test_paths?: string[];
    production_roots?: string[];
    declaration_paths?: string[];
  };
  /**
   * What every new worktree of the repository needs before anything runs in
   * it (see engine/worktree-setup.ts). Absent: nothing is run.
   */
  worktree_setup?: {
    commands: string[][];
    timeout_seconds?: number;
    env?: Record<string, string>;
    required_paths?: string[];
    /** Globs of the tracked files the setup installs from: changed in a worktree, a gate sets it up again first. */
    inputs?: string[];
  };
  commands: {
    build?: string[];
    test: string[];
    lint?: string[];
    regression?: string[];
    start?: string[];
    stop?: string[];
    healthcheck?: string[];
  };
  /**
   * How each module of the repository verifies itself (engine/modules.ts):
   * module-scoped, shell-free setup, build and test argv. A node's gates run
   * its module's; the full suite (`commands.test`) stays the regression and
   * candidate command. Absent: every node keeps the command its graph names.
   */
  modules?: ModuleDecl[];
  /** What every module inherits unless it says otherwise (null unsets). */
  module_defaults?: ModuleCommands;
}

export interface ModuleReport {
  /** Vitest's `--reporter=json`, or JUnit XML (Surefire, Node's reporter). */
  format: 'vitest-json' | 'junit-xml';
  /** A report directory inside the checkout (Surefire); absent, `${REPORT}` in the test argv names a controller-owned file. */
  dir?: string;
}

export interface ModuleCommands {
  setup?: string[][] | null;
  build?: string[][] | null;
  test?: string[] | null;
  report?: ModuleReport | null;
  timeout_seconds?: number | null;
}

export interface ModuleDecl extends ModuleCommands {
  id: string;
  /** The module's directory, relative to the repository root. */
  path: string;
  /** False for declarations or documentation only: no runtime test, no RED. Default true. */
  runtime_tests?: boolean;
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
  /**
   * Why a RED counts or not, in the benchmark replay's categories
   * (evidence/red-classify.ts): only `assertion` and `exception` are valid.
   */
  red_category?: RedEvidenceCategory;
  /** Identity of the failure that decided the category, stable across runs. */
  red_fingerprint?: string;
  /** One line saying why, for the worker. */
  red_detail?: string;
  /** The tests the RED declared and how each ended, when a structured report was read. */
  red_tests?: RedTestRecord[];
  /** The tests the RED's delta declared (its own new or changed tests), whatever the report. */
  red_declared?: { file: string; name: string }[];
  /** Known-broken tests excluded so a baseline failure is not charged here. */
  baseline_excluded?: string[];
  candidate_id?: string | null;
  scenario_id?: string | null;
  /** Receipt (SHA-256) of the worktree setup of the checkout the command ran in. */
  worktree_setup_sha256?: string;
  /** The setup inputs (engine/worktree-setup.ts) the worktree held when the command ran, when the setup declares any. */
  setup_inputs_sha256?: string;
  /** The module whose command ran (engine/modules.ts), and its descriptor's hash. */
  module?: string;
  module_sha256?: string;
  /** Hash of exactly what ran: the steps, the command, its report and timeout. */
  plan_sha256?: string;
  /** Setup and build steps run before the command, in order. */
  steps?: { argv: string[]; exit_code: number; timed_out: boolean; duration_ms: number }[];
  /** The structured report the command wrote, normalised and stored beside the log. */
  results?: EvidenceResults | null;
  /**
   * A regression whose failures all lie in modules owned by dependents of this
   * node that are not DONE (they reopen and re-verify): its obligation passes
   * to them (`to`); the candidate still requires the full suite.
   */
  regression_deferred?: { to: string[]; failing: string[] } | null;
  /**
   * A RED this generation did not run: the attested RED of a criterion it carries, as its completion record
   * (engine/criterion-ledger.ts) keeps it — the generation changed no production code, so the RED that drove the
   * code in its base is the node's (CSET-203 r16).
   */
  carried_from?: { record_id: string; criterion: string; generation: number; claim_id: string | null } | null;
}

export interface EvidenceResults {
  format: 'vitest-json' | 'junit-xml';
  /** Relative to the control root, like output_path. */
  path: string;
  sha256: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/** The module verification a claim is bound to: what its gates and its fresh verification run. */
export interface ClaimVerification {
  module: string;
  module_sha256: string;
  path: string;
  runtime_tests: boolean;
  plan: { setup: string[][]; build: string[][]; test: string[]; report: ModuleReport | null; timeout_seconds: number };
  plan_sha256: string;
  /** The repository's full suite, run by the regression gate. */
  regression: { command: string[]; sha256: string };
}

export type RedEvidenceCategory =
  | 'assertion'
  | 'exception'
  | 'syntax'
  | 'import'
  | 'missing-symbol'
  | 'setup'
  | 'timeout'
  | 'crash'
  | 'not-run'
  | 'no-test'
  | 'passed'
  | 'compile'
  | 'environment';

export interface RedTestRecord {
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'not-run';
  category: string;
  type: string | null;
  fingerprint: string | null;
}

/** The worktree setup a claim is bound to (engine/worktree-setup.ts): what ran, or was reused, before its ticket. */
export interface ClaimWorktreeSetup {
  status: 'complete' | 'reused';
  config: { commands: string[][]; timeout_seconds: number; env: Record<string, string>; required_paths: string[]; inputs?: string[] };
  config_sha256: string;
  /** Relative to the control root. */
  receipt_path: string;
  receipt_sha256: string;
  head_sha: string | null;
  /** The setup's inputs as its receipt found them (when it declares any): a gate that finds them changed sets up again. */
  inputs_sha256?: string;
}

/** The last worktree setup of a node's worktree, as STATE.json keeps it. */
export interface WorktreeSetupState {
  status: 'complete' | 'failed';
  code: string | null;
  config_sha256: string;
  receipt_path: string;
  receipt_sha256: string;
  worktree: string;
  head_sha: string | null;
  at: string;
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
  /**
   * What each accepted red gate ran with, on the node's current branch: the
   * commit it ran on and its test files by blob. Settle binds every RED
   * commit of the history to one of these. Cleared with the branch.
   */
  tdd_red_bindings?: TddRedBinding[];
  /** The last history settle verified for this node, kept as evidence. */
  tdd_history?: TddHistoryRecord | null;
  /** Why settle refused the node's last history: handed to its next worker. Cleared at DONE. */
  tdd_rejection?: TddRejection | null;
  /**
   * Why settle last refused to integrate the node's work, uncharged (CSET-201 final): it would have lost a sibling's standing
   * proof (SIBLING_PROGRESS_LOST: a stale base, or its own delta) or conflicted with it. Handed to its next worker; counted
   * per generation, and past MAX_SIBLING_LOSSES charged.
   */
  sibling_progress?: SiblingProgressRecord | null;
  /** The last setup of the node's worktree: a resume reuses it only while it still holds. */
  worktree_setup?: WorktreeSetupState | null;
  /**
   * The criterion evidence settle accepted for the node's last DONE (engine/criteria.ts): each test by its canonical id and full name.
   * `carried`: a criterion a rework did not name, proved in an earlier generation and proved again by this one's fresh
   * verification at its head (`carried_from`: the proof it carried).
   */
  criteria?: AcceptedCriterionRecord[];
  /**
   * Set by a rework, for the generation it starts: each new behaviour of the
   * node the rework does not name, with the proof the replaced generation
   * settled it with. Data, never an active gate: settle re-runs its test on
   * the new head and records a fresh proof (engine/criteria.ts).
   */
  carried_criterion_proofs?: CarriedCriterionProof[];
  /**
   * The orchestration epoch the node's own generation last changed at
   * (reworked, reopened, restored, invalidated: state/orchestration.ts). A
   * claim binds it; a claim whose node's lineage moved is obsolete. Absent: 0.
   */
  lineage?: number;
  /**
   * Every criterion the node completed by an accepted settlement, oldest first (engine/criterion-ledger.ts): one
   * immutable record per criterion and generation, hash-bound, its proof archived. Absent: a state from before the
   * ledger, whose records are derived from its rework history.
   */
  criterion_ledger?: CriterionCompletion[];
}

/** How a criterion's completion was proved (engine/criterion-ledger.ts). */
export type CompletionBasis = 'red' | 'compatibility' | 'declaration' | 'carried' | 'reproved';

/**
 * A criterion completed by an accepted settlement (CSET-203 r16): immutable, bound by `sha256` (the SHA-256 of the
 * record without `sha256` and `record_id`) to the order it answered, the repository delta that completed it, the RED
 * that drove it (its record and output archived under `archive`), the proof settle accepted, the settlement and its
 * lineage: `source` is the record a carried or re-proved completion stands on, `parent` this criterion's previous
 * record on the node.
 */
export interface CriterionCompletion {
  schema: 'mycelink-criterion-completion/1';
  record_id: string;
  sha256: string;
  node_id: string;
  criterion: string;
  kind: CriterionKind;
  generation: number;
  basis: CompletionBasis;
  source: string | null;
  parent: string | null;
  claim_id: string | null;
  dispatch_id: string | null;
  settled_at: string;
  /** The review order it answered, when one did: its revision and the gap's exact reproduction. */
  order: { review_id: string; revision: number | null; receipt_sha256: string | null; reproduction_sha256: string | null } | null;
  repo: { repository: string; base_sha: string | null; head_sha: string | null; integrated_sha: string | null };
  /** The production delta of the generation that completed it: each path's blob before and after (null: absent). */
  production: { paths: { path: string; before: string | null; after: string | null }[]; sha256: string };
  /** The proof settle accepted: its test (and that test file's blob at the head) and the gate output that ran it. */
  /** The test that proves it: raw (as its report named it) and, recorded since PCM-101 final, its canonical identity and alias receipt. */
  proof: { test_id: string | null; test: { path: string; name: string } | null; test_blob: string | null; gate: 'red' | 'green' | 'regression'; output_sha256: string; identity?: TestIdentity | null; identity_alias?: { path: string; sha256: string } | null };
  /** The RED that drove the behaviour: its output hash, and its record with the output archived, when it is kept. */
  red: { output_sha256: string; record: EvidenceRecord | null } | null;
  /** The judged history of the completing generation. */
  history: { output_path: string; output_sha256: string } | null;
  /** A re-proof (basis `reproved`): the red gate that passed the review's reproduction on the unchanged base, archived. */
  reproof: { gate_output_sha256: string; tests: { test_id: string; path: string; full_name: string }[]; files: { path: string; sha256: string; archived: string }[]; /** The re-proof unit settle committed it in (absent before CSET-201 final: never committed). */ commit?: string } | null;
  /** The record's archive directory (relative to the control root), or null for a record derived from history. */
  archive: string | null;
  /** Derived from a rework history entry of a state from before the ledger. */
  migrated?: boolean;
}

/**
 * A completed criterion that a generation's base no longer holds as it was completed (engine/criterion-ledger.ts):
 * found by revalidating its record on the new authoritative head, before any worker ran. Ordered again (or, for a
 * criterion the order already named, its completed proof withdrawn), never charged.
 */
export interface ReopenedCriterion {
  criterion: string;
  record_id: string;
  code: string;
  detail: string;
  base_sha: string;
  at: string;
}

/** A completed criterion's record revalidated on a claim's base: what was checked and found. */
export interface CompletionRevalidation {
  base_sha: string;
  at: string;
  /** The module run on the base that checked each record's test (absent: nothing needed running, or it could not run). */
  run: { output_path: string; output_sha256: string; exit_code: number; results_sha256: string | null } | null;
  verdicts: { criterion: string; record_id: string; ok: boolean; code: string | null }[];
}

/** What a dispatch lease is for (state/orchestration.ts). */
export type DispatchLeaseKind = 'worker' | 'verification' | 'candidate' | 'e2e' | 'review';

/** How a dispatch lease ended; `active` while it lasts. */
export type DispatchLeaseStatus = 'active' | 'settled' | 'revoked' | 'abandoned' | 'released' | 'stale' | 'interrupted-provider' | 'interrupted-agent';

/**
 * A launched reviewer interrupted before it completed (CSET-203 r13): past
 * its wall-clock from its launch (`timeout`), its host session's process
 * gone (`host-ended`), its task ended otherwise (`ended`, with Claude Code's
 * status of it), or its launch failed (`launch-failed`). Its Agent call, its
 * agent by hash, when it was launched, how long it ran of its wall-clock.
 * Never a prompt or an answer.
 */
export interface AgentInterruptMark {
  reason: 'timeout' | 'host-ended' | 'ended' | 'launch-failed';
  status: string | null;
  tool_use_id: string;
  agent_id_sha256: string | null;
  launched_at: string;
  elapsed_ms: number;
  timeout_ms: number;
  at: string;
}

/**
 * The host session a dispatch was handed to, as the plugin's fence saw it
 * run `dispatch` (hooks/provider-binding.ts): its id and its transcript.
 * What a provider failure of that host is read from (engine/provider-interrupt.ts).
 */
export interface HostSessionBinding {
  session_id: string;
  /** '/'-separated, absolute. */
  transcript_path: string;
  bound_at: string;
}

/**
 * A transient model-provider failure that ended a lease's holder (CSET-203
 * r10), as Claude Code recorded it: its class, the sanitized request id and
 * category, where it was read and of which session. Never a prompt or a reply.
 */
export interface ProviderMark {
  class: string;
  request_id: string | null;
  category: string | null;
  /** `host-transcript`: the host session that dispatched it; `agent-transcript`: the worker or reviewer subagent itself. */
  source: 'host-transcript' | 'agent-transcript';
  session_id: string | null;
  at: string;
}

/** The provider interruptions of a feature: each one, the counts that bound them, and a stop past them. */
export interface ProviderLedger {
  /** Newest last, at most 32: what was interrupted, by what, and what was done with it. */
  interruptions: (ProviderMark & { lease_id: string; kind: DispatchLeaseKind; node_id: string | null; review_id: string | null; ticket: string; phase: string; action: 'released' | 'resumable' | 'review-reissue' })[];
  /** Interruptions per logical ticket (a node's generation and attempt, a review's generation kind). */
  tickets: Record<string, number>;
  /** Interruptions per phase (as the notifier names it; `session` otherwise). */
  phases: Record<string, number>;
  /** Set past the bounds: the feature stops until a person clears it (`session provider-reset`). */
  unavailable: { code: 'PROVIDER_UNAVAILABLE'; at: string; reason: string } | null;
}

/**
 * One claim generation (a host dispatch, a resume's, a controller run) or one
 * review generation, from its issue to its close, in the feature's durable
 * dispatch registry (state/orchestration.ts).
 */
export interface DispatchLease {
  /** The dispatch generation's id, else the claim's. */
  lease_id: string;
  kind: DispatchLeaseKind;
  node_id: string | null;
  review_id: string | null;
  /** A review generation that refines a settled review. */
  refinement?: boolean;
  claim_id: string | null;
  dispatch_id: string | null;
  /** The generation's capability, by hash: how a late answer is recognised. */
  capability_sha256: string | null;
  /** The orchestration epoch and the node's lineage when it was issued. */
  epoch: number;
  lineage: number;
  /** The node's rework generation (a review's: its generation) when it was issued. */
  generation: number;
  status: DispatchLeaseStatus;
  issued_at: string;
  closed_at: string | null;
  closed_reason: string | null;
  /** Settled: the outcome, and the epoch the feature was at once it settled. */
  outcome?: string;
  settled_epoch?: number;
  /** A host dispatch: the worktree and result file its worker writes. */
  worktree?: string | null;
  result_file?: string | null;
  /** Late answers refused as stale: when, why, and each result archived (once per content). */
  stale?: { at: string; reason: string; archived: { path: string; sha256: string }[] } | null;
  /** The host session it was handed to (a host dispatch, a review generation). */
  host?: HostSessionBinding | null;
  /** `interrupted-provider`: the provider failure that ended its holder. */
  provider?: ProviderMark | null;
  /** `interrupted-agent`: why its reviewer was interrupted before it completed. */
  agent?: AgentInterruptMark | null;
}

/** The feature's orchestration epoch and dispatch registry (state/orchestration.ts). */
export interface OrchestrationState {
  /** Monotonic; moved in the same write as each change of what a review or a candidate binds. */
  epoch: number;
  /** The last bumps, newest last. */
  bumps: { epoch: number; reason: string; at: string; nodes?: string[] }[];
  /** Every active lease, and the newest closed ones. */
  leases: DispatchLease[];
  /** Model-provider failures of lease holders, and their bounds (CSET-203 r10). */
  provider?: ProviderLedger | null;
}

/**
 * A review-origin rework's worker answered BLOCKED REVIEW_GAP_NOT_REPRODUCED
 * (or INVALID_RED_EVIDENCE: behaviour already present) while its red gate
 * had passed every test it declared: the claim is held, no attempt charged,
 * and the next generation is asked to submit the structured challenge
 * (engine/review-challenge.ts). Once per claim.
 */
export interface ChallengeConversion {
  /** The refused answer's fingerprint and the generation that gave it. */
  fingerprint: string;
  from_dispatch_id: string | null;
  /** The controller copy of that answer, by SHA-256. */
  result_sha256: string;
  /** The red gate's output whose declared tests all passed (claim.challenge_red); a capsule's run output when the material is a capsule. */
  gate_output_sha256: string;
  /** The passing reproduction capsule of the claim that is the challenge's material (CSET-203 r17), when there is one. */
  capsule_id?: string | null;
  at: string;
}

/** A reproduction capsule a claim sealed, as its registry holds it (engine/reproduction-capsule.ts). */
export interface CapsuleRegistryEntry {
  capsule_id: string;
  /** SHA-256 of its receipt as sealed: the receipt read back must hash to it. */
  capsule_sha256: string;
  /** Its receipt, relative to the control root: features/<f>/evidence/<node>/capsules/<id>/capsule.json. */
  receipt_path: string;
  criterion: string;
  result: 'passed' | 'failed';
  /** The revision of the review order it was sealed for. */
  revision: number;
  /** The capability (by hash) of the holder that sealed it. */
  capability_sha256: string;
  registered_at: string;
  /** Carried to a rebased order: the capsule it was sealed as first. */
  carried_from?: { capsule_id: string; capsule_sha256: string } | null;
}

/** A criterion item settle accepted, as STATE.json keeps it. */
export interface AcceptedCriterionRecord {
  criterion: string;
  test_id: string | null;
  /** The test as its report named it (raw: the framework's full name, a JUnit test's class and method). */
  test: { path: string; name: string } | null;
  gate: 'red' | 'green' | 'regression';
  output_sha256: string;
  /** The test's canonical identity, versioned, resolved against the submitted head (evidence/test-identity.ts; PCM-101 final). */
  identity?: TestIdentity | null;
  /**
   * How a test published before identities were (its results carry none) maps to its canonical identity at the
   * submitted head: the raw name, the declaration it resolved to, and — once settle writes it — the immutable receipt.
   */
  identity_alias?: TestIdentityAlias | null;
  carried?: boolean;
  carried_from?: { generation: number; gate: 'red' | 'green' | 'regression'; output_sha256: string; claim_id: string | null; dispatch_id: string | null; repo_sha: string | null; record_id?: string | null };
  /** A criterion a per-criterion answer challenged (engine/criterion-outcomes.ts): its prior proof, carried while the challenge waits. */
  challenge_id?: string;
  /**
   * An ordered criterion completed before (CSET-203 r16): its completed proof carried (`carried`), and the review's
   * reproduction shown passing on the unchanged base by a red gate of this claim — never a RED, never committed.
   */
  reproof?: { gate_output_sha256: string; tests: { test_id: string; path: string; full_name: string }[] } | null;
  /**
   * A RED promoted from a failing reproduction capsule (CSET-203 r17): the capsule that ran the review's exact
   * reproduction on the unchanged base and failed, its files committed test-first and failed again by the red gate.
   */
  capsule?: { capsule_id: string; capsule_sha256: string; result: 'failed' } | null;
}

/**
 * A new behaviour's proof carried over a rework: the criterion, its test, the
 * generation and claim that settled it, the repository commit integrated
 * then, and the gate output (archived under `replaced/g<n>/`) it cited.
 */
export interface CarriedCriterionProof {
  criterion: string;
  test_id: string;
  test: { path: string; name: string };
  source_generation: number;
  source_claim_id: string | null;
  source_dispatch_id: string | null;
  repo_sha: string | null;
  gate: 'red' | 'green' | 'regression';
  output_sha256: string;
  output_path: string;
  /** The completion record it is (engine/criterion-ledger.ts), and that record's hash. Absent: a proof carried before the ledger. */
  record_id?: string | null;
  record_sha256?: string | null;
  /**
   * The order names this criterion again (a review gap of a criterion already completed): the proof is its completed
   * one, re-provable — the review's reproduction passing on the unchanged base shows it holds (CSET-203 r16).
   */
  ordered?: boolean;
}

export interface TddRedBinding {
  head_sha: string;
  tests: { path: string; blob: string | null }[];
  tests_sha256: string;
  evidence_sha256: string | null;
  recorded_at: string;
  /** The tests the RED declared, by canonical id (evidence/test-ids.ts), and how each ended. */
  red_tests?: { id: string; path: string; full_name: string; status: string; category: string; identity?: TestIdentity }[];
}

/**
 * A submission held because only its criterion evidence was refused
 * (engine/criteria.ts): its code, history and gates are settled, nothing is
 * charged or integrated, and the holder of the claim's capability resubmits
 * the same commit with corrected evidence.
 */
export interface EvidenceCorrection {
  /** The refusal: a CRITERION_* code. */
  code: string;
  detail: string;
  /** The criterion the refusal names, its kind and the gate its evidence needs (engine/criteria.ts requiredGate). */
  criterion?: string | null;
  kind?: CriterionKind | null;
  required_gate?: 'red' | 'green' | 'green or regression' | null;
  /**
   * A new behaviour no RED of the node proved: the holder may add one focused
   * RED cycle on the same claim and worktree (its gates open again) and
   * resubmit; settle judges the whole history again. Otherwise metadata only.
   */
  cycle?: boolean;
  /** Bound tests the evidence could name instead, by canonical id. */
  candidates: { id: string; path: string; full_name: string; status: string; gate: 'red' | 'green' | 'regression' }[];
  /** Corrections spent so far (refused resubmissions, answers that proved nothing); the hold ends as a failed attempt at the limit. */
  corrections: number;
  /** The held submission (the controller copy's SHA-256) and the commit it named, sealed. */
  result_sha256: string;
  commit_sha: string;
  at: string;
  /**
   * What the held commit was gated with, restored whenever a correction ends
   * at that same commit: a gate a correction ran (and was refused) never
   * replaces the held submission's evidence.
   */
  held?: { state: NodeState; evidence: Partial<Record<EvidenceKind, EvidenceRecord>>; bindings: number } | null;
  /**
   * The canonical test identity version (evidence/test-identity.ts) the refusal was judged under. Absent: judged before
   * canonical identities (PCM-101 final), so an identity refusal of it is re-evaluated once, administratively.
   */
  identity_version?: string;
}

/**
 * A submission re-evaluated administratively because the refusal it stood on was an identity-shape mismatch the
 * canonical identity resolves (PCM-101 final): a held correction judged under the old, runner-incompatible comparison,
 * or a worker's BLOCKED answer that named that refusal. Bound to the exact controller copy of the answer; no product
 * attempt, worker dispatch or correction is spent; the receipt is written once the evidence is accepted.
 */
export interface IdentityReconcile {
  cause: 'evidence-correction' | 'worker-blocked';
  /** The refusal it stood on: the hold's code and detail, or the identity code the worker's fingerprint names. */
  refused: { code: string; detail: string };
  /** The worker's failure fingerprint (a BLOCKED answer). */
  fingerprint: string | null;
  /** The controller copy of the answer, by file name (the node's sessions directory) and SHA-256, and the dispatch that wrote it. */
  result_file: string;
  result_sha256: string;
  from_dispatch_id: string | null;
  at: string;
  receipt?: { path: string; sha256: string } | null;
}

/** Pointer to a verified history record (engine/tdd-history.ts) written as evidence. */
export interface TddHistoryRecord {
  ok: boolean;
  base_sha: string;
  head_sha: string;
  cycles: number;
  /** Compatibility-regression units (engine/tdd-history.ts): tests alone proving existing behaviour, apart from the RED cycles. */
  compatibility_units?: number;
  code: string | null;
  policy_sha256: string;
  output_path: string;
  output_sha256: string;
  verified_at: string;
}

export interface TddRejection {
  code: string;
  commit: string | null;
  detail: string;
  head_sha: string;
  /** Where the refused branch is kept: its next claim archives it there and starts afresh. */
  archived_ref: string;
  /** The refused history record, relative to the control root; the attempt's evidence lies beside it. */
  evidence_path: string;
  evidence_sha256: string;
  attempt: number;
  at: string;
}

/** The test-path policy a claim was dispatched with (engine/tdd-history.ts). */
export interface ClaimTddPolicy {
  test_paths: string[];
  production_roots: string[];
  declaration_paths: string[];
  source: 'repository' | 'default';
  sha256: string;
}

/**
 * What a settle bound before it changed anything: the exact commit it
 * verifies and the history it judged. A settle that dies after sealing is
 * finished from the seal, never re-judged against a moved branch.
 */
export interface SettlementSeal {
  dispatch_id: string | null;
  head_sha: string;
  base_sha: string | null;
  policy_sha256: string | null;
  sealed_at: string;
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
  /** Who found the work wrong, when it was not a person: the acceptance review (engine/acceptance-review.ts). */
  origin?: ReworkOrigin;
  /**
   * False when the rework names compatibility criteria only: the code is in
   * the generation's base, so it proves itself with a compatibility-regression
   * unit and no RED. Absent: the generation needs its own RED.
   */
  red_required?: false;
  /**
   * An acceptance review's rework: each gap's criterion and the SHA-256 of its
   * exact public reproduction, as the review's receipt holds it. A
   * review-gap challenge binds them (engine/review-challenge.ts).
   */
  review_gaps?: { criterion: string; reproduction_sha256: string }[];
  /**
   * Each time the order was rebased to a later revision of its review, its
   * gaps carried unchanged (engine/review-revision.ts), oldest first. The
   * same records as its history entry's.
   */
  rebases?: ReworkRebase[];
  /**
   * Completed criteria its claim's base no longer holds as completed (engine/criterion-ledger.ts), oldest first:
   * each one ordered by this generation's own proof now, never charged.
   */
  reopened?: ReopenedCriterion[];
}

/** A rework the controller ordered on its own finding: an acceptance review's GAP. */
export interface ReworkOrigin {
  kind: 'acceptance-review';
  review_id: string;
  /** The review's ordinal since the last accepted delivery. */
  review: number;
  /** A gap a fresh reviewer refined (or upheld) after a challenge of it: the challenge and its round. */
  refinement?: { challenge_id: string; round: number };
  /** An order restoring completed proofs the reviewed heads lost (CSET-201 final): never an accepted rework of their criteria. */
  restoration?: { criterion: string; record_id: string; code: string | null }[];
  /**
   * The revision of the review the order is bound to (engine/review-revision.ts):
   * 0 its original receipt, n its n-th refinement's, with that receipt. Absent:
   * an order from before revisions, bound to the revision its evidence names.
   */
  revision?: number;
  receipt_path?: string;
  receipt_sha256?: string;
}

/** A revision of an acceptance review: 0 its original receipt, n its n-th refinement's, pinned by its SHA-256. */
export interface ReviewRevisionRef {
  revision: number;
  receipt_path: string;
  receipt_sha256: string;
}

/**
 * A retained gap carried from one revision of a review to a later one: its
 * criterion, the SHA-256 of its exact reproduction and its normalized
 * fingerprint unchanged, and the producers it maps to in each (the node
 * carried among them in both).
 */
export interface CarryProof {
  criterion: string;
  reproduction_sha256: string;
  fingerprint: string;
  from_targets: string[];
  to_targets: string[];
}

/**
 * A review rework's order rebased from one revision of its review to a later
 * one (CSET-203 r14): every gap it orders carried unchanged, its generation,
 * attempts and reason the same. `by`: the refinement that made the revision,
 * in its own write, or a reconciliation of an order STATE.json still bound to
 * an older one. `claim`: the live claim reissued with it. Bound by `sha256`,
 * the SHA-256 of the record without it.
 */
export interface ReworkRebase {
  review_id: string;
  from: ReviewRevisionRef;
  to: ReviewRevisionRef;
  criteria: string[];
  carry: CarryProof[];
  by: 'refinement' | 'reconcile';
  claim: { claim_id: string; from_dispatch_id: string | null; to_dispatch_id: string } | null;
  at: string;
  sha256: string;
}

/**
 * What a DONE generation was, kept with the rework that replaced it when an
 * acceptance review ordered that rework: a valid review-gap challenge puts the
 * node back exactly so (engine/review-challenge.ts), its evidence pointing at
 * the archived copies the rework made.
 */
export interface RestorableGeneration {
  state: 'DONE';
  attempts: number;
  failure_counts: Record<string, number>;
  last_failure_fingerprint: string | null;
  integrated_sha: string | null;
  branch_base_sha: string | null;
  evidence: Partial<Record<EvidenceKind, EvidenceRecord>>;
  criteria: AcceptedCriterionRecord[];
  tdd_history: TddHistoryRecord | null;
  tdd_red_bindings: TddRedBinding[];
  last_settlement: SettlementReceipt | null;
  carried_criterion_proofs: CarriedCriterionProof[];
  worktree_setup: WorktreeSetupState | null;
}

/**
 * What a red gate saw when the tests a RED declared all passed on the
 * claim's unchanged base during an acceptance review's rework: the material
 * of a review-gap challenge. The declared test files by blob, copied (as they
 * ran) under the node's evidence, and the tests by canonical id.
 */
export interface ChallengeRedSnapshot {
  /** output_sha256 of the red gate's evidence. */
  evidence_sha256: string;
  head_sha: string;
  tests: { path: string; blob: string | null }[];
  red_tests: { id: string; path: string; full_name: string; status: string }[];
  /** Each declared test file as it ran: its blob, its controller-owned copy (relative to the control root) and that copy's SHA-256. */
  files: { path: string; blob: string; copy: string; sha256: string }[];
  recorded_at: string;
  /**
   * A red gate the gate accepted (a RED: some declared test failed for a missing behaviour) whose other declared
   * tests passed: the passing ones are what a per-criterion challenge cites. Absent: a red gate refused because
   * every declared test passed.
   */
  accepted?: boolean;
  /** The gate's output and results as they ran, copied beside the files (a later red gate writes the same names). */
  gate?: { output_path: string; output_sha256: string; results_path: string | null; results_sha256: string | null; exit_code: number; commit_sha: string | null; red_category: string | null; module_sha256: string | null; plan_sha256: string | null };
}

/** A per-criterion answer, judged, on the claim until the node is DONE (engine/criterion-outcomes.ts). */
export interface CriteriaSettlement {
  /** The controller copy of the answer, by SHA-256, and the head it was judged at. */
  result_sha256: string;
  head_sha: string;
  done: string[];
  challenged: string[];
  unresolved: UnresolvedCriterionRecord[];
  /** Each challenged criterion's prior proof, carried while its challenge waits. */
  carried: AcceptedCriterionRecord[];
  /** The order it answers, as the live brief bound it (DONE clears the brief). */
  order: PartialOrderBinding;
  at: string;
}

/** The order a per-criterion answer settled, as its brief bound it: the review, its revision, each gap's exact reproduction. */
export interface PartialOrderBinding {
  review_id: string;
  review: number;
  revision: number | null;
  receipt_path: string | null;
  receipt_sha256: string | null;
  refinement: { challenge_id: string; round: number } | null;
  review_gaps: { criterion: string; reproduction_sha256: string }[];
  evidence: string[];
}

/** An ordered criterion a per-criterion answer left unresolved, with its own reason. */
export interface UnresolvedCriterionRecord {
  criterion: string;
  outcome: 'BLOCKED' | 'NEEDS_DECISION';
  reason: string;
  decision_request: { question: string; options: string[]; category?: string } | null;
}

/**
 * What a per-criterion answer made of the order it settled (CSET-203 r15): the criteria it proved DONE (the node's
 * new generation), those it challenged (one challenge, pending a refinement), those it left unresolved (ordered again
 * on their own, parked with their reasons, when no challenge waits — `follow_up`). The order stood: it is the
 * generation the node is DONE on.
 */
export interface PartialOrderRecord {
  claim_id: string;
  dispatch_id: string | null;
  done: string[];
  challenged: string[];
  unresolved: UnresolvedCriterionRecord[];
  challenge_id: string | null;
  /** The unresolved criteria's own order: still to be made (`pending`), made (`ordered`), or none. */
  follow_up: 'pending' | 'ordered' | null;
  /** The order it settled, as its brief bound it: the follow-up is ordered from exactly this. */
  order: PartialOrderBinding;
  at: string;
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
  /** The generation the rework replaced (0: the node's first work) and the claim and dispatch that settled it. */
  generation?: number;
  claim_id?: string | null;
  dispatch_id?: string | null;
  /** What that generation was settled with, archived: never active in the next one. */
  criteria?: AcceptedCriterionRecord[];
  tdd_history?: TddHistoryRecord | null;
  red_bindings?: TddRedBinding[];
  settlement?: SettlementReceipt | null;
  /** An acceptance review's rework: the DONE generation it replaced, whole, for a valid challenge to restore. */
  restore?: RestorableGeneration | null;
  /**
   * A valid review-gap challenge closed this rework: the generation it
   * replaced was restored and the rework counts for nothing (no generation,
   * no REWORK_LIMIT); the challenge's record says what came of it.
   */
  challenged?: { challenge_id: string; at: string } | null;
  /**
   * An acceptance review's rework: each DONE product dependent it reopened,
   * whole as it was (with its worker branch head), for a valid challenge of
   * the rework to restore with the node (CSET-203 r7).
   */
  restore_dependents?: Record<string, RestorableGeneration & { branch_head: string | null }> | null;
  /** The rebases of this order to later revisions of its review (the brief's, recorded with its rework). */
  rebases?: ReworkRebase[];
  /**
   * A later revision of the review changed this order's gaps (CSET-203 r14):
   * `amend`, replaced in the same write by an order of what the revision
   * keeps; `cancel`, every gap of it withdrawn, the generation it replaced
   * restored. Like a challenged rework it counts for nothing.
   */
  superseded?: { review_id: string; revision: number; action: 'amend' | 'cancel'; at: string; reason: string } | null;
  /** A per-criterion answer settled this order (CSET-203 r15): what each of its criteria came to. */
  partial?: PartialOrderRecord | null;
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
  /**
   * Delivered base branches that had moved on top of the integration branch
   * (someone committed on them after the delivery): the rework fast-forwarded
   * the integration branch to them, so the repair starts from the base as it
   * is and its candidate delivers by fast-forward again.
   */
  adopted_bases?: AdoptedBase[];
  /** The acceptance review whose GAP ordered it. */
  origin?: ReworkOrigin;
}

/** A base branch a rework adopted: the integration branch moved from `from` (where the controller left it) to `to` (the base's tip). */
export interface AdoptedBase {
  repository: string;
  base_branch: string;
  from: string;
  to: string;
}

export type ClaimMode = 'adapter' | 'host' | 'manual' | 'controller';

/** A re-proof unit, as the claim that settled it binds it. */
export interface ReproofUnitRecord {
  /** The worker's sealed head the unit sits on. */
  from: string;
  commit: string;
  criteria: string[];
  files: { path: string; blob: string }[];
  /** The red gate outputs whose snapshots it commits. */
  gate_outputs: string[];
  at: string;
}

/** An uncharged refusal to integrate a node's work that would lose a sibling's standing proof (engine/criterion-coverage.ts). */
export interface SiblingProgressRecord {
  code: 'SIBLING_PROGRESS_LOST';
  cause: 'stale-base' | 'delta' | 'conflict';
  generation: number;
  count: number;
  lost: { node_id: string; criterion: string; record_id: string; code: string | null }[];
  conflicts: string[];
  head: string;
  from: string;
  detail: string;
  at: string;
}

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
  /** The test-path policy the claim was dispatched with; gates and settle judge by it. */
  tdd_policy?: ClaimTddPolicy;
  /** What the settle of this claim bound before changing anything. */
  seal?: SettlementSeal | null;
  /**
   * The re-proof unit settle committed on top of the sealed head (engine/proof-units.ts; CSET-201 final): journaled before
   * the node branch moves to it, so an interrupted settle finishes at exactly that commit.
   */
  reproof_unit?: ReproofUnitRecord | null;
  /** The worktree setup that prepared the claim's worktree; fresh verification sets its checkout up the same way. */
  worktree_setup?: ClaimWorktreeSetup;
  /** The module command the claim's gates and fresh verification run (a module verifier's node only). */
  verification?: ClaimVerification;
  /** The approved criteria the claim serves (engine/acceptance.ts): the feature's manifest and the node's criteria, by hash. */
  acceptance?: { manifest_sha256: string | null; criteria_sha256: string };
  /** Set while the submission is held for criterion evidence correction (engine/criteria.ts). */
  evidence_correction?: EvidenceCorrection | null;
  /** Set while the claim's answer is re-evaluated administratively for an identity-shape refusal (PCM-101 final). */
  identity_reconcile?: IdentityReconcile | null;
  /** The last red gate of an acceptance review's rework whose declared tests all passed: what a review-gap challenge cites. */
  challenge_red?: ChallengeRedSnapshot | null;
  /**
   * Every red gate of an acceptance review's rework, on this claim, with a declared test that passed — accepted REDs
   * among them (CSET-203 r15: one red gate failed AC-3's reproduction and passed AC-4's): what a per-criterion
   * challenge cites, oldest first.
   */
  challenge_reds?: ChallengeRedSnapshot[];
  /**
   * A per-criterion answer judged (engine/criterion-outcomes.ts) and on its way to DONE: what each ordered criterion
   * came to, so a settle interrupted after integration records exactly it.
   */
  criteria_settlement?: CriteriaSettlement | null;
  /**
   * The sealed head this claim's criterion evidence was judged and accepted at: a settle interrupted after it (fresh
   * verification replaced the worker's green and regression records) finishes at that judgement, never judges again.
   */
  criteria_judged?: string | null;
  /**
   * `tdd cycle`: the worker declared a new complete RED cycle after
   * production began, at this head. Its RED-bound test files may change for
   * the cycle's RED; the next accepted RED binds them anew and ends it.
   */
  cycle_declared?: { head_sha: string; at: string } | null;
  /**
   * The orchestration epoch and the node's lineage and rework generation the
   * claim was issued at (state/orchestration.ts), and the kind of its lease.
   * A settle whose node's lineage moved since is STALE_ORCHESTRATION_EPOCH.
   */
  epoch?: number;
  lineage?: number;
  generation?: number;
  lease_kind?: DispatchLeaseKind;
  /** A legacy BLOCKED answer converted, once, into a request for the structured challenge. */
  challenge_conversion?: ChallengeConversion | null;
  /**
   * The reproduction capsules this claim's capability holder sealed (engine/reproduction-capsule.ts), oldest first:
   * each one's id, receipt and the receipt's hash. Only a capsule this registry holds is ever used by the claim.
   */
  capsules?: CapsuleRegistryEntry[];
  /** The completed criteria this generation relies on, revalidated on the claim's base before any worker ran. */
  revalidation?: CompletionRevalidation | null;
  /**
   * The claim's order was rebased to a later revision of its review while the
   * claim was held (CSET-203 r14): the generation's old capability is rotated
   * away and the next dispatch reissues it from where it stands — its
   * worktree, commits and gates — never charged. Cleared when it is handed out.
   */
  review_rebase?: { review_id: string; from_revision: number; to_revision: number; from_dispatch_id: string | null; rebase_sha256: string; at: string } | null;
  /** The host session the current generation was handed to (hooks/provider-binding.ts). */
  host_session?: HostSessionBinding | null;
  /**
   * The generation's holder was ended by a transient model-provider failure
   * after the worker had made progress (commits, gates): the claim is kept
   * for the same generation to resume, its old capability already rotated
   * away. Cleared when `dispatch` (or `dispatch --resume`) hands it out again.
   */
  provider_interrupted?: (ProviderMark & { from_dispatch_id: string | null; progress: ProviderProgress }) | null;
  /**
   * Set while a settle is verifying, so a second settle cannot run
   * concurrently. Names the settling process by identity (start, boot), so
   * a marker a dead settle left is seen through even where its pid now
   * names another process (engine/settler.ts).
   */
  settling?: { pid: number; host: string; started_at: string; start?: string; boot?: string | null } | null;
}

export interface SettlementReceipt {
  capability_sha256: string;
  claim_id: string;
  outcome: string;
  state: NodeState;
  detail: string;
  settled_at: string;
  /** The dispatch generation the settled claim answered. */
  dispatch_id?: string | null;
  /** The worktree setup configuration (SHA-256) the settled claim was bound to. */
  worktree_setup_sha256?: string;
  /** The module descriptor (SHA-256) the settled claim was bound to. */
  module_sha256?: string;
  /** The controller copy of the answer the settlement concluded (the node's sessions directory), by name and SHA-256. */
  result_file?: string | null;
  result_sha256?: string | null;
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
  /** Durable source/copy inventory for a completed producer imported from a separately pinned control. */
  completion_imports?: {
    node_id: string;
    source_state_sha256: string;
    source_graph_sha256: string;
    repository: string;
    integration_sha: string;
    files: { path: string; sha256: string }[];
  }[];
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
  /** The approved acceptance manifest (engine/acceptance.ts) the feature was initialised with, by its hash. */
  acceptance?: { path: string; sha256: string } | null;
  /**
   * The independent acceptance review between the last product node and the
   * candidate (engine/acceptance-review.ts): its policy, fixed at feature
   * init, the review in flight and every settled one. Absent: a feature
   * initialised before the review existed, which has none.
   */
  acceptance_review?: AcceptanceReviewState | null;
  /** The orchestration epoch and the dispatch lease registry (state/orchestration.ts). Absent: epoch 0, no registry yet. */
  orchestration?: OrchestrationState | null;
  /**
   * Every stale evidence pointer the controller repaired from an exact archive (engine/evidence-integrity.ts), each
   * bound by its receipt's hash. Absent: a feature none was ever repaired for.
   */
  evidence_repairs?: EvidenceRepairEntry[];
  /** A delivery refused for evidence no exact archive restores: administrative, never a product rework. */
  evidence_repair?: EvidenceRepairRequired | null;
}

/** Where an evidence repair took the bytes it restored: an archive the node's own records attest. */
export type EvidenceRepairSourceKind = 'replaced-generation' | 'ledger-archive' | 'challenge-snapshot';

/**
 * One stale pointer restored (engine/evidence-integrity.ts): the bytes a record named at `from_path` (`sha256`),
 * copied from an exact archive to a new immutable `to_path`; the receipt (its hash here) says from where and why.
 */
export interface EvidenceRepairEntry {
  repair_id: string;
  node_id: string | null;
  /** The references the copy stands for, by key (one path and hash may be named by several records). */
  refs: string[];
  from_path: string;
  sha256: string;
  to_path: string;
  source: { kind: EvidenceRepairSourceKind; path: string };
  receipt_path: string;
  receipt_sha256: string;
  at: string;
}

/** Evidence of the delivered state no exact archive restores: delivery fails closed until the controller repairs it. */
export interface EvidenceRepairRequired {
  status: 'REQUIRED';
  candidate_id: string | null;
  nodes: string[];
  problems: string[];
  at: string;
}

/** What a review binds: every registered repository's head, the graph, the approved criteria. */
export interface ReviewInputs {
  feature_id: string;
  graph_sha256: string;
  /** criteriaSha256 of the approved criteria (id, kind, text hash). */
  criteria_sha256: string;
  /** The bytes of features/<f>/ACCEPTANCE.json, when the feature has one. */
  manifest_sha256: string | null;
  /** Sorted by name: the integration branch's trusted head, or the base branch's tip where nothing was integrated. */
  repositories: { name: string; head_sha: string }[];
}

/** One reason a reviewer's verdict was refused, at the field it concerns (engine/acceptance-review.ts VerdictProblem). */
export interface ReviewProblem {
  code: string;
  /** RFC 6901 JSON pointer into the verdict as written. */
  pointer: string;
  detail: string;
  /** The bound the field is over. */
  limit?: number;
  /** What kind of content was refused (never the value itself). */
  kind?: 'control' | 'unicode' | 'credential' | 'authority' | 'instruction';
  /** A trace to complete: the evidence ids the packet offers for its criterion. */
  candidates?: string[];
}

/** A review ticket's generation in flight: handed to a reviewer subagent, not settled yet. */
/** What a worker had made when its holder was interrupted: what its resumed generation continues from. */
export interface ProviderProgress {
  state: string;
  base_sha: string | null;
  head_sha: string | null;
  commits: number;
  /** Uncommitted paths in the worktree, as they were (never trusted, never settled). */
  dirty: string[];
}

export interface OpenReview {
  review_id: string;
  /** This generation; a resume or a retry issues a new one and the earlier one's verdict stops counting. */
  dispatch_id: string;
  /** SHA-256 of the generation's capability (`review settle --capability`). */
  capability_sha256: string;
  inputs: ReviewInputs;
  inputs_sha256: string;
  /** The packet, relative to the control root, and its SHA-256. */
  packet_path: string;
  packet_sha256: string;
  /** The verdict file the reviewer writes, relative to the control root. */
  slot: string;
  /** The ordinal of this review since the last accepted delivery. */
  review: number;
  /** Generations of this review so far (1 for the first); refused verdicts are bounded. */
  attempt: number;
  /**
   * Verdicts of earlier generations refused, oldest first. `format`: a verdict refused for its form, kept in its slot
   * (`verdict`, relative to the control root) for the next generation to correct, with its problems; `review` (or
   * absent, in older records): a generation that left no verdict to correct.
   */
  refused: {
    dispatch_id: string;
    code: string;
    detail: string;
    at: string;
    kind?: 'format' | 'review';
    verdict?: string;
    problems?: ReviewProblem[];
  }[];
  issued_at: string;
  expires_at: string;
  /**
   * A refinement of a settled review (`review_id`) a valid challenge asked
   * for, rather than a review of its own: the challenges it decides, its
   * round, and the receipt and inputs of the review it refines.
   */
  refinement?: OpenRefinement | null;
  /** The orchestration epoch it was issued at: a verdict settled after the epoch moved is stale, never recorded. */
  epoch?: number;
  /** The host session it was handed to (hooks/provider-binding.ts). */
  host_session?: HostSessionBinding | null;
  /** Its reviewer (or host) was ended by a transient model-provider failure: revoked, and re-issued by the next dispatch. */
  provider_interrupted?: ProviderMark | null;
  /** Its reviewer was interrupted before it completed (CSET-203 r13): revoked, and re-issued by the next dispatch, nothing spent. */
  agent_interrupted?: AgentInterruptMark | null;
  /** Reviewer interruptions of this review so far, carried by each generation re-issued for one (MAX_REVIEWER_INTERRUPTIONS). */
  interruptions?: number;
}

/**
 * What a review PASS was settled with (CSET-203 r7): the orchestration epoch
 * after its settlement, no dispatch lease outstanding, every node it judges
 * DONE. It binds a candidate only while the epoch is still this one.
 */
export interface ReviewBarrier {
  epoch: number;
  at: string;
  /** Leases outstanding when it was settled: none, or it is no PASS. */
  leases: string[];
  nodes_done: boolean;
}

/** What a refinement generation decides (engine/acceptance-review.ts judgeRefinement). */
export interface OpenRefinement {
  /** The highest challenge round among its challenges. */
  round: number;
  challenges: { challenge_id: string; challenge_sha256: string; criteria: string[]; node_id: string }[];
  /** The receipt of the review it refines, as STATE.json pinned it when the refinement was issued. */
  of_receipt_path: string;
  of_receipt_sha256: string;
  of_inputs_sha256: string;
}

/** A settled review: what its verdict said, its receipt, and the reworks it ordered. */
export interface ReviewRecord {
  review_id: string;
  dispatch_id: string;
  /** The capability of the generation that settled it, by hash: the same settle again is answered, not re-run. */
  capability_sha256: string;
  review: number;
  overall: 'PASS' | 'GAPS';
  inputs_sha256: string;
  /** Relative to the control root. */
  receipt_path: string;
  receipt_sha256: string;
  at: string;
  /** GAPS: the producer nodes it reworks, dependents first, and whether every one was. */
  reworks: string[];
  reworks_applied: boolean;
  /**
   * Set when the gaps could not be reworked (rounds spent, no owner, a refused rework): the feature is blocked.
   * CHALLENGED: a worker's valid challenge contradicts one of its gaps; it authorises nothing until a fresh
   * reviewer refines it. WITHDRAWN: a refinement withdrew every gap, but the heads it reviewed moved: a new review follows.
   */
  outcome: 'PASS' | 'GAPS' | 'REVIEW_GAPS' | 'CHALLENGED' | 'WITHDRAWN' | 'REPEATED' | 'REVIEW_NONCONVERGENT' | 'REGRESSION';
  /** The coverage manifest its receipt pins (engine/criterion-coverage.ts; CSET-201 final): every standing completion at its heads. */
  coverage_sha256?: string;
  /** Each refinement of the review, oldest first: the receipt fields above are the latest one's. */
  refinements?: ReviewRefinementRecord[];
  /** The review's current revision (engine/review-revision.ts): 0 its original receipt, n after its n-th refinement. */
  revision?: number;
  /** Before its first refinement: the receipt it was settled with. */
  original?: { dispatch_id: string; receipt_path: string; receipt_sha256: string; overall: 'PASS' | 'GAPS'; inputs_sha256: string } | null;
  /** The orchestration epoch after it (or its last refinement) was settled. */
  epoch?: number;
  /** A PASS: the barrier it was settled with (no lease outstanding, every judged node DONE, the epoch). */
  barrier?: ReviewBarrier | null;
}

/** One refinement of a challenged review, settled. */
export interface ReviewRefinementRecord {
  dispatch_id: string;
  capability_sha256: string;
  round: number;
  challenges: string[];
  decisions: { challenge_id: string; criterion: string; decision: RefinementDecisionKind }[];
  receipt_path: string;
  receipt_sha256: string;
  at: string;
  /** The revision of the review it made. */
  revision?: number;
  /** What that revision did to each producer order of the review (engine/review-revision.ts). */
  orders?: { node_id: string; action: OrderActionKind }[];
}

export type RefinementDecisionKind = 'WITHDRAW' | 'REFINE' | 'UPHOLD';

/**
 * What a review's new revision does to a producer's order (engine/review-revision.ts):
 * `rebase` (every gap carried unchanged), `amend` (its gaps changed: replaced),
 * `cancel` (every gap withdrawn), `reorder` (the challenger, restored, ordered
 * again for what the revision keeps of its gaps), `order` (a refined gap's new
 * producer), `keep` (an order the node already completed).
 */
export type OrderActionKind = 'rebase' | 'amend' | 'cancel' | 'reorder' | 'order' | 'keep';

/**
 * A module-worker's valid review-gap challenge (engine/review-challenge.ts):
 * a GAP's exact public reproduction, written as focused tests, passed on the
 * unchanged integrated head. Its evidence is archived; its node went back to
 * the DONE generation the rework replaced; a fresh reviewer decides each gap.
 */
export interface ReviewChallengeRecord {
  challenge_id: string;
  review_id: string;
  node_id: string;
  /** pending: waiting for its refinement; withdrawn / refined / upheld: decided; disputed: over the rounds, the review blocked REVIEW_DISPUTE. */
  status: 'pending' | 'withdrawn' | 'refined' | 'upheld' | 'disputed';
  gaps: { criterion: string; round: number; reproduction_sha256: string; decision: RefinementDecisionKind | null }[];
  challenge_sha256: string;
  /** Relative to the control root: the receipt under features/<f>/reviews/challenges/<challenge_id>/. */
  receipt_path: string;
  receipt_sha256: string;
  /** The claim and dispatch generation that submitted it, and that claim's capability by hash: the same settle again is answered. */
  claim_id: string;
  dispatch_id: string | null;
  capability_sha256: string;
  generation: number;
  base_sha: string;
  at: string;
  /** The refinement that decided it. */
  refinement: { dispatch_id: string; receipt_path: string; at: string } | null;
  /** The DONE product dependents the challenged rework had reopened, restored with the node (CSET-203 r7). */
  restored?: string[];
  /**
   * A per-criterion answer's challenge (CSET-203 r15): the order's other criteria it proved DONE in the same
   * execution (the node is DONE on that work, never restored), and those it left unresolved.
   */
  partial?: { done: string[]; unresolved: UnresolvedCriterionRecord[] } | null;
}

/**
 * What became of one gap of a criterion (engine/review-lineage.ts). `regression`: a gap of a criterion whose completed
 * proof the reviewed heads lost (CSET-201 final) — restored, never an accepted rework.
 */
export type LineageGapVerdict = 'accepted' | 'duplicate' | 'exhausted' | 'unreworkable' | 'regression';

/**
 * Why a gap was (or was not) reworked (CSET-201 final): within its criterion's budget; past it, on verified producer
 * progress; not past it without that progress; at the emergency ceiling; a lost proof restored.
 */
export type GapBasis = 'budget' | 'progress' | 'no-progress' | 'ceiling' | 'regression';

/**
 * One fact of the acceptance review's per-criterion lineage (CSET-203 r11):
 * a gap and what became of it, a challenge of one, a refinement's decision,
 * a settled review and the progress it made, a criterion closed by a PASS,
 * a block, a person's grant past an exhausted budget, the migration of a
 * review state from before the lineage.
 */
export type LineageEventBody =
  | {
      kind: 'gap';
      review_id: string;
      criterion: string;
      reproduction_sha256: string;
      /** SHA-256 of the reproduction's normalized terms, and the terms. */
      fingerprint: string;
      terms: string[];
      verdict: LineageGapVerdict;
      /** The producers reworked for it (accepted), else none. */
      nodes: string[];
      /** A duplicate: the reproduction it repeats. */
      duplicate_of: string | null;
      /** A refinement's REFINE or UPHOLD: the challenge it answers. */
      challenge_id: string | null;
      /** Why it was (or was not) reworked (absent in events written before CSET-201 final). */
      basis?: GapBasis;
      /** basis `progress`: the completion records the producers' verified progress stands on. */
      progress?: string[];
      /** What makes it materially new: its reproduction, or an uncovered boundary no earlier gap of its criterion named. */
      novelty?: 'reproduction' | 'boundary';
      /** The uncovered boundaries its verdict named, each by its normalized terms. */
      boundaries?: string[][];
    }
  | { kind: 'challenge'; review_id: string; challenge_id: string; criterion: string; reproduction_sha256: string; receipt_sha256: string; node_id: string }
  | { kind: 'decision'; review_id: string; challenge_id: string; criterion: string; decision: RefinementDecisionKind }
  | {
      kind: 'review';
      review_id: string;
      inputs_sha256: string;
      /** `<repository>@<head>`, sorted. */
      heads: string[];
      outcome: string;
      passed: string[];
      gaps: string[];
      /** Why it made progress, as known when it was settled (a challenge of it adds to it later). */
      progress: string[];
    }
  | { kind: 'closure'; review_id: string; criterion: string; inputs_sha256: string }
  | { kind: 'blocked'; review_id: string; code: string; criteria: string[] }
  | { kind: 'grant'; review_id: string; criterion: string; decision_id: string }
  /** A criterion's completed proof the reviewed heads lost, ordered restored (once per lost record): never an accepted rework. */
  | { kind: 'regression'; review_id: string | null; criterion: string; node_id: string; record_id: string; code: string }
  | { kind: 'migrated'; review_id: null; reviews: string[] };

export type LineageEvent = LineageEventBody & { seq: number; at: string; prev_sha256: string | null; sha256: string };

/** The acceptance review's lineage: an append-only, hash-chained record of what every criterion's gaps came to. */
export interface ReviewLineage {
  schema: 'mycelink-review-lineage/1';
  /**
   * The budget per criterion since the last accepted delivery (the policy's max_rounds): accepted producer reworks a
   * materially new gap gets on its newness alone. Past it, each one needs verified producer progress (CSET-201 final).
   */
  max_criterion_reworks: number;
  /** The emergency ceiling per criterion, where a person decides (absent in a lineage from before it: the default). */
  criterion_ceiling?: number;
  max_review_sessions: number;
  max_no_progress: number;
  /** A configured review wall-clock budget, from the first review counted (absent: none). */
  max_review_ms?: number;
  events: LineageEvent[];
  head_sha256: string | null;
}

export interface AcceptanceReviewState {
  required: boolean;
  /**
   * Accepted producer reworks allowed per criterion since the last accepted delivery (CSET-203 r11: no longer one
   * count shared by every criterion); a materially new gap of a criterion past it blocks the feature.
   */
  max_rounds: number;
  /**
   * The safety the review converges under (CSET-201 final), fixed at feature init: the emergency ceiling of accepted
   * reworks per criterion, the review-session budget and the review wall-clock budget. Absent in a state from before
   * them: the defaults (a ceiling of DEFAULT_CRITERION_CEILING, 8 sessions, no wall-clock budget).
   */
  criterion_ceiling?: number;
  max_review_sessions?: number;
  review_wall_clock_ms?: number | null;
  /**
   * How long a launched reviewer may run, from its launch, before it is interrupted and its generation re-issued
   * (`acceptance_review.reviewer_timeout_seconds`, fixed at feature init; absent: 20 minutes).
   */
  reviewer_timeout_ms?: number;
  open: OpenReview | null;
  reviews: ReviewRecord[];
  /**
   * Why the feature cannot reach a candidate on its own: gaps left after the last round, no valid verdict, or a
   * gap still disputed after its challenge-refinement rounds.
   */
  blocked: { code: 'REVIEW_GAPS' | 'REVIEW_INVALID' | 'REVIEW_DISPUTE' | 'REVIEW_NONCONVERGENT' | 'REVIEW_LINEAGE_INVALID'; review_id: string; detail: string; at: string; criteria?: string[] } | null;
  /** Reviewer sessions settled (a verdict taken, valid or not), counted once per generation. */
  usage: UsageTotals;
  /** Review-gap challenges, oldest first. */
  challenges?: ReviewChallengeRecord[];
  /** Per-criterion gap lineage (engine/review-lineage.ts); absent in a state from before it, derived on first use. */
  lineage?: ReviewLineage;
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
