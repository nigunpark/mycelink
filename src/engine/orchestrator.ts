/**
 * Feature orchestration engine.
 *
 * Ties the deterministic pieces together into the cycle the instructions
 * mandate:
 *
 *   load state -> validate graph -> compute READY -> remove ownership and
 *   resource conflicts -> claim -> bounded context pack -> dispatch exactly
 *   one worker per node -> ingest a structured result -> fresh verification
 *   on a clean checkout -> atomic transition -> integrate -> recompute READY
 *
 * It stops only on: everything settled, BLOCKED, NEEDS_DECISION,
 * BUDGET_EXHAUSTED, or cancellation.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../util/paths.js';
import type {
  AdoptedBase,
  CapsuleRegistryEntry,
  ClaimMode,
  ClaimTddPolicy,
  ClaimVerification,
  ClaimWorktreeSetup,
  EvidenceKind,
  EvidenceRecord,
  FeatureState,
  FeatureState_,
  GraphNode,
  IdentityReconcile,
  NodeClaim,
  NodeRuntime,
  NodeState,
  PendingIntegration,
  PortfolioGraph,
  ReworkBrief,
  ReworkHistoryEntry,
  ReworkRecord,
  SettlementReceipt,
  TddHistoryRecord,
  CarriedCriterionProof,
  CompletionRevalidation,
  CriterionCompletion,
  ReopenedCriterion,
  UsageTotals,
} from '../model/types.js';
import { MAX_LEDGER_RECORDS, carriedRed, completionsOf, ledgerOf, revalidateCompletion, rootCompletion, writeCompletionArchive, type ArchiveCopy, type CompletionVerdict } from './criterion-ledger.js';
import { readGateTests } from '../evidence/gate-tests.js';
import { TEST_IDENTITY_VERSION, namesDeclaration } from '../evidence/test-identity.js';
import { commitProofUnit, planProofUnit, type ProofFile } from './proof-units.js';
import { tddPolicyFor, tddPolicySha256, verifyTddHistory, type TddHistory, type TddPolicy } from './tdd-history.js';
import {
  WorktreeSetupError,
  reusableSetup,
  runWorktreeSetup,
  setupInputs,
  setupMutatedWorktree,
  worktreeSetupOf,
  worktreeSetupSha256,
  type WorktreeSetupConfig,
} from './worktree-setup.js';
import { checkEvidenceOutput, relativeInside, resolveEvidenceOutput } from '../evidence/paths.js';
import { holdsControllerKey } from './authority.js';
import { settlerAlive, settlerMarker } from './settler.js';
import { verificationCriteria, verificationReceipt, verificationSteps, type VerificationRun, type VerificationStep } from './verification-node.js';
import { featurePaths, nodeEvidenceDir, type FeaturePaths } from '../workspace/paths.js';
import { loadWorkspace, repositoryPath, type Workspace } from '../workspace/workspace.js';
import { loadGraph } from '../workspace/workspace.js';
import { hashGraph } from '../graph/validate.js';
import { addUsage, loadState, mutateState, stateLockPath, zeroUsage } from '../state/feature-state.js';
import { BARRIER_KINDS, activeLeases, bumpEpoch, closeLeases, currentEpoch, issueLease, leaseKindFor, leaseOf, lineageOf, markStale, orchestrationOf } from '../state/orchestration.js';
import {
  accumulateUsage,
  applyNodeTransition,
  recordFailure,
  redRequired,
  SETTLE_GATE_STATE,
  TransitionError,
} from '../state/transition.js';
import { IN_FLIGHT_STATES, canSchedule, computeReady, generationAttempts, scheduleBatch, type SchedulePlan } from '../scheduler/ready.js';
import { validateAgainstSchema } from '../schema/registry.js';
import {
  CAPABILITY_ENV,
  CapabilityError,
  assertClaimCapability,
  capabilityMatches,
  newCapability,
} from './capability.js';
import {
  MAX_WORKER_RESULT_BYTES,
  WORKER_RESULT_DIR,
  WORKER_RESULT_FILE,
  buildHostWorkerPrompt,
  collectWorkerResult,
  generationResultFile,
  loadPromptPack,
  prepareResultSlot,
  renderGateCommand,
} from '../sessions/worker-protocol.js';
import { statusForOutcome } from '../sessions/adapter.js';
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import type { PreflightResult } from '../sessions/preflight.js';
import { expandAllowedProposalPaths } from '../sessions/wsl-codex-policy.js';
import { startExperimentalWslProcess, revokeWslCodexProcesses, wslCodexProcessActive, wslCodexProcessResult } from '../sessions/wsl-codex-process.js';
import { assertImmutableWslApplyBase, stageImmutableWslCodexSource, immutableGitSource } from '../sessions/wsl-codex-source.js';
import { sealRegisteredWslCodexWorker, sealRegisteredWslCodexReviewer, readRegisteredWslCodexTurn, wslCodexSettlementAnchor, type WslCodexWorkerSeal, type WslCodexVerifiedTurn } from '../sessions/wsl-codex-seal.js';
import { protectExperimentalWslCapability, unprotectExperimentalWslCapability } from '../sessions/wsl-codex-escrow.js';
import {
  acquireResource,
  listLeases,
  recoverLeases,
  releaseAllForNode,
  ResourceBusyError,
} from '../resources/leases.js';
import {
  createWorkerWorktree,
  integrationBranchName,
  matchGlob,
  removeWorkerWorktree,
  verifyChangedPaths,
  workerBranchName,
  worktreeDirName,
} from '../git/worktree.js';
import { createCandidate, loadCandidate } from '../git/candidate.js';
import { expectedIntegrationHead, IntegrationBranchMovedError, portfolioRefs, trustedIntegrationHead } from './portfolio.js';
import { LockTimeoutError, withLock } from '../state/process-lock.js';
import { codexLifecycleEnabled, withCodexLifecycleLock } from '../state/codex-lifecycle.js';
import { FeatureBusyError, withFeatureLock } from './feature-lock.js';
import { admitReworkReason, reasonSha256, reworkAcceptance, ReworkBriefError, reworkEvidence, stoodRework, verifiedReworkBrief } from './rework-brief.js';
import { loadScenarios, runE2E } from '../e2e/runner.js';
import { applyIntegration, DirtyWorktreeError, fastForwardIntegration, IntegrationConflictError, planIntegration, type IntegrateResult } from '../git/integrate.js';
import { coverageManifest, declaredAt, lostCompletions, type CompletionCoverage, type CoverageManifest } from './criterion-coverage.js';
import { branchExists, commitAll, isAncestor, isWorktreeClean, listWorktrees, resolveRef, runGit } from '../git/git.js';
import { quarantineStash, type StashQuarantine } from '../git/stash.js';
import { assertDecisionUsable, markDecisionApplied } from '../state/decisions.js';
import { buildContextPack, type ContextCapsule, type ContextPack, type MemoryRef } from '../sessions/context-pack.js';
import { mycelinkCliPath } from '../workspace/hook-settings.js';
import { moduleInvocation, runVerification, verifierInvocation } from '../evidence/runner.js';
import { claimVerificationFor, ModuleDriftError } from './modules.js';
import { regressionDeferral } from './regression-deferral.js';
import { CYCLE_CORRECTIONS, MAX_EVIDENCE_CORRECTIONS, capsulePathDetail, criteriaSha256, criterionKind, declarationAt, judgeCriteria, requiredGate, revalidateCarried, type CriterionCandidate, type CriterionCode } from './criteria.js';
import { criteriaFingerprint, criteriaForm, evidenceReuse, scalarCriteria, type CriteriaForm, type EvidenceUse } from './criterion-outcomes.js';
import { AcceptanceDriftError } from './acceptance.js';
import { appendEvent } from '../state/event-log.js';
import { isInsideReal, readRegular } from '../security/paths.js';
import { declaredTests } from './test-declarations.js';
import {
  CAPSULE_LIMITS,
  CAPSULES_DIR,
  blobAt,
  capsuleArchiveProblem,
  capsuleDir,
  capsuleIdentity,
  capsuleOutcome,
  capsuleSelfConsistent,
  capsuleTests,
  capsuleUse,
  capsuleWeakening,
  collectCapsuleFiles,
  currentOrder,
  orderDrift,
  readCapsule,
  removeCapsuleStaging,
  writeCapsuleArchive,
  type CapsuleCode,
  type CapsuleIdentityInput,
  type CapsuleOrder,
  type CapsuleReceipt,
  type CapsuleRefusal,
  type CapsuleRegistration,
  type CapsuleReplayRun,
  type CapsuleTest,
  type CapsuleVerification,
} from './reproduction-capsule.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { keepExactCopy, writeImmutable } from '../evidence/store.js';
import { repairRequired, repairRequiredDetail } from './evidence-integrity.js';
import type { NodeResult, SessionAdapter, SessionStatus, SpawnRequest } from '../sessions/adapter.js';
import {
  findOrphanedSessions,
  recordObservation,
  recordSpawn,
  liveSessions,
  markTerminal,
} from '../sessions/registry.js';
import { appendRun } from '../loops/runs.js';
import { CommandPolicyError } from '../security/exec.js';
import {
  ATTESTATION_FILE,
  FORMAT_REFUSALS,
  MAX_FORMAT_CORRECTIONS,
  MAX_REVIEW_ATTEMPTS,
  MAX_VERDICT_BYTES,
  REVIEWER_AGENT,
  REVIEW_ATTESTATION_SCHEMA,
  REVIEW_RECEIPT_SCHEMA,
  REVIEW_TICKET_SCHEMA,
  REVIEW_VERDICT_SCHEMA,
  VERDICT_FILE,
  canonicalVerdictSha256,
  criterionClauses,
  currentReviewInputs,
  fileSha256,
  gapReason,
  gapTargets,
  judgeRefinement,
  judgeVerdict,
  missingReworks,
  nextReviewId,
  passFor,
  receiptProblem,
  reviewCriteria,
  reviewInputsSha256,
  reviewSlot,
  roundsUsed,
  verdictCanonicalSha256,
  type Gap,
  type ReasonBudget,
  type GapTarget,
  type NormalizedField,
  type PriorGap,
  type RefinementJudgement,
  type VerdictCriterion,
  type VerdictNormalization,
  type VerdictProblem,
} from './acceptance-review.js';
import { MAX_REVIEW_FINDINGS, buildReviewPacket, controlRelative, loadPacket, refinementContext, refinementPrompt, removeReviewCheckouts, reviewerPrompt, verdictContext, type PacketRefinement, type ReviewCorrection, type ReviewFinding, type ReviewMemory, type ReviewPacket } from './review-packet.js';
import { DEFAULT_REVIEWER_TIMEOUT_MS, MAX_RESULT_DEPTH, REVIEWER_TRANSPORT, reviewerLifecycle, reviewerOutput, safeGenerationDir, writeIngestAttestation, writeIngestedVerdict, type AgentEvidence, type AgentOutput, type ResultExtraction, type ReviewerLifecycle, type ReviewerLifecycleState, type TransportCode } from './review-transport.js';
import { parseStrictJson } from '../security/strict-json.js';
import { countInterruption, emptyProviderLedger, holderFailure, launchFiles, providerMark, recordInterruption, ticketOf, type HolderFailure } from './provider-interrupt.js';
import { currentHostBinding, workerLaunchDir } from '../hooks/provider-binding.js';
import { runningWorker, type RunningWorker } from './worker-lifecycle.js';
import type { AcceptanceReviewState, AgentInterruptMark, CarryProof, DispatchLease, HostSessionBinding, LineageEventBody, ProviderLedger, ProviderMark, ProviderProgress, OpenRefinement, OpenReview, RefinementDecisionKind, RestorableGeneration, ReviewBarrier, ReviewChallengeRecord, ReviewInputs, ReviewLineage, ReviewProblem, ReviewRecord, ReviewRevisionRef, ReworkOrigin, ReworkRebase, AcceptedCriterionRecord, CriteriaSettlement, PartialOrderBinding, UnresolvedCriterionRecord } from '../model/types.js';
import { boundOrigin, boundRevision, carryAcross, currentRevision, nodeOrderProblems, orderViews, planRevision, readReceiptFile, rebaseRecord, revisionChain, revisionGaps, revisionTrustProblems, type OrderAction, type ReceiptRead } from './review-revision.js';
import {
  appendLineage,
  budgetLine,
  emptyLineage,
  gapEvent,
  judgeGapLineage,
  lineageProblems,
  migrateLineage,
  nonconvergence,
  reviewProgress,
  summarizeLineage,
  type GapFacts,
  type GapLineageJudgement,
  type LineageSummary,
  type ProgressFact,
  type RegressionFact,
} from './review-lineage.js';
import {
  MAX_CHALLENGE_ROUNDS,
  archiveChallenge,
  assertionProblem,
  challengeDir,
  challengeFingerprint,
  challengeId,
  judgeChallenge,
  parseAssertionRef,
  readChallengeReceipt,
  reproductionSha256,
  type ChallengeRefusal,
  type CriteriaChallengeContext,
  type JudgedChallenge,
} from './review-challenge.js';

export interface OrchestratorOptions {
  controlRoot: string;
  featureId: string;
  adapter: SessionAdapter;
  owner?: string;
  /** Extra environment handed to every worker session. */
  workerEnv?: Record<string, string>;
  /** Optional LLM Wiki Brain recall injected into each context pack. */
  recall?: (node: GraphNode) => MemoryRef[];
  /**
   * Checks that the worker adapter can start at all. Run once, before the
   * first worker node is claimed; a failure stops the run with
   * ADAPTER_UNAVAILABLE instead of charging the node.
   */
  preflight?: () => PreflightResult;
  /**
   * Test seam: called at each settle boundary a crash can fall on. A throw
   * here stands in for the process dying at that point.
   */
  settleFault?: (point: SettleFaultPoint) => void;
  /** Test seam: called where a capsule registration can die (engine/reproduction-capsule.ts): after its run, after its archive is sealed. */
  capsuleFault?: (point: string) => void;
}

/** Where a settle can die with something already done that a retry must not redo. */
export type SettleFaultPoint =
  | 'result-captured'
  | 'result-attested'
  | 'history-sealed'
  // A re-proof unit's commit written and journaled on the claim, the node branch not moved yet (CSET-201 final).
  | 'reproof-committed'
  | 'fresh-targeted'
  | 'fresh-verified'
  | 'gates-advanced'
  | 'integration-journaled'
  | 'integration-moved'
  | 'integrated'
  | 'attempt-concluded'
  // Not a settle boundary: a rework moved an integration branch onto its delivered base, and recorded nothing yet.
  | 'rework-base-adopted'
  // A verification node's run (the controller's own): claimed; its commands ran; its receipt and evidence recorded, not yet DONE.
  | 'verification-claimed'
  | 'verification-ran'
  | 'verification-recorded'
  // An acceptance review's settle: its receipt written, nothing recorded; then its record and every rework written together.
  | 'review-receipt-written'
  | 'review-recorded'
  // A review-gap challenge's settle: its evidence archived, nothing recorded; then the node restored and the challenge recorded.
  | 'challenge-archived'
  | 'challenge-recorded'
  // A per-criterion answer's settle: its plan judged and kept on the claim, nothing integrated; then the node DONE with its challenge recorded.
  | 'criteria-judged'
  | 'criteria-recorded'
  // An identity-shape refusal re-evaluated administratively (PCM-101 final): its receipt written and the evidence recorded, nothing
  // verified yet; a parked BLOCKED answer's claim reopened with its captured answer, nothing settled yet.
  | 'identity-receipt-written'
  | 'identity-reopened'
  // A claim's write made (the claim and its dispatch lease, together), its worktree not set up yet.
  | 'lease-issued';

/** A fault injected by a test at a settle boundary: a crash, never an attempt failure. */
export class InjectedFault extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'InjectedFault';
  }
}

export interface NodeRunReport {
  node_id: string;
  outcome:
    | 'DONE'
    | 'INTEGRATED'
    | 'SUBMITTED'
    | 'RETRY'
    | 'BLOCKED'
    | 'NEEDS_DECISION'
    | 'BUDGET_EXHAUSTED'
    | 'VERIFICATION_FAILED'
    | 'OWNERSHIP_VIOLATION'
    /** The worker could not be started; the claim was handed back unspent. */
    | 'INFRASTRUCTURE_FAILURE'
    /** A controller node's precondition (a clean control repository) does not hold; nothing was charged. */
    | 'PRECONDITION_FAILED'
    /** Settle refused the node's commit history as not test-first; it was archived and never integrated. */
    | 'TDD_HISTORY_INVALID'
    /**
     * Settle refused only the result's criterion evidence: the same claim is
     * held, nothing charged or integrated, for the capability holder to
     * resubmit the same commit with corrected evidence (engine/criteria.ts).
     */
    | 'EVIDENCE_CORRECTION_REQUIRED'
    /**
     * A valid review-gap challenge (engine/review-challenge.ts): no attempt charged, the node DONE on the
     * generation its rework replaced, the review CHALLENGED; a fresh reviewer refines the gap next.
     */
    | 'REVIEW_CHALLENGED'
    /**
     * A legacy answer (BLOCKED REVIEW_GAP_NOT_REPRODUCED, or INVALID_RED_EVIDENCE: behaviour already present)
     * in an acceptance review's rework whose red gate passed every test it declared: no attempt charged, the
     * claim held, and the next generation is asked for the structured challenge (once per claim).
     */
    | 'CHALLENGE_REQUIRED'
    /**
     * A late answer of a dispatch that no longer counts (state/orchestration.ts): a revoked, abandoned or
     * released lease, one whose node's lineage moved, one settled before the epoch moved on, or a result whose
     * orchestration_epoch is not its claim's. Its result is archived; nothing changed, nothing charged.
     */
    | 'STALE_ORCHESTRATION_EPOCH'
    /**
     * The worker's own request (or its host's) was ended by a transient model-provider failure and it left no
     * result (CSET-203 r10): its lease is interrupted-provider, nothing charged; a fresh (or resumed) generation next.
     */
    | 'PROVIDER_INTERRUPTED'
    /**
     * A settle while the worker launched for the claim's dispatch still runs (its completion not yet in its host
     * session's records) and its slot is empty: nothing settled, written or charged (engine/worker-lifecycle.ts).
     */
    | 'WORKER_RUNNING'
    /**
     * The answer of a ticket whose order was bound to an older revision of its review (CSET-203 r14: STATE.json written
     * before review revisions): never judged. Its gaps carry unchanged, so the order is rebased to the current revision
     * and the same generation reissued from where it stands: no attempt or failure counted; dispatch hands it out.
     */
    | 'REVIEW_ORDER_REBASED'
    /**
     * The same, but a later revision of the review changed the order's gaps: the claim is handed back unspent and the
     * order replaced (or cancelled); nothing counted.
     */
    | 'REVIEW_GAP_STALE'
    /**
     * A per-criterion answer settled (CSET-203 r15, engine/criterion-outcomes.ts): its DONE criteria integrated as the
     * node's new generation, its challenged ones recorded as one challenge (the node awaiting the review's refinement of
     * them), its unresolved ones ordered again on their own and parked with their reasons. One product attempt for the
     * one execution; nothing failed.
     */
    | 'CRITERIA_SETTLED';
  session_id: string | null;
  state: NodeState;
  detail: string;
  evidence: EvidenceRecord[];
  /** REVIEW_ORDER_REBASED / REVIEW_GAP_STALE: what the order was bound to, what it is now, and what reconciled it. */
  reconciliation?: { code: 'REVIEW_CHALLENGE_STALE' | 'REVIEW_GAP_STALE' | 'REVIEW_REVISION_REPLACED'; review_id: string; from_revision: number; to_revision: number; rebase_sha256: string | null };
  /** PROVIDER_INTERRUPTED: the failure, as Claude Code recorded it. */
  provider?: ProviderMark;
  /** EVIDENCE_CORRECTION_REQUIRED: the bound tests the evidence could name instead, by canonical id. */
  candidates?: CriterionCandidate[];
  /** REVIEW_CHALLENGED: the challenge recorded, its round and whether it waits for a refinement or disputes the review. */
  challenge?: { challenge_id: string; review_id: string; criteria: string[]; round: number; status: ReviewChallengeRecord['status']; receipt_path: string; restored: string[] };
  /** STALE_ORCHESTRATION_EPOCH: the lease that answered, how it stood, why it no longer counts, and the late result archived. */
  stale?: StaleAnswer;
  /** The entries the claim's worktree left in the shared stash: archived and dropped (git/stash.ts). */
  stash?: StashQuarantine;
  /** CRITERIA_SETTLED (and a per-criterion answer parked whole): what each ordered criterion came to. */
  criteria?: { criterion: string; outcome: string; challenge_id?: string }[];
  /** CRITERIA_SETTLED: the unresolved criteria's own order — parked with their reasons, or still to be made (pending). */
  follow_up?: { criteria: string[]; state: 'BLOCKED' | 'NEEDS_DECISION' | 'pending'; decisions: string[] };
}

/** Why a late answer no longer counts, and where its result went (state/orchestration.ts). */
export interface StaleAnswer {
  lease_id: string | null;
  /** The lease's status when it answered (`active`: the current claim's own result, refused). */
  status: DispatchLease['status'] | null;
  reason: string;
  /** The late result, moved out of the worker's slot into the controller's sessions directory; null when there was none. */
  archived: { path: string; sha256: string } | null;
  epoch: { issued: number | null; current: number };
  lineage: { issued: number | null; current: number };
}

export interface CycleReport {
  scheduled: string[];
  deferred: { node_id: string; reason: string }[];
  reports: NodeRunReport[];
}

export interface FeatureRunReport {
  cycles: number;
  stop_reason:
    | 'ALL_SETTLED'
    | 'BLOCKED'
    | 'NEEDS_DECISION'
    | 'BUDGET_EXHAUSTED'
    | 'NO_PROGRESS'
    | 'MAX_CYCLES'
    /** The worker adapter cannot start; nothing was charged. Resumable. */
    | 'ADAPTER_UNAVAILABLE'
    /**
     * Every product and verification node is DONE and the acceptance review is
     * due: it is a plugin subagent, run through `dispatch` (the host's Agent
     * tool), never by this standalone loop. No candidate is cut before it.
     */
    | 'REVIEW_REQUIRED';
  reports: NodeRunReport[];
  feature_state: string;
  /** The adapter preflight, when one ran. */
  adapter?: PreflightResult;
}

/** Node types the controller runs itself; never a rework target. */
const CONTROLLER_NODE_TYPES: ReadonlySet<string> = new Set(['candidate-build', 'e2e-scenario', 'verification']);
/** Node types that wait for the acceptance review: the candidate and what runs on it. Every other node is what the review judges. */
const REVIEW_GATED_TYPES: ReadonlySet<string> = new Set(['candidate-build', 'e2e-scenario']);

/** A node only the controller runs was asked for a worker claim. */
export class NotWorkerNodeError extends Error {
  readonly code = 'NOT_A_WORKER_NODE';
  constructor(nodeId: string, type: string) {
    super(`NOT_A_WORKER_NODE: ${nodeId} is a ${type} node: the controller runs it itself (dispatch runs it when it is due); it is never claimed for a worker. Nothing was claimed.`);
    this.name = 'NotWorkerNodeError';
  }
}

export type ReworkReport = ReworkRecord & {
  feature_id: string;
  idempotent: boolean;
  /** Archive refs the reopened nodes' old branches were kept under. */
  archived_refs: string[];
};

/** `feature owners`: the producer nodes a failure points at, and what reworking each reopens. */
export interface OwnersReport {
  feature_id: string;
  current_candidate: string | null;
  /** Delivered bases someone committed on since the delivery, and the paths those commits changed. */
  since_delivery: { repository: string; base_branch: string; from: string; to: string; paths: string[] }[];
  owners: {
    node_id: string;
    repository: string;
    state: string | null;
    /** `<repository>:<path>` entries the node owns. */
    paths: string[];
    acceptance: string[];
    /** What `node rework` of this node reopens: itself, its dependents, the controller nodes. */
    reopens: string[];
  }[];
  /** Paths no producer node owns. */
  unowned: string[];
}

export interface ReworkOptions {
  reason: string;
  decisionId?: string;
  /** Acceptance criteria the failure is attributed to (the reason's own mentions are added). */
  acceptance?: string[];
  /** Exactly `acceptance`, none of the reason's own mentions: a reviewer's free text may mention criteria it does not fault. */
  exactAcceptance?: boolean;
  /** Relative references to the failure's evidence. */
  evidence?: string[];
  /** The acceptance review whose GAP orders the rework. */
  origin?: ReworkOrigin;
  /** An acceptance review's gaps of this rework: each criterion and the SHA-256 of its exact reproduction (a challenge binds them). */
  reviewGaps?: { criterion: string; reproduction_sha256: string }[];
}

/** A rework checked and prepared against one state (Orchestrator.planRework), carried out in a STATE.json write by applyReworkPlan. */
interface ReworkPlan {
  nodeId: string;
  reason: string;
  decisionId: string | null;
  acceptance: string[];
  evidenceRefs: string[];
  origin: ReworkOrigin | undefined;
  at: string;
  /** The node, its dependents in dependency order, then the controller nodes. */
  cascade: string[];
  delivered: boolean;
  adopted: AdoptedBase[];
  entry: ReworkHistoryEntry;
  brief: ReworkBrief;
  /** The new behaviours the rework does not name, with the proof the replaced generation settled each with (Orchestrator.carriedProofs). */
  carriedProofs: CarriedCriterionProof[];
  /** Filled in when applied. */
  reopened: string[];
  candidate: string | null;
}

/** A node `feature status` names in its next action: its state, rework generation, attempts of that generation and last refusal. */
export interface NextActionNode {
  node_id: string;
  state: NodeState;
  rework_generation: number;
  attempts_used: number;
  max_attempts: number;
  last_refusal: { code: string; commit: string | null } | null;
}

/** What the next controller step of a feature is (Orchestrator.nextAction). */
export interface NextAction {
  /**
   * review-refine: a valid challenge of a review's gap waits for a fresh reviewer's refinement, which the next dispatch hands out.
   * await-worker: a worker holds a live lease (not expired, nothing to settle yet): wait for it, never review past it.
   * await-reviewer: the acceptance reviewer launched for the open review generation is running (or about to be launched by
   * the host that holds its ticket): wait for it (review await), never settle, correct or re-issue it while it runs
   * (CSET-203 r13). reconcile: a lease's holder has something for the controller (a result to settle, a hold to re-issue)
   * or is gone. evidence-repair: evidence the delivered state stands on that no exact archive restores
   * (engine/evidence-integrity.ts): the controller's to repair or a person's to decide, never a worker's.
   */
  kind: 'dispatch' | 'reconcile' | 'await-worker' | 'await-reviewer' | 'deliver' | 'decision' | 'none' | 'stopped' | 'review-refine' | 'evidence-repair';
  /** True when a controller invoked again (`/mycelink:run`) can take it without a person. */
  resumable: boolean;
  /** The Mycelink command that takes it, without the launcher. */
  command: string | null;
  detail: string;
  nodes: NextActionNode[];
  /** await-reviewer (and a reconcile of an interrupted reviewer): where the open generation's reviewer stands, by hash only. */
  reviewer?: ReviewerStatus;
}

/**
 * Where the reviewer of the open review generation stands, as status, ingest,
 * settle and `review await` report it and the benchmark harness records it:
 * its Agent task and agent by hash only, how long it has run of its
 * wall-clock — never its prompt, its answer or its raw ids.
 */
export interface ReviewerStatus {
  review_id: string;
  dispatch_id: string;
  refinement: boolean;
  state: ReviewerLifecycleState;
  /** SHA-256 of the host's Agent call id (the task) and of the subagent's id, once known. */
  task_sha256: string | null;
  agent_id_sha256: string | null;
  launched_at: string | null;
  elapsed_ms: number | null;
  remaining_ms: number | null;
  timeout_ms: number;
  notified_at: string | null;
}

/** `feature rework`: a reported failure attributed to its producer nodes, each reworked with the report as its reason. */
export interface FeatureReworkReport {
  feature_id: string;
  /** How the targets were found: the paths they own (`<repository>:<path>`), or the acceptance criteria named. */
  attribution: { by: 'paths' | 'acceptance' | 'pending'; paths: string[]; acceptance: string[] };
  /** The reworked producer nodes, dependents first. */
  targets: string[];
  reworks: ReworkReport[];
  /** True when every target was already reworked for this same report and waits for its dispatch. */
  idempotent: boolean;
  owners: OwnersReport;
}

/** The fingerprint of a worker that could not produce a valid RED. */
const INVALID_RED_FINGERPRINT = 'INVALID_RED_EVIDENCE';

/** A rework that would be unsafe or unjustified; nothing was changed. */
export class ReworkRefusedError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ReworkRefusedError';
    this.code = code;
  }
}

/** Interruptions a node may absorb before reconcile parks it instead of retrying. */
const MAX_INTERRUPTIONS = 3;

export interface ReconcileReport {
  recoveredLeases: number;
  orphanedSessions: string[];
  releasedNodes: string[];
  /**
   * Unsettled host dispatches still within their claim. `settlement: held`:
   * the controller holds the result (a settle was interrupted, or a resume
   * attested it), and dispatch finishes it; otherwise dispatch --resume
   * re-issues the ticket, or finishes it when the worker's result is in its slot.
   */
  pending_dispatches: { node_id: string; claim_id: string; result_present: boolean; expired: boolean; state: NodeState; settlement: 'held' | 'none' | 'correction' }[];
  /** Host dispatches handed back as interruptions (no failure recorded). */
  abandoned_dispatches: string[];
  /** Settles whose process died; their marker was cleared. */
  interrupted_settles: string[];
  /** Controller runs (a verification node, a candidate build) whose controller died: handed back as interruptions. */
  interrupted_controller_runs: string[];
  /** The acceptance review handed to a reviewer and not settled: `dispatch` settles a verdict already in its slot, `dispatch --resume <review_id>` re-issues it. */
  pending_review: PendingReview | null;
  /** Leases whose holder a model provider ended (CSET-203 r10), reconciled here: what was done with each. */
  provider_interrupted: ProviderInterruptReport['interrupted'];
}

/** What `session provider-interrupt` (and every reconcile, dispatch and settle) found and did. */
export interface ProviderInterruptReport {
  feature_id: string;
  /** RECONCILED: leases interrupted; NOTHING_INTERRUPTED: none whose holder failed; DUPLICATE: only failures already reconciled; PROVIDER_UNAVAILABLE: past the bounds. */
  outcome: 'RECONCILED' | 'NOTHING_INTERRUPTED' | 'DUPLICATE' | 'PROVIDER_UNAVAILABLE';
  idempotent: boolean;
  interrupted: {
    lease_id: string;
    kind: DispatchLease['kind'];
    node_id: string | null;
    review_id: string | null;
    dispatch_id: string | null;
    /** released: back READY for a fresh worker; resumable: the same generation, its capability rotated; review-reissue: a fresh reviewer generation. */
    action: 'released' | 'resumable' | 'review-reissue';
    failure: ProviderMark;
    ticket: string;
    count: { ticket: number; phase: number };
    progress?: ProviderProgress;
  }[];
  /** Active leases whose holder failed otherwise (a permanent failure, a limit), or that hold a result: left as they are. */
  kept: { lease_id: string; node_id: string | null; review_id: string | null; why: string }[];
  provider: ProviderLedger;
  next_action: NextAction;
}

/** An acceptance review out with a reviewer subagent, not settled yet. */
export interface PendingReview {
  review_id: string;
  dispatch_id: string;
  expires_at: string;
  expired: boolean;
  /** The reviewer's verdict is in its slot: settling it runs no reviewer again. */
  verdict_present: boolean;
  /** The generation's verdict was refused: the next dispatch hands the review to a fresh reviewer. */
  refused: boolean;
  /** A refinement of a challenged review, not a review of its own. */
  refinement: boolean;
  /** Where its reviewer stands (CSET-203 r13). */
  reviewer?: ReviewerStatus;
}

/** `review await`: where the open generation's reviewer stands, after waiting while it runs (Orchestrator.awaitReview). */
export interface ReviewAwaitReport {
  feature_id: string;
  review_id: string | null;
  dispatch_id: string | null;
  /** The reviewer's lifecycle; SETTLED: the generation was settled; STALE: it no longer counts; NONE: no review is open. */
  state: ReviewerLifecycleState | 'SETTLED' | 'STALE' | 'NONE';
  /** await: run the await line again; ingest, settle: run the ticket's line; launch: launch the reviewer; dispatch: dispatch again; stop: a person. */
  next: 'await' | 'ingest' | 'settle' | 'launch' | 'dispatch' | 'stop';
  detail: string;
  reviewer: ReviewerStatus | null;
  waited_ms: number;
  polls: number;
}

/** An acceptance-review ticket: what the host gives the Agent tool (subagent mycelink:acceptance-reviewer), then settles. */
export interface ReviewTicket {
  schema: typeof REVIEW_TICKET_SCHEMA;
  kind: 'acceptance-review';
  feature_id: string;
  /** A review is no graph node. */
  node_id: null;
  review_id: string;
  dispatch_id: string;
  /** The review's ordinal since the last accepted delivery. */
  review: number;
  /** This review's generation (a resume or a refused verdict issues the next). */
  attempt: number;
  agent: typeof REVIEWER_AGENT;
  /** Raw capability of this generation: `review settle` needs it. Only its hash is stored; never in the prompt. */
  capability: string;
  expires_at: string;
  packet_path: string;
  /** The reviewer's verdict file. */
  result_slot: string;
  criteria: string[];
  inputs_sha256: string;
  /**
   * Run when the reviewer's Agent call has returned (its completion notification arrived), before settle_command:
   * takes the reviewer's final answer as its verdict when it wrote none (engine/review-transport.ts).
   */
  ingest_command: string;
  /**
   * Run once the reviewer's Agent call is made, before ingest_command (CSET-203 r13): waits while the reviewer runs (at most
   * REVIEW_AWAIT_SECONDS a call) and says what comes next; RUNNING: run it again — never settle, correct or relaunch.
   */
  await_command: string;
  settle_command: string;
  prompt: string;
  resumed: boolean;
  /** A format correction: the refused verdict of this review the generation mends, and its problems. Null: a review of its own. */
  correction: ReviewCorrection | null;
  /** A refinement of a challenged review: its round and the challenged gaps it decides. Null: a review of its own. */
  refinement: { round: number; max_rounds: number; challenges: { challenge_id: string; criterion: string; node_id: string }[] } | null;
}

/** What settling a review concluded. */
export interface ReviewSettleReport {
  review_id: string;
  dispatch_id: string;
  /**
   * PASS: the candidate may be cut. GAPS: the producers were reworked. REVIEW_GAPS: gaps left after the last round,
   * blocked. REVIEW_INVALID: the verdict was refused. CHALLENGED: a worker's valid challenge of one of its gaps waits
   * for a refinement. WITHDRAWN: a refinement withdrew every gap, but the heads reviewed moved: a new review follows.
   */
  outcome: 'PASS' | 'GAPS' | 'REVIEW_GAPS' | 'REVIEW_INVALID' | 'CHALLENGED' | 'WITHDRAWN' | 'REPEATED' | 'REVIEW_NONCONVERGENT' | 'REGRESSION' | 'STALE_ORCHESTRATION_EPOCH' | 'PROVIDER_INTERRUPTED' | 'REVIEWER_RUNNING' | 'REVIEWER_INTERRUPTED' | 'REVIEWER_NOT_LAUNCHED';
  /** The coverage its receipt pins (CSET-201 final): whether every standing completion held at its heads, and what did not. */
  coverage?: { holds: boolean; sha256: string; lost: { node_id: string; criterion: string; record_id: string; code: string | null }[] } | null;
  detail: string;
  /** Where the generation's reviewer stood when settle looked (CSET-203 r13): RUNNING is never a missing verdict. */
  lifecycle?: ReviewerLifecycleState;
  reviewer?: ReviewerStatus;
  /** PROVIDER_INTERRUPTED: the reviewer's (or its host's) provider failure; the generation is revoked, nothing spent. */
  provider?: ProviderMark;
  /** A refused verdict's code (REVIEW_VERDICT_MISSING, REVIEW_UNATTESTED, ...). */
  code: string | null;
  receipt_path: string | null;
  receipt_sha256: string | null;
  /** The producer nodes reworked for its gaps, dependents first. */
  reworked: string[];
  gaps: { criterion: string; reproduction: string }[];
  /** The feature is blocked by the review (REVIEW_GAPS, or REVIEW_INVALID after the last attempt). */
  blocked: boolean;
  idempotent: boolean;
  /** wait: its reviewer runs (run the await line); launch: none was launched; dispatch: go on; stop: a person. */
  next: 'dispatch' | 'stop' | 'wait' | 'launch';
  /** A refusal: every problem of the verdict, each at its JSON pointer (none for a missing or unattested one). */
  problems?: ReviewProblem[];
  /** A refusal: the format corrections the review has spent, of MAX_FORMAT_CORRECTIONS. */
  corrections?: { used: number; max: number };
  /** A settled verdict: the original (attested) verdict's hash, the canonical one's, and the prose fields canonicalisation changed. */
  verdict_sha256?: string | null;
  canonical_verdict_sha256?: string | null;
  normalized?: NormalizedField[];
  /** A settled refinement: its round and each challenged gap's decision. */
  refinement?: { round: number; decisions: { challenge_id: string; criterion: string; decision: RefinementDecisionKind }[] };
  /** How the settled verdict reached the controller (null: a refusal, or a receipt from before transports were recorded). */
  transport?: ReviewTransport | null;
}

/**
 * How a verdict reached the controller (engine/review-transport.ts): the
 * reviewer's Write (`file`), its final answer (`agent-result`), or both,
 * saying the same verdict. The agent, its session and Agent call; for a
 * final answer, the answer's and the subagent transcript's hashes and how it
 * was extracted.
 */
export interface ReviewTransport {
  kind: 'file' | 'agent-result' | 'both';
  agent_id: string;
  session_id: string | null;
  tool_use_id: string | null;
  result_sha256: string | null;
  transcript_sha256: string | null;
  transcript_path: string | null;
  extraction: 'json' | 'fenced-json' | null;
}

/** What `review ingest` found and did (Orchestrator.ingestReview). */
export interface ReviewIngestReport {
  review_id: string;
  dispatch_id: string;
  /**
   * INGESTED: the reviewer's final answer is now the generation's verdict file. ALREADY_INGESTED: it was before.
   * WRITTEN: the reviewer wrote its verdict file (its final answer agrees, or carries no verdict). SETTLED: the
   * generation is settled already. PENDING: its reviewer has not completed — wait for the completion notification.
   * REVIEW_RESULT_INVALID: the final answer is not exactly one JSON object; it is kept as the generation's output and
   * settle refuses it for its form. REVIEW_OUTPUT_CONFLICT: the written verdict and the final answer differ.
   * STALE_ORCHESTRATION_EPOCH: the generation no longer counts. Any other: why no final answer could be taken.
   */
  outcome: 'INGESTED' | 'ALREADY_INGESTED' | 'WRITTEN' | 'SETTLED' | 'REVIEWER_RUNNING' | 'REVIEWER_INTERRUPTED' | 'REVIEWER_NOT_LAUNCHED' | 'REVIEW_RESULT_INVALID' | 'REVIEW_OUTPUT_CONFLICT' | 'STALE_ORCHESTRATION_EPOCH' | 'REVIEW_SLOT_UNSAFE' | 'REVIEW_UNATTESTED' | 'PROVIDER_INTERRUPTED' | TransportCode;
  /** Where the generation's reviewer stood (CSET-203 r13). */
  lifecycle?: ReviewerLifecycleState;
  reviewer?: ReviewerStatus;
  code: string | null;
  detail: string;
  transport: 'file' | 'agent-result' | 'both' | null;
  /** This call wrote the verdict file. */
  written: boolean;
  idempotent: boolean;
  agent_id: string | null;
  session_id: string | null;
  tool_use_id: string | null;
  result_sha256: string | null;
  transcript_sha256: string | null;
  /** canonicalVerdictSha256 of the generation's verdict file, when it holds one. */
  verdict_sha256: string | null;
  extraction: { ok: true; form: 'json' | 'fenced-json' } | { ok: false; reason: string; detail: string } | null;
  /** settle: run the settle line; wait: the reviewer is still running (run the await line); launch: none was launched; dispatch: nothing to settle here. */
  next: 'settle' | 'wait' | 'launch' | 'dispatch';
}

/** How a final answer was read as a verdict, as its attestation keeps it. */
type TransportExtraction = { ok: true; form: 'json' | 'fenced-json' } | { ok: false; reason: string; detail: string; pointer: string };

/** A verdict attestation as settle reads it: the fence's of a Write, or ingest's of a final answer. */
type Attestation = Record<string, any> & { schema?: unknown; transport?: unknown; agent_id?: unknown; agent_type?: unknown; session_id?: unknown; tool_use_id?: unknown; content_sha256?: unknown };

/**
 * A generation's output as settle and ingest find it (Orchestrator.reviewerTransport).
 * `agent`: the final answer is the verdict file (written now, or before); `file`: the reviewer's Write; `both`: both,
 * the same verdict; `conflict`: both, different; the rest: nothing that counts as a verdict.
 */
type Transported =
  | { status: 'unsafe'; detail: string }
  | { status: 'none'; detail: string; life: ReviewerLifecycle }
  /** CSET-203 r13: its reviewer runs (never a missing verdict), was lost or timed out, completed with no answer, or the provider ended it. */
  | { status: 'running'; life: Extract<ReviewerLifecycle, { state: 'RUNNING' }> }
  | { status: 'lost'; life: Extract<ReviewerLifecycle, { state: 'LOST' | 'TIMED_OUT' }> }
  | { status: 'no-output'; life: Extract<ReviewerLifecycle, { state: 'COMPLETED_NO_OUTPUT' }> }
  | { status: 'provider'; life: Extract<ReviewerLifecycle, { state: 'FAILED_PROVIDER' }> }
  | { status: 'rejected'; code: TransportCode; detail: string }
  | { status: 'oversize'; size: number }
  | { status: 'unattested'; content: string }
  | { status: 'agent'; content: string; attest: Attestation; written: boolean; repaired: boolean; extraction: TransportExtraction }
  | { status: 'file'; content: string; attest: Attestation; detail: string }
  | { status: 'both'; content: string; attest: Attestation; evidence: AgentEvidence }
  | { status: 'conflict'; content: string; attest: Attestation; evidence: AgentEvidence; pointer: string; detail: string };

const REVIEWER_TYPES: ReadonlySet<string> = new Set([REVIEWER_AGENT, 'acceptance-reviewer']);

/** The reviewer of a verdict settle takes: its agent and session, the verdict's hash as it came, and how it came. */
interface SettledReviewer {
  agent_id: string;
  session_id: string | null;
  verdict_sha256: string;
  transport: ReviewTransport;
}

/** A settled event's account of the transport (the run record reads it). */
/** Each lost completion of a criterion, as the lineage judges its gaps (engine/review-lineage.ts). */
function regressionFacts(lost: readonly CompletionCoverage[]): Record<string, RegressionFact> {
  const out: Record<string, RegressionFact> = {};
  for (const l of lost) (out[l.criterion] ??= { lost: [] }).lost.push({ node_id: l.node_id, record_id: l.record_id, code: l.code ?? 'COMPLETION_LOST', detail: l.detail ?? '' });
  return out;
}

/** The lineage facts of restoration orders: one per lost record, never an accepted rework. */
function regressionEvents(reviewId: string, plans: readonly ReworkPlan[]): LineageEventBody[] {
  return plans.flatMap((p) => (p.origin?.restoration ?? []).map((r): LineageEventBody => ({ kind: 'regression', review_id: reviewId, criterion: r.criterion, node_id: p.nodeId, record_id: r.record_id, code: r.code ?? 'COMPLETION_LOST' })));
}

/** The boundaries a verdict names uncovered for a criterion (what a repeat may still be new by: engine/review-lineage.ts). */
function uncoveredBoundaries(criteria: readonly { criterion: string; boundaries?: readonly { boundary: string; covered: boolean }[] }[], criterion: string): string[] {
  return (criteria.find((c) => c.criterion === criterion)?.boundaries ?? []).filter((b) => b.covered === false).map((b) => b.boundary);
}

/** A judged gap as a receipt records it: its verdict, why, and the progress it stood on. */
function lineageGapView(j: GapLineageJudgement, body: LineageEventBody | null, facts: GapFacts): Record<string, unknown> {
  const verdict = body !== null && body.kind === 'gap' ? body.verdict : j.verdict;
  return {
    criterion: j.criterion,
    reproduction_sha256: j.reproduction_sha256,
    fingerprint: j.fingerprint,
    verdict,
    duplicate_of: j.duplicate_of,
    basis: j.basis,
    novelty: j.novelty,
    ...(j.progress.length > 0 ? { progress: [...j.progress] } : {}),
    ...(j.basis === 'no-progress' || j.basis === 'progress' ? { progress_detail: (facts.progress?.[j.criterion]?.detail ?? '').slice(0, 600) } : {}),
    ...(j.lost !== undefined ? { lost: j.lost.map((l) => ({ ...l, detail: l.detail.slice(0, 300) })) } : {}),
  };
}

/** Each criterion's budget, ceiling and what is left of both, as a receipt and the reviewer's memory say them. */
function lineageBudgets(summary: LineageSummary): Record<string, { accepted_reworks: number; max: number; remaining: number; ceiling: number; ceiling_remaining: number; regressions: number; exhausted: boolean }> {
  return Object.fromEntries(Object.values(summary.criteria).map((c) => [c.criterion, { accepted_reworks: c.accepted_reworks, max: c.max, remaining: c.remaining, ceiling: c.ceiling, ceiling_remaining: c.ceiling_remaining, regressions: c.regressions, exhausted: c.exhausted }]));
}

function transportEvent(t: ReviewTransport): Record<string, unknown> {
  return { transport: t.kind, agent_id: t.agent_id, result_sha256: t.result_sha256, transcript_sha256: t.transcript_sha256 };
}

/** The first JSON pointer at which two JSON values differ ('' for the whole), in the first's key order. */
function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return at === '' ? '/' : at;
  const seg = (k: string | number): string => `${at}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = i < a.length && i < b.length ? firstDifference(a[i], b[i], seg(i)) : seg(i);
      if (d !== null) return d;
    }
    return null;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of [...Object.keys(x), ...Object.keys(y).filter((k) => !(k in x))]) {
    const d = k in x && k in y ? firstDifference(x[k], y[k], seg(k)) : seg(k);
    if (d !== null) return d;
  }
  return null;
}

/** Problems of a refused verdict kept in STATE.json and handed to its correction. */
const MAX_REFUSAL_PROBLEMS = 24;

/** A refusal's problem, bounded as STATE.json keeps it. */
function boundedProblem(p: ReviewProblem): ReviewProblem {
  return { ...p, pointer: p.pointer.slice(0, 200), detail: p.detail.slice(0, 600), ...(p.candidates !== undefined ? { candidates: p.candidates.slice(0, 12).map((c) => c.slice(0, 400)) } : {}) };
}

/** The refusals of a review so far: verdicts refused for their form, and generations that left none to correct (older records: the latter). */
function refusalCounts(refused: OpenReview['refused']): { format: number; review: number } {
  const format = refused.filter((r) => r.kind === 'format').length;
  return { format, review: refused.length - format };
}

/** How long past its wall-clock budget an unsettled claim is still presumed alive. */
const CLAIM_GRACE_MS = 15 * 60 * 1000;

/**
 * How long one `review await` waits while the reviewer runs, by default
 * (well within a host's Bash tool timeout); the host runs it again while the
 * reviewer still runs. At most REVIEW_AWAIT_MAX_SECONDS.
 */
export const REVIEW_AWAIT_SECONDS = 90;
export const REVIEW_AWAIT_MAX_SECONDS = 540;
const REVIEW_AWAIT_POLL_MS = 2_000;

/**
 * Reviewer interruptions (past its wall-clock, its host or task ended) one
 * review absorbs, each re-issuing its generation with nothing spent; one more
 * stops the review REVIEW_INVALID for a person (CSET-203 r13).
 */
export const MAX_REVIEWER_INTERRUPTIONS = 3;

/** The SHA-256 of an id, as status reports a task or an agent. */
const idHash = (id: string | null): string | null => (id === null ? null : createHash('sha256').update(id).digest('hex'));

/** Sleep the calling thread (a CLI waiting on a reviewer has nothing else to do). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

const STOPPED_FEATURE_STATES: ReadonlySet<FeatureState> = new Set<FeatureState>([
  'BUDGET_EXHAUSTED',
  'CANCELLED',
  'PAUSED',
]);

/** The claim was taken but its resources or worktree could not be set up. */
export class ClaimSetupError extends Error {
  readonly code = 'CLAIM_SETUP_FAILED';
  constructor(nodeId: string, cause: unknown) {
    super(`CLAIM_SETUP_FAILED: ${nodeId}: ${errorText(cause)}`);
    this.name = 'ClaimSetupError';
  }
}

/** The graph no longer hashes to what its feature was initialised with: nothing is claimed, set up or dispatched under it. */
export class GraphDriftError extends Error {
  readonly code = 'GRAPH_DRIFT';
  constructor(featureId: string, recorded: string, current: string) {
    super(
      `GRAPH_DRIFT: STATE.json of ${featureId} was initialised for graph ${recorded.slice(0, 12)}, but PORTFOLIO-GRAPH.yaml now hashes to ${current.slice(0, 12)}. A graph is immutable once its feature is initialised: restore it, or plan the change as a new feature (feature supersede).`,
    );
    this.name = 'GraphDriftError';
  }
}

/** A worker that never started is an environment failure, not a task failure. */
export function isInfrastructureFailure(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith('SPAWN_FAILED');
}

export class NotSchedulableError extends Error {
  readonly code = 'NOT_SCHEDULABLE';
  readonly reason: string;
  constructor(nodeId: string, reason: string, detail: string) {
    super(`NOT_SCHEDULABLE: ${nodeId} cannot be claimed (${reason}): ${detail}`);
    this.name = 'NotSchedulableError';
    this.reason = reason;
  }
}

export interface ClaimResult {
  claimId: string;
  /** Raw claim capability. Returned once; only its hash is stored. */
  capability: string;
  worktree: string | null;
  branch: string | null;
  attempt: number;
  mode: ClaimMode;
  expiresAt: string;
  /** Host dispatches: this generation's id and result file. */
  dispatchId?: string;
  resultFile?: string;
}

/** How a worker attempt ended, whoever ran it. */
export interface AttemptOutcome {
  status: SessionStatus;
  result: NodeResult | null;
  failureReason: string | null;
}

export type SettleReport = NodeRunReport & { idempotent: boolean };

/** The plugin subagent a host dispatches a worker node to. */
export const HOST_WORKER_AGENT = 'mycelink:module-worker';

export type DispatchStatus =
  | 'DISPATCHED'
  | 'ALL_SETTLED'
  | 'WAITING'
  | 'BLOCKED'
  | 'NEEDS_DECISION'
  | 'BUDGET_EXHAUSTED'
  | 'CANCELLED'
  | 'NO_PROGRESS'
  | 'INFRASTRUCTURE_FAILURE'
  | 'PRECONDITION_FAILED'
  | 'CONTROLLER_FAILED'
  | 'MAX_STEPS'
  /** `dispatch --resume` finished an interrupted settlement itself (see `settled`); continue with `dispatch`. */
  | 'SETTLED'
  /** Past the bounds of model-provider failures (CSET-203 r10): nothing is dispatched until a person clears it. */
  | 'PROVIDER_UNAVAILABLE';

export interface PendingDispatch {
  node_id: string;
  claim_id: string;
  state: NodeState;
  expires_at: string;
  expired: boolean;
}

export interface DispatchTicket {
  schema: 'mycelink-dispatch-ticket/1';
  feature_id: string;
  node_id: string;
  claim_id: string;
  /** This dispatch generation; a resume issues a new one and the old worker's result stops counting. */
  dispatch_id: string | null;
  /**
   * The orchestration epoch, the node's lineage and its rework generation this dispatch was issued at
   * (state/orchestration.ts): its result names the epoch (orchestration_epoch); a settle after the node's
   * lineage moved is STALE_ORCHESTRATION_EPOCH.
   */
  orchestration: { epoch: number; lineage: number; generation: number };
  attempt: number;
  /** Raw claim capability; settle and the gates need it. Only its hash is stored. */
  capability: string;
  expires_at: string;
  agent: string;
  repository: string | null;
  worktree: string | null;
  branch: string | null;
  allowed_paths: string[];
  forbidden_paths: string[];
  /** The criteria this node serves: its result names, for each, the test that proves it (engine/criteria.ts). */
  acceptance_criteria: ContextPack['acceptance_criteria'];
  verification_commands: GraphNode['verification_commands'];
  gate_commands: { gate: string; command: string }[];
  result_slot: string;
  settle_command: string;
  context_pack_path: string;
  budget: { model: string; max_turns: number; max_wall_clock_minutes: number };
  /** The rework brief the worker was given in its pack, when the node is being reworked. */
  rework?: NonNullable<ContextPack['rework']>;
  /** A held submission's criterion evidence correction (engine/criteria.ts): only a corrected result is asked for. */
  correction?: NonNullable<ContextPack['correction']>;
  /**
   * A claim held for its structured review-gap challenge (CSET-203 r7): the previous generation's answer and the
   * red gate that passed every test it declared, by output hash and test ids. Asked once.
   */
  challenge_request?: { fingerprint: string; gate_output_sha256: string; tests: string[]; capsule_id?: string | null };
  /** The same generation resumed after its holder's model provider failed (CSET-203 r10): where it stands; nothing of the old holder's counts. */
  provider_resume?: { class: string; request_id: string | null; head_sha: string | null; commits: number; state: string; dirty: string[] };
  /** The same generation reissued after its order was rebased to a later revision of its review (CSET-203 r14). */
  review_rebase?: { review_id: string; from_revision: number; to_revision: number };
  /** Where the node's history starts and which paths are tests: what settle verifies the history by. */
  tdd: { base_sha: string | null; policy_sha256: string; test_paths: string[]; production_roots: string[]; declaration_paths: string[] } | null;
  /**
   * The module command the claim's gates and fresh verification run
   * (engine/modules.ts), bound by its hash, and the full suite regression
   * runs. Null for a node without a module verifier.
   */
  verification: {
    module: string;
    module_sha256: string;
    path: string;
    runtime_tests: boolean;
    steps: string[][];
    test: string[];
    report: string | null;
    regression: string[];
  } | null;
  /** The setup the controller ran (or reused) in the worktree before this ticket, bound to the claim. */
  worktree_setup: {
    status: 'complete' | 'reused' | 'not-configured';
    config_sha256: string | null;
    receipt_sha256: string | null;
    receipt_path: string | null;
    commands: string[][];
    required_paths: string[];
  };
  prompt: string;
  resumed: boolean;
  result_present: boolean;
}

export interface DispatchResult {
  status: DispatchStatus;
  detail: string;
  /** A node's ticket, or an acceptance review's (`kind: acceptance-review`). */
  ticket?: DispatchTicket | ReviewTicket;
  /** The settlement `dispatch --resume` finished, when it did. */
  settled?: SettleReport;
  controller_reports: NodeRunReport[];
  /** Reviews this dispatch settled from a verdict already in its slot, or whose reworks it finished. */
  review_reports?: ReviewSettleReport[];
  /** The review out with a reviewer, when there is one. */
  pending_review?: PendingReview | null;
  pending: PendingDispatch[];
  deferred: { node_id: string; reason: string }[];
}

function resultInSlot(cwd: string, resultFile: string = WORKER_RESULT_FILE): boolean {
  try {
    return (
      lstatSync(join(cwd, WORKER_RESULT_DIR)).isDirectory() &&
      lstatSync(join(cwd, WORKER_RESULT_DIR, resultFile)).isFile()
    );
  } catch {
    return false;
  }
}

/**
 * Usage of a host-run worker. The host's Agent tool reports no stream the
 * controller can count, so the session is counted and the worker's own
 * figures are taken only as bounded, non-negative integers.
 */
function hostUsage(result: NodeResult | null, startedMs: number): UsageTotals {
  const n = (v: unknown, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0;
  const reported = result?.usage ?? {};
  return {
    model_turns: n(reported.model_turns, 10_000),
    input_tokens: n(reported.input_tokens, 100_000_000),
    output_tokens: n(reported.output_tokens, 100_000_000),
    wall_clock_ms: Number.isNaN(startedMs) ? 0 : Math.max(0, Date.now() - startedMs),
    sessions: 1,
  };
}

/**
 * Integrating a node's work would lose a sibling's standing proof that the integration head holds (CSET-201 final):
 * never integrated; the order reissued from the latest head, nothing charged.
 */
export class SiblingProgressLostError extends Error {
  readonly lost: CompletionCoverage[];
  readonly from: string;
  readonly to: string;
  constructor(nodeId: string, lost: CompletionCoverage[], from: string, to: string) {
    super(`SIBLING_PROGRESS_LOST: integrating ${nodeId} at ${to.slice(0, 12)} would lose ${lost.map((l) => `${l.node_id} ${l.criterion} (${l.code})`).join('; ')}, which ${from.slice(0, 12)} holds`);
    this.name = 'SiblingProgressLostError';
    this.lost = lost;
    this.from = from;
    this.to = to;
  }
}

/** Uncharged refusals to integrate one order's work before the next one is charged (a worker that keeps erasing a sibling's proof). */
export const MAX_SIBLING_LOSSES = 2;

export class SettleInProgressError extends Error {
  readonly code = 'SETTLE_IN_PROGRESS';
  constructor(nodeId: string, settling: { pid: number; host: string; started_at: string }) {
    super(
      `SETTLE_IN_PROGRESS: ${nodeId} is already being settled by pid ${settling.pid} on ${settling.host} since ${settling.started_at}.`,
    );
    this.name = 'SettleInProgressError';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const WSL_CODEX_INTERNAL_RECONCILE = Symbol('trusted WSL Codex reconciliation');

export class Orchestrator {
  readonly controlRoot: string;
  readonly featureId: string;
  readonly paths: FeaturePaths;
  readonly workspace: Workspace;
  private readonly adapter: SessionAdapter;
  private readonly owner: string;
  private readonly workerEnv: Record<string, string>;
  private readonly recall: ((node: GraphNode) => MemoryRef[]) | undefined;
  private readonly preflight: (() => PreflightResult) | undefined;
  private readonly settleFault: ((point: SettleFaultPoint) => void) | undefined;
  /** The controller copy of the answer the settle in progress concluded, by node: its receipt records it (PCM-101 final). */
  private readonly concludedAnswers = new Map<string, { file: string; sha256: string }>();
  // Experimental controller-only handoff: the host ticket's raw capability
  // cannot be reconstructed from STATE's hash after this process exits.
  // Never serialize this map or pass it to the Linux worker/reviewer.
  private readonly experimentalWslCapabilities = new Map<string, string>();
  private readonly capsuleFault: ((point: string) => void) | undefined;
  private preflightResult: PreflightResult | null = null;

  constructor(options: OrchestratorOptions) {
    this.controlRoot = resolve(options.controlRoot);
    this.featureId = options.featureId;
    this.paths = featurePaths(this.controlRoot, options.featureId);
    this.workspace = loadWorkspace(this.controlRoot);
    this.adapter = options.adapter;
    this.owner = options.owner ?? 'mycelink';
    this.workerEnv = options.workerEnv ?? {};
    this.recall = options.recall;
    this.preflight = options.preflight;
    this.settleFault = options.settleFault;
    this.capsuleFault = options.capsuleFault;
  }

  /** The adapter preflight, run at most once per orchestrator. */
  adapterReady(): PreflightResult {
    if (this.preflightResult === null) this.preflightResult = this.preflight ? this.preflight() : { ok: true };
    return this.preflightResult;
  }

  /**
   * Experimental read-only claim/policy inspection for the WSL controller.
   * This is NOT a launch, an authorization, or a lease held across the return:
   * the complete controller must hold the state lifecycle lock through broker
   * consumption, apply and revocation before this can become an execution path.
   */
  inspectWslCodexClaim(nodeId: string, claimId: string, dispatchId: string, proposedPaths: readonly string[]): {
    claim: string; generation: string; worktree: string; base_sha: string; allowed_paths: string[];
  } {
    if (this.workspace.config.provider.provider !== 'codex') throw new Error('WSL_CODEX_NOT_CONFIGURED');
    this.assertGraphUnchanged();
    const node = this.node(nodeId);
    const inspect = () => withLock(stateLockPath(this.paths.featureDir), () => {
      const state = this.state();
      const claim = state.nodes[nodeId]?.claim;
      const expires = Date.parse(claim?.expires_at ?? '');
      if (STOPPED_FEATURE_STATES.has(state.feature_state) ||
          typeof state.superseded_by === 'string' ||
          node.repository === null || claim?.mode !== 'host' ||
          claim.claim_id !== claimId || claim.dispatch_id !== dispatchId ||
          claim.epoch !== currentEpoch(state) || claim.lineage !== lineageOf(state, nodeId) ||
          claim.settling !== null || claim.provider_interrupted != null ||
          claim.evidence_correction != null || claim.challenge_conversion != null ||
          claim.worktree === null || !existsSync(claim.worktree) ||
          !/^[0-9a-f]{40}$/.test(claim.base_sha ?? '') ||
          !Number.isFinite(expires) || expires <= Date.now() ||
          !activeLeases(state).some((lease) => lease.node_id === nodeId &&
            lease.claim_id === claimId && lease.dispatch_id === dispatchId)) {
        throw new Error('WSL_CLAIM_STALE: no live generation-bound host claim');
      }
      const allowed = expandAllowedProposalPaths(proposedPaths,
        { allowed: node.allowed_paths, forbidden: node.forbidden_paths ?? [] });
      return { claim: claimId, generation: dispatchId, worktree: claim.worktree,
        base_sha: claim.base_sha as string, allowed_paths: allowed };
    }, { timeoutMs: 2_000, pollMs: 10, purpose: 'experimental WSL claim inspection' });
    return codexLifecycleEnabled(this.paths.featureDir)
      ? withCodexLifecycleLock(this.paths.featureDir, inspect, { timeoutMs: 2_000 })
      : inspect();
  }

  /**
   * Trusted synchronous broker/apply critical section. Claim policy is read
   * afresh under the same mutex every opted-in STATE mutation must acquire.
   * This does not launch Codex and is not callable by the isolated worker.
   */
  withLiveWslCodexClaim<T>(
    nodeId: string, claimId: string, dispatchId: string, proposedPaths: readonly string[],
    consume: (binding: { claim: string; generation: string; worktree: string; base_sha: string; allowed_paths: string[] }) => T,
  ): T {
    if (!codexLifecycleEnabled(this.paths.featureDir)) throw new Error('CODEX_LIFECYCLE_NOT_ENABLED');
    return withCodexLifecycleLock(this.paths.featureDir, () => {
      const binding = this.inspectWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths);
      const result = consume(binding);
      if (result !== null && typeof result === 'object' && 'then' in result) {
        throw new Error('CODEX_LIFECYCLE_ASYNC_FORBIDDEN');
      }
      // A synchronous callback may itself perform trusted state operations,
      // and expiry can pass during sealing. Never report its output accepted
      // without another live generation check under the same mutex.
      this.inspectWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths);
      return result;
    });
  }

  /**
   * Stage verified Git-object bytes atomically with a live host-claim check.
   * A caller MUST re-enter the lifecycle mutex after its model turn; this
   * staging receipt is not a broker/settlement authorization or worker lease.
   */
  stageExperimentalWslCodexClaimSource(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[]): ReturnType<typeof stageImmutableWslCodexSource> {
    let staged: ReturnType<typeof stageImmutableWslCodexSource> | undefined;
    try {
      return this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
        staged = stageImmutableWslCodexSource(grant.worktree, grant.base_sha, grant.claim, grant.generation);
        return staged;
      });
    } catch (error) {
      // A post-stage generation recheck may reject an already-created stage.
      if (staged) staged.dispose();
      throw error;
    }
  }

  /** Preflight only: no lease or authorization survives return; apply must use this inside its own critical section. */
  assertExperimentalWslCodexApplyBase(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[]): void {
    this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
      assertImmutableWslApplyBase(grant.worktree, grant.base_sha, grant.allowed_paths);
    });
  }

  /**
   * Opt-in Windows/WSL process-readiness tracer. Not a production dispatch:
   * command is trusted test/controller input, never a prompt or worker value.
   * The live claim and both readiness checks are inside the lifecycle mutex.
   */
  startExperimentalWslCodexGeneration(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[], command: readonly string[]):
    { claim: string; generation: string; pid: number; pgid: number; start: string } {
    let launched = false;
    try {
      return this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
        const receipt = startExperimentalWslProcess(this.paths.featureDir, grant.claim, grant.generation, command);
        launched = true;
        return receipt;
      });
    } catch (error) {
      // A post-readiness lease/epoch recheck may fail after Linux launch;
      // before surfacing it, revoke the process rather than orphan it.
      if (launched) revokeWslCodexProcesses(this.paths.featureDir);
      throw error;
    }
  }

  /**
   * Experimental broker consumption of a registered, completed Linux worker.
   * Rechecks the live host generation under the lifecycle mutex and derives
   * exact source hashes from Git objects. This does NOT apply or settle work.
   */
  sealExperimentalWslCodexWorker(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[]): WslCodexWorkerSeal {
    return this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths,
      (grant) => sealRegisteredWslCodexWorker(this.paths.featureDir, this.controlRoot, grant));
  }

  /** Distinct Linux reviewer principal and root-only verdict, after worker seal. */
  sealExperimentalWslCodexReviewer(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[]): WslCodexWorkerSeal {
    return this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths,
      (grant) => sealRegisteredWslCodexReviewer(this.paths.featureDir, this.controlRoot, grant));
  }

  readExperimentalWslCodexSealedTurn(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[]): WslCodexVerifiedTurn {
    return this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths,
      (grant) => {
        assertImmutableWslApplyBase(grant.worktree, grant.base_sha, grant.allowed_paths);
        const turn = readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
        assertImmutableWslApplyBase(grant.worktree, grant.base_sha, grant.allowed_paths);
        return turn;
      });
  }

  /**
   * First, deliberately incomplete transaction phase: the controller re-reads
   * both root-owned seals under the live claim and journals before touching the
   * test path. No gate, implementation apply or settlement is implied. An
   * interrupted phase is not retried blindly; reconciliation must examine it.
   */
  applyExperimentalWslCodexRedTest(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[], testPath: string):
    { phase: 'red-committed'; testPath: string; commit: string } {
    return this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
      if (!/^tests\/[A-Za-z0-9_./-]+\.mjs$/.test(testPath) ||
          !grant.allowed_paths.includes(testPath) || proposedPaths.length !== 2 ||
          grant.allowed_paths.length !== 2 ||
          !this.node(nodeId).verification_commands.some((step) => step.command.includes(testPath)))
        throw new Error('WSL_RED_TEST_PATH_DENIED');
      const journalDir = join(this.paths.featureDir, 'wsl-codex-transactions');
      const journal = join(journalDir, createHash('sha256').update(`${nodeId}\0${claimId}\0${dispatchId}`).digest('hex') + '.json');
      if (existsSync(journal)) throw new Error('WSL_RED_JOURNAL_ALREADY_EXISTS');
      assertImmutableWslApplyBase(grant.worktree, grant.base_sha, grant.allowed_paths);
      const turn = readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
      const paths = Object.keys(turn.proposals).sort();
      if (paths.length !== 2 || paths[0] !== [...grant.allowed_paths].sort()[0] ||
          paths[1] !== [...grant.allowed_paths].sort()[1]) throw new Error('WSL_RED_PROPOSAL_INCOMPLETE');
      const content = turn.proposals[testPath];
      if (typeof content !== 'string' || Buffer.byteLength(content) > 512 * 1024 ||
          !content.trim()) throw new Error('WSL_RED_TEST_INVALID');
      assertImmutableWslApplyBase(grant.worktree, grant.base_sha, grant.allowed_paths);
      // This phase replaces only the verifier's declared test, never a
      // previously unrelated file; the gate itself must verify RED.
      const prior = runGit(grant.worktree, ['show', `${grant.base_sha}:${testPath}`], { allowFail: true });
      if (prior.exitCode !== 0 || prior.stdout === content) throw new Error('WSL_RED_TEST_UNCHANGED');
      mkdirSync(journalDir, { recursive: true });
      const proposalSha256 = createHash('sha256').update(content).digest('hex');
      // No replay on an unknown phase, including a crash after the Git commit
      // but before the phase advance. A later reconciler must verify the tree.
      const fd = openSync(journal, 'wx');
      try {
        writeSync(fd, JSON.stringify({ phase: 'red-intent', nodeId, claimId, dispatchId,
          base: grant.base_sha, testPath, proposalSha256 }) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      const destination = join(grant.worktree, ...testPath.split('/'));
      writeTextAtomic(destination, content);
      if (readFileSync(destination, 'utf8') !== content) throw new Error('WSL_RED_TEST_WRITE_DRIFT');
      const status = runGit(grant.worktree, ['status', '--porcelain', '--untracked-files=all']).stdout.trimEnd();
      if (status !== ` M ${testPath}`) throw new Error('WSL_RED_TEST_WRITE_DRIFT');
      runGit(grant.worktree, ['add', '--', testPath]);
      const staged = runGit(grant.worktree, ['diff', '--cached', '--name-only']).stdout.trim();
      if (staged !== testPath) throw new Error('WSL_RED_TEST_STAGE_DRIFT');
      runGit(grant.worktree, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `test: WSL Codex RED ${nodeId}`]);
      const commit = runGit(grant.worktree, ['rev-parse', 'HEAD']).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commit) ||
          runGit(grant.worktree, ['rev-parse', 'HEAD^']).stdout.trim() !== grant.base_sha ||
          runGit(grant.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).stdout.trim() !== testPath)
        throw new Error('WSL_RED_COMMIT_DRIFT');
      writeTextAtomic(journal, JSON.stringify({ phase: 'red-committed', nodeId, claimId, dispatchId,
        base: grant.base_sha, testPath, proposalSha256, commit }) + '\n');
      return { phase: 'red-committed', testPath, commit };
    });
  }

  /** Host-owned exact RED gate; an ambiguous running journal is never replayed. */
  runExperimentalWslCodexRedGate(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[], capability: string):
    { phase: 'red-gated'; gate: 'red'; exitCode: 0; argv: string[]; commit: string } {
    const journal = join(this.paths.featureDir, 'wsl-codex-transactions',
      createHash('sha256').update(`${nodeId}\0${claimId}\0${dispatchId}`).digest('hex') + '.json');
    let worktree = '';
    let commit = '';
    this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
      const claim = this.state().nodes[nodeId]?.claim;
      if (!claim?.capability_sha256 || !capabilityMatches(capability, claim.capability_sha256))
        throw new CapabilityError('CAPABILITY_INVALID', 'RED gate requires the current host capability');
      if (!existsSync(journal)) throw new Error('WSL_RED_JOURNAL_MISSING');
      const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
      if (record['phase'] !== 'red-committed' || record['nodeId'] !== nodeId ||
          record['claimId'] !== claimId || record['dispatchId'] !== dispatchId ||
          record['base'] !== grant.base_sha || typeof record['testPath'] !== 'string' ||
          !grant.allowed_paths.includes(record['testPath']) ||
          typeof record['commit'] !== 'string' || !/^[0-9a-f]{40}$/.test(record['commit']))
        throw new Error('WSL_RED_JOURNAL_INVALID_OR_ALREADY_GATED');
      worktree = grant.worktree;
      commit = record['commit'];
      if (runGit(worktree, ['rev-parse', 'HEAD']).stdout.trim() !== commit ||
          runGit(worktree, ['rev-parse', 'HEAD^']).stdout.trim() !== grant.base_sha ||
          runGit(worktree, ['status', '--porcelain', '--untracked-files=all']).stdout.trim() !== '' ||
          runGit(worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).stdout.trim() !== record['testPath'] ||
          createHash('sha256').update(runGit(worktree, ['show', `${commit}:${record['testPath']}`]).stdout).digest('hex') !== record['proposalSha256'])
        throw new Error('WSL_RED_COMMIT_DRIFT');
      writeTextAtomic(journal, JSON.stringify({ ...record, phase: 'red-gate-running' }) + '\n');
    });
    // The CLI gate needs its own STATE lock; do not hold the lifecycle mutex
    // while it runs. Never persist the capability-bearing argv in the journal.
    const gate = this.gateCommands(nodeId, capability).find((entry) => entry.gate === 'red');
    if (!gate || gate.argv[0] !== 'node') throw new Error('WSL_RED_GATE_UNDECLARED');
    const result = spawnSync(gate.argv[0], gate.argv.slice(1), {
      cwd: worktree, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(`WSL_RED_GATE_REJECTED:${result.status ?? 'spawn'}`);
    this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
      const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
      if (record['phase'] !== 'red-gate-running' || record['commit'] !== commit ||
          grant.worktree !== worktree ||
          runGit(worktree, ['rev-parse', 'HEAD']).stdout.trim() !== commit ||
          runGit(worktree, ['status', '--porcelain', '--untracked-files=all']).stdout.trim() !== '')
        throw new Error('WSL_RED_GATE_POST_DRIFT');
      writeTextAtomic(journal, JSON.stringify({ ...record, phase: 'red-gated', gate: 'red',
        exitCode: 0, argvSha256: createHash('sha256').update(JSON.stringify(gate.argv)).digest('hex') }) + '\n');
    });
    return { phase: 'red-gated', gate: 'red', exitCode: 0, argv: gate.argv.slice(0, -2), commit };
  }

  /** Apply only the implementation from independently sealed proposal bytes after a controller RED gate. */
  applyExperimentalWslCodexGreenImplementation(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[], implementationPath: string):
    { phase: 'green-committed'; implementationPath: string; parent: string; commit: string } {
    const journal = join(this.paths.featureDir, 'wsl-codex-transactions',
      createHash('sha256').update(`${nodeId}\0${claimId}\0${dispatchId}`).digest('hex') + '.json');
    return this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
      if (!existsSync(journal)) throw new Error('WSL_GREEN_JOURNAL_MISSING');
      const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
      if (record['phase'] !== 'red-gated' || record['gate'] !== 'red' || record['exitCode'] !== 0 ||
          record['nodeId'] !== nodeId || record['claimId'] !== claimId ||
          record['dispatchId'] !== dispatchId || record['base'] !== grant.base_sha ||
          typeof record['commit'] !== 'string' || !/^[0-9a-f]{40}$/.test(record['commit']) ||
          typeof record['testPath'] !== 'string' || implementationPath === record['testPath'] ||
          !grant.allowed_paths.includes(implementationPath) || grant.allowed_paths.length !== 2)
        throw new Error('WSL_GREEN_JOURNAL_INVALID_OR_ALREADY_APPLIED');
      const parent = record['commit'];
      assertImmutableWslApplyBase(grant.worktree, parent, grant.allowed_paths);
      if (runGit(grant.worktree, ['rev-parse', `${parent}^`]).stdout.trim() !== grant.base_sha ||
          runGit(grant.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', parent]).stdout.trim() !== record['testPath'] ||
          createHash('sha256').update(runGit(grant.worktree, ['show', `${parent}:${record['testPath']}`]).stdout).digest('hex') !== record['proposalSha256'])
        throw new Error('WSL_GREEN_RED_COMMIT_DRIFT');
      const turn = readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
      const content = turn.proposals[implementationPath];
      if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 512 * 1024 ||
          createHash('sha256').update(turn.proposals[record['testPath']] ?? '').digest('hex') !== record['proposalSha256'])
        throw new Error('WSL_GREEN_PROPOSAL_DRIFT');
      const prior = runGit(grant.worktree, ['show', `${grant.base_sha}:${implementationPath}`], { allowFail: true });
      if (prior.exitCode === 0 && prior.stdout === content) throw new Error('WSL_GREEN_IMPLEMENTATION_UNCHANGED');
      if (prior.exitCode !== 0 && existsSync(join(grant.worktree, ...implementationPath.split('/'))))
        throw new Error('WSL_GREEN_IMPLEMENTATION_SOURCE_DRIFT');
      assertImmutableWslApplyBase(grant.worktree, parent, grant.allowed_paths);
      writeTextAtomic(journal, JSON.stringify({ ...record, phase: 'green-intent', implementationPath,
        implementationSha256: createHash('sha256').update(content).digest('hex') }) + '\n');
      const destination = join(grant.worktree, ...implementationPath.split('/'));
      writeTextAtomic(destination, content);
      if (readFileSync(destination, 'utf8') !== content ||
          runGit(grant.worktree, ['status', '--porcelain', '--untracked-files=all']).stdout.trimEnd() !==
            `${prior.exitCode === 0 ? ' M' : '??'} ${implementationPath}`)
        throw new Error('WSL_GREEN_WRITE_DRIFT');
      runGit(grant.worktree, ['add', '--', implementationPath]);
      if (runGit(grant.worktree, ['diff', '--cached', '--name-only']).stdout.trim() !== implementationPath)
        throw new Error('WSL_GREEN_STAGE_DRIFT');
      runGit(grant.worktree, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `feat: WSL Codex GREEN ${nodeId}`]);
      const commit = runGit(grant.worktree, ['rev-parse', 'HEAD']).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commit) || runGit(grant.worktree, ['rev-parse', 'HEAD^']).stdout.trim() !== parent ||
          runGit(grant.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).stdout.trim() !== implementationPath)
        throw new Error('WSL_GREEN_COMMIT_DRIFT');
      writeTextAtomic(journal, JSON.stringify({ ...record, phase: 'green-committed',
        implementationPath, implementationSha256: createHash('sha256').update(content).digest('hex'),
        greenCommit: commit }) + '\n');
      return { phase: 'green-committed', implementationPath, parent, commit };
    });
  }

  /** Run declared GREEN then regression, journaling each transition outside the lifecycle lock. */
  runExperimentalWslCodexGreenGates(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[], capability: string):
    { gate: 'green' | 'regression'; exitCode: 0; argv: string[]; commit: string }[] {
    const journal = join(this.paths.featureDir, 'wsl-codex-transactions',
      createHash('sha256').update(`${nodeId}\0${claimId}\0${dispatchId}`).digest('hex') + '.json');
    const declared = this.gateCommands(nodeId, capability);
    const receipts: { gate: 'green' | 'regression'; exitCode: 0; argv: string[]; commit: string }[] = [];
    for (const [gateName, before, running, after] of [
      ['green', 'green-committed', 'green-gate-running', 'green-gated'],
      ['regression', 'green-gated', 'regression-gate-running', 'gates-complete'],
    ] as const) {
      const gate = declared.find((entry) => entry.gate === gateName);
      if (!gate || gate.argv[0] !== 'node') throw new Error('WSL_GREEN_GATE_UNDECLARED');
      let worktree = '';
      let commit = '';
      this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
        const claim = this.state().nodes[nodeId]?.claim;
        if (!claim?.capability_sha256 || !capabilityMatches(capability, claim.capability_sha256))
          throw new CapabilityError('CAPABILITY_INVALID', 'GREEN gate requires the current host capability');
        if (!existsSync(journal)) throw new Error('WSL_GREEN_JOURNAL_MISSING');
        const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
        if (record['phase'] !== before || record['nodeId'] !== nodeId ||
            record['claimId'] !== claimId || record['dispatchId'] !== dispatchId ||
            record['base'] !== grant.base_sha || typeof record['greenCommit'] !== 'string' ||
            !/^[0-9a-f]{40}$/.test(record['greenCommit']) ||
            typeof record['commit'] !== 'string' ||
            runGit(grant.worktree, ['rev-parse', `${record['greenCommit']}^`]).stdout.trim() !== record['commit'] ||
            runGit(grant.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', record['greenCommit']]).stdout.trim() !== record['implementationPath'])
          throw new Error('WSL_GREEN_JOURNAL_INVALID_OR_ALREADY_GATED');
        worktree = grant.worktree;
        commit = record['greenCommit'];
        assertImmutableWslApplyBase(worktree, commit, grant.allowed_paths);
        if (createHash('sha256').update(runGit(worktree, ['show', `${commit}:${record['implementationPath']}`]).stdout).digest('hex') !== record['implementationSha256'])
          throw new Error('WSL_GREEN_COMMIT_DRIFT');
        writeTextAtomic(journal, JSON.stringify({ ...record, phase: running }) + '\n');
      });
      const result = spawnSync(gate.argv[0], gate.argv.slice(1), {
        cwd: worktree, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      if (result.error || result.status !== 0) throw new Error(`WSL_${gateName.toUpperCase()}_GATE_REJECTED:${result.status ?? 'spawn'}`);
      this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
        const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
        if (record['phase'] !== running || record['greenCommit'] !== commit || grant.worktree !== worktree)
          throw new Error('WSL_GREEN_GATE_POST_DRIFT');
        assertImmutableWslApplyBase(worktree, commit, grant.allowed_paths);
        writeTextAtomic(journal, JSON.stringify({ ...record, phase: after,
          [`${gateName}Gate`]: { exitCode: 0, argvSha256: createHash('sha256').update(JSON.stringify(gate.argv)).digest('hex') } }) + '\n');
      });
      receipts.push({ gate: gateName, exitCode: 0, argv: gate.argv.slice(0, -2), commit });
    }
    return receipts;
  }

  /**
   * Revalidate a completed experimental gate chain under the live claim.
   * This is evidence for a later controller settlement, never permission to
   * settle: an interrupted/running journal or a changed Git tree is denied.
   */
  verifyExperimentalWslCodexCompletedGates(nodeId: string, claimId: string, dispatchId: string,
    proposedPaths: readonly string[], capability: string):
    { redCommit: string; commit: string; gates: { gate: 'red' | 'green' | 'regression'; exitCode: 0; argv: string[] }[] } {
    return this.withLiveWslCodexClaim(nodeId, claimId, dispatchId, proposedPaths, (grant) => {
      const claim = this.state().nodes[nodeId]?.claim;
      if (!claim?.capability_sha256 || !capabilityMatches(capability, claim.capability_sha256))
        throw new CapabilityError('CAPABILITY_INVALID', 'completed gate evidence requires the current host capability');
      const journal = join(this.paths.featureDir, 'wsl-codex-transactions',
        createHash('sha256').update(`${nodeId}\0${claimId}\0${dispatchId}`).digest('hex') + '.json');
      if (!existsSync(journal)) throw new Error('WSL_GATE_JOURNAL_MISSING');
      const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
      if (record['phase'] !== 'gates-complete' || record['nodeId'] !== nodeId ||
          record['claimId'] !== claimId || record['dispatchId'] !== dispatchId ||
          record['base'] !== grant.base_sha || typeof record['testPath'] !== 'string' ||
          typeof record['implementationPath'] !== 'string' ||
          record['testPath'] === record['implementationPath'] ||
          !grant.allowed_paths.includes(record['testPath']) ||
          !grant.allowed_paths.includes(record['implementationPath']) || grant.allowed_paths.length !== 2 ||
          typeof record['commit'] !== 'string' || !/^[0-9a-f]{40}$/.test(record['commit']) ||
          typeof record['greenCommit'] !== 'string' || !/^[0-9a-f]{40}$/.test(record['greenCommit']))
        throw new Error('WSL_GATE_JOURNAL_INVALID');
      const redCommit = record['commit'];
      const commit = record['greenCommit'];
      assertImmutableWslApplyBase(grant.worktree, commit, grant.allowed_paths);
      if (runGit(grant.worktree, ['rev-parse', `${redCommit}^`]).stdout.trim() !== grant.base_sha ||
          runGit(grant.worktree, ['rev-parse', `${commit}^`]).stdout.trim() !== redCommit ||
          runGit(grant.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', redCommit]).stdout.trim() !== record['testPath'] ||
          runGit(grant.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).stdout.trim() !== record['implementationPath'])
        throw new Error('WSL_GATE_COMMIT_DRIFT');
      const turn = readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
      for (const [path, digest] of [[record['testPath'], record['proposalSha256']],
        [record['implementationPath'], record['implementationSha256']]] as const) {
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) ||
            createHash('sha256').update(turn.proposals[path] ?? '').digest('hex') !== digest ||
            createHash('sha256').update(runGit(grant.worktree, ['show', `${commit}:${path}`]).stdout).digest('hex') !== digest)
          throw new Error('WSL_GATE_PROPOSAL_DRIFT');
      }
      const gates = this.gateCommands(nodeId, capability).filter((g) =>
        g.gate === 'red' || g.gate === 'green' || g.gate === 'regression');
      if (gates.map((g) => g.gate).join(',') !== 'red,green,regression')
        throw new Error('WSL_GATE_UNDECLARED');
      const evidence = this.state().nodes[nodeId]?.evidence;
      for (const gate of gates) {
        const receipt = gate.gate === 'red' ? record : record[`${gate.gate}Gate`] as Record<string, unknown> | undefined;
        if (!receipt || receipt['exitCode'] !== 0 ||
            receipt['argvSha256'] !== createHash('sha256').update(JSON.stringify(gate.argv)).digest('hex') ||
            gate.argv.at(-2) !== '--capability' || gate.argv.at(-1) !== capability)
          throw new Error('WSL_GATE_JOURNAL_INVALID');
        const proof = evidence?.[gate.gate];
        const expectedCommit = gate.gate === 'red' ? redCommit : commit;
        // The journal records the wrapper exit; the CLI's own evidence must
        // independently bind the declared verifier output to this exact head.
        if (!proof || proof.kind !== gate.gate || proof.node_id !== nodeId ||
            typeof proof.cwd !== 'string' || join(this.controlRoot, proof.cwd) !== grant.worktree ||
            proof.commit_sha !== expectedCommit ||
            !Array.isArray(proof.command) ||
            proof.command.join('\0') !== this.node(nodeId).verification_commands[0]?.command.join('\0') ||
            typeof proof.output_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(proof.output_sha256) ||
            (gate.gate === 'red' ? proof.exit_code === 0 || proof.red_reason !== 'behaviour-missing'
              : proof.exit_code !== 0) ||
            typeof proof.output_path !== 'string' ||
            !/^[\w./-]+$/.test(proof.output_path) || proof.output_path.split('/').includes('..') ||
            !existsSync(join(this.controlRoot, proof.output_path)) ||
            createHash('sha256').update(readFileSync(join(this.controlRoot, proof.output_path))).digest('hex') !== proof.output_sha256)
          throw new Error('WSL_GATE_EVIDENCE_INVALID');
      }
      // Never return the capability-bearing tail to a caller that may render
      // these receipts into result JSON, logs, or a reviewer prompt.
      return { redCommit, commit, gates: gates.map((gate) => ({ gate: gate.gate as 'red' | 'green' | 'regression',
        exitCode: 0 as const, argv: gate.argv.slice(0, -2) })) };
    });
  }

  /**
   * Opt-in trusted host transaction. The controller owns launch, both seals,
   * Git changes and verifier argv; nothing from the worker can authorize them.
   * Until terminal result construction is independently verified, never
   * manufacture a DONE receipt or let the normal dispatch call this path.
   */
  async runExperimentalWslCodexTransaction(request: {
    nodeId: string; claimId: string; generation: string; allowedPaths: string[]; prompt: string;
    isolationProbe?: 'mcp' | 'builtin';
    refusalFixture?: 'hook-exit-nonzero' | 'broker-denied' | 'unsealed-transport';
    interruptAfter?: 'first-apply' | 'result-written' | 'post-settle'; onPhase?: (phase: 'model-complete') => Promise<void>;
  }, internal?: symbol): Promise<{ claim: string; generation: string; workerSeal: string; reviewerSeal: string;
    sourceSha256: Record<string, string>;
    model: { platform: 'linux'; apiRequests: number; mcpCalls: number; builtinCalls: number };
    isolation?: { hostMountDenied: boolean; directEgressDenied: boolean; otherRoleSlotDenied: boolean };
    gates: { gate: 'red' | 'green' | 'regression'; exitCode: 0; argv: string[] }[];
    settlement: { outcome: string; idempotent: boolean; usageSessions: number } }> {
    if (process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1' ||
        process.env['MYCELINK_LIVE_WSL_CODEX_AUTH'] !== '1')
      throw new Error('WSL_CODEX_EXPERIMENT_NOT_ENABLED');
    const { nodeId, claimId, generation, allowedPaths } = request;
    if (request.refusalFixture && !['hook-exit-nonzero', 'broker-denied', 'unsealed-transport'].includes(request.refusalFixture))
      throw new Error('WSL_CODEX_UNKNOWN_REFUSAL_FIXTURE');
    if (allowedPaths.length !== 2 || !allowedPaths.includes('tests/run.mjs') ||
        !allowedPaths.includes('src/publish.js')) throw new Error('WSL_CODEX_TRANSACTION_PATH_DENIED');
    const capability = this.experimentalWslCapabilities.get(`${nodeId}\0${claimId}\0${generation}`);
    if (!capability) throw new Error('WSL_CODEX_CAPABILITY_UNAVAILABLE');
    // Escrow is Windows-user DPAPI ciphertext, scoped to this host generation;
    // neither the WSL principal nor a journal reader receives the capability.
    const escrowScope = `${this.featureId}\0${nodeId}\0${claimId}\0${generation}`;
    const escrowFile = join(this.paths.featureDir, 'wsl-codex-transactions',
      createHash('sha256').update(`${nodeId}\0${claimId}\0${generation}`).digest('hex') + '.cap');
    const resuming = internal === WSL_CODEX_INTERNAL_RECONCILE;
    if (!resuming) {
      // Refuse a mutable checkout before escrowing or staging Linux source.
      this.assertExperimentalWslCodexApplyBase(nodeId, claimId, generation, allowedPaths);
      this.withLiveWslCodexClaim(nodeId, claimId, generation, allowedPaths, () => {
        if (existsSync(escrowFile)) throw new Error('WSL_CODEX_ESCROW_ALREADY_ISSUED');
        writeTextAtomic(escrowFile, protectExperimentalWslCapability(capability, escrowScope) + '\n');
      });
    }
    const stage = resuming ? null : this.stageExperimentalWslCodexClaimSource(nodeId, claimId, generation, allowedPaths);
    try {
      let workerSealHash: string;
      let reviewerSealHash: string;
      if (!resuming) {
      if (request.isolationProbe === 'mcp' && !stage?.hashes['mcp.py'])
        throw new Error('WSL_CODEX_MCP_FIXTURE_NOT_IN_IMMUTABLE_SOURCE');
      const script = join(packageRoot(), 'scripts', 'wsl-codex-turn.py');
      const translated = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--',
        'wslpath', '-u', script.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      if (translated.status !== 0 || !translated.stdout?.trim().startsWith('/mnt/'))
        throw new Error('WSL_CODEX_TURN_SCRIPT_UNAVAILABLE');
      const probePrompt = request.isolationProbe === 'mcp'
        ? 'First call the configured probe MCP inspect_fixture tool exactly once with empty arguments. '
        : request.isolationProbe === 'builtin'
          ? 'First use the built-in shell to run ls /mnt/c/Windows exactly once, then continue despite the denied path. '
          : '';
      const modelPrompt = probePrompt + 'Return only a JSON object keyed by the two exact paths tests/run.mjs and src/publish.js. ' +
        'The test file must be a valid node:test file that fails before the implementation exists; ' +
        'preserve the existing declared test behavior. No markdown. Task: ' + request.prompt;
      this.startExperimentalWslCodexGeneration(nodeId, claimId, generation, allowedPaths,
        ['/usr/bin/python3', translated.stdout.trim(), '--source', stage!.source,
          '--manifest', stage!.manifest, '--claim', claimId, '--generation', generation,
          '--proposal-path', 'tests/run.mjs', '--proposal-path', 'src/publish.js',
          ...(request.isolationProbe ? ['--isolation-probe', request.isolationProbe] : []),
          '--review-prompt', 'Independently review the proposed files as a separate read-only reviewer. Return only this JSON object: {"verdict":"PASS"}.',
          '--prompt', modelPrompt]);
      let outcome: { exit_code: number; revoked: boolean } | undefined;
      for (let i = 0; i < 160 && !outcome; i++) {
        try { outcome = wslCodexProcessResult(this.paths.featureDir, claimId, generation); }
        catch { await new Promise(resolve => setTimeout(resolve, 750)); }
      }
      if (!outcome || outcome.exit_code !== 0 || outcome.revoked)
        throw new Error('WSL_CODEX_GENERATION_FAILED_OR_REVOKED');
      await request.onPhase?.('model-complete');
      // The callback observes a phase, not authority: each operation below
      // re-enters the live claim mutex after a possible cancel or resume.
      if (request.refusalFixture) {
        const fixture = request.refusalFixture;
        try {
          this.withLiveWslCodexClaim(nodeId, claimId, generation, allowedPaths, grant => {
            if (fixture === 'unsealed-transport')
              return readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
            if (fixture === 'broker-denied')
              return sealRegisteredWslCodexWorker(this.paths.featureDir, this.controlRoot,
                { ...grant, allowed_paths: ['tests/run.mjs'] });
            return sealRegisteredWslCodexWorker(this.paths.featureDir,
              join(dirname(this.controlRoot), 'missing-hook-workspace'), grant);
          });
        } catch (error) {
          if (!String(error).includes('WSL_CODEX_BROKER_DENIED')) throw error;
          throw new Error(fixture === 'hook-exit-nonzero' ? 'WSL_CODEX_HOOK_DENIED'
            : fixture === 'broker-denied' ? 'WSL_CODEX_BROKER_DENIED'
              : 'WSL_CODEX_UNSEALED_TRANSPORT_DENIED');
        }
        throw new Error('WSL_CODEX_REFUSAL_FIXTURE_UNEXPECTED_ALLOW');
      }
      const workerSeal = this.sealExperimentalWslCodexWorker(nodeId, claimId, generation, allowedPaths);
      const reviewerSeal = this.sealExperimentalWslCodexReviewer(nodeId, claimId, generation, allowedPaths);
      workerSealHash = workerSeal.submission_sha256;
      reviewerSealHash = reviewerSeal.submission_sha256;
      const turn = this.readExperimentalWslCodexSealedTurn(nodeId, claimId, generation, allowedPaths);
      if (turn.worker.events.filter(event => event === 'turn.completed').length !== 1)
        throw new Error('WSL_CODEX_MODEL_TRANSCRIPT_INVALID');
      if (request.isolationProbe) {
        const items = turn.worker.transcript.flatMap((entry: unknown) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const message = entry as Record<string, unknown>;
          return message['type'] === 'item.completed' && message['item'] &&
            typeof message['item'] === 'object' && !Array.isArray(message['item'])
            ? [message['item'] as Record<string, unknown>] : [];
        });
        const invoked = request.isolationProbe === 'mcp'
          ? items.some(item => item['type'] === 'mcp_tool_call' &&
              item['server'] === 'probe' && item['tool'] === 'inspect_fixture')
          : items.some(item => item['type'] === 'command_execution' &&
              typeof item['command'] === 'string' && item['command'].includes('/mnt/c/Windows') &&
              typeof item['exit_code'] === 'number' && item['exit_code'] !== 0);
        if (!invoked) throw new Error('WSL_CODEX_MODEL_TOOL_CALL_NOT_OBSERVED');
        // The broker re-reads root-owned worker AND reviewer receipts. Each
        // prelude ran in its role's bwrap namespace before untrusted model
        // code; a transcript, tool response or worker proposal is not proof.
        if (turn.isolation?.hostMountDenied !== true ||
            turn.isolation.directEgressDenied !== true ||
            turn.isolation.otherRoleSlotDenied !== true)
          throw new Error('WSL_CODEX_ISOLATION_EVIDENCE_UNAVAILABLE');
      }
      this.applyExperimentalWslCodexRedTest(nodeId, claimId, generation, allowedPaths, 'tests/run.mjs');
      this.withLiveWslCodexClaim(nodeId, claimId, generation, allowedPaths, () => {
        const journal = join(this.paths.featureDir, 'wsl-codex-transactions',
          createHash('sha256').update(`${nodeId}\0${claimId}\0${generation}`).digest('hex') + '.json');
        const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
        if (record['phase'] !== 'red-committed' || record['claimId'] !== claimId || record['dispatchId'] !== generation)
          throw new Error('WSL_CODEX_RED_JOURNAL_INVALID');
        writeTextAtomic(journal, JSON.stringify({ ...record, workerSealHash, reviewerSealHash }) + '\n');
      });
      if (request.interruptAfter === 'first-apply') throw new Error('WSL_CODEX_INTERRUPTED_AFTER_FIRST_APPLY');
      } else {
        const seals = this.withLiveWslCodexClaim(nodeId, claimId, generation, allowedPaths, grant => {
          const journal = join(this.paths.featureDir, 'wsl-codex-transactions',
            createHash('sha256').update(`${nodeId}\0${claimId}\0${generation}`).digest('hex') + '.json');
          const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
          if (record['phase'] !== 'red-committed' || record['base'] !== grant.base_sha ||
              typeof record['workerSealHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['workerSealHash']) ||
              typeof record['reviewerSealHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['reviewerSealHash']))
            throw new Error('WSL_CODEX_RECONCILE_AMBIGUOUS_PHASE');
          const turn = readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
          if (record['workerSealHash'] !== turn.seals.worker ||
              record['reviewerSealHash'] !== turn.seals.reviewer)
            throw new Error('WSL_CODEX_RECONCILE_RECEIPT_INVALID');
          return { worker: record['workerSealHash'], reviewer: record['reviewerSealHash'] };
        });
        workerSealHash = seals.worker;
        reviewerSealHash = seals.reviewer;
      }
      this.runExperimentalWslCodexRedGate(nodeId, claimId, generation, allowedPaths, capability);
      this.applyExperimentalWslCodexGreenImplementation(nodeId, claimId, generation, allowedPaths, 'src/publish.js');
      this.runExperimentalWslCodexGreenGates(nodeId, claimId, generation, allowedPaths, capability);
      const completed = this.verifyExperimentalWslCodexCompletedGates(nodeId, claimId, generation, allowedPaths, capability);
      const verified = this.withLiveWslCodexClaim(nodeId, claimId, generation, allowedPaths, grant => {
        const current = this.state().nodes[nodeId];
        const red = current?.evidence.red;
        const green = current?.evidence.green;
        const regression = current?.evidence.regression;
        const failed = (readGateTests(this.controlRoot, red) ?? []).filter(test => test.status === 'failed');
        const passed = (readGateTests(this.controlRoot, green) ?? []).filter(test => test.status === 'passed');
        const replayed = (readGateTests(this.controlRoot, regression) ?? []).filter(test => test.status === 'passed');
        if (!red || !green || !regression || failed.length === 0 ||
            failed.some(test => !passed.some(g => g.id === test.id) || !replayed.some(g => g.id === test.id)))
          throw new Error('WSL_CODEX_CRITERION_RESULTS_UNAVAILABLE');
        const criteria = this.node(nodeId).acceptance_criteria ?? [];
        if (criteria.length !== 1 || failed.length !== 1)
          throw new Error('WSL_CODEX_CRITERION_AMBIGUOUS');
        const sealed = readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
        const toolItems = sealed.worker.transcript.flatMap((event: unknown) => {
          if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
          const entry = event as Record<string, unknown>;
          return entry['type'] === 'item.completed' && entry['item'] &&
            typeof entry['item'] === 'object' && !Array.isArray(entry['item'])
            ? [entry['item'] as Record<string, unknown>] : [];
        });
        const mcpCalls = toolItems.filter(item => item['type'] === 'mcp_tool_call' &&
          item['server'] === 'probe' && item['tool'] === 'inspect_fixture').length;
        const builtinCalls = toolItems.filter(item => item['type'] === 'command_execution' &&
          typeof item['command'] === 'string' && item['command'].includes('/mnt/c/Windows') &&
          typeof item['exit_code'] === 'number' && item['exit_code'] !== 0).length;
        if (request.isolationProbe && (!sealed.isolation ||
            (request.isolationProbe === 'mcp' ? mcpCalls : builtinCalls) < 1))
          throw new Error('WSL_CODEX_ISOLATION_EVIDENCE_UNAVAILABLE');
        const usage = { input_tokens: 0, output_tokens: 0, model_turns: 0 };
        for (const transcript of [sealed.worker.transcript,
          (sealed.reviewer as { transcript?: unknown[] }).transcript]) {
          if (!Array.isArray(transcript)) throw new Error('WSL_CODEX_USAGE_UNAVAILABLE');
          const events = transcript.filter((entry): entry is Record<string, unknown> =>
            !!entry && typeof entry === 'object' && !Array.isArray(entry));
          const turns = events.filter(entry => entry['type'] === 'turn.completed');
          if (turns.length !== 1) throw new Error('WSL_CODEX_USAGE_UNAVAILABLE');
          const counts = turns[0]!['usage'] as Record<string, unknown> | undefined;
          if (!counts || !Number.isSafeInteger(counts['input_tokens']) || !Number.isSafeInteger(counts['output_tokens']) ||
              (counts['input_tokens'] as number) <= 0 || (counts['output_tokens'] as number) <= 0)
            throw new Error('WSL_CODEX_USAGE_UNAVAILABLE');
          usage.input_tokens += counts['input_tokens'] as number;
          usage.output_tokens += counts['output_tokens'] as number;
          usage.model_turns++;
        }
        if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens))
          throw new Error('WSL_CODEX_USAGE_UNAVAILABLE');
        const claim = current?.claim;
        if (!claim || claim.claim_id !== claimId || claim.dispatch_id !== generation ||
            claim.worktree !== grant.worktree || claim.base_sha !== grant.base_sha)
          throw new Error('WSL_CLAIM_STALE');
        const result = {
          schema_version: 1, node_id: nodeId, claim_id: claimId, dispatch_id: generation,
          outcome: 'SUBMITTED', commands: completed.gates.map(gate => ({ command: gate.argv, exit_code: gate.exitCode })),
          commit_sha: completed.commit, branch: runGit(grant.worktree, ['branch', '--show-current']).stdout.trim(),
          changed_paths: [...allowedPaths], evidence_paths: [], failure_fingerprint: null, decision_request: null,
          usage, tdd: { base_sha: grant.base_sha, head_sha: completed.commit,
            cycles: [{ red_commits: [completed.redCommit], green_commits: [completed.commit] }] },
          criterion_evidence: [{ criterion: criteria[0]!, test_id: failed[0]!.id,
            gate: 'red', output_sha256: red.output_sha256 }],
        };
        // The controller writes after validating both immutable gate reports,
        // not through a model-owned result or a worker-provided assertion.
        const slot = join(grant.worktree, WORKER_RESULT_DIR, claim.result_file ?? WORKER_RESULT_FILE);
        if (resultInSlot(grant.worktree, claim.result_file ?? WORKER_RESULT_FILE))
          throw new Error('WSL_CODEX_RESULT_SLOT_OCCUPIED');
        const journal = join(this.paths.featureDir, 'wsl-codex-transactions',
          createHash('sha256').update(`${nodeId}\0${claimId}\0${generation}`).digest('hex') + '.json');
        const prior = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
        if (prior['phase'] !== 'gates-complete' || prior['greenCommit'] !== completed.commit)
          throw new Error('WSL_CODEX_RESULT_JOURNAL_INVALID');
        const bytes = JSON.stringify(result) + '\n';
        const resultSha256 = createHash('sha256').update(bytes).digest('hex');
        const sourceSha256 = immutableGitSource(grant.worktree, grant.base_sha).hashes;
        const receipt = { claim: claimId, generation, workerSeal: workerSealHash,
          reviewerSeal: reviewerSealHash, sourceSha256,
          // A completed authenticated turn proves a lower bound, not the
          // bridge's exact HTTP request count. Never call this an API audit.
          model: { platform: 'linux' as const, apiRequests: usage.model_turns, mcpCalls, builtinCalls },
          ...(sealed.isolation ? { isolation: sealed.isolation } : {}),
          gates: completed.gates };
        const receiptSha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
        writeTextAtomic(journal, JSON.stringify({ ...prior, phase: 'result-intent', resultSha256, receipt, receiptSha256 }) + '\n');
        writeTextAtomic(slot, bytes);
        writeTextAtomic(journal, JSON.stringify({ ...prior, phase: 'result-written', resultSha256, receipt, receiptSha256 }) + '\n');
        // Root-owned write-once authentication must precede DONE, which clears the claim.
        wslCodexSettlementAnchor(this.paths.featureDir, claimId, generation, { receiptSha256, resultSha256 });
        return { receipt, resultSha256, journal };
      });
      if (request.interruptAfter === 'result-written') throw new Error('WSL_CODEX_INTERRUPTED_AFTER_RESULT_WRITTEN');
      const settled = this.settle(nodeId, capability);
      if (settled.outcome !== 'DONE' || this.state().nodes[nodeId]?.state !== 'DONE')
        throw new Error(`WSL_CODEX_SETTLEMENT_REFUSED:${settled.outcome}`);
      if (request.interruptAfter === 'post-settle') throw new Error('WSL_CODEX_INTERRUPTED_AFTER_SETTLEMENT');
      const prior = JSON.parse(readFileSync(verified.journal, 'utf8')) as Record<string, unknown>;
      if (prior['phase'] !== 'result-written' || prior['resultSha256'] !== verified.resultSha256)
        throw new Error('WSL_CODEX_RESULT_JOURNAL_INVALID');
      writeTextAtomic(verified.journal, JSON.stringify({ ...prior, phase: 'settled' }) + '\n');
      rmSync(escrowFile, { force: true });
      return { ...verified.receipt,
        settlement: { outcome: settled.outcome, idempotent: settled.idempotent,
          usageSessions: this.state().nodes[nodeId]?.usage.sessions ?? 0 } };
    } finally {
      stage?.dispose();
      // A recovered controller reopens only DPAPI ciphertext under a freshly
      // checked host claim; no in-memory capability is retained after a turn.
      this.experimentalWslCapabilities.delete(`${nodeId}\0${claimId}\0${generation}`);
    }
  }

  /** Resume only a controller-journaled result whose exact slot is still bound.
   * Earlier intent/gate phases are ambiguous without a durable capability
   * escrow and are deliberately NOT replayed by this recovery path. */
  async reconcileExperimentalWslCodexTransaction(nodeId: string, claimId: string, generation: string):
    Promise<{ claim: string; generation: string; workerSeal: string; reviewerSeal: string;
      sourceSha256: Record<string, string>;
      model: { platform: 'linux'; apiRequests: number; mcpCalls: number; builtinCalls: number };
      isolation?: { hostMountDenied: boolean; directEgressDenied: boolean; otherRoleSlotDenied: boolean };
      gates: { gate: 'red' | 'green' | 'regression'; exitCode: 0; argv: string[] }[];
      settlement: { outcome: string; idempotent: boolean; usageSessions: number } }> {
    if (process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1' ||
        process.env['MYCELINK_LIVE_WSL_CODEX_AUTH'] !== '1')
      throw new Error('WSL_CODEX_EXPERIMENT_NOT_ENABLED');
    const journal = join(this.paths.featureDir, 'wsl-codex-transactions',
      createHash('sha256').update(`${nodeId}\0${claimId}\0${generation}`).digest('hex') + '.json');
    if (!existsSync(journal) || lstatSync(journal).isSymbolicLink()) {
      const state = this.state();
      const claim = state.nodes[nodeId]?.claim;
      if (STOPPED_FEATURE_STATES.has(state.feature_state) || claim?.claim_id !== claimId ||
          claim?.dispatch_id !== generation || claim.provider_interrupted != null)
        throw new Error('WSL_CLAIM_STALE_OR_REVOKED');
      throw new Error('WSL_CODEX_RECONCILE_JOURNAL_MISSING');
    }
    const record = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
    if (record['nodeId'] !== nodeId || record['claimId'] !== claimId || record['dispatchId'] !== generation)
      throw new Error('WSL_CODEX_RECONCILE_JOURNAL_INVALID');
    if (record['phase'] === 'red-committed') {
      const allowedPaths = ['tests/run.mjs', 'src/publish.js'];
      const capability = this.withLiveWslCodexClaim(nodeId, claimId, generation, allowedPaths, () => {
        const escrow = journal.slice(0, -'.json'.length) + '.cap';
        if (!existsSync(escrow) || !lstatSync(escrow).isFile() || lstatSync(escrow).isSymbolicLink())
          throw new Error('WSL_CODEX_ESCROW_UNAVAILABLE');
        const raw = unprotectExperimentalWslCapability(readFileSync(escrow, 'utf8').trim(),
          `${this.featureId}\0${nodeId}\0${claimId}\0${generation}`);
        const claim = this.state().nodes[nodeId]?.claim;
        if (!claim?.capability_sha256 || !capabilityMatches(raw, claim.capability_sha256))
          throw new Error('WSL_CODEX_ESCROW_CAPABILITY_INVALID');
        return raw;
      });
      this.experimentalWslCapabilities.set(`${nodeId}\0${claimId}\0${generation}`, capability);
      return this.runExperimentalWslCodexTransaction({ nodeId, claimId, generation, allowedPaths,
        prompt: '' }, WSL_CODEX_INTERNAL_RECONCILE);
    }
    if (typeof record['resultSha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['resultSha256']))
      throw new Error('WSL_CODEX_RECONCILE_JOURNAL_INVALID');
    const receipt = record['receipt'] as Record<string, unknown> | undefined;
    // A hash stored next to its own receipt is not an authentication code:
    // a journal editor can update both. Re-derive the capability-redacted
    // command lines from the trusted graph/controller, never from the receipt.
    const declaredGates = this.gateCommands(nodeId, 'redacted-reconcile-only')
      .filter(gate => gate.gate === 'red' || gate.gate === 'green' || gate.gate === 'regression')
      .map(gate => ({ gate: gate.gate, exitCode: 0, argv: gate.argv.slice(0, -2) }));
    if (!receipt || receipt['claim'] !== claimId || receipt['generation'] !== generation ||
        typeof receipt['workerSeal'] !== 'string' || typeof receipt['reviewerSeal'] !== 'string' ||
        !Array.isArray(receipt['gates']) ||
        JSON.stringify(receipt['gates']) !== JSON.stringify(declaredGates) ||
        record['receiptSha256'] !== createHash('sha256').update(JSON.stringify(receipt)).digest('hex'))
      throw new Error('WSL_CODEX_RECONCILE_RECEIPT_INVALID');
    const anchor = wslCodexSettlementAnchor(this.paths.featureDir, claimId, generation);
    if (anchor.receiptSha256 !== record['receiptSha256'] || anchor.resultSha256 !== record['resultSha256'])
      throw new Error('WSL_CODEX_RECONCILE_RECEIPT_INVALID');
    const runtime = this.state().nodes[nodeId];
    const done = runtime?.state === 'DONE';
    if (done) {
      const settled = runtime.last_settlement;
      if (runtime.claim !== null || runtime.usage.sessions !== 1 ||
          settled?.outcome !== 'DONE' || settled.claim_id !== claimId || settled.dispatch_id !== generation ||
          typeof settled.result_file !== 'string' || typeof settled.result_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(settled.result_sha256) ||
          sha256OfFile(join(this.sessionDir(nodeId), settled.result_file)) !== settled.result_sha256)
        throw new Error('WSL_CODEX_RECONCILE_SETTLEMENT_DRIFT');
    }
    if (record['phase'] === 'result-written' && !done) {
      const liveClaim = this.state().nodes[nodeId]?.claim;
      if (!liveClaim || liveClaim.claim_id !== claimId || liveClaim.dispatch_id !== generation ||
          !liveClaim.worktree || typeof record['base'] !== 'string' ||
          JSON.stringify(receipt?.['sourceSha256']) !==
            JSON.stringify(immutableGitSource(liveClaim.worktree, record['base']).hashes))
        throw new Error('WSL_CODEX_RECONCILE_RECEIPT_INVALID');
      this.withLiveWslCodexClaim(nodeId, claimId, generation, ['tests/run.mjs', 'src/publish.js'], grant => {
        const turn = readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
        if (receipt['workerSeal'] !== turn.seals.worker || receipt['reviewerSeal'] !== turn.seals.reviewer ||
            record['workerSealHash'] !== turn.seals.worker || record['reviewerSealHash'] !== turn.seals.reviewer)
          throw new Error('WSL_CODEX_RECONCILE_RECEIPT_INVALID');
      });
    }
    if (record['phase'] === 'settled' || (record['phase'] === 'result-written' && done)) {
      if (!done)
        throw new Error('WSL_CODEX_RECONCILE_SETTLEMENT_DRIFT');
      if (record['phase'] === 'result-written')
        writeTextAtomic(journal, JSON.stringify({ ...record, phase: 'settled' }) + '\n');
      rmSync(journal.slice(0, -'.json'.length) + '.cap', { force: true });
      return { ...(receipt as any), settlement: { outcome: 'DONE', idempotent: true, usageSessions: 1 } };
    }
    if (record['phase'] !== 'result-written') throw new Error('WSL_CODEX_RECONCILE_AMBIGUOUS_PHASE');
    this.withLiveWslCodexClaim(nodeId, claimId, generation, ['tests/run.mjs', 'src/publish.js'], grant => {
      this.assertExperimentalWslStopped(nodeId);
      const claim = this.state().nodes[nodeId]?.claim;
      if (!claim || claim.claim_id !== claimId || claim.dispatch_id !== generation || claim.worktree !== grant.worktree)
        throw new Error('WSL_CLAIM_STALE');
      if (!claim.result_captured_sha256) {
        const slot = join(grant.worktree, WORKER_RESULT_DIR, claim.result_file ?? WORKER_RESULT_FILE);
        if (!lstatSync(slot).isFile() || lstatSync(slot).isSymbolicLink() ||
            createHash('sha256').update(readFileSync(slot)).digest('hex') !== record['resultSha256'])
          throw new Error('WSL_CODEX_RECONCILE_RESULT_DRIFT');
        let result: Record<string, unknown>;
        try { result = JSON.parse(readFileSync(slot, 'utf8')) as Record<string, unknown>; }
        catch { throw new Error('WSL_CODEX_RECONCILE_RESULT_DRIFT'); }
        const turn = readRegisteredWslCodexTurn(this.paths.featureDir, this.controlRoot, grant);
        const usage = { input_tokens: 0, output_tokens: 0, model_turns: 0 };
        for (const transcript of [turn.worker.transcript, (turn.reviewer as { transcript?: unknown[] }).transcript]) {
          if (!Array.isArray(transcript)) throw new Error('WSL_CODEX_RECONCILE_RESULT_DRIFT');
          const completed = transcript.filter((event): event is Record<string, unknown> =>
            !!event && typeof event === 'object' && !Array.isArray(event) &&
            (event as Record<string, unknown>)['type'] === 'turn.completed');
          if (completed.length !== 1) throw new Error('WSL_CODEX_RECONCILE_RESULT_DRIFT');
          const counts = completed[0]!['usage'] as Record<string, unknown> | undefined;
          if (!counts || !Number.isSafeInteger(counts['input_tokens']) || !Number.isSafeInteger(counts['output_tokens']) ||
              (counts['input_tokens'] as number) <= 0 || (counts['output_tokens'] as number) <= 0)
            throw new Error('WSL_CODEX_RECONCILE_RESULT_DRIFT');
          usage.input_tokens += counts['input_tokens'] as number;
          usage.output_tokens += counts['output_tokens'] as number;
          usage.model_turns++;
        }
        if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens) ||
            JSON.stringify(result['usage']) !== JSON.stringify(usage) ||
            result['commit_sha'] !== record['greenCommit'] ||
            result['node_id'] !== nodeId || result['claim_id'] !== claimId ||
            result['dispatch_id'] !== generation || result['outcome'] !== 'SUBMITTED')
          throw new Error('WSL_CODEX_RECONCILE_RESULT_DRIFT');
        const captured = this.attestSlot(nodeId, claim);
        // Capture redacts and re-serializes the result; its controller-copy
        // hash deliberately differs from the original slot's journal hash.
        // The exact original bytes were checked before the atomic capture.
        if (!captured) throw new Error('WSL_CODEX_RECONCILE_RESULT_DRIFT');
        mutateState(this.paths.featureDir, state => this.recordCapture(state, nodeId, captured, claimId));
      } else if (!claim.result_captured_file ||
          sha256OfFile(join(this.sessionDir(nodeId), claim.result_captured_file)) !== claim.result_captured_sha256) {
        throw new Error('WSL_CODEX_RECONCILE_RESULT_DRIFT');
      }
    });
    const settled = this.completeSettlement(nodeId, 'resume');
    if (settled.outcome !== 'DONE' || this.state().nodes[nodeId]?.state !== 'DONE')
      throw new Error(`WSL_CODEX_RECONCILE_SETTLEMENT_REFUSED:${settled.outcome}`);
    writeTextAtomic(journal, JSON.stringify({ ...record, phase: 'settled' }) + '\n');
    rmSync(journal.slice(0, -'.json'.length) + '.cap', { force: true });
    return { ...(receipt as any), settlement: { outcome: 'DONE', idempotent: false,
      usageSessions: this.state().nodes[nodeId]?.usage.sessions ?? 0 } };
  }

  graph(): PortfolioGraph {
    return loadGraph(this.controlRoot, this.featureId);
  }

  state(): FeatureState_ {
    const doc = loadState(this.paths.featureDir);
    if (doc === null) throw new Error(`Feature "${this.featureId}" has no STATE.json.`);
    return doc.data;
  }

  /** Throw GraphDriftError unless the graph still hashes to the one STATE.json was initialised for. */
  assertGraphUnchanged(): void {
    const recorded = this.state().graph_hash;
    const current = hashGraph(this.graph());
    if (current !== recorded) throw new GraphDriftError(this.featureId, recorded, current);
  }

  node(id: string): GraphNode {
    const node = this.graph().nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Node "${id}" is not in the graph.`);
    return node;
  }

  ready(): string[] {
    return computeReady(this.graph(), this.state());
  }

  plan(): SchedulePlan {
    const state = this.state();
    const plan = scheduleBatch(this.graph(), state, {
      writerConcurrency: state.budget.max_writer_concurrency,
    });
    // No candidate (and nothing run on one) before an acceptance review PASS bound to what it would bind.
    const gated = plan.scheduled.filter((s) => REVIEW_GATED_TYPES.has(this.node(s.node_id).node_type));
    if (gated.length === 0 || this.reviewPassed(state)) return plan;
    return {
      scheduled: plan.scheduled.filter((s) => !gated.includes(s)),
      deferred: [...plan.deferred, ...gated.map((s) => ({ node_id: s.node_id, reason: 'ACCEPTANCE_REVIEW_PENDING' as const, detail: 'no acceptance review PASS binds the repository heads, graph and criteria a candidate would bind' }))],
    };
  }

  private event(type: string, nodeId: string | null, data: Record<string, unknown>): void {
    appendEvent(this.paths.events, {
      idempotency_key: `${type}:${nodeId ?? '-'}:${randomUUID()}`,
      type,
      actor: this.owner,
      feature_id: this.featureId,
      ...(nodeId ? { node_id: nodeId } : {}),
      data,
    });
  }

  private transition(nodeId: string, to: NodeState, options: Record<string, unknown> = {}): void {
    const graph = this.graph();
    mutateState(this.paths.featureDir, (s) => {
      const next = applyNodeTransition(graph, s, nodeId, to, {
        actor: this.owner,
        ...(options as { reason?: string; decisionId?: string; integratedSha?: string }),
      });
      // An invalidated node's generation changed with what a review or a candidate binds: the epoch moves, and its lineage.
      if (to === 'INVALIDATED' && s.nodes[nodeId]?.state !== 'INVALIDATED') bumpEpoch(next, `invalidate ${nodeId}`, [nodeId]);
      return next;
    });
    this.event('node.transition', nodeId, { to, ...options });
  }

  private setEvidence(nodeId: string, record: EvidenceRecord): void {
    mutateState(this.paths.featureDir, (s) => {
      const runtime = s.nodes[nodeId];
      if (runtime) runtime.evidence[record.kind] = record;
      return s;
    });
    this.event('evidence.recorded', nodeId, {
      kind: record.kind,
      exit_code: record.exit_code,
      output_path: record.output_path,
      fingerprint: record.failure_fingerprint,
    });
  }

  private contractHashes(node: GraphNode): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rel of [...(node.contract_inputs ?? []), ...(node.contract_outputs ?? [])]) {
      const full = join(this.controlRoot, rel);
      out[rel] = existsSync(full)
        ? createHash('sha256').update(readFileSync(full)).digest('hex')
        : '';
    }
    return out;
  }

  // ---- claim lifecycle --------------------------------------------------

  /**
   * Claim a node atomically: re-check it against the scheduler under the
   * state lock, move it to CLAIMED and record the claim with the hash of a
   * fresh capability, all in one STATE.json write. Then reserve its
   * resources and create its worktree. If that setup fails, the claim is
   * released again without consuming the node's attempt budget.
   *
   * The raw capability is returned once and never stored.
   */
  claim(nodeId: string, options: { mode?: ClaimMode; claimId?: string } = {}): ClaimResult {
    this.assertGraphUnchanged();
    const graph = this.graph();
    const node = this.node(nodeId);
    const mode = options.mode ?? 'adapter';
    // A verification node writes nothing and has no worker: only the controller's own run claims it, with no worktree.
    const verifying = node.node_type === 'verification';
    if (verifying && mode !== 'controller') throw new NotWorkerNodeError(nodeId, node.node_type);
    const capability = newCapability();
    // A concluded claim whose captured answer is settled again (an identity reconciliation, PCM-101 final) keeps its id: the
    // answer names it.
    const claimId = options.claimId ?? randomUUID();
    const dispatchId = mode === 'host' ? randomUUID() : undefined;
    const resultFile = dispatchId !== undefined ? generationResultFile(dispatchId) : undefined;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.claimTtlMs(node)).toISOString();
    let attempt = 0;
    // The test-path policy the gates and settle judge this claim by, fixed now:
    // a repositories.yaml changed while the worker runs does not move it.
    const tddPolicy = node.repository !== null && !verifying ? this.claimTddPolicy(node.repository) : null;
    // The module command its gates and fresh verification run, fixed now too; a module changed
    // since the graph was planned refuses the claim before anything is taken (MODULE_DRIFT).
    const repoDecl = node.repository !== null ? this.workspace.repositories.repositories.find((r) => r.name === node.repository) : undefined;
    const verification = repoDecl !== undefined && !verifying ? claimVerificationFor(nodeId, node.verification_commands[0], repoDecl) : null;
    // The approved criteria the claim serves (engine/acceptance.ts), bound by hash; a changed manifest refuses it (ACCEPTANCE_DRIFT).
    const acceptance = this.claimAcceptance(nodeId);
    const host = mode === 'host' ? this.hostBinding() : null;

    mutateState(this.paths.featureDir, (s) => {
      if (STOPPED_FEATURE_STATES.has(s.feature_state)) {
        throw new NotSchedulableError(nodeId, 'FEATURE_STOPPED', `feature is ${s.feature_state}`);
      }
      if (typeof s.superseded_by === 'string') {
        throw new NotSchedulableError(nodeId, 'FEATURE_STOPPED', `feature is superseded by ${s.superseded_by}`);
      }
      // The review barrier, both ways (CSET-203 r7): nothing it judges is worked on while a review is out with its reviewer.
      const open = s.acceptance_review?.open ?? null;
      if (open !== null && !REVIEW_GATED_TYPES.has(node.node_type)) {
        throw new NotSchedulableError(nodeId, 'REVIEW_OPEN', `acceptance review ${open.review_id} (dispatch ${open.dispatch_id}) is out with its reviewer and binds what every product and verification node made; nothing it judges is claimed until it settles (dispatch settles a verdict in its slot, or drops a review whose inputs moved)`);
      }
      const check = canSchedule(graph, s, nodeId, { writerConcurrency: s.budget.max_writer_concurrency });
      if (!check.ok) throw new NotSchedulableError(nodeId, check.reason, check.detail);
      // A rework brief that no longer matches its rework is never handed out; nor an order bound to an older revision of
      // its review (dispatch reconciles it first), or whose gaps are not its bound revision's (CSET-203 r14).
      verifiedReworkBrief(s, nodeId);
      this.assertOrderCurrent(s, nodeId);
      let next = s;
      if (next.nodes[nodeId]?.state !== 'READY') {
        next = applyNodeTransition(graph, next, nodeId, 'READY', { actor: this.owner });
      }
      next = applyNodeTransition(graph, next, nodeId, 'CLAIMED', { actor: this.owner });
      const rt = next.nodes[nodeId] as NodeRuntime;
      attempt = rt.attempts;
      // The epoch, the node's lineage and rework generation the claim is issued at, and its lease, in this one write.
      const generation = rt.rework_brief?.generation ?? (rt.rework_history ?? []).filter(stoodRework).length;
      const kind = leaseKindFor(node.node_type, mode);
      rt.claim = {
        claim_id: claimId,
        owner: this.owner,
        worktree: null,
        branch: null,
        claimed_at: now.toISOString(),
        capability_sha256: capability.sha256,
        mode,
        attempt,
        expires_at: expiresAt,
        // A controller run (a candidate build, a verification node) is marked as this process's from the start:
        // one whose controller died is seen through by its identity and handed back (recoverControllerRuns).
        settling: mode === 'controller' ? settlerMarker() : null,
        ...(dispatchId !== undefined ? { dispatch_id: dispatchId, result_file: resultFile as string } : {}),
        ...(tddPolicy !== null ? { tdd_policy: tddPolicy } : {}),
        ...(verification !== null ? { verification } : {}),
        acceptance,
        epoch: currentEpoch(next),
        lineage: lineageOf(next, nodeId),
        generation,
        lease_kind: kind,
        // The host session this dispatch is handed to, as the plugin's fence saw it run dispatch: its provider failure is read from it.
        ...(mode === 'host' && host !== null ? { host_session: host } : {}),
      };
      issueLease(next, { kind, node_id: nodeId, review_id: null, claim_id: claimId, dispatch_id: dispatchId ?? null, capability_sha256: capability.sha256, generation, worktree: null, result_file: resultFile ?? null, host: mode === 'host' ? host : null }, now.toISOString());
      return next;
    });
    this.fault('lease-issued');

    let worktree: string | null = null;
    let branch: string | null = null;
    try {
      for (const resource of node.required_resources) {
        acquireResource(this.paths.featureDir, resource, {
          nodeId,
          owner: this.owner,
          capacities: graph.resources,
          idempotencyKey: `${nodeId}:${resource}:${claimId}`,
          // A host or manual claim outlives this process; its lease ends with
          // the claim. An adapter or controller claim lives in this process.
          ...(mode === 'host' || mode === 'manual' ? { claimId, ttlMs: this.claimTtlMs(node) } : {}),
        });
      }

      if (node.repository !== null && !verifying) {
        const created = this.ensureWorktree(nodeId, claimId);
        worktree = created.worktree;
        branch = created.branch;
        // Before any worker or gate runs there: what the checkout does not carry.
        this.prepareWorktree(nodeId, claimId, created.worktree);
      }
    } catch (err) {
      if (err instanceof WorktreeSetupError) {
        // A controller precondition, not the node's failure: nothing is charged or counted.
        this.releaseForPrecondition(nodeId, claimId, err.message);
        throw err;
      }
      this.releaseForInfrastructure(nodeId, claimId, `claim setup failed: ${errorText(err)}`);
      if (err instanceof ResourceBusyError) throw err;
      throw new ClaimSetupError(nodeId, err);
    }
    // What the generation carries is revalidated on its base before any worker runs (CSET-203 r16).
    if (worktree !== null) this.revalidateCompletions(nodeId, claimId);

    this.event('node.claimed', nodeId, { claim_id: claimId, mode, attempt, worktree, branch });
    if (mode === 'host' && dispatchId && process.platform === 'win32' &&
        process.env['MYCELINK_LIVE_WSL_WORKER'] === '1' && process.env['MYCELINK_LIVE_WSL_CODEX_AUTH'] === '1') {
      this.experimentalWslCapabilities.set(`${nodeId}\0${claimId}\0${dispatchId}`, capability.raw);
    }
    return {
      claimId,
      capability: capability.raw,
      worktree,
      branch,
      attempt,
      mode,
      expiresAt,
      ...(dispatchId !== undefined ? { dispatchId, resultFile: resultFile as string } : {}),
    };
  }

  /**
   * Create (or re-attach) the node's worktree for the claim `claimId` and pin
   * the commit its branch started from in the claim and the node runtime.
   *
   * A new branch starts at the repository's integration head when anything
   * has been integrated (so a dependent sees the work its upstream nodes
   * landed, without merging it itself), otherwise at the base branch. A
   * branch that already exists keeps its commits and the base recorded when
   * it was created.
   */
  private ensureWorktree(nodeId: string, claimId: string): { worktree: string; branch: string; baseSha: string | null } {
    const node = this.node(nodeId);
    if (node.repository === null) throw new Error(`${nodeId} has no repository.`);
    const repoPath = repositoryPath(this.workspace, node.repository);
    const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === node.repository);
    // A rework replaces the branch: its old commits are kept under an
    // archive ref and the node starts again from the integration head.
    if (this.state().nodes[nodeId]?.fresh_branch_required === true) this.archiveWorkerBranch(nodeId);
    // Only the integration head the controller itself recorded is a start
    // point; a branch moved any other way refuses the claim.
    const trusted = trustedIntegrationHead(this.workspace, this.featureId, node.repository, { graph: this.graph(), state: this.state() });
    const startPoint = trusted ?? resolveRef(repoPath, `refs/heads/${repoDecl?.base_branch ?? 'main'}`);
    const created = createWorkerWorktree({
      repoPath,
      featureId: this.featureId,
      nodeId,
      baseBranch: repoDecl?.base_branch ?? 'main',
      worktreeRoot: this.workspace.paths.worktreesDir,
      repositoryName: node.repository,
      startPoint,
    });
    // An existing branch with no recorded base (made by `branch create`, or
    // before bases were recorded) is fenced from where it meets the start point.
    const adopted =
      created.startSha === null && !this.state().nodes[nodeId]?.branch_base_sha
        ? runGit(repoPath, ['merge-base', created.branch, startPoint], { allowFail: true }).stdout.trim() || null
        : null;
    let baseSha: string | null = created.startSha ?? adopted;
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (!rt) return s;
      if (created.startSha !== null) {
        rt.branch_base_sha = created.startSha;
        delete rt.fresh_branch_required;
        // A new branch has no RED of its own yet; the old branch's bindings went with it.
        rt.tdd_red_bindings = [];
      } else if (adopted !== null && !rt.branch_base_sha) {
        rt.branch_base_sha = adopted;
      }
      baseSha = rt.branch_base_sha ?? null;
      const claim = rt.claim;
      if (claim?.claim_id === claimId) {
        claim.worktree = created.worktree;
        claim.branch = created.branch;
        if (baseSha !== null) claim.base_sha = baseSha;
        // The lease knows where its worker writes: a late answer of it is found there.
        for (const l of activeLeases(s)) if (l.claim_id === claimId && l.dispatch_id === (claim.dispatch_id ?? null)) l.worktree = created.worktree;
      }
      return s;
    });
    return { worktree: created.worktree, branch: created.branch, baseSha };
  }

  /**
   * Materialise the node's worktree before anything runs in it (see
   * engine/worktree-setup.ts) and bind the setup to the claim `claimId`. The
   * last receipt is reused only while it binds this very worktree, its
   * current commit and the repository's configured setup with every required
   * path present; otherwise the setup runs again. A setup that did not
   * complete throws WorktreeSetupError, its log and receipt kept as evidence;
   * one that changed the worktree removes it, so the next claim checks it out
   * afresh (the branch, and every commit on it, is kept). Nothing is ever
   * taken from a README: a repository without worktree_setup runs nothing.
   */
  private prepareWorktree(nodeId: string, claimId: string, worktree: string): void {
    const node = this.node(nodeId);
    const repository = node.repository as string;
    const config = worktreeSetupOf(this.workspace.repositories.repositories.find((r) => r.name === repository));
    if (config === null) {
      mutateState(this.paths.featureDir, (s) => {
        const claim = s.nodes[nodeId]?.claim;
        if (claim?.claim_id === claimId) delete claim.worktree_setup;
        return s;
      });
      return;
    }
    const configSha = worktreeSetupSha256(config);
    const head = resolveRef(worktree, 'HEAD');
    const record = this.state().nodes[nodeId]?.worktree_setup ?? null;
    const reuse = reusableSetup({ controlRoot: this.controlRoot, record, worktree, headSha: head, config });
    let binding: ClaimWorktreeSetup;
    if (reuse.ok && record !== null) {
      const inputs = setupInputs(worktree, config);
      binding = { status: 'reused', config, config_sha256: configSha, receipt_path: record.receipt_path, receipt_sha256: record.receipt_sha256, head_sha: head, ...(inputs !== null ? { inputs_sha256: inputs.sha256 } : {}) };
      this.event('worktree.setup_reused', nodeId, { claim_id: claimId, receipt_path: record.receipt_path, receipt_sha256: record.receipt_sha256 });
    } else {
      const repoPath = repositoryPath(this.workspace, repository);
      const bound = this.state().nodes[nodeId]?.claim?.verification;
      const run = runWorktreeSetup({
        controlRoot: this.controlRoot,
        repository,
        repoPath,
        worktree,
        root: this.workspace.paths.worktreesDir,
        config,
        evidenceDir: nodeEvidenceDir(this.controlRoot, this.featureId, nodeId),
        label: `${safeNodeDir(nodeId)}.worktree-setup`,
        // The receipt names the module verification the worktree was prepared for.
        ...(bound !== undefined ? { verification: { module: bound.module, module_sha256: bound.module_sha256 } } : {}),
      });
      mutateState(this.paths.featureDir, (s) => {
        const rt = s.nodes[nodeId];
        if (rt) rt.worktree_setup = run.record;
        return s;
      });
      this.event('worktree.setup', nodeId, {
        claim_id: claimId,
        purpose: 'worker',
        status: run.receipt.status,
        code: run.receipt.code,
        rerun_because: reuse.ok ? null : reuse.reason.slice(0, 300),
        receipt_path: run.receipt_path,
        receipt_sha256: run.receipt_sha256,
        output_path: run.receipt.output_path,
      });
      if (run.receipt.status !== 'complete') {
        if (setupMutatedWorktree(run.receipt.code)) removeWorkerWorktree(repoPath, worktree);
        throw new WorktreeSetupError(nodeId, run.receipt, run.receipt_path);
      }
      binding = { status: 'complete', config, config_sha256: configSha, receipt_path: run.receipt_path, receipt_sha256: run.receipt_sha256, head_sha: head, ...(run.receipt.inputs_sha256 !== undefined ? { inputs_sha256: run.receipt.inputs_sha256 } : {}) };
    }
    mutateState(this.paths.featureDir, (s) => {
      const claim = s.nodes[nodeId]?.claim;
      if (claim?.claim_id === claimId) claim.worktree_setup = binding;
      return s;
    });
  }

  /**
   * The setup a fresh checkout of the node is prepared with: the one its
   * claim is bound to (a repositories.yaml changed while the worker ran does
   * not move it), else the repository's configured one.
   */
  private checkoutSetup(nodeId: string, repository: string): WorktreeSetupConfig | null {
    const bound = this.state().nodes[nodeId]?.claim?.worktree_setup;
    if (bound !== undefined && worktreeSetupSha256(bound.config) === bound.config_sha256) return bound.config;
    return worktreeSetupOf(this.workspace.repositories.repositories.find((r) => r.name === repository));
  }

  /**
   * The commit a node's fence is measured from: its pinned base, advanced
   * to the newest integration commit this controller itself recorded (a
   * node's integrated_sha in this repository) that the node's branch
   * contains. A worker that merged the integration branch after it moved
   * therefore owns only its own changes; a commit placed on the integration
   * branch any other way stays in the node's diff. Returns null when the
   * pinned base is not in the branch's history at all.
   */
  private fenceBase(repository: string, repoPath: string, pinned: string, head: string): string | null {
    if (!isAncestor(repoPath, pinned, head)) return null;
    const graph = this.graph();
    let base = pinned;
    for (const [id, rt] of Object.entries(this.state().nodes)) {
      const sha = rt.integrated_sha;
      if (!sha || graph.nodes.find((n) => n.id === id)?.repository !== repository) continue;
      if (sha === base) continue;
      if (isAncestor(repoPath, base, sha) && isAncestor(repoPath, sha, head)) base = sha;
    }
    return base;
  }

  /**
   * The node's own delta at `sha`, as fresh verification fences it: the
   * base it is measured from (its pinned base advanced over what the
   * controller integrated, or the base branch for a branch with no pinned
   * base), and an OWNERSHIP_VIOLATION when a committed change lies outside
   * its allowed paths or inside its forbidden ones.
   */
  private fenceOf(nodeId: string, sha: string): { base: string | null; detail: string | null } {
    const node = this.node(nodeId);
    const repository = node.repository as string;
    const repoPath = repositoryPath(this.workspace, repository);
    const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === repository);
    const runtime = this.state().nodes[nodeId];
    const pinned = runtime?.claim?.base_sha ?? runtime?.branch_base_sha ?? null;
    const base = pinned === null ? resolveRef(repoPath, repoDecl?.base_branch ?? 'main') : this.fenceBase(repository, repoPath, pinned, sha);
    if (base === null) {
      return {
        base: null,
        detail: `OWNERSHIP_VIOLATION: BASE_NOT_ANCESTOR: ${workerBranchName(this.featureId, nodeId)} at ${sha.slice(0, 12)} no longer contains the commit ${String(pinned).slice(0, 12)} its worktree was created from`,
      };
    }
    const changed = runGit(repoPath, ['diff', '--name-only', '-z', '--no-renames', base, sha]).stdout.split('\0').filter((p) => p !== '');
    const violations = changed.filter(
      (path) => !node.allowed_paths.some((g) => matchGlob(g, path)) || (node.forbidden_paths ?? []).some((g) => matchGlob(g, path)),
    );
    return { base, detail: violations.length > 0 ? `OWNERSHIP_VIOLATION: ${violations.slice(0, 10).join(', ')}` : null };
  }

  /**
   * What a claim binds of the approved criteria (engine/acceptance.ts): the
   * manifest the feature was initialised with, which must still hash to what
   * STATE.json recorded, and the node's own criteria (id, kind, exact text).
   * Throws AcceptanceDriftError when the manifest changed or went.
   */
  claimAcceptance(nodeId: string): { manifest_sha256: string | null; criteria_sha256: string } {
    const graph = this.graph();
    const node = this.node(nodeId);
    const bound = this.state().acceptance ?? null;
    if (bound) {
      const file = join(this.controlRoot, bound.path);
      const now = existsSync(file) ? sha256OfFile(file) : null;
      if (now !== bound.sha256) {
        throw new AcceptanceDriftError(nodeId, `${bound.path} ${now === null ? 'is gone' : `now hashes to ${now.slice(0, 12)}`}, not ${bound.sha256.slice(0, 12)}, the approved criteria the feature was initialised with`);
      }
    }
    const mine = graph.acceptance_criteria.filter((a) => (node.acceptance_criteria ?? []).includes(a.id));
    return { manifest_sha256: bound?.sha256 ?? null, criteria_sha256: criteriaSha256(mine) };
  }

  /** The repository's test-path policy, with its hash, as a claim binds it. */
  private claimTddPolicy(repository: string): ClaimTddPolicy {
    const policy = tddPolicyFor(this.workspace.repositories.repositories.find((r) => r.name === repository));
    return { ...policy, sha256: tddPolicySha256(policy) };
  }

  /** How long a claim may stay unsettled before a host dispatch counts as abandoned. */
  claimTtlMs(node: GraphNode): number {
    return node.worker.max_wall_clock_minutes * 60_000 + CLAIM_GRACE_MS;
  }

  /**
   * End a claim for an infrastructure reason: the node returns to READY with
   * its attempt refunded and an interruption counted, no failure fingerprint
   * is recorded, and its leases are released. The worktree and branch are
   * kept, so committed work survives. Idempotent: only the named claim is
   * released, and only once.
   */
  releaseForInfrastructure(nodeId: string, claimId: string, reason: string): boolean {
    const graph = this.graph();
    let released = false;
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (!rt?.claim || rt.claim.claim_id !== claimId) return s;
      released = true;
      // Its holder is gone or never started: the lease is abandoned, and a late answer of it is stale.
      closeLeases(s, (l) => l.node_id === nodeId && l.claim_id === claimId, 'abandoned', reason);
      if (rt.state === 'INTEGRATED') {
        // Already merged: it cannot simply be retried, so a person decides.
        return applyNodeTransition(graph, s, nodeId, 'BLOCKED', { actor: this.owner, reason: `${reason} after integration` });
      }
      return applyNodeTransition(graph, s, nodeId, 'READY', { actor: this.owner, reason, refundAttempt: true });
    });
    releaseAllForNode(this.paths.featureDir, nodeId);
    if (released) this.event('node.interrupted', nodeId, { claim_id: claimId, reason: reason.slice(0, 500) });
    return released;
  }

  /**
   * End a claim because a controller precondition does not hold (its
   * worktree could not be set up): the node returns to READY with its
   * attempt refunded, and nothing is recorded against it — no failure, no
   * interruption, no usage — because no worker ran on it. Its leases are
   * released; its branch is kept. Idempotent, like the release above.
   */
  releaseForPrecondition(nodeId: string, claimId: string, reason: string): boolean {
    const graph = this.graph();
    let released = false;
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (!rt?.claim || rt.claim.claim_id !== claimId) return s;
      released = true;
      if (rt.state === 'INTEGRATED') {
        return applyNodeTransition(graph, s, nodeId, 'BLOCKED', { actor: this.owner, reason: `${reason.slice(0, 500)} after integration` });
      }
      return applyNodeTransition(graph, s, nodeId, 'READY', { actor: this.owner, reason: reason.slice(0, 500), refundAttempt: true, precondition: true });
    });
    releaseAllForNode(this.paths.featureDir, nodeId);
    if (released) this.event('node.precondition_failed', nodeId, { claim_id: claimId, reason: reason.slice(0, 500) });
    return released;
  }

  /**
   * The `mycelink tdd` calls a worker must make, as exact argv.
   *
   * No `-- <command>` passthrough: each gate runs the node's declared
   * verifier, so pre-approving the line grants nothing the graph did not
   * already declare. Paths use forward slashes so the line reads the same in
   * every shell a worker might use.
   */
  gateCommands(nodeId: string, capability: string): NonNullable<SpawnRequest['gateCommands']> {
    const node = this.node(nodeId);
    if (node.verification_commands.length === 0) return [];
    const launcher = mycelinkCliPath().replace(/\\/g, '/');
    const controlRoot = this.controlRoot.replace(/\\/g, '/');
    return (['red', 'green', 'regression'] as const)
      .filter((gate) => node.required_evidence.includes(gate))
      .map((gate) => ({
        gate,
        argv: [
          'node',
          launcher,
          'tdd',
          gate,
          this.featureId,
          nodeId,
          '--control-root',
          controlRoot,
          '--capability',
          capability,
        ],
      }));
  }

  /** Write the node's context pack and return its path. */
  writeContextPack(nodeId: string, claimId: string): string {
    const graph = this.graph();
    const state = this.state();
    const node = this.node(nodeId);
    const runtime = state.nodes[nodeId];
    const pack = buildContextPack({
      graph,
      state,
      nodeId,
      claimId,
      worktree: runtime?.claim?.worktree ?? null,
      branch: runtime?.claim?.branch ?? null,
      contractHashes: this.contractHashes(node),
      maxBytes: this.workspace.config.context_pack_max_bytes,
      ...(this.recall ? { memory: this.recall(node) } : {}),
      capsules: this.capsuleViews(nodeId),
    });
    mkdirSync(this.paths.contextPacksDir, { recursive: true });
    const file = join(this.paths.contextPacksDir, `${nodeId}.json`);
    writeTextAtomic(file, JSON.stringify(pack, null, 2) + '\n');
    return file;
  }

  /** Release a node's claim, leases and worktree. */
  releaseClaim(nodeId: string, options: { removeWorktree?: boolean } = {}): void {
    const released = releaseAllForNode(this.paths.featureDir, nodeId);
    if (options.removeWorktree) {
      const node = this.node(nodeId);
      const runtime = this.state().nodes[nodeId];
      const worktree = runtime?.claim?.worktree;
      if (worktree && node.repository) {
        removeWorkerWorktree(repositoryPath(this.workspace, node.repository), worktree);
      }
    }
    if (released.length > 0) {
      this.event('resource.released', nodeId, { count: released.length });
    }
  }

  // ---- verification -----------------------------------------------------

  /**
   * Fresh verification.
   *
   * Runs in a clean worktree created from the node's branch, so nothing the
   * worker left in its own working directory can make a failing suite look
   * green. Also re-checks the ownership fence against a real diff.
   */
  freshVerify(
    nodeId: string,
    options: { labelPrefix?: string; expectedSha?: string } = {},
  ): { ok: boolean; evidence: EvidenceRecord[]; detail: string; sha?: string; setupFailed?: boolean } {
    const labelPrefix = options.labelPrefix ?? 'fresh';
    const node = this.node(nodeId);
    const evidence: EvidenceRecord[] = [];
    if (node.repository === null) {
      return { ok: true, evidence, detail: 'no repository to verify' };
    }

    const repoPath = repositoryPath(this.workspace, node.repository);
    const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === node.repository);
    const baseBranch = repoDecl?.base_branch ?? 'main';
    const branch = workerBranchName(this.featureId, nodeId);

    const verifyRoot = join(this.workspace.paths.workDir, 'verify');
    mkdirSync(verifyRoot, { recursive: true });
    // One directory per verification, so a concurrent check never removes
    // the checkout another verification is using.
    const verifyDir = join(
      verifyRoot,
      `${node.repository}__${nodeId.replace(/[^\w.-]/g, '_')}__${randomUUID().slice(0, 8)}`,
    );

    // A clean checkout of exactly the commit the branch names now. That SHA
    // is what gets integrated: a commit landing on the branch afterwards was
    // never verified.
    const sha = resolveRef(repoPath, branch);
    if (options.expectedSha !== undefined && sha !== options.expectedSha) {
      // Settle judged the history up to the sealed head; anything after it was never judged.
      return {
        ok: false,
        evidence,
        sha,
        detail: `BRANCH_MOVED: ${branch} is at ${sha.slice(0, 12)}, not at ${options.expectedSha.slice(0, 12)}, the commit the submission named and settle judged`,
      };
    }
    runGit(repoPath, ['worktree', 'prune'], { allowFail: true });
    runGit(repoPath, ['worktree', 'add', '--detach', verifyDir, sha]);
    runGit(verifyDir, ['config', 'core.autocrlf', 'false'], { allowFail: true });

    try {
      const runtime = this.state().nodes[nodeId];
      const pinned = runtime?.claim?.base_sha ?? runtime?.branch_base_sha ?? null;
      // A branch with no pinned base (created before bases were recorded) is
      // measured against the base branch, as it always was.
      const base = pinned === null ? resolveRef(repoPath, baseBranch) : this.fenceBase(node.repository, repoPath, pinned, sha);
      if (base === null) {
        return {
          ok: false,
          evidence,
          sha,
          detail: `OWNERSHIP_VIOLATION: BASE_NOT_ANCESTOR: ${branch} at ${sha.slice(0, 12)} no longer contains the commit ${String(pinned).slice(0, 12)} its worktree was created from`,
        };
      }
      const fence = verifyChangedPaths(verifyDir, base, {
        allowed: node.allowed_paths,
        forbidden: node.forbidden_paths ?? [],
      });
      if (fence.violations.length > 0) {
        return {
          ok: false,
          evidence,
          sha,
          detail: `OWNERSHIP_VIOLATION: ${fence.violations.slice(0, 10).join(', ')}`,
        };
      }

      const evidenceDir = nodeEvidenceDir(this.controlRoot, this.featureId, nodeId);
      // The module command the claim bound: the gates ran it, and so does this clean checkout.
      const bound = runtime?.claim?.verification;
      // The clean checkout gets what a checkout does not carry, set up exactly as the claim's worktree was.
      let setupReceipt: string | null = null;
      const setup = this.checkoutSetup(nodeId, node.repository);
      if (setup !== null) {
        const run = runWorktreeSetup({
          controlRoot: this.controlRoot,
          repository: node.repository,
          repoPath,
          worktree: verifyDir,
          root: verifyRoot,
          config: setup,
          evidenceDir,
          label: `${safeNodeDir(nodeId)}.${labelPrefix}-setup`,
          ...(bound !== undefined ? { verification: { module: bound.module, module_sha256: bound.module_sha256 } } : {}),
        });
        this.event('worktree.setup', nodeId, {
          purpose: 'fresh-verification',
          status: run.receipt.status,
          code: run.receipt.code,
          receipt_path: run.receipt_path,
          receipt_sha256: run.receipt_sha256,
          output_path: run.receipt.output_path,
        });
        if (run.receipt.status !== 'complete') {
          // Nothing about the work is known: the checkout could not be prepared.
          return { ok: false, evidence, sha, setupFailed: true, detail: new WorktreeSetupError(`${nodeId} fresh verification`, run.receipt, run.receipt_path).message };
        }
        setupReceipt = run.receipt_sha256;
      }
      const bindSetup = (record: EvidenceRecord): EvidenceRecord => (setupReceipt === null ? record : { ...record, worktree_setup_sha256: setupReceipt });
      for (const [i, verifier] of node.verification_commands.entries()) {
        const moduleRun = bound !== undefined && i === 0 && verifier.module === bound.module;
        const record = bindSetup(runVerification({
          kind: 'green',
          nodeId,
          repository: node.repository,
          ...(moduleRun ? moduleInvocation(bound) : verifierInvocation(verifier)),
          cwd: !moduleRun && verifier.cwd ? join(verifyDir, verifier.cwd) : verifyDir,
          evidenceDir,
          label: `${labelPrefix}-${verifier.id}`,
          baselineFailures: repoDecl?.baseline_failures ?? [],
          allowShell: this.workspace.config.allow_shell_commands,
          pathBase: this.controlRoot,
          ...(verifier.expect_exit !== undefined ? { expectExit: verifier.expect_exit } : {}),
        }));
        evidence.push(record);
        if (record.failure_fingerprint !== null) {
          return {
            ok: false,
            evidence,
            detail: `verifier "${verifier.id}" exited ${record.exit_code} (${record.failure_fingerprint})`,
          };
        }
      }

      // The targeted verifiers ran and recorded their output; the regression has not (where the pilot's settle died).
      this.fault('fresh-targeted');
      if (node.required_evidence.includes('regression')) {
        // The full suite: the one the claim bound, else the repository's.
        const command = bound?.regression.command ?? repoDecl?.commands.regression ?? repoDecl?.commands.test;
        if (command) {
          const record = bindSetup(runVerification({
            kind: 'regression',
            nodeId,
            repository: node.repository,
            command,
            cwd: verifyDir,
            evidenceDir,
            label: `${labelPrefix}-regression`,
            baselineFailures: repoDecl?.baseline_failures ?? [],
            pathBase: this.controlRoot,
          }));
          // A module-bound producer's full suite may fail only where its dependents re-verify: that passes to them.
          let unattributed = '';
          if (record.failure_fingerprint !== null && bound !== undefined) {
            const decision = regressionDeferral({
              graph: this.graph(),
              state: this.state(),
              nodeId,
              output: readFileSync(join(this.controlRoot, record.output_path), 'utf8'),
              exitCode: record.exit_code,
              checkout: verifyDir,
            });
            if (decision.deferred) record.regression_deferred = { to: decision.to, failing: decision.failing };
            else unattributed = `; REGRESSION_NOT_DEFERRED: ${decision.reason}`;
          }
          evidence.push(record);
          if (record.failure_fingerprint !== null && record.regression_deferred === undefined) {
            return {
              ok: false,
              evidence,
              detail: `regression exited ${record.exit_code} (${record.failure_fingerprint})${unattributed}`,
            };
          }
        }
      }

      return { ok: true, evidence, sha, detail: 'fresh verification passed' };
    } finally {
      runGit(repoPath, ['worktree', 'remove', '--force', verifyDir], { allowFail: true });
      runGit(repoPath, ['worktree', 'prune'], { allowFail: true });
    }
  }

  // ---- reproduction capsules (engine/reproduction-capsule.ts; CSET-203 r17) ------------------

  /**
   * Seal the exact focused reproduction of a review gap the claim's worktree holds, uncommitted, as a capsule: its files
   * read and checked (contained, bounded, never through a link, safe), run with the claim's own module command on a
   * throwaway checkout of the claim's unchanged base set up as its worktree was, each test that run reported from its
   * files recorded, the archive sealed under the control repository and its receipt's hash put in the claim's registry —
   * by the holder of the claim's capability only. Nothing of the product (refs, index, worktree) is touched. The same
   * bytes for the same order again are the same capsule (idempotent, nothing run again); one sealed by a registration
   * that died before its registry write is finished, never run twice. `carry` re-binds a capsule of this claim to the
   * order's current revision, its reproduction, bytes, base and module verified unchanged.
   */
  registerCapsule(nodeId: string, capability: string | undefined, options: { criterion: string; files?: readonly string[] | null; carry?: string | null }): CapsuleRegistration | CapsuleRefusal {
    const refuse = (code: CapsuleCode, detail: string): CapsuleRefusal => ({ ok: false, code, detail });
    const node = this.node(nodeId);
    const state = this.state();
    const rt = state.nodes[nodeId] as NodeRuntime;
    assertClaimCapability(nodeId, rt, capability);
    const claim = rt.claim as NodeClaim;
    if (node.repository === null || claim.worktree === null || !existsSync(claim.worktree)) return refuse('CAPSULE_UNAVAILABLE', `${nodeId} has no claim with a worktree to read a reproduction from`);
    const brief = rt.rework_brief ?? null;
    if (brief === null || brief.origin?.kind !== 'acceptance-review') return refuse('CAPSULE_NOT_REVIEW_REWORK', `${nodeId} is not in an acceptance review's rework: a capsule seals the exact reproduction of a review's gap`);
    const graph = this.graph();
    if (!brief.acceptance_criteria.includes(options.criterion)) return refuse('CAPSULE_CRITERION', `${options.criterion} is not a criterion of this rework (${brief.acceptance_criteria.join(', ')})`);
    if (criterionKind(graph, options.criterion) !== 'new-behavior') return refuse('CAPSULE_CRITERION', `${options.criterion} is a ${criterionKind(graph, options.criterion)} criterion: its test is expected to pass and is committed as a compatibility-regression unit, never sealed as a reproduction`);
    if (this.orderStaleness(state, nodeId) !== null) return refuse('CAPSULE_STALE', `${nodeId}'s order is bound to an older revision of its review: dispatch reconciles it first`);
    const order = currentOrder(rt, options.criterion);
    if (order === null) return refuse('CAPSULE_CRITERION', `the order holds no reproduction of ${options.criterion}`);
    const base = claim.base_sha ?? rt.branch_base_sha ?? null;
    if (base === null) return refuse('CAPSULE_UNAVAILABLE', `${nodeId}'s claim records no base`);
    const repoPath = repositoryPath(this.workspace, node.repository);
    const bound = claim.verification;
    const declared = node.verification_commands[0];
    if (bound === undefined && (declared === undefined || declared.command.length === 0)) return refuse('CAPSULE_UNAVAILABLE', `${nodeId} declares no verifier to run a reproduction with`);
    const command = bound !== undefined ? moduleInvocation(bound).command : (declared as { command: string[] }).command;
    const module = bound !== undefined ? { id: bound.module, sha256: bound.module_sha256, plan_sha256: bound.plan_sha256 } : null;
    const claimRef = { claim_id: claim.claim_id, generation: claim.generation ?? 0, dispatch_id: claim.dispatch_id ?? null, capability_sha256: claim.capability_sha256 as string };
    removeCapsuleStaging(this.controlRoot, this.featureId, nodeId);
    if (options.carry !== undefined && options.carry !== null) return this.carryCapsule(nodeId, rt, options.carry, options.criterion, order, base, module);

    const policy = claim.tdd_policy ?? this.claimTddPolicy(node.repository);
    const collected = collectCapsuleFiles({
      worktree: claim.worktree,
      policy,
      allowed: node.allowed_paths,
      forbidden: node.forbidden_paths ?? [],
      modulePath: bound?.path ?? null,
      paths: options.files ?? null,
      base,
      holdsAuthority: (text) => holdsControllerKey(this.controlRoot, text),
    });
    if (!collected.ok) return collected;
    const files = collected.files.map((f) => ({ ...f, base_blob: blobAt(repoPath, base, f.path) }));
    const contentAt = (path: string): string | null => {
      const r = runGit(repoPath, ['show', `${base}:${path}`], { allowFail: true });
      return r.exitCode === 0 ? r.stdout : null;
    };
    const deltas = files.map((f) => ({ path: f.path, before: f.base_blob === null ? null : contentAt(f.path), after: f.bytes.toString('utf8') }));
    const weakened = capsuleWeakening(deltas);
    if (weakened.length > 0) return refuse('CAPSULE_WEAKENS', `the reproduction ${weakened.slice(0, 6).join('; ')}: a reproduction only adds the focused tests of the gap, never weakens one that was there`);
    const identity: CapsuleIdentityInput = { feature_id: this.featureId, node_id: nodeId, claim_id: claimRef.claim_id, generation: claimRef.generation, criterion: options.criterion, order, base_sha: base, module, command: [...command], files: files.map((f) => ({ path: f.path, sha256: f.sha256 })) };
    const ident = capsuleIdentity(identity);
    // The same reproduction again: what was sealed stands (a registry entry, or an archive whose registry write died).
    const again = this.existingCapsule(nodeId, ident.capsule_id, claimRef.capability_sha256);
    if (again !== null) return again;
    if ((claim.capsules ?? []).length >= CAPSULE_LIMITS.per_claim) return refuse('CAPSULE_LIMIT', `${nodeId}'s claim holds ${CAPSULE_LIMITS.per_claim} capsules already: cite one of them`);

    const staging = join(nodeEvidenceDir(this.controlRoot, this.featureId, nodeId), CAPSULES_DIR, `.run-${ident.capsule_id}-${randomUUID().slice(0, 8)}`);
    mkdirSync(staging, { recursive: true });
    try {
      const run = this.runCapsuleAt(nodeId, base, files, staging, 'capsule');
      if ('setup' in run) return refuse('CAPSULE_SETUP_FAILED', `the checkout of ${base.slice(0, 12)} could not be set up: ${run.setup}`);
      const record = run.record;
      const ran = readGateTests(this.controlRoot, record);
      if (ran === null) return refuse('CAPSULE_NO_REPORT', `the module command published no structured test report (exit ${record.exit_code}; log ${record.output_path}): a capsule names its tests by the report its run writes`);
      const tests = capsuleTests({ files: deltas, ran });
      if (tests.length === 0) return refuse('CAPSULE_NO_TESTS', `its run reported no test from ${files.map((f) => f.path).join(', ')} (exit ${record.exit_code}): the module's command must run the reproduction's files`);
      const outcome = capsuleOutcome(tests);
      if (!outcome.ok) return refuse('CAPSULE_RUN_INVALID', outcome.detail);
      const sealed = writeCapsuleArchive({
        controlRoot: this.controlRoot,
        featureId: this.featureId,
        nodeId,
        identity,
        ...ident,
        repository: node.repository,
        claim: claimRef,
        integration_sha: brief.replaced.integrated_sha,
        module_path: bound?.path ?? null,
        verification: bound ?? null,
        files,
        tests,
        result: outcome.result,
        run: {
          output_file: join(this.controlRoot, ...record.output_path.split('/')),
          results_file: record.results ? join(this.controlRoot, ...record.results.path.split('/')) : null,
          exit_code: record.exit_code,
          commit_sha: record.commit_sha,
          worktree_setup_sha256: run.setup_sha256,
          started_at: record.started_at,
          finished_at: record.finished_at,
        },
        carried_from: null,
      });
      this.capsuleFault?.('capsule-sealed');
      return this.registerSealed(nodeId, sealed.capsule, sealed.capsule_sha256, sealed.receipt_path, claimRef.capability_sha256, false);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** A capsule already sealed under this id for the claim: its registration (idempotent), finishing one whose registry write died. */
  private existingCapsule(nodeId: string, capsuleId: string, capabilitySha: string): CapsuleRegistration | CapsuleRefusal | null {
    const claim = this.state().nodes[nodeId]?.claim ?? null;
    const entry = (claim?.capsules ?? []).find((e) => e.capsule_id === capsuleId);
    const receiptPath = `${capsuleDir(this.featureId, nodeId, capsuleId)}/capsule.json`;
    if (entry === undefined && !existsSync(join(this.controlRoot, ...receiptPath.split('/')))) return null;
    const read = readCapsule(this.controlRoot, entry?.receipt_path ?? receiptPath, entry?.capsule_sha256);
    if (!read.ok) return { ok: false, code: 'CAPSULE_TAMPERED', detail: `${capsuleId} is sealed already, and its archive is not as sealed: ${read.detail}` };
    if (read.capsule.capsule_id !== capsuleId || !capsuleSelfConsistent(read.capsule)) return { ok: false, code: 'CAPSULE_TAMPERED', detail: `${receiptPath} does not bind ${capsuleId}` };
    const archive = capsuleArchiveProblem(this.controlRoot, read.capsule);
    if (archive !== null) return { ok: false, code: 'CAPSULE_TAMPERED', detail: `${capsuleId} is sealed already, and ${archive}` };
    if (entry !== undefined) return this.registration(read.capsule, read.capsule_sha256, entry.receipt_path, true);
    return this.registerSealed(nodeId, read.capsule, read.capsule_sha256, receiptPath, capabilitySha, true);
  }

  /** Put a sealed capsule in the claim's registry, under its capability, once; and say so. */
  private registerSealed(nodeId: string, capsule: CapsuleReceipt, capsuleSha: string, receiptPath: string, capabilitySha: string, resumed: boolean): CapsuleRegistration {
    const entry: CapsuleRegistryEntry = {
      capsule_id: capsule.capsule_id,
      capsule_sha256: capsuleSha,
      receipt_path: receiptPath,
      criterion: capsule.criterion,
      result: capsule.result,
      revision: capsule.order.revision,
      capability_sha256: capabilitySha,
      registered_at: new Date().toISOString(),
      ...(capsule.carried_from !== null ? { carried_from: { ...capsule.carried_from } } : {}),
    };
    let added = false;
    mutateState(this.paths.featureDir, (s) => {
      const c = s.nodes[nodeId]?.claim;
      if (!c || c.claim_id !== capsule.claim.claim_id || c.capability_sha256 !== capabilitySha) throw new CapabilityError('CAPABILITY_INVALID', `${nodeId}'s claim changed while its capsule was sealed; seal it again with the current capability`);
      if ((c.capsules ?? []).some((e) => e.capsule_id === entry.capsule_id)) return s;
      c.capsules = [...(c.capsules ?? []), entry].slice(-CAPSULE_LIMITS.per_claim);
      added = true;
      return s;
    });
    if (added) {
      this.event(capsule.carried_from !== null ? 'capsule.carried' : 'capsule.registered', nodeId, {
        capsule_id: capsule.capsule_id,
        capsule_sha256: capsuleSha,
        criterion: capsule.criterion,
        result: capsule.result,
        review_id: capsule.order.review_id,
        revision: capsule.order.revision,
        base_sha: capsule.base_sha,
        tests: capsule.tests.map((t) => ({ id: t.id, status: t.status })),
        files: capsule.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
        receipt_path: receiptPath,
        ...(capsule.carried_from !== null ? { carried_from: capsule.carried_from } : {}),
        resumed,
      });
    }
    return this.registration(capsule, capsuleSha, receiptPath, !added || resumed);
  }

  private registration(capsule: CapsuleReceipt, capsuleSha: string, receiptPath: string, idempotent: boolean): CapsuleRegistration {
    const unnamed = capsule.tests.filter((t) => t.declared !== 'static').filter((t) => {
      const f = capsule.files.find((x) => x.path === t.path);
      if (f === undefined) return true;
      const source = readFileSync(join(this.controlRoot, ...f.archived.split('/')), 'utf8');
      return !declaredTests(t.path, source).some((d) => d.name === t.name || d.name === t.full_name);
    });
    const detail =
      capsule.result === 'passed'
        ? `${capsule.capsule_id}: ${capsule.criterion}'s reproduction passes on the unchanged base ${capsule.base_sha.slice(0, 12)} — challenge material only: the challenge line with --capsule ${capsule.capsule_id}, outcome REVIEW_GAP_CHALLENGE (or that criterion's in a per-criterion answer), then the check line. Keep its files out of the branch; never cite it as a proof of DONE.`
        : `${capsule.capsule_id}: ${capsule.criterion}'s reproduction fails on the unchanged base ${capsule.base_sha.slice(0, 12)} — the gap reproduces: it is RED material only. Commit exactly its files alone (test-first), run the red gate, then the fix; cite the red gate's failing test with "capsule_id": "${capsule.capsule_id}".${unnamed.length > 0 ? ` Its tests ${unnamed.slice(0, 4).map((t) => JSON.stringify(t.full_name)).join(', ')} are not statically named (a template literal or a loop): a RED's tests must be (give each a string-literal title) before they are committed.` : ''}`;
    return {
      ok: true,
      capsule_id: capsule.capsule_id,
      capsule_sha256: capsuleSha,
      criterion: capsule.criterion,
      result: capsule.result,
      idempotent,
      carried_from: capsule.carried_from,
      receipt_path: receiptPath,
      artifact_path: capsule.artifact.path,
      base_sha: capsule.base_sha,
      run_output_sha256: capsule.run.output_sha256,
      tests: capsule.tests.map((t) => ({ id: t.id, path: t.path, full_name: t.full_name, status: t.status, category: t.category, declared: t.declared, block: t.block })),
      files: capsule.files.map((f) => ({ path: f.path, sha256: f.sha256, blob: f.blob })),
      detail,
    };
  }

  /**
   * Carry a capsule of this claim to its order's current revision (a rebase, CSET-203 r14): the same claim, generation,
   * base and module plan, the criterion's reproduction unchanged, its archive intact. A new capsule, bound to the
   * current order, its run and files the old one's; never run again.
   */
  private carryCapsule(nodeId: string, rt: NodeRuntime, oldId: string, criterion: string, order: CapsuleOrder, base: string, module: CapsuleIdentityInput['module']): CapsuleRegistration | CapsuleRefusal {
    const claim = rt.claim as NodeClaim;
    const used = capsuleUse({ controlRoot: this.controlRoot, featureId: this.featureId, nodeId, runtime: rt, capsuleId: oldId, capsuleSha256: null, criterion, want: null });
    let old: CapsuleReceipt;
    let oldSha: string;
    if (used.ok) {
      old = used.capsule;
      oldSha = used.capsule_sha256;
    } else {
      // Stale only for its order: anything else (another claim, generation, base or module; tampered; unknown) is not carried.
      const entry = (claim.capsules ?? []).find((e) => e.capsule_id === oldId);
      if (entry === undefined) return { ok: false, code: used.code === 'CAPSULE_UNKNOWN' ? 'CAPSULE_UNKNOWN' : 'CAPSULE_STALE', detail: `${used.detail}; a capsule is carried only within the claim that sealed it` };
      const read = readCapsule(this.controlRoot, entry.receipt_path, entry.capsule_sha256);
      if (!read.ok) return { ok: false, code: 'CAPSULE_TAMPERED', detail: read.detail };
      old = read.capsule;
      oldSha = read.capsule_sha256;
      if (!capsuleSelfConsistent(old)) return { ok: false, code: 'CAPSULE_TAMPERED', detail: `${oldId}'s receipt does not bind its id` };
      const archive = capsuleArchiveProblem(this.controlRoot, old);
      if (archive !== null) return { ok: false, code: 'CAPSULE_TAMPERED', detail: archive };
      if (old.claim.claim_id !== claim.claim_id || old.claim.generation !== (claim.generation ?? 0)) return { ok: false, code: 'CAPSULE_STALE', detail: `${oldId} was sealed for another claim or generation: a capsule is carried only within the claim that sealed it` };
      if (old.base_sha !== base) return { ok: false, code: 'CAPSULE_STALE', detail: `${oldId} ran on ${old.base_sha.slice(0, 12)}, the claim's base is ${base.slice(0, 12)}: seal the reproduction again` };
      if (JSON.stringify(old.module === null ? null : { id: old.module.id, sha256: old.module.sha256, plan_sha256: old.module.plan_sha256 }) !== JSON.stringify(module)) return { ok: false, code: 'CAPSULE_STALE', detail: `${oldId} ran another module command than the claim's now: seal the reproduction again` };
    }
    if (old.criterion !== criterion) return { ok: false, code: 'CAPSULE_CRITERION', detail: `${oldId} was sealed for ${old.criterion}, not ${criterion}` };
    if (old.order.reproduction_sha256 !== order.reproduction_sha256 || old.order.review_id !== order.review_id || old.order.reason_sha256 !== order.reason_sha256) {
      return { ok: false, code: 'CAPSULE_CARRY_CHANGED', detail: `${oldId} reproduces ${old.order.review_id}'s gap as it was; the order's reproduction (or reason) of ${criterion} is another now: seal the new reproduction` };
    }
    // Already current: nothing to carry.
    if (orderDrift(old.order, order) === null) return this.registration(old, oldSha, `${capsuleDir(this.featureId, nodeId, old.capsule_id)}/capsule.json`, true);
    const identity: CapsuleIdentityInput = { feature_id: this.featureId, node_id: nodeId, claim_id: claim.claim_id, generation: claim.generation ?? 0, criterion, order, base_sha: base, module, command: [...old.command], files: old.files.map((f) => ({ path: f.path, sha256: f.sha256 })) };
    const ident = capsuleIdentity(identity);
    const capabilitySha = claim.capability_sha256 as string;
    const again = this.existingCapsule(nodeId, ident.capsule_id, capabilitySha);
    if (again !== null) return again;
    const files = old.files.map((f) => ({ path: f.path, bytes: readFileSync(join(this.controlRoot, ...f.archived.split('/'))), sha256: f.sha256, blob: f.blob, base_blob: f.base_blob }));
    const sealed = writeCapsuleArchive({
      controlRoot: this.controlRoot,
      featureId: this.featureId,
      nodeId,
      identity,
      ...ident,
      repository: old.repository,
      claim: { claim_id: claim.claim_id, generation: claim.generation ?? 0, dispatch_id: claim.dispatch_id ?? null, capability_sha256: capabilitySha },
      integration_sha: old.integration_sha,
      module_path: old.module?.path ?? null,
      verification: old.verification ?? null,
      files,
      tests: old.tests,
      result: old.result,
      run: {
        output_file: join(this.controlRoot, ...old.run.output_path.split('/')),
        results_file: old.run.results_path === null ? null : join(this.controlRoot, ...old.run.results_path.split('/')),
        exit_code: old.run.exit_code,
        commit_sha: old.run.commit_sha,
        worktree_setup_sha256: old.run.worktree_setup_sha256,
        started_at: old.run.started_at,
        finished_at: old.run.finished_at,
      },
      carried_from: { capsule_id: old.capsule_id, capsule_sha256: oldSha },
    });
    return this.registerSealed(nodeId, sealed.capsule, sealed.capsule_sha256, sealed.receipt_path, capabilitySha, false);
  }

  /**
   * Run `files` with the node's module command (its claim's binding, else its verifier) on a throwaway detached checkout of
   * `sha`, set up as the claim's worktree was; the checkout is removed whatever happens. Evidence goes to `evidenceDir`.
   */
  private runCapsuleAt(nodeId: string, sha: string, files: readonly { path: string; bytes: Buffer }[], evidenceDir: string, label: string, binding?: { verification: ClaimVerification | null; command: string[] }): { record: EvidenceRecord; setup_sha256: string | null } | { setup: string } {
    const node = this.node(nodeId);
    const repository = node.repository as string;
    const repoPath = repositoryPath(this.workspace, repository);
    const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === repository);
    const root = join(this.workspace.paths.workDir, 'capsule-runs');
    mkdirSync(root, { recursive: true });
    const prefix = `${safeNodeDir(nodeId)}__`;
    // A checkout a dead registration left behind: removed before another is made.
    for (const left of readdirSync(root).filter((n) => n.startsWith(prefix))) {
      runGit(repoPath, ['worktree', 'remove', '--force', join(root, left)], { allowFail: true });
      rmSync(join(root, left), { recursive: true, force: true });
    }
    runGit(repoPath, ['worktree', 'prune'], { allowFail: true });
    const dir = join(root, `${prefix}${randomUUID().slice(0, 8)}`);
    runGit(repoPath, ['worktree', 'add', '--detach', dir, sha]);
    try {
      runGit(dir, ['config', 'core.autocrlf', 'false'], { allowFail: true });
      // A replay runs exactly the plan the capsule was sealed with; a registration, the claim's.
      const bound = binding !== undefined ? (binding.verification ?? undefined) : this.state().nodes[nodeId]?.claim?.verification;
      let setupSha: string | null = null;
      const setup = this.checkoutSetup(nodeId, repository);
      if (setup !== null) {
        const run = runWorktreeSetup({
          controlRoot: this.controlRoot,
          repository,
          repoPath,
          worktree: dir,
          root,
          config: setup,
          evidenceDir,
          label: `${safeNodeDir(nodeId)}.${label}-setup`,
          ...(bound !== undefined ? { verification: { module: bound.module, module_sha256: bound.module_sha256 } } : {}),
        });
        if (run.receipt.status !== 'complete') return { setup: `${run.receipt.code}: ${run.receipt.detail}` };
        setupSha = run.receipt_sha256;
      }
      for (const f of files) {
        const target = join(dir, ...f.path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        // Written only inside the checkout: a directory the base tree links elsewhere is never written through.
        if (!isInsideReal(dir, target)) throw new Error(`CAPSULE_SYMLINK: ${f.path} leaves the checkout of ${sha.slice(0, 12)}`);
        rmSync(target, { force: true });
        writeFileSync(target, f.bytes, { flag: 'wx' });
      }
      const declared = node.verification_commands[0];
      const plan = bound !== undefined ? moduleInvocation(bound) : verifierInvocation({ command: binding?.command ?? declared?.command ?? [] });
      const record = runVerification({
        kind: 'red',
        nodeId,
        repository,
        ...plan,
        cwd: dir,
        evidenceDir,
        label,
        expectExit: -1,
        baselineFailures: repoDecl?.baseline_failures ?? [],
        allowShell: this.workspace.config.allow_shell_commands,
        pathBase: this.controlRoot,
        redDeclared: null,
      });
      this.capsuleFault?.('capsule-ran');
      return { record, setup_sha256: setupSha };
    } finally {
      runGit(repoPath, ['worktree', 'remove', '--force', dir], { allowFail: true });
      rmSync(dir, { recursive: true, force: true });
      runGit(repoPath, ['worktree', 'prune'], { allowFail: true });
    }
  }

  /**
   * Every capsule of the feature, checked: its receipt and archive as sealed, self-consistent; every one a challenge or a
   * promoted RED cites, present and as cited. With `replay`, each cited one is run again, independently, on a fresh
   * checkout of its base with its archived files — every test must end as sealed — and a promoted RED's capsule on the
   * head that integrated its fix, where every test must pass.
   */
  verifyCapsules(options: { replay?: boolean; nodeId?: string | null; capsuleId?: string | null } = {}): { ok: boolean; capsules: CapsuleVerification[] } {
    const out: CapsuleVerification[] = [];
    const state = this.state();
    const cited = this.citedCapsules(state);
    const found = new Map<string, { nodeId: string; receipt: string }>();
    for (const node of this.graph().nodes) {
      const dir = join(nodeEvidenceDir(this.controlRoot, this.featureId, node.id), CAPSULES_DIR);
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => /^CAP-[0-9a-f]{16}$/.test(n));
      } catch {
        names = [];
      }
      for (const n of names) found.set(n, { nodeId: node.id, receipt: `${capsuleDir(this.featureId, node.id, n)}/capsule.json` });
    }
    for (const c of cited) if (!found.has(c.capsule_id)) found.set(c.capsule_id, { nodeId: c.node_id, receipt: `${capsuleDir(this.featureId, c.node_id, c.capsule_id)}/capsule.json` });
    for (const [id, at] of [...found.entries()].sort()) {
      if (options.nodeId != null && at.nodeId !== options.nodeId) continue;
      if (options.capsuleId != null && id !== options.capsuleId) continue;
      const uses = cited.filter((c) => c.capsule_id === id);
      const problems: string[] = [];
      const expected = uses.find((u) => u.capsule_sha256 !== null)?.capsule_sha256 ?? null;
      const read = readCapsule(this.controlRoot, at.receipt, expected);
      let replay: CapsuleVerification['replay'] = null;
      if (!read.ok) problems.push(`${read.code}: ${read.detail}`);
      else {
        if (!capsuleSelfConsistent(read.capsule) || read.capsule.capsule_id !== id) problems.push(`CAPSULE_TAMPERED: ${at.receipt} does not bind ${id}`);
        const archive = capsuleArchiveProblem(this.controlRoot, read.capsule);
        if (archive !== null) problems.push(archive);
        for (const u of uses) if (u.capsule_sha256 !== null && u.capsule_sha256 !== read.capsule_sha256) problems.push(`CAPSULE_TAMPERED: ${u.by} cites ${id} at ${u.capsule_sha256.slice(0, 12)}, it hashes to ${read.capsule_sha256.slice(0, 12)}`);
        if (problems.length === 0 && options.replay === true && uses.length > 0) replay = this.replayCapsule(read.capsule, uses);
        if (replay !== null && (!replay.base.ok || (replay.head !== null && !replay.head.ok))) problems.push(`CAPSULE_REPLAY_DIFFERS: ${[replay.base, replay.head].filter((r) => r !== null && !r.ok).map((r) => (r as { detail: string }).detail).join('; ')}`);
      }
      out.push({ capsule_id: id, node_id: at.nodeId, cited_by: uses.map((u) => u.by), ok: problems.length === 0, problems, replay });
    }
    return { ok: out.every((c) => c.ok), capsules: out };
  }

  /** Where the feature cites capsules: its challenges' receipts and its DONE nodes' promoted REDs. */
  private citedCapsules(state: FeatureState_): { capsule_id: string; capsule_sha256: string | null; node_id: string; by: string; promoted_head: string | null }[] {
    const out: { capsule_id: string; capsule_sha256: string | null; node_id: string; by: string; promoted_head: string | null }[] = [];
    for (const ch of state.acceptance_review?.challenges ?? []) {
      const receipt = readChallengeReceipt(this.controlRoot, ch.receipt_path);
      for (const k of (receipt?.['capsules'] ?? []) as { capsule_id: string; capsule_sha256: string }[]) out.push({ capsule_id: k.capsule_id, capsule_sha256: k.capsule_sha256, node_id: ch.node_id, by: `challenge ${ch.challenge_id}`, promoted_head: null });
    }
    for (const [id, rt] of Object.entries(state.nodes)) {
      for (const c of rt.criteria ?? []) if (c.capsule) out.push({ capsule_id: c.capsule.capsule_id, capsule_sha256: c.capsule.capsule_sha256, node_id: id, by: `${id} ${c.criterion} RED`, promoted_head: rt.state === 'DONE' ? rt.integrated_sha : null });
    }
    return out;
  }

  /** Run a sealed capsule again on its base (every test as sealed) and, promoted to a RED, on the head that integrated its fix (every test passing). */
  private replayCapsule(capsule: CapsuleReceipt, uses: readonly { promoted_head: string | null }[]): NonNullable<CapsuleVerification['replay']> {
    const files = capsule.files.map((f) => ({ path: f.path, bytes: readFileSync(join(this.controlRoot, ...f.archived.split('/'))) }));
    const at = (sha: string, expect: (sealed: CapsuleTest) => string): CapsuleReplayRun => {
      const dir = join(nodeEvidenceDir(this.controlRoot, this.featureId, capsule.node_id), CAPSULES_DIR, `.run-replay-${capsule.capsule_id}-${randomUUID().slice(0, 8)}`);
      mkdirSync(dir, { recursive: true });
      try {
        const run = this.runCapsuleAt(capsule.node_id, sha, files, dir, 'replay', { verification: capsule.verification ?? null, command: capsule.command });
        if ('setup' in run) return { sha, ok: false, detail: `the checkout of ${sha.slice(0, 12)} could not be set up: ${run.setup}`, statuses: {} };
        const ran = readGateTests(this.controlRoot, run.record) ?? [];
        const statuses = Object.fromEntries(capsule.tests.map((t) => [t.id, ran.find((r) => r.id === t.id)?.status ?? 'not-run']));
        const differs = capsule.tests.filter((t) => statuses[t.id] !== expect(t));
        return { sha, ok: differs.length === 0, detail: differs.length === 0 ? 'as sealed' : `on ${sha.slice(0, 12)}: ${differs.map((t) => `${t.full_name} ${statuses[t.id]}, expected ${expect(t)}`).slice(0, 4).join('; ')}`, statuses };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const base = at(capsule.base_sha, (t) => t.status);
    const promoted = uses.find((u) => u.promoted_head !== null)?.promoted_head ?? null;
    return { base, head: promoted === null ? null : at(promoted, () => 'passed') };
  }

  /** The claim's capsules as its worker sees them: current, or stale and whether it may be carried (context pack). */
  capsuleViews(nodeId: string): ContextCapsule[] {
    const rt = this.state().nodes[nodeId];
    const claim = rt?.claim ?? null;
    if (rt === undefined || claim === null) return [];
    return (claim.capsules ?? []).map((e) => {
      const used = capsuleUse({ controlRoot: this.controlRoot, featureId: this.featureId, nodeId, runtime: rt, capsuleId: e.capsule_id, capsuleSha256: e.capsule_sha256, criterion: null, want: null });
      let carry = false;
      if (!used.ok && used.code === 'CAPSULE_STALE') {
        const read = readCapsule(this.controlRoot, e.receipt_path, e.capsule_sha256);
        const now = read.ok ? currentOrder(rt, read.capsule.criterion) : null;
        carry = read.ok && now !== null && read.capsule.claim.claim_id === claim.claim_id && read.capsule.claim.generation === (claim.generation ?? 0) && read.capsule.base_sha === (claim.base_sha ?? rt.branch_base_sha ?? null) && read.capsule.order.reproduction_sha256 === now.reproduction_sha256 && read.capsule.order.reason_sha256 === now.reason_sha256;
      }
      const read = used.ok ? { ok: true as const, capsule: used.capsule } : readCapsule(this.controlRoot, e.receipt_path, e.capsule_sha256);
      return {
        capsule_id: e.capsule_id,
        capsule_sha256: e.capsule_sha256,
        criterion: e.criterion,
        result: e.result,
        revision: e.revision,
        current: used.ok,
        carry,
        ...(used.ok ? {} : { why: used.detail.slice(0, 400) }),
        tests: read.ok ? read.capsule.tests.slice(0, 16).map((t) => ({ id: t.id, status: t.status, full_name: t.full_name.slice(0, 300) })) : [],
      };
    });
  }

  /** Merge a verified node branch into its repository integration branch. */
  integrate(nodeId: string, expectedSha?: string): string | null {
    return this.integrateNode(nodeId, expectedSha)?.sha ?? null;
  }

  /**
   * Integrate under the repository's integration lock. The exact commit the
   * branch will move to is journaled in STATE.json before it moves; an
   * integration that died after moving it resumes only when the branch is at
   * exactly that journaled commit. The branch's shape (which commits it
   * contains, its parents) is never evidence: anything else is
   * INTEGRATION_BRANCH_MOVED.
   */
  integrateNode(nodeId: string, expectedSha?: string): { sha: string; branch: string; strategy: IntegrateResult['strategy'] } | null {
    const node = this.node(nodeId);
    if (node.repository === null) return null;
    const repository = node.repository;
    const lockDir = join(this.paths.featureDir, 'integration');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, `${repository}.lock`), () => this.integrateLocked(nodeId, repository, expectedSha), {
      timeoutMs: 30_000,
      pollMs: 50,
      purpose: 'integration',
    });
  }

  private integrateLocked(
    nodeId: string,
    repository: string,
    expectedSha: string | undefined,
  ): { sha: string; branch: string; strategy: IntegrateResult['strategy'] } {
    const repoPath = repositoryPath(this.workspace, repository);
    const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === repository);
    const branch = integrationBranchName(this.featureId);
    const trust = { graph: this.graph(), state: this.state() };
    try {
      trustedIntegrationHead(this.workspace, this.featureId, repository, trust);
    } catch (err) {
      // An integration that died after moving the branch: only the exact
      // commit it journaled, from the head it started at, for this node's
      // verified commit.
      const pending = trust.state.pending_integrations?.[repository];
      const resumable =
        err instanceof IntegrationBranchMovedError &&
        pending !== undefined &&
        expectedSha !== undefined &&
        pending.node_id === nodeId &&
        pending.verified_sha === expectedSha &&
        pending.from === err.expected &&
        resolveRef(repoPath, branch) === pending.to;
      if (!resumable) throw err;
      return this.recordIntegration(nodeId, repository, pending.to, pending.strategy, true);
    }
    const plan = planIntegration({
      repoPath,
      featureId: this.featureId,
      nodeBranch: workerBranchName(this.featureId, nodeId),
      baseBranch: repoDecl?.base_branch ?? 'main',
      integrationRoot: this.workspace.paths.integrationDir,
      repositoryName: repository,
      ...(expectedSha !== undefined ? { expectedSha } : {}),
    });
    // The plan starts where the controller left the branch, or nowhere.
    const expected = expectedIntegrationHead(this.workspace, repository, trust);
    if (plan.from !== expected) throw new IntegrationBranchMovedError(repository, branch, plan.from, expected);
    if (plan.strategy !== 'already-integrated') {
      // Never a last-writer-wins (CSET-201 final): what the integration head holds of every sibling's standing proof, the
      // integrated commit holds too.
      const lost = this.progressLost(nodeId, repository, plan.from, plan.to);
      if (lost.length > 0) throw new SiblingProgressLostError(nodeId, lost, plan.from, plan.to);
      const journal: PendingIntegration = { node_id: nodeId, verified_sha: plan.nodeSha, from: plan.from, to: plan.to, strategy: plan.strategy };
      mutateState(this.paths.featureDir, (s) => {
        s.pending_integrations = { ...(s.pending_integrations ?? {}), [repository]: journal };
        return s;
      });
      this.fault('integration-journaled');
      applyIntegration(plan);
      this.fault('integration-moved');
    }
    return this.recordIntegration(nodeId, repository, plan.to, plan.strategy, false);
  }

  private recordIntegration(
    nodeId: string,
    repository: string,
    sha: string,
    strategy: IntegrateResult['strategy'],
    resumed: boolean,
  ): { sha: string; branch: string; strategy: IntegrateResult['strategy'] } {
    mutateState(this.paths.featureDir, (s) => {
      // The heads a review and a candidate bind moved: the epoch moves with them (once per integration recorded).
      if (s.integration_heads?.[repository] !== sha) bumpEpoch(s, `integrate ${nodeId} into ${repository} at ${sha.slice(0, 12)}`);
      s.integration_heads = { ...(s.integration_heads ?? {}), [repository]: sha };
      if (s.pending_integrations?.[repository] !== undefined) {
        const { [repository]: _done, ...rest } = s.pending_integrations;
        if (Object.keys(rest).length > 0) s.pending_integrations = rest;
        else delete s.pending_integrations;
      }
      return s;
    });
    this.event('node.integrated', nodeId, { repository, sha, strategy, ...(resumed ? { resumed: true } : {}) });
    return { sha, branch: integrationBranchName(this.featureId), strategy };
  }

  // ---- one node attempt -------------------------------------------------

  async runNode(nodeId: string): Promise<NodeRunReport> {
    const node = this.node(nodeId);
    const started = Date.now();
    const evidence: EvidenceRecord[] = [];
    let sessionId: string | null = null;

    // Deterministic node types are executed by the controller itself. There is
    // nothing for a model to decide about cutting a candidate or running a
    // scenario shard, and a worker session would only add cost and risk.
    if (node.node_type === 'candidate-build') return this.runCandidateNode(nodeId);
    if (node.node_type === 'e2e-scenario') return await this.runE2ENode(nodeId);
    if (node.node_type === 'verification') return this.runVerificationNode(nodeId);

    const adapter = this.adapterReady();
    if (!adapter.ok) {
      // Found before anything was claimed: an environment problem, not the node's.
      return this.report(nodeId, 'INFRASTRUCTURE_FAILURE', null, `ADAPTER_UNAVAILABLE: ${adapter.detail ?? 'unavailable'}`, evidence);
    }

    try {
      const { claimId, capability, worktree, branch } = this.claim(nodeId, { mode: 'adapter' });
      const packPath = this.writeContextPack(nodeId, claimId);
      const attempt = this.state().nodes[nodeId]?.attempts ?? 1;

      const sessionDir = join(this.paths.sessionsDir, nodeId.replace(/[^\w.-]/g, '_'));
      mkdirSync(sessionDir, { recursive: true });

      const previous = liveSessions(this.paths.sessionsRegistry).find((s) => s.node_id === nodeId);

      const request: SpawnRequest = {
        featureId: this.featureId,
        nodeId,
        claimId,
        attempt,
        contextPackPath: packPath,
        cwd: worktree ?? this.controlRoot,
        resultPath: join(sessionDir, `result.attempt-${attempt}.json`),
        logPath: join(sessionDir, `session.attempt-${attempt}.log`),
        model: node.worker.model,
        maxTurns: node.worker.max_turns,
        maxWallClockMs: Math.min(
          node.worker.max_wall_clock_minutes * 60_000,
          this.workspace.config.session_timeout_ms,
        ),
        stallMs: Math.max(30_000, Math.floor(node.worker.max_wall_clock_minutes * 60_000 * 0.4)),
        gateCommands: this.gateCommands(nodeId, capability),
        env: {
          MYCELINK_CONTROL_ROOT: this.controlRoot,
          MYCELINK_BRANCH: branch ?? '',
          [CAPABILITY_ENV]: capability,
          ...this.workerEnv,
        },
        replacesSessionId: previous?.session_id ?? null,
      };

      const handle = this.adapter.spawn(request);
      sessionId = handle.session_id;
      recordSpawn(this.paths.sessionsRegistry, handle, {
        featureId: this.featureId,
        repository: node.repository,
        worktree,
        branch,
        attempt,
        replacesSessionId: previous?.session_id ?? null,
      });
      if (previous) markTerminal(this.paths.sessionsRegistry, previous.session_id, 'stopped');

      const observation = await this.adapter.wait(handle);
      recordObservation(this.paths.sessionsRegistry, handle.session_id, observation);

      if (isInfrastructureFailure(observation.failure_reason)) {
        // No worker ever ran: hand the claim back unspent and stop, rather
        // than charging the node and blocking it after two identical tries.
        this.releaseForInfrastructure(nodeId, claimId, observation.failure_reason ?? 'SPAWN_FAILED');
        return this.report(nodeId, 'INFRASTRUCTURE_FAILURE', sessionId, observation.failure_reason ?? 'SPAWN_FAILED', evidence);
      }

      mutateState(this.paths.featureDir, (s) => accumulateUsage(s, nodeId, observation.usage));

      appendRun(this.paths.runs, {
        attempt_id: `${nodeId}#${attempt}`,
        idempotency_key: `${nodeId}#${attempt}#${handle.session_id}`,
        loop_id: `node-agent:${nodeId}`,
        parent_loop_id: `feature-orchestration:${this.featureId}`,
        node_id: nodeId,
        candidate_sha: null,
        input_hash: createHash('sha256').update(readFileSync(packPath)).digest('hex').slice(0, 16),
        started_at: new Date(started).toISOString(),
        finished_at: new Date().toISOString(),
        model_turns: observation.turns,
        usage: observation.usage,
        wall_clock_ms: observation.usage.wall_clock_ms,
        commands: (observation.result?.commands ?? []).map((c) => c.command.join(' ')),
        exit_codes: (observation.result?.commands ?? []).map((c) => c.exit_code),
        failure_fingerprint: observation.result?.failure_fingerprint ?? observation.failure_reason,
        evidence_paths: observation.result?.evidence_paths ?? [],
        transition: observation.status,
      });

      return this.concludeAttempt(
        nodeId,
        sessionId,
        { status: observation.status, result: observation.result, failureReason: observation.failure_reason },
        evidence,
      );
    } catch (err) {
      if (err instanceof InjectedFault) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof ResourceBusyError || err instanceof NotSchedulableError) {
        // Nothing was claimed (or the claim was already released): no failure.
        return this.report(nodeId, 'RETRY', sessionId, detail, evidence);
      }
      if (err instanceof ClaimSetupError) {
        // The claim was released with its attempt refunded by claim() itself.
        return this.report(nodeId, 'INFRASTRUCTURE_FAILURE', sessionId, detail, evidence);
      }
      if (err instanceof GraphDriftError || err instanceof ModuleDriftError || err instanceof AcceptanceDriftError) {
        // Refused before anything was claimed.
        return this.report(nodeId, 'PRECONDITION_FAILED', sessionId, detail, evidence);
      }
      if (err instanceof WorktreeSetupError) {
        // The worktree could not be set up: released unspent by claim(), no worker started.
        return this.report(nodeId, 'PRECONDITION_FAILED', sessionId, detail, evidence);
      }
      if (err instanceof ReworkBriefError) {
        // Refused before the claim: nothing was charged, and nothing runs on it.
        return this.report(nodeId, 'PRECONDITION_FAILED', sessionId, detail, evidence);
      }
      return this.failAttempt(nodeId, sessionId, detail, evidence);
    }
  }

  // ---- concluding an attempt ---------------------------------------------

  /**
   * Act on how a worker attempt ended. Shared by the adapter path (runNode)
   * and the host-dispatch path (settle): a parking outcome parks the node, a
   * failure is recorded under its fingerprint, and only a submission goes on
   * to {@link finalizeVerified}. Nothing the worker says is believed beyond
   * which of those roads to take.
   */
  concludeAttempt(
    nodeId: string,
    sessionId: string | null,
    outcome: AttemptOutcome,
    evidence: EvidenceRecord[] = [],
  ): NodeRunReport {
    const result = outcome.result;

    // A ticket of an order bound to an older revision of its review (CSET-203 r14: STATE.json written before review
    // revisions): its answer is never judged. The order is reconciled — rebased, the same generation reissued from where it
    // stands, or (its gaps changed) handed back unspent and replaced — and nothing is charged.
    if (result !== null) {
      const stale = this.orderStaleness(this.state(), nodeId);
      if (stale !== null) return this.reconcileStaleClaim(nodeId, sessionId, stale, result);
    }

    // Each criterion of the order answered on its own (CSET-203 r15): judged one by one, never one outcome for all.
    if (result !== null && result.outcome === 'CRITERIA') return this.concludeCriteria(nodeId, sessionId, result, evidence);

    // A legacy answer whose red gate passed every test it declared, in an acceptance review's rework (CSET-203 r7): a
    // challenge opportunity, once per claim — the claim held, nothing charged, the next generation asked for the
    // structured challenge. Never a challenge inferred: its worker writes it, each clause traced to its assertions.
    if (result !== null && this.challengeConversionDue(nodeId, result)) return this.holdForChallenge(nodeId, sessionId, result, evidence);

    // A review gap whose exact reproduction passed on the unchanged head is challenged, never a parked node (CSET-203 r6):
    // r6's own answer (BLOCKED REVIEW_GAP_NOT_REPRODUCED) is a challenge with no structure, refused as one.
    if (result !== null && (result.outcome === 'REVIEW_GAP_CHALLENGE' || this.legacyChallenge(nodeId, result))) {
      return this.concludeChallenge(nodeId, sessionId, result, evidence);
    }

    if (outcome.status === 'needs-decision' && result?.decision_request) {
      this.recordDecisionRequest(nodeId, result);
      this.transition(nodeId, 'NEEDS_DECISION', {
        reason: result.decision_request.question.slice(0, 300),
      });
      this.releaseClaim(nodeId);
      return this.report(nodeId, 'NEEDS_DECISION', sessionId, result.decision_request.question, evidence);
    }

    if (outcome.status === 'budget-exhausted') {
      this.transition(nodeId, 'BUDGET_EXHAUSTED', {
        reason: outcome.failureReason ?? 'worker budget exhausted',
      });
      this.releaseClaim(nodeId);
      return this.report(nodeId, 'BUDGET_EXHAUSTED', sessionId, outcome.failureReason ?? '', evidence);
    }

    // A correction generation of a held submission that gave up without changing anything (r1's
    // CRITERION_UNPROVEN:AC-4) spends a correction, never a product attempt.
    const hold = this.state().nodes[nodeId]?.claim?.evidence_correction ?? null;
    if (hold && outcome.status === 'failed' && this.branchHead(nodeId) === hold.commit_sha) {
      return this.unprovenCorrection(nodeId, sessionId, result?.failure_fingerprint ?? outcome.failureReason ?? `CRITERION_UNPROVEN:${hold.criterion ?? 'evidence'}`, evidence);
    }

    // Inside an approved rework, a worker that could not write a RED made a
    // mistake the brief tells it how to fix; it did not find a blocker. The
    // attempt is a recorded failure under one stable fingerprint, so a retry
    // stays inside the generation's allowance and the same mistake again
    // parks the node (max_same_failure).
    const fingerprint = result?.failure_fingerprint ?? outcome.failureReason ?? null;
    if (
      (outcome.status === 'blocked' || outcome.status === 'failed') &&
      fingerprint !== null &&
      fingerprint.startsWith(INVALID_RED_FINGERPRINT) &&
      (this.state().nodes[nodeId]?.rework_brief ?? null) !== null
    ) {
      return this.failAttempt(nodeId, sessionId, INVALID_RED_FINGERPRINT, evidence);
    }

    // A BLOCKED answer that only an identity-shape refusal caused (PCM-101 final: the visits worker's `tdd check` refused every Java
    // test by the old comparison, and it answered BLOCKED with its work committed): a submission, settled as one — never parked.
    if (outcome.status === 'blocked' && result !== null) {
      // Already found so for exactly this answer (a reopened claim, or a settlement interrupted after it was judged): finished as the
      // submission it was settled as — fresh verification may have replaced the gate records its evidence named since.
      const live = this.state().nodes[nodeId]?.claim ?? null;
      const marked = live?.identity_reconcile ?? null;
      if (marked !== null && marked.cause === 'worker-blocked' && live !== null && marked.result_sha256 === live.result_captured_sha256) return this.finalizeVerified(nodeId, sessionId, evidence, { ...result, outcome: 'SUBMITTED' });
      const submitted = this.identityBlockedSubmission(nodeId, result);
      if (submitted !== null) return this.settleIdentityBlocked(nodeId, sessionId, result, submitted, evidence);
    }

    if (outcome.status === 'blocked') {
      this.transition(nodeId, 'BLOCKED', {
        reason: result?.failure_fingerprint ?? outcome.failureReason ?? 'worker blocked',
      });
      this.releaseClaim(nodeId);
      return this.report(nodeId, 'BLOCKED', sessionId, outcome.failureReason ?? 'blocked', evidence);
    }

    if (outcome.status !== 'done' || result === null) {
      return this.failAttempt(
        nodeId,
        sessionId,
        result?.failure_fingerprint ?? outcome.failureReason ?? 'WORKER_FAILED',
        evidence,
      );
    }

    return this.finalizeVerified(nodeId, sessionId, evidence, result);
  }


  // ---- identity-shape refusals, re-evaluated administratively (PCM-101 final) --------------------------------

  /**
   * A BLOCKED answer that names an identity refusal (CRITERION_TEST_UNKNOWN or _AMBIGUOUS), judged as settle will judge a
   * submission — its history and criterion evidence, by the canonical identity (evidence/test-identity.ts), read-only — at exactly the
   * head its branch is at, which it must name. Its accepted criteria when they hold and at least one test of them is a JUnit name the
   * old, runner-incompatible comparison could not have matched: the refusal was the identity's shape, never the work's. Else null.
   */
  private identityBlockedJudgement(nodeId: string, result: NodeResult, runtime: NodeRuntime, ctx: { policy: TddPolicy; base: string | null; modulePath: string | null }): { code: string; accepted: AcceptedCriterionRecord[] } | null {
    const code = /^(CRITERION_TEST_(?:UNKNOWN|AMBIGUOUS))\b/.exec(result.failure_fingerprint ?? '')?.[1] ?? null;
    const node = this.node(nodeId);
    if (code === null || result.outcome !== 'BLOCKED' || node.repository === null || ctx.base === null || (result.criterion_evidence ?? []).length === 0) return null;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    const head = branchExists(repoPath, branch) ? resolveRef(repoPath, branch) : null;
    if (head === null || result.commit_sha !== head) return null;
    const history = verifyTddHistory({
      repoPath,
      base: ctx.base,
      head,
      policy: ctx.policy,
      bindings: runtime.tdd_red_bindings ?? [],
      requireRed: node.required_evidence.includes('red'),
      declarationsOnly: !node.required_evidence.includes('red') && node.node_type !== 'refactor',
      compatibility: { criteria: this.compatibilityCriteria(nodeId) },
      claimed: result.tdd ?? null,
    });
    if (!history.ok) return null;
    const judged = judgeCriteria({ controlRoot: this.controlRoot, featureId: this.featureId, graph: this.graph(), node, runtime, evidence: result.criterion_evidence, repoPath, head, policy: ctx.policy, modulePath: ctx.modulePath, compatibility: history.compatibility });
    if (!judged.ok) return null;
    const translated = judged.accepted.some((a) => a.identity?.runner === 'junit' && a.test !== null && a.test.name !== a.identity.key);
    return translated ? { code, accepted: judged.accepted } : null;
  }

  /** A live host claim's captured BLOCKED answer that only an identity-shape refusal caused (identityBlockedJudgement), or null. */
  private identityBlockedSubmission(nodeId: string, result: NodeResult): { code: string } | null {
    const rt = this.state().nodes[nodeId];
    const claim = rt?.claim ?? null;
    const node = this.node(nodeId);
    if (rt === undefined || claim === null || claim.mode !== 'host' || claim.result_captured_sha256 === undefined || node.repository === null) return null;
    const judged = this.identityBlockedJudgement(nodeId, result, rt, { policy: claim.tdd_policy ?? this.claimTddPolicy(node.repository), base: claim.base_sha ?? rt.branch_base_sha ?? null, modulePath: claim.verification?.path ?? null });
    return judged === null ? null : { code: judged.code };
  }

  /**
   * Settle a BLOCKED answer only an identity-shape refusal caused as the submission it is: finalizeVerified judges it in full at its
   * sealed head. Its claim is marked first, bound to the answer's exact controller copy, so the receipt written once its evidence is
   * accepted says what was re-evaluated and why. Nothing is charged for the refusal, and no worker is asked to correct anything.
   */
  private settleIdentityBlocked(nodeId: string, sessionId: string | null, result: NodeResult, submitted: { code: string }, evidence: EvidenceRecord[]): NodeRunReport {
    const claim = this.state().nodes[nodeId]?.claim as NodeClaim;
    if ((claim.identity_reconcile ?? null) === null) {
      const marker: IdentityReconcile = {
        cause: 'worker-blocked',
        refused: { code: submitted.code, detail: (result.failure_fingerprint ?? submitted.code).slice(0, 500) },
        fingerprint: result.failure_fingerprint ?? null,
        result_file: claim.result_captured_file ?? '',
        result_sha256: claim.result_captured_sha256 ?? '',
        from_dispatch_id: claim.result_captured_dispatch_id ?? claim.dispatch_id ?? null,
        at: new Date().toISOString(),
      };
      mutateState(this.paths.featureDir, (s) => {
        const c = s.nodes[nodeId]?.claim;
        if (c?.claim_id === claim.claim_id) c.identity_reconcile = marker;
        return s;
      });
    }
    return this.finalizeVerified(nodeId, sessionId, evidence, { ...result, outcome: 'SUBMITTED' });
  }

  /**
   * A node a core before this repair parked for an identity-shape refusal (PCM-101 final: visits BLOCKED by its own answer, its
   * attempt spent, its work committed): the controller copy of that answer — the one its last settlement recorded by hash, or
   * (recorded before the hash was) the single copy of its claim and dispatch — that still validates, names exactly the refusal the
   * node was parked for, commits its branch's head and holds by the canonical identity, its module unchanged. Null otherwise: a
   * person decides, as before.
   */
  private parkedIdentityCandidate(nodeId: string, state: FeatureState_ = this.state()): { file: string; sha256: string; result: NodeResult; last: SettlementReceipt; code: string } | null {
    const rt = state.nodes[nodeId];
    const node = this.graph().nodes.find((n) => n.id === nodeId);
    const last = rt?.last_settlement ?? null;
    if (rt === undefined || node === undefined || node.repository === null || CONTROLLER_NODE_TYPES.has(node.node_type) || node.node_type === 'verification') return null;
    if (rt.state !== 'BLOCKED' || rt.claim !== null || last === null || last.outcome !== 'BLOCKED' || typeof last.dispatch_id !== 'string') return null;
    if (!/^CRITERION_TEST_(?:UNKNOWN|AMBIGUOUS)\b/.test(rt.blocked_reason ?? '')) return null;
    const dir = join(this.paths.sessionsDir, safeNodeDir(nodeId));
    let file: string;
    let recorded: string | null = null;
    if (typeof last.result_file === 'string' && last.result_file !== '' && typeof last.result_sha256 === 'string') {
      file = last.result_file;
      recorded = last.result_sha256;
    } else {
      const prefix = `result.${last.dispatch_id}.`;
      const copies = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix) && /^[0-9a-f]{32}\.json$/.test(f.slice(prefix.length))) : [];
      if (copies.length !== 1) return null;
      file = copies[0] as string;
    }
    if (file.includes('/') || file.includes('\\')) return null;
    const result = readControllerCopy(join(dir, file), recorded, nodeId, last.claim_id, last.dispatch_id);
    if (result === null || result.outcome !== 'BLOCKED' || (result.failure_fingerprint ?? null) !== rt.blocked_reason) return null;
    // The module its gates ran is still the one a claim binds: else the claim would bind another, and settle refuse its gates.
    const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === node.repository);
    let binding: ClaimVerification | null;
    try {
      binding = repoDecl !== undefined ? claimVerificationFor(nodeId, node.verification_commands[0], repoDecl) : null;
    } catch {
      return null;
    }
    for (const kind of ['red', 'green'] as const) {
      const r = rt.evidence[kind];
      if (r !== undefined && binding !== null && (r.module_sha256 !== binding.module_sha256 || r.plan_sha256 !== binding.plan_sha256)) return null;
    }
    const judged = this.identityBlockedJudgement(nodeId, result, rt, { policy: this.claimTddPolicy(node.repository), base: rt.branch_base_sha ?? null, modulePath: binding?.path ?? null });
    if (judged === null) return null;
    return { file, sha256: sha256OfFile(join(dir, file)), result, last, code: judged.code };
  }

  /**
   * Reopen each node a core before this repair parked for an identity-shape refusal (parkedIdentityCandidate) and settle its captured
   * answer administratively: in one state write it leaves BLOCKED (a recorded input change — the identity it was refused by is not
   * the one it is judged by now), its attempts and failures as they stood; then the same claim id is claimed again — its answer names
   * it — with that answer captured and its usage already counted, and the settlement concludes it as a settle would have: no worker,
   * no attempt, no correction. A node that cannot be claimed now is parked again exactly as it was.
   */
  private reconcileParkedIdentity(): SettleReport[] {
    const reports: SettleReport[] = [];
    const graph = this.graph();
    for (const n of graph.nodes) {
      const found = this.parkedIdentityCandidate(n.id);
      if (found === null) continue;
      const before = structuredClone(this.state().nodes[n.id] as NodeRuntime);
      const marker: IdentityReconcile = {
        cause: 'worker-blocked',
        refused: { code: found.code, detail: (found.result.failure_fingerprint ?? found.code).slice(0, 500) },
        fingerprint: found.result.failure_fingerprint ?? null,
        result_file: found.file,
        result_sha256: found.sha256,
        from_dispatch_id: found.last.dispatch_id ?? null,
        at: new Date().toISOString(),
      };
      try {
        mutateState(this.paths.featureDir, (s) => {
          const rt = s.nodes[n.id];
          if (rt === undefined || rt.state !== 'BLOCKED' || rt.claim !== null) return s;
          const next = applyNodeTransition(graph, s, n.id, 'READY', { actor: this.owner, inputChanged: true, reason: `IDENTITY_RECONCILED: ${found.code} was an identity-shape refusal; judged by ${TEST_IDENTITY_VERSION}, its captured answer is settled again` });
          const r = next.nodes[n.id] as NodeRuntime;
          // The attempt it spent stands as it was: claiming it again counts no other.
          r.attempts = Math.max(0, before.attempts - 1);
          r.failure_counts = { ...before.failure_counts };
          r.last_failure_fingerprint = before.last_failure_fingerprint;
          return next;
        });
        this.claim(n.id, { mode: 'host', claimId: found.last.claim_id });
      } catch (err) {
        if (err instanceof InjectedFault) throw err;
        // Not claimable now: parked again exactly as it was, for a later dispatch or a person.
        mutateState(this.paths.featureDir, (s) => {
          const rt = s.nodes[n.id];
          if (rt === undefined || rt.claim !== null) return s;
          s.nodes[n.id] = { ...rt, state: 'BLOCKED', attempts: before.attempts, failure_counts: { ...before.failure_counts }, last_failure_fingerprint: before.last_failure_fingerprint, blocked_reason: before.blocked_reason, updated_at: new Date().toISOString() };
          return s;
        });
        this.event('node.identity_reconcile_deferred', n.id, { detail: errorText(err).slice(0, 300) });
        continue;
      }
      mutateState(this.paths.featureDir, (s) => {
        const c = s.nodes[n.id]?.claim;
        if (c?.claim_id !== found.last.claim_id) return s;
        c.result_captured_sha256 = found.sha256;
        c.result_captured_file = found.file;
        c.result_captured_dispatch_id = found.last.dispatch_id as string;
        // Its worker's usage was counted when its answer was settled the first time.
        c.usage_counted_for = found.last.dispatch_id as string;
        c.identity_reconcile = marker;
        return s;
      });
      this.event('node.identity_reopened', n.id, { claim_id: found.last.claim_id, dispatch_id: found.last.dispatch_id ?? null, result_sha256: found.sha256, code: found.code });
      this.fault('identity-reopened');
      try {
        reports.push(this.completeSettlement(n.id, 'dispatch'));
      } catch (err) {
        if (err instanceof SettleInProgressError) continue;
        throw err;
      }
    }
    return reports;
  }

  /**
   * A held submission judged before canonical identities whose refusal was a test's identity (CRITERION_TEST_UNKNOWN or _AMBIGUOUS)
   * and whose captured answer is still the held one: judged again once, administratively, before anyone is asked to correct it.
   */
  private identityReconcilableHold(claim: NodeClaim): boolean {
    const hold = claim.evidence_correction ?? null;
    return hold !== null && claim.mode === 'host' && (hold.code === 'CRITERION_TEST_UNKNOWN' || hold.code === 'CRITERION_TEST_AMBIGUOUS') && (hold.identity_version ?? null) !== TEST_IDENTITY_VERSION && claim.result_captured_sha256 !== undefined && hold.result_sha256 === claim.result_captured_sha256;
  }

  /** Mark a held claim for its administrative re-evaluation, bound to the held answer's controller copy. */
  private markHoldReconcile(nodeId: string): void {
    mutateState(this.paths.featureDir, (s) => {
      const c = s.nodes[nodeId]?.claim;
      const hold = c?.evidence_correction ?? null;
      if (!c || hold === null || (c.identity_reconcile ?? null) !== null) return s;
      c.identity_reconcile = { cause: 'evidence-correction', refused: { code: hold.code, detail: hold.detail.slice(0, 500) }, fingerprint: null, result_file: c.result_captured_file ?? '', result_sha256: c.result_captured_sha256 ?? '', from_dispatch_id: c.result_captured_dispatch_id ?? c.dispatch_id ?? null, at: new Date().toISOString() };
      return s;
    });
  }

  /** Where a node's identity receipts go: its aliases and reconciliations. */
  private identityDir(nodeId: string): string {
    return join(nodeEvidenceDir(this.controlRoot, this.featureId, nodeId), 'identity');
  }

  /** Each alias of `accepted` (a test published before identities) written as its immutable receipt, the record pointing at it. */
  private receiptAliases(nodeId: string, accepted: AcceptedCriterionRecord[], claimId: string | null): AcceptedCriterionRecord[] {
    return accepted.map((a) => {
      if (a.identity_alias == null || (a.identity_alias.receipt ?? null) !== null) return a;
      const { receipt: _receipt, ...alias } = a.identity_alias;
      const body = { ...alias, feature_id: this.featureId, node_id: nodeId, claim_id: claimId, criterion: a.criterion, gate: a.gate, output_sha256: a.output_sha256 };
      mkdirSync(this.identityDir(nodeId), { recursive: true });
      const stored = writeImmutable(this.identityDir(nodeId), 'alias', '.json', JSON.stringify(body, null, 2) + '\n');
      return { ...a, identity_alias: { ...a.identity_alias, receipt: { path: (relativeInside(this.controlRoot, stored.file) ?? stored.file).replace(/\\/g, '/'), sha256: stored.sha256 } } };
    });
  }

  /**
   * The receipt of an administrative re-evaluation (immutable, content-addressed, the same bytes however often it is written): what
   * was refused and under which identity, the exact answer re-evaluated, the head, and how each criterion's test is named by the
   * canonical identity now — nothing charged.
   */
  private writeIdentityReconciliation(nodeId: string, claimId: string, marker: IdentityReconcile, head: string, accepted: readonly AcceptedCriterionRecord[]): { path: string; sha256: string } {
    const body = {
      schema: 'mycelink-identity-reconciliation/1',
      feature_id: this.featureId,
      node_id: nodeId,
      claim_id: claimId,
      cause: marker.cause,
      identity_version: TEST_IDENTITY_VERSION,
      refused: marker.refused,
      fingerprint: marker.fingerprint,
      result: { file: marker.result_file, sha256: marker.result_sha256, dispatch_id: marker.from_dispatch_id },
      head_sha: head,
      criteria: accepted.map((a) => ({ criterion: a.criterion, gate: a.gate, test_id: a.test_id, raw: a.test?.name ?? null, identity: a.identity ?? null, alias: a.identity_alias?.receipt ?? null })),
      charged: { product_attempt: false, worker_dispatch: false, correction: false },
      at: marker.at,
    };
    mkdirSync(this.identityDir(nodeId), { recursive: true });
    const stored = writeImmutable(this.identityDir(nodeId), 'reconciliation', '.json', JSON.stringify(body, null, 2) + '\n');
    return { path: (relativeInside(this.controlRoot, stored.file) ?? stored.file).replace(/\\/g, '/'), sha256: stored.sha256 };
  }

  // ---- a review gap challenged ---------------------------------------------

  /**
   * Whether a worker's answer is a challenge opportunity to convert (once per
   * claim): a host dispatch in an acceptance review's rework answered BLOCKED
   * or RETRYABLE with REVIEW_GAP_NOT_REPRODUCED or INVALID_RED_EVIDENCE (the
   * behaviour already present), while its last red gate passed every test it
   * declared on the unchanged base (claim.challenge_red, that gate's output
   * still the node's red evidence) — the material of a challenge, which only
   * the worker can complete with its assertions.
   */
  private challengeConversionDue(nodeId: string, result: NodeResult): boolean {
    const rt = this.state().nodes[nodeId];
    const claim = rt?.claim ?? null;
    if (rt === undefined || claim === null || claim.mode !== 'host' || rt.rework_brief?.origin?.kind !== 'acceptance-review') return false;
    if ((claim.challenge_conversion ?? null) !== null) return false;
    // The claim's last red gate (each red gate clears it): its declared tests all passed. Its record stays the node's RED, or
    // its own copy stands for it — a refused run never displaces the generation's RED (engine/criterion-ledger.ts).
    if (result.outcome !== 'BLOCKED' && result.outcome !== 'RETRYABLE') return false;
    // A current passing reproduction capsule of the claim (CSET-203 r17): whatever the worker said of it — r17's
    // REVIEW_REPRODUCTION_PASSES_BUT_REPROOF_UNCHECKABLE, CRITERION_TEST_UNKNOWN, NO_DECLARED_TESTS, GATE_UNKNOWN — it is
    // the material of a challenge the worker is asked for once, never a blocker charged.
    if (this.passingCapsuleOf(nodeId) !== null) return true;
    const snapshot = claim.challenge_red ?? null;
    if (snapshot === null || (rt.evidence.red?.output_sha256 !== snapshot.evidence_sha256 && snapshot.gate === undefined) || snapshot.red_tests.length === 0 || snapshot.red_tests.some((t) => t.status !== 'passed')) return false;
    const fingerprint = result.failure_fingerprint ?? '';
    return /^REVIEW_GAP_NOT_REPRODUCED\b/.test(fingerprint) || /^INVALID_RED_EVIDENCE\b/.test(fingerprint);
  }

  /** The claim's newest current passing reproduction capsule of an ordered new-behaviour criterion, or null. */
  private passingCapsuleOf(nodeId: string): CapsuleReceipt | null {
    const rt = this.state().nodes[nodeId];
    const claim = rt?.claim ?? null;
    if (rt === undefined || claim === null) return null;
    for (const e of [...(claim.capsules ?? [])].reverse()) {
      if (e.result !== 'passed') continue;
      const used = capsuleUse({ controlRoot: this.controlRoot, featureId: this.featureId, nodeId, runtime: rt, capsuleId: e.capsule_id, capsuleSha256: e.capsule_sha256, criterion: null, want: 'passed' });
      if (used.ok) return used.capsule;
    }
    return null;
  }

  /**
   * Hold the claim for the structured challenge its worker should have
   * written (CSET-203 r7): no attempt charged, no failure counted, nothing
   * integrated; the slot is cleared and dispatch hands the next generation
   * the request (reissueForChallenge). Its answer is judged as any: a valid
   * challenge, a RED that fails after all, or — answered the old way again —
   * the refusal it always was. Once per claim.
   */
  private holdForChallenge(nodeId: string, sessionId: string | null, result: NodeResult, evidence: EvidenceRecord[]): NodeRunReport {
    const claim = this.state().nodes[nodeId]?.claim as NodeClaim;
    const capsule = this.passingCapsuleOf(nodeId);
    const snapshot = claim.challenge_red ?? null;
    const gateSha = capsule !== null ? capsule.run.output_sha256 : (snapshot as NonNullable<NodeClaim['challenge_red']>).evidence_sha256;
    const tests = capsule !== null ? capsule.tests.map((t) => t.id) : (snapshot as NonNullable<NodeClaim['challenge_red']>).red_tests.map((t) => t.id);
    const fingerprint = (result.failure_fingerprint ?? `WORKER_${result.outcome}`).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
    const at = new Date().toISOString();
    mutateState(this.paths.featureDir, (s) => {
      const c = s.nodes[nodeId]?.claim;
      if (c?.claim_id !== claim.claim_id) return s;
      c.challenge_conversion = { fingerprint, from_dispatch_id: c.dispatch_id ?? null, result_sha256: c.result_captured_sha256 ?? '', gate_output_sha256: gateSha, ...(capsule !== null ? { capsule_id: capsule.capsule_id } : {}), at };
      return s;
    });
    if (claim.worktree !== null) prepareResultSlot(claim.worktree, claim.result_file ?? WORKER_RESULT_FILE);
    this.event('node.challenge_requested', nodeId, { claim_id: claim.claim_id, dispatch_id: claim.dispatch_id ?? null, fingerprint, gate_output_sha256: gateSha, tests, ...(capsule !== null ? { capsule_id: capsule.capsule_id } : {}) });
    const criteria = (this.state().nodes[nodeId]?.rework_brief?.acceptance_criteria ?? []).join(', ');
    const material = capsule !== null ? `its reproduction capsule ${capsule.capsule_id} (${capsule.criterion}) passed on the unchanged base` : `the red gate (output ${gateSha.slice(0, 12)}) passed every test it declared on the unchanged base`;
    return this.report(
      nodeId,
      'CHALLENGE_REQUIRED',
      sessionId,
      `CHALLENGE_REQUIRED: ${fingerprint.slice(0, 200)} — but ${material}: in this acceptance review's rework of ${criteria} that is a review-gap challenge to submit, not a blocker. No attempt charged; the claim is held, and dispatch hands the next generation the request for the structured challenge (once).`,
      evidence,
    );
  }

  /** r6's answer to a review gap whose reproduction passed: BLOCKED (or RETRYABLE) REVIEW_GAP_NOT_REPRODUCED in a review's rework. */
  private legacyChallenge(nodeId: string, result: NodeResult): boolean {
    return (result.outcome === 'BLOCKED' || result.outcome === 'RETRYABLE') && /^REVIEW_GAP_NOT_REPRODUCED\b/.test(result.failure_fingerprint ?? '') && this.state().nodes[nodeId]?.rework_brief?.origin?.kind === 'acceptance-review';
  }

  /**
   * A worker's challenge of a review's gap (engine/review-challenge.ts):
   * judged against its claim, the red gate's snapshot, the review's pinned
   * receipt and the repository. A refused one invents nothing: it is a
   * failed attempt under REVIEW_CHALLENGE_INVALID:<what>, the review as it
   * was. A valid one is recorded (acceptChallenge).
   */
  private concludeChallenge(nodeId: string, sessionId: string | null, result: NodeResult, evidence: EvidenceRecord[], form: CriteriaForm | null = null): NodeRunReport {
    // A per-criterion answer that proves nothing DONE: its challenge is judged per criterion (only the tests it cites must
    // have passed), and with no DONE criterion no production change at all is allowed.
    const judged = this.judgeChallengeOf(nodeId, result, form === null ? null : { done: [], doneRedTests: [], doneTests: [], cycles: [], bindings: this.state().nodes[nodeId]?.tdd_red_bindings ?? [] });
    if (!judged.ok && this.capsuleAdministrative(nodeId, judged) !== null) return this.holdForCapsule(nodeId, sessionId, judged, evidence);
    if (!judged.ok) {
      const fingerprint = challengeFingerprint(judged.code);
      this.event('review.challenge_refused', nodeId, { code: judged.code, detail: judged.detail.slice(0, 500), problems: judged.problems.slice(0, 12).map((p) => ({ code: p.code, pointer: p.pointer })) });
      const report = this.failAttempt(nodeId, sessionId, fingerprint, evidence);
      return { ...report, detail: `${fingerprint}: ${judged.code}: ${judged.detail}`.slice(0, 2000) };
    }
    return this.acceptChallenge(nodeId, sessionId, judged, evidence, form === null ? null : { done: [], unresolved: form.unresolved });
  }

  /**
   * A per-criterion answer (engine/criterion-outcomes.ts; CSET-203 r15). Its form against the order it answers first:
   * a malformed one is a failed attempt (CRITERIA_RESULT_INVALID:<what>), as any refused answer. Then by what it says:
   * nothing proved and nothing challenged parks the node, each criterion with its own reason (and question); nothing
   * proved is a challenge with no product work, judged so (no production change at all), the others kept as gaps;
   * something proved is finalized as the node's new generation, its challenged criteria recorded as one challenge beside
   * it and its unresolved ones ordered again on their own. One product attempt for the one execution, never one per
   * criterion; a valid answer is no failure and asks no person.
   */
  private concludeCriteria(nodeId: string, sessionId: string | null, result: NodeResult, evidence: EvidenceRecord[]): NodeRunReport {
    const rt = this.state().nodes[nodeId] as NodeRuntime;
    const form = criteriaForm({ result, brief: rt.rework_brief ?? null, graph: this.graph(), node: this.node(nodeId) });
    if (!form.ok || form.form === null) {
      const code = form.ok ? 'CRITERIA_RESULT_INVALID' : form.code;
      const detail = form.ok ? 'outcome CRITERIA answered nothing per criterion' : form.detail;
      const fingerprint = criteriaFingerprint(code);
      this.event('node.criteria_refused', nodeId, { code, criterion: form.ok ? null : form.criterion, detail: detail.slice(0, 500) });
      const report = this.failAttempt(nodeId, sessionId, fingerprint, evidence);
      return { ...report, detail: `${fingerprint}: ${code}: ${detail}`.slice(0, 2000) };
    }
    const f = form.form;
    if (f.done.length === 0 && f.challenged.length === 0) return this.parkUnresolved(nodeId, sessionId, f.unresolved, evidence);
    if (f.done.length === 0) return this.concludeChallenge(nodeId, sessionId, result, evidence, f);
    return this.finalizeVerified(nodeId, sessionId, evidence, result, f);
  }

  /**
   * Every ordered criterion unresolved: the node parked as a whole answer would park it — NEEDS_DECISION, each question
   * a recorded decision, when one asks a person, else BLOCKED — with each criterion's own reason.
   */
  private parkUnresolved(nodeId: string, sessionId: string | null, unresolved: UnresolvedCriterionRecord[], evidence: EvidenceRecord[]): NodeRunReport {
    const reason = unresolvedReason(unresolved);
    const criteria = unresolved.map((u) => ({ criterion: u.criterion, outcome: u.outcome }));
    const decide = unresolved.filter((u) => u.outcome === 'NEEDS_DECISION' && u.decision_request !== null);
    for (const u of decide) this.recordDecisionRequest(nodeId, { decision_request: criterionQuestion(u) } as NodeResult);
    this.transition(nodeId, decide.length > 0 ? 'NEEDS_DECISION' : 'BLOCKED', { reason: reason.slice(0, 300) });
    this.releaseClaim(nodeId);
    return { ...this.report(nodeId, decide.length > 0 ? 'NEEDS_DECISION' : 'BLOCKED', sessionId, reason, evidence), criteria };
  }

  /** The challenge a node's worker submitted, judged exactly as settle (and `tdd check`) judges it. */
  judgeChallengeOf(nodeId: string, result: NodeResult, answer: CriteriaChallengeContext | null = null): ({ ok: true } & JudgedChallenge) | ChallengeRefusal {
    const node = this.node(nodeId);
    const runtime = this.state().nodes[nodeId] as NodeRuntime;
    if (node.repository === null) return { ok: false, code: 'REVIEW_CHALLENGE_NOT_REVIEW_REWORK', detail: `${nodeId} has no repository`, problems: [] };
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    const head = branchExists(repoPath, branch) ? resolveRef(repoPath, branch) : '';
    const graph = this.graph();
    return judgeChallenge({
      controlRoot: this.controlRoot,
      featureId: this.featureId,
      graph,
      node,
      runtime,
      result,
      repoPath,
      repository: node.repository,
      head,
      policy: runtime.claim?.tdd_policy ?? this.claimTddPolicy(node.repository),
      reviews: this.state().acceptance_review?.reviews ?? [],
      criteria: reviewCriteria(this.controlRoot, this.featureId, graph),
      holdsAuthority: (text) => holdsControllerKey(this.controlRoot, text),
      answer,
    });
  }

  private acceptChallenge(nodeId: string, sessionId: string | null, judged: JudgedChallenge, evidence: EvidenceRecord[], partial: ReviewChallengeRecord['partial'] = null): NodeRunReport {
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'deliver.lock'), () => this.acceptChallengeLocked(nodeId, sessionId, judged, evidence, partial), { timeoutMs: 15_000, pollMs: 50, purpose: 'review-gap challenge' });
  }

  /**
   * A valid challenge, recorded: no product attempt charged. Its evidence is
   * archived under the review; its test-only commit (if any) kept under a
   * ref of its own, never integrated; the rework's worktree abandoned and
   * the node's branch put back where its replaced generation left it; in one
   * STATE.json write the node is DONE again on that generation (its
   * evidence, criteria, history, settlement and attempt baseline, the
   * evidence pointing at the copies the rework archived), the rework marked
   * challenged (it counts for nothing), the challenge recorded and the
   * review CHALLENGED: its gaps authorise nothing until a fresh reviewer
   * refines them. Past MAX_CHALLENGE_ROUNDS of one gap the review is blocked
   * REVIEW_DISPUTE instead, with the evidence of every round; the node stays
   * DONE, never BLOCKED.
   */
  private acceptChallengeLocked(nodeId: string, sessionId: string | null, judged: JudgedChallenge, evidence: EvidenceRecord[], partial: ReviewChallengeRecord['partial'] = null): NodeRunReport {
    const state = this.state();
    const rt = state.nodes[nodeId] as NodeRuntime;
    const claim = rt.claim as NodeClaim;
    const brief = rt.rework_brief as ReworkBrief;
    const review = this.requiredReview(state);
    const history = rt.rework_history ?? [];
    const entry = history[history.length - 1];
    const refuse = (detail: string): NodeRunReport => {
      const fingerprint = challengeFingerprint('REVIEW_CHALLENGE_NOT_REVIEW_REWORK');
      this.event('review.challenge_refused', nodeId, { code: 'REVIEW_CHALLENGE_NOT_REVIEW_REWORK', detail: detail.slice(0, 500), problems: [] });
      const report = this.failAttempt(nodeId, sessionId, fingerprint, evidence);
      return { ...report, detail: `${fingerprint}: ${detail}`.slice(0, 2000) };
    };
    if (review === null || entry === undefined || !stoodRework(entry) || (entry.restore ?? null) === null) {
      return refuse(`the rework ${nodeId}'s generation answers keeps no DONE generation to restore (a rework made before review-gap challenges existed); report the passing reproduction to the operator`);
    }
    const restored = this.restoredGeneration(entry);
    if ('problem' in restored) return refuse(restored.problem);
    const reviewId = judged.review.review_id;
    const prior = (review.challenges ?? []).filter((c) => c.review_id === reviewId);
    const id = challengeId(reviewId, prior.length + 1);
    const rounds: Record<string, number> = Object.fromEntries(judged.challenge.gaps.map((g) => [g.criterion, prior.filter((c) => c.gaps.some((x) => x.criterion === g.criterion)).length + 1]));
    const disputed = Object.values(rounds).some((n) => n > MAX_CHALLENGE_ROUNDS);
    const archived = archiveChallenge({
      controlRoot: this.controlRoot,
      featureId: this.featureId,
      id,
      judged,
      nodeId,
      claimId: claim.claim_id,
      dispatchId: claim.dispatch_id ?? null,
      generation: brief.generation,
      rounds,
      reasonSha256: brief.reason_sha256,
      partial,
    });
    this.fault('challenge-archived');
    const node = this.node(nodeId);
    const repoPath = repositoryPath(this.workspace, node.repository as string);
    // A test-only challenge commit is evidence: kept under its own ref, never integrated.
    if (judged.head_sha !== judged.base_sha) runGit(repoPath, ['update-ref', this.challengeRefName(nodeId, id), judged.head_sha]);
    const at = new Date().toISOString();
    const record: ReviewChallengeRecord = {
      challenge_id: id,
      review_id: reviewId,
      node_id: nodeId,
      status: disputed ? 'disputed' : 'pending',
      gaps: judged.challenge.gaps.map((g) => ({ criterion: g.criterion, round: rounds[g.criterion] ?? 1, reproduction_sha256: g.reproduction_sha256, decision: null })),
      challenge_sha256: judged.challenge_sha256,
      receipt_path: archived.receipt_path,
      receipt_sha256: archived.receipt_sha256,
      claim_id: claim.claim_id,
      dispatch_id: claim.dispatch_id ?? null,
      capability_sha256: claim.capability_sha256 as string,
      generation: brief.generation,
      base_sha: judged.base_sha,
      at,
      refinement: null,
      ...(partial !== null ? { partial: { done: [...partial.done], unresolved: structuredClone(partial.unresolved) } } : {}),
    };
    const dispute = disputed ? this.disputeDetail(reviewId, record, prior) : null;
    const graph = this.graph();
    const candidates = this.restorableDependents(entry);
    mutateState(this.paths.featureDir, (s) => {
      const n = s.nodes[nodeId];
      if (!n || n.claim?.claim_id !== claim.claim_id) throw new Error(`CHALLENGE_CHANGED: ${nodeId}'s claim changed while its challenge was settled; dispatch again.`);
      const e = (n.rework_history ?? [])[history.length - 1];
      if (e) e.challenged = { challenge_id: id, at };
      // The DONE generation the rework replaced, exactly: no product attempt is charged for the challenge.
      restoreGenerationInto(n, restored, at);
      // Each DONE product dependent the rework reopened, still exactly as it left it, every upstream DONE again:
      // put back on its generation too (CSET-203 r7), dependency order. Verification consumers run again instead.
      const restoredDependents = restoreDependentsInto(s, candidates, graph, at);
      record.restored = restoredDependents;
      // What a review binds changed: the epoch moves, with the lineage of every node put back; the challenge's lease settled.
      const epoch = bumpEpoch(s, `challenge ${id} of ${reviewId}`, [nodeId, ...restoredDependents], at);
      closeLeases(s, (l) => l.node_id === nodeId && l.claim_id === claim.claim_id, 'settled', `review-gap challenge ${id}`, at, { outcome: 'REVIEW_CHALLENGED', settled_epoch: epoch });
      const r = s.acceptance_review as AcceptanceReviewState;
      // A valid challenge of a gap is progress of the review it challenges, and restores what its rework spent (engine/review-lineage.ts).
      r.lineage = appendLineage(this.lineageOf(s), record.gaps.map((g): LineageEventBody => ({ kind: 'challenge', review_id: reviewId, challenge_id: id, criterion: g.criterion, reproduction_sha256: g.reproduction_sha256, receipt_sha256: archived.receipt_sha256, node_id: nodeId })), at).lineage;
      r.challenges = [...(r.challenges ?? []), record];
      const rec = [...r.reviews].reverse().find((x) => x.review_id === reviewId);
      if (rec) rec.outcome = 'CHALLENGED';
      if (dispute !== null) {
        r.blocked = { code: 'REVIEW_DISPUTE', review_id: reviewId, detail: dispute.slice(0, 4000), at };
        s.feature_state = 'BLOCKED';
        s.blocked_reason = `REVIEW_DISPUTE: ${dispute.slice(0, 1000)}`;
      }
      return s;
    });
    releaseAllForNode(this.paths.featureDir, nodeId);
    // The rework's worktree is abandoned; the node's branch is its restored generation's again.
    if (claim.worktree) removeWorkerWorktree(repoPath, claim.worktree);
    const branch = workerBranchName(this.featureId, nodeId);
    if (entry.branch_head !== null) runGit(repoPath, ['branch', '-f', branch, entry.branch_head], { allowFail: true });
    else runGit(repoPath, ['branch', '-D', branch], { allowFail: true });
    this.fault('challenge-recorded');
    this.event('review.challenged', nodeId, {
      challenge_id: id,
      review_id: reviewId,
      criteria: record.gaps.map((g) => g.criterion),
      rounds,
      status: record.status,
      receipt_path: record.receipt_path,
      receipt_sha256: record.receipt_sha256,
      challenge_sha256: record.challenge_sha256,
      tests: judged.tests.map((t) => t.test_id),
      base_sha: judged.base_sha,
      head_sha: judged.head_sha,
      attempts: restored.attempts,
      restored: record.restored ?? [],
      epoch: currentEpoch(this.state()),
    });
    return this.challengeReport(nodeId, record, sessionId);
  }

  /**
   * The DONE product dependents a challenged rework reopened that can be put
   * back with its node, as far as the files say: each one's worker branch
   * where the rework left it and its evidence (and judged history) intact.
   * Whether it is still exactly as the rework left it, and every upstream is
   * DONE again, is judged in the challenge's own write.
   */
  private restorableDependents(entry: ReworkHistoryEntry): Map<string, RestorableGeneration & { branch_head: string | null }> {
    const out = new Map<string, RestorableGeneration & { branch_head: string | null }>();
    for (const [id, snap] of Object.entries(entry.restore_dependents ?? {})) {
      if (this.branchHead(id) !== snap.branch_head) continue;
      const records = Object.values(snap.evidence) as EvidenceRecord[];
      if (records.some((r) => checkEvidenceOutput(this.controlRoot, this.featureId, r) !== null)) continue;
      if (snap.tdd_history !== null && checkEvidenceOutput(this.controlRoot, this.featureId, snap.tdd_history) !== null) continue;
      out.set(id, snap);
    }
    return out;
  }

  /** `refs/mycelink/challenges/<feature>/<node>/<challenge id>`: a challenge's test-only commit, kept as evidence. */
  private challengeRefName(nodeId: string, id: string): string {
    const suffix = workerBranchName(this.featureId, nodeId).slice(`wip/${this.featureId}/`.length);
    return `refs/mycelink/challenges/${this.featureId}/${suffix}/${id}`;
  }

  /** Why a challenge blocks its review: every round of the gap, with its evidence and what each refinement decided. */
  private disputeDetail(reviewId: string, record: ReviewChallengeRecord, prior: ReviewChallengeRecord[]): string {
    const criteria = record.gaps.filter((g) => g.round > MAX_CHALLENGE_ROUNDS).map((g) => g.criterion);
    const rounds = [...prior.filter((c) => c.gaps.some((g) => criteria.includes(g.criterion))), record];
    return [
      `${reviewId}'s gap of ${criteria.join(', ')} was challenged again after ${MAX_CHALLENGE_ROUNDS} challenge-refinement rounds:`,
      ...rounds.map((c) => `${c.challenge_id} (${c.node_id}; evidence ${c.receipt_path}; ${c.gaps.map((g) => `${g.criterion} round ${g.round}${g.decision !== null ? ` ${g.decision}` : ''}`).join(', ')})`),
      `Each passing reproduction and each refinement is on record. ${record.node_id} stays DONE on its prior generation; no candidate is cut.`,
      'A person decides: record a decision and rework past the block (node rework --decision), or supersede the feature.',
    ].join(' ');
  }

  /**
   * The DONE generation a rework of an acceptance review replaced, as its
   * history entry keeps it, its evidence read from the copies the rework
   * archived (the node's later gates wrote the same file names). A problem
   * when any of it is no longer intact.
   */
  private restoredGeneration(entry: ReworkHistoryEntry): RestorableGeneration | { problem: string } {
    const snap = entry.restore as RestorableGeneration;
    const evidence: Partial<Record<EvidenceKind, EvidenceRecord>> = {};
    for (const [kind, rec] of Object.entries(snap.evidence) as [EvidenceKind, EvidenceRecord][]) {
      const archived = entry.evidence[kind];
      const path = [archived?.output_path, rec.output_path].find((p): p is string => typeof p === 'string' && checkEvidenceOutput(this.controlRoot, this.featureId, { output_path: p, output_sha256: rec.output_sha256 }) === null);
      if (path === undefined) return { problem: `the ${kind} evidence of the generation the rework replaced (${rec.output_path}) is no longer intact` };
      let results = rec.results;
      if (results !== undefined && results !== null) {
        const want = results.sha256;
        const copy = `${path.slice(0, path.lastIndexOf('/'))}/${basename(results.path)}`;
        const where = [copy, results.path].find((p) => existsSync(join(this.controlRoot, p)) && sha256OfFile(join(this.controlRoot, p)) === want);
        if (where === undefined) return { problem: `the ${kind} results of the generation the rework replaced (${results.path}) are no longer intact` };
        results = { ...results, path: where };
      }
      evidence[kind] = { ...rec, output_path: path, ...(results ? { results } : {}) };
    }
    return { ...structuredClone(snap), evidence };
  }

  /** What settling a challenge concluded, from its record. */
  private challengeReport(nodeId: string, record: ReviewChallengeRecord, sessionId: string | null): NodeRunReport {
    const round = Math.max(...record.gaps.map((g) => g.round));
    const criteria = record.gaps.map((g) => g.criterion);
    return {
      node_id: nodeId,
      outcome: 'REVIEW_CHALLENGED',
      session_id: sessionId,
      state: this.state().nodes[nodeId]?.state ?? 'DONE',
      detail:
        record.status === 'disputed'
          ? `${record.challenge_id} challenges ${criteria.join(', ')} of ${record.review_id} past ${MAX_CHALLENGE_ROUNDS} challenge-refinement rounds: the review is blocked REVIEW_DISPUTE (its evidence: ${record.receipt_path}); ${nodeId} is DONE on its prior generation`
          : `${record.challenge_id}: the exact reproduction of ${criteria.join(', ')} from ${record.review_id} passes on the unchanged head; no attempt charged, ${nodeId} is DONE on its prior generation${(record.restored ?? []).length > 0 ? ` (with ${(record.restored ?? []).join(', ')}, which its rework had reopened)` : ''} and ${record.review_id} CHALLENGED; dispatch hands a fresh reviewer its refinement (round ${round} of ${MAX_CHALLENGE_ROUNDS}) once the work it does not decide has settled`,
      evidence: [],
      challenge: { challenge_id: record.challenge_id, review_id: record.review_id, criteria, round, status: record.status, receipt_path: record.receipt_path, restored: [...(record.restored ?? [])] },
    };
  }

  /**
   * The only road to DONE for a node with a worker: the history judged
   * test-first from the repository and sealed at the exact head submitted
   * (see judgeHistory), fresh verification on a clean checkout of exactly
   * that commit (the worker's own files and claims count for nothing), gate
   * advancement against the evidence actually recorded, integration into
   * the repository's feature branch, DONE, and release of the claim, its
   * leases and its worktree. Any refusal along the way is a recorded
   * attempt failure, never a node left half-way; a refused history is
   * archived with its evidence and never integrated.
   */
  finalizeVerified(nodeId: string, sessionId: string | null, evidence: EvidenceRecord[] = [], result: NodeResult | null = null, form: CriteriaForm | null = null): NodeRunReport {
    // A finalize interrupted after integration resumes at DONE: the merge
    // already happened, from a commit already judged and verified.
    if (this.state().nodes[nodeId]?.state === 'INTEGRATED') return this.concludeDone(nodeId, sessionId, 'integrated before an interruption', evidence, result);

    let sealed: string | undefined;
    let compatibility: TddHistory['compatibility'] = [];
    let cycles: TddHistory['cycles'] = [];
    const repository = this.node(nodeId).repository;
    if (repository !== null) {
      const repoPath = repositoryPath(this.workspace, repository);
      const branchAt = resolveRef(repoPath, workerBranchName(this.featureId, nodeId));
      // A re-proof unit settle committed on the sealed head before an interruption (CSET-201 final) is the controller's,
      // never the worker's: the worker's history is judged at the head it sealed.
      const unit = this.state().nodes[nodeId]?.claim?.reproof_unit ?? null;
      const head = unit !== null && branchAt === unit.commit ? unit.from : branchAt;
      // A submission held for its criterion evidence, resubmitted: at the held commit it is judged with exactly the
      // evidence it was held with; a correction's new RED cycle builds on the held commit, and the whole history from
      // the base is judged again at the new head (engine/criteria.ts).
      const hold = this.state().nodes[nodeId]?.claim?.evidence_correction ?? null;
      if (hold && head === hold.commit_sha) this.restoreHeldSubmission(nodeId);
      else if (hold && hold.cycle === true) {
        if (!isAncestor(repoPath, hold.commit_sha, head)) {
          const report = this.failAttempt(nodeId, sessionId, `CORRECTION_HISTORY_REWRITTEN: ${workerBranchName(this.featureId, nodeId)} at ${head.slice(0, 12)} no longer holds ${hold.commit_sha.slice(0, 12)}, the commit held for correction; a correction adds its RED cycle on top of it and never rewrites it`, evidence);
          return { ...report, outcome: 'VERIFICATION_FAILED' };
        }
        mutateState(this.paths.featureDir, (s) => {
          const c = s.nodes[nodeId]?.claim;
          if (c) {
            c.seal = null;
            c.criteria_judged = null;
          }
          return s;
        });
      }
      // Ownership first, judged on the same delta as the history: work an
      // upstream node integrated is base, never this node's.
      // A settlement sealed before an interruption is finished at the head it judged, or not at all.
      const sealedHead = this.state().nodes[nodeId]?.claim?.seal?.head_sha;
      if (sealedHead !== undefined && sealedHead !== head) {
        const report = this.failAttempt(nodeId, sessionId, `BRANCH_MOVED: ${workerBranchName(this.featureId, nodeId)} moved from ${sealedHead.slice(0, 12)}, the head settle sealed, to ${head.slice(0, 12)}`, evidence);
        return { ...report, outcome: 'VERIFICATION_FAILED' };
      }
      const fence = this.fenceOf(nodeId, head);
      // A branch rebuilt on a head older than the one its claim started from (CSET-201 final): integrated, it would erase what
      // landed since; reissued from the latest head, uncharged.
      if (fence.base === null) {
        const stale = this.staleBase(nodeId, head);
        if (stale !== null) return this.siblingProgressLost(nodeId, sessionId, stale, evidence);
      }
      if (fence.base === null || fence.detail !== null) {
        const report = this.failAttempt(nodeId, sessionId, fence.detail ?? 'OWNERSHIP_VIOLATION', evidence);
        return { ...report, outcome: 'OWNERSHIP_VIOLATION' };
      }
      const judged = this.judgeHistory(nodeId, result, head, fence.base);
      if (!judged.ok) {
        // A history refused only because a capsule's files were committed as a RED its tests' titles cannot declare
        // (CSET-203 r17's NO_DECLARED_TESTS): the capsule's path, held uncharged — never a rejected history.
        const k = this.capsuleOfHistory(nodeId, judged.history);
        if (k !== null) return this.holdForEvidenceCorrection(nodeId, sessionId, { code: 'CRITERION_CAPSULE_PATH', detail: capsulePathDetail(k, k.criterion, `TDD_HISTORY_INVALID:${judged.history.violation?.code}: ${judged.history.violation?.detail ?? ''}`), candidates: [], criterion: k.criterion }, evidence, head);
        return this.rejectHistory(nodeId, sessionId, judged.history, evidence);
      }
      sealed = judged.history.head_sha;
      compatibility = judged.history.compatibility;
      cycles = judged.history.cycles;
      this.fault('history-sealed');
    }

    // The gates ran exactly the module command the claim bound, or nothing they recorded is believed.
    const unbound = this.gateBindingProblem(nodeId);
    if (unbound !== null) {
      const report = this.failAttempt(nodeId, sessionId, unbound, evidence);
      return { ...report, outcome: 'VERIFICATION_FAILED' };
    }

    // The approved criteria the claim was bound to are still the feature's (engine/acceptance.ts): else nothing is judged by them.
    const boundAcceptance = this.state().nodes[nodeId]?.claim?.acceptance;
    if (boundAcceptance !== undefined) {
      let now: { manifest_sha256: string | null; criteria_sha256: string } | null = null;
      let drift: string | null = null;
      try {
        now = this.claimAcceptance(nodeId);
      } catch (err) {
        drift = errorText(err);
      }
      if (drift === null && now !== null && (now.criteria_sha256 !== boundAcceptance.criteria_sha256 || now.manifest_sha256 !== boundAcceptance.manifest_sha256)) {
        drift = new AcceptanceDriftError(nodeId, 'the criteria the claim was bound to are not the graph\'s and manifest\'s any more').message;
      }
      if (drift !== null) return this.holdForPrecondition(nodeId, sessionId, drift, evidence);
    }

    // Every criterion the node serves names the test that proves it and the gate output that ran it (engine/criteria.ts).
    // A worker's submission only: a node finalized by hand is held to coverage feature-wide, at candidate verify and delivery.
    // Judged and accepted at this sealed head before an interruption: finished at that judgement (fresh verification has
    // since replaced the worker's green and regression records, which the evidence named).
    const judgedBefore = sealed !== undefined && (this.state().nodes[nodeId]?.claim?.criteria_judged ?? null) === sealed;
    if (result !== null && repository !== null && sealed !== undefined && !judgedBefore) {
      const runtime = this.state().nodes[nodeId] as NodeRuntime;
      const judged = judgeCriteria({
        controlRoot: this.controlRoot,
        featureId: this.featureId,
        graph: this.graph(),
        node: this.node(nodeId),
        runtime,
        evidence: result.criterion_evidence,
        repoPath: repositoryPath(this.workspace, repository),
        head: sealed,
        policy: runtime.claim?.tdd_policy ?? this.claimTddPolicy(repository),
        modulePath: runtime.claim?.verification?.path ?? null,
        compatibility,
        // A per-criterion answer: its challenged and unresolved criteria are judged apart, never covered here.
        ...(form !== null ? { exclude: [...form.challenged, ...form.unresolved.map((u) => u.criterion)] } : {}),
        challengeTests: (result.challenge?.gaps ?? []).flatMap((g) => g.tests),
      });
      if (!judged.ok) return this.holdForEvidenceCorrection(nodeId, sessionId, judged, evidence, sealed);
      // A per-criterion answer (CSET-203 r15): each DONE criterion's evidence judged above on its own; then one test for two
      // criteria, its challenge judged per criterion, each challenged criterion's prior proof carried while it waits — all
      // kept on the claim before anything is integrated, so a settle interrupted later records exactly it.
      let accepted: AcceptedCriterionRecord[] = judged.accepted;
      let settlement: CriteriaSettlement | null = null;
      if (form !== null) {
        const answered = this.answerVerdict(nodeId, result, form, judged.accepted, cycles, sealed);
        if (answered.kind === 'hold') return this.holdForEvidenceCorrection(nodeId, sessionId, answered.refusal, evidence, sealed);
        if (answered.kind === 'refused') return this.refuseChallenge(nodeId, sessionId, answered.refusal, evidence);
        accepted = [...judged.accepted, ...answered.carried];
        if (form.challenged.length > 0 || form.unresolved.length > 0) {
          settlement = { result_sha256: runtime.claim?.result_captured_sha256 ?? '', head_sha: sealed, done: [...form.done], challenged: [...form.challenged], unresolved: structuredClone(form.unresolved), carried: answered.carried, order: answered.order, at: new Date().toISOString() };
        }
      }
      // Production code is never carried in behind a completed or carried proof (CSET-203 r16): every production change of
      // a generation that relies on one follows a RED that failed a test this answer proves a DONE criterion by.
      const undriven = this.productionUndriven(runtime, accepted, cycles);
      if (undriven !== null) {
        const report = this.failAttempt(nodeId, sessionId, `CRITERIA_PRODUCTION_UNDRIVEN: ${undriven}`, evidence);
        return { ...report, outcome: 'VERIFICATION_FAILED' };
      }
      // The generation's RED, judged per criterion, never as one aggregate: its own when it ran a RED cycle; when it changed no
      // production code, the attested RED of a completion it carries (or none at all for compatibility work alone).
      const basis = this.generationRed(nodeId, runtime, accepted, cycles);
      if (basis.kind === 'missing') {
        return this.holdForEvidenceCorrection(nodeId, sessionId, { code: 'CRITERION_RED_REQUIRED', detail: basis.detail, candidates: [], criterion: basis.criterion }, evidence, sealed);
      }
      // A test published before identities is recorded by its canonical identity beside an immutable alias receipt (PCM-101 final);
      // an administrative re-evaluation of an identity-shape refusal, by the receipt of what it re-evaluated. Nothing is rewritten.
      accepted = this.receiptAliases(nodeId, accepted, runtime.claim?.claim_id ?? null);
      const marker = runtime.claim?.identity_reconcile ?? null;
      const reconciled = marker !== null && (marker.receipt ?? null) === null && runtime.claim ? this.writeIdentityReconciliation(nodeId, runtime.claim.claim_id, marker, sealed, accepted) : null;
      mutateState(this.paths.featureDir, (s) => {
        const rt = s.nodes[nodeId];
        if (rt) {
          rt.criteria = accepted;
          if (basis.kind === 'carried') rt.evidence.red = basis.record;
          if (basis.kind === 'compatibility') {
            // Compatibility work alone, on code its base already holds: no RED is this generation's (as a compatibility-only order's).
            if (rt.rework_brief) rt.rework_brief.red_required = false;
            if (rt.evidence.red !== undefined && (rt.evidence.red.exit_code === 0 || rt.evidence.red.red_reason !== 'behaviour-missing')) delete rt.evidence.red;
          }
          if (rt.claim) {
            rt.claim.evidence_correction = null;
            rt.claim.criteria_judged = sealed;
            if (form !== null) rt.claim.criteria_settlement = settlement;
            if (reconciled !== null && rt.claim.identity_reconcile) rt.claim.identity_reconcile.receipt = reconciled;
          }
        }
        return s;
      });
      if (basis.kind === 'carried') this.event('node.red_carried', nodeId, { record_id: basis.record.carried_from?.record_id ?? null, criterion: basis.record.carried_from?.criterion ?? null, generation: basis.record.carried_from?.generation ?? null, output_sha256: basis.record.output_sha256 });
      if (settlement !== null) this.fault('criteria-judged');
      if (reconciled !== null && marker !== null) {
        this.event('node.identity_reconciled', nodeId, { claim_id: runtime.claim?.claim_id ?? null, cause: marker.cause, refused: marker.refused.code, fingerprint: marker.fingerprint, result_sha256: marker.result_sha256, receipt_path: reconciled.path, receipt_sha256: reconciled.sha256, criteria: accepted.map((a) => ({ criterion: a.criterion, key: a.identity?.key ?? null })) });
        this.fault('identity-receipt-written');
      }
    }

    // A re-proof is committed into the product exactly as its red gate ran it (CSET-201 final): a test-only unit of the
    // controller's on the sealed head, verified and integrated with it, so every later head holds the settled proof.
    let verifyAt = sealed;
    if (repository !== null && sealed !== undefined) {
      const unit = this.materializeReproof(nodeId, sealed);
      if (unit.kind === 'held') return this.holdReproof(nodeId, sessionId, unit.criterion, unit.detail, evidence, sealed);
      if (unit.kind === 'committed') verifyAt = unit.commit;
    }
    const verification = this.freshVerify(nodeId, verifyAt !== undefined ? { expectedSha: verifyAt } : {});
    for (const record of verification.evidence) {
      evidence.push(record);
      this.setEvidence(nodeId, record);
    }

    if (!verification.ok && verification.setupFailed === true) return this.holdForPrecondition(nodeId, sessionId, verification.detail, evidence);
    if (!verification.ok) {
      const ownership = verification.detail.startsWith('OWNERSHIP_VIOLATION');
      const outcome = ownership ? 'OWNERSHIP_VIOLATION' : 'VERIFICATION_FAILED';
      this.undoReproofUnit(nodeId);
      const report = this.failAttempt(nodeId, sessionId, verification.detail, evidence);
      return { ...report, outcome };
    }
    // A re-proof holds only where its tests pass: at the unit's commit, in the fresh verification's own run of them.
    const unproved = this.reproofUnproved(nodeId, verification.evidence);
    if (unproved !== null && sealed !== undefined) {
      this.undoReproofUnit(nodeId);
      return this.holdReproof(nodeId, sessionId, unproved.criterion, unproved.detail, evidence, sealed);
    }
    // A carried proof is never this generation's evidence: its test, run again by the fresh verification of the
    // sealed head, is (engine/criteria.ts revalidateCarried).
    const accepted = this.state().nodes[nodeId]?.criteria ?? [];
    if (accepted.some((c) => c.carried === true)) {
      // A challenged criterion's prior proof is carried while its challenge waits (CSET-203 r15): its test must pass at the
      // sealed head as any carried proof's; one recorded without a test id is kept as it was settled.
      const kept = this.state().nodes[nodeId]?.claim?.criteria_settlement?.carried ?? [];
      const asIs = accepted.filter((c) => c.carried === true && c.test_id === null && kept.some((k) => k.criterion === c.criterion));
      const proofs = [...(this.state().nodes[nodeId]?.carried_criterion_proofs ?? []), ...kept.filter((k) => k.test_id !== null && k.test !== null).map(interimProof)];
      const revalidated = revalidateCarried({ controlRoot: this.controlRoot, accepted: accepted.filter((c) => !asIs.includes(c)), proofs, fresh: verification.evidence });
      if (!revalidated.ok) {
        // A completion the worker's own change broke is the work's failure; one the base no longer holds (a concurrent change,
        // an upstream rework) is reopened on its own, the claim handed back unspent (CSET-203 r16).
        const proof = proofs.find((p) => p.criterion === revalidated.criterion) ?? null;
        this.undoReproofUnit(nodeId);
        if (proof !== null && sealed !== undefined && !this.workerTouched(nodeId, proof, sealed)) return this.reopenAtSettle(nodeId, sessionId, proof, revalidated.detail, evidence);
        const report = this.failAttempt(nodeId, sessionId, revalidated.detail, evidence);
        return { ...report, outcome: 'VERIFICATION_FAILED' };
      }
      mutateState(this.paths.featureDir, (s) => {
        const rt = s.nodes[nodeId];
        if (rt) rt.criteria = [...revalidated.criteria, ...asIs];
        return s;
      });
    }
    this.fault('fresh-verified');

    try {
      this.advanceVerifiedGates(nodeId);
      this.fault('gates-advanced');
      const sha = this.integrate(nodeId, verification.sha);
      this.transition(nodeId, 'INTEGRATED', sha !== null ? { integratedSha: sha } : {});
      this.fault('integrated');
    } catch (err) {
      if (err instanceof InjectedFault) throw err;
      // Another process holds the integration lock (a concurrent settle): contention, never the worker's failure. The sealed,
      // verified submission is held, nothing charged; the next dispatch finishes the settlement.
      if (err instanceof SiblingProgressLostError) return this.siblingProgressLost(nodeId, sessionId, { cause: 'delta', lost: err.lost, conflicts: [], head: err.to, from: err.from }, evidence);
      // A conflict with a sibling's work is the worker's to resolve on the latest head: reissued from it, uncharged.
      if (err instanceof IntegrationConflictError) return this.siblingProgressLost(nodeId, sessionId, { cause: 'conflict', lost: [], conflicts: err.conflicts, head: verification.sha ?? '', from: this.state().integration_heads?.[repository as string] ?? '' }, evidence);
      if (err instanceof LockTimeoutError) return this.holdForPrecondition(nodeId, sessionId, 'INTEGRATION_LOCK_BUSY: another process held the integration lock past its wait; nothing was charged or integrated, and the next dispatch finishes this settlement', evidence);
      // A gate the controller's own record of a verified, judged settlement cannot enter (its evidence, as recorded, is not
      // the generation's): an administrative state, never the work's failure — CSET-203 r16 charged it twice and BLOCKED the
      // cli. Held, nothing charged or counted; the next dispatch finishes the settlement.
      if (err instanceof TransitionError && (err.code === 'INVALID_RED_EVIDENCE' || err.code === 'MISSING_EVIDENCE')) {
        return this.holdForPrecondition(nodeId, sessionId, `${SETTLE_GATE_STATE}: ${err.message} The history, criteria and fresh verification of this settlement were judged and accepted; nothing was charged or integrated.`, evidence);
      }
      this.undoReproofUnit(nodeId);
      return this.failAttempt(nodeId, sessionId, errorText(err), evidence);
    }
    const done = this.concludeDone(nodeId, sessionId, verification.detail, evidence, result);
    this.reopenDeferredDependents(nodeId);
    return done;
  }

  /**
   * A deferred regression's dependents re-verify on the producer's new work:
   * one already DONE is reopened (with its dependents) on a fresh branch
   * from the integration state, as a rework reopens its cascade.
   */
  private reopenDeferredDependents(nodeId: string): void {
    const deferred = this.state().nodes[nodeId]?.evidence.regression?.regression_deferred?.to ?? [];
    const graph = this.graph();
    for (const id of deferred) {
      if (this.state().nodes[id]?.state !== 'DONE') continue;
      const reopened = this.invalidateWithDependents(id, `upstream ${nodeId} changed what its tests pin (a deferred regression); re-verify on the integrated work`);
      mutateState(this.paths.featureDir, (s) => {
        for (const r of reopened) {
          const n = graph.nodes.find((x) => x.id === r);
          const rt = s.nodes[r];
          if (rt === undefined || n?.repository === null || n === undefined || CONTROLLER_NODE_TYPES.has(n.node_type)) continue;
          rt.fresh_branch_required = true;
          rt.branch_base_sha = null;
        }
        return s;
      });
    }
  }

  /**
   * Why the node's gate evidence was not run with the module command its
   * claim binds (engine/modules.ts), or null: its RED and GREEN must carry
   * the claim's module and plan hashes, its regression the bound full suite.
   */
  private gateBindingProblem(nodeId: string): string | null {
    const rt = this.state().nodes[nodeId];
    const bound = rt?.claim?.verification;
    if (rt === undefined || bound === undefined) return null;
    for (const kind of ['red', 'green'] as const) {
      const r = rt.evidence[kind];
      // A carried RED was bound to its own claim's module when it ran: its completion record attests it (engine/criterion-ledger.ts).
      if (r === undefined || (kind === 'red' && r.carried_from != null)) continue;
      if (r.module_sha256 !== bound.module_sha256 || r.plan_sha256 !== bound.plan_sha256) {
        const ran = r.module !== undefined ? `module ${r.module} ${String(r.module_sha256).slice(0, 12)}` : `${JSON.stringify(r.command).slice(0, 200)}, no module command`;
        return `MODULE_BINDING_MISMATCH: the ${kind} evidence ran ${ran}, not module ${bound.module} ${bound.module_sha256.slice(0, 12)} the claim binds`;
      }
    }
    const regression = rt.evidence.regression;
    if (regression !== undefined && (regression.command.length !== bound.regression.command.length || regression.command.some((a, i) => a !== bound.regression.command[i]))) {
      return `MODULE_BINDING_MISMATCH: the regression evidence ran ${JSON.stringify(regression.command).slice(0, 200)}, not the full suite the claim binds`;
    }
    return null;
  }

  /**
   * Stop a settlement on a controller precondition (the fresh checkout
   * could not be set up): nothing is known about the work, so nothing is
   * charged or recorded against it. A host dispatch keeps its claim and its
   * sealed history, and the next dispatch finishes the settlement (once, then
   * stops again if the precondition still fails); any other claim is handed
   * back unspent.
   */
  private holdForPrecondition(nodeId: string, sessionId: string | null, detail: string, evidence: EvidenceRecord[]): NodeRunReport {
    const claim = this.state().nodes[nodeId]?.claim ?? null;
    if (claim !== null && claim.mode !== 'host') this.releaseForPrecondition(nodeId, claim.claim_id, detail);
    this.event('settlement.held', nodeId, { claim_id: claim?.claim_id ?? null, detail: detail.slice(0, 500) });
    return this.report(nodeId, 'PRECONDITION_FAILED', sessionId, detail, evidence);
  }

  /**
   * Hold a submission whose criterion evidence alone was refused: its
   * history is judged and sealed and its gates are recorded, so nothing about
   * the product is wrong yet. The same claim stays live, in the same state,
   * nothing is charged or counted and nothing is integrated; the gates are
   * closed (the CLI refuses them while the hold lasts), and the result slot
   * is ready for the capability holder's corrected result — or `dispatch`
   * hands the correction to a fresh worker generation. A resubmission that is
   * refused again counts; at MAX_EVIDENCE_CORRECTIONS the hold ends as a
   * failed attempt. Only a host dispatch has a worker to correct it: any
   * other claim fails the attempt at once.
   */
  private holdForEvidenceCorrection(
    nodeId: string,
    sessionId: string | null,
    judged: { code: string; detail: string; candidates: CriterionCandidate[]; criterion: string | null },
    evidence: EvidenceRecord[],
    head: string,
  ): NodeRunReport {
    const detail = `CRITERION_EVIDENCE_INVALID:${judged.code}: ${judged.detail}`;
    const before = this.state().nodes[nodeId];
    const claim = before?.claim ?? null;
    const resultSha = claim?.result_captured_sha256 ?? '';
    const previous = claim?.evidence_correction ?? null;
    // Only a new submission is a correction: the held one judged again changes nothing.
    const corrections = previous === null ? 0 : previous.corrections + (resultSha !== previous.result_sha256 ? 1 : 0);
    if (claim === null || claim.mode !== 'host' || corrections >= MAX_EVIDENCE_CORRECTIONS) {
      const why = corrections >= MAX_EVIDENCE_CORRECTIONS ? `${detail} (evidence correction limit of ${MAX_EVIDENCE_CORRECTIONS} reached)` : detail;
      const report = this.failAttempt(nodeId, sessionId, why.slice(0, 2000), evidence);
      return { ...report, candidates: judged.candidates };
    }
    // What the refused criterion needs, and whether only a new RED cycle can give it (engine/criteria.ts).
    const graph = this.graph();
    const node = this.node(nodeId);
    const declarationOnly = !node.required_evidence.includes('red');
    const kind = judged.criterion !== null && graph.acceptance_criteria.some((a) => a.id === judged.criterion) ? criterionKind(graph, judged.criterion) : null;
    const cycle = kind === 'new-behavior' && !declarationOnly && CYCLE_CORRECTIONS.has(judged.code as CriterionCode);
    const runtime = before as NodeRuntime;
    // What the held commit was gated with: every correction that ends at this commit gets exactly this back.
    const held = {
      state: runtime.state,
      evidence: structuredClone(runtime.evidence),
      bindings: (runtime.tdd_red_bindings ?? []).length,
    };
    mutateState(this.paths.featureDir, (s) => {
      const c = s.nodes[nodeId]?.claim;
      if (c?.claim_id !== claim.claim_id) return s;
      c.evidence_correction = {
        code: judged.code,
        detail: detail.slice(0, 2000),
        criterion: judged.criterion,
        kind,
        required_gate: kind === null ? null : requiredGate(kind, declarationOnly),
        cycle,
        candidates: judged.candidates.slice(0, 24),
        corrections,
        result_sha256: resultSha,
        commit_sha: head,
        at: new Date().toISOString(),
        held,
        // Judged by the canonical test identity (PCM-101 final): an identity refusal of it is a correction's, never re-evaluated again.
        identity_version: TEST_IDENTITY_VERSION,
      };
      // An administrative re-evaluation that was refused again ends here: what is answered next is a correction.
      c.identity_reconcile = null;
      return s;
    });
    // The slot is the capability holder's again, for the corrected result of the same generation.
    if (claim.worktree !== null) prepareResultSlot(claim.worktree, claim.result_file ?? WORKER_RESULT_FILE);
    this.event('node.evidence_correction_required', nodeId, { claim_id: claim.claim_id, code: judged.code, criterion: judged.criterion, kind, cycle, corrections, commit_sha: head });
    return { ...this.report(nodeId, 'EVIDENCE_CORRECTION_REQUIRED', sessionId, detail, evidence), candidates: judged.candidates };
  }

  /**
   * Put the held submission back exactly as it was judged: its gate
   * evidence, its RED bindings and its state. A correction that ended at the
   * held commit (an answer that proved nothing, a metadata-only resubmission)
   * may have run a gate that was refused or never committed: none of that
   * replaces what the held commit was gated with.
   */
  private restoreHeldSubmission(nodeId: string): void {
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      const held = rt?.claim?.evidence_correction?.held;
      if (!rt || !held) return s;
      rt.evidence = structuredClone(held.evidence);
      rt.tdd_red_bindings = (rt.tdd_red_bindings ?? []).slice(0, held.bindings);
      if (IN_FLIGHT_STATES.has(rt.state) && rt.state !== 'INTEGRATED') rt.state = held.state;
      return s;
    });
  }

  /**
   * A correction generation that changed nothing and gave up (RETRYABLE, a
   * missing result): no product attempt is charged (CSET-203 r1 charged
   * r1's CRITERION_UNPROVEN:AC-4 twice and BLOCKED the node). The held
   * submission is restored and the hold continues, one correction spent —
   * counted once per answer, however often it is settled; at the bound the
   * hold ends as a failed attempt under the answer's fingerprint.
   */
  private unprovenCorrection(nodeId: string, sessionId: string | null, fingerprint: string, evidence: EvidenceRecord[]): NodeRunReport {
    const claim = this.state().nodes[nodeId]?.claim as NodeClaim;
    const hold = claim.evidence_correction as NonNullable<NodeClaim['evidence_correction']>;
    const answer = claim.result_captured_sha256 ?? `missing:${claim.dispatch_id ?? claim.claim_id}`;
    const corrections = hold.corrections + (answer !== hold.result_sha256 ? 1 : 0);
    this.restoreHeldSubmission(nodeId);
    const what = hold.criterion ?? 'its criteria';
    if (corrections >= MAX_EVIDENCE_CORRECTIONS) {
      const report = this.failAttempt(nodeId, sessionId, fingerprint, evidence);
      return { ...report, detail: `${fingerprint}: the correction proved nothing for ${what} and changed nothing; the evidence correction limit of ${MAX_EVIDENCE_CORRECTIONS} is reached, so the hold ends as a failed attempt` };
    }
    mutateState(this.paths.featureDir, (s) => {
      const c = s.nodes[nodeId]?.claim;
      if (c?.claim_id !== claim.claim_id || !c.evidence_correction) return s;
      c.evidence_correction.corrections = corrections;
      c.evidence_correction.result_sha256 = answer;
      return s;
    });
    if (claim.worktree !== null) prepareResultSlot(claim.worktree, claim.result_file ?? WORKER_RESULT_FILE);
    this.event('node.evidence_correction_unproven', nodeId, { claim_id: claim.claim_id, criterion: hold.criterion ?? null, fingerprint, corrections });
    const detail = `${fingerprint}: the correction proved nothing for ${what} and changed nothing; no attempt is charged, and ${what} is still held at ${hold.commit_sha.slice(0, 12)} (correction ${corrections} of ${MAX_EVIDENCE_CORRECTIONS} spent)`;
    return this.report(nodeId, 'EVIDENCE_CORRECTION_REQUIRED', sessionId, detail, evidence);
  }

  /**
   * Whether a refused challenge is the controller's state, never the work's (CSET-203 r17): a capsule that is stale (sealed
   * before a rebase, or by another claim — a late or reused one), or a gate no red run kept while a current passing capsule
   * of the claim reproduces the criterion. The code it is held under, or null.
   */
  private capsuleAdministrative(nodeId: string, judged: ChallengeRefusal): string | null {
    if (judged.code === 'REVIEW_CHALLENGE_CAPSULE_STALE') return 'CRITERION_CAPSULE_STALE';
    if (judged.code === 'REVIEW_CHALLENGE_GATE_UNKNOWN' && this.passingCapsuleOf(nodeId) !== null) return 'CRITERION_CAPSULE_PATH';
    return null;
  }

  /** Hold a submission a capsule's own state refused: the claim kept, nothing charged or counted, the slot ready for the corrected answer. */
  private holdForCapsule(nodeId: string, sessionId: string | null, judged: ChallengeRefusal, evidence: EvidenceRecord[]): NodeRunReport {
    const code = this.capsuleAdministrative(nodeId, judged) ?? 'CRITERION_CAPSULE_STALE';
    const capsule = this.passingCapsuleOf(nodeId);
    const guidance = capsule !== null ? ` The claim's current passing capsule is ${capsule.capsule_id} (${capsule.criterion}): cite it (the challenge line with --capsule ${capsule.capsule_id}).` : ' Seal the reproduction for this claim (the capsule line), or carry a capsule of this claim sealed before a rebase (--carry), and cite it.';
    const criterion = (this.state().nodes[nodeId]?.rework_brief?.acceptance_criteria ?? [])[0] ?? null;
    const head = this.branchHead(nodeId) ?? '';
    return this.holdForEvidenceCorrection(nodeId, sessionId, { code, detail: `${judged.code}: ${judged.detail}${guidance} Nothing was charged.`.slice(0, 1800), candidates: [], criterion }, evidence, head);
  }

  /** A refused challenge: a failed attempt under REVIEW_CHALLENGE_INVALID:<what>, the review as it was; nothing integrated. */
  private refuseChallenge(nodeId: string, sessionId: string | null, judged: ChallengeRefusal, evidence: EvidenceRecord[]): NodeRunReport {
    if (this.capsuleAdministrative(nodeId, judged) !== null) return this.holdForCapsule(nodeId, sessionId, judged, evidence);
    const fingerprint = challengeFingerprint(judged.code);
    this.event('review.challenge_refused', nodeId, { code: judged.code, detail: judged.detail.slice(0, 500), problems: judged.problems.slice(0, 12).map((p) => ({ code: p.code, pointer: p.pointer })) });
    const report = this.failAttempt(nodeId, sessionId, fingerprint, evidence);
    return { ...report, detail: `${fingerprint}: ${judged.code}: ${judged.detail}`.slice(0, 2000) };
  }

  /**
   * What a per-criterion answer's DONE criteria and its challenge come to beside each other, once the DONE criteria's
   * evidence was judged on its own (engine/criteria.ts): one test named for two criteria only where each traces its own
   * clauses to that test's assertions (else held for correction, CRITERION_EVIDENCE_REUSED — a passing test is never a
   * RED, a failing one never a challenge); its challenge judged per criterion (refused: a failed attempt); each
   * challenged criterion's prior proof — the generation the rework replaced settled it — carried while its challenge
   * waits; and the order as its brief binds it.
   */
  private answerVerdict(nodeId: string, result: NodeResult, form: CriteriaForm, accepted: readonly AcceptedCriterionRecord[], cycles: TddHistory['cycles'], head: string):
    | { kind: 'ok'; carried: AcceptedCriterionRecord[]; order: PartialOrderBinding; challenge_sha256: string | null }
    | { kind: 'hold'; refusal: { code: string; detail: string; candidates: CriterionCandidate[]; criterion: string | null } }
    | { kind: 'refused'; refusal: ChallengeRefusal } {
    const rt = this.state().nodes[nodeId] as NodeRuntime;
    const done = new Set(form.done);
    const proofs = accepted.filter((a) => done.has(a.criterion) && a.test_id !== null);
    const uses: EvidenceUse[] = [
      ...proofs.map((a) => ({ criterion: a.criterion, test_id: a.test_id as string, role: a.gate })),
      ...(result.challenge?.gaps ?? []).flatMap((g) => g.tests.map((t) => ({ criterion: g.criterion, test_id: t, role: 'challenge' as const }))),
    ];
    const reused = evidenceReuse(uses, (criterion, testId) => this.tracedTo(nodeId, result, criterion, testId, accepted, head));
    if (reused !== null) return { kind: 'hold', refusal: { code: 'CRITERION_EVIDENCE_REUSED', detail: reused.detail, candidates: [], criterion: reused.criterion } };
    let challengeSha: string | null = null;
    if (form.challenged.length > 0) {
      const judged = this.judgeChallengeOf(nodeId, result, { done: [...form.done], doneRedTests: proofs.filter((a) => a.gate === 'red').map((a) => a.test_id as string), doneTests: proofs.map((a) => a.test_id as string), cycles, bindings: rt.tdd_red_bindings ?? [] });
      if (!judged.ok) return { kind: 'refused', refusal: judged };
      challengeSha = judged.challenge_sha256;
    }
    const entry = (rt.rework_history ?? []).at(-1);
    const carried: AcceptedCriterionRecord[] = [];
    for (const c of form.challenged) {
      const prior = (entry?.criteria ?? []).find((x) => x.criterion === c);
      if (prior === undefined) {
        return { kind: 'refused', refusal: { ok: false, code: 'REVIEW_CHALLENGE_NOT_REVIEW_REWORK', detail: `${c} has no proof of the generation this rework replaced to keep while its challenge waits: prove it, or challenge the whole order`, problems: [] } };
      }
      const { challenge_id: _stale, ...kept } = structuredClone(prior);
      carried.push({ ...kept, carried: true, carried_from: prior.carried_from ?? { generation: entry?.generation ?? 0, gate: prior.gate, output_sha256: prior.output_sha256, claim_id: entry?.claim_id ?? null, dispatch_id: entry?.dispatch_id ?? null, repo_sha: entry?.integrated_sha ?? null } });
    }
    const brief = rt.rework_brief as ReworkBrief;
    const origin = brief.origin as ReworkOrigin;
    const order: PartialOrderBinding = {
      review_id: origin.review_id,
      review: origin.review,
      revision: origin.revision ?? null,
      receipt_path: origin.receipt_path ?? null,
      receipt_sha256: origin.receipt_sha256 ?? null,
      refinement: origin.refinement !== undefined ? { ...origin.refinement } : null,
      review_gaps: structuredClone(brief.review_gaps ?? []),
      evidence: [...brief.evidence],
    };
    return { kind: 'ok', carried, order, challenge_sha256: challengeSha };
  }

  /**
   * Whether a criterion of a per-criterion answer traces its own clauses to the test it shares with another: a
   * challenged one in its challenge (judged there); a DONE one in its criteria item — each clause one of its own, each
   * assertion a concrete one inside that test's block at the submitted head.
   */
  private tracedTo(nodeId: string, result: NodeResult, criterion: string, testId: string, accepted: readonly AcceptedCriterionRecord[], head: string): boolean {
    const gap = (result.challenge?.gaps ?? []).find((g) => g.criterion === criterion);
    if (gap !== undefined) return gap.clauses.some((cl) => cl.test_id === testId);
    const clauses = ((result.criteria ?? []).find((x) => x.criterion === criterion)?.clauses ?? []).filter((cl) => cl.test_id === testId);
    const test = accepted.find((a) => a.test_id === testId)?.test ?? null;
    const node = this.node(nodeId);
    if (clauses.length === 0 || test === null || node.repository === null) return false;
    const source = runGit(repositoryPath(this.workspace, node.repository), ['show', `${head}:${test.path}`], { allowFail: true });
    if (source.exitCode !== 0) return false;
    const text = reviewCriteria(this.controlRoot, this.featureId, this.graph()).find((x) => x.id === criterion)?.text ?? '';
    const own = criterionClauses(criterion, text).map((x) => x.id);
    return clauses.every((cl) => own.includes(cl.clause) && cl.assertions.length > 0 && cl.assertions.every((ref) => {
      const at = parseAssertionRef(ref, node.repository);
      return at !== null && at.path === test.path && assertionProblem(source.stdout, test.path, test.name, at.from, at.to) === null;
    }));
  }

  /**
   * A per-criterion answer's integration concluded (CSET-203 r15). Under the delivery lock, in one STATE.json write: the
   * node DONE on its new generation (the criteria it proved; each challenged criterion's prior proof carried, marked with
   * its challenge); the order's record of what each criterion came to; its challenge — re-judged here as settle judged it,
   * its evidence archived under the review — recorded, the review CHALLENGED, the lineage giving back the challenged
   * criteria's rework alone, the epoch moved. Then, with no challenge waiting, its unresolved criteria ordered again on
   * their own (orderFollowUp). A settle interrupted on either side of the write finishes it once: the claim keeps the plan
   * until the write, and the write drops the claim.
   */
  private concludeCriteriaDone(nodeId: string, sessionId: string | null, evidence: EvidenceRecord[], result: NodeResult | null): NodeRunReport {
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    const made = withLock(join(lockDir, 'deliver.lock'), () => this.recordCriteriaLocked(nodeId, result), { timeoutMs: 15_000, pollMs: 50, purpose: 'per-criterion settle' });
    // What the write recorded is said at once: an interruption after it loses nothing of the record.
    this.event('node.transition', nodeId, { to: 'DONE' });
    this.completedEvent(nodeId, made.completions);
    const { plan, record, unresolved } = made;
    if (record !== null) {
      this.event('review.challenged', nodeId, { challenge_id: record.challenge_id, review_id: record.review_id, criteria: record.gaps.map((g) => g.criterion), status: record.status, receipt_path: record.receipt_path, receipt_sha256: record.receipt_sha256, challenge_sha256: record.challenge_sha256, partial: { done: plan.done }, epoch: currentEpoch(this.state()) });
    }
    this.event('node.criteria_settled', nodeId, { done: plan.done, challenged: record !== null ? plan.challenged : [], unresolved: unresolved.map((u) => ({ criterion: u.criterion, outcome: u.outcome })), challenge_id: record?.challenge_id ?? null, follow_up: made.followUp });
    this.fault('criteria-recorded');
    this.releaseClaim(nodeId);
    this.removeWorktree(nodeId, made.worktree);
    const follow = made.followUp ? (this.orderFollowUp(nodeId) ?? { criteria: unresolved.map((u) => u.criterion), state: 'pending' as const, decisions: [] }) : null;
    const order = this.graph().acceptance_criteria.map((a) => a.id);
    const criteria = [
      ...plan.done.map((criterion) => ({ criterion, outcome: 'DONE' })),
      ...(record !== null ? plan.challenged.map((criterion) => ({ criterion, outcome: 'REVIEW_GAP_CHALLENGE', challenge_id: record.challenge_id })) : []),
      ...unresolved.map((u) => ({ criterion: u.criterion, outcome: u.outcome })),
    ].sort((a, b) => order.indexOf(a.criterion) - order.indexOf(b.criterion));
    const state = this.state().nodes[nodeId]?.state ?? 'DONE';
    const what = criteria.map((c) => `${c.criterion} ${c.outcome}`).join(', ');
    const detail = [
      `${nodeId} settled per criterion (${what}): the DONE criteria integrated as its new generation, one product attempt for the execution`,
      record !== null ? `${record.challenge_id} records the challenge of ${plan.challenged.join(', ')}; ${record.review_id} is CHALLENGED and a fresh reviewer refines it (dispatch hands out its ticket once the work it does not decide has settled)` : '',
      follow !== null ? (follow.state === 'pending' ? `${follow.criteria.join(', ')} ordered again once the work in flight settles` : `${follow.criteria.join(', ')} ordered again on ${follow.criteria.length === 1 ? 'its' : 'their'} own and parked ${follow.state} with ${follow.criteria.length === 1 ? 'its' : 'their'} reason`) : '',
    ].filter((x) => x !== '').join('; ');
    return {
      node_id: nodeId,
      outcome: 'CRITERIA_SETTLED',
      session_id: sessionId,
      state,
      detail,
      evidence,
      criteria,
      ...(record !== null ? { challenge: { challenge_id: record.challenge_id, review_id: record.review_id, criteria: record.gaps.map((g) => g.criterion), round: Math.max(...record.gaps.map((g) => g.round)), status: record.status, receipt_path: record.receipt_path, restored: [] } } : {}),
      ...(follow !== null ? { follow_up: follow } : {}),
    };
  }

  /** The body of concludeCriteriaDone under the delivery lock: the challenge re-judged and archived, then the one write. */
  private recordCriteriaLocked(nodeId: string, result: NodeResult | null): { worktree: string | null; plan: CriteriaSettlement; record: ReviewChallengeRecord | null; unresolved: UnresolvedCriterionRecord[]; followUp: boolean; completions: CriterionCompletion[] } {
    const state = this.state();
    const rt = state.nodes[nodeId] as NodeRuntime;
    const claim = rt.claim as NodeClaim;
    const plan = claim.criteria_settlement as CriteriaSettlement;
    const graph = this.graph();
    // The challenge, judged again as settle judged it (its archive is made here, under the lock that numbers it).
    let judged: ({ ok: true } & JudgedChallenge) | null = null;
    let deferred: UnresolvedCriterionRecord[] = [];
    if (plan.challenged.length > 0) {
      const red = (rt.criteria ?? []).filter((a) => plan.done.includes(a.criterion) && a.test_id !== null);
      const again = result === null ? null : this.judgeChallengeOf(nodeId, result, { done: [...plan.done], doneRedTests: red.filter((a) => a.gate === 'red').map((a) => a.test_id as string), doneTests: red.map((a) => a.test_id as string), cycles: this.sealedCycles(rt), bindings: rt.tdd_red_bindings ?? [] });
      if (again !== null && again.ok) judged = again;
      else deferred = plan.challenged.map((criterion) => ({ criterion, outcome: 'BLOCKED' as const, reason: `its challenge could not be recorded at the integrated head (${again === null ? 'the answer is gone' : again.detail.slice(0, 300)}): ordered again`, decision_request: null }));
    }
    const review = this.requiredReview(state);
    let record: ReviewChallengeRecord | null = null;
    let dispute: string | null = null;
    const at = new Date().toISOString();
    if (judged !== null && review !== null) {
      const brief = rt.rework_brief as ReworkBrief;
      const reviewId = judged.review.review_id;
      const prior = (review.challenges ?? []).filter((c) => c.review_id === reviewId);
      const id = challengeId(reviewId, prior.length + 1);
      const rounds: Record<string, number> = Object.fromEntries(judged.challenge.gaps.map((g) => [g.criterion, prior.filter((c) => c.gaps.some((x) => x.criterion === g.criterion)).length + 1]));
      const disputed = Object.values(rounds).some((n) => n > MAX_CHALLENGE_ROUNDS);
      const archived = archiveChallenge({ controlRoot: this.controlRoot, featureId: this.featureId, id, judged, nodeId, claimId: claim.claim_id, dispatchId: claim.dispatch_id ?? null, generation: brief.generation, rounds, reasonSha256: brief.reason_sha256, partial: { done: plan.done, unresolved: plan.unresolved } });
      this.fault('challenge-archived');
      record = {
        challenge_id: id,
        review_id: reviewId,
        node_id: nodeId,
        status: disputed ? 'disputed' : 'pending',
        gaps: judged.challenge.gaps.map((g) => ({ criterion: g.criterion, round: rounds[g.criterion] ?? 1, reproduction_sha256: g.reproduction_sha256, decision: null })),
        challenge_sha256: judged.challenge_sha256,
        receipt_path: archived.receipt_path,
        receipt_sha256: archived.receipt_sha256,
        claim_id: claim.claim_id,
        dispatch_id: claim.dispatch_id ?? null,
        capability_sha256: claim.capability_sha256 as string,
        generation: brief.generation,
        base_sha: judged.base_sha,
        at,
        refinement: null,
        partial: { done: [...plan.done], unresolved: structuredClone(plan.unresolved) },
      };
      dispute = disputed ? this.disputeDetail(reviewId, record, prior) : null;
    }
    const unresolved = [...plan.unresolved, ...deferred];
    const followUp = record === null && unresolved.length > 0;
    const rec = record;
    // The completions the DONE criteria add (engine/criterion-ledger.ts), archived first and recorded in this same write.
    const completions = this.completionsAtDone(nodeId, state);
    writeCompletionArchive(this.controlRoot, completions.records, completions.copies);
    mutateState(this.paths.featureDir, (s) => {
      if (s.nodes[nodeId]?.claim?.claim_id !== claim.claim_id) throw new Error(`CRITERIA_CHANGED: ${nodeId}'s claim changed while its per-criterion answer was settled; dispatch again.`);
      let next = applyNodeTransition(graph, s, nodeId, 'DONE', { actor: this.owner });
      const n = next.nodes[nodeId] as NodeRuntime;
      if (completions.records.length > 0) Orchestrator.appendLedger(n, completions.base, completions.records);
      if (rec !== null) n.criteria = (n.criteria ?? []).map((c) => (plan.challenged.includes(c.criterion) ? { ...c, challenge_id: rec.challenge_id } : c));
      const e = (n.rework_history ?? []).at(-1);
      if (e !== undefined) {
        e.partial = { claim_id: claim.claim_id, dispatch_id: claim.dispatch_id ?? null, done: [...plan.done], challenged: rec !== null ? [...plan.challenged] : [], unresolved: structuredClone(unresolved), challenge_id: rec?.challenge_id ?? null, follow_up: followUp ? 'pending' : null, order: structuredClone(plan.order), at };
      }
      if (rec !== null) {
        const r = next.acceptance_review as AcceptanceReviewState;
        // A valid challenge of a gap is progress of the review it challenges, and gives back what its rework spent — the challenged criteria's alone.
        r.lineage = appendLineage(this.lineageOf(next), rec.gaps.map((g): LineageEventBody => ({ kind: 'challenge', review_id: rec.review_id, challenge_id: rec.challenge_id, criterion: g.criterion, reproduction_sha256: g.reproduction_sha256, receipt_sha256: rec.receipt_sha256, node_id: nodeId })), at).lineage;
        r.challenges = [...(r.challenges ?? []), rec];
        const reviewed = [...r.reviews].reverse().find((x) => x.review_id === rec.review_id);
        if (reviewed) reviewed.outcome = 'CHALLENGED';
        if (dispute !== null) {
          r.blocked = { code: 'REVIEW_DISPUTE', review_id: rec.review_id, detail: dispute.slice(0, 4000), at };
          next.feature_state = 'BLOCKED';
          next.blocked_reason = `REVIEW_DISPUTE: ${dispute.slice(0, 1000)}`;
        }
        // What a review binds changed: the epoch moves, with the node's lineage.
        bumpEpoch(next, `per-criterion challenge ${rec.challenge_id} of ${rec.review_id}`, [nodeId], at);
      }
      closeLeases(next, (l) => l.node_id === nodeId && l.claim_id === claim.claim_id, 'settled', 'per-criterion settle', at, { outcome: 'CRITERIA_SETTLED', settled_epoch: currentEpoch(next) });
      return next;
    });
    return { worktree: claim.worktree, plan, record, unresolved, followUp, completions: completions.records };
  }

  /** The cycles of the history settle judged and sealed for this claim (its evidence record), or none when it cannot be read as recorded. */
  private sealedCycles(rt: NodeRuntime): TddHistory['cycles'] {
    const h = rt.tdd_history ?? null;
    if (h === null || checkEvidenceOutput(this.controlRoot, this.featureId, { output_path: h.output_path, output_sha256: h.output_sha256 }) !== null) return [];
    try {
      return (JSON.parse(readFileSync(join(this.controlRoot, ...h.output_path.split('/')), 'utf8')) as TddHistory).cycles ?? [];
    } catch {
      return [];
    }
  }

  /** INTEGRATED -> DONE, releasing the claim, its leases and its worktree. */
  private concludeDone(nodeId: string, sessionId: string | null, detail: string, evidence: EvidenceRecord[], result: NodeResult | null = null): NodeRunReport {
    // A per-criterion answer's plan concludes in its own write: DONE with its challenge, its unresolved criteria ordered again.
    if ((this.state().nodes[nodeId]?.claim?.criteria_settlement ?? null) !== null) return this.concludeCriteriaDone(nodeId, sessionId, evidence, result);
    // DONE drops the claim, so remember the worktree before it goes.
    const worktree = this.state().nodes[nodeId]?.claim?.worktree ?? null;
    this.transitionDone(nodeId);
    this.releaseClaim(nodeId);
    this.removeWorktree(nodeId, worktree);
    return this.report(nodeId, 'DONE', sessionId, detail, evidence);
  }

  // ---- the criterion completion ledger (engine/criterion-ledger.ts; CSET-203 r16) -------------------------------

  /** A node's completion records: its own, or those its rework history implies (a state from before the ledger). */
  private ledgerFor(nodeId: string, state: FeatureState_ = this.state()): CriterionCompletion[] {
    const node = this.node(nodeId);
    const rt = state.nodes[nodeId];
    if (rt === undefined || node.repository === null) return [];
    return ledgerOf({ controlRoot: this.controlRoot, featureId: this.featureId, graph: this.graph(), node, runtime: rt, repoPath: repositoryPath(this.workspace, node.repository), policy: rt.claim?.tdd_policy ?? this.claimTddPolicy(node.repository) });
  }

  /**
   * The records the generation settling DONE adds (one per criterion it accepted, never twice for the same claim) and
   * the files they archive: none for a controller or verification node, or a node that serves no criterion.
   */
  private completionsAtDone(nodeId: string, state: FeatureState_): { records: CriterionCompletion[]; copies: ArchiveCopy[]; base: CriterionCompletion[] } {
    const node = this.node(nodeId);
    const rt = state.nodes[nodeId];
    const none = { records: [], copies: [], base: [] };
    if (rt === undefined || node.repository === null || CONTROLLER_NODE_TYPES.has(node.node_type) || node.node_type === 'verification' || (rt.criteria ?? []).length === 0) return none;
    const claim = rt.claim;
    const brief = rt.rework_brief ?? null;
    const origin = brief?.origin?.kind === 'acceptance-review' ? brief.origin : null;
    const ledger = this.ledgerFor(nodeId, state);
    const made = completionsOf({
      controlRoot: this.controlRoot,
      featureId: this.featureId,
      graph: this.graph(),
      node,
      runtime: rt,
      ledger,
      repoPath: repositoryPath(this.workspace, node.repository),
      policy: claim?.tdd_policy ?? this.claimTddPolicy(node.repository),
      generation: claim?.generation ?? brief?.generation ?? (rt.rework_history ?? []).filter(stoodRework).length,
      claimId: claim?.claim_id ?? null,
      dispatchId: claim?.dispatch_id ?? null,
      base: claim?.seal?.base_sha ?? claim?.base_sha ?? rt.branch_base_sha ?? null,
      // A re-proof unit settle committed on the sealed head is the generation's head (engine/proof-units.ts).
      head: claim?.reproof_unit?.commit ?? claim?.seal?.head_sha ?? rt.tdd_history?.head_sha ?? null,
      integrated: rt.integrated_sha,
      order: origin === null ? null : { review_id: origin.review_id, revision: origin.revision ?? null, receipt_sha256: origin.receipt_sha256 ?? null, gaps: structuredClone(brief?.review_gaps ?? []) },
      snapshots: [...(claim?.challenge_reds ?? []), ...(claim?.challenge_red ? [claim.challenge_red] : [])],
      reproofCommit: claim?.reproof_unit?.commit ?? null,
      settledAt: new Date().toISOString(),
    });
    // A state from before the ledger writes down the records its history implies first.
    return { ...made, base: rt.criterion_ledger === undefined ? ledger : [] };
  }

  /** The node's ledger with `records` appended (a derived ledger written down first), each record once, bounded. */
  private static appendLedger(rt: NodeRuntime, base: readonly CriterionCompletion[], records: readonly CriterionCompletion[]): void {
    const own = rt.criterion_ledger ?? [...base];
    const fresh = records.filter((r) => !own.some((x) => x.record_id === r.record_id || (x.criterion === r.criterion && x.generation === r.generation && x.claim_id === r.claim_id)));
    rt.criterion_ledger = [...own, ...fresh].slice(-MAX_LEDGER_RECORDS);
  }

  /**
   * INTEGRATED -> DONE and the completions the generation adds, in one STATE.json write (their archives copied
   * first, byte for byte): a settle interrupted on either side records them once.
   */
  private transitionDone(nodeId: string): void {
    const graph = this.graph();
    const made = this.completionsAtDone(nodeId, this.state());
    writeCompletionArchive(this.controlRoot, made.records, made.copies);
    mutateState(this.paths.featureDir, (s) => {
      const next = applyNodeTransition(graph, s, nodeId, 'DONE', { actor: this.owner });
      const rt = next.nodes[nodeId];
      if (rt !== undefined && made.records.length > 0) Orchestrator.appendLedger(rt, made.base, made.records);
      return next;
    });
    this.event('node.transition', nodeId, { to: 'DONE' });
    this.completedEvent(nodeId, made.records);
  }

  /**
   * Why a generation that relies on a completed or carried proof changed production code no RED of its own drives, or
   * null: each production run of its history follows a RED binding whose failing tests include one this answer proves a
   * DONE criterion by, as its own RED (CSET-203 r16: production is never laundered behind a carried proof).
   */
  private productionUndriven(runtime: NodeRuntime, accepted: readonly AcceptedCriterionRecord[], cycles: TddHistory['cycles']): string | null {
    if (!accepted.some((a) => a.carried === true || a.reproof != null)) return null;
    const own = accepted.filter((a) => a.gate === 'red' && a.carried !== true && a.reproof == null && a.test_id !== null);
    const ids = new Set(own.map((a) => a.test_id as string));
    const bindings = runtime.tdd_red_bindings ?? [];
    for (const c of cycles) {
      if (c.green_commits.length === 0) continue;
      const b = bindings.find((x) => x.evidence_sha256 !== null && x.evidence_sha256 === (c.red_binding?.evidence_sha256 ?? null));
      const byId = (b?.red_tests ?? []).some((t) => t.status === 'failed' && ids.has(t.id));
      const byName = c.declared.some((d) => own.some((a) => a.test !== null && a.test.path === d.file && namesDeclaration(a.test.path, a.test.name, d.name)));
      if (!byId && !byName) {
        return `the production commit ${String(c.green_commits[0]).slice(0, 12)} follows a RED none of whose failing tests proves a criterion this answer proves DONE by its own RED; a generation that carries completed criteria changes production code only for a criterion it proves with its own RED cycle`;
      }
    }
    return null;
  }

  /**
   * The RED a generation stands on, judged per criterion: its own when it ran a RED cycle (the history bound each to an
   * accepted RED) or keeps one it recorded; when it ran none and changed no production code, the attested RED of a
   * completion it carries or re-proves (its completion record's, with where it came from); none at all when its work is
   * compatibility alone; else missing — a new behaviour DONE needs a RED.
   */
  private generationRed(nodeId: string, runtime: NodeRuntime, accepted: readonly AcceptedCriterionRecord[], cycles: TddHistory['cycles']):
    | { kind: 'own' }
    | { kind: 'carried'; record: EvidenceRecord }
    | { kind: 'compatibility' }
    | { kind: 'missing'; detail: string; criterion: string | null } {
    const node = this.node(nodeId);
    if (!redRequired(node, runtime) || cycles.length > 0) return { kind: 'own' };
    const red = runtime.evidence.red;
    // A RED recorded on tests the sealed head does not declare (CSET-201 final: a re-proof's first, failing run of tests it then
    // fixed and kept out of the branch) is no generation's own: kept, it is what a later generation would cite for a proof
    // nothing holds.
    if (red !== undefined && red.exit_code !== 0 && red.red_reason === 'behaviour-missing' && red.carried_from == null && this.redDeclared(nodeId, red)) return { kind: 'own' };
    // A node re-proving its own settled generation (an upstream rework reopened it) keeps the RED it settled on — a carried
    // one too — cited as its recorded RED: nothing to carry anew.
    if (red !== undefined && red.carried_from != null && runtime.rework_brief == null && accepted.some((a) => a.gate === 'red' && a.carried !== true && a.output_sha256 === red.output_sha256)) return { kind: 'own' };
    const graph = this.graph();
    const ledger = this.ledgerFor(nodeId);
    // The completions this answer carries: each carried proof's record, the RED it stood on.
    const proofs = runtime.carried_criterion_proofs ?? [];
    const ids: string[] = [];
    for (const a of accepted.filter((x) => x.carried === true)) {
      const id = a.carried_from?.record_id ?? proofs.find((p) => p.criterion === a.criterion && p.test_id === a.test_id && p.output_sha256 === a.output_sha256)?.record_id ?? null;
      if (id != null && !ids.includes(id)) ids.push(id);
    }
    // The RED it already stands on first, when it is still one of them.
    const now = red?.carried_from?.record_id ?? null;
    const ordered = now !== null && ids.some((id) => rootCompletion(ledger, ledger.find((r) => r.record_id === id) as CriterionCompletion)?.record_id === now) ? [now, ...ids] : ids;
    const carried = carriedRed(this.controlRoot, this.featureId, ledger, ordered);
    if (carried !== null) return { kind: 'carried', record: carried };
    const behaviours = accepted.filter((a) => criterionKind(graph, a.criterion) === 'new-behavior' && a.carried !== true);
    if (behaviours.length === 0) return { kind: 'compatibility' };
    const ac = behaviours[0]?.criterion ?? null;
    return { kind: 'missing', criterion: ac, detail: `${ac ?? 'a new behaviour'} is DONE in this answer, but this generation ran no RED cycle and carries no completed RED: a new behaviour is proved by a RED that failed for its missing behaviour (its own red gate, then the fix), or — completed by an earlier generation and ordered again — by its completed proof and the review's reproduction re-proved` };
  }

  /** Whether every test a RED failed for a missing behaviour is declared at the node's sealed head (when Mycelink can tell). */
  private redDeclared(nodeId: string, red: EvidenceRecord): boolean {
    const node = this.node(nodeId);
    const head = this.state().nodes[nodeId]?.claim?.seal?.head_sha ?? null;
    if (node.repository === null || head === null) return true;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const cache = new Map<string, string | null>();
    // The RED's own declared names (its reader's, never a report's): still declared while a test of the file carries each (a name
    // two nested classes share included); one no test of the head carries is not.
    return (red.red_tests ?? []).filter((t) => t.status === 'failed').every((t) => {
      const declared = declarationAt(repoPath, head, { path: t.file.replace(/\\/g, '/'), full_name: t.name }, cache);
      return declared.status !== 'missing' && declared.status !== 'mismatch';
    });
  }

  /** Whether the worker's own delta (its claim's base to `head`) changed a carried completion's test or production code. */
  private workerTouched(nodeId: string, proof: CarriedCriterionProof, head: string): boolean {
    const node = this.node(nodeId);
    const rt = this.state().nodes[nodeId];
    const base = rt?.claim?.base_sha ?? rt?.branch_base_sha ?? null;
    if (node.repository === null || base === null) return true;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const changed = new Set(runGit(repoPath, ['diff', '--name-only', '-z', '--no-renames', base, head], { allowFail: true }).stdout.split('\0').filter((p) => p !== ''));
    if (changed.has(proof.test.path)) return true;
    const ledger = this.ledgerFor(nodeId);
    const rec = proof.record_id ? ledger.find((r) => r.record_id === proof.record_id) : undefined;
    if (rec === undefined) return true;
    return rootCompletion(ledger, rec).production.paths.some((p) => changed.has(p.path));
  }

  // ---- sibling progress (engine/criterion-coverage.ts; CSET-201 final) ----------------------------------------

  /** The ledgers coverage is judged from: every producer node of `repository` (all repositories when null) but `except`. */
  private coverageNodes(repository: string | null, except: string | null = null): { node_id: string; repository: string; ledger: CriterionCompletion[]; repoPath: string; policy: TddPolicy }[] {
    const state = this.state();
    return this.graph()
      .nodes.filter((n) => n.repository !== null && n.id !== except && (repository === null || n.repository === repository) && !CONTROLLER_NODE_TYPES.has(n.node_type) && n.node_type !== 'verification')
      .map((n) => ({ node_id: n.id, repository: n.repository as string, ledger: this.ledgerFor(n.id, state), repoPath: repositoryPath(this.workspace, n.repository as string), policy: state.nodes[n.id]?.claim?.tdd_policy ?? this.claimTddPolicy(n.repository as string) }))
      .filter((n) => n.ledger.length > 0);
  }

  /** Every sibling's standing completion `from` holds and `to` does not: what integrating `to` would lose. */
  private progressLost(nodeId: string, repository: string, from: string, to: string): CompletionCoverage[] {
    const nodes = this.coverageNodes(repository, nodeId);
    if (nodes.length === 0) return [];
    const at = (sha: string) => coverageManifest({ controlRoot: this.controlRoot, featureId: this.featureId, criteria: [], nodes, heads: [{ name: repository, head_sha: sha }] });
    const before = at(from).criteria.flatMap((c) => c.completions).filter((c) => c.holds);
    if (before.length === 0) return [];
    const after = at(to).criteria.flatMap((c) => c.completions);
    return before.filter((b) => after.some((a) => a.node_id === b.node_id && a.record_id === b.record_id && !a.holds)).map((b) => after.find((a) => a.node_id === b.node_id && a.record_id === b.record_id) as CompletionCoverage);
  }

  /**
   * A branch whose head no longer holds the commit its claim started from, rebuilt on an older one of its history (CSET-201
   * final: the planner's second rework on the head R001 reviewed, before either re-proof unit): stale, with what
   * integrating it as it stands would lose. Null when the head shares no history with that commit (an ownership violation).
   */
  private staleBase(nodeId: string, head: string): { cause: 'stale-base'; lost: CompletionCoverage[]; conflicts: string[]; head: string; from: string } | null {
    const node = this.node(nodeId);
    const rt = this.state().nodes[nodeId];
    const pinned = rt?.claim?.base_sha ?? rt?.branch_base_sha ?? null;
    if (node.repository === null || pinned === null) return null;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const mb = runGit(repoPath, ['merge-base', head, pinned], { allowFail: true }).stdout.trim();
    if (mb === '' || mb === pinned || !isAncestor(repoPath, mb, pinned)) return null;
    // Its own delta from where it forked must stay inside its fence: a stale branch that also writes another node's paths is an ownership violation.
    const changed = runGit(repoPath, ['diff', '--name-only', '-z', '--no-renames', mb, head], { allowFail: true }).stdout.split('\0').filter((x) => x !== '');
    if (changed.some((path) => !node.allowed_paths.some((g) => matchGlob(g, path)) || (node.forbidden_paths ?? []).some((g) => matchGlob(g, path)))) return null;
    return { cause: 'stale-base', lost: this.progressLost(nodeId, node.repository, pinned, head), conflicts: [], head, from: pinned };
  }

  /**
   * Refuse to integrate a node's work that would lose a sibling's standing proof, or that conflicts with it, or that a
   * branch rebuilt on an older head holds (CSET-201 final): nothing integrated or charged; the branch archived by the next
   * claim, which starts afresh from the latest integration head and hands its worker the reason. The same order refused
   * past MAX_SIBLING_LOSSES times is charged: a worker that keeps erasing a sibling's work does not loop for free.
   */
  private siblingProgressLost(nodeId: string, sessionId: string | null, loss: { cause: 'stale-base' | 'delta' | 'conflict'; lost: CompletionCoverage[]; conflicts: string[]; head: string; from: string }, evidence: EvidenceRecord[]): NodeRunReport {
    this.undoReproofUnit(nodeId);
    const rt = this.state().nodes[nodeId];
    const claim = rt?.claim ?? null;
    const generation = claim?.generation ?? rt?.rework_brief?.generation ?? 0;
    const prior = rt?.sibling_progress ?? null;
    const count = prior !== null && prior.generation === generation ? prior.count + 1 : 1;
    const named = loss.lost.map((l) => `${l.node_id} ${l.criterion} (${l.record_id}: ${l.code})`).join('; ');
    const why =
      loss.cause === 'stale-base'
        ? `${workerBranchName(this.featureId, nodeId)} at ${loss.head.slice(0, 12)} was rebuilt on an older head and no longer holds ${loss.from.slice(0, 12)}, the integration head its claim started from${named !== '' ? `; integrated, it would erase ${named}` : ''}`
        : loss.cause === 'conflict'
          ? `integrating it conflicts with a sibling's integrated work in ${loss.conflicts.join(', ') || '(unknown files)'}`
          : `integrating it would lose ${named}, which the integration head ${loss.from.slice(0, 12)} holds`;
    const detail = `SIBLING_PROGRESS_LOST: ${why}`.slice(0, 3500);
    if (count > MAX_SIBLING_LOSSES) {
      const report = this.failAttempt(nodeId, sessionId, `${detail} (refused ${count} times for this order: charged)`.slice(0, 2000), evidence);
      return { ...report, outcome: 'VERIFICATION_FAILED' };
    }
    const at = new Date().toISOString();
    mutateState(this.paths.featureDir, (s) => {
      const n = s.nodes[nodeId];
      if (n === undefined) return s;
      n.sibling_progress = { code: 'SIBLING_PROGRESS_LOST', cause: loss.cause, generation, count, lost: loss.lost.slice(0, 64).map((l) => ({ node_id: l.node_id, criterion: l.criterion, record_id: l.record_id, code: l.code })), conflicts: loss.conflicts.slice(0, 64), head: loss.head, from: loss.from, detail, at };
      // The order starts again from the latest integration head: nothing the refused branch was gated with carries over.
      n.fresh_branch_required = true;
      n.branch_base_sha = null;
      n.evidence = {};
      n.tdd_red_bindings = [];
      return s;
    });
    if (claim !== null) this.releaseForPrecondition(nodeId, claim.claim_id, detail.slice(0, 500));
    this.event('node.sibling_progress_lost', nodeId, { claim_id: claim?.claim_id ?? null, cause: loss.cause, count, lost: loss.lost.map((l) => ({ node_id: l.node_id, criterion: l.criterion, record_id: l.record_id, code: l.code })), conflicts: loss.conflicts.slice(0, 16), head: loss.head, from: loss.from });
    return this.report(nodeId, 'PRECONDITION_FAILED', sessionId, `${detail}. Nothing was charged or integrated; the order is reissued from the latest integration head (refusal ${count} of ${MAX_SIBLING_LOSSES} uncharged): run dispatch.`, evidence);
  }

  /** The coverage manifest of every standing completion at `heads` (engine/criterion-coverage.ts). */
  private coverageAt(heads: readonly { name: string; head_sha: string }[]): CoverageManifest {
    const graph = this.graph();
    return coverageManifest({ controlRoot: this.controlRoot, featureId: this.featureId, criteria: graph.acceptance_criteria.map((a) => a.id), nodes: this.coverageNodes(null), heads });
  }

  /**
   * The completed criterion's proof a restoration order carries (CSET-201 final): the newest record of its standing chain —
   * then its parents — whose root RED's test the current head still declares and whose RED is archived: the original RED,
   * preserved; the worker re-proves the criterion on it (a re-proof, committed by settle).
   */
  private restorationProof(nodeId: string, criterion: string, state: FeatureState_): CarriedCriterionProof | null {
    const node = this.node(nodeId);
    if (node.repository === null) return null;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const head = state.integration_heads?.[node.repository] ?? null;
    const ledger = this.ledgerFor(nodeId, state);
    let at: CriterionCompletion | undefined = [...ledger].reverse().find((r) => r.criterion === criterion);
    for (let hops = 0; at !== undefined && hops < 64; hops++) {
      const root = rootCompletion(ledger, at);
      const test = root.proof.test;
      const red = root.red?.record ?? null;
      if (test !== null && root.proof.test_id !== null && red !== null && root.red !== null && head !== null && declaredAt(repoPath, head, test.path, test.name) !== false && checkEvidenceOutput(this.controlRoot, this.featureId, red) === null) {
        return { criterion, test_id: root.proof.test_id, test: { ...test }, source_generation: root.generation, source_claim_id: root.claim_id, source_dispatch_id: root.dispatch_id, repo_sha: root.repo.integrated_sha ?? root.repo.head_sha, gate: 'red', output_sha256: root.red.output_sha256, output_path: red.output_path, record_id: root.record_id, record_sha256: root.sha256, ordered: true };
      }
      const parent: string | null = at.parent;
      at = parent === null ? undefined : ledger.find((r) => r.record_id === parent);
    }
    return null;
  }

  /**
   * Restoration orders for completed proofs a reviewed head lost (CSET-201 final): one per producer, for exactly the criteria
   * it lost, its reason naming what is missing and where an archived copy of it is; never an accepted rework of those
   * criteria (no budget spent), its original RED carried. A node `into` already orders gets the criteria added to that order.
   */
  private planRestorations(args: { reviewId: string; review: number; receiptPath: string; lost: readonly CompletionCoverage[]; gaps: readonly Gap[]; state: FeatureState_; graph: PortfolioGraph; summary: LineageSummary; into: ReworkPlan[] }): { plans: ReworkPlan[]; refused: { node_id: string; criteria: string[]; detail: string }[] } {
    const plans: ReworkPlan[] = [];
    const refused: { node_id: string; criteria: string[]; detail: string }[] = [];
    for (const nodeId of [...new Set(args.lost.map((l) => l.node_id))]) {
      const mine = args.lost.filter((l) => l.node_id === nodeId);
      const criteria = [...new Set(mine.map((l) => l.criterion))].sort();
      const restoration = mine.map((l) => ({ criterion: l.criterion, record_id: l.record_id, code: l.code }));
      const proofs = criteria.map((c) => this.restorationProof(nodeId, c, args.state)).filter((p): p is CarriedCriterionProof => p !== null);
      const existing = args.into.find((p) => p.nodeId === nodeId);
      if (existing !== undefined) {
        for (const c of criteria) if (!existing.acceptance.includes(c)) existing.acceptance.push(c);
        existing.brief.acceptance_criteria = [...new Set([...existing.brief.acceptance_criteria, ...criteria])];
        existing.carriedProofs = [...existing.carriedProofs.filter((p) => !criteria.includes(p.criterion)), ...proofs];
        existing.origin = { ...(existing.origin as ReworkOrigin), restoration };
        if (existing.brief.origin !== undefined) existing.brief.origin = { ...existing.brief.origin, restoration };
        continue;
      }
      const gaps: Gap[] = criteria.map((c) => {
        const reviewer = args.gaps.find((g) => g.criterion === c);
        const what = mine.filter((l) => l.criterion === c);
        const missing = what.map((l) => (l.detail ?? l.code ?? 'its proof is not in the head').slice(0, 400)).join('; ');
        const tests = what.flatMap((l) => l.tests.filter((t) => t.declared === false).map((t) => `${t.path} › ${t.name}`));
        const archived = this.archivedCopies(nodeId, what.flatMap((l) => l.tests.filter((t) => t.declared === false)));
        return {
          criterion: c,
          missing: `its completed proof is lost at the reviewed head: ${missing}`,
          reproduction: `Restore ${c}'s proof: ${tests.join('; ') || 'the tests its completion stands on'}${archived.length > 0 ? `; archived copies as they ran: ${archived.join(', ')}` : ''}. Write them on the unchanged base, run the red gate (they pass: a re-proof), keep them out of the branch and cite the completed proof with that re-proof${reviewer !== undefined ? `. The review found: ${reviewer.reproduction.slice(0, 400)}` : ''}`,
          producer: { node_id: nodeId },
          confidence: 'high',
        };
      });
      const budgets = Object.fromEntries(criteria.map((c): [string, ReasonBudget] => [c, { used: args.summary.criteria[c]?.accepted_reworks ?? 0, max: args.summary.criteria[c]?.max ?? args.summary.max_criterion_reworks, ceiling: args.summary.criteria[c]?.ceiling ?? args.summary.criterion_ceiling, basis: 'regression' }]));
      const reason = gapReason({ reviewId: args.reviewId, review: args.review, budgets, gaps, kindOf: (ac) => criterionKind(args.graph, ac) });
      const origin: ReworkOrigin = { kind: 'acceptance-review', review_id: args.reviewId, review: args.review, restoration };
      try {
        // Only a reviewer's own gap binds the order to its review's revision; a restoration it never found binds none.
        const reviewGaps = args.gaps.filter((g) => criteria.includes(g.criterion)).map((g) => ({ criterion: g.criterion, reproduction_sha256: reproductionSha256(g.reproduction) }));
        const planned = this.planRework(nodeId, { reason, acceptance: criteria, exactAcceptance: true, evidence: [args.receiptPath], origin, ...(reviewGaps.length > 0 ? { reviewGaps } : {}) }, args.state, args.graph);
        if ('idempotent' in planned) continue;
        planned.carriedProofs = [...planned.carriedProofs.filter((p) => !criteria.includes(p.criterion)), ...proofs];
        plans.push(planned);
      } catch (err) {
        if (!(err instanceof ReworkRefusedError)) throw err;
        refused.push({ node_id: nodeId, criteria, detail: err.message.slice(0, 600) });
      }
    }
    return { plans, refused };
  }

  /** Archived copies of the node's lost tests as they ran (its ledger's re-proof archives), relative to the control root. */
  private archivedCopies(nodeId: string, tests: readonly { path: string; name: string }[]): string[] {
    const out: string[] = [];
    for (const r of [...this.ledgerFor(nodeId)].reverse()) {
      for (const f of r.reproof?.files ?? []) {
        if (!tests.some((t) => t.path === f.path) || out.includes(f.archived)) continue;
        try {
          const source = readFileSync(join(this.controlRoot, ...f.archived.split('/')), 'utf8');
          if (tests.some((t) => t.path === f.path && declaredTests(f.path, source).some((d) => namesDeclaration(t.path, t.name, d.name)))) out.push(f.archived);
        } catch {
          continue;
        }
      }
    }
    return out.slice(0, 8);
  }

  /**
   * Before a review is handed out: every standing completion at the heads it would review (CSET-201 final). A lost one is
   * restored first — the order made in one write with its lineage fact, nothing spent, no reviewer started — and the
   * dispatch goes on ('restored'); a restoration that cannot be ordered blocks the review (its detail); else null.
   */
  private restoreLostProofs(state: FeatureState_): 'restored' | string | null {
    const review = this.requiredReview(state);
    const last = review?.reviews[review.reviews.length - 1] ?? null;
    const now = this.reviewInputsNow(state);
    if (review === null || last === null || now === null) return null;
    const lost = lostCompletions(this.coverageAt(now.inputs.repositories));
    if (lost.length === 0) return null;
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'deliver.lock'), () => {
      const fresh = this.state();
      const graph = this.graph();
      const summary = this.lineageSummary(fresh);
      const planned = this.planRestorations({ reviewId: last.review_id, review: last.review, receiptPath: last.receipt_path, lost, gaps: [], state: fresh, graph, summary, into: [] });
      if (planned.refused.length > 0) {
        const detail = `REVIEW_GAPS: completed proofs are lost at the heads to be reviewed and cannot be restored: ${planned.refused.map((r) => `${r.node_id} (${r.criteria.join(', ')}): ${r.detail}`).join('; ')}`;
        this.blockReview('REVIEW_GAPS', last.review_id, detail, [...new Set(planned.refused.flatMap((r) => r.criteria))], true);
        return detail;
      }
      if (planned.plans.length === 0) return null;
      const at = new Date().toISOString();
      mutateState(this.paths.featureDir, (s) => {
        let next = s;
        for (const plan of planned.plans) next = this.applyReworkPlan(next, plan, graph);
        const r = next.acceptance_review as AcceptanceReviewState;
        r.lineage = appendLineage(this.lineageOf(next), regressionEvents(last.review_id, planned.plans), at).lineage;
        return next;
      });
      for (const plan of planned.plans) this.reworkMade(plan);
      this.event('review.proofs_restored', null, { review_id: last.review_id, lost: lost.map((l) => ({ node_id: l.node_id, criterion: l.criterion, record_id: l.record_id, code: l.code })), reworks: planned.plans.map((p) => p.nodeId) });
      return 'restored';
    }, { timeoutMs: 15_000, pollMs: 50, purpose: 'proof restoration' });
  }

  // ---- re-proof units (engine/proof-units.ts; CSET-201 final) -------------------------------------------------

  /**
   * Commit the re-proof the generation's answer was accepted with into the product (CSET-201 final): the test files of
   * each red-gate snapshot an accepted re-proof cites, exactly as the gate ran them (the bytes hashed as recorded),
   * applied to the sealed head as a test-only unit of the controller's, carrying the `Mycelink-Reproof` trailer. The
   * unit is journaled on the claim before the node branch moves to it; an interrupted settle finishes at exactly it.
   * Nothing when the answer cites no re-proof, or its files already stand at the head as they ran; held, nothing
   * charged, when they conflict with the worker's own later change or would remove or edit a test the head holds.
   */
  private materializeReproof(nodeId: string, sealed: string): { kind: 'none' } | { kind: 'committed'; commit: string } | { kind: 'held'; criterion: string; detail: string } {
    const node = this.node(nodeId);
    const rt = this.state().nodes[nodeId];
    const claim = rt?.claim ?? null;
    const reproofs = (rt?.criteria ?? []).filter((a) => a.reproof != null);
    if (node.repository === null || claim === null || reproofs.length === 0) return { kind: 'none' };
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    const done = claim.reproof_unit ?? null;
    if (done !== null && done.from === sealed) {
      const at = resolveRef(repoPath, branch);
      if (at === sealed) runGit(repoPath, ['update-ref', `refs/heads/${branch}`, done.commit, sealed]);
      return { kind: 'committed', commit: done.commit };
    }
    const outputs = [...new Set(reproofs.map((a) => (a.reproof as { gate_output_sha256: string }).gate_output_sha256))];
    const snapshots = [...(claim.challenge_reds ?? []), ...(claim.challenge_red ? [claim.challenge_red] : [])].filter((x) => outputs.includes(x.evidence_sha256)).sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : 0));
    const criteria = [...new Set(reproofs.map((a) => a.criterion))].sort();
    // Each file once: the latest run of it.
    const byPath = new Map<string, ProofFile>();
    for (const snap of snapshots) {
      for (const f of snap.files) {
        const file = join(this.controlRoot, ...f.copy.split('/'));
        if (!existsSync(file)) return { kind: 'held', criterion: criteria[0] as string, detail: `REPROOF_UNIT_REFUSED:REPROOF_TAMPERED: ${f.path}: the red gate's copy of what it ran is gone` };
        byPath.set(f.path, { path: f.path, bytes: readFileSync(file), sha256: f.sha256, base_blob: runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${snap.head_sha}:${f.path}`], { allowFail: true }).stdout.trim() || null });
      }
    }
    const plan = planProofUnit(repoPath, sealed, [...byPath.values()]);
    if (plan.kind === 'refused') return { kind: 'held', criterion: criteria[0] as string, detail: `REPROOF_UNIT_REFUSED:${plan.code}: ${plan.detail}` };
    if (plan.kind === 'none') return { kind: 'none' };
    const order = rt?.rework_brief?.origin?.review_id ?? null;
    const commit = commitProofUnit(repoPath, sealed, plan, {
      subject: `test(${nodeId}): re-proof of ${criteria.join(', ')}${order !== null ? ` for ${order}` : ''}`,
      body: `The tests the red gate${outputs.length === 1 ? '' : 's'} ${outputs.map((o) => o.slice(0, 16)).join(', ')} ran and passed on the unchanged base, committed by Mycelink settle exactly as they ran, for claim ${claim.claim_id}${claim.dispatch_id ? ` (dispatch ${claim.dispatch_id})` : ''}.`,
      criteria,
    });
    const at = new Date().toISOString();
    mutateState(this.paths.featureDir, (st) => {
      const c = st.nodes[nodeId]?.claim;
      if (c?.claim_id === claim.claim_id) c.reproof_unit = { from: sealed, commit, criteria, files: plan.files.map((f) => ({ path: f.path, blob: f.blob })), gate_outputs: outputs, at };
      return st;
    });
    this.fault('reproof-committed');
    runGit(repoPath, ['update-ref', `refs/heads/${branch}`, commit, sealed]);
    this.event('node.reproof_committed', nodeId, { claim_id: claim.claim_id, commit, from: sealed, criteria, files: plan.files.map((f) => f.path), gate_outputs: outputs });
    return { kind: 'committed', commit };
  }

  /** The node branch back on the sealed head and the unit off the claim: a settle that does not go on keeps no commit of the controller's. */
  private undoReproofUnit(nodeId: string): void {
    const node = this.node(nodeId);
    const claim = this.state().nodes[nodeId]?.claim ?? null;
    const unit = claim?.reproof_unit ?? null;
    if (unit === null || claim === null || node.repository === null) return;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    if (resolveRef(repoPath, branch) === unit.commit) runGit(repoPath, ['update-ref', `refs/heads/${branch}`, unit.from, unit.commit]);
    mutateState(this.paths.featureDir, (st) => {
      const c = st.nodes[nodeId]?.claim;
      if (c?.claim_id === claim.claim_id) c.reproof_unit = null;
      return st;
    });
  }

  /** Why an accepted re-proof does not hold at the verified head, or null: a test it cites that the fresh verification's report did not pass. */
  private reproofUnproved(nodeId: string, fresh: readonly EvidenceRecord[]): { criterion: string; detail: string } | null {
    const items = (this.state().nodes[nodeId]?.criteria ?? []).filter((a) => a.reproof != null);
    if (items.length === 0) return null;
    const reports = fresh.map((r) => readGateTests(this.controlRoot, r)).filter((t): t is NonNullable<typeof t> => t !== null);
    if (reports.length === 0) return null;
    for (const a of items) {
      for (const t of a.reproof?.tests ?? []) {
        if (!reports.some((tests) => tests.some((x) => x.id === t.test_id && x.status === 'passed'))) {
          return { criterion: a.criterion, detail: `REPROOF_NOT_PASSING: ${a.criterion}'s re-proof test ${t.full_name} (${t.test_id}) did not pass in the fresh verification of the re-proof unit` };
        }
      }
    }
    return null;
  }

  /**
   * Hold a re-proof settle cannot commit or that does not pass at its unit (CSET-201 final): the claim kept, nothing charged
   * or integrated; the worker runs the review's reproduction through the red gate again on its submitted head and cites
   * that run as the re-proof. Judged again on the resubmission.
   */
  private holdReproof(nodeId: string, sessionId: string | null, criterion: string, detail: string, evidence: EvidenceRecord[], head: string): NodeRunReport {
    mutateState(this.paths.featureDir, (st) => {
      const c = st.nodes[nodeId]?.claim;
      if (c) c.criteria_judged = null;
      return st;
    });
    return this.holdForEvidenceCorrection(nodeId, sessionId, { code: 'CRITERION_REPROOF_REQUIRED', detail: `${detail}. Write the review's reproduction on your submitted head as it is now (add tests only, after the ones there), run the red gate on it (mycelink tdd cycle first if the gate asks), keep it out of the branch, and cite that red gate's output as the re-proof; nothing was charged or integrated`, candidates: [], criterion }, evidence, head);
  }

  /**
   * A carried completion the fresh verification of the sealed head did not hold, though the worker's own work never
   * touched its test or code: the base no longer holds it (CSET-203 r16). Reopened on its own — ordered by this
   * generation's own proof — the claim handed back unspent (its branch and commits kept for the next worker), nothing
   * charged, nothing integrated.
   */
  private reopenAtSettle(nodeId: string, sessionId: string | null, proof: CarriedCriterionProof, detail: string, evidence: EvidenceRecord[]): NodeRunReport {
    const rt = this.state().nodes[nodeId];
    const claim = rt?.claim ?? null;
    const base = claim?.base_sha ?? rt?.branch_base_sha ?? '';
    const at = new Date().toISOString();
    const graph = this.graph();
    const reopened: ReopenedCriterion = { criterion: proof.criterion, record_id: proof.record_id ?? 'none', code: 'COMPLETION_TEST_FAILED', detail: `COMPLETION_TEST_FAILED: ${detail}`.slice(0, 2000), base_sha: base, at };
    mutateState(this.paths.featureDir, (s) => {
      const n = s.nodes[nodeId];
      const brief = n?.rework_brief ?? null;
      if (n === undefined || brief === null || (claim !== null && n.claim?.claim_id !== claim.claim_id)) return s;
      n.carried_criterion_proofs = (n.carried_criterion_proofs ?? []).filter((x) => !(x.criterion === proof.criterion && x.output_sha256 === proof.output_sha256));
      if (!brief.acceptance_criteria.includes(proof.criterion)) brief.acceptance_criteria = [...brief.acceptance_criteria, proof.criterion];
      brief.reopened = [...(brief.reopened ?? []), reopened];
      if (criterionKind(graph, proof.criterion) === 'new-behavior') delete brief.red_required;
      return s;
    });
    if (claim !== null) this.releaseForPrecondition(nodeId, claim.claim_id, `CRITERION_REOPENED: ${proof.criterion}: ${detail}`.slice(0, 500));
    this.event('node.criterion_reopened', nodeId, { claim_id: claim?.claim_id ?? null, criterion: proof.criterion, record_id: proof.record_id ?? null, code: reopened.code, detail: detail.slice(0, 500), base_sha: base, at_settle: true });
    return this.report(nodeId, 'PRECONDITION_FAILED', sessionId, `CRITERION_REOPENED: ${proof.criterion}'s completed proof does not hold on this head (${detail.slice(0, 400)}), and this generation's own work never touched its test or code: it is reopened on its own — ordered by this generation's own proof — and the claim handed back unspent; nothing was charged or integrated. Run dispatch.`, evidence);
  }

  private completedEvent(nodeId: string, records: readonly CriterionCompletion[]): void {
    if (records.length === 0) return;
    this.event('node.criteria_completed', nodeId, { records: records.map((r) => ({ record_id: r.record_id, criterion: r.criterion, basis: r.basis, generation: r.generation, source: r.source, sha256: r.sha256 })) });
  }

  /**
   * The completed criteria a rework's generation relies on — each carried or re-provable proof its brief holds —
   * revalidated on the claim's base before any worker runs (CSET-203 r16): intact, its completed work in the base,
   * its test as proved, its production change still there or changed by someone else only where its test still passes
   * on the base (the module's own command, run there once when the base is not the head it was proved at). A
   * completion that no longer holds is reopened — ordered by this generation's own proof (or, a review gap of a
   * criterion whose test alone changed, re-provable) — in one write, never charged; the rest is carried.
   */
  private revalidateCompletions(nodeId: string, claimId: string): void {
    const state = this.state();
    const rt = state.nodes[nodeId];
    const claim = rt?.claim ?? null;
    const node = this.node(nodeId);
    if (rt === undefined || claim === null || claim.claim_id !== claimId || node.repository === null || (rt.rework_brief ?? null) === null) return;
    const proofs = (rt.carried_criterion_proofs ?? []).filter((p) => typeof p.record_id === 'string');
    const base = claim.base_sha ?? rt.branch_base_sha ?? null;
    if (proofs.length === 0 || base === null) return;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const policy = claim.tdd_policy ?? this.claimTddPolicy(node.repository);
    const ledger = this.ledgerFor(nodeId, state);
    const judged = proofs.map((p) => {
      const rec = ledger.find((r) => r.record_id === p.record_id);
      let verdict: CompletionVerdict;
      if (rec === undefined || (p.record_sha256 != null && rec.sha256 !== p.record_sha256)) {
        verdict = { ok: false, code: 'COMPLETION_TAMPERED', detail: `COMPLETION_TAMPERED: ${p.criterion} (${p.record_id}): the completion its proof names is ${rec === undefined ? 'not in the ledger' : 'not the record it was carried as'}`, hard: true };
      } else verdict = revalidateCompletion({ controlRoot: this.controlRoot, featureId: this.featureId, record: rec, ledger, repoPath, head: base, policy });
      return { p, rec: rec ?? null, verdict };
    });
    // Each test that must pass on the base: where the base is not the head it was proved at, or someone else changed its code.
    const retest = judged.filter((j) => (j.verdict.ok && j.verdict.retest) || (!j.verdict.ok && j.verdict.code === 'COMPLETION_FIX_CHANGED'));
    let run: CompletionRevalidation['run'] = null;
    if (retest.length > 0 && claim.verification !== undefined && claim.worktree !== null) {
      try {
        const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === node.repository);
        const ran = runVerification({ kind: 'green', label: 'revalidation', nodeId, repository: node.repository, ...moduleInvocation(claim.verification), cwd: claim.worktree, evidenceDir: nodeEvidenceDir(this.controlRoot, this.featureId, nodeId), baselineFailures: repoDecl?.baseline_failures ?? [], allowShell: this.workspace.config.allow_shell_commands, pathBase: this.controlRoot });
        run = { output_path: ran.output_path, output_sha256: ran.output_sha256, exit_code: ran.exit_code, results_sha256: ran.results?.sha256 ?? null };
        const tests = readGateTests(this.controlRoot, ran);
        if (tests !== null) {
          for (const j of retest) {
            const passed = tests.some((t) => t.id === j.p.test_id && t.status === 'passed');
            j.verdict = passed
              ? { ok: true, retest: false }
              : { ok: false, code: 'COMPLETION_TEST_FAILED', detail: `COMPLETION_TEST_FAILED: ${j.p.criterion} (${j.p.record_id}): its test ${j.p.test.name} does not pass on ${base.slice(0, 12)}${j.verdict.ok ? '' : ` (${j.verdict.detail.slice(0, 300)})`}`, hard: true };
          }
        }
      } catch (err) {
        // The run could not be made: nothing is concluded from it; settle runs every carried test at its head again.
        this.event('node.revalidation_inconclusive', nodeId, { claim_id: claimId, detail: errorText(err).slice(0, 300) });
      }
    }
    const at = new Date().toISOString();
    const reopened: ReopenedCriterion[] = [];
    const graph = this.graph();
    mutateState(this.paths.featureDir, (s) => {
      const n = s.nodes[nodeId];
      const brief = n?.rework_brief ?? null;
      if (n === undefined || n.claim?.claim_id !== claimId || brief === null) return s;
      n.claim.revalidation = { base_sha: base, at, run, verdicts: judged.map((j) => ({ criterion: j.p.criterion, record_id: j.p.record_id as string, ok: j.verdict.ok, code: j.verdict.ok ? null : j.verdict.code })) };
      for (const j of judged) {
        if (j.verdict.ok || !j.verdict.hard) continue;
        // A review gap's criterion whose test alone changed is re-provable; anything else needs this generation's own proof.
        const reprove = j.verdict.code === 'COMPLETION_TEST_CHANGED' && brief.origin?.kind === 'acceptance-review';
        n.carried_criterion_proofs = (n.carried_criterion_proofs ?? []).flatMap((x) => (x.criterion === j.p.criterion && x.record_id === j.p.record_id ? (reprove ? [{ ...x, ordered: true }] : []) : [x]));
        if (!brief.acceptance_criteria.includes(j.p.criterion)) brief.acceptance_criteria = [...brief.acceptance_criteria, j.p.criterion];
        const r: ReopenedCriterion = { criterion: j.p.criterion, record_id: j.p.record_id as string, code: j.verdict.code, detail: j.verdict.detail.slice(0, 2000), base_sha: base, at };
        brief.reopened = [...(brief.reopened ?? []), r];
        reopened.push(r);
      }
      // A new behaviour reopened is proved by this generation's own RED.
      if (reopened.some((r) => criterionKind(graph, r.criterion) === 'new-behavior')) delete brief.red_required;
      return s;
    });
    for (const r of reopened) this.event('node.criterion_reopened', nodeId, { claim_id: claimId, criterion: r.criterion, record_id: r.record_id, code: r.code, detail: r.detail.slice(0, 500), base_sha: base });
  }

  /**
   * Judge the node's history from its base to the exact head of its branch,
   * against the RED bindings its gates recorded and the policy its claim was
   * dispatched with, and bind the submission: a SUBMITTED result must name
   * exactly that head, and its own `tdd` claim must match. The record is
   * written as evidence and the claim sealed at that head, in one state
   * write, before anything moves.
   */
  private judgeHistory(nodeId: string, result: NodeResult | null, head: string, base: string): { ok: boolean; history: TddHistory } {
    const node = this.node(nodeId);
    const repository = node.repository as string;
    const repoPath = repositoryPath(this.workspace, repository);
    const runtime = this.state().nodes[nodeId] as NodeRuntime;
    const claim = runtime.claim;
    const policy = claim?.tdd_policy ?? this.claimTddPolicy(repository);
    let history = verifyTddHistory({
      repoPath,
      base,
      head,
      policy,
      bindings: runtime.tdd_red_bindings ?? [],
      requireRed: node.required_evidence.includes('red'),
      // No red gate and not a refactor: a declaration change, inside the claim's declaration paths only.
      declarationsOnly: !node.required_evidence.includes('red') && node.node_type !== 'refactor',
      // A compatibility-regression unit may prove the node's compatibility criteria, nothing else.
      compatibility: { criteria: this.compatibilityCriteria(nodeId) },
      claimed: result?.tdd ?? null,
    });
    if (result !== null && result.outcome === 'SUBMITTED' && result.commit_sha !== head) {
      // The submission binds its head: what it names is what is judged and integrated, or nothing is.
      history = {
        ...history,
        ok: false,
        violation: {
          code: 'TDD_CLAIM_MISMATCH',
          commit: null,
          detail: `the result's commit_sha ${typeof result.commit_sha === 'string' ? result.commit_sha.slice(0, 12) : '(none)'} is not the head of the node branch, ${head.slice(0, 12)}; a submission names exactly the commit it submits`,
        },
      };
    }
    const dir = nodeEvidenceDir(this.controlRoot, this.featureId, nodeId);
    // Immutable, by its own bytes (evidence/store.ts): a later generation's judged history never overwrites the one a
    // completion record or a replaced generation still names (the CSET-202 rerun).
    const stored = writeImmutable(dir, 'tdd-history', '.json', JSON.stringify(history, null, 2) + '\n');
    const outputPath = relativeInside(this.controlRoot, stored.file) ?? stored.file;
    const outputSha = stored.sha256;
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (!rt) return s;
      rt.tdd_history = {
        ok: history.ok,
        base_sha: history.base_sha,
        head_sha: history.head_sha,
        cycles: history.cycles.length,
        compatibility_units: history.compatibility.length,
        code: history.violation?.code ?? null,
        policy_sha256: history.policy_sha256,
        output_path: outputPath,
        output_sha256: outputSha,
        verified_at: new Date().toISOString(),
      };
      if (history.ok && rt.claim) {
        rt.claim.seal = { dispatch_id: rt.claim.dispatch_id ?? null, head_sha: head, base_sha: base, policy_sha256: policy.sha256, sealed_at: new Date().toISOString() };
      }
      return s;
    });
    this.event('node.history_judged', nodeId, { ok: history.ok, code: history.violation?.code ?? null, head_sha: head, cycles: history.cycles.length, compatibility_units: history.compatibility.length });
    return { ok: history.ok, history };
  }

  /** The current capsule of the claim whose files are exactly the test files a refused history's NO_DECLARED_TESTS names, or null. */
  capsuleOfHistory(nodeId: string, history: TddHistory): { capsule_id: string; criterion: string; result: 'passed' | 'failed' } | null {
    const v = history.violation;
    if (v === null || v.code !== 'NO_DECLARED_TESTS' || (v.paths ?? []).length === 0) return null;
    const rt = this.state().nodes[nodeId];
    if (rt === undefined) return null;
    for (const e of rt.claim?.capsules ?? []) {
      const used = capsuleUse({ controlRoot: this.controlRoot, featureId: this.featureId, nodeId, runtime: rt, capsuleId: e.capsule_id, capsuleSha256: e.capsule_sha256, criterion: null, want: null });
      if (used.ok && (v.paths ?? []).every((p) => used.capsule.files.some((f) => f.path === p))) return { capsule_id: used.capsule.capsule_id, criterion: used.capsule.criterion, result: used.capsule.result };
    }
    return null;
  }

  /** The node's compatibility criteria: what a compatibility-regression unit of its history may prove. */
  compatibilityCriteria(nodeId: string): string[] {
    const graph = this.graph();
    return (this.node(nodeId).acceptance_criteria ?? []).filter((ac) => criterionKind(graph, ac) === 'compatibility');
  }

  /**
   * Refuse a history: never integrated, recorded as a failed attempt under a
   * stable fingerprint (the same refusal twice parks the node), kept with
   * the attempt's evidence, and its branch archived by the node's next claim,
   * which starts a fresh branch from the current integration state and
   * hands the worker the reason.
   */
  private rejectHistory(nodeId: string, sessionId: string | null, history: TddHistory, evidence: EvidenceRecord[]): NodeRunReport {
    const graph = this.graph();
    const before = this.state().nodes[nodeId] as NodeRuntime;
    const violation = history.violation ?? { code: 'TDD_CLAIM_MISMATCH' as const, commit: null, detail: 'the history could not be judged' };
    const attempt = before.claim?.attempt ?? before.attempts;
    const fingerprint = `TDD_HISTORY_INVALID:${violation.code}`;
    const detail = `${fingerprint}: ${violation.detail}`.slice(0, 2000);
    const archivedRef = this.archiveRefName(nodeId, history.head_sha);
    // Keep the refused history and the attempt's evidence before the next attempt overwrites them.
    const keep = join(nodeEvidenceDir(this.controlRoot, this.featureId, nodeId), 'rejected', `attempt-${attempt}-${history.head_sha.slice(0, 12)}`);
    // Kept immutably (evidence/store.ts): the refused history by its own bytes, each record's output only as it ran.
    const kept = writeImmutable(keep, 'tdd-history', '.json', JSON.stringify(history, null, 2) + '\n');
    for (const record of Object.values(before.evidence)) {
      const output = resolveEvidenceOutput(this.controlRoot, this.featureId, record);
      if (output.ok) keepExactCopy(output.path, record.output_sha256, keep);
    }
    const evidencePath = relativeInside(this.controlRoot, kept.file) ?? kept.file;
    const evidenceSha = kept.sha256;
    mutateState(this.paths.featureDir, (s) => {
      let next = recordFailure(graph, s, nodeId, fingerprint, { actor: this.owner });
      const rt = next.nodes[nodeId] as NodeRuntime;
      rt.tdd_rejection = {
        code: violation.code,
        commit: violation.commit,
        detail,
        head_sha: history.head_sha,
        archived_ref: archivedRef,
        evidence_path: evidencePath,
        evidence_sha256: evidenceSha,
        attempt,
        at: new Date().toISOString(),
      };
      // The rework redoes a whole cycle on a fresh branch: nothing the refused history was gated with carries over.
      rt.evidence = {};
      rt.tdd_red_bindings = [];
      rt.fresh_branch_required = true;
      rt.branch_base_sha = null;
      if (rt.state !== 'BLOCKED') next = applyNodeTransition(graph, next, nodeId, 'READY', { actor: this.owner, reason: detail });
      return next;
    });
    releaseAllForNode(this.paths.featureDir, nodeId);
    this.event('node.tdd_rejected', nodeId, {
      code: violation.code,
      commit: violation.commit,
      head_sha: history.head_sha,
      archived_ref: archivedRef,
      evidence_path: evidencePath,
      fingerprint,
    });
    const state = this.state().nodes[nodeId]?.state ?? 'BLOCKED';
    return { node_id: nodeId, outcome: state === 'BLOCKED' ? 'BLOCKED' : 'TDD_HISTORY_INVALID', session_id: sessionId, state, detail, evidence };
  }

  /** The head of the node's worker branch, or null (no repository, no branch). */
  private branchHead(nodeId: string): string | null {
    const node = this.node(nodeId);
    if (node.repository === null) return null;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    return branchExists(repoPath, branch) ? resolveRef(repoPath, branch) : null;
  }

  private removeWorktree(nodeId: string, worktree: string | null): void {
    const node = this.node(nodeId);
    if (worktree && node.repository) {
      removeWorkerWorktree(repositoryPath(this.workspace, node.repository), worktree);
    }
  }

  /**
   * Run `work` as the single settlement of the node's current claim.
   *
   * The presented capability must be the current claim's. A settling marker
   * is set in the same locked write, so a concurrent settle of the same claim
   * refuses instead of verifying and integrating twice. The outcome is kept
   * as a receipt: presenting the same capability again returns it rather
   * than re-running anything.
   */
  settleGuard(
    nodeId: string,
    capability: string | undefined,
    work: (claim: NodeClaim) => NodeRunReport,
    options: { resumedBy?: 'dispatch' | 'resume' } = {},
  ): SettleReport {
    let receipt: SettlementReceipt | null = null;
    let challengeAnswer: ReviewChallengeRecord | null = null;
    let claim: NodeClaim | null = null;
    let from: NodeState | null = null;
    const resumedBy = options.resumedBy;
    // A late answer that no longer counts is refused before anything is touched (state/orchestration.ts).
    const stale = this.staleSettle(nodeId, capability, resumedBy);
    if (stale !== null) return stale;
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      const last = rt?.last_settlement ?? null;
      const current = rt?.claim ?? null;
      if (resumedBy === undefined) {
        const isCurrent =
          capability !== undefined && current?.capability_sha256 !== undefined && capabilityMatches(capability, current.capability_sha256);
        // A provisional receipt only answers once its claim is gone (the settle
        // concluded and then died); while the claim lives on, a rotated-away
        // capability is simply invalid.
        const pendingLive = last?.outcome === 'PENDING' && current?.claim_id === last.claim_id;
        if (!isCurrent && !pendingLive && last !== null && capability !== undefined && capabilityMatches(capability, last.capability_sha256)) {
          receipt = last;
          return s;
        }
        // A challenge settled before: its claim is gone (the node is DONE on its prior generation); its record answers.
        const challenged = isCurrent || capability === undefined ? undefined : (s.acceptance_review?.challenges ?? []).find((c) => c.node_id === nodeId && capabilityMatches(capability, c.capability_sha256));
        if (challenged !== undefined) {
          challengeAnswer = challenged;
          return s;
        }
        assertClaimCapability(nodeId, rt, capability);
      } else if (current === null || current.capability_sha256 === undefined) {
        // The controller finishes a settlement only of a live claim it holds the result of.
        throw new CapabilityError('NOT_CLAIMED', `${nodeId} has no claim whose settlement could be finished.`);
      }
      const live = (rt as NodeRuntime).claim as NodeClaim;
      if (live.settling && settlerAlive(live.settling)) throw new SettleInProgressError(nodeId, live.settling);
      from = (rt as NodeRuntime).state;
      live.settling = settlerMarker();
      // A provisional receipt, in the same write: a settle that dies after
      // concluding the attempt (the claim is gone) is still answered when the
      // same capability settles again, instead of NOT_CLAIMED.
      (rt as NodeRuntime).last_settlement = {
        capability_sha256: live.capability_sha256 as string,
        claim_id: live.claim_id,
        outcome: 'PENDING',
        state: (rt as NodeRuntime).state,
        detail: resumedBy === undefined ? 'settle started and did not record an outcome' : 'a resumed settlement started and did not record an outcome',
        settled_at: new Date().toISOString(),
        dispatch_id: live.dispatch_id ?? null,
      };
      claim = structuredClone(live);
      return s;
    });
    if (resumedBy !== undefined && claim !== null) {
      const c = claim as NodeClaim;
      this.event('settlement.resumed', nodeId, {
        claim_id: c.claim_id,
        from_state: from,
        by: resumedBy,
        sealed: c.seal !== undefined && c.seal !== null,
        result_from: c.result_captured_dispatch_id ?? (c.capture_pending ? c.capture_pending.dispatch_id : null),
      });
    }

    if (challengeAnswer !== null) return { ...this.challengeReport(nodeId, challengeAnswer as ReviewChallengeRecord, null), idempotent: true };
    if (receipt !== null) {
      const r = receipt as SettlementReceipt;
      const state = this.state().nodes[nodeId]?.state ?? (r.state as NodeState);
      return {
        node_id: nodeId,
        outcome: r.outcome === 'PENDING' ? outcomeFromState(state) : (r.outcome as NodeRunReport['outcome']),
        session_id: null,
        state,
        detail: r.detail,
        evidence: [],
        idempotent: true,
      };
    }

    const held = claim as unknown as NodeClaim;
    let report: NodeRunReport;
    this.concludedAnswers.delete(nodeId);
    try {
      report = work(held);
    } catch (err) {
      this.clearSettling(nodeId, held.claim_id);
      throw err;
    }
    const answer = this.concludedAnswers.get(nodeId) ?? null;
    this.concludedAnswers.delete(nodeId);
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (!rt) return s;
      // A challenge restored the generation its rework replaced, with that generation's receipt; its own is its record.
      if (report.outcome === 'REVIEW_CHALLENGED') return s;
      rt.last_settlement = {
        capability_sha256: held.capability_sha256 as string,
        claim_id: held.claim_id,
        outcome: report.outcome,
        state: rt.state,
        detail: report.detail.slice(0, 1000),
        settled_at: new Date().toISOString(),
        dispatch_id: held.dispatch_id ?? null,
        ...(held.worktree_setup !== undefined ? { worktree_setup_sha256: held.worktree_setup.config_sha256 } : {}),
        ...(held.verification !== undefined ? { module_sha256: held.verification.module_sha256 } : {}),
        // The exact answer it concluded: a parked answer is re-evaluated from these bytes and no other (PCM-101 final).
        ...(answer !== null ? { result_file: answer.file, result_sha256: answer.sha256 } : {}),
      };
      if (rt.claim?.claim_id === held.claim_id) rt.claim.settling = null;
      // The lease ends with the claim's generation (it stays active while the claim is held for a correction or a
      // challenge): settled, at the epoch the settle left the feature at, which a later answer of it is judged against.
      const live = rt.claim !== null && rt.claim.claim_id === held.claim_id && (rt.claim.dispatch_id ?? null) === (held.dispatch_id ?? null);
      const lease = (s.orchestration?.leases ?? []).find((l) => l.node_id === nodeId && l.claim_id === held.claim_id && l.dispatch_id === (held.dispatch_id ?? null));
      if (!live && lease !== undefined && (lease.status === 'active' || lease.status === 'released' || (lease.status === 'settled' && lease.outcome === 'PENDING'))) {
        lease.status = 'settled';
        lease.closed_at = lease.closed_at ?? new Date().toISOString();
        lease.closed_reason = `settled ${report.outcome}`;
        lease.outcome = report.outcome.slice(0, 64);
        lease.settled_epoch = currentEpoch(s);
      }
      return s;
    });
    this.event('node.settled', nodeId, { claim_id: held.claim_id, outcome: report.outcome, state: report.state });
    return { ...report, idempotent: false };
  }

  /**
   * A settle of a dispatch that no longer counts (CSET-203 r7), judged from
   * the lease registry before anything is touched: a lease revoked (a resume
   * rotated it), abandoned (its holder vanished) or released; an active lease
   * that is not the node's claim; a lease settled before the epoch moved on
   * (presented again after a review, a rework, an integration since); the
   * current claim of a node whose lineage moved after it was issued; or a
   * result in the current claim's slot naming another orchestration epoch
   * than its claim's. Its result is moved out of the worker's slot into the
   * sessions directory (once per content); the lease records the answer.
   * Nothing else changes — no state, attempt, evidence, invalidation or
   * usage — and the node is never BLOCKED. Null: the settle goes on (a
   * legacy capability, the current claim, a duplicate of a settlement at the
   * same epoch, all answered as before).
   */
  private staleSettle(nodeId: string, capability: string | undefined, resumedBy: 'dispatch' | 'resume' | undefined): SettleReport | null {
    const state = this.state();
    const rt = state.nodes[nodeId];
    if (rt === undefined) return null;
    const current = rt.claim ?? null;
    const epoch = currentEpoch(state);
    const lineage = lineageOf(state, nodeId);
    const isCurrent = resumedBy !== undefined ? current !== null : capability !== undefined && current?.capability_sha256 !== undefined && capabilityMatches(capability, current.capability_sha256);
    let lease: DispatchLease | null = null;
    let reason: string;
    let keepClaim = false;
    let slot: string | null = null;
    if (isCurrent && current !== null) {
      lease = activeLeases(state).find((l) => l.node_id === nodeId && l.claim_id === current.claim_id && l.dispatch_id === (current.dispatch_id ?? null)) ?? null;
      slot = current.worktree !== null ? join(current.worktree, WORKER_RESULT_DIR, current.result_file ?? WORKER_RESULT_FILE) : null;
      if (current.lineage !== undefined && current.lineage !== lineage) {
        reason = `${nodeId}'s generation changed at orchestration epoch ${lineage}, after this claim was issued on lineage ${current.lineage}: the dispatch no longer counts`;
      } else {
        const named = resumedBy === undefined && slot !== null ? slotEpoch(slot) : null;
        if (named === null || current.epoch === undefined || named === current.epoch) return null;
        reason = `its result names orchestration_epoch ${named}, not ${current.epoch}, the epoch its claim was issued at: the result of another dispatch, or a forged one; the claim stays live for its own result`;
        keepClaim = true;
      }
    } else {
      if (capability === undefined) return null;
      lease = leaseOf(state, (h) => capabilityMatches(capability, h));
      if (lease === null || lease.node_id !== nodeId) return null;
      if (lease.status === 'settled') {
        const at = lease.settled_epoch ?? lease.epoch;
        if (at === epoch) return null;
        const since = (state.orchestration?.bumps ?? []).filter((b) => b.epoch > at).map((b) => b.reason);
        reason = `it settled ${lease.outcome ?? ''} at orchestration epoch ${at}; the feature has moved to epoch ${epoch} since (${since.slice(-3).join('; ') || 'later changes'}): an answer of it now changes nothing`;
      } else if (lease.status === 'active') {
        reason = `its lease is not ${nodeId}'s claim any more: the claim was replaced`;
      } else {
        reason = `its lease was ${lease.status}${lease.closed_reason !== null ? ` (${lease.closed_reason})` : ''}`;
      }
      slot = lease.worktree !== undefined && lease.worktree !== null && lease.result_file !== undefined && lease.result_file !== null ? join(lease.worktree, WORKER_RESULT_DIR, lease.result_file) : null;
    }
    const archived = slot !== null ? this.archiveLateResult(nodeId, slot, lease?.lease_id ?? current?.dispatch_id ?? current?.claim_id ?? 'result', capability) : null;
    // An answer that moved nothing (no late result to archive) is a replay: answered as before, STATE.json untouched.
    const answeredBefore = archived === null && !(isCurrent && !keepClaim);
    const leaseId = lease?.lease_id ?? null;
    const status = lease?.status ?? null;
    let recorded: { path: string; sha256: string } | null = archived ?? lease?.stale?.archived.at(-1) ?? null;
    if (!keepClaim && leaseId !== null && (archived !== null || (isCurrent && current !== null))) {
      mutateState(this.paths.featureDir, (s) => {
        const l = (s.orchestration?.leases ?? []).find((x) => x.lease_id === leaseId && x.node_id === nodeId);
        if (l !== undefined) {
          markStale(l, reason, archived);
          recorded = archived ?? l.stale?.archived.at(-1) ?? null;
        }
        return s;
      });
    }
    // The current claim of a node whose generation moved under it: handed back unspent, never charged or BLOCKED.
    if (!keepClaim && isCurrent && current !== null && this.state().nodes[nodeId]?.claim?.claim_id === current.claim_id) {
      this.releaseForPrecondition(nodeId, current.claim_id, `STALE_ORCHESTRATION_EPOCH: ${reason}`);
    }
    this.event('settlement.stale', nodeId, { lease_id: leaseId, status, reason: reason.slice(0, 500), archived: recorded, epoch, lineage, idempotent: answeredBefore });
    const after = this.state().nodes[nodeId]?.state ?? rt.state;
    return {
      node_id: nodeId,
      outcome: 'STALE_ORCHESTRATION_EPOCH',
      session_id: null,
      state: after,
      detail: `STALE_ORCHESTRATION_EPOCH: ${reason}. Nothing was changed or charged${recorded !== null ? `; its result is archived at ${recorded.path}` : ''}. Continue with dispatch.`,
      evidence: [],
      idempotent: answeredBefore,
      stale: {
        lease_id: leaseId,
        status,
        reason,
        archived: recorded,
        epoch: { issued: lease?.epoch ?? current?.epoch ?? null, current: epoch },
        lineage: { issued: lease?.lineage ?? current?.lineage ?? null, current: lineage },
      },
    };
  }

  /**
   * Move a late result out of a worker's slot into the controller's sessions
   * directory (`stale/<lease>.<hash>.json`), the capability redacted: a
   * regular file under the size ceiling only (a link is removed, never
   * followed). Null when the slot holds nothing.
   */
  private archiveLateResult(nodeId: string, slot: string, leaseId: string, capability: string | undefined): { path: string; sha256: string } | null {
    // Only a real result directory: one replaced by a link (or anything else) is never followed or touched.
    if (!realDirectory(dirname(slot))) return null;
    let st;
    try {
      st = lstatSync(slot);
    } catch {
      return null;
    }
    // Read through one descriptor: what was looked at is what is read, or nothing is.
    const read = st.isFile() && st.size <= MAX_WORKER_RESULT_BYTES ? readRegular(slot, MAX_WORKER_RESULT_BYTES) : null;
    if (read === null) {
      try {
        if (st.isSymbolicLink() || st.isFile()) unlinkSync(slot);
      } catch {
        // left as it is: nothing of it is read
      }
      return null;
    }
    let text = read.bytes.toString('utf8');
    if (capability !== undefined && capability !== '') text = text.split(capability).join('[REDACTED]');
    const sha = createHash('sha256').update(text).digest('hex');
    const dir = join(this.sessionDir(nodeId), 'stale');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${leaseId.replace(/[^\w.-]/g, '_')}.${sha.slice(0, 16)}.json`);
    if (!existsSync(file)) writeTextAtomic(file, text);
    unlinkSync(slot);
    return { path: (relativeInside(this.controlRoot, file) ?? file).replace(/\\/g, '/'), sha256: sha };
  }

  private clearSettling(nodeId: string, claimId: string): void {
    mutateState(this.paths.featureDir, (s) => {
      const claim = s.nodes[nodeId]?.claim;
      if (claim?.claim_id === claimId) claim.settling = null;
      return s;
    });
  }

  /**
   * Finalize a node driven through the gates by hand (`node claim` + `tdd`):
   * the same deterministic tail a settled worker submission takes.
   */
  finalize(nodeId: string, capability: string | undefined): SettleReport {
    return this.settleGuard(nodeId, capability, () => this.finalizeVerified(nodeId, null, []));
  }

  // ---- host dispatch -----------------------------------------------------

  /**
   * Hand the host session its next unit of work.
   *
   * Controller nodes (candidate builds, E2E) are run here, inline: there is
   * nothing for a model to decide about them. The first schedulable worker
   * node is claimed in host mode and returned as a ticket for the host's own
   * Agent tool. Nothing is spawned. The loop is bounded by
   * `maxControllerSteps`, and a stop always says why.
   */
  async dispatchNext(options: { maxControllerSteps?: number } = {}): Promise<DispatchResult> {
    this.reviewReports = [];
    try {
      const result = await this.dispatchLoop(options);
      const reviewed = this.reviewReports;
      return {
        ...result,
        ...(reviewed.length > 0 ? { review_reports: reviewed } : {}),
        pending_review: result.pending_review ?? this.pendingReview(),
      };
    } finally {
      this.reviewReports = [];
    }
  }

  private async dispatchLoop(options: { maxControllerSteps?: number }): Promise<DispatchResult> {
    const reports: NodeRunReport[] = [];
    const maxSteps = options.maxControllerSteps ?? 10;
    try {
      // Fail fast: nothing is settled, claimed, set up or dispatched under an edited graph.
      this.assertGraphUnchanged();
    } catch (err) {
      if (!(err instanceof GraphDriftError)) throw err;
      this.event('dispatch.stopped', null, { status: 'PRECONDITION_FAILED', detail: err.message.slice(0, 500) });
      return { status: 'PRECONDITION_FAILED', detail: err.message, controller_reports: [], pending: this.pendingDispatches(), deferred: [] };
    }
    this.recordConcludedReceipts();
    // A controller run (a verification node, a candidate build) whose controller died is handed back first, unspent.
    this.recoverControllerRuns();
    // A holder a model provider ended (CSET-203 r10) is reconciled now, from its own records: no lease waits for its expiry.
    this.providerInterrupt();
    // An order STATE.json still binds to an older revision of its review (CSET-203 r14): rebased, or replaced, before anything is handed out.
    this.reconcileReviewOrders();
    // A per-criterion answer's unresolved criteria (CSET-203 r15), still to be ordered again on their own: before anything else.
    this.orderPendingFollowUps();
    // A node a core before canonical test identities parked for an identity-shape refusal (PCM-101 final): its captured answer
    // settled administratively, before anything is handed out — never a worker, an attempt or a person for it.
    for (const settled of this.reconcileParkedIdentity()) {
      reports.push(settled);
      if (settled.outcome === 'PRECONDITION_FAILED') {
        this.event('dispatch.stopped', null, { status: 'PRECONDITION_FAILED', detail: settled.detail.slice(0, 500) });
        return { status: 'PRECONDITION_FAILED', detail: settled.detail, controller_reports: reports, pending: this.pendingDispatches(), deferred: [] };
      }
    }
    for (let step = 0; step <= maxSteps; step++) {
      const unavailable = this.state().orchestration?.provider?.unavailable ?? null;
      if (unavailable !== null) {
        const detail = `PROVIDER_UNAVAILABLE: ${unavailable.reason}; nothing is dispatched until a person clears it (session provider-reset ${this.featureId})`;
        this.event('dispatch.stopped', null, { status: 'PROVIDER_UNAVAILABLE', detail: detail.slice(0, 500) });
        return { status: 'PROVIDER_UNAVAILABLE', detail, controller_reports: reports, pending: this.pendingDispatches(), deferred: [] };
      }
      // A generation kept after a provider failure (its worker had made progress): handed out again first, from where it stands.
      const resumable = Object.entries(this.state().nodes).find(([, rt]) => rt.claim?.mode === 'host' && (rt.claim.provider_interrupted ?? null) !== null);
      if (resumable !== undefined) return { ...this.resumeDispatch(resumable[0]), controller_reports: reports };
      // A generation whose order was rebased to a later revision of its review while it was held (CSET-203 r14): reissued first, from where it stands.
      const rebased = Object.entries(this.state().nodes).find(([, rt]) => rt.claim?.mode === 'host' && (rt.claim.review_rebase ?? null) !== null && !(rt.claim.settling && settlerAlive(rt.claim.settling)));
      if (rebased !== undefined) return { ...this.resumeDispatch(rebased[0]), controller_reports: reports };
      // A submission held for criterion evidence correction comes first: settled when a corrected result is
      // in its slot, else handed to a fresh worker generation to correct (never re-implemented, never charged).
      const held = Object.entries(this.state().nodes).find(([, rt]) => rt.claim?.mode === 'host' && rt.claim.evidence_correction && !(rt.claim.settling && settlerAlive(rt.claim.settling)));
      if (held !== undefined) {
        const [id, rt] = held;
        const claim = rt.claim as NodeClaim;
        // Held by the old, runner-incompatible identity comparison (PCM-101 final): the held answer judged again, administratively,
        // once — settled when it holds, else handed to its correction as before.
        const administrative = !slotTouched(claim.worktree ?? this.controlRoot, claim.result_file ?? WORKER_RESULT_FILE) && this.identityReconcilableHold(claim);
        if (administrative) this.markHoldReconcile(id);
        if (administrative || slotTouched(claim.worktree ?? this.controlRoot, claim.result_file ?? WORKER_RESULT_FILE)) {
          const settled = this.completeSettlement(id, 'dispatch');
          reports.push(settled);
          if (settled.outcome === 'PRECONDITION_FAILED') return { status: 'PRECONDITION_FAILED', detail: settled.detail, controller_reports: reports, pending: this.pendingDispatches(), deferred: [] };
          if (settled.outcome === 'EVIDENCE_CORRECTION_REQUIRED') {
            const r = this.reissueForCorrection(id);
            if (r !== null) return { ...r, controller_reports: reports };
          }
          continue;
        }
        const r = this.reissueForCorrection(id);
        if (r !== null) return { ...r, controller_reports: reports };
      }
      // A claim held for its structured challenge (CSET-203 r7): the request handed to the next generation once; its
      // answer, once in its slot, settled; while that generation works, nothing is re-issued under it.
      const asked = Object.entries(this.state().nodes).find(([, rt]) => rt.claim?.mode === 'host' && rt.claim.challenge_conversion && !(rt.claim.settling && settlerAlive(rt.claim.settling)));
      if (asked !== undefined) {
        const [id, rt] = asked;
        const claim = rt.claim as NodeClaim;
        const out = (claim.dispatch_id ?? null) !== (claim.challenge_conversion?.from_dispatch_id ?? null);
        if (out && slotTouched(claim.worktree ?? this.controlRoot, claim.result_file ?? WORKER_RESULT_FILE)) {
          reports.push(this.completeSettlement(id, 'dispatch'));
          continue;
        }
        if (!out) {
          const r = this.reissueForChallenge(id);
          if (r !== null) return { ...r, controller_reports: reports };
        }
      }
      // A settlement interrupted with its result already in the controller's
      // hands (a settle that died, a crashed host) is finished first, by the
      // controller: no ticket, no worker run again, no lost capability needed.
      for (const [id, rt] of Object.entries(this.state().nodes)) {
        if (!this.resumableSettlement(rt.claim)) continue;
        let settled: SettleReport;
        try {
          settled = this.completeSettlement(id, 'dispatch');
        } catch (err) {
          if (err instanceof SettleInProgressError) continue;
          throw err;
        }
        reports.push(settled);
        if (settled.outcome === 'PRECONDITION_FAILED') {
          // Held again on the same precondition: tried once in this call, never in a loop.
          this.event('dispatch.stopped', null, { status: 'PRECONDITION_FAILED', detail: settled.detail.slice(0, 500) });
          return { status: 'PRECONDITION_FAILED', detail: settled.detail, controller_reports: reports, pending: this.pendingDispatches(), deferred: [] };
        }
      }
      const state = this.state();
      const pending = this.pendingDispatches(state);
      const stop = (status: DispatchStatus, detail: string): DispatchResult => {
        this.event('dispatch.stopped', null, { status, detail: detail.slice(0, 500) });
        return { status, detail, controller_reports: reports, pending, deferred: [] };
      };

      if (state.feature_state === 'BUDGET_EXHAUSTED') return stop('BUDGET_EXHAUSTED', state.blocked_reason ?? '');
      if (state.feature_state === 'CANCELLED') return stop('CANCELLED', state.blocked_reason ?? '');
      if (typeof state.superseded_by === 'string') return stop('CANCELLED', `superseded by ${state.superseded_by}`);
      // The acceptance review between the last product node and the candidate (engine/acceptance-review.ts).
      const reviewed = this.reviewStep(state, pending);
      if (reviewed === 'continue') continue;
      if (reviewed !== null) return { ...reviewed, controller_reports: reports };
      const nodes = Object.values(state.nodes);
      if (nodes.every((n) => n.state === 'DONE' || n.state === 'EXCLUDED')) {
        this.promoteSettledFeature();
        return stop('ALL_SETTLED', 'every node is DONE or EXCLUDED');
      }
      if (nodes.some((n) => n.state === 'NEEDS_DECISION')) {
        return stop('NEEDS_DECISION', `pending decisions: ${state.pending_decisions.join(', ') || '(see DECISIONS.md)'}`);
      }

      const plan = this.plan();
      const pick = plan.scheduled[0];
      if (pick === undefined) {
        const deferred = plan.deferred.map((d) => ({ node_id: d.node_id, reason: d.reason }));
        if (pending.length > 0) {
          return { ...stop('WAITING', `${pending.length} dispatched node(s) not settled yet`), deferred };
        }
        // Another controller is running a controller node right now (a concurrent dispatch): never taken over.
        const running = Object.entries(state.nodes).filter(([, rt]) => rt.claim?.mode === 'controller' && rt.claim.settling && settlerAlive(rt.claim.settling)).map(([id]) => id);
        if (running.length > 0) {
          return { ...stop('WAITING', `${running.join(', ')} ${running.length === 1 ? 'is' : 'are'} being run by another controller`), deferred };
        }
        const parked = Object.entries(state.nodes).filter(([, n]) => n.state === 'BLOCKED' || n.state === 'BUDGET_EXHAUSTED');
        if (parked.length > 0) {
          return {
            ...stop('BLOCKED', parked.map(([id, n]) => `${id}: ${n.blocked_reason ?? n.state}`).join('; ')),
            deferred,
          };
        }
        return { ...stop('NO_PROGRESS', deferred.map((d) => `${d.node_id}: ${d.reason}`).join('; ') || 'nothing is ready'), deferred };
      }

      const node = this.node(pick.node_id);
      if (CONTROLLER_NODE_TYPES.has(node.node_type)) {
        const report = await this.runNode(node.id);
        reports.push(report);
        // A controller node that did not finish is not retried inline: an
        // identical retry inside one call would only burn its budget before
        // the host can see, let alone fix, what went wrong.
        if (report.outcome === 'PRECONDITION_FAILED') return stop('PRECONDITION_FAILED', report.detail);
        if (report.outcome !== 'DONE') {
          return stop(report.state === 'BLOCKED' ? 'BLOCKED' : 'CONTROLLER_FAILED', `${node.id}: ${report.detail}`);
        }
        continue;
      }

      let claim: ClaimResult;
      try {
        claim = this.claim(node.id, { mode: 'host' });
      } catch (err) {
        // A crash a test injected: the claim and its lease are written, nothing else.
        if (err instanceof InjectedFault) throw err;
        // Lost a race to another dispatcher, or a lease is busy: look again.
        if (err instanceof NotSchedulableError || err instanceof ResourceBusyError) continue;
        if (err instanceof ReworkBriefError) return stop('PRECONDITION_FAILED', err.message);
        // The worktree could not be set up: handed back unspent, no worker started.
        if (err instanceof WorktreeSetupError) return stop('PRECONDITION_FAILED', err.message);
        // The module command the graph was planned with is not the repository's any more: nothing was claimed.
        if (err instanceof ModuleDriftError) return stop('PRECONDITION_FAILED', err.message);
        // The approved criteria changed since the feature was initialised: nothing was claimed.
        if (err instanceof AcceptanceDriftError) return stop('PRECONDITION_FAILED', err.message);
        // The claim was already released with its attempt refunded.
        return stop('INFRASTRUCTURE_FAILURE', errorText(err));
      }
      const ticket = this.buildTicket(node.id, claim, { resumed: false });
      this.event('dispatch.ticket', node.id, { claim_id: claim.claimId, attempt: claim.attempt, expires_at: claim.expiresAt });
      return {
        status: 'DISPATCHED',
        detail: `dispatched ${node.id} (attempt ${claim.attempt})`,
        ticket,
        controller_reports: reports,
        pending,
        deferred: [],
      };
    }
    return {
      status: 'MAX_STEPS',
      detail: `stopped after ${maxSteps} controller steps`,
      controller_reports: reports,
      pending: this.pendingDispatches(this.state()),
      deferred: [],
    };
  }

  /**
   * A settle that concluded its attempt (the claim is gone) and died before
   * writing its receipt left the provisional one: record what it concluded,
   * so the receipt answers with the outcome instead of PENDING.
   */
  private recordConcludedReceipts(): void {
    const concluded = Object.entries(this.state().nodes).filter(([, rt]) => rt.claim === null && rt.last_settlement?.outcome === 'PENDING');
    if (concluded.length === 0) return;
    mutateState(this.paths.featureDir, (s) => {
      for (const [id] of concluded) {
        const rt = s.nodes[id];
        if (!rt || rt.claim !== null || rt.last_settlement?.outcome !== 'PENDING') continue;
        rt.last_settlement = { ...rt.last_settlement, outcome: outcomeFromState(rt.state), state: rt.state, detail: 'concluded before an interruption; receipt recorded by dispatch' };
        // Its lease, closed by the write that concluded it, says what it concluded too.
        for (const l of s.orchestration?.leases ?? []) {
          if (l.node_id === id && l.claim_id === rt.last_settlement.claim_id && l.status === 'settled' && l.outcome === 'PENDING') l.outcome = rt.last_settlement.outcome.slice(0, 64);
        }
      }
      return s;
    });
  }

  /** Host-dispatched claims that have not been settled. */
  pendingDispatches(state: FeatureState_ = this.state()): PendingDispatch[] {
    const now = Date.now();
    return Object.entries(state.nodes)
      .filter(([, rt]) => rt.claim?.mode === 'host')
      .map(([id, rt]) => {
        const claim = rt.claim as NodeClaim;
        const expires = claim.expires_at ?? claim.claimed_at;
        return {
          node_id: id,
          claim_id: claim.claim_id,
          state: rt.state,
          expires_at: expires,
          expired: Date.parse(expires) <= now,
        };
      });
  }

  /**
   * Re-issue the ticket of an unsettled host dispatch whose capability the
   * host lost (an interrupted session). The capability is rotated: the old
   * one stops working everywhere, so a stray copy cannot settle later. The
   * claim, worktree, branch and any result already in the slot are kept.
   */
  resumeDispatch(nodeId: string): DispatchResult {
    const run = (): DispatchResult => {
      if (codexLifecycleEnabled(this.paths.featureDir)) revokeWslCodexProcesses(this.paths.featureDir);
      return this.resumeDispatchLocked(nodeId);
    };
    return codexLifecycleEnabled(this.paths.featureDir)
      ? withCodexLifecycleLock(this.paths.featureDir, run, { timeoutMs: 2_000 }) : run();
  }

  private resumeDispatchLocked(nodeId: string): DispatchResult {
    try {
      this.assertGraphUnchanged();
    } catch (err) {
      if (!(err instanceof GraphDriftError)) throw err;
      this.event('dispatch.stopped', null, { status: 'PRECONDITION_FAILED', detail: err.message.slice(0, 500) });
      return { status: 'PRECONDITION_FAILED', detail: err.message, controller_reports: [], pending: this.pendingDispatches(), deferred: [] };
    }
    // An acceptance review handed to a reviewer (a review id is `<feature>-R<n>`, never a node id).
    const openReview = this.requiredReview()?.open ?? null;
    if (openReview !== null && nodeId === openReview.review_id) return this.resumeReview(openReview);
    if (/^[A-Z][A-Z0-9]*-[0-9]+-R[0-9]{3,}$/.test(nodeId)) {
      throw new Error(`REVIEW_NOT_OPEN: ${nodeId} is not an acceptance review of ${this.featureId} handed to a reviewer; run dispatch.`);
    }
    const node = this.node(nodeId);
    const before = this.state().nodes[nodeId]?.claim ?? null;
    if (before === null) throw new CapabilityError('NOT_CLAIMED', `${nodeId} has no claim to resume.`);
    if (before.mode !== 'host') {
      throw new Error(`NOT_HOST_DISPATCH: ${nodeId} is claimed in ${before.mode ?? 'legacy'} mode, not by a host dispatch.`);
    }
    if (before.settling && settlerAlive(before.settling)) throw new SettleInProgressError(nodeId, before.settling);
    if (before.evidence_correction) {
      // Held for its criterion evidence: a corrected result in the slot is settled, else a fresh generation corrects it — unless the
      // hold is an identity refusal the old comparison made (PCM-101 final): its held answer is judged again first, administratively.
      if (slotTouched(before.worktree ?? this.controlRoot, before.result_file ?? WORKER_RESULT_FILE)) {
        const settled = this.completeSettlement(nodeId, 'resume');
        return { status: 'SETTLED', detail: `settled the corrected evidence of ${nodeId}: ${settled.outcome}`, settled, controller_reports: [settled], pending: this.pendingDispatches(), deferred: [] };
      }
      if (this.identityReconcilableHold(before)) {
        this.markHoldReconcile(nodeId);
        const settled = this.completeSettlement(nodeId, 'resume');
        if (settled.outcome !== 'EVIDENCE_CORRECTION_REQUIRED') return { status: 'SETTLED', detail: `re-evaluated ${nodeId}'s held answer by the canonical test identity: ${settled.outcome}`, settled, controller_reports: [settled], pending: this.pendingDispatches(), deferred: [] };
      }
      const r = this.reissueForCorrection(nodeId);
      if (r !== null) return r;
    }
    if (before.challenge_conversion) {
      // Held for its structured challenge: the request's answer in its slot is settled, else the request goes out (again).
      const out = (before.dispatch_id ?? null) !== (before.challenge_conversion.from_dispatch_id ?? null);
      if (out && slotTouched(before.worktree ?? this.controlRoot, before.result_file ?? WORKER_RESULT_FILE)) {
        const settled = this.completeSettlement(nodeId, 'resume');
        return { status: 'SETTLED', detail: `settled the structured challenge request of ${nodeId}: ${settled.outcome}`, settled, controller_reports: [settled], pending: this.pendingDispatches(), deferred: [] };
      }
      const r = this.reissueForChallenge(nodeId);
      if (r !== null) return r;
    }

    // Attest before rotating: a result the current generation already wrote
    // is taken into the controller now, checked against that generation, or
    // not at all. After the rotation nothing that generation writes counts.
    // A settle of this generation that died after writing its copy counts as
    // captured before the rotation too.
    // A generation whose holder a model provider ended (CSET-203 r10): its old capability was rotated away when it was
    // interrupted, and nothing of the old holder's is attested; the same generation goes on from where it stands.
    const interrupted = before.provider_interrupted ?? null;
    // A generation whose order was rebased (CSET-203 r14): its old answer was taken and never judged; nothing of the old holder's is attested.
    const rebase = before.review_rebase ?? null;
    const attested =
      interrupted === null && rebase === null && before.result_captured_sha256 === undefined
        ? (this.pendingCapture(nodeId, before, Date.parse(before.dispatched_at ?? before.claimed_at))?.captured ??
          this.attestSlot(nodeId, before))
        : null;

    const capability = newCapability();
    const dispatchId = randomUUID();
    const host = this.hostBinding();
    let claim: NodeClaim | null = null;
    let attempt = 0;
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      const live = rt?.claim ?? null;
      if (!rt || live === null || live.claim_id !== before.claim_id || live.capability_sha256 !== before.capability_sha256) {
        throw new Error(`DISPATCH_CHANGED: ${nodeId}'s claim changed while it was being resumed; reconcile and try again.`);
      }
      if (live.settling && settlerAlive(live.settling)) throw new SettleInProgressError(nodeId, live.settling);
      let next = s;
      if (attested !== null) {
        next = this.recordCapture(next, nodeId, attested);
      }
      const held = (next.nodes[nodeId] as NodeRuntime).claim as NodeClaim;
      held.settling = null;
      held.capture_pending = null;
      held.capability_sha256 = capability.sha256;
      held.dispatch_id = dispatchId;
      held.result_file = generationResultFile(dispatchId);
      held.expires_at = new Date(Date.now() + this.claimTtlMs(node)).toISOString();
      held.dispatched_at = new Date().toISOString();
      held.host_session = host;
      held.provider_interrupted = null;
      held.review_rebase = null;
      attempt = held.attempt ?? (next.nodes[nodeId] as NodeRuntime).attempts;
      // The old generation's lease is revoked (anything it answers later is stale); the new one is issued, in this write.
      closeLeases(next, (l) => l.node_id === nodeId && l.claim_id === held.claim_id && l.dispatch_id === (before.dispatch_id ?? null), 'revoked', `rotated by dispatch --resume to ${dispatchId}`);
      issueLease(next, { kind: held.lease_kind ?? 'worker', node_id: nodeId, review_id: null, claim_id: held.claim_id, dispatch_id: dispatchId, capability_sha256: capability.sha256, generation: held.generation ?? 0, worktree: held.worktree, result_file: held.result_file, host });
      claim = structuredClone(held);
      return next;
    });
    const held = claim as unknown as NodeClaim;
    if (node.repository !== null && (held.worktree === null || !existsSync(held.worktree))) {
      // The dispatch was interrupted between claiming and creating the
      // worktree (or the worktree went); finish that instead of pointing a
      // worker at the control root.
      const created = this.ensureWorktree(nodeId, held.claim_id);
      held.worktree = created.worktree;
      held.branch = created.branch;
    }
    if (this.capturedResultFor(nodeId, held) !== null) {
      // The previous generation's result is in the controller's hands: its
      // worker finished. Finish the settlement here rather than hand the host
      // a ticket it could fulfil again; the rotated capability is never
      // revealed, so nothing from before the resume can settle it either.
      this.event('dispatch.resumed', nodeId, { claim_id: held.claim_id, attempt, dispatch_id: dispatchId, attested: attested !== null, settled: true });
      const settled = this.completeSettlement(nodeId, 'resume');
      return {
        status: 'SETTLED',
        detail: `finished the interrupted settlement of ${nodeId} (attempt ${attempt}): ${settled.outcome}`,
        settled,
        controller_reports: [settled],
        pending: this.pendingDispatches(),
        deferred: [],
      };
    }
    if (node.repository !== null && held.worktree !== null) {
      // The receipt holds only for the same worktree, commit and setup; anything else sets it up again.
      try {
        this.prepareWorktree(nodeId, held.claim_id, held.worktree);
      } catch (err) {
        if (!(err instanceof WorktreeSetupError)) throw err;
        this.releaseForPrecondition(nodeId, held.claim_id, err.message);
        this.event('dispatch.stopped', null, { status: 'PRECONDITION_FAILED', detail: err.message.slice(0, 500) });
        return { status: 'PRECONDITION_FAILED', detail: err.message, controller_reports: [], pending: this.pendingDispatches(), deferred: [] };
      }
    }
    const ticket = this.buildTicket(
      nodeId,
      {
        claimId: held.claim_id,
        capability: capability.raw,
        worktree: held.worktree,
        branch: held.branch,
        attempt,
        mode: 'host',
        expiresAt: held.expires_at as string,
        dispatchId,
        resultFile: held.result_file as string,
      },
      {
        resumed: true,
        resultPresent: this.capturedResultFor(nodeId, held) !== null,
        ...(interrupted !== null ? { providerResume: { class: interrupted.class, request_id: interrupted.request_id, head_sha: interrupted.progress.head_sha, commits: interrupted.progress.commits, state: interrupted.progress.state, dirty: interrupted.progress.dirty } } : {}),
        ...(rebase !== null ? { reviewRebase: { review_id: rebase.review_id, from_revision: rebase.from_revision, to_revision: rebase.to_revision } } : {}),
      },
    );
    this.event('dispatch.resumed', nodeId, {
      claim_id: held.claim_id,
      attempt,
      dispatch_id: dispatchId,
      attested: attested !== null,
      ...(rebase !== null ? { review_rebase: { review_id: rebase.review_id, from_revision: rebase.from_revision, to_revision: rebase.to_revision, from_dispatch_id: rebase.from_dispatch_id } } : {}),
      ...(interrupted !== null ? { provider: { class: interrupted.class, request_id: interrupted.request_id, from_dispatch_id: interrupted.from_dispatch_id } } : {}),
    });
    return {
      status: 'DISPATCHED',
      detail: `re-issued ${nodeId} (attempt ${attempt}) with a new capability and dispatch id`,
      ticket,
      controller_reports: [],
      pending: this.pendingDispatches(),
      deferred: [],
    };
  }

  /**
   * Hand a submission held for criterion evidence correction to a fresh
   * worker generation: the claim, its sealed commit and its gate evidence are
   * kept; the capability and dispatch id are rotated (the earlier generation
   * can no longer write or settle); the ticket carries the refusal, the held
   * commit and the candidate test ids, and asks for a corrected result only.
   * Null when the claim is not held (any more).
   */
  private reissueForCorrection(nodeId: string): DispatchResult | null {
    const node = this.node(nodeId);
    const capability = newCapability();
    const dispatchId = randomUUID();
    let held: NodeClaim | null = null;
    mutateState(this.paths.featureDir, (s) => {
      const c = s.nodes[nodeId]?.claim;
      if (!c || c.mode !== 'host' || !c.evidence_correction || (c.settling && settlerAlive(c.settling))) return s;
      const previous = c.dispatch_id ?? null;
      c.settling = null;
      c.capture_pending = null;
      c.capability_sha256 = capability.sha256;
      c.dispatch_id = dispatchId;
      c.result_file = generationResultFile(dispatchId);
      c.expires_at = new Date(Date.now() + this.claimTtlMs(node)).toISOString();
      c.dispatched_at = new Date().toISOString();
      closeLeases(s, (l) => l.node_id === nodeId && l.claim_id === c.claim_id && l.dispatch_id === previous, 'revoked', `rotated for an evidence correction to ${dispatchId}`);
      issueLease(s, { kind: c.lease_kind ?? 'worker', node_id: nodeId, review_id: null, claim_id: c.claim_id, dispatch_id: dispatchId, capability_sha256: capability.sha256, generation: c.generation ?? 0, worktree: c.worktree, result_file: c.result_file });
      held = structuredClone(c);
      return s;
    });
    if (held === null) return null;
    const claim = held as NodeClaim;
    const attempt = claim.attempt ?? this.state().nodes[nodeId]?.attempts ?? 1;
    const ticket = this.buildTicket(
      nodeId,
      { claimId: claim.claim_id, capability: capability.raw, worktree: claim.worktree, branch: claim.branch, attempt, mode: 'host', expiresAt: claim.expires_at as string, dispatchId, resultFile: claim.result_file as string },
      { resumed: true },
    );
    this.event('dispatch.correction', nodeId, { claim_id: claim.claim_id, attempt, dispatch_id: dispatchId, code: claim.evidence_correction?.code ?? null });
    return {
      status: 'DISPATCHED',
      detail: `re-issued ${nodeId} (attempt ${attempt}) to correct its criterion evidence only: ${claim.evidence_correction?.code ?? ''}`,
      ticket,
      controller_reports: [],
      pending: this.pendingDispatches(),
      deferred: [],
    };
  }

  /**
   * Hand a claim held for its structured challenge (holdForChallenge) to a
   * fresh worker generation: the claim, its worktree, its red gate's snapshot
   * and evidence are kept; the capability and dispatch id are rotated (the
   * generation that answered the old way can no longer settle); the ticket
   * asks for the challenge, once. Null when the claim is not held so.
   */
  private reissueForChallenge(nodeId: string): DispatchResult | null {
    const node = this.node(nodeId);
    const capability = newCapability();
    const dispatchId = randomUUID();
    let held: NodeClaim | null = null;
    mutateState(this.paths.featureDir, (s) => {
      const c = s.nodes[nodeId]?.claim;
      if (!c || c.mode !== 'host' || !c.challenge_conversion || (c.settling && settlerAlive(c.settling))) return s;
      const previous = c.dispatch_id ?? null;
      c.settling = null;
      c.capture_pending = null;
      // The old answer was taken and judged: the next generation's own result is the one settled, never that copy again.
      delete c.result_captured_sha256;
      delete c.result_captured_file;
      delete c.result_captured_dispatch_id;
      c.seal = null;
      c.criteria_judged = null;
      c.capability_sha256 = capability.sha256;
      c.dispatch_id = dispatchId;
      c.result_file = generationResultFile(dispatchId);
      c.expires_at = new Date(Date.now() + this.claimTtlMs(node)).toISOString();
      c.dispatched_at = new Date().toISOString();
      closeLeases(s, (l) => l.node_id === nodeId && l.claim_id === c.claim_id && l.dispatch_id === previous, 'revoked', `rotated for its structured challenge to ${dispatchId}`);
      issueLease(s, { kind: c.lease_kind ?? 'worker', node_id: nodeId, review_id: null, claim_id: c.claim_id, dispatch_id: dispatchId, capability_sha256: capability.sha256, generation: c.generation ?? 0, worktree: c.worktree, result_file: c.result_file });
      held = structuredClone(c);
      return s;
    });
    if (held === null) return null;
    const claim = held as NodeClaim;
    const attempt = claim.attempt ?? this.state().nodes[nodeId]?.attempts ?? 1;
    const ticket = this.buildTicket(
      nodeId,
      { claimId: claim.claim_id, capability: capability.raw, worktree: claim.worktree, branch: claim.branch, attempt, mode: 'host', expiresAt: claim.expires_at as string, dispatchId, resultFile: claim.result_file as string },
      { resumed: true },
    );
    this.event('dispatch.challenge_request', nodeId, { claim_id: claim.claim_id, attempt, dispatch_id: dispatchId, fingerprint: claim.challenge_conversion?.fingerprint ?? null });
    return {
      status: 'DISPATCHED',
      detail: `re-issued ${nodeId} (attempt ${attempt}) for its structured review-gap challenge: its last answer was ${claim.challenge_conversion?.fingerprint ?? 'BLOCKED'} while its red gate passed every test it declared`,
      ticket,
      controller_reports: [],
      pending: this.pendingDispatches(),
      deferred: [],
    };
  }

  /** The structured ticket the host's Agent tool fulfils. */
  private buildTicket(
    nodeId: string,
    claim: ClaimResult,
    options: { resumed: boolean; resultPresent?: boolean; providerResume?: NonNullable<DispatchTicket['provider_resume']>; reviewRebase?: NonNullable<DispatchTicket['review_rebase']> },
  ): DispatchTicket {
    const node = this.node(nodeId);
    const packPath = this.writeContextPack(nodeId, claim.claimId);
    const pack = loadPromptPack(packPath, { featureId: this.featureId, nodeId, claimId: claim.claimId });
    const cwd = claim.worktree ?? this.controlRoot;
    // Every generation starts from its own empty result file. A result an
    // earlier generation wrote was attested into the controller at the resume.
    const resultSlot = prepareResultSlot(cwd, claim.resultFile ?? WORKER_RESULT_FILE);
    const gates = this.gateCommands(nodeId, claim.capability).map((g) => ({ gate: g.gate, line: renderGateCommand(g.argv) }));
    const launcher = mycelinkCliPath().replace(/\\/g, '/');
    const controlRoot = this.controlRoot.replace(/\\/g, '/');
    const tdd = pack.tdd ?? null;
    const state = this.state();
    const live = state.nodes[nodeId]?.claim ?? null;
    const setup = live?.worktree_setup ?? null;
    const bound = live?.verification ?? null;
    // What the claim was issued at: its result names the epoch, and a settle after the node's lineage moved is stale.
    const orchestration = { epoch: live?.epoch ?? currentEpoch(state), lineage: live?.lineage ?? lineageOf(state, nodeId), generation: live?.generation ?? 0 };
    // A claim held for its structured challenge, handed to the generation after the one that answered the old way.
    const conversion = live?.challenge_conversion ?? null;
    const snapshot = live?.challenge_red ?? null;
    const capsuleEntry = conversion?.capsule_id != null ? (live?.capsules ?? []).find((e) => e.capsule_id === conversion.capsule_id) ?? null : null;
    const capsuleRead = capsuleEntry !== null ? readCapsule(this.controlRoot, capsuleEntry.receipt_path, capsuleEntry.capsule_sha256) : null;
    const challengeRequest =
      conversion !== null && (claim.dispatchId ?? null) !== conversion.from_dispatch_id
        ? capsuleRead !== null && capsuleRead.ok
          ? { fingerprint: conversion.fingerprint, gate_output_sha256: conversion.gate_output_sha256, tests: capsuleRead.capsule.tests.map((t) => t.id), capsule_id: capsuleRead.capsule.capsule_id }
          : snapshot !== null
            ? { fingerprint: conversion.fingerprint, gate_output_sha256: conversion.gate_output_sha256, tests: snapshot.red_tests.map((t) => t.id) }
            : null
        : null;
    return {
      schema: 'mycelink-dispatch-ticket/1',
      feature_id: this.featureId,
      node_id: nodeId,
      claim_id: claim.claimId,
      dispatch_id: claim.dispatchId ?? null,
      orchestration,
      attempt: claim.attempt,
      capability: claim.capability,
      expires_at: claim.expiresAt,
      agent: HOST_WORKER_AGENT,
      repository: node.repository,
      worktree: claim.worktree,
      branch: claim.branch,
      allowed_paths: [...node.allowed_paths],
      forbidden_paths: [...(node.forbidden_paths ?? [])],
      acceptance_criteria: pack.acceptance_criteria.map((a) => ({ ...a })),
      verification_commands: node.verification_commands.map((v) => ({ ...v })),
      gate_commands: gates.map((g) => ({ gate: g.gate, command: g.line })),
      result_slot: resultSlot,
      settle_command: renderGateCommand([
        'node',
        launcher,
        'settle',
        this.featureId,
        nodeId,
        '--control-root',
        controlRoot,
        '--capability',
        claim.capability,
        '--json',
      ]),
      context_pack_path: packPath,
      budget: {
        model: node.worker.model,
        max_turns: node.worker.max_turns,
        max_wall_clock_minutes: node.worker.max_wall_clock_minutes,
      },
      ...(pack.rework !== undefined ? { rework: pack.rework } : {}),
      ...(pack.correction !== undefined ? { correction: pack.correction } : {}),
      ...(challengeRequest !== null ? { challenge_request: challengeRequest } : {}),
      tdd:
        tdd === null
          ? null
          : { base_sha: tdd.base_sha, policy_sha256: tdd.policy_sha256, test_paths: tdd.test_paths, production_roots: tdd.production_roots, declaration_paths: tdd.declaration_paths },
      verification:
        bound === null
          ? null
          : {
              module: bound.module,
              module_sha256: bound.module_sha256,
              path: bound.path,
              runtime_tests: bound.runtime_tests,
              steps: [...bound.plan.setup, ...bound.plan.build].map((a) => [...a]),
              test: [...bound.plan.test],
              report: bound.plan.report?.format ?? null,
              regression: [...bound.regression.command],
            },
      worktree_setup:
        setup === null
          ? { status: 'not-configured', config_sha256: null, receipt_sha256: null, receipt_path: null, commands: [], required_paths: [] }
          : {
              status: setup.status,
              config_sha256: setup.config_sha256,
              receipt_sha256: setup.receipt_sha256,
              receipt_path: setup.receipt_path,
              commands: setup.config.commands.map((c) => [...c]),
              required_paths: [...setup.config.required_paths],
            },
      prompt: buildHostWorkerPrompt({
        pack,
        worktree: claim.worktree,
        resultSlot,
        gates,
        // The bound tests by their canonical ids (evidence/test-ids.ts), what criterion evidence names.
        ...(gates.length > 0 ? { testsLine: renderGateCommand(['node', launcher, 'tdd', 'tests', this.featureId, nodeId, '--control-root', controlRoot, '--capability', claim.capability]) } : {}),
        // The result's criterion evidence judged exactly as settle will, before the worker submits (CSET-203 r1's AC-4).
        ...(gates.length > 0 && pack.acceptance_criteria.length > 0 ? { checkLine: renderGateCommand(['node', launcher, 'tdd', 'check', this.featureId, nodeId, '--control-root', controlRoot, '--capability', claim.capability]) } : {}),
        // An acceptance review's rework: what a challenge of its gap binds, once a red gate passed every test it declared (CSET-203 r6).
        ...(gates.length > 0 && pack.rework?.origin?.kind === 'acceptance-review' ? { challengeLine: renderGateCommand(['node', launcher, 'tdd', 'challenge', this.featureId, nodeId, '--control-root', controlRoot, '--capability', claim.capability]) } : {}),
        // Its exact focused reproduction sealed without a commit (engine/reproduction-capsule.ts; CSET-203 r17).
        ...(gates.length > 0 && pack.rework?.origin?.kind === 'acceptance-review' ? { capsuleLine: renderGateCommand(['node', launcher, 'tdd', 'capsule', this.featureId, nodeId, '--control-root', controlRoot, '--capability', claim.capability]) } : {}),
        ...(claim.dispatchId !== undefined ? { dispatchId: claim.dispatchId } : {}),
        orchestrationEpoch: orchestration.epoch,
        ...(challengeRequest !== null ? { challengeRequest } : {}),
        ...(options.providerResume !== undefined ? { providerResume: options.providerResume } : {}),
        ...(options.reviewRebase !== undefined ? { reviewRebase: options.reviewRebase } : {}),
      }),
      ...(options.providerResume !== undefined ? { provider_resume: options.providerResume } : {}),
      ...(options.reviewRebase !== undefined ? { review_rebase: options.reviewRebase } : {}),
      resumed: options.resumed,
      result_present: options.resultPresent ?? false,
    };
  }

  /**
   * Take a host-dispatched worker's result back and conclude the attempt.
   *
   * The result is moved out of the slot into a controller-owned quarantine
   * and checked for links, size, schema and identity before anything reads
   * it (see worker-protocol.ts). Its outcome only chooses the road; a
   * submission is believed only after fresh verification and integration.
   */
  /** A status without a root-owned generation tombstone is not evidence of exit. */
  private assertExperimentalWslStopped(nodeId: string): void {
    const claim = this.state().nodes[nodeId]?.claim;
    if (claim?.mode === 'host' && claim.dispatch_id) {
      if (wslCodexProcessActive(this.paths.featureDir, claim.claim_id, claim.dispatch_id)) {
        throw new Error('WSL_CODEX_WORKER_ACTIVE: settle only after the registered Linux process exits');
      }
      const result = wslCodexProcessResult(this.paths.featureDir, claim.claim_id, claim.dispatch_id);
      if (result.revoked || result.exit_code !== 0) throw new Error('WSL_CODEX_WORKER_FAILED: root-supervisor exit was not successful');
    }
  }

  settle(nodeId: string, capability: string | undefined): SettleReport {
    const run = (): SettleReport => {
      if (codexLifecycleEnabled(this.paths.featureDir)) this.assertExperimentalWslStopped(nodeId);
      return this.settleLocked(nodeId, capability);
    };
    return codexLifecycleEnabled(this.paths.featureDir)
      ? withCodexLifecycleLock(this.paths.featureDir, run, { timeoutMs: 2_000 }) : run();
  }

  private settleLocked(nodeId: string, capability: string | undefined): SettleReport {
    // No result because a model provider ended the worker (or its host): an interruption, never RESULT_MISSING.
    const provider = this.providerSettle(nodeId, capability);
    if (provider !== null) return provider;
    // Its worker still runs with nothing in its slot: the host settled too early, which is never the worker's attempt.
    const running = this.workerRunningSettle(nodeId, capability);
    if (running !== null) return running;
    return this.settleGuard(nodeId, capability, (claim) => this.settleWork(nodeId, claim, capability));
  }

  /**
   * Finish, as the controller, a host dispatch whose result the controller
   * already holds: captured by a settle that died (sealed or not), or
   * attested from the slot at a resume. No capability is needed and the
   * worker is not run again; the settlement is the same one a settle would
   * have made, under the same guard (a live settle is never raced), with
   * the same receipt. `by` says who finished it, for the record.
   */
  completeSettlement(nodeId: string, by: 'dispatch' | 'resume'): SettleReport {
    const run = (): SettleReport => {
      if (codexLifecycleEnabled(this.paths.featureDir)) this.assertExperimentalWslStopped(nodeId);
      return this.settleGuard(nodeId, undefined, (claim) => this.settleWork(nodeId, claim, undefined), { resumedBy: by });
    };
    return codexLifecycleEnabled(this.paths.featureDir)
      ? withCodexLifecycleLock(this.paths.featureDir, run, { timeoutMs: 2_000 }) : run();
  }

  /** Whether a claim's settlement can be finished by the controller: its result is in the controller's hands. */
  private resumableSettlement(claim: NodeClaim | null): boolean {
    if (claim === null || claim.mode !== 'host') return false;
    // Held for its criterion evidence: a worker corrects it (dispatch re-issues it), the controller cannot.
    if (claim.evidence_correction) return false;
    // Held for its structured challenge: the next generation answers it (dispatch re-issues it), the controller cannot.
    if (claim.challenge_conversion) return false;
    // Its order rebased while it was held (CSET-203 r14): the reissued generation answers again.
    if ((claim.review_rebase ?? null) !== null) return false;
    if (claim.settling && settlerAlive(claim.settling)) return false;
    return (claim.seal !== undefined && claim.seal !== null) || claim.result_captured_sha256 !== undefined || (claim.capture_pending ?? null) !== null;
  }

  /** The body of a settle: take the result, count its usage once, record the attempt, conclude it. */
  private settleWork(nodeId: string, claim: NodeClaim, capability: string | undefined): NodeRunReport {
    if (claim.mode !== 'host') {
      throw new Error(`NOT_HOST_DISPATCH: ${nodeId} is claimed in ${claim.mode ?? 'legacy'} mode; use node finalize for a manual claim.`);
    }
    // Nothing the worktree set aside stays live in the shared stash: archived and dropped before anything is judged.
    const stash = this.quarantineWorkerStash(nodeId);
    const report = this.settleResult(nodeId, claim, capability);
    return stash === null ? report : { ...report, stash };
  }

  /**
   * The entries a node's worktree left in its repository's shared stash
   * (CSET-203 r12), archived under the node's archive refs and dropped;
   * every other entry stays exactly as it was. Null when it left none.
   * Throws STASH_LEFT when the stash keeps moving: nothing is settled then.
   */
  private quarantineWorkerStash(nodeId: string): StashQuarantine | null {
    const node = this.node(nodeId);
    if (node.repository === null || CONTROLLER_NODE_TYPES.has(node.node_type)) return null;
    const branch = workerBranchName(this.featureId, nodeId);
    const prefix = `refs/mycelink/archive/${this.featureId}/${branch.slice(`wip/${this.featureId}/`.length)}/stash`;
    let q: StashQuarantine | null;
    try {
      q = quarantineStash(repositoryPath(this.workspace, node.repository), branch, prefix);
    } catch (err) {
      throw new Error(`STASH_LEFT: ${nodeId}'s worktree left entries in the shared stash that could not be quarantined (${err instanceof Error ? err.message.slice(0, 300) : 'error'}); nothing was settled — settle again.`);
    }
    if (q !== null) this.event('node.stash_quarantined', nodeId, { quarantined: q.quarantined, remaining: q.remaining });
    return q;
  }

  private settleResult(nodeId: string, claim: NodeClaim, capability: string | undefined): NodeRunReport {
    const started = Date.parse(claim.dispatched_at ?? claim.claimed_at);
    const attempt = claim.attempt ?? this.state().nodes[nodeId]?.attempts ?? 1;
    const cwd = claim.worktree ?? this.controlRoot;
    const generation = claim.dispatch_id ?? claim.claim_id;
    const resultFile = claim.result_file ?? WORKER_RESULT_FILE;

    let result: NodeResult | null = null;
    let failure: string | null = null;
    if (slotTouched(cwd, resultFile)) {
      // The current generation's own result (or a slot tampered with,
      // which the capture reports). The capability is redacted
      // from everything kept: a worker may echo its gate lines back.
      const env = { ...process.env, [CAPABILITY_ENV]: capability ?? '' };
      const file = `result.${generation}.${randomBytes(16).toString('hex')}.json`;
      // Record where the copy goes before taking it, so a settle that dies
      // once the copy is written can finish from it.
      mutateState(this.paths.featureDir, (s) => {
        const c = s.nodes[nodeId]?.claim;
        if (c?.claim_id === claim.claim_id) c.capture_pending = { file, dispatch_id: generation };
        return s;
      });
      const collected = collectWorkerResult(
        cwd,
        { featureId: this.featureId, nodeId, claimId: claim.claim_id, ...(claim.dispatch_id !== undefined ? { dispatchId: claim.dispatch_id } : {}) },
        join(this.sessionDir(nodeId), file),
        env,
        {
          resultFile,
          ...(claim.worktree === null ? { fallbackQuarantineDir: null } : {}),
          // Without the raw capability (a controller finishing it), redact it by its hash.
          ...(capability === undefined && claim.capability_sha256 !== undefined ? { capabilitySha256: claim.capability_sha256 } : {}),
        },
      );
      if (collected.result !== null) {
        this.fault('result-captured');
        const captured = { file, sha256: sha256OfFile(join(this.sessionDir(nodeId), file)), dispatchId: generation, usage: hostUsage(collected.result, started) };
        mutateState(this.paths.featureDir, (s) => this.recordCapture(s, nodeId, captured, claim.claim_id));
        this.fault('result-attested');
        result = collected.result;
      } else {
        failure = collected.failure;
      }
    } else {
      // Nothing new in the slot: a copy captured before (by a resume's
      // attestation, or by a settle of this claim that died) is the result.
      result = this.capturedResultFor(nodeId, claim) ?? this.finishPendingCapture(nodeId, claim, started);
      if (result === null) failure = 'RESULT_MISSING';
    }
    // Whatever happened, the attempt's usage is counted once per generation.
    const usage = hostUsage(result, started);
    mutateState(this.paths.featureDir, (s) => {
      const c = s.nodes[nodeId]?.claim;
      if (c?.claim_id !== claim.claim_id) return s;
      c.capture_pending = null;
      if (c.usage_counted_for === generation || (result !== null && c.usage_counted_for === c.result_captured_dispatch_id)) return s;
      const next = accumulateUsage(s, nodeId, usage);
      ((next.nodes[nodeId] as NodeRuntime).claim as NodeClaim).usage_counted_for = generation;
      return next;
    });
    const copy = this.state().nodes[nodeId]?.claim;
    if (result !== null && copy?.claim_id === claim.claim_id && copy.result_captured_file !== undefined && copy.result_captured_sha256 !== undefined) this.concludedAnswers.set(nodeId, { file: copy.result_captured_file, sha256: copy.result_captured_sha256 });
    const collected = { result, failure };
    const status: SessionStatus = result === null ? 'failed' : statusForOutcome(result.outcome);
    const failureReason =
      collected.failure ?? (status === 'failed' && result !== null ? `WORKER_${result.outcome}` : null);
    // One ledger record per generation whose result is concluded: a resumed
    // settlement of a captured result is the same attempt, never a second one.
    const concluded = (result !== null ? this.state().nodes[nodeId]?.claim?.result_captured_dispatch_id : undefined) ?? generation;
    appendRun(this.paths.runs, {
      attempt_id: `${nodeId}#${attempt}`,
      idempotency_key: `${nodeId}#${attempt}#${claim.claim_id}#${concluded}`,
      loop_id: `node-agent:${nodeId}`,
      parent_loop_id: `feature-orchestration:${this.featureId}`,
      node_id: nodeId,
      candidate_sha: null,
      input_hash: claim.claim_id.slice(0, 16),
      started_at: new Date(Number.isNaN(started) ? Date.now() : started).toISOString(),
      finished_at: new Date().toISOString(),
      model_turns: usage.model_turns,
      usage,
      wall_clock_ms: usage.wall_clock_ms,
      commands: (result?.commands ?? []).map((c) => c.command.join(' ')),
      exit_codes: (result?.commands ?? []).map((c) => c.exit_code),
      failure_fingerprint: result?.failure_fingerprint ?? failureReason,
      evidence_paths: result?.evidence_paths ?? [],
      transition: status,
    });
    const report = this.concludeAttempt(nodeId, null, { status, result, failureReason }, []);
    this.fault('attempt-concluded');
    return report;
  }

  private fault(point: SettleFaultPoint): void {
    try {
      this.settleFault?.(point);
    } catch (err) {
      throw new InjectedFault(err);
    }
  }

  private sessionDir(nodeId: string): string {
    const dir = join(this.paths.sessionsDir, safeNodeDir(nodeId));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Record a captured controller copy on the claim and count the worker's
   * usage, in one STATE.json write: either both happened or neither did, so
   * a settle that dies on either side of it never loses or double-counts.
   */
  private recordCapture(
    s: FeatureState_,
    nodeId: string,
    captured: { file: string; sha256: string; dispatchId: string; usage: UsageTotals },
    claimId?: string,
  ): FeatureState_ {
    const c = s.nodes[nodeId]?.claim;
    if (!c || (claimId !== undefined && c.claim_id !== claimId)) return s;
    c.result_captured_sha256 = captured.sha256;
    c.result_captured_file = captured.file;
    c.result_captured_dispatch_id = captured.dispatchId;
    c.capture_pending = null;
    if (c.usage_counted_for === captured.dispatchId) return s;
    const next = accumulateUsage(s, nodeId, captured.usage);
    ((next.nodes[nodeId] as NodeRuntime).claim as NodeClaim).usage_counted_for = captured.dispatchId;
    return next;
  }

  /**
   * At a resume: take the result the current generation left in its slot
   * into a controller copy, validated against that generation and with its
   * capability redacted by hash. Returns null (and drops the file) when
   * there is none or it does not validate.
   */
  private attestSlot(
    nodeId: string,
    claim: NodeClaim,
  ): { file: string; sha256: string; dispatchId: string; usage: UsageTotals } | null {
    const cwd = claim.worktree ?? this.controlRoot;
    const resultFile = claim.result_file ?? WORKER_RESULT_FILE;
    if (!resultInSlot(cwd, resultFile)) return null;
    const generation = claim.dispatch_id ?? claim.claim_id;
    const file = `result.${generation}.${randomBytes(16).toString('hex')}.json`;
    const collected = collectWorkerResult(
      cwd,
      { featureId: this.featureId, nodeId, claimId: claim.claim_id, ...(claim.dispatch_id !== undefined ? { dispatchId: claim.dispatch_id } : {}) },
      join(this.sessionDir(nodeId), file),
      process.env,
      {
        resultFile,
        ...(claim.capability_sha256 !== undefined ? { capabilitySha256: claim.capability_sha256 } : {}),
        ...(claim.worktree === null ? { fallbackQuarantineDir: null } : {}),
      },
    );
    if (collected.result === null) {
      this.event('dispatch.attest_refused', nodeId, { claim_id: claim.claim_id, failure: collected.failure.slice(0, 300) });
      return null;
    }
    return {
      file,
      sha256: sha256OfFile(join(this.sessionDir(nodeId), file)),
      dispatchId: generation,
      usage: hostUsage(collected.result, Date.parse(claim.dispatched_at ?? claim.claimed_at)),
    };
  }

  /**
   * A settle that died after writing its controller copy but before
   * recording it: finish that capture from the copy it announced, after the
   * same checks as any captured copy.
   */
  private finishPendingCapture(nodeId: string, claim: NodeClaim, started: number): NodeResult | null {
    const pending = this.pendingCapture(nodeId, claim, started);
    if (pending === null) return null;
    mutateState(this.paths.featureDir, (s) => this.recordCapture(s, nodeId, pending.captured, claim.claim_id));
    return pending.result;
  }

  /** The controller copy a capture of this claim's current generation announced and wrote, checked. */
  private pendingCapture(
    nodeId: string,
    claim: NodeClaim,
    started: number,
  ): { result: NodeResult; captured: { file: string; sha256: string; dispatchId: string; usage: UsageTotals } } | null {
    const pending = claim.capture_pending;
    if (!pending || pending.dispatch_id !== (claim.dispatch_id ?? claim.claim_id)) return null;
    const file = join(this.sessionDir(nodeId), pending.file);
    const parsed = readControllerCopy(file, null, nodeId, claim.claim_id, claim.dispatch_id);
    if (parsed === null) return null;
    return {
      result: parsed,
      captured: { file: pending.file, sha256: sha256OfFile(file), dispatchId: pending.dispatch_id, usage: hostUsage(parsed, started) },
    };
  }

  /** RUNNING or CANDIDATE_READY becomes VERIFIED once every node is settled. */
  private promoteSettledFeature(): void {
    mutateState(this.paths.featureDir, (s) => {
      if (s.feature_state === 'RUNNING' || s.feature_state === 'CANDIDATE_READY') s.feature_state = 'VERIFIED';
      return s;
    });
  }

  /**
   * Cut an immutable candidate from every repository integration branch.
   *
   * Refuses on a dirty worktree or a missing branch, so a candidate always
   * corresponds to a reproducible checkout.
   */
  private runCandidateNode(nodeId: string): NodeRunReport {
    const evidence: EvidenceRecord[] = [];
    let claimId: string | null = null;
    // Never a candidate before an acceptance review PASS bound to what it would bind: nothing claimed or charged.
    if (!this.reviewPassed()) {
      return this.report(nodeId, 'PRECONDITION_FAILED', null, `PRECONDITION_FAILED: REVIEW_REQUIRED: no acceptance review PASS binds the repository heads, graph and criteria ${nodeId} would bind; dispatch hands out the review`, evidence);
    }
    try {
      claimId = this.claim(nodeId, { mode: 'controller' }).claimId;
      const contracts = existsSync(this.workspace.paths.contractsDir)
        ? readdirSync(this.workspace.paths.contractsDir)
            .filter((f) => !f.startsWith('.'))
            .map((f) => `contracts/${f}`)
        : [];

      // Bound and made current under the feature's delivery lock: never in
      // the middle of a delivery, a rework or a supersede.
      const manifest = withFeatureLock(this.paths.featureDir, 'candidate build', () => {
        const repoRefs = this.integrationRefs();
        if (repoRefs.length === 0) return null;
        const cut = createCandidate({
          controlRepo: this.controlRoot,
          featureDir: this.paths.featureDir,
          featureId: this.featureId,
          repositories: repoRefs,
          contracts,
        });
        mutateState(this.paths.featureDir, (s) => {
          if (!s.candidates.includes(cut.candidate_id)) s.candidates.push(cut.candidate_id);
          s.current_candidate = cut.candidate_id;
          if (s.feature_state === 'RUNNING') s.feature_state = 'CANDIDATE_READY';
          return s;
        });
        return cut;
      });
      if (manifest === null) {
        return this.failAttempt(nodeId, null, 'NO_INTEGRATION_BRANCHES', evidence);
      }

      const record: EvidenceRecord = {
        kind: 'candidate',
        node_id: nodeId,
        command: ['mycelink', 'candidate', 'create', this.featureId],
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        cwd: '.',
        repository: null,
        commit_sha: manifest.control_commit,
        output_path: `features/${this.featureId}/candidates/${manifest.candidate_id}.yaml`,
        output_sha256: sha256OfFile(join(this.paths.candidatesDir, `${manifest.candidate_id}.yaml`)),
        failure_fingerprint: null,
        candidate_id: manifest.candidate_id,
      };
      evidence.push(record);
      this.setEvidence(nodeId, record);

      this.advanceVerifiedGates(nodeId);
      this.transition(nodeId, 'INTEGRATED');
      this.transition(nodeId, 'DONE');
      this.releaseClaim(nodeId);
      return this.report(nodeId, 'DONE', null, manifest.candidate_id, evidence);
    } catch (err) {
      if (err instanceof FeatureBusyError && claimId !== null) {
        // Another delivery, rework or candidate cut is running: handed back
        // unspent, nothing recorded.
        const detail = `PRECONDITION_FAILED: ${err.message}`;
        this.releaseForInfrastructure(nodeId, claimId, detail);
        return this.report(nodeId, 'PRECONDITION_FAILED', null, detail, evidence);
      }
      if (err instanceof DirtyWorktreeError && claimId !== null) {
        // Uncommitted files in the control repository or an integration
        // worktree: a precondition the host can fix by committing them, not
        // a failure of the build. Handed back unspent, nothing recorded.
        const detail = `PRECONDITION_FAILED: ${err.message} Commit (or remove) those files, then dispatch again.`;
        this.releaseForInfrastructure(nodeId, claimId, detail);
        return this.report(nodeId, 'PRECONDITION_FAILED', null, detail, evidence);
      }
      return this.failAttempt(
        nodeId,
        null,
        err instanceof Error ? err.message : String(err),
        evidence,
      );
    }
  }

  /**
   * Run a verification node (engine/verification-node.ts) as the controller:
   * bind every verifier (a drifted module charges nothing), claim it with no
   * worktree, check out the repository's integrated head afresh, set it up as
   * the repository declares, run each verifier there and remove the checkout,
   * then record one receipt binding all of it as the node's evidence and its
   * compatibility criteria by that receipt, and conclude DONE. A failing
   * verifier is the node's recorded, retryable verification failure; a
   * checkout that cannot be set up, or an integration branch that moved, is a
   * precondition (handed back unspent). Nothing is written to the product
   * repository: no branch, no commit, no history to judge.
   */
  private runVerificationNode(nodeId: string): NodeRunReport {
    const evidence: EvidenceRecord[] = [];
    const node = this.node(nodeId);
    const repository = node.repository;
    const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === repository);
    if (repository === null || repoDecl === undefined) {
      return this.report(nodeId, 'PRECONDITION_FAILED', null, `PRECONDITION_FAILED: verification node ${nodeId} names no registered repository`, evidence);
    }
    let steps: VerificationStep[];
    try {
      // Everything it runs, bound before anything is claimed.
      steps = verificationSteps(nodeId, node, repoDecl);
    } catch (err) {
      if (err instanceof ModuleDriftError) {
        this.event('dispatch.stopped', nodeId, { status: 'PRECONDITION_FAILED', detail: err.message.slice(0, 500) });
        return this.report(nodeId, 'PRECONDITION_FAILED', null, err.message, evidence);
      }
      throw err;
    }
    let claimId: string;
    try {
      claimId = this.claim(nodeId, { mode: 'controller' }).claimId;
    } catch (err) {
      if (err instanceof NotSchedulableError || err instanceof ResourceBusyError) return this.report(nodeId, 'RETRY', null, errorText(err), evidence);
      if (err instanceof GraphDriftError || err instanceof AcceptanceDriftError) return this.report(nodeId, 'PRECONDITION_FAILED', null, errorText(err), evidence);
      throw err;
    }
    this.fault('verification-claimed');
    const precondition = (detail: string): NodeRunReport => {
      this.releaseForPrecondition(nodeId, claimId, detail);
      return this.report(nodeId, 'PRECONDITION_FAILED', null, detail, evidence);
    };

    const graph = this.graph();
    const repoPath = repositoryPath(this.workspace, repository);
    let head: string;
    let headSource: 'integration' | 'base';
    try {
      // The commit the candidate will bind: where the controller left the integration branch, or the base before anything was integrated.
      const trusted = trustedIntegrationHead(this.workspace, this.featureId, repository, { graph, state: this.state() });
      head = trusted ?? resolveRef(repoPath, `refs/heads/${repoDecl.base_branch}`);
      headSource = trusted === null ? 'base' : 'integration';
    } catch (err) {
      if (err instanceof IntegrationBranchMovedError) return precondition(`PRECONDITION_FAILED: ${err.message}`);
      throw err;
    }
    const criteria = verificationCriteria(graph, this.state(), node);
    if (!criteria.ok) {
      return this.failAttempt(nodeId, null, `VERIFICATION_CRITERION_UNOWNED:${criteria.criterion}: ${criteria.criterion} (${criteria.kind}) has no DONE upstream producer that owns its proof`, evidence);
    }

    const evidenceDir = nodeEvidenceDir(this.controlRoot, this.featureId, nodeId);
    const where = this.verificationCheckoutPrefix(nodeId) as { root: string; prefix: string };
    mkdirSync(where.root, { recursive: true });
    const checkout = join(where.root, `${where.prefix}${randomUUID().slice(0, 8)}`);
    runGit(repoPath, ['worktree', 'prune'], { allowFail: true });
    runGit(repoPath, ['worktree', 'add', '--detach', checkout, head]);
    runGit(checkout, ['config', 'core.autocrlf', 'false'], { allowFail: true });
    const runs: VerificationRun[] = [];
    let setup: { config_sha256: string; receipt_path: string; receipt_sha256: string } | null = null;
    try {
      const config = worktreeSetupOf(repoDecl);
      if (config !== null) {
        const run = runWorktreeSetup({ controlRoot: this.controlRoot, repository, repoPath, worktree: checkout, root: where.root, config, evidenceDir, label: `${safeNodeDir(nodeId)}.verification-setup` });
        // The setup of its checkout is on record like any worker's: complete, with the repository's config and its receipt.
        mutateState(this.paths.featureDir, (s) => {
          const rt = s.nodes[nodeId];
          if (rt) rt.worktree_setup = run.record;
          return s;
        });
        this.event('worktree.setup', nodeId, { claim_id: claimId, purpose: 'verification', status: run.receipt.status, code: run.receipt.code, receipt_path: run.receipt_path, receipt_sha256: run.receipt_sha256, output_path: run.receipt.output_path });
        if (run.receipt.status !== 'complete') return precondition(new WorktreeSetupError(`${nodeId} verification`, run.receipt, run.receipt_path).message);
        setup = { config_sha256: worktreeSetupSha256(config), receipt_path: run.receipt_path, receipt_sha256: run.receipt_sha256 };
      }
      for (const step of steps) {
        const ran = runVerification({
          kind: 'regression',
          nodeId,
          repository,
          ...(step.module !== null ? moduleInvocation(step.module) : verifierInvocation(step.verifier)),
          cwd: step.module === null && step.verifier.cwd !== undefined ? join(checkout, step.verifier.cwd) : checkout,
          evidenceDir,
          label: `verification-${step.verifier.id}`,
          baselineFailures: repoDecl.baseline_failures ?? [],
          allowShell: this.workspace.config.allow_shell_commands,
          pathBase: this.controlRoot,
          ...(step.verifier.expect_exit !== undefined ? { expectExit: step.verifier.expect_exit } : {}),
        });
        runs.push({ step, record: setup === null ? ran : { ...ran, worktree_setup_sha256: setup.receipt_sha256 } });
        if (ran.failure_fingerprint !== null) break;
      }
      // The commands ran and their checkout is still there (where a controller dying mid-run leaves it).
      this.fault('verification-ran');
    } catch (err) {
      if (err instanceof InjectedFault) throw err;
      if (err instanceof CommandPolicyError) return this.failAttempt(nodeId, null, `VERIFICATION_FAILED:${err.message}`, evidence);
      throw err;
    } finally {
      removeWorkerWorktree(repoPath, checkout);
    }

    // One receipt binds what ran; it is the node's evidence, whatever the outcome.
    const receipt = verificationReceipt({ controlRoot: this.controlRoot, featureId: this.featureId, nodeId, claimId, repository, head, headSource, setup, runs, criteria: criteria.criteria });
    mkdirSync(evidenceDir, { recursive: true });
    const file = join(evidenceDir, `${safeNodeDir(nodeId)}.verification-${randomUUID().slice(0, 8)}.json`);
    writeTextAtomic(file, JSON.stringify(receipt, null, 2) + '\n');
    const failed = runs.find((r) => r.record.failure_fingerprint !== null);
    const fingerprint = failed === undefined ? null : `VERIFICATION_FAILED:${failed.step.verifier.id}:${failed.record.failure_fingerprint}`;
    const now = new Date().toISOString();
    const record: EvidenceRecord = {
      kind: 'regression',
      node_id: nodeId,
      command: ['mycelink', 'verification', this.featureId, nodeId],
      exit_code: failed?.record.exit_code ?? 0,
      started_at: runs[0]?.record.started_at ?? now,
      finished_at: now,
      cwd: '.',
      repository,
      commit_sha: head,
      output_path: relativeInside(this.controlRoot, file) ?? file,
      output_sha256: sha256OfFile(file),
      failure_fingerprint: fingerprint,
      ...(setup !== null ? { worktree_setup_sha256: setup.receipt_sha256 } : {}),
    };
    for (const kind of node.required_evidence.filter((k): k is 'green' | 'regression' => k === 'green' || k === 'regression')) {
      const kept = { ...record, kind };
      evidence.push(kept);
      this.setEvidence(nodeId, kept);
    }
    if (failed !== undefined) {
      const report = this.failAttempt(nodeId, null, fingerprint as string, evidence);
      const detail = `${fingerprint}: verifier "${failed.step.verifier.id}" exited ${failed.record.exit_code} on ${head.slice(0, 12)}; its output ${failed.record.output_path}, the receipt ${record.output_path}`;
      this.event('verification.failed', nodeId, { head_sha: head, verifier: failed.step.verifier.id, exit_code: failed.record.exit_code, receipt_path: record.output_path, fingerprint });
      return { ...report, detail };
    }
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (rt) rt.criteria = criteria.criteria.filter((c) => c.evidence === 'passed').map((c) => ({ criterion: c.criterion, test_id: null, test: null, gate: 'regression' as const, output_sha256: record.output_sha256 }));
      return s;
    });
    this.fault('verification-recorded');
    this.advanceVerifiedGates(nodeId);
    this.transition(nodeId, 'INTEGRATED');
    this.transition(nodeId, 'DONE');
    this.releaseClaim(nodeId);
    this.event('verification.completed', nodeId, {
      head_sha: head,
      head_source: headSource,
      receipt_path: record.output_path,
      receipt_sha256: record.output_sha256,
      tests_passed: receipt.tests.passed.length,
      criteria: receipt.criteria.map((c) => `${c.criterion}:${c.evidence}`),
    });
    return this.report(nodeId, 'DONE', null, `verified ${repository} at ${head.slice(0, 12)}: ${runs.length} command(s) passed, ${receipt.tests.passed.length} test(s) by id; receipt ${record.output_path}`, evidence);
  }

  // ---- the acceptance review (engine/acceptance-review.ts) -------------------

  /** Reviews a dispatch call settled, or finished the reworks of; reported with its result. */
  private reviewReports: ReviewSettleReport[] = [];

  /** The feature's review when it is required; null for a feature initialised before it existed, or opted out. */
  private requiredReview(state: FeatureState_ = this.state()): AcceptanceReviewState | null {
    const review = state.acceptance_review ?? null;
    return review !== null && review.required ? review : null;
  }

  /** Every node the review judges is settled: all but the candidate build and what runs on a candidate. */
  private reviewable(state: FeatureState_, graph: PortfolioGraph = this.graph()): boolean {
    return graph.nodes
      .filter((n) => !REVIEW_GATED_TYPES.has(n.node_type))
      .every((n) => {
        const st = state.nodes[n.id]?.state;
        return st === 'DONE' || st === 'EXCLUDED';
      });
  }

  /** What a review binds now, and its hash; null when an integration branch is not where the controller left it. */
  private reviewInputsNow(state: FeatureState_): { inputs: ReviewInputs; sha: string } | null {
    try {
      const inputs = currentReviewInputs(this.controlRoot, this.featureId, this.workspace, this.graph(), state);
      return { inputs, sha: reviewInputsSha256(inputs) };
    } catch (err) {
      if (err instanceof IntegrationBranchMovedError) return null;
      throw err;
    }
  }

  /**
   * Whether a candidate may be cut: no review required, or a PASS whose
   * untampered receipt binds exactly what the feature has now — the heads,
   * graph and criteria, and the orchestration epoch it was settled at, with
   * no dispatch lease outstanding and every node it judges DONE (CSET-203
   * r7: a PASS settled while the cli was reopened bound nothing).
   */
  reviewPassed(state: FeatureState_ = this.state()): boolean {
    const review = this.requiredReview(state);
    if (review === null) return true;
    if (review.blocked !== null) return false;
    const now = this.reviewInputsNow(state);
    if (now === null) return false;
    const pass = passFor(review.reviews, now.sha);
    if (pass === null || receiptProblem(this.controlRoot, pass) !== null) return false;
    // A PASS from before epochs binds only a feature whose epoch never moved since.
    if ((pass.epoch ?? 0) !== currentEpoch(state)) return false;
    const barrier = this.reviewBarrier(state);
    return barrier.leases.length === 0 && barrier.notDone.length === 0;
  }

  /**
   * What stands between the feature and a review of it (CSET-203 r7): the
   * dispatch leases outstanding that can still change what it judges (a
   * worker's, a verification run's), and each node it judges that is not
   * DONE (or EXCLUDED), less `allowed` (a refinement's standing reworks).
   */
  private reviewBarrier(state: FeatureState_, allowed: ReadonlySet<string> = new Set(), graph: PortfolioGraph = this.graph()): { leases: string[]; notDone: string[] } {
    const claimed = Object.entries(state.nodes)
      .filter(([id, rt]) => rt.claim !== null && !REVIEW_GATED_TYPES.has(graph.nodes.find((n) => n.id === id)?.node_type ?? ''))
      .map(([id, rt]) => `${id} (${(rt.claim as NodeClaim).dispatch_id ?? (rt.claim as NodeClaim).claim_id})`);
    const leased = activeLeases(state, BARRIER_KINDS).map((l) => `${l.node_id ?? l.review_id} (${l.lease_id})`);
    const notDone = graph.nodes
      .filter((n) => !REVIEW_GATED_TYPES.has(n.node_type) && !allowed.has(n.id))
      .filter((n) => {
        const st = state.nodes[n.id]?.state;
        return st !== 'DONE' && st !== 'EXCLUDED';
      })
      .map((n) => n.id);
    return { leases: [...new Set([...leased, ...claimed])], notDone };
  }

  /**
   * What a refinement of `reviewId` may leave unsettled: the standing reworks
   * of its gaps it does not decide (not DONE yet) and everything downstream
   * of them, which can only run after them. Anything else it judges settles
   * first — a reopened dependent, a verification consumer run again.
   */
  private standingLineage(state: FeatureState_, reviewId: string, graph: PortfolioGraph = this.graph()): Set<string> {
    const roots = Object.entries(state.nodes)
      .filter(([, rt]) => rt.state !== 'DONE' && rt.state !== 'EXCLUDED' && rt.rework_brief?.origin?.kind === 'acceptance-review' && rt.rework_brief.origin.review_id === reviewId)
      .map(([id]) => id);
    const out = new Set<string>(roots);
    const queue = [...roots];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const n of graph.nodes) {
        if (n.depends_on.includes(id) && !out.has(n.id)) {
          out.add(n.id);
          queue.push(n.id);
        }
      }
    }
    return out;
  }

  /**
   * Why an open review generation no longer reviews what the feature is
   * (null: it does): the orchestration epoch moved since it was issued, a
   * dispatch lease is outstanding, or a node it judges is not DONE (a
   * refinement: outside its review's standing reworks).
   */
  private reviewStaleReason(open: OpenReview, state: FeatureState_): string | null {
    const now = currentEpoch(state);
    if (open.epoch !== undefined && open.epoch !== now) {
      const since = (state.orchestration?.bumps ?? []).filter((b) => b.epoch > (open.epoch as number)).map((b) => b.reason);
      return `the orchestration epoch moved from ${open.epoch}, when ${open.review_id} was handed out, to ${now} (${since.slice(-3).join('; ') || 'later changes'})`;
    }
    const allowed = (open.refinement ?? null) !== null ? this.standingLineage(state, open.review_id) : new Set<string>();
    const barrier = this.reviewBarrier(state, allowed);
    if (barrier.leases.length > 0) return `dispatch leases are outstanding: ${barrier.leases.join(', ')}`;
    if (barrier.notDone.length > 0) return `nodes it judges are not DONE: ${barrier.notDone.map((id) => `${id}=${state.nodes[id]?.state ?? '?'}`).join(', ')}`;
    return null;
  }

  /**
   * An open review generation found stale at its settle: dropped, never
   * recorded, its lease stale; the reviewer session counted once. The next
   * dispatch hands out a new review once the barrier holds.
   */
  private staleOpenReview(open: OpenReview, why: string): ReviewSettleReport {
    const usage = { ...zeroUsage(), sessions: 1, wall_clock_ms: Math.max(0, Date.now() - Date.parse(open.issued_at)) };
    mutateState(this.paths.featureDir, (s) => {
      const r = s.acceptance_review;
      if (!r || r.open?.dispatch_id !== open.dispatch_id) return s;
      r.open = null;
      r.usage = addUsage(r.usage, usage);
      s.usage = addUsage(s.usage, usage);
      const l = (s.orchestration?.leases ?? []).find((x) => x.kind === 'review' && x.dispatch_id === open.dispatch_id);
      if (l !== undefined) markStale(l, why, null);
      return s;
    });
    removeReviewCheckouts(this.controlRoot, this.featureId, open.review_id, this.workspace);
    this.event('review.stale', null, { review_id: open.review_id, dispatch_id: open.dispatch_id, why: why.slice(0, 500), epoch: open.epoch ?? null });
    return this.staleReviewReport(open.review_id, open.dispatch_id, why, false);
  }

  /**
   * A stopped review generation's verdict settled (again): stale, recorded on
   * its lease. No usage: a generation found stale at its own settle was
   * counted there (staleOpenReview), a refused one at its refusal, and one
   * replaced by a resume or dropped by dispatch never is.
   */
  private staleReviewAnswer(reviewId: string, lease: DispatchLease): ReviewSettleReport {
    const first = (lease.stale ?? null) === null;
    const why = lease.stale?.reason ?? `its generation was ${lease.status}${lease.closed_reason !== null ? ` (${lease.closed_reason})` : ''}`;
    if (first) {
      mutateState(this.paths.featureDir, (s) => {
        const l = (s.orchestration?.leases ?? []).find((x) => x.lease_id === lease.lease_id && x.kind === 'review');
        if (l === undefined || (l.stale ?? null) !== null) return s;
        markStale(l, why, null);
        return s;
      });
      this.event('review.stale', null, { review_id: reviewId, dispatch_id: lease.dispatch_id, why: why.slice(0, 500), late: true });
    }
    return this.staleReviewReport(reviewId, lease.dispatch_id ?? '', why, !first);
  }

  private staleReviewReport(reviewId: string, dispatchId: string, why: string, idempotent: boolean): ReviewSettleReport {
    return {
      review_id: reviewId,
      dispatch_id: dispatchId,
      outcome: 'STALE_ORCHESTRATION_EPOCH',
      detail: `STALE_ORCHESTRATION_EPOCH: ${reviewId} (dispatch ${dispatchId}) no longer reviews what the feature is: ${why}. Nothing was recorded; dispatch hands out a new review once the work in flight has settled and every node it judges is DONE.`,
      code: 'STALE_ORCHESTRATION_EPOCH',
      receipt_path: null,
      receipt_sha256: null,
      reworked: [],
      gaps: [],
      blocked: false,
      idempotent,
      next: 'dispatch',
    };
  }

  /** Whether the generation left a verdict to settle: its verdict file, or a launched reviewer's completed final answer. */
  private verdictPresent(open: OpenReview): boolean {
    return this.slotHolds(open) || this.lifecycleOf(open).state === 'COMPLETED';
  }

  /** The generation's verdict file is there (the reviewer's Write, or a final answer ingested before). */
  private slotHolds(open: OpenReview): boolean {
    try {
      return lstatSync(join(this.controlRoot, ...open.slot.split('/'))).isFile();
    } catch {
      return false;
    }
  }

  /** The reviewer's wall-clock, as the feature's review policy fixed it at init (CSET-203 r13; 20 minutes before it did). */
  private reviewerTimeoutMs(state: FeatureState_ = this.state()): number {
    const t = state.acceptance_review?.reviewer_timeout_ms;
    return typeof t === 'number' && Number.isInteger(t) && t > 0 ? t : DEFAULT_REVIEWER_TIMEOUT_MS;
  }

  /** Where the open generation's reviewer stands (engine/review-transport.ts reviewerLifecycle). */
  private lifecycleOf(open: OpenReview, options: { agentId?: string | undefined; hostText?: string | undefined } = {}, state?: FeatureState_): ReviewerLifecycle {
    return reviewerLifecycle(this.controlRoot, open, { ...options, timeoutMs: this.reviewerTimeoutMs(state) });
  }

  /** The reviewer's standing as status, settle and `review await` report it: by hash only, never its prompt or answer. */
  private reviewerStatus(open: OpenReview, life: ReviewerLifecycle, state?: FeatureState_): ReviewerStatus {
    const task = life.state === 'MISSING' || life.state === 'REJECTED' ? null : life.task;
    const interrupted = open.agent_interrupted ?? null;
    return {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      refinement: (open.refinement ?? null) !== null,
      state: life.state,
      task_sha256: idHash(task?.tool_use_id ?? interrupted?.tool_use_id ?? null),
      agent_id_sha256: idHash(task?.agent_id ?? null) ?? interrupted?.agent_id_sha256 ?? null,
      launched_at: task?.launched_at ?? interrupted?.launched_at ?? null,
      elapsed_ms: task?.elapsed_ms ?? interrupted?.elapsed_ms ?? null,
      remaining_ms: task?.remaining_ms ?? (interrupted !== null ? 0 : null),
      timeout_ms: task?.timeout_ms ?? this.reviewerTimeoutMs(state),
      notified_at: task?.notified_at ?? null,
    };
  }

  /** An interrupted generation's standing, from its mark (its reviewer is not read again). */
  private interruptedLife(open: OpenReview): ReviewerLifecycle {
    const m = open.agent_interrupted as AgentInterruptMark;
    const task = { tool_use_id: m.tool_use_id, session_id: '', agent_id: null, launched_at: m.launched_at, elapsed_ms: m.elapsed_ms, timeout_ms: m.timeout_ms, remaining_ms: 0, notified_at: null, notification: null, holder_alive: null, launch: { path: '', sha256: '' } };
    return m.reason === 'timeout' ? { state: 'TIMED_OUT', detail: 'its reviewer ran past its wall-clock', task } : { state: 'LOST', reason: m.reason, status: m.status, detail: `its reviewer was lost (${m.reason})`, task };
  }

  /** The review out with a reviewer, as reconcile and a waiting dispatch report it. */
  pendingReview(state: FeatureState_ = this.state()): PendingReview | null {
    const open = this.requiredReview(state)?.open ?? null;
    if (open === null) return null;
    const life = (open.agent_interrupted ?? null) !== null ? this.interruptedLife(open) : this.lifecycleOf(open, {}, state);
    return {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      expires_at: open.expires_at,
      expired: Date.parse(open.expires_at) <= Date.now(),
      verdict_present: this.slotHolds(open) || life.state === 'COMPLETED',
      refused: open.refused.some((r) => r.dispatch_id === open.dispatch_id),
      refinement: (open.refinement ?? null) !== null,
      reviewer: this.reviewerStatus(open, life, state),
    };
  }

  /**
   * Interrupt the open generation whose reviewer did not complete — past its
   * wall-clock (TIMED_OUT), or its host or task ended (LOST) — in one write:
   * its lease closed `interrupted-agent`, the generation marked, for the next
   * dispatch to re-issue it with nothing spent (no format correction, no
   * reviewer attempt, no round, no usage); a late answer of that reviewer is
   * stale. Past MAX_REVIEWER_INTERRUPTIONS of the review, the review stops
   * REVIEW_INVALID instead. Idempotent: a generation already interrupted is
   * left as it is.
   */
  /** What a generation keeps of a reviewer that did not complete: why, its task and agent by hash, how long it ran. */
  private markOf(life: Extract<ReviewerLifecycle, { state: 'TIMED_OUT' | 'LOST' }>, at: string = new Date().toISOString()): AgentInterruptMark {
    return {
      reason: life.state === 'TIMED_OUT' ? 'timeout' : life.reason,
      status: life.state === 'LOST' ? life.status : null,
      tool_use_id: life.task.tool_use_id,
      agent_id_sha256: idHash(life.task.agent_id),
      launched_at: life.task.launched_at,
      elapsed_ms: life.task.elapsed_ms,
      timeout_ms: life.task.timeout_ms,
      at,
    };
  }

  private interruptReviewer(open: OpenReview, life: Extract<ReviewerLifecycle, { state: 'TIMED_OUT' | 'LOST' }>): { interrupted: boolean; blocked: boolean; count: number } {
    const at = new Date().toISOString();
    const mark = this.markOf(life, at);
    let interrupted = false;
    let blocked = false;
    let count = open.interruptions ?? 0;
    mutateState(this.paths.featureDir, (s) => {
      const r = s.acceptance_review;
      const live = r?.open ?? null;
      if (!r || live === null || live.dispatch_id !== open.dispatch_id || (live.agent_interrupted ?? null) !== null) return s;
      interrupted = true;
      count = (live.interruptions ?? 0) + 1;
      const reason = `its reviewer was interrupted (${mark.reason}${mark.status !== null ? ` ${mark.status}` : ''}) after ${Math.round(mark.elapsed_ms / 1000)} s of ${Math.round(mark.timeout_ms / 1000)} s`;
      closeLeases(s, (l) => l.kind === 'review' && l.dispatch_id === open.dispatch_id, 'interrupted-agent', reason, at);
      for (const l of s.orchestration?.leases ?? []) if (l.kind === 'review' && l.dispatch_id === open.dispatch_id && l.status === 'interrupted-agent') l.agent = mark;
      live.agent_interrupted = mark;
      live.interruptions = count;
      if (count > MAX_REVIEWER_INTERRUPTIONS) {
        blocked = true;
        const why = `the reviewer of ${open.review_id} was interrupted ${count} times (the last: ${mark.reason}${mark.status !== null ? ` ${mark.status}` : ''}, after ${Math.round(mark.elapsed_ms / 1000)} s of its ${Math.round(mark.timeout_ms / 1000)} s wall-clock); at most ${MAX_REVIEWER_INTERRUPTIONS} are re-issued`;
        r.blocked = { code: 'REVIEW_INVALID', review_id: open.review_id, detail: why, at };
        r.open = null;
        s.feature_state = 'BLOCKED';
        s.blocked_reason = `REVIEW_INVALID: ${why}`;
      }
      return s;
    });
    if (interrupted) {
      this.event('review.reviewer_interrupted', null, { review_id: open.review_id, dispatch_id: open.dispatch_id, reason: mark.reason, status: mark.status, task_sha256: idHash(mark.tool_use_id), agent_id_sha256: mark.agent_id_sha256, launched_at: mark.launched_at, elapsed_ms: mark.elapsed_ms, timeout_ms: mark.timeout_ms, count, blocked });
      if (blocked) removeReviewCheckouts(this.controlRoot, this.featureId, open.review_id, this.workspace);
    }
    return { interrupted, blocked, count };
  }

  /** A settle (or a replay of it) of a generation whose reviewer was interrupted: revoked, re-issued by the next dispatch, nothing spent. */
  private interruptedReviewReport(open: OpenReview, idempotent: boolean, blocked = false): ReviewSettleReport {
    const m = open.agent_interrupted ?? null;
    const what = m === null ? 'was interrupted' : m.reason === 'timeout' ? `ran past its wall-clock (${Math.round(m.elapsed_ms / 1000)} s of ${Math.round(m.timeout_ms / 1000)} s)` : m.reason === 'host-ended' ? 'was lost: the host session that launched it ended before it completed' : m.reason === 'launch-failed' ? 'was never started: its launch failed' : `ended ${m.status ?? 'early'} without completing`;
    const life = this.interruptedLife({ ...open, agent_interrupted: m ?? { reason: 'ended', status: null, tool_use_id: '', agent_id_sha256: null, launched_at: open.issued_at, elapsed_ms: 0, timeout_ms: this.reviewerTimeoutMs(), at: open.issued_at } });
    return {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      outcome: 'REVIEWER_INTERRUPTED',
      detail: blocked
        ? `REVIEWER_INTERRUPTED: the reviewer of ${open.review_id} (generation ${open.dispatch_id}) ${what}, past the bound of ${MAX_REVIEWER_INTERRUPTIONS} interruptions: the review stops REVIEW_INVALID for a person.`
        : `REVIEWER_INTERRUPTED: the reviewer of ${open.review_id} (generation ${open.dispatch_id}) ${what}. The generation is revoked; no format correction, reviewer attempt, round or usage was spent; its late answer is stale. If it still runs, stop it (TaskStop); dispatch hands a fresh reviewer generation of the same review out.`,
      code: null,
      receipt_path: null,
      receipt_sha256: null,
      reworked: [],
      gaps: [],
      blocked,
      idempotent,
      next: blocked ? 'stop' : 'dispatch',
      lifecycle: life.state,
      reviewer: this.reviewerStatus(open, life),
    };
  }

  /** A settle while the generation's reviewer runs, or before one was launched: nothing changes, nothing is spent. */
  private unsettledReviewReport(open: OpenReview, life: ReviewerLifecycle): ReviewSettleReport {
    const running = life.state === 'RUNNING';
    const status = this.reviewerStatus(open, life);
    return {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      outcome: running ? 'REVIEWER_RUNNING' : 'REVIEWER_NOT_LAUNCHED',
      detail: running
        ? `REVIEWER_RUNNING: the reviewer of ${open.review_id} (generation ${open.dispatch_id}) has not completed (${Math.round((status.elapsed_ms ?? 0) / 1000)} s of its ${Math.round(status.timeout_ms / 1000)} s wall-clock). Nothing was settled or spent: run the ticket's await line until it completes, then its ingest and settle lines; never settle, correct or relaunch it while it runs.`
        : `REVIEWER_NOT_LAUNCHED: no reviewer was launched for ${open.review_id} generation ${open.dispatch_id} and none wrote its verdict. Nothing was settled or spent: launch the reviewer with the ticket's prompt (the Agent tool), then run its await line.`,
      code: null,
      receipt_path: null,
      receipt_sha256: null,
      reworked: [],
      gaps: [],
      blocked: false,
      idempotent: true,
      next: running ? 'wait' : 'launch',
      lifecycle: life.state,
      reviewer: status,
    };
  }

  /**
   * `review await`: wait while the open generation's reviewer runs — at most
   * `waitMs`, its lifecycle read every REVIEW_AWAIT_POLL_MS — and say what
   * comes next (CSET-203 r13: never a settle, a correction or a relaunch
   * while it runs). A reviewer past its wall-clock, or whose host or task
   * ended, is interrupted here (interruptReviewer); one the provider ended is
   * reconciled as a provider interruption. With a capability, it must be the
   * open generation's (a settled or revoked one is answered so); without one,
   * the open generation's reviewer is read (a fresh controller, or the
   * benchmark harness, holds no ticket).
   */
  awaitReview(reviewId: string | null, capability: string | undefined, options: { waitMs?: number; pollMs?: number } = {}): ReviewAwaitReport {
    const review = this.requiredReview();
    if (review === null) throw new Error(`REVIEW_NOT_REQUIRED: ${this.featureId} has no acceptance review to await.`);
    const waitMs = Math.max(0, Math.min(options.waitMs ?? REVIEW_AWAIT_SECONDS * 1000, REVIEW_AWAIT_MAX_SECONDS * 1000));
    const pollMs = Math.max(10, options.pollMs ?? REVIEW_AWAIT_POLL_MS);
    const start = Date.now();
    let polls = 0;
    const report = (r: Omit<ReviewAwaitReport, 'feature_id' | 'waited_ms' | 'polls'>): ReviewAwaitReport => ({ feature_id: this.featureId, ...r, waited_ms: Date.now() - start, polls });
    if (capability !== undefined) {
      const settled = review.reviews.find((r) => (reviewId === null || r.review_id === reviewId) && (capabilityMatches(capability, r.capability_sha256) || (r.refinements ?? []).some((x) => capabilityMatches(capability, x.capability_sha256))));
      if (settled !== undefined) return report({ review_id: settled.review_id, dispatch_id: null, state: 'SETTLED', next: 'dispatch', detail: `${settled.review_id} was settled already: ${settled.outcome}`, reviewer: null });
      const lease = leaseOf(this.state(), (h) => capabilityMatches(capability, h));
      const open = review.open;
      if (lease !== null && lease.kind === 'review' && lease.status !== 'active' && lease.status !== 'settled' && (open === null || open.dispatch_id !== lease.dispatch_id)) {
        return report({ review_id: lease.review_id, dispatch_id: lease.dispatch_id, state: 'STALE', next: 'dispatch', detail: `generation ${lease.dispatch_id} no longer counts: it was ${lease.status}; dispatch hands out what comes next`, reviewer: null });
      }
      if (open === null || (reviewId !== null && open.review_id !== reviewId)) throw new CapabilityError('NOT_CLAIMED', `${reviewId ?? 'that review'} is not an open acceptance review of ${this.featureId}.`);
      if (!capabilityMatches(capability, open.capability_sha256)) throw new CapabilityError('CAPABILITY_INVALID', `the capability presented is not the one of ${open.review_id}'s current generation (stale, rotated, or of another review).`);
    }
    for (;;) {
      polls++;
      const now = this.requiredReview() as AcceptanceReviewState;
      const open = now.open;
      if (open === null || (reviewId !== null && open.review_id !== reviewId)) {
        return report({ review_id: reviewId, dispatch_id: null, state: 'NONE', next: now.blocked !== null ? 'stop' : 'dispatch', detail: now.blocked !== null ? `the acceptance review is blocked (${now.blocked.code}): ${now.blocked.detail}` : `no acceptance review${reviewId !== null ? ` ${reviewId}` : ''} is open: dispatch hands out what comes next`, reviewer: null });
      }
      const base = { review_id: open.review_id, dispatch_id: open.dispatch_id };
      if ((open.agent_interrupted ?? null) !== null) {
        const life = this.interruptedLife(open);
        return report({ ...base, state: life.state, next: 'dispatch', detail: this.interruptedReviewReport(open, true).detail, reviewer: this.reviewerStatus(open, life) });
      }
      if ((open.provider_interrupted ?? null) !== null) return report({ ...base, state: 'FAILED_PROVIDER', next: 'dispatch', detail: this.providerReviewReport(open, open.provider_interrupted as ProviderMark, true).detail, reviewer: null });
      if (open.refused.some((r) => r.dispatch_id === open.dispatch_id)) return report({ ...base, state: 'SETTLED', next: 'dispatch', detail: `generation ${open.dispatch_id} was settled: its verdict was refused; dispatch hands out the next generation`, reviewer: null });
      const life = this.lifecycleOf(open);
      const status = this.reviewerStatus(open, life);
      if (this.slotHolds(open) && life.state !== 'COMPLETED') return report({ ...base, state: life.state === 'MISSING' || life.state === 'RUNNING' ? 'COMPLETED' : life.state, next: 'settle', detail: `the reviewer wrote its verdict file: run the ticket's ingest and settle lines`, reviewer: status });
      switch (life.state) {
        case 'RUNNING': {
          const waited = Date.now() - start;
          if (waited + pollMs > waitMs) {
            return report({ ...base, state: 'RUNNING', next: 'await', detail: `the reviewer has not completed (${Math.round((status.elapsed_ms ?? 0) / 1000)} s of its ${Math.round(status.timeout_ms / 1000)} s wall-clock, ${Math.round((status.remaining_ms ?? 0) / 1000)} s left): run the await line again; never settle, correct or relaunch it while it runs`, reviewer: status });
          }
          sleepSync(pollMs);
          continue;
        }
        case 'COMPLETED':
          return report({ ...base, state: 'COMPLETED', next: 'ingest', detail: `the reviewer completed (${life.task.notification ?? 'recorded'} at ${life.task.notified_at ?? 'an unrecorded time'}): run the ticket's ingest line, then its settle line`, reviewer: status });
        case 'COMPLETED_NO_OUTPUT':
          return report({ ...base, state: 'COMPLETED_NO_OUTPUT', next: 'settle', detail: `${life.detail}: run the ticket's settle line (a generation that left no verdict gets a fresh reviewer)`, reviewer: status });
        case 'FAILED_PROVIDER': {
          const hit = this.providerReview(open);
          return report({ ...base, state: 'FAILED_PROVIDER', next: hit !== null ? 'dispatch' : 'settle', detail: hit !== null ? this.providerReviewReport(open, hit.failure, false).detail : `${life.detail}, not transient: run the ticket's settle line`, reviewer: status });
        }
        case 'TIMED_OUT':
        case 'LOST': {
          const r = this.interruptReviewer(open, life);
          const now = (this.requiredReview() as AcceptanceReviewState).open;
          const fresh = now !== null && (now.agent_interrupted ?? null) !== null ? now : { ...open, agent_interrupted: this.markOf(life) };
          return report({ ...base, state: life.state, next: r.blocked ? 'stop' : 'dispatch', detail: this.interruptedReviewReport(fresh, !r.interrupted, r.blocked).detail, reviewer: status });
        }
        case 'MISSING':
          return report({ ...base, state: 'MISSING', next: 'launch', detail: `no reviewer was launched for generation ${open.dispatch_id}: launch it with the ticket's prompt (the Agent tool), then run the await line; a fresh controller without the ticket re-issues it (dispatch --resume ${open.review_id})`, reviewer: status });
        case 'REJECTED':
          return report({ ...base, state: 'REJECTED', next: 'settle', detail: `${life.code}: ${life.detail}; settle refuses a generation that left no verdict`, reviewer: status });
      }
    }
  }

  /**
   * The review's turn in a dispatch: blocked, finishing the reworks of a
   * GAPS review a dead controller left, settling a verdict already in its
   * slot (no reviewer runs again), re-issuing a review whose verdict was
   * refused or whose reviewer never answered, waiting for one with its
   * reviewer, or handing out a new review once every product and
   * verification node is DONE and no PASS binds what they made. Null: the
   * review has nothing to do now. 'continue': it changed something; look again.
   */
  private reviewStep(state: FeatureState_, pending: PendingDispatch[]): DispatchResult | 'continue' | null {
    const review = this.requiredReview(state);
    if (review === null) return null;
    const result = (status: DispatchStatus, detail: string, extra: Partial<DispatchResult> = {}): DispatchResult => {
      this.event('dispatch.stopped', null, { status, detail: detail.slice(0, 500) });
      return { status, detail, controller_reports: [], pending, deferred: [], ...extra };
    };
    if (review.blocked !== null) return result('BLOCKED', `${review.blocked.code}: ${review.blocked.detail}`);
    // The per-criterion lineage reset or rewritten outside Mycelink (CSET-203 r11): no budget it says is believed; nothing goes on.
    const broken = this.lineageTrustProblems(state);
    if (broken.length > 0) {
      const last = review.reviews[review.reviews.length - 1]?.review_id ?? nextReviewId(this.featureId, state);
      const detail = `the acceptance review's per-criterion lineage in features/${this.featureId}/STATE.json is not the chain its receipts pin: ${broken.slice(0, 4).join('; ')}. Restore STATE.json from the control repository's history (git log -- features/${this.featureId}/STATE.json); no budget it records is believed.`;
      this.blockReview('REVIEW_LINEAGE_INVALID', last, detail, [], false);
      return result('BLOCKED', `REVIEW_LINEAGE_INVALID: ${detail}`);
    }
    // A review recorded as reworked whose rework records are not in STATE.json: it was changed outside Mycelink. Said, never built on.
    const lost = review.reviews.find((r) => r.reworks_applied && r.reworks.length > 0 && missingReworks(state, r.review_id, r.reworks).length > 0);
    if (lost !== undefined) {
      const missing = missingReworks(state, lost.review_id, lost.reworks);
      mutateState(this.paths.featureDir, (s) => {
        const rec = s.acceptance_review?.reviews.find((x) => x.review_id === lost.review_id);
        if (rec) rec.reworks_applied = false;
        return s;
      });
      return result(
        'BLOCKED',
        `REVIEW_REWORKS_MISSING: acceptance review ${lost.review_id} is recorded as reworked, but no rework record of ${missing.join(', ')} carries it: features/${this.featureId}/STATE.json was changed outside Mycelink. Restore it from the control repository's history (git log -- features/${this.featureId}/STATE.json); nothing is dispatched on a review whose reworks are not on record.`,
      );
    }
    // A per-criterion answer's unresolved criteria still to be ordered again (work was in flight): no review goes past them.
    if (this.orderPendingFollowUps().length > 0) return null;
    const unfinished = review.reviews.find((r) => r.outcome === 'GAPS' && !r.reworks_applied);
    if (unfinished !== undefined) {
      this.reviewReports.push(this.applyReviewReworks(unfinished.review_id));
      return 'continue';
    }
    const graph = this.graph();
    const open = review.open;
    if (open !== null) {
      const now = this.reviewInputsNow(state);
      // A refinement decides challenged gaps of a review while its reworks wait: it binds the heads, graph and criteria alone.
      const refining = (open.refinement ?? null) !== null;
      const moved = open.epoch !== undefined && open.epoch !== currentEpoch(state);
      if ((!refining && !this.reviewable(state, graph)) || now === null || now.sha !== open.inputs_sha256 || moved) {
        this.abandonReview(open, moved ? `the orchestration epoch moved from ${open.epoch} to ${currentEpoch(state)} since it was handed out` : 'what it reviews changed since it was handed out (a rework, a moved head, another graph or criteria)');
        return 'continue';
      }
      if (open.refused.some((r) => r.dispatch_id === open.dispatch_id)) return this.reissueReview(open, 'its verdict was refused');
      // Its reviewer (or host) was ended by a model provider (CSET-203 r10): a fresh generation, nothing spent; a late verdict never counts.
      if ((open.provider_interrupted ?? null) !== null) return this.reissueReview(open, `its reviewer was ended by the model provider (${open.provider_interrupted?.class})`);
      // Its reviewer was interrupted (CSET-203 r13: past its wall-clock, its host or task ended): a fresh generation, nothing spent.
      if ((open.agent_interrupted ?? null) !== null) return this.reissueReview(open, `its reviewer was interrupted (${open.agent_interrupted?.reason})`);
      // A verdict its reviewer wrote settles, whatever the reviewer still does.
      if (this.slotHolds(open)) {
        this.reviewReports.push(this.settleOpenReview('dispatch', open.dispatch_id));
        return 'continue';
      }
      // Its reviewer's lifecycle (CSET-203 r13): never a second generation while it runs, never a settle before it completed.
      const life = this.lifecycleOf(open, {}, state);
      switch (life.state) {
        case 'COMPLETED':
        case 'COMPLETED_NO_OUTPUT':
          this.reviewReports.push(this.settleOpenReview('dispatch', open.dispatch_id));
          return 'continue';
        case 'RUNNING': {
          const r = this.reviewerStatus(open, life, state);
          return result('WAITING', `await-reviewer: the reviewer of acceptance review ${open.review_id} (dispatch ${open.dispatch_id}) is running (${Math.round((r.elapsed_ms ?? 0) / 1000)} s of its ${Math.round(r.timeout_ms / 1000)} s wall-clock): run its ticket's await line until it completes, then its ingest and settle lines; nothing is settled, corrected or re-issued while it runs. A fresh controller without the ticket runs review await ${this.featureId} --review ${open.review_id}, then dispatch`, { pending_review: this.pendingReview(state) });
        }
        case 'TIMED_OUT':
        case 'LOST': {
          const r = this.interruptReviewer(open, life);
          if (r.blocked) return result('BLOCKED', `REVIEW_INVALID: ${(this.requiredReview() as AcceptanceReviewState).blocked?.detail ?? 'its reviewer was interrupted past the bound'}`);
          return this.reissueReview({ ...open, interruptions: r.count }, `its reviewer was interrupted (${life.state === 'TIMED_OUT' ? 'timeout' : life.reason})`);
        }
        case 'FAILED_PROVIDER': {
          const hit = this.providerReview(open);
          if (hit !== null) return this.reissueReview(open, `its reviewer was ended by the model provider (${hit.failure.class})`);
          this.reviewReports.push(this.settleOpenReview('dispatch', open.dispatch_id));
          return 'continue';
        }
        default:
          break;
      }
      if (Date.parse(open.expires_at) <= Date.now()) return this.reissueReview(open, 'its reviewer did not answer before the review expired');
      return result('WAITING', `acceptance review ${open.review_id} (dispatch ${open.dispatch_id}) has no reviewer that answered yet${life.state === 'MISSING' ? ' (none was launched: launch it with its ticket\'s prompt)' : ` (${life.code})`}: run its await line, then its ingest and settle lines; after an interruption, dispatch --resume ${open.review_id}`, { pending_review: this.pendingReview(state) });
    }
    // A valid challenge of a review's gap: a fresh reviewer refines it before anything else of the review runs (CSET-203
    // r6). The barrier first (CSET-203 r7): every dispatch lease settles (await-worker), and every node it judges is DONE
    // but the standing reworks of the gaps it does not decide (and what runs after them) — a dependent its rework had
    // reopened, a verification consumer, runs first. The refinement binds the heads it refines, and its refined gaps are
    // reworked in its settle.
    const challenged = this.pendingChallenges(state);
    if (challenged.length > 0) {
      const busy = [...new Set([...Object.entries(state.nodes).filter(([, rt]) => rt.claim !== null).map(([id]) => id), ...activeLeases(state, BARRIER_KINDS).map((l) => l.node_id ?? l.lease_id)])];
      if (busy.length > 0) {
        return result('WAITING', `await-worker: ${challenged.map((c) => c.challenge_id).join(', ')} ${challenged.length === 1 ? 'waits' : 'wait'} for ${busy.join(', ')} to settle before a fresh reviewer refines ${challenged.length === 1 ? 'it' : 'them'}`, { pending_review: this.pendingReview(state) });
      }
      const barrier = this.reviewBarrier(state, this.standingLineage(state, (challenged[0] as ReviewChallengeRecord).review_id, graph), graph);
      // What must settle first is the scheduler's to run (a verification consumer inline, a worker by its ticket).
      if (barrier.notDone.length > 0) return null;
      return this.issueRefinement(pending, challenged);
    }
    if (!this.reviewable(state, graph) || this.reviewPassed(state)) return null;
    // A new review only once no dispatch lease is outstanding (CSET-203 r7): nothing reviewed may still change.
    const leased = this.reviewBarrier(state, new Set(), graph).leases;
    if (leased.length > 0) return result('WAITING', `await-worker: no acceptance review while ${leased.join(', ')} ${leased.length === 1 ? 'holds a live lease' : 'hold live leases'}`, { pending_review: this.pendingReview(state) });
    // Every allowable gap reworked and settled: a criterion that exhausted its own budget blocks now (CSET-203 r11), and the
    // global ceilings (review sessions, consecutive reviews without progress) stop a review that cannot converge.
    const summary = this.lineageSummary(state);
    if (summary.pending_exhausted.length > 0) {
      const detail = this.exhaustedDetail(summary, summary.pending_exhausted);
      const criteria = [...new Set(summary.pending_exhausted.map((p) => p.criterion))];
      this.blockReview('REVIEW_GAPS', (summary.pending_exhausted[0] as { review_id: string }).review_id, detail, criteria, true);
      return result('BLOCKED', `REVIEW_GAPS: ${detail}`);
    }
    const why = nonconvergence(summary);
    if (why !== null) {
      const detail = this.nonconvergentDetail(summary, why);
      this.blockReview('REVIEW_NONCONVERGENT', summary.reviews[summary.reviews.length - 1]?.review_id ?? nextReviewId(this.featureId, state), detail, [], true);
      return result('BLOCKED', `REVIEW_NONCONVERGENT: ${detail}`);
    }
    // A completed proof the heads to be reviewed lost (CSET-201 final): restored before any reviewer is spent on them.
    const restored = this.restoreLostProofs(state);
    if (restored === 'restored') return 'continue';
    if (restored !== null) return result('BLOCKED', restored);
    return this.issueReview(pending);
  }

  // ---- the per-criterion lineage (engine/review-lineage.ts) ------------------

  /** A settled review's (or a refinement's) receipt as JSON, or null when it cannot be read. */
  private readReceiptLike(rel: string): Record<string, any> | null {
    try {
      return JSON.parse(readFileSync(join(this.controlRoot, ...rel.split('/')), 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  }

  /**
   * The review's lineage as STATE.json records it; for a review state from
   * before the lineage, derived from its records and pinned receipts
   * (migrateLineage) — the next write that touches it records it so.
   */
  private lineageOf(state: FeatureState_): ReviewLineage {
    const review = state.acceptance_review;
    if (review === undefined || review === null) return emptyLineage(2);
    if (review.lineage !== undefined) return review.lineage;
    // The safety the feature was initialised with (CSET-201 final): a state from before it takes the defaults.
    const safety = { ...(review.criterion_ceiling !== undefined ? { criterionCeiling: review.criterion_ceiling } : {}), ...(review.max_review_sessions !== undefined ? { maxReviewSessions: review.max_review_sessions } : {}), maxReviewMs: review.review_wall_clock_ms ?? null };
    if (review.reviews.length === 0 && (review.challenges ?? []).length === 0) return emptyLineage(review.max_rounds, safety);
    return migrateLineage({ reviews: review.reviews, challenges: review.challenges, maxCriterionReworks: review.max_rounds, safety, readReceipt: (rel) => this.readReceiptLike(rel) });
  }

  /** Each criterion's budget and the reviews' progress since the last accepted delivery. */
  private lineageSummary(state: FeatureState_, lineage: ReviewLineage = this.lineageOf(state)): LineageSummary {
    return summarizeLineage(lineage, reviewCriteria(this.controlRoot, this.featureId, this.graph()).map((c) => c.id), this.lastAcceptedAt(state));
  }

  /** Why the recorded lineage cannot be trusted (its chain, the heads the receipts pin): empty when it can, or when there is none yet. */
  private lineageTrustProblems(state: FeatureState_): string[] {
    const review = state.acceptance_review;
    if (review === undefined || review === null) return [];
    // Each review's revision chain and every rebase record too (engine/review-revision.ts): one changed outside Mycelink binds nothing.
    return [...lineageProblems(review, (rel) => this.readReceiptLike(rel)), ...revisionTrustProblems(review, state.nodes, (rel) => readReceiptFile(this.controlRoot, rel))];
  }

  /**
   * Each gap's criterion and its accepted-rework budget before this review's rework of it, its ceiling and the basis it
   * is reworked on (engine/review-lineage.ts): what a rework reason names.
   */
  private budgetsOf(summary: LineageSummary, gaps: readonly Gap[], judged: readonly GapLineageJudgement[] = []): Record<string, ReasonBudget> {
    return Object.fromEntries(
      gaps.map((g) => {
        const c = summary.criteria[g.criterion];
        const basis = judged.find((j) => j.criterion === g.criterion)?.basis;
        return [g.criterion, { used: c?.accepted_reworks ?? 0, max: c?.max ?? summary.max_criterion_reworks, ceiling: c?.ceiling ?? summary.criterion_ceiling, ...(basis === 'progress' || basis === 'regression' || basis === 'budget' ? { basis } : {}) }];
      }),
    );
  }

  /**
   * What the producers did for each criterion's last accepted gap (CSET-201 final), verified from their completion
   * ledgers: every producer reworked for it settled the criterion answering exactly that gap — with its own RED, a
   * re-proof or a compatibility proof, never a carried proof alone — and that work is in the heads reviewed now.
   * Progress is a production change or a new proof. What a review past a criterion's budget is reworked on.
   */
  private progressFacts(state: FeatureState_, summary: LineageSummary, criteria: readonly string[], heads: readonly { name: string; head_sha: string }[]): Record<string, ProgressFact> {
    const graph = this.graph();
    const out: Record<string, ProgressFact> = {};
    for (const criterion of new Set(criteria)) {
      const last = [...(summary.criteria[criterion]?.reproductions ?? [])].filter((r) => r.status === 'accepted').sort((a, b) => b.seq - a.seq)[0];
      if (last === undefined || last.nodes.length === 0) {
        out[criterion] = { verified: false, basis: 'none', records: [], detail: `${criterion} has no accepted, reworked gap to show progress on` };
        continue;
      }
      const records: string[] = [];
      const missing: string[] = [];
      let changed = false;
      let proved = false;
      for (const nodeId of last.nodes) {
        const node = graph.nodes.find((n) => n.id === nodeId);
        const head = node?.repository ? heads.find((h) => h.name === node.repository)?.head_sha : undefined;
        const ledger = node === undefined ? [] : this.ledgerFor(nodeId, state);
        const rec = [...ledger].reverse().find((r) => r.criterion === criterion && r.order?.review_id === last.review_id && r.order?.reproduction_sha256 === last.sha256 && (r.basis === 'red' || r.basis === 'reproved' || r.basis === 'compatibility'));
        const work = rec?.repo.integrated_sha ?? rec?.repo.head_sha ?? null;
        if (rec === undefined || node?.repository == null || head === undefined || work === null || state.nodes[nodeId]?.state !== 'DONE' || !isAncestor(repositoryPath(this.workspace, node.repository), work, head)) {
          missing.push(nodeId);
          continue;
        }
        records.push(rec.record_id);
        if (rec.production.paths.length > 0) changed = true;
        if (rec.basis !== 'red' || rec.reproof !== null) proved = true;
      }
      const verified = missing.length === 0 && (changed || proved);
      out[criterion] = {
        verified,
        basis: verified ? (changed ? 'producer-change' : 'new-proof') : 'none',
        records,
        detail: verified
          ? `${last.nodes.join(', ')} settled ${criterion} for ${last.review_id}'s gap with ${changed ? 'a RED and a production change' : 'a new proof'} (${records.join(', ')}), in the heads reviewed now`
          : `no verified progress on ${criterion} since ${last.review_id}'s gap: ${missing.length > 0 ? `${missing.join(', ')} holds no settled completion of it in the heads reviewed now` : 'its settlement changed no production code and added no proof'}`,
      };
    }
    return out;
  }

  /**
   * Block the review in one write: its code, the review it names, why, the
   * criteria it names, and (unless the lineage is what cannot be trusted) the
   * lineage's fact of it, so an exhausted criterion is reported once.
   */
  private blockReview(code: NonNullable<AcceptanceReviewState['blocked']>['code'], reviewId: string, detail: string, criteria: string[], record: boolean): void {
    const at = new Date().toISOString();
    mutateState(this.paths.featureDir, (s) => {
      const r = s.acceptance_review;
      if (!r) return s;
      if (record) r.lineage = appendLineage(this.lineageOf(s), [{ kind: 'blocked', review_id: reviewId, code, criteria }], at).lineage;
      r.blocked = { code, review_id: reviewId, detail: detail.slice(0, 4000), at, ...(criteria.length > 0 ? { criteria } : {}) };
      s.feature_state = 'BLOCKED';
      s.blocked_reason = `${code}: ${detail.slice(0, 1000)}`;
      return s;
    });
    this.event('review.blocked', null, { review_id: reviewId, code, criteria, detail: detail.slice(0, 500) });
  }

  /** Why an exhausted criterion blocks the feature, with its lineage. */
  private exhaustedDetail(summary: LineageSummary, pending: LineageSummary['pending_exhausted']): string {
    const named = pending.map((p) => {
      const c = summary.criteria[p.criterion];
      const accepted = c?.accepted_reworks ?? 0;
      const ceiling = c?.ceiling ?? summary.criterion_ceiling;
      // Never the budget alone (CSET-201 final): at the emergency ceiling, or past the budget with no verified producer progress.
      const why = accepted >= ceiling ? `at its emergency ceiling of ${ceiling} accepted rework(s)` : `${accepted} accepted rework(s), past its budget of ${c?.max ?? summary.max_criterion_reworks} with no verified producer progress since its last gap`;
      return `${p.criterion} (${why}; ${p.review_id}'s materially new reproduction ${p.reproduction_sha256.slice(0, 12)})`;
    });
    return [
      `${named.join('; ')}: exhausted. Every other allowable gap was reworked and settled first; no candidate is cut.`,
      `Lineage: ${budgetLine(summary)}; head ${String(summary.head_sha256).slice(0, 12)}.`,
      'A person decides: record a decision and rework past the block (node rework --decision grants each exhausted criterion one more accepted rework), or supersede the feature.',
    ].join(' ');
  }

  /** Why the review is nonconvergent, with its lineage. */
  private nonconvergentDetail(summary: LineageSummary, why: string): string {
    return [
      `${why}.`,
      `Lineage: ${budgetLine(summary)}; ${summary.review_sessions} review session(s) of ${summary.max_review_sessions}, ${summary.no_progress_streak} of ${summary.max_no_progress} without progress; head ${String(summary.head_sha256).slice(0, 12)}. No candidate is cut.`,
      'A person decides: record a decision and rework past the block (node rework --decision), or supersede the feature.',
    ].join(' ');
  }

  /** Every reproduction text the review's receipts hold (reviews and refinements), by the SHA-256 of its exact text. */
  private reproductionTexts(state: FeatureState_): Map<string, string> {
    const texts = new Map<string, string>();
    for (const rec of state.acceptance_review?.reviews ?? []) {
      for (const rel of new Set([rec.original?.receipt_path ?? rec.receipt_path, ...(rec.refinements ?? []).map((x) => x.receipt_path), rec.receipt_path])) {
        const r = this.readReceiptLike(rel);
        for (const g of (r?.['gaps'] ?? []) as { reproduction?: unknown }[]) if (typeof g.reproduction === 'string') texts.set(reproductionSha256(g.reproduction), g.reproduction);
        for (const d of (r?.['refinement']?.['decisions'] ?? []) as { gap?: { reproduction?: unknown } }[]) if (typeof d.gap?.reproduction === 'string') texts.set(reproductionSha256(d.gap.reproduction), d.gap.reproduction);
      }
    }
    return texts;
  }

  /** Every earlier reproduction of a criterion in the lineage but one never acted on: a refinement may repeat none of them. */
  private lineageReproductions(state: FeatureState_, criterion: string): string[] {
    const texts = this.reproductionTexts(state);
    return (this.lineageSummary(state).criteria[criterion]?.reproductions ?? []).filter((r) => r.status !== 'unreworkable').flatMap((r) => (texts.has(r.sha256) ? [texts.get(r.sha256) as string] : []));
  }

  /**
   * The reviewer's memory of this delivery (engine/review-packet.ts
   * ReviewMemory): each criterion's budget, the ceilings, and every earlier
   * finding with what became of it — its challenge's tests and assertion
   * lines, the producers reworked for it with their commits and evidence.
   */
  private reviewMemory(state: FeatureState_): ReviewMemory {
    const summary = this.lineageSummary(state);
    const texts = this.reproductionTexts(state);
    const challenges = state.acceptance_review?.challenges ?? [];
    const findings: ReviewFinding[] = Object.values(summary.criteria)
      .flatMap((c) => c.reproductions.map((r) => ({ criterion: c.criterion, r })))
      .sort((a, b) => a.r.seq - b.r.seq)
      .slice(-MAX_REVIEW_FINDINGS)
      .map(({ criterion, r }) => {
        const rec = r.challenge_id === null ? undefined : challenges.find((c) => c.challenge_id === r.challenge_id);
        let challenge: ReviewFinding['challenge'] = null;
        if (rec !== undefined) {
          const archived = readChallengeReceipt(this.controlRoot, rec.receipt_path) ?? {};
          const gap = ((archived['gaps'] ?? []) as Record<string, any>[]).find((x) => x['criterion'] === criterion) ?? {};
          const ids = (gap['tests'] ?? []) as string[];
          const tests = ((archived['tests'] ?? []) as { test_id: string; full_name: string }[]).filter((t) => ids.includes(t.test_id)).map((t) => ({ id: `test:${t.test_id}`, name: t.full_name }));
          const assertions = ((gap['clauses'] ?? []) as { assertions?: string[] }[]).flatMap((x) => x.assertions ?? []).slice(0, 12);
          challenge = { challenge_id: rec.challenge_id, decision: rec.gaps.find((g) => g.criterion === criterion)?.decision ?? null, tests, assertions };
        }
        const rework: ReviewFinding['rework'] =
          r.nodes.length === 0
            ? null
            : {
                nodes: r.nodes.map((id) => {
                  const rt = state.nodes[id];
                  return { node_id: id, state: rt?.state ?? null, integrated_sha: rt?.integrated_sha ?? null, evidence: (rt?.criteria ?? []).filter((x) => x.criterion === criterion).map((x) => ({ test_id: x.test_id, name: x.test?.name ?? null, gate: x.gate })) };
                }),
              };
        return { review_id: r.review_id, criterion, reproduction: (texts.get(r.sha256) ?? '').slice(0, 600), reproduction_sha256: r.sha256, fingerprint: r.fingerprint, status: r.status, duplicate_of: r.duplicate_of, challenge, rework };
      });
    return {
      budgets: Object.fromEntries(Object.values(summary.criteria).map((c) => [c.criterion, { accepted_reworks: c.accepted_reworks, max: c.max, remaining: c.remaining, ceiling: c.ceiling, ceiling_remaining: c.ceiling_remaining, challenges: c.challenges, withdrawals: c.withdrawals, duplicates: c.duplicates, regressions: c.regressions, exhausted: c.exhausted, closed: c.closed !== null, next_action: c.next_action }])),
      budget_line: budgetLine(summary),
      review_sessions: { used: summary.review_sessions, max: summary.max_review_sessions },
      no_progress: { streak: summary.no_progress_streak, max: summary.max_no_progress },
      findings,
    };
  }

  /** What feature status and review status say of the lineage: each criterion's budget and next action, the ceilings, the chain. */
  private lineageStatus(state: FeatureState_): Pick<NonNullable<ReturnType<Orchestrator['statusSummary']>['acceptance_review']>, 'criteria' | 'budget_line' | 'review_sessions' | 'no_progress' | 'lineage'> {
    const lineage = this.lineageOf(state);
    const summary = this.lineageSummary(state, lineage);
    return {
      criteria: Object.fromEntries(Object.values(summary.criteria).map((c) => [c.criterion, { accepted_reworks: c.accepted_reworks, max: c.max, remaining: c.remaining, ceiling: c.ceiling, ceiling_remaining: c.ceiling_remaining, challenges: c.challenges, withdrawals: c.withdrawals, duplicates: c.duplicates, regressions: c.regressions, exhausted: c.exhausted, closed: c.closed?.review_id ?? null, next_action: c.next_action }])),
      budget_line: budgetLine(summary),
      review_sessions: { used: summary.review_sessions, max: summary.max_review_sessions },
      no_progress: { streak: summary.no_progress_streak, max: summary.max_no_progress },
      lineage: { head_sha256: lineage.head_sha256, events: lineage.events.length, migrated: state.acceptance_review?.lineage === undefined ? lineage.events.length > 0 : lineage.events[0]?.kind === 'migrated', problems: this.lineageTrustProblems(state) },
    };
  }

  /** What feature status and review status say of the reviews' revisions and the orders bound to them (engine/review-revision.ts). */
  private revisionStatus(state: FeatureState_): Pick<NonNullable<ReturnType<Orchestrator['statusSummary']>['acceptance_review']>, 'revisions' | 'orders'> {
    const reviews = state.acceptance_review?.reviews ?? [];
    return {
      revisions: reviews.map((r) => {
        const chain = revisionChain(r);
        return { review_id: r.review_id, revision: chain.length - 1, receipts: chain.map((c, i) => ({ revision: c.revision, receipt_path: c.receipt_path, receipt_sha256: c.receipt_sha256, parent_sha256: i === 0 ? null : (chain[i - 1] as ReviewRevisionRef).receipt_sha256 })) };
      }),
      orders: Object.entries(state.nodes).flatMap(([id, rt]) => {
        const b = rt.rework_brief ?? null;
        if (b === null || b.origin?.kind !== 'acceptance-review') return [];
        const rec = [...reviews].reverse().find((r) => r.review_id === b.origin?.review_id);
        const bound = rec === undefined ? null : boundRevision(rec, b);
        return [{ node_id: id, review_id: b.origin.review_id, revision: bound?.revision ?? null, receipt_sha256: bound?.receipt_sha256 ?? null, current: rec !== undefined && bound !== null && bound.revision === currentRevision(rec).revision, rebases: (b.rebases ?? []).map((x) => ({ from: x.from.revision, to: x.to.revision, by: x.by, sha256: x.sha256 })) }];
      }),
    };
  }

  /** Valid challenges no refinement has decided yet, oldest first. */
  private pendingChallenges(state: FeatureState_): ReviewChallengeRecord[] {
    return (state.acceptance_review?.challenges ?? []).filter((c) => c.status === 'pending');
  }

  /**
   * A refinement of the review the oldest pending challenge challenges: a
   * fresh reviewer generation of that review, bound to the heads, graph and
   * criteria now and to each of its pending challenges by hash.
   */
  private issueRefinement(pending: PendingDispatch[], challenged: ReviewChallengeRecord[]): DispatchResult {
    const state = this.state();
    const review = this.requiredReview(state) as AcceptanceReviewState;
    const reviewId = (challenged[0] as ReviewChallengeRecord).review_id;
    const mine = challenged.filter((c) => c.review_id === reviewId);
    const record = [...review.reviews].reverse().find((r) => r.review_id === reviewId);
    if (record === undefined) {
      this.event('dispatch.stopped', null, { status: 'BLOCKED', detail: `${reviewId} is not a settled review`.slice(0, 500) });
      return { status: 'BLOCKED', detail: `REVIEW_NOT_SETTLED: ${mine.map((c) => c.challenge_id).join(', ')} challenge ${reviewId}, which is not a settled review of ${this.featureId}`, controller_reports: [], pending, deferred: [] };
    }
    let inputs: ReviewInputs;
    try {
      inputs = currentReviewInputs(this.controlRoot, this.featureId, this.workspace, this.graph(), state);
    } catch (err) {
      if (!(err instanceof IntegrationBranchMovedError)) throw err;
      this.event('dispatch.stopped', null, { status: 'PRECONDITION_FAILED', detail: err.message.slice(0, 500) });
      return { status: 'PRECONDITION_FAILED', detail: err.message, controller_reports: [], pending, deferred: [] };
    }
    const refinement: OpenRefinement = {
      round: Math.max(...mine.flatMap((c) => c.gaps.map((g) => g.round))),
      challenges: mine.map((c) => ({ challenge_id: c.challenge_id, challenge_sha256: c.challenge_sha256, criteria: c.gaps.map((g) => g.criterion), node_id: c.node_id })),
      of_receipt_path: record.receipt_path,
      of_receipt_sha256: record.receipt_sha256,
      of_inputs_sha256: record.inputs_sha256,
    };
    return this.openReviewGeneration({ reviewId, inputs, sha: reviewInputsSha256(inputs), review: record.review, attempt: 1, refused: [], resumed: false, refinement });
  }

  /**
   * What a refinement packet carries of the review it refines and of each
   * challenged gap (engine/review-packet.ts PacketRefinement): read from the
   * review's pinned receipt and each challenge's archived receipt.
   */
  private packetRefinement(reviewId: string, r: OpenRefinement): PacketRefinement {
    const state = this.state();
    const review = this.requiredReview(state) as AcceptanceReviewState;
    const record = [...review.reviews].reverse().find((x) => x.review_id === reviewId) as ReviewRecord;
    const abs = (rel: string): string => join(this.controlRoot, ...rel.split('/')).replace(/\\/g, '/');
    const receipt = (rel: string): { criteria?: VerdictCriterion[]; gaps?: Gap[]; packet_path?: string } => {
      try {
        return JSON.parse(readFileSync(join(this.controlRoot, ...rel.split('/')), 'utf8')) as { criteria?: VerdictCriterion[]; gaps?: Gap[]; packet_path?: string };
      } catch {
        return {};
      }
    };
    const now = receipt(record.receipt_path);
    const first = receipt(record.original?.receipt_path ?? record.receipt_path);
    // Every reproduction of a gap so far: the review's own, each refinement's, the one challenged now.
    const reproductions = (criterion: string): string[] => {
      const all = [first, ...(record.refinements ?? []).map((x) => receipt(x.receipt_path)), now].flatMap((x) => (x.gaps ?? []).filter((g) => g.criterion === criterion).map((g) => g.reproduction));
      return [...new Set(all)];
    };
    const challenges: PacketRefinement['challenges'] = r.challenges.flatMap((c) => {
      const rec = (review.challenges ?? []).find((x) => x.challenge_id === c.challenge_id) as ReviewChallengeRecord;
      const archived = readChallengeReceipt(this.controlRoot, rec.receipt_path) ?? {};
      const repository = this.node(rec.node_id).repository ?? '';
      return rec.gaps.map((g) => {
        const gap = ((archived['gaps'] ?? []) as Record<string, any>[]).find((x) => x['criterion'] === g.criterion) ?? {};
        const tests = ((archived['tests'] ?? []) as { test_id: string; path: string; full_name: string; status: string }[]).filter((t) => ((gap['tests'] ?? []) as string[]).includes(t.test_id));
        const capsule = gap['capsule'] !== undefined ? ((archived['capsules'] ?? []) as Record<string, any>[]).find((k) => k['capsule_id'] === gap['capsule']['capsule_id']) : undefined;
        const gate = (capsule?.['gate'] ?? archived['gate'] ?? {}) as Record<string, any>;
        return {
          challenge_id: rec.challenge_id,
          challenge_sha256: rec.challenge_sha256,
          node_id: rec.node_id,
          criterion: g.criterion,
          round: g.round,
          gap: { missing: String(gap['missing'] ?? ''), reproduction: String(gap['reproduction'] ?? ''), reproduction_sha256: g.reproduction_sha256 },
          // The review's own reproductions of the gap, and every one its criterion's lineage holds (CSET-203 r11).
          earlier_reproductions: [...new Set([...reproductions(g.criterion), ...this.lineageReproductions(state, g.criterion)])],
          tests: tests.map((t) => ({ id: `test:${t.test_id}`, test_id: t.test_id, path: t.path, name: t.full_name, status: t.status })),
          files: ((archived['files'] ?? []) as { path: string; archived: string; sha256: string }[]).map((f) => ({ repository, path: f.path, archived: abs(f.archived), sha256: f.sha256 })),
          gate: { output_path: abs(String(gate['output_path'] ?? rec.receipt_path)), output_sha256: String(gate['output_sha256'] ?? ''), results_path: typeof gate['results_path'] === 'string' ? abs(gate['results_path'] as string) : null, base_sha: rec.base_sha },
          clauses: (gap['clauses'] ?? []) as PacketRefinement['challenges'][number]['clauses'],
          explanation: String(gap['explanation'] ?? ''),
          receipt_path: abs(rec.receipt_path),
          evidence_id: `challenge:${rec.challenge_id}`,
          // The gap's reproduction capsule (CSET-203 r17): its bounded, sanitized artifact — the source and each test's block.
          ...(capsule !== undefined ? { capsules: [{ capsule_id: String(capsule['capsule_id']), capsule_sha256: String(capsule['capsule_sha256']), result: String(capsule['result']), artifact: abs(String(capsule['artifact'])), artifact_sha256: String(capsule['artifact_sha256']), tests: ((capsule['tests'] ?? []) as { test_id: string; status: string; full_name: string; block: unknown }[]).map((t) => ({ test_id: t.test_id, status: t.status, name: t.full_name, block: t.block })) }] } : {}),
        };
      });
    });
    const challengedNow = new Set(challenges.map((c) => c.criterion));
    return {
      round: r.round,
      max_rounds: MAX_CHALLENGE_ROUNDS,
      of: { review_id: reviewId, receipt_path: abs(record.receipt_path), receipt_sha256: record.receipt_sha256, packet_path: typeof first.packet_path === 'string' ? abs(first.packet_path) : null, inputs_sha256: record.inputs_sha256, overall: record.overall, criteria: now.criteria ?? [] },
      challenges,
      unchanged_gaps: (now.gaps ?? []).filter((g) => !challengedNow.has(g.criterion)),
    };
  }

  /** A new review of what every product and verification node made, handed to a fresh reviewer. */
  private issueReview(pending: PendingDispatch[]): DispatchResult {
    const state = this.state();
    const review = this.requiredReview(state) as AcceptanceReviewState;
    let inputs: ReviewInputs;
    try {
      inputs = currentReviewInputs(this.controlRoot, this.featureId, this.workspace, this.graph(), state);
    } catch (err) {
      if (!(err instanceof IntegrationBranchMovedError)) throw err;
      this.event('dispatch.stopped', null, { status: 'PRECONDITION_FAILED', detail: err.message.slice(0, 500) });
      return { status: 'PRECONDITION_FAILED', detail: err.message, controller_reports: [], pending, deferred: [] };
    }
    const since = this.lastAcceptedAt(state);
    const ordinal = review.reviews.filter((r) => since === null || r.at > since).length + 1;
    return this.openReviewGeneration({ reviewId: nextReviewId(this.featureId, state), inputs, sha: reviewInputsSha256(inputs), review: ordinal, attempt: 1, refused: [], resumed: false });
  }

  /** A review generation: its packet and checkouts, a new capability and verdict file, the ticket. */
  private openReviewGeneration(args: { reviewId: string; inputs: ReviewInputs; sha: string; review: number; attempt: number; refused: OpenReview['refused']; resumed: boolean; refinement?: OpenRefinement | null; interruptions?: number }): DispatchResult {
    const state = this.state();
    const review = this.requiredReview(state) as AcceptanceReviewState;
    const dispatchId = randomUUID();
    const capability = newCapability();
    const slot = reviewSlot(this.controlRoot, this.featureId, args.reviewId, dispatchId);
    const used = roundsUsed(review.reviews, this.lastAcceptedAt(state));
    const correction = this.correctionOf(args.refused);
    const built = buildReviewPacket({
      controlRoot: this.controlRoot,
      featureId: this.featureId,
      workspace: this.workspace,
      graph: this.graph(),
      state,
      reviewId: args.reviewId,
      dispatchId,
      review: args.review,
      roundsUsed: used,
      maxRounds: review.max_rounds,
      inputs: args.inputs,
      inputsSha256: args.sha,
      slotDir: slot.dir,
      verdictFile: slot.verdict,
      priorGaps: this.priorCompatibilityGaps(state, args.reviewId),
      correction,
      ...(args.refinement ? { refinement: this.packetRefinement(args.reviewId, args.refinement) } : {}),
      reviewMemory: this.reviewMemory(state),
    });
    const issued = new Date();
    const open: OpenReview = {
      review_id: args.reviewId,
      dispatch_id: dispatchId,
      capability_sha256: capability.sha256,
      inputs: args.inputs,
      inputs_sha256: args.sha,
      packet_path: controlRelative(this.controlRoot, built.path),
      packet_sha256: built.sha256,
      slot: controlRelative(this.controlRoot, slot.verdict),
      review: args.review,
      attempt: args.attempt,
      refused: args.refused,
      issued_at: issued.toISOString(),
      expires_at: new Date(issued.getTime() + this.workspace.config.session_timeout_ms + CLAIM_GRACE_MS).toISOString(),
      ...(args.refinement ? { refinement: args.refinement } : {}),
      host_session: this.hostBinding(),
      ...((args.interruptions ?? 0) > 0 ? { interruptions: args.interruptions } : {}),
    };
    mutateState(this.paths.featureDir, (s) => {
      if (s.acceptance_review) {
        // Bound to the epoch it is issued at, and leased: a verdict settled after the epoch moved is never recorded.
        open.epoch = currentEpoch(s);
        closeLeases(s, (l) => l.kind === 'review', 'revoked', `replaced by ${args.reviewId} generation ${dispatchId}`);
        s.acceptance_review.open = open;
        issueLease(s, { kind: 'review', node_id: null, review_id: args.reviewId, ...(args.refinement ? { refinement: true } : {}), claim_id: null, dispatch_id: dispatchId, capability_sha256: capability.sha256, generation: args.attempt, worktree: null, result_file: null, host: open.host_session ?? null });
      }
      return s;
    });
    this.event('review.dispatched', null, { review_id: args.reviewId, dispatch_id: dispatchId, attempt: args.attempt, review: args.review, inputs_sha256: args.sha, resumed: args.resumed, correction: correction?.number ?? null, epoch: open.epoch ?? null, ...(args.refinement ? { refinement: { round: args.refinement.round, challenges: args.refinement.challenges.map((c) => c.challenge_id) } } : {}) });
    const launcher = mycelinkCliPath().replace(/\\/g, '/');
    const ticket: ReviewTicket = {
      schema: REVIEW_TICKET_SCHEMA,
      kind: 'acceptance-review',
      feature_id: this.featureId,
      node_id: null,
      review_id: args.reviewId,
      dispatch_id: dispatchId,
      review: args.review,
      attempt: args.attempt,
      agent: REVIEWER_AGENT,
      capability: capability.raw,
      expires_at: open.expires_at,
      packet_path: built.path.replace(/\\/g, '/'),
      result_slot: slot.verdict.replace(/\\/g, '/'),
      criteria: built.packet.criteria.map((c) => c.id),
      inputs_sha256: args.sha,
      ingest_command: renderGateCommand(['node', launcher, 'review', 'ingest', this.featureId, '--review', args.reviewId, '--control-root', this.controlRoot.replace(/\\/g, '/'), '--capability', capability.raw, '--json']),
      await_command: renderGateCommand(['node', launcher, 'review', 'await', this.featureId, '--review', args.reviewId, '--control-root', this.controlRoot.replace(/\\/g, '/'), '--capability', capability.raw, '--wait-seconds', String(REVIEW_AWAIT_SECONDS), '--json']),
      settle_command: renderGateCommand(['node', launcher, 'review', 'settle', this.featureId, '--review', args.reviewId, '--control-root', this.controlRoot.replace(/\\/g, '/'), '--capability', capability.raw, '--json']),
      prompt: args.refinement ? refinementPrompt(built.packet, built.path, this.controlRoot) : reviewerPrompt(built.packet, built.path, this.controlRoot),
      resumed: args.resumed,
      correction,
      refinement: args.refinement
        ? { round: args.refinement.round, max_rounds: MAX_CHALLENGE_ROUNDS, challenges: args.refinement.challenges.flatMap((c) => c.criteria.map((criterion) => ({ challenge_id: c.challenge_id, criterion, node_id: c.node_id }))) }
        : null,
    };
    return {
      status: 'DISPATCHED',
      detail: `dispatched acceptance review ${args.reviewId}${args.refinement ? ` for its refinement (round ${args.refinement.round} of ${MAX_CHALLENGE_ROUNDS}: ${args.refinement.challenges.map((c) => c.challenge_id).join(', ')})` : ''} (generation ${args.attempt}${correction !== null ? `, format correction ${correction.number} of ${correction.max}` : ''}) to ${REVIEWER_AGENT}`,
      ticket,
      controller_reports: [],
      pending: this.pendingDispatches(),
      deferred: [],
    };
  }

  /**
   * The correction a new generation of a review makes, if any: of the last
   * verdict refused for its form, with its problems. A generation that left
   * no verdict to correct (none written, one not attested) changes nothing:
   * the next still corrects that verdict.
   */
  private correctionOf(refused: OpenReview['refused']): ReviewCorrection | null {
    const formats = refused.filter((r) => r.kind === 'format' && typeof r.verdict === 'string');
    const last = formats[formats.length - 1];
    if (last === undefined) return null;
    return {
      number: formats.length,
      max: MAX_FORMAT_CORRECTIONS,
      of_dispatch_id: last.dispatch_id,
      previous_verdict: join(this.controlRoot, ...(last.verdict as string).split('/')).replace(/\\/g, '/'),
      code: last.code,
      problems: last.problems ?? [],
      transport: REVIEWER_TRANSPORT,
    };
  }

  /**
   * The compatibility gaps earlier reviews of this delivery found (since the
   * last accepted delivery), each with the clauses its receipt says no test
   * covered: a PASS of such a clause now needs a test the gates passed.
   */
  private priorCompatibilityGaps(state: FeatureState_, reviewId: string): PriorGap[] {
    const since = this.lastAcceptedAt(state);
    const out: PriorGap[] = [];
    for (const record of state.acceptance_review?.reviews ?? []) {
      if (record.review_id === reviewId || record.overall !== 'GAPS' || (since !== null && record.at <= since)) continue;
      if (receiptProblem(this.controlRoot, record) !== null) continue;
      try {
        const receipt = JSON.parse(readFileSync(join(this.controlRoot, ...record.receipt_path.split('/')), 'utf8')) as { gaps?: Gap[] };
        for (const g of receipt.gaps ?? []) {
          if ((g.untested ?? []).length > 0) out.push({ review_id: record.review_id, criterion: g.criterion, untested: [...(g.untested as string[])] });
        }
      } catch {
        continue;
      }
    }
    return out;
  }

  /** The open review to a fresh reviewer generation: the old capability and verdict file stop counting. */
  private reissueReview(open: OpenReview, why: string): DispatchResult {
    this.event('review.reissued', null, { review_id: open.review_id, previous: open.dispatch_id, why });
    return this.openReviewGeneration({ reviewId: open.review_id, inputs: open.inputs, sha: open.inputs_sha256, review: open.review, attempt: open.attempt + 1, refused: open.refused, resumed: true, refinement: open.refinement ?? null, interruptions: open.interruptions ?? 0 });
  }

  /** An open review that no longer reviews what the feature is: dropped, never settled. */
  private abandonReview(open: OpenReview, why: string): void {
    mutateState(this.paths.featureDir, (s) => {
      if (s.acceptance_review?.open?.dispatch_id === open.dispatch_id) s.acceptance_review.open = null;
      return s;
    });
    removeReviewCheckouts(this.controlRoot, this.featureId, open.review_id, this.workspace);
    this.event('review.abandoned', null, { review_id: open.review_id, dispatch_id: open.dispatch_id, why });
  }

  /** `dispatch --resume <review_id>`: a verdict already in its slot is settled (no reviewer runs again), else a fresh generation. */
  private resumeReview(open: OpenReview): DispatchResult {
    if ((open.provider_interrupted ?? null) !== null) return this.reissueReview(open, 'its reviewer was ended by the model provider');
    if ((open.agent_interrupted ?? null) !== null) return this.reissueReview(open, `its reviewer was interrupted (${open.agent_interrupted?.reason})`);
    const settleIt = (): DispatchResult => {
      const report = this.settleOpenReview('resume', open.dispatch_id);
      return { status: 'SETTLED', detail: `settled acceptance review ${open.review_id} from the verdict in its slot: ${report.outcome}`, review_reports: [report], controller_reports: [], pending: this.pendingDispatches(), deferred: [], pending_review: this.pendingReview() };
    };
    if (open.refused.some((r) => r.dispatch_id === open.dispatch_id)) return this.reissueReview(open, 'resumed after an interruption');
    if (this.slotHolds(open)) return settleIt();
    // CSET-203 r13: the reviewer of this generation may still be running — its host lives on — and is never doubled.
    const life = this.lifecycleOf(open);
    switch (life.state) {
      case 'COMPLETED':
      case 'COMPLETED_NO_OUTPUT':
        return settleIt();
      case 'RUNNING': {
        const r = this.reviewerStatus(open, life);
        const detail = `REVIEWER_RUNNING: the reviewer of ${open.review_id} (dispatch ${open.dispatch_id}) launched before is still running (${Math.round((r.elapsed_ms ?? 0) / 1000)} s of its ${Math.round(r.timeout_ms / 1000)} s wall-clock): it is not re-issued. Wait for it (review await ${this.featureId} --review ${open.review_id}), then dispatch settles its answer.`;
        this.event('dispatch.stopped', null, { status: 'WAITING', detail: detail.slice(0, 500) });
        return { status: 'WAITING', detail, controller_reports: [], pending: this.pendingDispatches(), deferred: [], pending_review: this.pendingReview() };
      }
      case 'TIMED_OUT':
      case 'LOST': {
        const r = this.interruptReviewer(open, life);
        if (r.blocked) {
          const detail = `REVIEW_INVALID: ${(this.requiredReview() as AcceptanceReviewState).blocked?.detail ?? 'its reviewer was interrupted past the bound'}`;
          this.event('dispatch.stopped', null, { status: 'BLOCKED', detail: detail.slice(0, 500) });
          return { status: 'BLOCKED', detail, controller_reports: [], pending: this.pendingDispatches(), deferred: [] };
        }
        return this.reissueReview({ ...open, interruptions: r.count }, `its reviewer was interrupted (${life.state === 'TIMED_OUT' ? 'timeout' : life.reason})`);
      }
      case 'FAILED_PROVIDER': {
        if (this.providerReview(open) !== null) return this.reissueReview(open, 'its reviewer was ended by the model provider');
        return settleIt();
      }
      default:
        return this.reissueReview(open, 'resumed after an interruption');
    }
  }

  /**
   * `review ingest --capability <c>`: once the reviewer's Agent call has
   * returned, take its final answer as the generation's verdict when it
   * wrote none (reviewerTransport), bound to exactly that open generation —
   * its capability, its orchestration epoch, the reviewer launched for it.
   * Nothing is judged here: settle judges the verdict file whichever way it
   * came. A transport refused (another agent, a host copy that is not the
   * transcript's, a stale epoch, ...) writes and charges nothing. A settled
   * generation is answered from its record.
   */
  ingestReview(reviewId: string, capability: string | undefined, options: { agentId?: string | undefined; hostText?: string | undefined } = {}): ReviewIngestReport {
    const review = this.requiredReview();
    if (review === null) throw new Error(`REVIEW_NOT_REQUIRED: ${this.featureId} has no acceptance review to ingest.`);
    if (capability === undefined) throw new CapabilityError('CAPABILITY_REQUIRED', `${reviewId}: pass the review ticket's --capability.`);
    const settled = review.reviews.find((r) => r.review_id === reviewId && (capabilityMatches(capability, r.capability_sha256) || (r.refinements ?? []).some((x) => capabilityMatches(capability, x.capability_sha256))));
    if (settled !== undefined) return this.settledIngest(settled);
    const open = review.open;
    const lease = leaseOf(this.state(), (h) => capabilityMatches(capability, h));
    if (lease !== null && lease.kind === 'review' && lease.review_id === reviewId && lease.status !== 'active' && lease.status !== 'settled' && (open === null || open.dispatch_id !== lease.dispatch_id)) {
      return this.ingestReport(reviewId, lease.dispatch_id ?? '', 'STALE_ORCHESTRATION_EPOCH', `${reviewId} (dispatch ${lease.dispatch_id}) no longer counts: its generation was ${lease.status}. Nothing was written; dispatch hands out what comes next.`, { next: 'dispatch', idempotent: true });
    }
    if (open === null || open.review_id !== reviewId) throw new CapabilityError('NOT_CLAIMED', `${reviewId} is not an open acceptance review of ${this.featureId}.`);
    if (!capabilityMatches(capability, open.capability_sha256)) {
      throw new CapabilityError('CAPABILITY_INVALID', `the capability presented is not the one of ${reviewId}'s current generation (stale, rotated, or of another review).`);
    }
    // Its reviewer (or host) ended by a model provider before it answered: nothing to ingest; the generation is revoked.
    if ((open.provider_interrupted ?? null) !== null) return this.ingestReport(reviewId, open.dispatch_id, 'PROVIDER_INTERRUPTED', this.providerReviewReport(open, open.provider_interrupted as ProviderMark, true).detail, { next: 'dispatch', idempotent: true });
    // Its reviewer was interrupted (CSET-203 r13): nothing to ingest, ever; the generation is revoked.
    if ((open.agent_interrupted ?? null) !== null) return this.interruptedIngest(this.interruptedReviewReport(open, true));
    const interrupted = this.providerReview(open);
    if (interrupted !== null) return this.ingestReport(reviewId, open.dispatch_id, 'PROVIDER_INTERRUPTED', this.providerReviewReport(open, interrupted.failure, false).detail, { next: 'dispatch' });
    const lockDir = join(this.paths.featureDir, 'reviews');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'settle.lock'), () => this.ingestLocked(open.dispatch_id, options), { timeoutMs: 15_000, pollMs: 50, purpose: 'acceptance review ingest' });
  }

  /** An ingest of an interrupted generation, from the settle report of it. */
  private interruptedIngest(r: ReviewSettleReport): ReviewIngestReport {
    return this.ingestReport(r.review_id, r.dispatch_id, 'REVIEWER_INTERRUPTED', r.detail, { next: r.blocked ? 'dispatch' : 'dispatch', idempotent: r.idempotent, ...(r.lifecycle !== undefined ? { lifecycle: r.lifecycle } : {}), ...(r.reviewer !== undefined ? { reviewer: r.reviewer } : {}) });
  }

  private ingestLocked(dispatchId: string, options: { agentId?: string | undefined; hostText?: string | undefined }): ReviewIngestReport {
    const review = this.requiredReview() as AcceptanceReviewState;
    const settled = review.reviews.find((r) => r.dispatch_id === dispatchId || (r.refinements ?? []).some((x) => x.dispatch_id === dispatchId));
    if (settled !== undefined) return this.settledIngest(settled);
    const open = review.open;
    if (open === null || open.dispatch_id !== dispatchId) throw new Error(`REVIEW_NOT_OPEN: dispatch ${dispatchId} is not the open generation of an acceptance review of ${this.featureId}.`);
    const refused = open.refused.find((r) => r.dispatch_id === dispatchId);
    if (refused !== undefined) return this.ingestReport(open.review_id, dispatchId, 'SETTLED', `generation ${dispatchId} was settled already: its verdict was refused ${refused.code}; dispatch hands out the next generation`, { next: 'dispatch', idempotent: true, code: refused.code });
    const staleWhy = this.reviewStaleReason(open, this.state());
    if (staleWhy !== null) return this.ingestReport(open.review_id, dispatchId, 'STALE_ORCHESTRATION_EPOCH', `STALE_ORCHESTRATION_EPOCH: ${open.review_id} (dispatch ${dispatchId}) no longer reviews what the feature is: ${staleWhy}. Nothing was written; its settle records it.`, { next: 'settle', code: 'STALE_ORCHESTRATION_EPOCH' });
    const t = this.reviewerTransport(open, options, 'host');
    const base = { review_id: open.review_id, dispatch_id: dispatchId };
    const attested = (a: Attestation): Partial<ReviewIngestReport> => ({
      agent_id: typeof a.agent_id === 'string' ? a.agent_id : null,
      session_id: typeof a.session_id === 'string' ? a.session_id : null,
      tool_use_id: typeof a.tool_use_id === 'string' ? a.tool_use_id : null,
      result_sha256: typeof a['result_sha256'] === 'string' ? (a['result_sha256'] as string) : null,
      transcript_sha256: typeof a['transcript']?.['sha256'] === 'string' ? (a['transcript']['sha256'] as string) : null,
    });
    const fromEvidence = (e: AgentEvidence): Partial<ReviewIngestReport> => ({ agent_id: e.agent_id, session_id: e.session_id, tool_use_id: e.tool_use_id, result_sha256: e.result_sha256, transcript_sha256: e.transcript.sha256 });
    switch (t.status) {
      case 'unsafe':
        return this.ingestReport(base.review_id, dispatchId, 'REVIEW_SLOT_UNSAFE', `nothing was written: ${t.detail}`, { code: 'REVIEW_SLOT_UNSAFE' });
      case 'none':
        return this.ingestReport(base.review_id, dispatchId, 'REVIEWER_NOT_LAUNCHED', `no verdict was written and none can be taken: ${t.detail}. Nothing is spent: launch the reviewer with the ticket's prompt through the Agent tool, then run its await line.`, { next: 'launch', lifecycle: 'MISSING', reviewer: this.reviewerStatus(open, t.life) });
      case 'running':
        return this.ingestReport(base.review_id, dispatchId, 'REVIEWER_RUNNING', `${t.life.detail}: nothing was written or spent. Run the ticket's await line until it completes, then this line again; never settle, correct or relaunch it while it runs.`, { next: 'wait', lifecycle: 'RUNNING', reviewer: this.reviewerStatus(open, t.life) });
      case 'lost': {
        const r = this.interruptReviewer(open, t.life);
        const now = (this.requiredReview() as AcceptanceReviewState).open ?? open;
        return this.interruptedIngest(this.interruptedReviewReport((now.agent_interrupted ?? null) !== null ? now : { ...open, agent_interrupted: this.markOf(t.life) }, !r.interrupted, r.blocked));
      }
      case 'no-output':
        return this.ingestReport(base.review_id, dispatchId, t.life.code, `nothing was written: ${t.life.detail}. Settle refuses the generation (it completed with no verdict).`, { code: t.life.code, lifecycle: 'COMPLETED_NO_OUTPUT', reviewer: this.reviewerStatus(open, t.life) });
      case 'provider':
        return this.ingestReport(base.review_id, dispatchId, 'REVIEW_RESULT_MISSING', `nothing was written: ${t.life.detail}, not transient. Settle refuses the generation.`, { code: 'REVIEW_RESULT_MISSING', lifecycle: 'FAILED_PROVIDER', reviewer: this.reviewerStatus(open, t.life) });
      case 'rejected':
        return this.ingestReport(base.review_id, dispatchId, t.code, `nothing was written: ${t.detail}`, { code: t.code });
      case 'oversize':
        return this.ingestReport(base.review_id, dispatchId, 'WRITTEN', `the reviewer wrote its verdict file (${t.size} bytes, over ${MAX_VERDICT_BYTES}: settle refuses it for its form)`, { transport: 'file' });
      case 'unattested':
        return this.ingestReport(base.review_id, dispatchId, 'REVIEW_UNATTESTED', 'the verdict file holds a verdict no reviewer is attested to have written, and no launched reviewer answered it', { code: 'REVIEW_UNATTESTED', verdict_sha256: canonicalVerdictSha256(t.content) });
      case 'file':
        return this.ingestReport(base.review_id, dispatchId, 'WRITTEN', `the reviewer wrote its verdict file; ${t.detail}`, { transport: 'file', verdict_sha256: canonicalVerdictSha256(t.content), ...attested(t.attest) });
      case 'both':
        return this.ingestReport(base.review_id, dispatchId, 'WRITTEN', 'the reviewer wrote its verdict file, and its final answer is the same verdict', { transport: 'both', verdict_sha256: canonicalVerdictSha256(t.content), ...attested(t.attest), ...fromEvidence(t.evidence) });
      case 'conflict':
        return this.ingestReport(base.review_id, dispatchId, 'REVIEW_OUTPUT_CONFLICT', `${t.detail}; settle refuses it for its form`, { code: 'REVIEW_OUTPUT_CONFLICT', transport: 'both', verdict_sha256: canonicalVerdictSha256(t.content), ...attested(t.attest), ...fromEvidence(t.evidence) });
      case 'agent': {
        const ok = t.extraction.ok;
        const outcome: ReviewIngestReport['outcome'] = !ok ? 'REVIEW_RESULT_INVALID' : t.written || t.repaired ? 'INGESTED' : 'ALREADY_INGESTED';
        const detail = !ok
          ? `${(t.extraction as { detail: string }).detail} It is kept as the generation's output; settle refuses it for its form, and the next generation corrects it.`
          : t.written
            ? "the reviewer's final answer is the generation's verdict file now, attested with its transcript's and its own hashes"
            : t.repaired
              ? 'the verdict file an earlier ingest wrote is attested now'
              : "the reviewer's final answer was ingested already";
        return this.ingestReport(base.review_id, dispatchId, outcome, detail, {
          ...(ok ? {} : { code: 'REVIEW_RESULT_INVALID' }),
          transport: 'agent-result',
          written: t.written,
          idempotent: !t.written && !t.repaired,
          verdict_sha256: canonicalVerdictSha256(t.content),
          extraction: ok ? { ok: true, form: (t.extraction as { form: 'json' | 'fenced-json' }).form } : { ok: false, reason: (t.extraction as { reason: string }).reason, detail: (t.extraction as { detail: string }).detail },
          ...attested(t.attest),
        });
      }
    }
  }

  private ingestReport(reviewId: string, dispatchId: string, outcome: ReviewIngestReport['outcome'], detail: string, extra: Partial<ReviewIngestReport> = {}): ReviewIngestReport {
    return {
      review_id: reviewId,
      dispatch_id: dispatchId,
      outcome,
      code: null,
      detail,
      transport: null,
      written: false,
      idempotent: false,
      agent_id: null,
      session_id: null,
      tool_use_id: null,
      result_sha256: null,
      transcript_sha256: null,
      verdict_sha256: null,
      extraction: null,
      next: 'settle',
      ...extra,
    };
  }

  /** `review ingest` of a generation already settled: its record answers, nothing changes. */
  private settledIngest(record: ReviewRecord): ReviewIngestReport {
    const report = this.recordReport(record);
    const t = report.transport ?? null;
    return this.ingestReport(record.review_id, report.dispatch_id, 'SETTLED', `${record.review_id} was settled already: ${record.outcome}`, {
      idempotent: true,
      next: 'dispatch',
      transport: t?.kind ?? null,
      agent_id: t?.agent_id ?? null,
      session_id: t?.session_id ?? null,
      tool_use_id: t?.tool_use_id ?? null,
      result_sha256: t?.result_sha256 ?? null,
      transcript_sha256: t?.transcript_sha256 ?? null,
      verdict_sha256: report.verdict_sha256 ?? null,
    });
  }

  /**
   * A generation's output, whichever way it came (engine/review-transport.ts),
   * for settle and ingest alike. Its verdict file, attested: a final answer
   * ingested before; or the reviewer's Write — checked against the final
   * answer of the reviewer launched for it, when that is a verdict too (the
   * same: `both`; another: `conflict`). An unattested verdict file is
   * attested again only when it is exactly a launched reviewer's final
   * answer (an ingest that died between its two writes). No verdict file:
   * the launched reviewer's completed final answer, written to the verdict
   * file only (exclusively, never over a Write) and attested with what
   * proves it — kept as it was when it is not exactly one JSON object, for
   * settle to refuse for its form. Never anything outside the generation's
   * own directory, never through a link.
   */
  private reviewerTransport(open: OpenReview, options: { agentId?: string | undefined; hostText?: string | undefined }, by: string, again = false): Transported {
    const safe = safeGenerationDir(this.controlRoot, open);
    if (!safe.ok) return { status: 'unsafe', detail: safe.detail };
    const slot = join(safe.dir, VERDICT_FILE);
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(slot);
    } catch {
      st = null;
    }
    if (st !== null) {
      if (!st.isFile()) return { status: 'unsafe', detail: `${open.slot} is not a regular file` };
      if (st.size > MAX_VERDICT_BYTES) return { status: 'oversize', size: st.size };
      // Read through one descriptor: a verdict swapped for a link or another file since the look is no verdict.
      const read = readRegular(slot, MAX_VERDICT_BYTES);
      if (read === null) return { status: 'unsafe', detail: `${open.slot} changed while it was read` };
      const content = read.bytes.toString('utf8');
      const attest = ((): Attestation | null => {
        try {
          const parsed = JSON.parse(readFileSync(join(safe.dir, ATTESTATION_FILE), 'utf8')) as unknown;
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Attestation) : null;
        } catch {
          return null;
        }
      })();
      const attested = attest !== null && attest.schema === REVIEW_ATTESTATION_SCHEMA && REVIEWER_TYPES.has(String(attest.agent_type ?? '')) && typeof attest.agent_id === 'string' && attest.agent_id !== '' && attest.content_sha256 === canonicalVerdictSha256(content);
      if (attested && attest.transport === 'agent-result') {
        // Ingested before: a host naming another agent, or holding another answer, is told so.
        if (options.agentId !== undefined || options.hostText !== undefined) {
          const out = reviewerOutput(this.controlRoot, open, options);
          if (out.kind === 'rejected') return { status: 'rejected', code: out.code, detail: out.detail };
          if (out.kind === 'found' && out.evidence.agent_id !== attest.agent_id) return { status: 'rejected', code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `the verdict file holds agent ${String(attest.agent_id)}'s answer, not ${out.evidence.agent_id}'s` };
        }
        const ex = (attest['extraction'] ?? {}) as Record<string, unknown>;
        const extraction: TransportExtraction = ex['ok'] === false ? { ok: false, reason: String(ex['reason'] ?? 'not-json'), detail: String(ex['detail'] ?? ''), pointer: String(ex['pointer'] ?? '') } : { ok: true, form: ex['form'] === 'fenced-json' ? 'fenced-json' : 'json' };
        return { status: 'agent', content, attest, written: false, repaired: false, extraction };
      }
      const out = reviewerOutput(this.controlRoot, open, options);
      if (attested) {
        // The reviewer's Write: its final answer, when that is a verdict too, must be the same verdict.
        if (out.kind === 'found' && out.extraction.ok) {
          const written = parseStrictJson(content, { maxBytes: MAX_VERDICT_BYTES, maxDepth: MAX_RESULT_DEPTH });
          const pointer = written.ok ? firstDifference(written.value, out.extraction.value) : '/';
          if (pointer === null) return { status: 'both', content, attest, evidence: out.evidence };
          return { status: 'conflict', content, attest, evidence: out.evidence, pointer, detail: `the verdict agent ${String(attest.agent_id)} wrote to ${open.slot} and the final answer of agent ${out.evidence.agent_id} are different verdicts (first at ${pointer})` };
        }
        const why = out.kind === 'found' ? 'its final answer carries no verdict of its own' : out.kind === 'none' ? 'no launch of it from the host session is recorded' : out.detail;
        return { status: 'file', content, attest, detail: why };
      }
      // Unattested: exactly a launched reviewer's final answer is an ingest that died between its writes; anything else is not the reviewer's.
      if (out.kind === 'found' && canonicalVerdictSha256(content) === canonicalVerdictSha256(out.extraction.ok ? out.extraction.json : out.text.trim())) {
        const attestation = this.ingestAttestation(open, out, by);
        if (writeIngestAttestation(this.controlRoot, open, attestation)) {
          this.event('review.ingested', null, this.ingestedEvent(open, out, 'repaired', by));
          return { status: 'agent', content, attest: attestation, written: false, repaired: true, extraction: this.extractionOf(out.extraction) };
        }
      }
      return { status: 'unattested', content };
    }
    // No verdict file: the launched reviewer's final answer, once Claude Code has made its completion durable (CSET-203 r13).
    const life = this.lifecycleOf(open, options);
    switch (life.state) {
      case 'MISSING':
        return { status: 'none', detail: life.detail, life };
      case 'RUNNING':
        return { status: 'running', life };
      case 'LOST':
      case 'TIMED_OUT':
        return { status: 'lost', life };
      case 'COMPLETED_NO_OUTPUT':
        return { status: 'no-output', life };
      case 'FAILED_PROVIDER':
        return { status: 'provider', life };
      case 'REJECTED':
        return { status: 'rejected', code: life.code, detail: life.detail };
      default:
        break;
    }
    const out = life.output;
    const content = out.extraction.ok ? out.extraction.json : out.text.trim();
    const attestation = this.ingestAttestation(open, out, by);
    const w = writeIngestedVerdict({ controlRoot: this.controlRoot, open, content, attestation });
    if (!w.written) {
      if (w.reason === 'unsafe') return { status: 'unsafe', detail: w.detail };
      // A verdict file appeared meanwhile (a Write raced the ingest): judge what is there now.
      return again ? { status: 'unattested', content } : this.reviewerTransport(open, options, by, true);
    }
    this.event('review.ingested', null, this.ingestedEvent(open, out, out.extraction.ok ? 'INGESTED' : 'REVIEW_RESULT_INVALID', by));
    return { status: 'agent', content, attest: attestation, written: true, repaired: false, extraction: this.extractionOf(out.extraction) };
  }

  private extractionOf(e: ResultExtraction): TransportExtraction {
    return e.ok ? { ok: true, form: e.form } : { ok: false, reason: e.reason, detail: e.detail.slice(0, 600), pointer: e.pointer };
  }

  /** What an ingested verdict file is attested with: who answered, in which session and Agent call, the answer's and its transcript's hashes, the generation it binds. */
  private ingestAttestation(open: OpenReview, out: Extract<AgentOutput, { kind: 'found' }>, by: string): Attestation {
    const e = out.evidence;
    const content = out.extraction.ok ? out.extraction.json : out.text.trim();
    return {
      schema: REVIEW_ATTESTATION_SCHEMA,
      transport: 'agent-result',
      agent_id: e.agent_id,
      agent_type: e.agent_type,
      session_id: e.session_id,
      tool_use_id: e.tool_use_id,
      content_sha256: canonicalVerdictSha256(content),
      result_sha256: e.result_sha256,
      result_bytes: e.result_bytes,
      extraction: this.extractionOf(out.extraction),
      transcript: e.transcript,
      session_transcript: e.session_transcript,
      completion: e.completion,
      launch: e.launch,
      binding: { review_id: open.review_id, dispatch_id: open.dispatch_id, epoch: open.epoch ?? null, inputs_sha256: open.inputs_sha256, packet_sha256: open.packet_sha256 },
      ingested_by: by,
      at: new Date().toISOString(),
    };
  }

  private ingestedEvent(open: OpenReview, out: Extract<AgentOutput, { kind: 'found' }>, outcome: string, by: string): Record<string, unknown> {
    return {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      outcome,
      agent_id: out.evidence.agent_id,
      session_id: out.evidence.session_id,
      tool_use_id: out.evidence.tool_use_id,
      result_sha256: out.evidence.result_sha256,
      transcript_sha256: out.evidence.transcript.sha256,
      extraction: out.extraction.ok ? out.extraction.form : `invalid:${out.extraction.reason}`,
      by,
    };
  }

  /** How a settled verdict reached the controller, as its receipt and settle report say it. */
  private transportOf(t: Extract<Transported, { status: 'agent' | 'file' | 'both' }>): ReviewTransport {
    const a = t.attest;
    const fromAttest = { agent_id: String(a.agent_id ?? ''), session_id: typeof a.session_id === 'string' ? a.session_id : null, tool_use_id: typeof a.tool_use_id === 'string' ? a.tool_use_id : null };
    if (t.status === 'file') return { kind: 'file', ...fromAttest, result_sha256: null, transcript_sha256: null, transcript_path: null, extraction: null };
    if (t.status === 'both') return { kind: 'both', ...fromAttest, result_sha256: t.evidence.result_sha256, transcript_sha256: t.evidence.transcript.sha256, transcript_path: t.evidence.transcript.path, extraction: 'json' };
    const tr = (a['transcript'] ?? {}) as Record<string, unknown>;
    return {
      kind: 'agent-result',
      ...fromAttest,
      result_sha256: typeof a['result_sha256'] === 'string' ? (a['result_sha256'] as string) : null,
      transcript_sha256: typeof tr['sha256'] === 'string' ? (tr['sha256'] as string) : null,
      transcript_path: typeof tr['path'] === 'string' ? (tr['path'] as string) : null,
      extraction: t.extraction.ok ? t.extraction.form : null,
    };
  }

  /**
   * `review settle --capability <c>`: the host settles the review it handed
   * out with that generation's capability. A generation settled already is
   * answered from its record; a revoked one is refused.
   */
  settleReview(reviewId: string, capability: string | undefined): ReviewSettleReport {
    const review = this.requiredReview();
    if (review === null) throw new Error(`REVIEW_NOT_REQUIRED: ${this.featureId} has no acceptance review to settle.`);
    if (capability === undefined) throw new CapabilityError('CAPABILITY_REQUIRED', `${reviewId}: pass the review ticket's --capability.`);
    const settled = review.reviews.find((r) => r.review_id === reviewId && (capabilityMatches(capability, r.capability_sha256) || (r.refinements ?? []).some((x) => capabilityMatches(capability, x.capability_sha256))));
    if (settled !== undefined) return { ...this.recordReport(settled), idempotent: true };
    const open = review.open;
    // A generation that stopped counting (dropped when what it reviews moved, or found stale at its settle): answered stale.
    const lease = leaseOf(this.state(), (h) => capabilityMatches(capability, h));
    if (lease !== null && lease.kind === 'review' && lease.review_id === reviewId && lease.status !== 'active' && lease.status !== 'settled' && (open === null || open.dispatch_id !== lease.dispatch_id)) {
      return this.staleReviewAnswer(reviewId, lease);
    }
    if (open === null || open.review_id !== reviewId) throw new CapabilityError('NOT_CLAIMED', `${reviewId} is not an open acceptance review of ${this.featureId}.`);
    if (!capabilityMatches(capability, open.capability_sha256)) {
      throw new CapabilityError('CAPABILITY_INVALID', `the capability presented is not the one of ${reviewId}'s current generation (stale, rotated, or of another review).`);
    }
    // Its reviewer (or host) ended by a model provider before it answered: revoked, nothing spent (CSET-203 r10); the same answer again.
    if ((open.provider_interrupted ?? null) !== null) return this.providerReviewReport(open, open.provider_interrupted as ProviderMark, true);
    // Its reviewer interrupted (CSET-203 r13): revoked, nothing spent; the same answer again.
    if ((open.agent_interrupted ?? null) !== null) return this.interruptedReviewReport(open, true);
    const interrupted = this.providerReview(open);
    if (interrupted !== null) return this.providerReviewReport(open, interrupted.failure, false);
    return this.settleOpenReview('host', open.dispatch_id);
  }

  private settleOpenReview(by: 'host' | 'dispatch' | 'resume', dispatchId: string): ReviewSettleReport {
    const lockDir = join(this.paths.featureDir, 'reviews');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'settle.lock'), () => this.settleOpenReviewLocked(by, dispatchId), { timeoutMs: 15_000, pollMs: 50, purpose: 'acceptance review settle' });
  }

  /**
   * Take a reviewer's verdict, whichever way it came (reviewerTransport: its
   * Write, or its final answer, ingested here when the host did not):
   * missing, oversized, unattested (not what the reviewer subagent wrote
   * through the fence, nor its own final answer), a final answer that is not
   * exactly one JSON object, a written verdict its final answer contradicts,
   * not JSON, or refused by judgeVerdict, it is a refused generation; else
   * its receipt is written and recorded, and a GAPS verdict reworks its
   * producers (or blocks the feature after the last round).
   */
  private settleOpenReviewLocked(by: 'host' | 'dispatch' | 'resume', dispatchId: string): ReviewSettleReport {
    const review = this.requiredReview();
    if (review === null) throw new Error(`REVIEW_NOT_REQUIRED: ${this.featureId} has no acceptance review to settle.`);
    const settled = review.reviews.find((r) => r.dispatch_id === dispatchId || (r.refinements ?? []).some((x) => x.dispatch_id === dispatchId));
    if (settled !== undefined) return { ...this.recordReport(settled), idempotent: true };
    const open = review.open;
    const earlier = open?.refused.find((r) => r.dispatch_id === dispatchId);
    if (open !== null && earlier !== undefined) {
      return { ...this.refusalReport(open.review_id, dispatchId, earlier.code, earlier.detail, false, true), problems: earlier.problems ?? [], corrections: { used: refusalCounts(open.refused).format, max: MAX_FORMAT_CORRECTIONS } };
    }
    if (open === null || open.dispatch_id !== dispatchId) {
      const blocked = review.blocked;
      if (blocked !== null) return this.refusalReport(blocked.review_id, dispatchId, blocked.code, blocked.detail, true, true);
      throw new Error(`REVIEW_NOT_OPEN: dispatch ${dispatchId} is not the open generation of an acceptance review of ${this.featureId}.`);
    }
    // What it reviewed is not what the feature is now (the epoch moved, work is in flight, a node it judges reopened): never recorded.
    const staleWhy = this.reviewStaleReason(open, this.state());
    if (staleWhy !== null) return this.staleOpenReview(open, staleWhy);
    if ((open.agent_interrupted ?? null) !== null) return this.interruptedReviewReport(open, true);
    const t = this.reviewerTransport(open, {}, by);
    switch (t.status) {
      case 'unsafe':
        return this.refuseVerdict(open, 'REVIEW_VERDICT_MISSING', `${open.slot} is not a regular file of its generation's directory: ${t.detail}`);
      // CSET-203 r13: a reviewer still running, or none launched, is no missing verdict: nothing is settled or spent.
      case 'running':
        return this.unsettledReviewReport(open, t.life);
      case 'none':
        return this.unsettledReviewReport(open, t.life);
      // A reviewer that did not complete (past its wall-clock, its host or task ended): interrupted, re-issued, nothing spent.
      case 'lost': {
        const r = this.interruptReviewer(open, t.life);
        const now = (this.requiredReview() as AcceptanceReviewState).open ?? { ...open, agent_interrupted: this.markOf(t.life) };
        return this.interruptedReviewReport((now.agent_interrupted ?? null) !== null ? now : { ...open, agent_interrupted: this.markOf(t.life) }, !r.interrupted, r.blocked);
      }
      // It completed and left no verdict: the only REVIEW_VERDICT_MISSING (a reviewer attempt, never a correction).
      case 'no-output':
      case 'provider':
        return { ...this.refuseVerdict(open, 'REVIEW_VERDICT_MISSING', `the reviewer wrote no verdict to ${open.slot} and completed with no final answer: ${t.life.detail}`), lifecycle: t.life.state, reviewer: this.reviewerStatus(open, t.life) };
      case 'rejected':
        return this.refuseVerdict(open, 'REVIEW_VERDICT_MISSING', `the reviewer wrote no verdict to ${open.slot}, and no final answer of a reviewer launched for it was taken: ${t.detail}`);
      case 'oversize':
        return this.refuseVerdict(open, 'REVIEW_VERDICT_INVALID', `the verdict file is ${t.size} bytes, over ${MAX_VERDICT_BYTES}`, { kind: 'format', problems: [{ code: 'REVIEW_VERDICT_INVALID', pointer: '', detail: `the verdict is ${t.size} bytes, over ${MAX_VERDICT_BYTES}`, limit: MAX_VERDICT_BYTES }] });
      case 'unattested':
        return this.refuseVerdict(open, 'REVIEW_UNATTESTED', 'the verdict in the slot is not what the reviewer subagent wrote through the plugin fence (no attestation of its Write, or one of other content), nor the final answer of a reviewer launched for it');
      case 'conflict':
        return this.refuseVerdict(open, 'REVIEW_OUTPUT_CONFLICT', `${t.detail}: write one verdict, or answer it, the same both ways`, { kind: 'format', problems: [{ code: 'REVIEW_OUTPUT_CONFLICT', pointer: t.pointer, detail: `${t.detail}; the verdict file is the one to mend` }], content: t.content, transport: 'both' });
      default:
        break;
    }
    if (t.status === 'agent' && !t.extraction.ok) {
      return this.refuseVerdict(open, 'REVIEW_RESULT_INVALID', t.extraction.detail, { kind: 'format', problems: [{ code: 'REVIEW_RESULT_INVALID', pointer: t.extraction.pointer, detail: t.extraction.detail }], content: t.content, transport: 'agent-result' });
    }
    const { content, attest } = t;
    const transport = this.transportOf(t);
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      const why = `the verdict is not JSON: ${errorText(err).slice(0, 200)}`;
      return this.refuseVerdict(open, 'REVIEW_VERDICT_INVALID', why, { kind: 'format', problems: [{ code: 'REVIEW_VERDICT_INVALID', pointer: '', detail: why }], content, transport: transport.kind });
    }
    const reviewer = { agent_id: String(attest.agent_id), session_id: typeof attest.session_id === 'string' ? attest.session_id : null, verdict_sha256: canonicalVerdictSha256(content), transport };
    const packet = loadPacket(join(this.controlRoot, ...open.packet_path.split('/')), open.packet_sha256);
    if (packet === null) return this.refuseVerdict(open, 'REVIEW_PACKET_CHANGED', 'the review packet is not the one the controller wrote for this generation');
    if ((open.refinement ?? null) !== null) {
      const refined = judgeRefinement(raw, refinementContext(packet, this.workspace, this.reviewPackets(open.review_id)));
      if (!refined.ok) return this.refuseVerdict(open, refined.code, refined.detail, { kind: FORMAT_REFUSALS.has(refined.code) ? 'format' : 'review', problems: refined.problems, content, transport: transport.kind });
      return this.recordRefinement(open, refined, reviewer, by);
    }
    const judged = judgeVerdict(raw, verdictContext(packet, this.workspace));
    if (!judged.ok) return this.refuseVerdict(open, judged.code, judged.detail, { kind: FORMAT_REFUSALS.has(judged.code) ? 'format' : 'review', problems: judged.problems, content, transport: transport.kind });
    return this.recordVerdict(open, judged, reviewer, by);
  }

  /**
   * A refused verdict: its generation is spent (a reviewer session counted
   * once, a re-settle answered from the record). A verdict refused for its
   * form (`format`) is corrected by the next generation, MAX_FORMAT_CORRECTIONS
   * times at most; a generation that left none to correct (`review`: none
   * written, one not attested, a changed packet) spends one of
   * MAX_REVIEW_ATTEMPTS. Either spent, the feature is blocked REVIEW_INVALID.
   * Neither is a review-rework round.
   */
  private refuseVerdict(open: OpenReview, code: string, detail: string, extra: { kind?: 'format' | 'review'; problems?: VerdictProblem[]; content?: string; transport?: ReviewTransport['kind'] } = {}): ReviewSettleReport {
    const at = new Date().toISOString();
    const usage = { ...zeroUsage(), sessions: 1, wall_clock_ms: Math.max(0, Date.now() - Date.parse(open.issued_at)) };
    const kind = extra.kind ?? 'review';
    const problems = (extra.problems ?? []).slice(0, MAX_REFUSAL_PROBLEMS).map(boundedProblem);
    let blocked = false;
    let counts = { format: 0, review: 0 };
    mutateState(this.paths.featureDir, (s) => {
      const r = s.acceptance_review;
      if (!r || r.open === null || r.open.dispatch_id !== open.dispatch_id) return s;
      r.open.refused.push({ dispatch_id: open.dispatch_id, code, detail: detail.slice(0, 2000), at, kind, ...(kind === 'format' ? { verdict: open.slot, problems } : {}) });
      r.usage = addUsage(r.usage, usage);
      s.usage = addUsage(s.usage, usage);
      counts = refusalCounts(r.open.refused);
      if (counts.format > MAX_FORMAT_CORRECTIONS || counts.review >= MAX_REVIEW_ATTEMPTS) {
        blocked = true;
        const why =
          counts.format > MAX_FORMAT_CORRECTIONS
            ? `the verdict of ${open.review_id} was still refused for its form after ${MAX_FORMAT_CORRECTIONS} format corrections (${r.open.refused.map((x) => x.code).join(', ')}); the last: ${detail.slice(0, 500)}`
            : `${counts.review} reviewer generation(s) of ${open.review_id} left no verdict to correct (${r.open.refused.map((x) => x.code).join(', ')}); the last: ${detail.slice(0, 500)}`;
        r.blocked = { code: 'REVIEW_INVALID', review_id: open.review_id, detail: why, at };
        r.open = null;
        s.feature_state = 'BLOCKED';
        s.blocked_reason = `REVIEW_INVALID: ${why}`;
      }
      return s;
    });
    this.event('review.refused', null, {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      code,
      kind,
      detail: detail.slice(0, 500),
      problems: problems.slice(0, 12).map((p) => ({ code: p.code, pointer: p.pointer })),
      verdict_sha256: extra.content !== undefined ? canonicalVerdictSha256(extra.content) : null,
      transport: extra.transport ?? null,
      corrections_used: counts.format,
      reviewer_attempts_used: counts.review,
      blocked,
    });
    if (blocked) removeReviewCheckouts(this.controlRoot, this.featureId, open.review_id, this.workspace);
    return { ...this.refusalReport(open.review_id, open.dispatch_id, code, detail, blocked, false), problems, corrections: { used: counts.format, max: MAX_FORMAT_CORRECTIONS } };
  }

  private refusalReport(reviewId: string, dispatchId: string, code: string, detail: string, blocked: boolean, idempotent: boolean): ReviewSettleReport {
    return { review_id: reviewId, dispatch_id: dispatchId, outcome: 'REVIEW_INVALID', detail, code, receipt_path: null, receipt_sha256: null, reworked: [], gaps: [], blocked, idempotent, next: blocked ? 'stop' : 'dispatch' };
  }

  /** A settled review's report, from its record (and its receipt's gaps and block). */
  private recordReport(record: ReviewRecord): ReviewSettleReport {
    let receipt: { gaps?: Gap[]; blocked?: string | null; verdict_sha256?: string; canonical_verdict_sha256?: string; normalization?: VerdictNormalization; transport?: ReviewTransport; coverage?: CoverageManifest } = {};
    try {
      receipt = JSON.parse(readFileSync(join(this.controlRoot, ...record.receipt_path.split('/')), 'utf8')) as typeof receipt;
    } catch {
      receipt = {};
    }
    const last = (record.refinements ?? [])[(record.refinements ?? []).length - 1];
    return {
      review_id: record.review_id,
      dispatch_id: last?.dispatch_id ?? record.dispatch_id,
      outcome: record.outcome,
      detail:
        record.outcome === 'PASS'
          ? `${record.review_id} passed every criterion${last !== undefined ? ' once its refinement withdrew every challenged gap' : ''}`
          : record.outcome === 'GAPS'
            ? `${record.review_id} found gaps; reworked ${record.reworks.join(', ')}${last !== undefined ? ` (refined: ${last.decisions.map((d) => `${d.criterion} ${d.decision}`).join(', ')})` : ''}`
            : record.outcome === 'CHALLENGED'
              ? `${record.review_id} is challenged: a worker's focused test of one of its gaps' exact reproduction passes on the unchanged head; a fresh reviewer refines it next`
              : record.outcome === 'WITHDRAWN'
                ? `${record.review_id}'s refinement withdrew every gap, but the heads it reviewed moved since: a new review follows`
                : record.outcome === 'REPEATED'
                  ? `${record.review_id} found only repeats of earlier reproductions (${(receipt.gaps ?? []).map((g) => g.criterion).join(', ')}): nothing reworked, no budget spent; a new review follows`
                  : record.outcome === 'REGRESSION'
                  ? `${record.review_id} found completed proofs lost at its heads (${(receipt.coverage ? lostCompletions(receipt.coverage) : []).map((l) => `${l.node_id} ${l.criterion}`).join(', ')}): restored by ${record.reworks.join(', ')}, nothing spent; a new review follows`
                  : typeof receipt.blocked === 'string' && receipt.blocked !== ''
                  ? receipt.blocked
                  : `${record.review_id} found gaps after the last review-rework round`,
      code: null,
      receipt_path: record.receipt_path,
      receipt_sha256: record.receipt_sha256,
      reworked: record.reworks_applied ? [...record.reworks] : [],
      gaps: (receipt.gaps ?? []).map((g) => ({ criterion: g.criterion, reproduction: g.reproduction })),
      blocked: record.outcome === 'REVIEW_GAPS' || record.outcome === 'REVIEW_NONCONVERGENT',
      idempotent: false,
      next: record.outcome === 'REVIEW_GAPS' || record.outcome === 'REVIEW_NONCONVERGENT' ? 'stop' : 'dispatch',
      verdict_sha256: receipt.verdict_sha256 ?? null,
      canonical_verdict_sha256: receipt.canonical_verdict_sha256 ?? null,
      normalized: receipt.normalization?.changed ?? [],
      transport: receipt.transport ?? null,
      coverage: receipt.coverage === undefined ? null : { holds: receipt.coverage.holds, sha256: receipt.coverage.sha256, lost: lostCompletions(receipt.coverage).map((l) => ({ node_id: l.node_id, criterion: l.criterion, record_id: l.record_id, code: l.code })) },
      ...(last !== undefined ? { refinement: { round: last.round, decisions: last.decisions.map((d) => ({ ...d })) } } : {}),
    };
  }

  /** Every packet a review was judged with: its own, then each refinement's (what its criteria cite). */
  private reviewPackets(reviewId: string): ReviewPacket[] {
    const record = [...(this.requiredReview()?.reviews ?? [])].reverse().find((r) => r.review_id === reviewId);
    if (record === undefined) return [];
    const receipts = [record.original?.receipt_path ?? record.receipt_path, ...(record.refinements ?? []).map((x) => x.receipt_path)];
    const packets: ReviewPacket[] = [];
    for (const rel of [...new Set(receipts)]) {
      try {
        const r = JSON.parse(readFileSync(join(this.controlRoot, ...rel.split('/')), 'utf8')) as { packet_path?: string; packet_sha256?: string };
        if (typeof r.packet_path !== 'string' || typeof r.packet_sha256 !== 'string') continue;
        const p = loadPacket(join(this.controlRoot, ...r.packet_path.split('/')), r.packet_sha256);
        if (p !== null) packets.push(p);
      } catch {
        continue;
      }
    }
    return packets;
  }

  private recordRefinement(open: OpenReview, judged: Extract<RefinementJudgement, { ok: true }>, reviewer: SettledReviewer, by: string): ReviewSettleReport {
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'deliver.lock'), () => this.recordRefinementLocked(open, judged, reviewer, by), { timeoutMs: 15_000, pollMs: 50, purpose: 'acceptance review refinement' });
  }

  /**
   * A valid refinement, settled: a new revision of the review it refines
   * (engine/review-revision.ts) — its receipt, linked to the revision before
   * it, with what it did to each gap of that revision and to each producer
   * order of the review — then one STATE.json write that records it and
   * reconciles every order with it: each order whose gaps it carries
   * unchanged rebased to it (CSET-203 r14: the cli's AC-3 order stayed bound
   * to R002's original receipt after AC-1's refinement), each order whose
   * gaps it changed replaced, each order whose every gap it withdrew
   * cancelled (its generation restored), the challenger ordered again for
   * what it keeps of its gaps, a refined gap's producers ordered — from the
   * attempt base each one's generation began at, no product attempt charged,
   * in the review's own round. With every gap withdrawn and the heads
   * unchanged since the review, the review is a PASS (its unchanged criteria
   * and the challenge's evidence meet the PASS rules); with the heads moved,
   * WITHDRAWN: a new review follows. Each challenge records its decision.
   */
  private recordRefinementLocked(open: OpenReview, judged: Extract<RefinementJudgement, { ok: true }>, reviewer: SettledReviewer, by: string): ReviewSettleReport {
    const state = this.state();
    const review = this.requiredReview(state) as AcceptanceReviewState;
    const graph = this.graph();
    const ref = open.refinement as OpenRefinement;
    const record = [...review.reviews].reverse().find((r) => r.review_id === open.review_id) as ReviewRecord;
    // Each refined gap against its criterion's own lineage (CSET-203 r11): the challenged rework was restored and spent
    // nothing; a refined gap spends its criterion's budget only once a producer is reworked for it.
    const lineage = this.lineageOf(state);
    const summary = this.lineageSummary(state, lineage);
    const facts: GapFacts = { progress: this.progressFacts(state, summary, judged.refined.map((g) => g.criterion), open.inputs.repositories) };
    const refinedLineage = judgeGapLineage(summary, judged.refined, facts);
    const verdictOf = (criterion: string): GapLineageJudgement['verdict'] | undefined => refinedLineage.find((j) => j.criterion === criterion)?.verdict;
    const allowable = judged.refined.filter((g) => verdictOf(g.criterion) === 'accepted');
    const exhausted = judged.refined.filter((g) => verdictOf(g.criterion) === 'exhausted').map((g) => g.criterion);
    // The revision this refinement makes, linked to the one it refines (CSET-203 r14).
    const parent = currentRevision(record);
    const n = parent.revision + 1;
    const receiptPath = `features/${this.featureId}/reviews/${open.review_id}.refined-${n}.json`;
    const parentGaps = (this.readReceiptLike(parent.receipt_path)?.['gaps'] ?? []) as Gap[];
    // A retained gap orders its producers only as it did when it was found: accepted — never a repeat or one past its budget.
    const orderedBefore = (g: Gap): boolean => {
      const rep = summary.criteria[g.criterion]?.reproductions.find((r) => r.sha256 === reproductionSha256(g.reproduction));
      return rep === undefined || rep.status === 'accepted';
    };
    const roundOf = (challengeId: string, criterion: string): number => (review.challenges ?? []).find((c) => c.challenge_id === challengeId)?.gaps.find((g) => g.criterion === criterion)?.round ?? ref.round;
    const challengedNow = new Set(ref.challenges.map((c) => c.challenge_id));
    const plan = planRevision({ graph, parentGaps, decisions: judged.decisions, refined: judged.refined, accepted: new Set(allowable.map((g) => g.criterion)), retainedOrderable: orderedBefore, nodes: orderViews(graph, state, open.review_id, challengedNow, parentGaps) });
    const at = new Date().toISOString();
    const why = (o: OrderAction): string =>
      o.action === 'cancel'
        ? `revision ${n} of ${open.review_id} withdrew every gap of this order (${o.criteria_before.join(', ')})`
        : `revision ${n} of ${open.review_id} changed this order's gaps (${o.criteria_before.join(', ')} -> ${o.criteria_after.join(', ')})`;
    // An order the revision replaces or cancels is put back on the generation it replaced first; its replacement is
    // planned from there, as a challenged rework's is (engine/review-revision.ts).
    const virtual = structuredClone(state);
    const unsuperseded: { node_id: string; criteria: string[]; detail: string }[] = [];
    for (const o of plan.orders.filter((x) => x.action === 'amend' || x.action === 'cancel')) {
      try {
        this.supersedeOrderIn(virtual, o.node_id, { review_id: open.review_id, revision: n, action: o.action as 'amend' | 'cancel', at, reason: why(o).slice(0, 500) }, graph, o.action === 'cancel');
      } catch (err) {
        if (!(err instanceof ReworkRefusedError)) throw err;
        unsuperseded.push({ node_id: o.node_id, criteria: [...o.criteria_after], detail: err.message.slice(0, 600) });
      }
    }
    const blocked = new Set(unsuperseded.map((u) => u.node_id));
    const superseded = plan.orders.filter((o) => (o.action === 'amend' || o.action === 'cancel') && !blocked.has(o.node_id));
    const ordering = plan.orders.filter((o) => (o.action === 'amend' || o.action === 'reorder' || o.action === 'order') && !blocked.has(o.node_id));
    const retained = new Set(plan.dispositions.filter((d) => d.disposition === 'retained').map((d) => d.criterion));
    const orderedGaps = [...parentGaps.filter((g) => retained.has(g.criterion) && orderedBefore(g)), ...allowable.map(({ challenge_id: _c, ...g }) => g as Gap)];
    // A retained gap's budget was spent when it was found: its order again names the same rework of its criterion.
    const budgets = Object.fromEntries(
      orderedGaps.map((g): [string, ReasonBudget] => {
        const c = summary.criteria[g.criterion];
        const accepted = c?.accepted_reworks ?? 0;
        const basis = retained.has(g.criterion) ? undefined : refinedLineage.find((j) => j.criterion === g.criterion)?.basis;
        return [g.criterion, { used: retained.has(g.criterion) ? Math.max(0, accepted - 1) : accepted, max: c?.max ?? summary.max_criterion_reworks, ceiling: c?.ceiling ?? summary.criterion_ceiling, ...(basis === 'progress' || basis === 'budget' ? { basis } : {}) }];
      }),
    );
    const refinement = Object.fromEntries(allowable.map((g) => [g.criterion, { challenge_id: g.challenge_id, round: roundOf(g.challenge_id, g.criterion) }]));
    const planned = ordering.length === 0 ? { plans: [], made: [], refused: [] } : this.planGapReworks({ reviewId: record.review_id, review: record.review, receiptPath, budgets, targets: ordering.map((o) => ({ node_id: o.node_id, criteria: o.criteria_after })), gaps: orderedGaps, state: virtual, graph, refinement });
    // An order that could not be put out of force (its generation's evidence no longer intact) is refused with it: the review blocks.
    const prepared = { ...planned, refused: [...unsuperseded, ...planned.refused] };
    const unowned = gapTargets(graph, allowable).unowned;
    let outcome: ReviewRecord['outcome'] = 'GAPS';
    let overall: 'PASS' | 'GAPS' = 'GAPS';
    let blockDetail: string | null = null;
    if (judged.gaps.length === 0) {
      // Every gap withdrawn: a PASS only on the heads, graph and criteria the review's unchanged verdicts were judged on,
      // with no dispatch lease outstanding and every node it judges DONE (CSET-203 r7); otherwise a new review follows.
      const same = open.inputs_sha256 === ref.of_inputs_sha256;
      const barrier = this.reviewBarrier(state, new Set(), graph);
      const holds = barrier.leases.length === 0 && barrier.notDone.length === 0;
      outcome = same && holds ? 'PASS' : 'WITHDRAWN';
      overall = same && holds ? 'PASS' : 'GAPS';
    } else if (unowned.length > 0 || prepared.refused.length > 0) {
      outcome = 'REVIEW_GAPS';
      blockDetail = this.unreworkableDetail(record.review_id, { gaps: judged.refined, unowned, refused: prepared.refused, reworked: prepared.plans.map((p) => ({ node_id: p.nodeId, criteria: p.acceptance })), graph });
    }
    // The review's reworks now: every order it keeps (rebased, replaced, ordered again, kept as completed).
    const refused = new Set(prepared.refused.map((r) => r.node_id));
    const kept = plan.orders.filter((o) => o.action !== 'cancel' && !refused.has(o.node_id));
    const reworks = [...new Set(kept.map((o) => o.node_id))];
    // Gaps left, but nothing to rework: an exhausted criterion blocks now; repeats alone leave the next review to come.
    if (outcome === 'GAPS' && judged.gaps.length > 0 && reworks.length === 0) outcome = exhausted.length > 0 ? 'REVIEW_GAPS' : 'REPEATED';
    if (outcome === 'REVIEW_GAPS' && blockDetail === null) {
      blockDetail = this.exhaustedDetail(summary, refinedLineage.filter((j) => j.verdict === 'exhausted').map((j) => ({ criterion: j.criterion, review_id: record.review_id, reproduction_sha256: j.reproduction_sha256 })));
    }
    const orderedFor = (criterion: string): string[] => ordering.filter((o) => !refused.has(o.node_id) && o.criteria_after.includes(criterion)).map((o) => o.node_id);
    const bodies: LineageEventBody[] = [
      ...judged.decisions.map((d): LineageEventBody => ({ kind: 'decision', review_id: record.review_id, challenge_id: d.challenge_id, criterion: d.criterion, decision: d.decision })),
      ...refinedLineage.map((j) => {
        const nodes = j.verdict === 'accepted' ? orderedFor(j.criterion) : [];
        const challenge = judged.refined.find((g) => g.criterion === j.criterion)?.challenge_id ?? null;
        return gapEvent(record.review_id, j, j.verdict === 'accepted' && nodes.length === 0 ? 'unreworkable' : j.verdict, nodes, challenge);
      }),
      ...(outcome === 'PASS' ? judged.criteria.filter((c) => c.verdict === 'PASS').map((c): LineageEventBody => ({ kind: 'closure', review_id: record.review_id, criterion: c.criterion, inputs_sha256: open.inputs_sha256 })) : []),
      ...(outcome === 'REVIEW_GAPS' ? [{ kind: 'blocked', review_id: record.review_id, code: 'REVIEW_GAPS', criteria: exhausted } as LineageEventBody] : []),
    ];
    const chained = appendLineage(lineage, bodies, at);
    const after = this.lineageSummary(state, chained.lineage);
    let previous: { reworks?: { node_id: string; criteria: string[]; by: string }[] } = {};
    try {
      previous = JSON.parse(readFileSync(join(this.controlRoot, ...record.receipt_path.split('/')), 'utf8')) as typeof previous;
    } catch {
      previous = {};
    }
    // The epoch this settle moves the feature to (each rework, then the refinement), and a PASS's barrier.
    const settledEpoch = currentEpoch(state) + prepared.plans.length + 1;
    const barrier: ReviewBarrier | null = outcome === 'PASS' ? { epoch: settledEpoch, at, leases: [], nodes_done: true } : null;
    const merged = { schema: REVIEW_VERDICT_SCHEMA, feature_id: this.featureId, review_id: open.review_id, dispatch_id: open.dispatch_id, inputs_sha256: open.inputs_sha256, reviewer: { agent: REVIEWER_AGENT, model: judged.refinement.reviewer.model }, criteria: judged.criteria, overall };
    const canonical = verdictCanonicalSha256(merged);
    const byOf = new Map([...gapTargets(graph, orderedGaps).targets.map((t) => [t.node_id, t.by] as const), ...(previous.reworks ?? []).map((t) => [t.node_id, t.by] as const)]);
    const receipt = {
      schema: REVIEW_RECEIPT_SCHEMA,
      feature_id: this.featureId,
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      review: record.review,
      // The revision this receipt is, and the one it refines (engine/review-revision.ts).
      revision: n,
      parent: { revision: parent.revision, receipt_path: parent.receipt_path, receipt_sha256: parent.receipt_sha256 },
      rework_rounds: { used: roundsUsed(review.reviews.filter((r) => r.review_id !== record.review_id), this.lastAcceptedAt(state)), max: review.max_rounds },
      inputs: open.inputs,
      inputs_sha256: open.inputs_sha256,
      packet_path: open.packet_path,
      packet_sha256: open.packet_sha256,
      // The refinement as the reviewer wrote it (attested), and the canonical verdict of the review as refined (criteria below).
      verdict_sha256: reviewer.verdict_sha256,
      canonical_verdict_sha256: canonical,
      normalization: { ...judged.normalization, original_sha256: reviewer.verdict_sha256, canonical_sha256: canonical, refinement_sha256: judged.normalization.canonical_sha256 },
      reviewer: { agent: REVIEWER_AGENT, model: judged.refinement.reviewer.model, agent_id: reviewer.agent_id, session_id: reviewer.session_id },
      transport: reviewer.transport,
      overall,
      outcome,
      criteria: judged.criteria,
      gaps: judged.gaps,
      // What the revision did to each gap of the one it refines, and to each producer order of the review.
      gap_dispositions: plan.dispositions,
      orders: plan.orders.map((o) => ({ node_id: o.node_id, action: o.action, criteria_before: o.criteria_before, criteria_after: o.criteria_after, ...(o.action === 'rebase' ? { carry: o.carry } : {}), ...(refused.has(o.node_id) ? { refused: true } : {}) })),
      reworks: kept.map((o) => ({ node_id: o.node_id, criteria: o.criteria_after, by: byOf.get(o.node_id) ?? 'criterion', action: o.action })),
      unowned: [],
      refused: prepared.refused,
      blocked: blockDetail,
      lineage: {
        prev_sha256: lineage.head_sha256,
        head_sha256: chained.lineage.head_sha256,
        events: chained.appended.map((e) => ({ seq: e.seq, kind: e.kind, sha256: e.sha256 })),
        gaps: refinedLineage.map((j) => lineageGapView(j, null, facts)),
        budgets: lineageBudgets(after),
      },
      refinement: {
        of: { review_id: open.review_id, receipt_path: ref.of_receipt_path, receipt_sha256: ref.of_receipt_sha256, inputs_sha256: ref.of_inputs_sha256 },
        round: ref.round,
        challenges: ref.challenges.map((c) => ({ challenge_id: c.challenge_id, challenge_sha256: c.challenge_sha256, criteria: c.criteria, node_id: c.node_id })),
        decisions: judged.decisions.map((d) => ({ challenge_id: d.challenge_id, criterion: d.criterion, decision: d.decision, reason: d.reason, ...(d.gap !== null ? { gap: d.gap } : {}), ...(d.rebuttal.length > 0 ? { rebuttal: d.rebuttal } : {}) })),
      },
      orchestration: { issued_epoch: open.epoch ?? null, settled_epoch: settledEpoch, barrier },
      settled_at: at,
      settled_by: by,
    };
    const file = join(this.controlRoot, ...receiptPath.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeTextAtomic(file, JSON.stringify(receipt, null, 2) + '\n');
    const receiptSha = fileSha256(file);
    this.fault('review-receipt-written');
    const revision: ReviewRevisionRef = { revision: n, receipt_path: receiptPath, receipt_sha256: receiptSha };
    // Every order the revision makes is bound to it; every one it carries unchanged is rebased to it, with its record.
    for (const p of prepared.plans) this.bindPlan(p, revision);
    const rebases = new Map<string, ReworkRebase>();
    for (const o of plan.orders.filter((x) => x.action === 'rebase')) {
      const brief = state.nodes[o.node_id]?.rework_brief ?? null;
      const from = brief === null ? null : boundRevision(record, brief);
      if (from === null) continue;
      const claim = state.nodes[o.node_id]?.claim ?? null;
      const live = claim !== null && claim.mode === 'host' ? { claim_id: claim.claim_id, from_dispatch_id: claim.dispatch_id ?? null, to_dispatch_id: randomUUID() } : null;
      rebases.set(o.node_id, rebaseRecord({ review_id: open.review_id, from, to: revision, criteria: [...o.criteria_after], carry: o.carry, by: 'refinement', claim: live, at }));
    }
    const usage = { ...zeroUsage(), sessions: 1, wall_clock_ms: Math.max(0, Date.now() - Date.parse(open.issued_at)) };
    const decisions = judged.decisions.map((d) => ({ challenge_id: d.challenge_id, criterion: d.criterion, decision: d.decision }));
    const restoredBy: string[] = [];
    mutateState(this.paths.featureDir, (s) => {
      if (s.acceptance_review?.open?.dispatch_id !== open.dispatch_id) throw new Error(`REVIEW_CHANGED: acceptance review ${open.review_id} changed while its refinement was settled; dispatch again.`);
      if ((s.acceptance_review.lineage?.head_sha256 ?? null) !== (state.acceptance_review?.lineage?.head_sha256 ?? null)) throw new Error(`REVIEW_CHANGED: the review lineage moved while ${open.review_id}'s refinement was settled; dispatch again.`);
      if (outcome === 'PASS') {
        const now = this.reviewBarrier(s, new Set(), graph);
        if (now.leases.length > 0 || now.notDone.length > 0) throw new Error(`REVIEW_CHANGED: work started while ${open.review_id}'s refinement was settled (${[...now.leases, ...now.notDone].join(', ')}); dispatch again.`);
      }
      let next = s;
      // The revision, and every order of the review reconciled with it, in this one write (CSET-203 r14).
      for (const o of superseded) restoredBy.push(o.node_id, ...this.supersedeOrderIn(next, o.node_id, { review_id: open.review_id, revision: n, action: o.action as 'amend' | 'cancel', at, reason: why(o).slice(0, 500) }, graph, o.action === 'cancel'));
      for (const [id, r] of rebases) this.rebaseOrderIn(next, id, r);
      for (const p of prepared.plans) {
        const carried = superseded.some((o) => o.node_id === p.nodeId) ? (state.nodes[p.nodeId]?.rework_history ?? []).at(-1) : undefined;
        next = this.applyReworkPlan(next, p, graph);
        // An order replaced in place keeps what its predecessor could restore: the generation it replaced, the dependents it reopened.
        if (carried !== undefined) this.inheritRestorable(next, p.nodeId, carried);
      }
      const r = next.acceptance_review as AcceptanceReviewState;
      // The refinement settled: the epoch moves, in this write, with the lineage of every order it put back; a PASS binds the epoch it moved to.
      const epoch = bumpEpoch(next, `refinement of ${open.review_id} settled ${outcome} (revision ${n})`, [...new Set(restoredBy)], at);
      if (epoch !== settledEpoch) throw new Error(`REVIEW_CHANGED: the orchestration epoch moved while ${open.review_id}'s refinement was settled; dispatch again.`);
      const rec = [...r.reviews].reverse().find((x) => x.review_id === open.review_id) as ReviewRecord;
      rec.epoch = epoch;
      rec.barrier = barrier;
      rec.original = rec.original ?? { dispatch_id: rec.dispatch_id, receipt_path: rec.receipt_path, receipt_sha256: rec.receipt_sha256, overall: rec.overall, inputs_sha256: rec.inputs_sha256 };
      rec.refinements = [...(rec.refinements ?? []), { dispatch_id: open.dispatch_id, capability_sha256: open.capability_sha256, round: ref.round, challenges: ref.challenges.map((c) => c.challenge_id), decisions, receipt_path: receiptPath, receipt_sha256: receiptSha, at, revision: n, orders: plan.orders.map((o) => ({ node_id: o.node_id, action: o.action })) }];
      rec.revision = n;
      rec.overall = overall;
      rec.outcome = outcome;
      rec.inputs_sha256 = open.inputs_sha256;
      rec.receipt_path = receiptPath;
      rec.receipt_sha256 = receiptSha;
      rec.reworks = reworks;
      rec.reworks_applied = reworks.length > 0 && missingReworks(next, open.review_id, reworks).length === 0;
      for (const c of r.challenges ?? []) {
        if (!ref.challenges.some((x) => x.challenge_id === c.challenge_id)) continue;
        for (const g of c.gaps) {
          const d = decisions.find((x) => x.challenge_id === c.challenge_id && x.criterion === g.criterion);
          if (d !== undefined) g.decision = d.decision;
        }
        c.status = c.gaps.some((g) => g.decision === 'UPHOLD') ? 'upheld' : c.gaps.some((g) => g.decision === 'REFINE') ? 'refined' : 'withdrawn';
        c.refinement = { dispatch_id: open.dispatch_id, receipt_path: receiptPath, at };
      }
      r.open = null;
      r.lineage = chained.lineage;
      r.usage = addUsage(r.usage, usage);
      next.usage = addUsage(next.usage, usage);
      if (outcome === 'REVIEW_GAPS') {
        r.blocked = { code: 'REVIEW_GAPS', review_id: open.review_id, detail: (blockDetail as string).slice(0, 4000), at, ...(exhausted.length > 0 ? { criteria: exhausted } : {}) };
        next.feature_state = 'BLOCKED';
        next.blocked_reason = `REVIEW_GAPS: ${(blockDetail as string).slice(0, 1000)}`;
      }
      return next;
    });
    this.afterSupersede(superseded.map((o) => ({ nodeId: o.node_id, action: o.action as 'amend' | 'cancel' })), state);
    for (const p of prepared.plans) this.reworkMade(p);
    for (const [id, r] of rebases) this.event('review.order_rebased', id, { review_id: r.review_id, from: r.from, to: r.to, criteria: r.criteria, by: r.by, rebase_sha256: r.sha256, claim: r.claim });
    for (const o of superseded) this.event('review.order_superseded', o.node_id, { review_id: open.review_id, revision: n, action: o.action, criteria_before: o.criteria_before, criteria_after: o.criteria_after });
    this.event('review.settled', null, {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      overall,
      outcome,
      inputs_sha256: open.inputs_sha256,
      receipt_path: receiptPath,
      receipt_sha256: receiptSha,
      revision: n,
      model: judged.refinement.reviewer.model.slice(0, 100),
      verdict_sha256: reviewer.verdict_sha256,
      canonical_verdict_sha256: canonical,
      ...transportEvent(reviewer.transport),
      normalized: judged.normalization.changed.slice(0, 16).map((c) => ({ pointer: c.pointer, action: c.action, original_length: c.original_length, original_sha256: c.original_sha256 })),
      gaps: judged.gaps.map((g) => g.criterion),
      reworks,
      refined: ordering.map((o) => o.node_id),
      orders: plan.orders.map((o) => ({ node_id: o.node_id, action: o.action })),
      refinement: { round: ref.round, decisions },
      by,
    });
    removeReviewCheckouts(this.controlRoot, this.featureId, open.review_id, this.workspace);
    this.fault('review-recorded');
    const now = [...(this.requiredReview()?.reviews ?? [])].reverse().find((r) => r.review_id === open.review_id) as ReviewRecord;
    return this.recordReport(now);
  }

  /** A planned review rework bound to the revision of its review it is made by: its origin, its brief's, its record's. */
  private bindPlan(plan: ReworkPlan, ref: ReviewRevisionRef): void {
    if (plan.origin?.kind !== 'acceptance-review') return;
    plan.origin = boundOrigin(plan.origin, ref);
    if (plan.brief.origin !== undefined) plan.brief.origin = boundOrigin(plan.brief.origin, ref);
  }

  /**
   * Put a node's review order out of force on `s` (the body of a STATE.json
   * write) for a later revision of its review: the history entry marked
   * superseded (it counts for nothing, as a challenged one), the node back on
   * the DONE generation the order replaced, exactly (as a challenge restores
   * it); a live claim of it revoked. A cancel puts back the dependents it
   * reopened too. Returns those dependents.
   */
  private supersedeOrderIn(s: FeatureState_, nodeId: string, mark: NonNullable<ReworkHistoryEntry['superseded']>, graph: PortfolioGraph, restoreDependents: boolean): string[] {
    const n = s.nodes[nodeId] as NodeRuntime;
    const history = n.rework_history ?? [];
    const entry = history[history.length - 1];
    if (entry === undefined || !stoodRework(entry) || (entry.restore ?? null) === null) {
      throw new ReworkRefusedError('REWORK_NOT_DONE', `${nodeId}'s order keeps no generation to restore: revision ${mark.revision} of ${mark.review_id} cannot replace it`);
    }
    const restored = this.restoredGeneration(entry);
    if ('problem' in restored) throw new ReworkRefusedError('REWORK_NOT_DONE', `${nodeId}: ${restored.problem}`);
    entry.superseded = { ...mark };
    if (n.claim !== null) closeLeases(s, (l) => l.node_id === nodeId && l.claim_id === (n.claim as NodeClaim).claim_id, 'revoked', `superseded by revision ${mark.revision} of ${mark.review_id}`, mark.at);
    restoreGenerationInto(n, restored, mark.at);
    if (!restoreDependents) return [];
    return restoreDependentsInto(s, this.restorableDependents(entry), graph, mark.at);
  }

  /** An order replaced in place by a revision of its review: the new one restores what the old one could (its generation, its reopened dependents). */
  private inheritRestorable(s: FeatureState_, nodeId: string, old: ReworkHistoryEntry): void {
    const history = s.nodes[nodeId]?.rework_history ?? [];
    const entry = history[history.length - 1];
    if (entry === undefined || entry === old) return;
    entry.branch_head = old.branch_head;
    entry.archived_ref = old.archived_ref;
    const kept = Object.fromEntries(Object.entries(old.restore_dependents ?? {}).filter(([id]) => s.nodes[id]?.state === 'INVALIDATED'));
    if (Object.keys(kept).length > 0) entry.restore_dependents = { ...kept, ...(entry.restore_dependents ?? {}) };
  }

  /**
   * After a write that put orders out of force: a cancelled order's node is
   * DONE on its generation again — its worker branch back where that
   * generation left it (anything the order's workers made archived first) and
   * any worktree of the order removed; its leases released.
   */
  private afterSupersede(orders: { nodeId: string; action: 'amend' | 'cancel' }[], before: FeatureState_): void {
    for (const { nodeId, action } of orders) {
      releaseAllForNode(this.paths.featureDir, nodeId);
      const node = this.node(nodeId);
      if (node.repository === null) continue;
      const repoPath = repositoryPath(this.workspace, node.repository);
      const worktree = before.nodes[nodeId]?.claim?.worktree ?? null;
      if (worktree !== null) removeWorkerWorktree(repoPath, worktree);
      if (action !== 'cancel') continue;
      const entry = (this.state().nodes[nodeId]?.rework_history ?? []).at(-1);
      const branch = workerBranchName(this.featureId, nodeId);
      const head = branchExists(repoPath, branch) ? resolveRef(repoPath, branch) : null;
      if (entry === undefined || head === entry.branch_head) continue;
      if (head !== null) runGit(repoPath, ['update-ref', this.archiveRefName(nodeId, head), head], { allowFail: true });
      if (entry.branch_head !== null) runGit(repoPath, ['branch', '-f', branch, entry.branch_head], { allowFail: true });
      else runGit(repoPath, ['branch', '-D', branch], { allowFail: true });
    }
  }

  /**
   * Rebase a node's live review order to a later revision of its review on
   * `s` (the body of a STATE.json write): bound to it (its origin, its
   * evidence), the rebase recorded on the brief and its history entry — its
   * generation, attempts and reason untouched. A live claim of it is the same
   * generation reissued: its old capability rotated away now, its lease
   * revoked, a new one issued for the next dispatch to hand out from where the
   * worker stands (its worktree, commits, gates); never charged.
   */
  private rebaseOrderIn(s: FeatureState_, nodeId: string, rebase: ReworkRebase): void {
    const n = s.nodes[nodeId] as NodeRuntime;
    const brief = n.rework_brief as ReworkBrief;
    const entry = (n.rework_history ?? []).at(-1) as ReworkHistoryEntry;
    brief.origin = boundOrigin(brief.origin as ReworkOrigin, rebase.to);
    brief.evidence = [...new Set([rebase.to.receipt_path, ...brief.evidence.filter((p) => p !== rebase.from.receipt_path)])].slice(0, 8);
    brief.rebases = [...(brief.rebases ?? []), structuredClone(rebase)];
    entry.rebases = [...(entry.rebases ?? []), structuredClone(rebase)];
    const c = n.claim;
    if (c === null || c.mode !== 'host' || rebase.claim === null || c.claim_id !== rebase.claim.claim_id) return;
    const capability = newCapability();
    const from = c.dispatch_id ?? null;
    closeLeases(s, (l) => l.node_id === nodeId && l.claim_id === c.claim_id && l.dispatch_id === from, 'revoked', `its order was rebased to revision ${rebase.to.revision} of ${rebase.review_id}`, rebase.at);
    c.settling = null;
    c.capture_pending = null;
    delete c.result_captured_sha256;
    delete c.result_captured_file;
    delete c.result_captured_dispatch_id;
    c.seal = null;
    c.criteria_judged = null;
    c.capability_sha256 = capability.sha256;
    c.dispatch_id = rebase.claim.to_dispatch_id;
    c.result_file = generationResultFile(rebase.claim.to_dispatch_id);
    c.host_session = null;
    c.review_rebase = { review_id: rebase.review_id, from_revision: rebase.from.revision, to_revision: rebase.to.revision, from_dispatch_id: from, rebase_sha256: rebase.sha256, at: rebase.at };
    issueLease(s, { kind: c.lease_kind ?? 'worker', node_id: nodeId, review_id: null, claim_id: c.claim_id, dispatch_id: rebase.claim.to_dispatch_id, capability_sha256: capability.sha256, generation: c.generation ?? 0, worktree: c.worktree, result_file: c.result_file, host: null }, rebase.at);
  }

  // ---- an order bound to an older revision of its review (CSET-203 r14) ----------------------

  /**
   * Why a node's live review order is bound to an older revision of its
   * review than the current one (an order STATE.json recorded before review
   * revisions, as r14's — a refinement made since reconciles every order in
   * its own write): the revision it is bound to, the current one, and the
   * carry proofs of its gaps when they carry there unchanged (else null).
   * Null when it is bound to the current revision, or is no review order.
   */
  private orderStaleness(state: FeatureState_, nodeId: string): { record: ReviewRecord; from: ReviewRevisionRef; to: ReviewRevisionRef; carry: CarryProof[] | null } | null {
    const brief = state.nodes[nodeId]?.rework_brief ?? null;
    if (brief === null || brief.origin?.kind !== 'acceptance-review') return null;
    const record = [...(state.acceptance_review?.reviews ?? [])].reverse().find((r) => r.review_id === brief.origin?.review_id);
    if (record === undefined) return null;
    const from = boundRevision(record, brief);
    const to = currentRevision(record);
    if (from === null || from.revision >= to.revision) return null;
    const read = (rel: string): ReceiptRead => readReceiptFile(this.controlRoot, rel);
    const fromGaps = revisionGaps(read, from);
    const toGaps = revisionGaps(read, to);
    if (fromGaps === null || toGaps === null) return { record, from, to, carry: null };
    const carried = carryAcross({ graph: this.graph(), nodeId, reviewGaps: brief.review_gaps ?? [], fromGaps, toGaps });
    return { record, from, to, carry: carried.ok ? carried.carry : null };
  }

  /**
   * An order handed out only bound to its review's current revision and with
   * its gaps exactly that revision's: a claim of one bound to an older
   * revision (dispatch reconciles it first), or of one whose binding cannot be
   * trusted, is refused before anything is taken.
   */
  private assertOrderCurrent(s: FeatureState_, nodeId: string): void {
    const rt = s.nodes[nodeId];
    const review = s.acceptance_review ?? null;
    if (rt === undefined || review === null) return;
    const problems = nodeOrderProblems(review, nodeId, rt, (rel) => readReceiptFile(this.controlRoot, rel));
    if (problems.length > 0) throw new ReworkBriefError('REWORK_BRIEF_INVALID', `${problems[0]}; re-run node rework, or record a decision`);
    const stale = this.orderStaleness(s, nodeId);
    if (stale !== null) throw new ReworkBriefError('REWORK_BRIEF_INVALID', `${nodeId}'s order is bound to revision ${stale.from.revision} of ${stale.record.review_id}, which is at revision ${stale.to.revision}: dispatch reconciles it before it is handed out`);
  }

  /**
   * Rebase a node's stale order to the current revision of its review in one
   * STATE.json write — its live claim, if any, reissued from where it stands
   * — when its gaps still carry there unchanged. The rebase record, or null
   * when there was nothing (any more) to rebase.
   */
  private rebaseStaleOrder(nodeId: string, code: string): ReworkRebase | null {
    const at = new Date().toISOString();
    let made: ReworkRebase | null = null;
    mutateState(this.paths.featureDir, (s) => {
      const now = this.orderStaleness(s, nodeId);
      if (now === null || now.carry === null) return s;
      const c = s.nodes[nodeId]?.claim ?? null;
      const live = c !== null && c.mode === 'host' ? { claim_id: c.claim_id, from_dispatch_id: c.dispatch_id ?? null, to_dispatch_id: randomUUID() } : null;
      made = rebaseRecord({ review_id: now.record.review_id, from: now.from, to: now.to, criteria: now.carry.map((x) => x.criterion), carry: now.carry, by: 'reconcile', claim: live, at });
      this.rebaseOrderIn(s, nodeId, made);
      return s;
    });
    const r = made as ReworkRebase | null;
    if (r !== null) this.event('review.order_rebased', nodeId, { review_id: r.review_id, from: r.from, to: r.to, criteria: r.criteria, by: r.by, code, rebase_sha256: r.sha256, claim: r.claim });
    return r;
  }

  /**
   * The answer of a ticket whose order is bound to an older revision of its
   * review: an orchestration reconciliation, never a worker's failure
   * (CSET-203 r14: two REVIEW_CHALLENGE_STALE refusals charged two attempts
   * and BLOCKED the cli). Its gaps carry unchanged: rebased, the same
   * generation reissued from where it stands. Its gaps changed: the claim is
   * handed back unspent and the order replaced (or cancelled). No attempt or
   * failure is counted either way; the answer is never judged.
   */
  private reconcileStaleClaim(nodeId: string, sessionId: string | null, stale: { record: ReviewRecord; from: ReviewRevisionRef; to: ReviewRevisionRef; carry: CarryProof[] | null }, result: NodeResult): NodeRunReport {
    const challenge = result.outcome === 'REVIEW_GAP_CHALLENGE' || this.legacyChallenge(nodeId, result);
    const what = `its order is bound to revision ${stale.from.revision} of ${stale.record.review_id} (${stale.from.receipt_path}), which is at revision ${stale.to.revision} (${stale.to.receipt_path})`;
    if (stale.carry !== null) {
      const code = challenge ? 'REVIEW_CHALLENGE_STALE' : 'REVIEW_REVISION_REPLACED';
      const r = this.rebaseStaleOrder(nodeId, code);
      if (r !== null) {
        return {
          node_id: nodeId,
          outcome: 'REVIEW_ORDER_REBASED',
          session_id: sessionId,
          state: this.state().nodes[nodeId]?.state ?? 'READY',
          detail: `${code}: ${what}. Its gaps (${r.criteria.join(', ')}) carry there unchanged: the order is rebased to revision ${r.to.revision} and the same generation reissued from where it stands; this answer is not judged and nothing was charged. Run dispatch: it hands the reissued ticket out.`,
          evidence: [],
          reconciliation: { code, review_id: r.review_id, from_revision: r.from.revision, to_revision: r.to.revision, rebase_sha256: r.sha256 },
        };
      }
    }
    // Its gaps changed: the claim handed back unspent, the order replaced or cancelled by the reconciliation.
    const claim = this.state().nodes[nodeId]?.claim ?? null;
    if (claim !== null) this.releaseForPrecondition(nodeId, claim.claim_id, `REVIEW_GAP_STALE: ${what}`);
    this.reconcileReviewOrders();
    this.event('review.order_reconciled', nodeId, { code: 'REVIEW_GAP_STALE', review_id: stale.record.review_id, from: stale.from, to: stale.to });
    return {
      node_id: nodeId,
      outcome: 'REVIEW_GAP_STALE',
      session_id: sessionId,
      state: this.state().nodes[nodeId]?.state ?? 'READY',
      detail: `REVIEW_GAP_STALE: ${what}, and a gap of it changed there: the claim was handed back unspent and the order replaced (or cancelled) for what revision ${stale.to.revision} holds; this answer is not judged and nothing was charged. Run dispatch.`,
      evidence: [],
      reconciliation: { code: 'REVIEW_GAP_STALE', review_id: stale.record.review_id, from_revision: stale.from.revision, to_revision: stale.to.revision, rebase_sha256: null },
    };
  }

  /**
   * Reconcile every live review order STATE.json still binds to an older
   * revision of its review than the current one (written before review
   * revisions, as r14's): its gaps carried unchanged, rebased (a live claim
   * reissued from where it stands); its gaps changed, a live claim handed back
   * unspent and the order replaced — or cancelled when the review keeps no gap
   * of it. Idempotent; a settle in progress reconciles its own.
   */
  /**
   * The unresolved criteria of a per-criterion answer, ordered again on their own (CSET-203 r15: an administrative split
   * of one order): a rework of the node — DONE on the criteria the same answer proved — for exactly those criteria, as
   * the review's current revision holds their gaps (a gap a later revision withdrew is closed), bound to that revision;
   * no attempt, failure or criterion budget spent (the same rework of each criterion). Parked at once, each criterion
   * with its own reason: NEEDS_DECISION, each question a recorded decision, when one asks a person; else BLOCKED. Deferred
   * while other work is in flight (dispatch makes it before anything else). What it did, or null (nothing to order).
   */
  private orderFollowUp(nodeId: string): NonNullable<NodeRunReport['follow_up']> | null {
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    const made = withLock(join(lockDir, 'deliver.lock'), () => {
      const state = this.state();
      const rt = state.nodes[nodeId];
      const p = (rt?.rework_history ?? []).at(-1)?.partial ?? null;
      if (rt === undefined || rt.state !== 'DONE' || p === null || p.follow_up !== 'pending') return null;
      const asked = p.unresolved.map((u) => u.criterion);
      if (Object.values(state.nodes).some((n) => n.claim !== null || IN_FLIGHT_STATES.has(n.state))) return { kind: 'pending' as const, criteria: asked };
      const graph = this.graph();
      const record = [...(state.acceptance_review?.reviews ?? [])].reverse().find((r) => r.review_id === p.order.review_id);
      const current = record === undefined ? null : currentRevision(record);
      const gaps = current === null ? [] : (revisionGaps((rel) => readReceiptFile(this.controlRoot, rel), current) ?? []).filter((g) => asked.includes(g.criterion));
      if (record === undefined || current === null || gaps.length === 0) {
        // The review keeps no gap of them any more: nothing to order, the node stays DONE.
        mutateState(this.paths.featureDir, (s) => {
          const e = (s.nodes[nodeId]?.rework_history ?? []).at(-1);
          if (e?.partial) e.partial.follow_up = null;
          return s;
        });
        return { kind: 'closed' as const, criteria: asked };
      }
      const summary = this.lineageSummary(state);
      const budgets = Object.fromEntries(gaps.map((g) => [g.criterion, { used: Math.max(0, (summary.criteria[g.criterion]?.accepted_reworks ?? 0) - 1), max: summary.criteria[g.criterion]?.max ?? summary.max_criterion_reworks }]));
      const refinement = p.order.refinement !== null ? Object.fromEntries(gaps.map((g) => [g.criterion, { ...(p.order.refinement as { challenge_id: string; round: number }) }])) : undefined;
      const criteria = gaps.map((g) => g.criterion);
      const planned = this.planGapReworks({ reviewId: record.review_id, review: record.review, receiptPath: current.receipt_path, budgets, targets: [{ node_id: nodeId, criteria }], gaps, state, graph, ...(refinement !== undefined ? { refinement } : {}) });
      const plan = planned.plans[0];
      if (plan === undefined || planned.refused.length > 0) return { kind: 'refused' as const, detail: (planned.refused[0]?.detail ?? 'nothing to plan').slice(0, 500), criteria };
      this.bindPlan(plan, current);
      const parked = p.unresolved.filter((u) => criteria.includes(u.criterion));
      const decide = parked.filter((u) => u.outcome === 'NEEDS_DECISION');
      const to: 'NEEDS_DECISION' | 'BLOCKED' = decide.length > 0 ? 'NEEDS_DECISION' : 'BLOCKED';
      const why = unresolvedReason(parked);
      mutateState(this.paths.featureDir, (s) => {
        let next = this.applyReworkPlan(s, plan, graph);
        const prev = ((next.nodes[nodeId] as NodeRuntime).rework_history ?? []).at(-2);
        if (prev?.partial) prev.partial.follow_up = 'ordered';
        next = applyNodeTransition(graph, next, nodeId, 'READY', { actor: this.owner, reason: `ordered again on its own: ${why}`.slice(0, 300) });
        return applyNodeTransition(graph, next, nodeId, to, { actor: this.owner, reason: why.slice(0, 300) });
      });
      return { kind: 'ordered' as const, plan, criteria, to, decide };
    }, { timeoutMs: 15_000, pollMs: 50, purpose: 'per-criterion follow-up order' });
    if (made === null) return null;
    if (made.kind === 'pending') return { criteria: made.criteria, state: 'pending', decisions: [] };
    if (made.kind === 'closed') {
      this.event('node.follow_up_closed', nodeId, { criteria: made.criteria });
      return null;
    }
    if (made.kind === 'refused') {
      this.event('node.follow_up_refused', nodeId, { criteria: made.criteria, detail: made.detail });
      return { criteria: made.criteria, state: 'pending', decisions: [] };
    }
    this.reworkMade(made.plan);
    const decisions = made.decide.map((u) => this.recordDecisionRequest(nodeId, { decision_request: criterionQuestion(u) } as NodeResult)).filter((x): x is string => x !== null);
    this.event('node.transition', nodeId, { to: made.to });
    this.event('node.follow_up_ordered', nodeId, { criteria: made.criteria, state: made.to, decisions });
    return { criteria: made.criteria, state: made.to, decisions };
  }

  /** Every per-criterion answer's unresolved criteria still to be ordered again: ordered when nothing is in flight. The nodes still waiting. */
  private orderPendingFollowUps(): string[] {
    const waiting: string[] = [];
    for (const [id, rt] of Object.entries(this.state().nodes)) {
      if (rt.state !== 'DONE' || (rt.rework_history ?? []).at(-1)?.partial?.follow_up !== 'pending') continue;
      const r = this.orderFollowUp(id);
      if (r !== null && r.state === 'pending') waiting.push(id);
    }
    return waiting;
  }

  /**
   * `tdd check` of a per-criterion answer (engine/criterion-outcomes.ts): judged exactly as settle will, read-only — its
   * form against the order; its history from the claim's base, with its own tdd claim; each DONE criterion's evidence;
   * one test for two criteria; its challenge, per criterion. Nothing is recorded.
   */
  checkCriteriaAnswer(nodeId: string, result: NodeResult):
    | { ok: true; head_sha: string; criteria: { criterion: string; outcome: string }[]; accepted: AcceptedCriterionRecord[]; challenge_sha256: string | null }
    | { ok: false; code: string; detail: string; criterion: string | null; candidates?: CriterionCandidate[]; problems?: unknown[] } {
    const state = this.state();
    const rt = state.nodes[nodeId] as NodeRuntime;
    const node = this.node(nodeId);
    const graph = this.graph();
    const form = criteriaForm({ result, brief: rt.rework_brief ?? null, graph, node });
    if (!form.ok) return { ok: false, code: form.code, detail: form.detail, criterion: form.criterion };
    if (form.form === null) return { ok: false, code: 'CRITERIA_RESULT_INVALID', detail: 'not a per-criterion answer (outcome CRITERIA)', criterion: null };
    const f = form.form;
    const per = (scalarCriteria(result, rt.rework_brief ?? null) ?? []).map((c) => ({ criterion: c.criterion, outcome: c.outcome as string }));
    const claim = rt.claim;
    if (claim === null || node.repository === null) return { ok: false, code: 'CHECK_UNAVAILABLE', detail: `${nodeId} has no claim with a repository to check`, criterion: null };
    if (f.done.length === 0 && f.challenged.length === 0) return { ok: true, head_sha: '', criteria: per, accepted: [], challenge_sha256: null };
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    const head = branchExists(repoPath, branch) ? resolveRef(repoPath, branch) : '';
    if (result.commit_sha !== head) return { ok: false, code: 'TDD_CLAIM_MISMATCH', detail: `the result's commit_sha ${String(result.commit_sha).slice(0, 12)} is not the head of ${branch}, ${head.slice(0, 12)}; an answer names exactly the commit it settles`, criterion: null };
    if (f.done.length === 0) {
      const judged = this.judgeChallengeOf(nodeId, result, { done: [], doneRedTests: [], doneTests: [], cycles: [], bindings: rt.tdd_red_bindings ?? [] });
      if (!judged.ok) return { ok: false, code: judged.code, detail: judged.detail, criterion: null, problems: judged.problems };
      return { ok: true, head_sha: head, criteria: per, accepted: [], challenge_sha256: judged.challenge_sha256 };
    }
    const policy = claim.tdd_policy ?? this.claimTddPolicy(node.repository);
    const base = claim.base_sha ?? rt.branch_base_sha ?? null;
    if (base === null) return { ok: false, code: 'CHECK_UNAVAILABLE', detail: `${nodeId}'s claim records no base`, criterion: null };
    // A held answer resubmitted at the held commit is judged with exactly the evidence it was held with.
    const hold = claim.evidence_correction;
    const judgedRuntime = hold?.held && head === hold.commit_sha ? { ...rt, evidence: hold.held.evidence, tdd_red_bindings: (rt.tdd_red_bindings ?? []).slice(0, hold.held.bindings) } : rt;
    const history = verifyTddHistory({
      repoPath,
      base,
      head,
      policy,
      bindings: judgedRuntime.tdd_red_bindings ?? [],
      requireRed: node.required_evidence.includes('red'),
      declarationsOnly: !node.required_evidence.includes('red') && node.node_type !== 'refactor',
      compatibility: { criteria: this.compatibilityCriteria(nodeId) },
      claimed: result.tdd ?? null,
    });
    if (!history.ok && history.violation !== null) return { ok: false, code: history.violation.code, detail: history.violation.detail, criterion: null };
    const judged = judgeCriteria({
      controlRoot: this.controlRoot,
      featureId: this.featureId,
      graph,
      node,
      runtime: judgedRuntime,
      evidence: result.criterion_evidence,
      repoPath,
      head,
      policy,
      modulePath: claim.verification?.path ?? null,
      compatibility: history.compatibility,
      exclude: [...f.challenged, ...f.unresolved.map((u) => u.criterion)],
      challengeTests: (result.challenge?.gaps ?? []).flatMap((g) => g.tests),
    });
    if (!judged.ok) return { ok: false, code: judged.code, detail: judged.detail, criterion: judged.criterion, candidates: judged.candidates };
    const answered = this.answerVerdict(nodeId, result, f, judged.accepted, history.cycles, head);
    if (answered.kind === 'hold') return { ok: false, code: answered.refusal.code, detail: answered.refusal.detail, criterion: answered.refusal.criterion };
    if (answered.kind === 'refused') return { ok: false, code: answered.refusal.code, detail: answered.refusal.detail, criterion: null, problems: answered.refusal.problems };
    return { ok: true, head_sha: head, criteria: per, accepted: [...judged.accepted, ...answered.carried], challenge_sha256: answered.challenge_sha256 };
  }

  private reconcileReviewOrders(): { rebased: string[]; replaced: string[] } {
    const out = { rebased: [] as string[], replaced: [] as string[] };
    for (const id of Object.keys(this.state().nodes)) {
      const state = this.state();
      const stale = this.orderStaleness(state, id);
      if (stale === null) continue;
      const claim = state.nodes[id]?.claim ?? null;
      if (claim !== null && claim.settling && settlerAlive(claim.settling)) continue;
      if (stale.carry !== null) {
        if (this.rebaseStaleOrder(id, 'REVIEW_REVISION_REPLACED') !== null) out.rebased.push(id);
        continue;
      }
      if (claim !== null) this.releaseForPrecondition(id, claim.claim_id, `REVIEW_GAP_STALE: its order is bound to revision ${stale.from.revision} of ${stale.record.review_id}, whose revision ${stale.to.revision} changed its gaps`);
      if (this.replaceStaleOrder(id)) out.replaced.push(id);
    }
    return out;
  }

  /**
   * Replace (or cancel) a stale order whose gaps the current revision of its
   * review changed, under the delivery lock, in one STATE.json write: put out
   * of force, and ordered again for exactly the gaps that revision holds for
   * the node, bound to it — never charged. True when it was replaced.
   */
  private replaceStaleOrder(nodeId: string): boolean {
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'deliver.lock'), () => {
      const state = this.state();
      const stale = this.orderStaleness(state, nodeId);
      if (stale === null || stale.carry !== null || (state.nodes[nodeId]?.claim ?? null) !== null) return false;
      const graph = this.graph();
      const summary = this.lineageSummary(state);
      const gaps = (revisionGaps((rel) => readReceiptFile(this.controlRoot, rel), stale.to) ?? []).filter((g) => {
        const rep = summary.criteria[g.criterion]?.reproductions.find((r) => r.sha256 === reproductionSha256(g.reproduction));
        return rep === undefined || rep.status === 'accepted';
      });
      const target = gapTargets(graph, gaps).targets.find((t) => t.node_id === nodeId);
      const at = new Date().toISOString();
      const action: 'amend' | 'cancel' = target === undefined ? 'cancel' : 'amend';
      const mark = { review_id: stale.record.review_id, revision: stale.to.revision, action, at, reason: `revision ${stale.to.revision} of ${stale.record.review_id} changed the gaps of this order, bound to revision ${stale.from.revision}` };
      const virtual = structuredClone(state);
      try {
        this.supersedeOrderIn(virtual, nodeId, mark, graph, action === 'cancel');
      } catch (err) {
        if (!(err instanceof ReworkRefusedError)) throw err;
        this.event('review.order_reconciled', nodeId, { code: 'REVIEW_GAP_STALE', refused: err.message.slice(0, 300) });
        return false;
      }
      let plan: ReworkPlan | null = null;
      if (target !== undefined) {
        const budgets = Object.fromEntries(target.gaps.map((g) => [g.criterion, { used: Math.max(0, (summary.criteria[g.criterion]?.accepted_reworks ?? 0) - 1), max: summary.criteria[g.criterion]?.max ?? summary.max_criterion_reworks }]));
        const planned = this.planGapReworks({ reviewId: stale.record.review_id, review: stale.record.review, receiptPath: stale.to.receipt_path, budgets, targets: [target], gaps: target.gaps, state: virtual, graph });
        if (planned.refused.length > 0 || planned.plans.length === 0) {
          this.event('review.order_reconciled', nodeId, { code: 'REVIEW_GAP_STALE', refused: (planned.refused[0]?.detail ?? 'nothing to plan').slice(0, 300) });
          return false;
        }
        plan = planned.plans[0] as ReworkPlan;
        this.bindPlan(plan, stale.to);
      }
      const old = (state.nodes[nodeId]?.rework_history ?? []).at(-1);
      mutateState(this.paths.featureDir, (s) => {
        const restored = this.supersedeOrderIn(s, nodeId, mark, graph, action === 'cancel');
        let next = s;
        if (plan !== null) {
          next = this.applyReworkPlan(next, plan, graph);
          if (old !== undefined) this.inheritRestorable(next, nodeId, old);
        } else bumpEpoch(next, `order of ${nodeId} cancelled: ${mark.reason}`.slice(0, 300), [nodeId, ...restored], at);
        return next;
      });
      this.afterSupersede([{ nodeId, action }], state);
      if (plan !== null) this.reworkMade(plan);
      this.event('review.order_superseded', nodeId, { review_id: stale.record.review_id, revision: stale.to.revision, action, by: 'reconcile', from_revision: stale.from.revision });
      return plan !== null;
    }, { timeoutMs: 15_000, pollMs: 50, purpose: 'review order reconciliation' });
  }

  /**
   * The rework of each producer a GAPS review's gaps map to, planned against
   * `state` (nothing changes yet), dependents first, each with exactly its
   * own criteria and the bounded public reason of its own gaps (gapReason:
   * a focused RED for a new behaviour, a compatibility-regression unit for a
   * compatibility criterion). A rework already made for this review (an
   * interrupted settle finishing) counts as made; a refused one (its limit
   * spent, say) is returned apart and blocks the feature, never the others.
   */
  private planGapReworks(args: {
    reviewId: string;
    review: number;
    receiptPath: string;
    /** Each gap criterion's accepted reworks before this one, and its budget (engine/review-lineage.ts). */
    budgets: Record<string, { used: number; max: number }>;
    targets: { node_id: string; criteria: string[] }[];
    gaps: Gap[];
    state: FeatureState_;
    graph: PortfolioGraph;
    /** A refinement's gaps: the challenge each refines (by criterion) and its round. */
    refinement?: Record<string, { challenge_id: string; round: number }>;
  }): { plans: ReworkPlan[]; made: string[]; refused: { node_id: string; criteria: string[]; detail: string }[] } {
    const plans: ReworkPlan[] = [];
    const made: string[] = [];
    const refused: { node_id: string; criteria: string[]; detail: string }[] = [];
    for (const target of args.targets) {
      const gaps = args.gaps.filter((g) => target.criteria.includes(g.criterion));
      const refined = args.refinement === undefined ? undefined : target.criteria.map((ac) => args.refinement?.[ac]).find((x) => x !== undefined);
      const reason = gapReason({ reviewId: args.reviewId, review: args.review, budgets: args.budgets, gaps, kindOf: (ac) => criterionKind(args.graph, ac), ...(refined !== undefined ? { refinement: { ...refined, max: MAX_CHALLENGE_ROUNDS } } : {}) });
      const origin: ReworkOrigin = { kind: 'acceptance-review', review_id: args.reviewId, review: args.review, ...(refined !== undefined ? { refinement: { ...refined } } : {}) };
      const reviewGaps = gaps.map((g) => ({ criterion: g.criterion, reproduction_sha256: reproductionSha256(g.reproduction) }));
      try {
        const planned = this.planRework(target.node_id, { reason, acceptance: target.criteria, exactAcceptance: true, evidence: [args.receiptPath], origin, reviewGaps }, args.state, args.graph);
        if ('idempotent' in planned) made.push(target.node_id);
        else plans.push(planned);
      } catch (err) {
        if (!(err instanceof ReworkRefusedError)) throw err;
        refused.push({ node_id: target.node_id, criteria: [...target.criteria], detail: err.message.slice(0, 600) });
      }
    }
    return { plans, made, refused };
  }

  /** Why a GAPS review blocks the feature although its other gaps were reworked: gaps no product node serves, reworks refused. */
  private unreworkableDetail(reviewId: string, args: { gaps: Gap[]; unowned: Gap[]; refused: { node_id: string; criteria: string[]; detail: string }[]; reworked: { node_id: string; criteria: string[] }[]; graph: PortfolioGraph }): string {
    const named = args.gaps.map((g) => `${g.criterion} (reproduce: ${g.reproduction.slice(0, 160)})`).join('; ');
    const owners = (ac: string): string => args.graph.nodes.filter((n) => (n.acceptance_criteria ?? []).includes(ac)).map((n) => `${n.id} (${n.node_type})`).join(', ') || 'no node';
    return [
      `${reviewId} found ${named}.`,
      ...args.unowned.map((g) => `${g.criterion} is served by no product node: the graph gives it only to ${owners(g.criterion)}, a graph from before every criterion had a producer, so its gap has no node to rework (REVIEW_OWNER_UNKNOWN).`),
      ...args.refused.map((r) => `The rework of ${r.node_id} for ${r.criteria.join(', ')} was refused: ${r.detail}.`),
      args.reworked.length > 0 ? `The other gaps were reworked all the same: ${args.reworked.map((r) => `${r.node_id} (${r.criteria.join(', ')})`).join('; ')}.` : 'Nothing was reworked.',
      'No candidate is cut. A person decides: supersede the feature with a graph whose implementation nodes serve every criterion (graph validate), or record a decision and rework past the block (node rework --decision).',
    ].join(' ');
  }

  /**
   * A valid verdict, settled: its receipt, then one STATE.json write that
   * records the review and, for GAPS, makes the rework of every producer
   * its gaps map to (gapTargets: by the graph; the reviewer's naming is
   * advisory), dependents first, each with its own criteria and public
   * reason; the candidate and everything downstream are invalidated by the
   * first of them. Never concurrently with a delivery. A gap left after the
   * last round, a gap whose criterion no product node serves (a graph from
   * before every criterion had a producer) or a refused rework blocks the
   * feature in that same write — the reworks of the other gaps are made all
   * the same, and no candidate is cut. `reworks_applied` is true only when
   * the rework records of `reworks` exist.
   */
  private recordVerdict(open: OpenReview, judged: Extract<ReturnType<typeof judgeVerdict>, { ok: true }>, reviewer: SettledReviewer, by: string): ReviewSettleReport {
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'deliver.lock'), () => this.recordVerdictLocked(open, judged, reviewer, by), { timeoutMs: 15_000, pollMs: 50, purpose: 'acceptance review reworks' });
  }

  private recordVerdictLocked(open: OpenReview, judged: Extract<ReturnType<typeof judgeVerdict>, { ok: true }>, reviewer: SettledReviewer, by: string): ReviewSettleReport {
    const state = this.state();
    const review = this.requiredReview(state) as AcceptanceReviewState;
    const graph = this.graph();
    const used = roundsUsed(review.reviews, this.lastAcceptedAt(state));
    const receiptPath = `features/${this.featureId}/reviews/${open.review_id}.json`;
    // Each gap against its own criterion's lineage (CSET-203 r11): a repeat is no rework, a criterion past its budget is
    // exhausted, the rest are reworked — and only a gap a producer is actually reworked for spends its criterion's budget.
    const lineage = this.lineageOf(state);
    const summary = this.lineageSummary(state, lineage);
    let outcome: ReviewRecord['outcome'] = 'PASS';
    let blockDetail: string | null = null;
    let targets: GapTarget[] = [];
    let unowned: Gap[] = [];
    let prepared: ReturnType<Orchestrator['planGapReworks']> = { plans: [], made: [], refused: [] };
    // Past a criterion's budget a materially new gap is reworked on verified producer progress (CSET-201 final), and a
    // repeat that names an uncovered boundary no earlier gap named is new all the same.
    const facts: GapFacts = { progress: this.progressFacts(state, summary, judged.gaps.map((g) => g.criterion), open.inputs.repositories) };
    // Every standing completion at the exact heads reviewed (CSET-201 final): a criterion whose proof is lost is a regression —
    // restored, never an ignored duplicate, never an accepted rework — and a PASS closes nothing while one is.
    const coverage = this.coverageAt(open.inputs.repositories);
    const lost = lostCompletions(coverage);
    facts.regressions = regressionFacts(lost);
    const lineageOfGaps: GapLineageJudgement[] = judged.overall === 'GAPS' ? judgeGapLineage(summary, judged.gaps.map((g) => ({ ...g, boundaries: uncoveredBoundaries(judged.verdict.criteria, g.criterion) })), facts) : [];
    const verdictOf = (criterion: string): GapLineageJudgement['verdict'] | undefined => lineageOfGaps.find((j) => j.criterion === criterion)?.verdict;
    const allowable = judged.gaps.filter((g) => verdictOf(g.criterion) === 'accepted');
    const exhausted = judged.gaps.filter((g) => verdictOf(g.criterion) === 'exhausted').map((g) => g.criterion);
    if (judged.overall === 'GAPS') {
      const mapped = gapTargets(graph, allowable);
      targets = mapped.targets;
      unowned = mapped.unowned;
      prepared = this.planGapReworks({ reviewId: open.review_id, review: open.review, receiptPath, budgets: this.budgetsOf(summary, allowable, lineageOfGaps), targets, gaps: allowable, state, graph });
      const made = targets.filter((t) => prepared.made.includes(t.node_id) || prepared.plans.some((p) => p.nodeId === t.node_id));
      // A lost proof restored beside the reworks of the review's gaps, uncharged.
      const restored = this.planRestorations({ reviewId: open.review_id, review: open.review, receiptPath, lost, gaps: judged.gaps, state, graph, summary, into: prepared.plans });
      prepared = { ...prepared, plans: [...prepared.plans, ...restored.plans], refused: [...prepared.refused, ...restored.refused] };
      if (unowned.length > 0 || prepared.refused.length > 0) {
        outcome = 'REVIEW_GAPS';
        blockDetail = this.unreworkableDetail(open.review_id, { gaps: [...allowable, ...judged.gaps.filter((g) => exhausted.includes(g.criterion))], unowned, refused: prepared.refused, reworked: prepared.plans.map((p) => ({ node_id: p.nodeId, criteria: p.acceptance })), graph });
      } else if (made.length === 0 && exhausted.length > 0) {
        // Nothing else to rework: the exhausted criterion blocks now.
        outcome = 'REVIEW_GAPS';
      } else outcome = made.length > 0 ? 'GAPS' : 'REPEATED';
      if (outcome === 'REPEATED' && prepared.plans.length > 0) outcome = 'REGRESSION';
      if (outcome === 'REVIEW_GAPS' && blockDetail === null && made.length === 0 && prepared.plans.length > 0) outcome = 'REGRESSION';
    } else if (lost.length > 0) {
      // A PASS on heads that lost a completed proof is no closure: the proof is restored and reviewed again.
      const restored = this.planRestorations({ reviewId: open.review_id, review: open.review, receiptPath, lost, gaps: [], state, graph, summary, into: [] });
      prepared = { plans: restored.plans, made: [], refused: restored.refused };
      outcome = restored.refused.length > 0 ? 'REVIEW_GAPS' : 'REGRESSION';
      if (restored.refused.length > 0) blockDetail = this.unreworkableDetail(open.review_id, { gaps: [], unowned: [], refused: restored.refused, reworked: restored.plans.map((p) => ({ node_id: p.nodeId, criteria: p.acceptance })), graph });
    }
    const restoring = prepared.plans.filter((p) => (p.origin?.restoration ?? []).length > 0 && !targets.some((t) => t.node_id === p.nodeId)).map((p) => p.nodeId);
    const reworks = [...targets.map((t) => t.node_id).filter((id) => prepared.made.includes(id) || prepared.plans.some((p) => p.nodeId === id)), ...restoring];
    const reworkedFor = (criterion: string): string[] => targets.filter((t) => reworks.includes(t.node_id) && t.criteria.includes(criterion)).map((t) => t.node_id);
    const gapBodies: LineageEventBody[] = lineageOfGaps.map((j) => {
      const nodes = j.verdict === 'accepted' ? reworkedFor(j.criterion) : j.verdict === 'regression' ? prepared.plans.filter((p) => (p.origin?.restoration ?? []).some((r) => r.criterion === j.criterion)).map((p) => p.nodeId) : [];
      return gapEvent(open.review_id, j, j.verdict === 'accepted' && nodes.length === 0 ? 'unreworkable' : j.verdict, nodes);
    });
    const accepted = gapBodies.filter((b) => b.kind === 'gap' && b.verdict === 'accepted').length;
    const heads = open.inputs.repositories.map((r) => `${r.name}@${r.head_sha}`).sort();
    const passed = judged.verdict.criteria.filter((c) => c.verdict === 'PASS').map((c) => c.criterion);
    const progress = reviewProgress(summary, { heads, passed, gaps: judged.gaps.map((g) => g.criterion), accepted, pass: judged.overall === 'PASS' });
    // No progress, again: past the ceiling the review is nonconvergent (a review that reworked or passed made progress).
    const streak = progress.length === 0 ? summary.no_progress_streak + 1 : 0;
    if (outcome === 'REPEATED' && streak >= summary.max_no_progress) {
      outcome = 'REVIEW_NONCONVERGENT';
      blockDetail = this.nonconvergentDetail({ ...summary, no_progress_streak: streak, review_sessions: summary.review_sessions + 1, reviews: [...summary.reviews, { review_id: open.review_id, outcome: 'REPEATED', heads, passed, gaps: judged.gaps.map((g) => g.criterion), progress, seq: 0 }] }, `${streak} consecutive reviews made no progress (no producer change, no new criterion proof, no accepted materially new gap, no valid challenge): ${[...(streak > 1 ? summary.reviews.slice(-(streak - 1)) : []).map((r) => `${r.review_id} ${r.outcome}`), `${open.review_id} REPEATED`].join(', ')}`);
    }
    if (outcome === 'REVIEW_GAPS' && blockDetail === null) {
      const pending = lineageOfGaps.filter((j) => j.verdict === 'exhausted').map((j) => ({ criterion: j.criterion, review_id: open.review_id, reproduction_sha256: j.reproduction_sha256 }));
      blockDetail = this.exhaustedDetail(summary, pending);
    }
    const bodies: LineageEventBody[] = [
      ...gapBodies,
      { kind: 'review', review_id: open.review_id, inputs_sha256: open.inputs_sha256, heads, outcome, passed, gaps: judged.gaps.map((g) => g.criterion), progress },
      ...(outcome === 'PASS' ? passed.map((c): LineageEventBody => ({ kind: 'closure', review_id: open.review_id, criterion: c, inputs_sha256: open.inputs_sha256 })) : []),
      ...regressionEvents(open.review_id, prepared.plans),
      ...(outcome === 'REVIEW_GAPS' || outcome === 'REVIEW_NONCONVERGENT' ? [{ kind: 'blocked', review_id: open.review_id, code: outcome === 'REVIEW_GAPS' ? 'REVIEW_GAPS' : 'REVIEW_NONCONVERGENT', criteria: exhausted } as LineageEventBody] : []),
    ];
    const at = new Date().toISOString();
    const chained = appendLineage(lineage, bodies, at);
    const after = this.lineageSummary(state, chained.lineage);
    // The epoch this settle moves the feature to (each rework, then the review), and a PASS's barrier: what it binds.
    const settledEpoch = currentEpoch(state) + prepared.plans.length + 1;
    const barrier: ReviewBarrier | null = outcome === 'PASS' ? { epoch: settledEpoch, at, leases: [], nodes_done: true } : null;
    const receipt = {
      schema: REVIEW_RECEIPT_SCHEMA,
      feature_id: this.featureId,
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      review: open.review,
      rework_rounds: { used, max: review.max_rounds },
      inputs: open.inputs,
      inputs_sha256: open.inputs_sha256,
      packet_path: open.packet_path,
      packet_sha256: open.packet_sha256,
      // The verdict as the reviewer wrote it (attested), and the canonical one this receipt carries (criteria below).
      verdict_sha256: reviewer.verdict_sha256,
      canonical_verdict_sha256: judged.normalization.canonical_sha256,
      normalization: judged.normalization,
      reviewer: { agent: REVIEWER_AGENT, model: judged.verdict.reviewer.model, agent_id: reviewer.agent_id, session_id: reviewer.session_id },
      transport: reviewer.transport,
      overall: judged.overall,
      outcome,
      criteria: judged.verdict.criteria,
      gaps: judged.gaps,
      reworks: [...targets.filter((t) => reworks.includes(t.node_id)).map((t) => ({ node_id: t.node_id, criteria: t.criteria, by: t.by })), ...restoring.map((id) => ({ node_id: id, criteria: (prepared.plans.find((p) => p.nodeId === id) as ReworkPlan).acceptance, by: 'restoration' }))],
      // Every standing completion at the reviewed heads: what this review's closure (or its gaps) stood on.
      coverage,
      unowned,
      refused: prepared.refused,
      blocked: blockDetail,
      // What each gap came to against its criterion's own lineage, and the chain head this settle leaves (engine/review-lineage.ts).
      lineage: {
        prev_sha256: lineage.head_sha256,
        head_sha256: chained.lineage.head_sha256,
        events: chained.appended.map((e) => ({ seq: e.seq, kind: e.kind, sha256: e.sha256 })),
        gaps: gapBodies.map((b, i) => lineageGapView(lineageOfGaps[i] as GapLineageJudgement, b, facts)),
        progress,
        review_sessions: after.review_sessions,
        max_review_sessions: after.max_review_sessions,
        no_progress_streak: after.no_progress_streak,
        budgets: lineageBudgets(after),
      },
      orchestration: { issued_epoch: open.epoch ?? null, settled_epoch: settledEpoch, barrier },
      settled_at: at,
      settled_by: by,
    };
    const file = join(this.paths.featureDir, 'reviews', `${open.review_id}.json`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeTextAtomic(file, JSON.stringify(receipt, null, 2) + '\n');
    const receiptSha = fileSha256(file);
    this.fault('review-receipt-written');
    // Each rework the review orders is bound to its revision 0, this receipt by hash (engine/review-revision.ts).
    for (const plan of prepared.plans) this.bindPlan(plan, { revision: 0, receipt_path: receiptPath, receipt_sha256: receiptSha });
    const usage = { ...zeroUsage(), sessions: 1, wall_clock_ms: Math.max(0, Date.now() - Date.parse(open.issued_at)) };
    mutateState(this.paths.featureDir, (s) => {
      if (s.acceptance_review?.open?.dispatch_id !== open.dispatch_id) throw new Error(`REVIEW_CHANGED: acceptance review ${open.review_id} changed while its verdict was settled; dispatch again.`);
      if ((s.acceptance_review.lineage?.head_sha256 ?? null) !== (state.acceptance_review?.lineage?.head_sha256 ?? null)) throw new Error(`REVIEW_CHANGED: the review lineage moved while ${open.review_id} was settled; dispatch again.`);
      if (outcome === 'PASS') {
        const now = this.reviewBarrier(s, new Set(), graph);
        if (now.leases.length > 0 || now.notDone.length > 0) throw new Error(`REVIEW_CHANGED: work started while ${open.review_id}'s PASS was settled (${[...now.leases, ...now.notDone].join(', ')}); dispatch again.`);
      }
      // The reworks and the record in this one write: a crash leaves either nothing (the verdict is settled again from its slot) or all of it.
      let next = s;
      for (const plan of prepared.plans) next = this.applyReworkPlan(next, plan, graph);
      const r = next.acceptance_review as AcceptanceReviewState;
      // The review settled: the epoch moves, in this write; a PASS binds the epoch it moved to.
      const epoch = bumpEpoch(next, `review ${open.review_id} settled ${outcome}`, [], at);
      if (epoch !== settledEpoch) throw new Error(`REVIEW_CHANGED: the orchestration epoch moved while ${open.review_id} was settled; dispatch again.`);
      r.reviews.push({
        review_id: open.review_id,
        dispatch_id: open.dispatch_id,
        capability_sha256: open.capability_sha256,
        review: open.review,
        overall: judged.overall,
        inputs_sha256: open.inputs_sha256,
        receipt_path: receiptPath,
        receipt_sha256: receiptSha,
        at,
        reworks,
        reworks_applied: reworks.length > 0 && missingReworks(next, open.review_id, reworks).length === 0,
        outcome,
        epoch,
        ...(barrier !== null ? { barrier } : {}),
        revision: 0,
        coverage_sha256: coverage.sha256,
      });
      r.open = null;
      r.lineage = chained.lineage;
      r.usage = addUsage(r.usage, usage);
      next.usage = addUsage(next.usage, usage);
      if (outcome === 'REVIEW_GAPS' || outcome === 'REVIEW_NONCONVERGENT') {
        r.blocked = { code: outcome, review_id: open.review_id, detail: (blockDetail as string).slice(0, 4000), at, ...(exhausted.length > 0 ? { criteria: exhausted } : {}) };
        next.feature_state = 'BLOCKED';
        next.blocked_reason = `${outcome}: ${(blockDetail as string).slice(0, 1000)}`;
      }
      return next;
    });
    for (const plan of prepared.plans) this.reworkMade(plan);
    this.event('review.settled', null, {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      overall: judged.overall,
      outcome,
      inputs_sha256: open.inputs_sha256,
      receipt_path: receiptPath,
      receipt_sha256: receiptSha,
      model: judged.verdict.reviewer.model.slice(0, 100),
      verdict_sha256: reviewer.verdict_sha256,
      canonical_verdict_sha256: judged.normalization.canonical_sha256,
      ...transportEvent(reviewer.transport),
      normalized: judged.normalization.changed.slice(0, 16).map((c) => ({ pointer: c.pointer, action: c.action, original_length: c.original_length, original_sha256: c.original_sha256 })),
      gaps: judged.gaps.map((g) => g.criterion),
      reworks,
      unowned: unowned.map((g) => g.criterion),
      refused: prepared.refused.map((r) => r.node_id),
      lineage: { head_sha256: chained.lineage.head_sha256, gaps: gapBodies.map((b) => (b.kind === 'gap' ? `${b.criterion}:${b.verdict}` : '')), progress },
      by,
    });
    removeReviewCheckouts(this.controlRoot, this.featureId, open.review_id, this.workspace);
    this.fault('review-recorded');
    const record = this.requiredReview()?.reviews.find((r) => r.dispatch_id === open.dispatch_id) as ReviewRecord;
    if (reworks.length > 0 && !record.reworks_applied) {
      throw new Error(`REVIEW_REWORK_INCOMPLETE: ${open.review_id} was recorded, but the rework records of ${missingReworks(this.state(), open.review_id, reworks).join(', ')} are not in STATE.json; run dispatch again: it finishes the reworks its receipt names.`);
    }
    return this.recordReport(record);
  }

  /**
   * Finish the reworks of a GAPS review recorded before they were made (a
   * STATE.json from before a review and its reworks were written together):
   * the receipt's targets, planned and made in one write; a rework already
   * made for this review counts. A refused rework blocks the feature (the
   * others are made all the same): no candidate on a gap.
   */
  private applyReviewReworks(reviewId: string): ReviewSettleReport {
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'deliver.lock'), () => this.applyReviewReworksLocked(reviewId), { timeoutMs: 15_000, pollMs: 50, purpose: 'acceptance review reworks' });
  }

  private applyReviewReworksLocked(reviewId: string): ReviewSettleReport {
    const state = this.state();
    const review = this.requiredReview(state) as AcceptanceReviewState;
    const record = review.reviews.find((r) => r.review_id === reviewId) as ReviewRecord;
    if (record.reworks_applied) return { ...this.recordReport(record), idempotent: true };
    const graph = this.graph();
    const block = (detail: string, plans: ReworkPlan[] = []): ReviewSettleReport => {
      const at = new Date().toISOString();
      mutateState(this.paths.featureDir, (s) => {
        let next = s;
        for (const plan of plans) next = this.applyReworkPlan(next, plan, graph);
        const r = next.acceptance_review;
        const rec = r?.reviews.find((x) => x.review_id === reviewId);
        if (!r || !rec) return next;
        rec.outcome = 'REVIEW_GAPS';
        rec.reworks_applied = rec.reworks.length > 0 && missingReworks(next, reviewId, rec.reworks).length === 0;
        r.blocked = { code: 'REVIEW_GAPS', review_id: reviewId, detail: detail.slice(0, 4000), at };
        next.feature_state = 'BLOCKED';
        next.blocked_reason = `REVIEW_GAPS: ${detail.slice(0, 1000)}`;
        return next;
      });
      for (const plan of plans) this.reworkMade(plan);
      this.event('review.blocked', null, { review_id: reviewId, detail: detail.slice(0, 500) });
      const now = this.requiredReview()?.reviews.find((r) => r.review_id === reviewId) as ReviewRecord;
      return { ...this.recordReport(now), detail, blocked: true, next: 'stop' };
    };
    const tampered = receiptProblem(this.controlRoot, record);
    if (tampered !== null) return block(`${reviewId}: ${tampered}`);
    const receipt = JSON.parse(readFileSync(join(this.controlRoot, ...record.receipt_path.split('/')), 'utf8')) as { gaps: Gap[]; reworks: { node_id: string; criteria: string[] }[] };
    const prepared = this.planGapReworks({ reviewId, review: record.review, receiptPath: record.receipt_path, budgets: this.budgetsOf(this.lineageSummary(state), receipt.gaps), targets: receipt.reworks, gaps: receipt.gaps, state, graph });
    for (const plan of prepared.plans) this.bindPlan(plan, currentRevision(record));
    if (prepared.refused.length > 0) {
      return block(this.unreworkableDetail(reviewId, { gaps: receipt.gaps, unowned: [], refused: prepared.refused, reworked: prepared.plans.map((p) => ({ node_id: p.nodeId, criteria: p.acceptance })), graph }), prepared.plans);
    }
    mutateState(this.paths.featureDir, (s) => {
      let next = s;
      for (const plan of prepared.plans) next = this.applyReworkPlan(next, plan, graph);
      const rec = next.acceptance_review?.reviews.find((x) => x.review_id === reviewId);
      if (rec) rec.reworks_applied = rec.reworks.length > 0 && missingReworks(next, reviewId, rec.reworks).length === 0;
      return next;
    });
    for (const plan of prepared.plans) this.reworkMade(plan);
    this.event('review.reworked', null, { review_id: reviewId, reworked: receipt.reworks.map((t) => t.node_id) });
    const now = this.requiredReview()?.reviews.find((r) => r.review_id === reviewId) as ReviewRecord;
    if (!now.reworks_applied) {
      throw new Error(`REVIEW_REWORK_INCOMPLETE: the rework records of ${missingReworks(this.state(), reviewId, now.reworks).join(', ')} for ${reviewId} are not in STATE.json after its reworks were made; this is a Mycelink fault: report it with features/${this.featureId}/STATE.json and events.jsonl.`);
    }
    return this.recordReport(now);
  }

  // ---- rework within the feature -------------------------------------------

  /**
   * Reopen a DONE producer node whose work a later check (fresh
   * verification, E2E, the candidate, delivery acceptance, the product's own
   * acceptance suite) found wrong, inside this same feature.
   *
   * Controller-authorized and recorded: a non-empty reason is required, and
   * a parked node anywhere in the cascade needs a recorded decision (which is
   * consumed). Everything is checked before anything changes, and refused
   * when unsafe: work still in flight, a stopped feature, a delivered base
   * branch that no longer holds the integration branch, the node's attempt
   * budget or rework limit spent. A delivered base someone committed on
   * after the delivery (a fast-forward of the integration branch) is
   * adopted: the integration branch moves to it and is recorded there, so
   * the repair starts from the base as it is now and its candidate delivers
   * by fast-forward again. Then, in one STATE.json write: the
   * node goes DONE -> INVALIDATED keeping its attempts and fingerprints (no
   * fresh budget) with the replaced work in its rework_history; every DONE
   * or parked dependent, and every candidate-build and E2E node, is
   * invalidated in dependency order; the current candidate stops being
   * current and the feature returns to RUNNING. Worker branches of reopened
   * nodes are archived, so each is dispatched again from the current
   * integration state and fenced to its own new delta. Repeating the same
   * rework before the node is DONE again changes nothing.
   */
  rework(nodeId: string, options: ReworkOptions): ReworkReport {
    // Never concurrently with a delivery of this feature (or a supersede).
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'deliver.lock'), () => this.reworkLocked(nodeId, options), {
      timeoutMs: 2_000,
      pollMs: 50,
      purpose: 'feature rework',
    });
  }

  private reworkLocked(nodeId: string, options: ReworkOptions): ReworkReport {
    const graph = this.graph();
    const planned = this.planRework(nodeId, options, this.state(), graph);
    if ('idempotent' in planned) return planned.idempotent;
    mutateState(this.paths.featureDir, (s) => this.applyReworkPlan(s, planned, graph));
    return this.reworkMade(planned);
  }

  /**
   * Everything a rework checks and prepares before it changes anything, on
   * `state`: refused (ReworkRefusedError) when unsafe or unjustified, the
   * report of the same rework already made when it is repeated, else the
   * plan applyReworkPlan carries out in a STATE.json write — alone, or with
   * the other reworks of an acceptance review in the write that records it.
   */
  private planRework(nodeId: string, options: ReworkOptions, state: FeatureState_, graph: PortfolioGraph): ReworkPlan | { idempotent: ReworkReport } {
    const decisionId = options.decisionId ?? null;
    if (options.reason.trim() === '') throw new ReworkRefusedError('REWORK_REASON_REQUIRED', `${nodeId}: say why the node's DONE work is wrong (--reason).`);
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Node "${nodeId}" is not in the graph.`);
    // The reason is handed to the node's next workers: bounded, redacted and
    // never carrying authority, or the rework is refused before anything changes.
    let reason: string;
    let acceptance: string[];
    let evidenceRefs: string[];
    try {
      reason = admitReworkReason(options.reason, this.controlRoot);
      // Exactly the criteria given (an acceptance review's gap), or those plus the ones the reason mentions.
      acceptance = reworkAcceptance(graph, options.exactAcceptance === true ? '' : reason, options.acceptance ?? []);
      evidenceRefs = reworkEvidence(options.evidence ?? []);
    } catch (err) {
      if (err instanceof ReworkBriefError) throw new ReworkRefusedError(err.code, `${nodeId}: ${err.message.slice(err.code.length + 2)}`);
      throw err;
    }
    if (node.repository === null || CONTROLLER_NODE_TYPES.has(node.node_type)) {
      throw new ReworkRefusedError(
        'REWORK_NOT_A_PRODUCER',
        `${nodeId} is a ${node.node_type} node; rework the producer node the failure is attributed to (controller nodes are re-run after it).`,
      );
    }
    const runtime = state.nodes[nodeId] as NodeRuntime;

    if (runtime.state !== 'DONE') {
      const last = runtime.rework_history?.[runtime.rework_history.length - 1];
      const record = [...(state.reworks ?? [])].reverse().find((r) => r.node_id === nodeId);
      if (
        last !== undefined &&
        record !== undefined &&
        last.reason === reason &&
        last.decision_id === decisionId &&
        runtime.integrated_sha === null &&
        !IN_FLIGHT_STATES.has(runtime.state)
      ) {
        // The same rework again (a retried command): finish what it started.
        // Marking the decision is idempotent by key, so a rework that died
        // after its STATE.json write still consumes it.
        if (record.decision_id !== null) markDecisionApplied(this.paths.events, this.featureId, record.decision_id, `node rework ${nodeId}`);
        return { idempotent: { feature_id: this.featureId, ...record, idempotent: true, archived_refs: this.plannedArchives(record.reopened) } };
      }
      throw new ReworkRefusedError(
        'REWORK_NOT_DONE',
        `${nodeId} is ${runtime.state}; only DONE work is reworked. A parked node is resumed with a recorded decision (decision apply), never by a rework.`,
      );
    }
    if (state.feature_state === 'CANCELLED' || state.feature_state === 'BUDGET_EXHAUSTED' || typeof state.superseded_by === 'string') {
      throw new ReworkRefusedError(
        'REWORK_FEATURE_STOPPED',
        `${this.featureId} is ${typeof state.superseded_by === 'string' ? `superseded by ${state.superseded_by}` : state.feature_state}.`,
      );
    }
    // The acceptance review blocked the feature: only a person's recorded decision repairs past it (and lifts the block).
    // A delivery refused for evidence no exact archive restores is administrative (engine/evidence-integrity.ts; the CSET-202
    // rerun): a product rework cannot repair a record, and its worker cannot honestly reproduce a historical RED on fixed code.
    const evidenceRepair = repairRequired(state);
    if (evidenceRepair !== null && evidenceRepair.nodes.includes(nodeId) && decisionId === null) {
      throw new ReworkRefusedError('REWORK_EVIDENCE_REPAIR', `${nodeId}'s evidence needs an administrative repair, not a product rework: ${repairRequiredDetail(this.featureId, evidenceRepair).slice(0, 900)}. Record a decision and pass --decision to rework it anyway.`);
    }
    const reviewBlock = state.acceptance_review?.blocked ?? null;
    if (reviewBlock !== null && decisionId === null) {
      throw new ReworkRefusedError('REWORK_REVIEW_BLOCKED', `the acceptance review blocked ${this.featureId} (${reviewBlock.code}: ${reviewBlock.detail.slice(0, 300)}); record a decision and pass --decision to rework past it.`);
    }
    const busy = Object.entries(state.nodes)
      .filter(([, rt]) => rt.claim !== null || IN_FLIGHT_STATES.has(rt.state))
      .map(([id, rt]) => `${id}=${rt.state}`);
    if (busy.length > 0) {
      throw new ReworkRefusedError('REWORK_IN_FLIGHT', `settle or reconcile the work in flight first: ${busy.join(', ')}.`);
    }
    this.assertReworkAllowed(nodeId, state, options.origin);
    // A rework a valid challenge closed, or a later revision of its review superseded, counts for nothing: generations number the reworks that stood.
    const reworked = (runtime.rework_history ?? []).filter(stoodRework).length;

    const cascade = this.reworkCascade(graph, nodeId);
    const parked = cascade.filter((id) => {
      const st = state.nodes[id]?.state;
      return st === 'BLOCKED' || st === 'NEEDS_DECISION' || st === 'BUDGET_EXHAUSTED';
    });
    if (parked.length > 0 && decisionId === null) {
      throw new ReworkRefusedError(
        'REWORK_PARKED',
        `${parked.join(', ')} ${parked.length === 1 ? 'is' : 'are'} parked; record a decision and pass --decision to reopen ${parked.length === 1 ? 'it' : 'them'} with the rework.`,
      );
    }
    const paused = cascade.filter((id) => state.nodes[id]?.state === 'PAUSED');
    if (paused.length > 0) throw new ReworkRefusedError('REWORK_PAUSED', `${paused.join(', ')} paused.`);
    if (decisionId !== null) assertDecisionUsable(this.paths.events, decisionId);

    const delivered = this.featureDelivered(state);
    let adopted: AdoptedBase[] = [];
    if (delivered) {
      const bases = this.deliveredBases(graph, state);
      if (bases.diverged.length > 0) {
        throw new ReworkRefusedError(
          'REWORK_BASE_MOVED',
          `the delivered base no longer holds the feature's integration branch in ${bases.diverged.join('; ')}; a replacement candidate could not fast-forward it. Reconcile those bases by hand first.`,
        );
      }
      adopted = bases.adopt;
    }

    // What the rework replaces, before anything changes.
    const at = new Date().toISOString();
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    const head = branchExists(repoPath, branch) ? resolveRef(repoPath, branch) : null;
    const settlement = runtime.last_settlement ?? null;
    const entry: ReworkHistoryEntry = {
      at,
      reason,
      decision_id: decisionId,
      attempts: runtime.attempts,
      failure_counts: { ...runtime.failure_counts },
      integrated_sha: runtime.integrated_sha,
      branch_head: head,
      archived_ref: head !== null ? this.archiveRefName(nodeId, head) : null,
      candidate_id: state.current_candidate,
      // Copies of what proved the replaced work: its next gates write the same file names (a carried proof is checked on them).
      evidence: this.archiveReplacedEvidence(nodeId, reworked + 1, runtime.evidence),
      // Everything else the replaced generation was settled with, bound to it and to the claim that settled it: none of it stays active.
      generation: reworked,
      claim_id: settlement?.claim_id ?? null,
      dispatch_id: settlement?.dispatch_id ?? null,
      criteria: structuredClone(runtime.criteria ?? []),
      tdd_history: this.archiveReplacedHistory(nodeId, reworked + 1, runtime.tdd_history ?? null),
      red_bindings: structuredClone(runtime.tdd_red_bindings ?? []),
      settlement: settlement === null ? null : structuredClone(settlement),
    };
    // An acceptance review's GAP is a hypothesis a passing reproduction may contradict: the DONE generation is kept whole,
    // for a valid challenge to restore (engine/review-challenge.ts).
    if (options.origin?.kind === 'acceptance-review') {
      entry.restore = {
        state: 'DONE',
        attempts: runtime.attempts,
        failure_counts: { ...runtime.failure_counts },
        last_failure_fingerprint: runtime.last_failure_fingerprint,
        integrated_sha: runtime.integrated_sha,
        branch_base_sha: runtime.branch_base_sha ?? null,
        evidence: structuredClone(runtime.evidence),
        criteria: structuredClone(runtime.criteria ?? []),
        tdd_history: entry.tdd_history ?? null,
        tdd_red_bindings: structuredClone(runtime.tdd_red_bindings ?? []),
        last_settlement: settlement === null ? null : structuredClone(settlement),
        carried_criterion_proofs: structuredClone(runtime.carried_criterion_proofs ?? []),
        worktree_setup: runtime.worktree_setup === undefined || runtime.worktree_setup === null ? null : structuredClone(runtime.worktree_setup),
      };
    }

    // What the node's next workers are told, bound to this rework by the reason's hash.
    const brief: ReworkBrief = {
      generation: reworked + 1,
      // A review rework is bounded by its criterion, not this: the brief never says a generation is past its limit.
      limit: options.origin?.kind === 'acceptance-review' ? Math.max(state.budget.max_same_failure, reworked + 1) : state.budget.max_same_failure,
      at,
      reason,
      reason_sha256: reasonSha256(reason),
      decision_id: decisionId,
      acceptance_criteria: acceptance,
      evidence: evidenceRefs,
      replaced: { integrated_sha: runtime.integrated_sha, candidate_id: state.current_candidate, archived_ref: entry.archived_ref },
      attempt_base: runtime.attempts,
      ...(options.origin !== undefined ? { origin: { ...options.origin } } : {}),
      // Compatibility criteria only: the code is in the generation's base, proved by a compatibility-regression unit, no RED.
      ...(acceptance.length > 0 && acceptance.every((ac) => criterionKind(graph, ac) === 'compatibility') ? { red_required: false as const } : {}),
      ...(options.reviewGaps !== undefined && options.reviewGaps.length > 0 ? { review_gaps: options.reviewGaps.map((g) => ({ ...g })) } : {}),
    };

    const carriedProofs = this.carriedProofs(graph, node, acceptance, entry, this.ledgerFor(nodeId, state), options.origin?.kind === 'acceptance-review');
    return { nodeId, reason, decisionId, acceptance, evidenceRefs, origin: options.origin, at, cascade, delivered, adopted, entry, brief, carriedProofs, reopened: [], candidate: null };
  }

  /**
   * What a rework's generation carries of the one it replaces: each new
   * behaviour of the node the rework does not name, as the replaced
   * generation settled it (its test, gate and output), bound to that
   * generation, its claim and dispatch, the commit integrated then, the
   * output's archived copy and the completion record it is
   * (engine/criterion-ledger.ts). Only a proof whose archived copy holds is
   * carried. A criterion the rework names is proved by the new generation's
   * own gates — but an acceptance review's gap of a criterion the replaced
   * generation completed keeps that completion, re-provable (`ordered`,
   * CSET-203 r16): the review's reproduction passing on the unchanged base
   * shows it holds there. Data, never an active gate (engine/criteria.ts);
   * revalidated on the claim's base before any worker runs.
   */
  private carriedProofs(graph: PortfolioGraph, node: GraphNode, acceptance: readonly string[], entry: ReworkHistoryEntry, ledger: readonly CriterionCompletion[], review: boolean): CarriedCriterionProof[] {
    return (node.acceptance_criteria ?? [])
      .filter((ac) => criterionKind(graph, ac) === 'new-behavior' && (review || !acceptance.includes(ac)))
      .flatMap((ac) => {
        const ordered = acceptance.includes(ac);
        const prior = (entry.criteria ?? []).find((c) => c.criterion === ac && c.test_id !== null && c.test !== null && c.reproof == null);
        const archived = prior === undefined ? undefined : entry.evidence[prior.gate];
        if (prior === undefined || archived === undefined || archived.output_sha256 !== prior.output_sha256 || !/\/replaced\/g\d+\//.test(archived.output_path)) return [];
        // The completion this proof is: the replaced generation's record of the criterion.
        const record = [...ledger].reverse().find((r) => r.criterion === ac && r.generation === (entry.generation ?? 0) && (entry.claim_id == null || r.claim_id === entry.claim_id)) ?? null;
        // A re-provable completion stands on a RED it ran (or carried): never on a proof no completion record holds.
        if (ordered && record === null) return [];
        return [
          {
            criterion: ac,
            test_id: prior.test_id as string,
            test: { ...(prior.test as { path: string; name: string }) },
            source_generation: entry.generation ?? 0,
            source_claim_id: entry.claim_id ?? null,
            source_dispatch_id: entry.dispatch_id ?? null,
            repo_sha: entry.integrated_sha,
            gate: prior.gate,
            output_sha256: prior.output_sha256,
            output_path: archived.output_path,
            ...(record !== null ? { record_id: record.record_id, record_sha256: record.sha256 } : {}),
            ...(ordered ? { ordered: true } : {}),
          },
        ];
      });
  }

  /** The replaced generation's judged history, copied beside its archived evidence (`replaced/g<generation>/`) byte for byte. */
  private archiveReplacedHistory(nodeId: string, generation: number, history: TddHistoryRecord | null): TddHistoryRecord | null {
    if (history === null) return null;
    const src = resolve(this.controlRoot, history.output_path);
    if (relativeInside(this.paths.featureDir, src) === null) return structuredClone(history);
    // Only exactly the bytes the record names are kept: a source another run overwrote is never archived as if it were.
    const dir = join(nodeEvidenceDir(this.controlRoot, this.featureId, nodeId), 'replaced', `g${generation}`);
    const copy = keepExactCopy(src, history.output_sha256, dir);
    const kept = copy === null ? history.output_path : (relativeInside(this.controlRoot, copy.file) ?? history.output_path);
    return { ...structuredClone(history), output_path: kept.replace(/\\/g, '/') };
  }

  /**
   * Carry a planned rework out on `s` (the body of a STATE.json write),
   * re-checking under the write that nothing started meanwhile: adopted
   * bases first, the node INVALIDATED with its history entry and brief, its
   * DONE or parked dependents and the controller nodes invalidated (a node
   * an earlier plan of the same write invalidated already is left as it
   * is), the candidate no longer current, the rework recorded. Fills in the
   * plan's `reopened` and `candidate`.
   */
  private applyReworkPlan(s: FeatureState_, plan: ReworkPlan, graph: PortfolioGraph): FeatureState_ {
    const { nodeId, reason, decisionId } = plan;
    // Re-checked under the lock: nothing may have started meanwhile.
    if (s.nodes[nodeId]?.state !== 'DONE') throw new ReworkRefusedError('REWORK_NOT_DONE', `${nodeId} changed while it was being reworked.`);
    if (typeof s.superseded_by === 'string') throw new ReworkRefusedError('REWORK_FEATURE_STOPPED', `${this.featureId} was superseded meanwhile.`);
    const started = Object.entries(s.nodes).find(([, rt]) => rt.claim !== null || IN_FLIGHT_STATES.has(rt.state));
    if (started) throw new ReworkRefusedError('REWORK_IN_FLIGHT', `${started[0]} started while the rework was prepared.`);
    // Each adopted base: the integration branch goes there first, then (in this same write) becomes where the
    // controller left it. Should the write not happen, the same rework again finds the branch at the base and records it.
    for (const a of plan.adopted) {
      fastForwardIntegration({ repoPath: repositoryPath(this.workspace, a.repository), featureId: this.featureId, from: a.from, to: a.to });
    }
    if (plan.adopted.length > 0) this.fault('rework-base-adopted');
    for (const a of plan.adopted) s.integration_heads = { ...(s.integration_heads ?? {}), [a.repository]: a.to };
    const reopened: string[] = [];
    // An acceptance review's rework is a hypothesis a valid challenge may withdraw: each DONE product dependent it
    // reopens is kept whole, so that challenge restores it with the node (CSET-203 r7: the cli stayed reopened).
    const dependents: Record<string, RestorableGeneration & { branch_head: string | null }> = {};
    let next = s;
    for (const id of plan.cascade) {
      const rt = next.nodes[id] as NodeRuntime;
      const root = id === nodeId;
      const from = rt.state;
      const dependentNode = graph.nodes.find((n) => n.id === id);
      if (!root && from === 'DONE' && plan.origin?.kind === 'acceptance-review' && dependentNode?.repository && !CONTROLLER_NODE_TYPES.has(dependentNode.node_type)) {
        const repoPath = repositoryPath(this.workspace, dependentNode.repository);
        const branch = workerBranchName(this.featureId, id);
        dependents[id] = {
          state: 'DONE',
          attempts: rt.attempts,
          failure_counts: { ...rt.failure_counts },
          last_failure_fingerprint: rt.last_failure_fingerprint,
          integrated_sha: rt.integrated_sha,
          branch_base_sha: rt.branch_base_sha ?? null,
          evidence: structuredClone(rt.evidence),
          criteria: structuredClone(rt.criteria ?? []),
          tdd_history: rt.tdd_history === undefined || rt.tdd_history === null ? null : structuredClone(rt.tdd_history),
          tdd_red_bindings: structuredClone(rt.tdd_red_bindings ?? []),
          last_settlement: rt.last_settlement === undefined || rt.last_settlement === null ? null : structuredClone(rt.last_settlement),
          carried_criterion_proofs: structuredClone(rt.carried_criterion_proofs ?? []),
          worktree_setup: rt.worktree_setup === undefined || rt.worktree_setup === null ? null : structuredClone(rt.worktree_setup),
          branch_head: branchExists(repoPath, branch) ? resolveRef(repoPath, branch) : null,
        };
      }
      if (root) {
        rt.rework_history = [...(rt.rework_history ?? []), plan.entry];
        next = applyNodeTransition(graph, next, id, 'INVALIDATED', { actor: this.owner, reason: `rework: ${reason}`, rework: true });
        const n = next.nodes[id] as NodeRuntime;
        n.rework_brief = plan.brief;
        // A new generation: nothing the replaced one was gated or settled with is active (it is in the history entry).
        n.criteria = [];
        n.tdd_history = null;
        n.tdd_red_bindings = [];
        n.last_settlement = null;
        n.carried_criterion_proofs = structuredClone(plan.carriedProofs);
      } else if (from === 'DONE') {
        next = applyNodeTransition(graph, next, id, 'INVALIDATED', { actor: this.owner, reason: `upstream ${nodeId} reworked: ${reason}`, inputChanged: true });
      } else if (from === 'BLOCKED' || from === 'NEEDS_DECISION' || from === 'BUDGET_EXHAUSTED') {
        // Its history stays with it: INVALIDATED from a parked state keeps
        // attempts and fingerprints (see transition.ts).
        next = applyNodeTransition(graph, next, id, 'INVALIDATED', {
          actor: this.owner,
          reason: `upstream ${nodeId} reworked: ${reason}`,
          decisionId: decisionId as string,
        });
      } else {
        continue; // PLANNED, READY or already INVALIDATED: nothing trusted to reopen.
      }
      reopened.push(id);
      const reopenedNode = graph.nodes.find((n) => n.id === id);
      if (reopenedNode?.repository && !CONTROLLER_NODE_TYPES.has(reopenedNode.node_type)) {
        const n = next.nodes[id] as NodeRuntime;
        n.fresh_branch_required = true;
        n.branch_base_sha = null;
      }
    }
    const candidate = next.current_candidate;
    next.current_candidate = null;
    if (['CANDIDATE_READY', 'E2E_RUNNING', 'VERIFIED', 'COMPLETED'].includes(next.feature_state)) next.feature_state = 'RUNNING';
    // A decided rework past an acceptance review's block lifts it; the next review judges the repair.
    if (decisionId !== null && next.acceptance_review?.blocked) {
      // The person's decision is a grant (engine/review-lineage.ts): one more accepted rework for each criterion the block
      // named exhausted, and the review-session and no-progress ceilings counted afresh from it.
      const lifted = next.acceptance_review.blocked;
      if (lifted.code !== 'REVIEW_LINEAGE_INVALID') {
        const criteria = lifted.criteria !== undefined && lifted.criteria.length > 0 ? lifted.criteria : ['*'];
        next.acceptance_review.lineage = appendLineage(this.lineageOf(next), criteria.map((criterion): LineageEventBody => ({ kind: 'grant', review_id: lifted.review_id, criterion, decision_id: decisionId })), plan.at).lineage;
      }
      next.acceptance_review.blocked = null;
      next.acceptance_review.open = null;
      if (next.feature_state === 'BLOCKED') next.feature_state = 'RUNNING';
      next.blocked_reason = null;
    }
    const record: ReworkRecord = { node_id: nodeId, reason, decision_id: decisionId, at: plan.at, reopened, invalidated_candidate: candidate, delivered: plan.delivered, ...(plan.adopted.length > 0 ? { adopted_bases: plan.adopted } : {}), ...(plan.origin !== undefined ? { origin: { ...plan.origin } } : {}) };
    next.reworks = [...(next.reworks ?? []), record];
    const kept = Object.fromEntries(Object.entries(dependents).filter(([id]) => reopened.includes(id)));
    if (Object.keys(kept).length > 0) {
      const history = (next.nodes[nodeId] as NodeRuntime).rework_history ?? [];
      const entry = history[history.length - 1];
      if (entry !== undefined) entry.restore_dependents = kept;
    }
    // What a review and a candidate bind changed: the epoch moves in this write, with the lineage of every node reopened.
    bumpEpoch(next, `rework ${nodeId}${plan.origin !== undefined ? ` (${plan.origin.review_id})` : ''}`, reopened);
    plan.reopened = reopened;
    plan.candidate = candidate;
    return next;
  }

  /** After a plan's write: its decision consumed, its event, and its report (the branches are archived by each reopened node's next claim). */
  private reworkMade(plan: ReworkPlan): ReworkReport {
    const { nodeId, reason, decisionId, brief, entry, reopened, candidate, adopted } = plan;
    if (decisionId !== null) markDecisionApplied(this.paths.events, this.featureId, decisionId, `node rework ${nodeId}`);
    this.event('node.reworked', nodeId, {
      reason: reason.slice(0, 500),
      reason_sha256: brief.reason_sha256,
      generation: brief.generation,
      limit: brief.limit,
      acceptance_criteria: plan.acceptance,
      evidence: plan.evidenceRefs,
      decision_id: decisionId,
      reopened,
      invalidated_candidate: candidate,
      delivered: plan.delivered,
      archived_ref: entry.archived_ref,
      ...(adopted.length > 0 ? { adopted_bases: adopted } : {}),
      ...(plan.origin !== undefined ? { origin: plan.origin } : {}),
    });
    // The branches are archived by the next claim of each node (under its
    // claim, so never racing a dispatch); report where they will go.
    return {
      feature_id: this.featureId,
      node_id: nodeId,
      reason,
      decision_id: decisionId,
      at: plan.at,
      reopened,
      invalidated_candidate: candidate,
      delivered: plan.delivered,
      ...(adopted.length > 0 ? { adopted_bases: adopted } : {}),
      idempotent: false,
      archived_refs: this.plannedArchives(reopened),
    };
  }

  /**
   * The evidence of work a rework replaces, kept with its history: each
   * output (and its results file) copied under the node's evidence as
   * `replaced/g<generation>/`, byte for byte, because the node's next gates
   * write the same file names. A criterion the rework does not name carries
   * its RED proof only while that copy still hashes as recorded.
   */
  private archiveReplacedEvidence(nodeId: string, generation: number, evidence: Partial<Record<EvidenceKind, EvidenceRecord>>): ReworkHistoryEntry['evidence'] {
    const dir = join(nodeEvidenceDir(this.controlRoot, this.featureId, nodeId), 'replaced', `g${generation}`);
    const out: ReworkHistoryEntry['evidence'] = {};
    for (const [kind, r] of Object.entries(evidence) as [EvidenceKind, EvidenceRecord][]) {
      let kept = r.output_path;
      // Each output (and its results) only exactly as its record names it: bytes another run wrote over it are never archived.
      for (const [rel, sha] of [[r.output_path, r.output_sha256], ...(r.results ? [[r.results.path, r.results.sha256]] : [])] as [string, string][]) {
        const src = resolve(this.controlRoot, rel);
        if (relativeInside(this.paths.featureDir, src) === null) continue;
        const copy = keepExactCopy(src, sha, dir);
        if (rel === r.output_path && copy !== null) kept = relativeInside(this.controlRoot, copy.file) ?? r.output_path;
      }
      out[kind] = { output_path: kept.replace(/\\/g, '/'), output_sha256: r.output_sha256, exit_code: r.exit_code, commit_sha: r.commit_sha };
    }
    return out;
  }

  /** The node, its transitive dependents in dependency order, then every other controller node. */
  private reworkCascade(graph: PortfolioGraph, nodeId: string): string[] {
    const dependents = new Map<string, string[]>();
    for (const n of graph.nodes) for (const dep of n.depends_on) dependents.set(dep, [...(dependents.get(dep) ?? []), n.id]);
    const reach = new Set<string>([nodeId]);
    const queue = [nodeId];
    while (queue.length > 0) {
      for (const next of dependents.get(queue.shift() as string) ?? []) {
        if (!reach.has(next)) {
          reach.add(next);
          queue.push(next);
        }
      }
    }
    // The candidate binds the whole portfolio, so every candidate build and
    // E2E run is stale once any producer is reworked.
    for (const n of graph.nodes) if (CONTROLLER_NODE_TYPES.has(n.node_type)) reach.add(n.id);
    // Graph declaration order is a topological order of a validated graph
    // only by convention; order by dependency depth instead.
    const depth = new Map<string, number>();
    const depthOf = (id: string): number => {
      const known = depth.get(id);
      if (known !== undefined) return known;
      const n = graph.nodes.find((x) => x.id === id);
      const d = n === undefined || n.depends_on.length === 0 ? 0 : 1 + Math.max(...n.depends_on.map(depthOf));
      depth.set(id, d);
      return d;
    };
    const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
    return [...reach].sort((a, b) =>
      a === nodeId ? -1 : b === nodeId ? 1 : depthOf(a) - depthOf(b) || (index.get(a) ?? 0) - (index.get(b) ?? 0),
    );
  }

  /**
   * REWORK_LIMIT: the node's reworks since the feature's last accepted
   * delivery (all of them before one) may not reach max_same_failure. An
   * accepted delivery passed acceptance on exactly what it delivered, so a
   * failure reported after it is a new one; the reworks before it still
   * stand in the node's history and brief generations.
   */
  private assertReworkAllowed(nodeId: string, state: FeatureState_, origin?: ReworkOrigin): void {
    // A rework a valid challenge closed counts for nothing (engine/review-challenge.ts). An acceptance review's rework is
    // bounded by its criterion's own budget and the review's ceilings (engine/review-lineage.ts; CSET-203 r11: the cli's
    // third review rework, for AC-3's second gap, was what r11 needed): the node's other review reworks do not count against it.
    const review = origin?.kind === 'acceptance-review';
    const history = (state.nodes[nodeId]?.rework_history ?? []).filter((e) => stoodRework(e) && !(review && (e.restore ?? null) !== null));
    const since = this.lastAcceptedAt(state);
    const counted = since === null ? history.length : history.filter((e) => e.at > since).length;
    if (counted >= state.budget.max_same_failure) {
      throw new ReworkRefusedError(
        'REWORK_LIMIT',
        `${nodeId} was already reworked ${counted} time(s)${since === null ? '' : ' since the last accepted delivery'}, the limit (max_same_failure ${state.budget.max_same_failure}); report it instead.`,
      );
    }
  }

  /**
   * When the feature's latest accepted delivery was accepted, or null: the
   * accepted_at of each delivery manifest that is byte for byte the one
   * acceptance pinned in STATE.json. Any other manifest counts for nothing.
   */
  private lastAcceptedAt(state: FeatureState_): string | null {
    let last: string | null = null;
    for (const [candidate, sha] of Object.entries(state.accepted_deliveries ?? {})) {
      if (!/^[A-Za-z0-9._-]+$/.test(candidate)) continue;
      const file = join(this.paths.featureDir, 'deliveries', `${candidate}.json`);
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      if (createHash('sha256').update(bytes).digest('hex') !== sha) continue;
      let at: unknown;
      try {
        at = (JSON.parse(bytes.toString('utf8')) as { accepted_at?: unknown }).accepted_at;
      } catch {
        continue;
      }
      if (typeof at === 'string' && (last === null || at > last)) last = at;
    }
    return last;
  }

  /**
   * QA's report on a delivered feature, attributed and reworked in one
   * controller step (`feature rework`). The targets are the producer nodes
   * owning the given paths and, with `sinceDelivery`, what changed on a
   * delivered base since the delivery; failing those, the single producer
   * of the named acceptance criteria. Several owners are reworked
   * dependents first, so each keeps the report as its own brief. Refused,
   * changing nothing, when no producer owns the report, when acceptance
   * criteria alone name more than one, or when any target cannot be
   * reworked. Repeating it once the reworks are recorded changes nothing.
   */
  reworkOwners(options: { reason: string; paths: string[]; acceptance: string[]; sinceDelivery: boolean }): FeatureReworkReport {
    if (options.reason.trim() === '') throw new ReworkRefusedError('REWORK_REASON_REQUIRED', `${this.featureId}: give QA's report as the reason (--reason).`);
    let reason: string;
    try {
      reason = admitReworkReason(options.reason, this.controlRoot);
    } catch (err) {
      if (err instanceof ReworkBriefError) throw new ReworkRefusedError(err.code, `${this.featureId}: ${err.message.slice(err.code.length + 2)}`);
      throw err;
    }
    const owners = this.owners({ paths: options.paths, acceptance: options.acceptance, sinceDelivery: options.sinceDelivery });
    const byPath = owners.owners.filter((o) => o.paths.length > 0);
    const byAcceptance = owners.owners.filter((o) => o.acceptance.length > 0);
    const state = this.state();
    let chosen = byPath.length > 0 ? byPath : byAcceptance.length === 1 ? byAcceptance : [];
    let by: FeatureReworkReport['attribution']['by'] = byPath.length > 0 ? 'paths' : 'acceptance';
    if (chosen.length === 0) {
      // The same report, already reworked: nothing moved since (the rework adopted the base), its nodes wait.
      const pending = [...new Set((state.reworks ?? []).filter((r) => r.reason === reason && state.nodes[r.node_id]?.state !== 'DONE').map((r) => r.node_id))];
      if (pending.length > 0) {
        const reworks = pending.map((id) => this.rework(id, { reason, acceptance: [], evidence: [] }));
        return { feature_id: this.featureId, attribution: { by: 'pending', paths: [], acceptance: options.acceptance }, targets: pending, reworks, idempotent: reworks.every((r) => r.idempotent), owners };
      }
      if (byAcceptance.length > 1) {
        throw new ReworkRefusedError(
          'REWORK_OWNER_AMBIGUOUS',
          `${options.acceptance.join(', ')} ${options.acceptance.length === 1 ? 'is' : 'are'} owned by ${byAcceptance.map((o) => o.node_id).join(', ')} and no reported path decides between them; rework the producer that owns the failing behaviour with \`node rework\`.`,
        );
      }
      throw new ReworkRefusedError(
        'REWORK_OWNER_UNKNOWN',
        `no producer node owns ${owners.unowned.length > 0 ? owners.unowned.join(', ') : 'what the report names'}; name the paths or acceptance criteria the failing checks exercise.`,
      );
    }
    const graph = this.graph();
    // Dependents first: a dependent's cascade is inside its upstream's, so it is shorter.
    const reach = new Map(chosen.map((o) => [o.node_id, o.reopens.length]));
    const order = graph.nodes.map((n) => n.id);
    chosen = [...chosen].sort((a, b) => (reach.get(a.node_id) ?? 0) - (reach.get(b.node_id) ?? 0) || order.indexOf(a.node_id) - order.indexOf(b.node_id));
    // Every target either waits for this same rework already or can be reworked now; otherwise nothing changes.
    for (const o of chosen) {
      const rt = state.nodes[o.node_id];
      const last = rt?.rework_history?.at(-1);
      if (rt?.state === 'DONE') this.assertReworkAllowed(o.node_id, state);
      else if (last?.reason !== reason) {
        throw new ReworkRefusedError('REWORK_NOT_DONE', `${o.node_id} is ${rt?.state ?? 'unknown'}; only DONE work is reworked.`);
      }
    }
    const reworks = chosen.map((o) => this.rework(o.node_id, { reason, acceptance: o.acceptance, evidence: [] }));
    const paths = [...new Set(chosen.flatMap((o) => o.paths))];
    if (by === 'paths' && paths.length === 0) by = 'acceptance';
    return {
      feature_id: this.featureId,
      attribution: { by, paths, acceptance: options.acceptance },
      targets: chosen.map((o) => o.node_id),
      reworks,
      idempotent: reworks.every((r) => r.idempotent),
      owners,
    };
  }

  /** Whether any delivery of this feature moved (or tried to move) its base branches. */
  private featureDelivered(state: FeatureState_): boolean {
    if (Object.keys(state.accepted_deliveries ?? {}).length > 0) return true;
    const dir = join(this.paths.featureDir, 'deliveries');
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'));
  }

  /**
   * How each delivered base branch stands to this feature's integration
   * branch: `adopt` the bases someone committed on after the delivery (the
   * integration branch, exactly where the controller left it, is an
   * ancestor of the base: everything delivered is still there), `diverged`
   * the ones that no longer hold it. An integration branch already at its
   * base's tip, ahead of where the controller left it, is an adoption a crash
   * cut short before it was recorded. Any other moved integration branch is
   * refused (INTEGRATION_BRANCH_MOVED).
   */
  private deliveredBases(graph: PortfolioGraph, state: FeatureState_): { adopt: AdoptedBase[]; diverged: string[] } {
    const branch = integrationBranchName(this.featureId);
    const adopt: AdoptedBase[] = [];
    const diverged: string[] = [];
    for (const repo of this.workspace.repositories.repositories) {
      const path = repositoryPath(this.workspace, repo.name);
      if (!branchExists(path, branch) || !branchExists(path, repo.base_branch)) continue;
      const base = resolveRef(path, repo.base_branch);
      const integration = resolveRef(path, branch);
      const expected = expectedIntegrationHead(this.workspace, repo.name, { graph, state });
      const adoption = { repository: repo.name, base_branch: repo.base_branch, from: expected, to: base };
      if (isAncestor(path, base, integration)) {
        if (integration === base && integration !== expected && isAncestor(path, expected, integration)) adopt.push(adoption);
        continue;
      }
      if (!isAncestor(path, integration, base)) {
        diverged.push(`${repo.name} (${repo.base_branch} at ${base.slice(0, 12)})`);
        continue;
      }
      if (integration !== expected) throw new IntegrationBranchMovedError(repo.name, branch, integration, expected);
      adopt.push(adoption);
    }
    return { adopt, diverged };
  }

  /** The archive refs the reopened worker nodes' current branches go to on their next claim. */
  private plannedArchives(nodeIds: string[]): string[] {
    const out: string[] = [];
    for (const id of nodeIds) {
      const node = this.node(id);
      if (node.repository === null || CONTROLLER_NODE_TYPES.has(node.node_type)) continue;
      const repoPath = repositoryPath(this.workspace, node.repository);
      const branch = workerBranchName(this.featureId, id);
      if (branchExists(repoPath, branch)) out.push(this.archiveRefName(id, resolveRef(repoPath, branch)));
    }
    return out;
  }

  private archiveRefName(nodeId: string, head: string): string {
    const suffix = workerBranchName(this.featureId, nodeId).slice(`wip/${this.featureId}/`.length);
    return `refs/mycelink/archive/${this.featureId}/${suffix}/${head}`;
  }

  /**
   * Keep a reopened node's old branch under an archive ref and delete the
   * branch (and any worktree on it), so its next claim starts afresh from
   * the integration head. Idempotent; returns the archive ref, or null when
   * there was no branch.
   */
  private archiveWorkerBranch(nodeId: string): string | null {
    const node = this.node(nodeId);
    if (node.repository === null || this.state().nodes[nodeId]?.fresh_branch_required !== true) return null;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    if (!branchExists(repoPath, branch)) return null;
    const head = resolveRef(repoPath, branch);
    const ref = this.archiveRefName(nodeId, head);
    runGit(repoPath, ['update-ref', ref, head]);
    // The branch's worktree goes: what it left in the shared stash is archived first (git/stash.ts).
    this.quarantineWorkerStash(nodeId);
    const expected = resolve(join(this.workspace.paths.worktreesDir, worktreeDirName(node.repository, nodeId)));
    for (const w of listWorktrees(repoPath)) {
      if (w.branch === branch || resolve(w.path) === expected) removeWorkerWorktree(repoPath, w.path);
    }
    // Compare-and-swap: only the branch head that was archived is deleted.
    runGit(repoPath, ['update-ref', '-d', `refs/heads/${branch}`, head]);
    return ref;
  }

  /**
   * Discard a dispatch the controller reached into (a controller write the
   * benchmark's monitor, or an operator, found in a worker's worktree,
   * result slot or evidence): nothing it holds is trusted, however its
   * hashes look. The claim is handed back unspent, as an interruption; its
   * worktree (and result slot) removed and its branch archived; its gate
   * evidence, RED bindings and history forgotten; and the node's next claim
   * starts a fresh branch from the integration head, so the next worker is
   * a genuine one. Presented with the claim's current capability: its
   * holder may always give it up. A claim that reached INTEGRATED is
   * refused: discarding never undoes an integration.
   */
  discard(nodeId: string, capability: string | undefined, reason: string): { node_id: string; discarded: true; claim_id: string; worktree: string | null; archived_ref: string | null; state: NodeState; reason: string; stash?: StashQuarantine } {
    const graph = this.graph();
    const before = this.state().nodes[nodeId];
    assertClaimCapability(nodeId, before, capability);
    const claim = (before as NodeRuntime).claim as NodeClaim;
    if (claim.settling && settlerAlive(claim.settling)) throw new SettleInProgressError(nodeId, claim.settling);
    if ((before as NodeRuntime).state === 'INTEGRATED' || (before as NodeRuntime).state === 'DONE') {
      throw new Error(`DISCARD_AFTER_INTEGRATION: ${nodeId} is ${(before as NodeRuntime).state}: its work is integrated, and discarding never undoes that; rework it instead.`);
    }
    const why = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) || 'discarded';
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (rt?.claim?.claim_id === claim.claim_id) rt.fresh_branch_required = true;
      return s;
    });
    // What its worktree set aside in the shared stash is archived with its branch, never left live.
    const stash = this.quarantineWorkerStash(nodeId);
    const archived = this.archiveWorkerBranch(nodeId);
    if (claim.worktree !== null && existsSync(claim.worktree) && this.node(nodeId).repository !== null) {
      removeWorkerWorktree(repositoryPath(this.workspace, this.node(nodeId).repository as string), claim.worktree);
    }
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (!rt?.claim || rt.claim.claim_id !== claim.claim_id) throw new CapabilityError('NOT_CLAIMED', `${nodeId}'s claim changed while it was being discarded.`);
      // Nothing it holds is trusted: its lease is revoked, and anything it answers later is stale.
      closeLeases(s, (l) => l.node_id === nodeId && l.claim_id === claim.claim_id, 'revoked', `discarded: ${why}`);
      rt.evidence = {};
      rt.tdd_red_bindings = [];
      rt.tdd_history = null;
      rt.branch_base_sha = null;
      rt.fresh_branch_required = true;
      return applyNodeTransition(graph, s, nodeId, 'READY', { actor: this.owner, reason: `DISCARDED: ${why}`, refundAttempt: true });
    });
    releaseAllForNode(this.paths.featureDir, nodeId);
    this.event('node.discarded', nodeId, { claim_id: claim.claim_id, dispatch_id: claim.dispatch_id ?? null, reason: why, archived_ref: archived, worktree: claim.worktree });
    return { node_id: nodeId, discarded: true, claim_id: claim.claim_id, worktree: claim.worktree, archived_ref: archived, state: this.state().nodes[nodeId]?.state ?? 'READY', reason: why, ...(stash !== null ? { stash } : {}) };
  }

  /**
   * Invalidate a node and everything that transitively depends on it.
   *
   * A downstream node's evidence was produced against the old upstream, so
   * leaving it DONE would let a stale candidate look verified.
   */
  invalidateWithDependents(nodeId: string, reason: string, justification: { decisionId?: string } = {}): string[] {
    const graph = this.graph();
    const dependents = new Map<string, string[]>();
    for (const node of graph.nodes) {
      for (const dep of node.depends_on) {
        dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
      }
    }

    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      order.push(current);
      for (const next of dependents.get(current) ?? []) queue.push(next);
    }

    const invalidated: string[] = [];
    for (const id of order) {
      const root = id === nodeId;
      try {
        this.transition(id, 'INVALIDATED', {
          reason: root ? reason : `upstream ${nodeId} was invalidated: ${reason}`,
          // The root needs the caller's recorded decision to leave a parked
          // state; a dependent's input genuinely changed because of the root.
          ...(root ? (justification.decisionId ? { decisionId: justification.decisionId } : {}) : { inputChanged: true }),
        });
        invalidated.push(id);
      } catch (err) {
        // A parked root without a justification is the caller's error, never
        // something to skip silently. Dependents already past reach are left.
        if (root && err instanceof TransitionError && err.code === 'UNBLOCK_REQUIRES_JUSTIFICATION') throw err;
      }
    }
    if (invalidated.length > 0) {
      this.event('node.invalidated', nodeId, { cascade: invalidated, reason });
    }
    return invalidated;
  }

  /** Every registered repository on this feature's integration branch, created at its base where missing. */
  private integrationRefs(): { name: string; path: string; branch: string }[] {
    return portfolioRefs(this.workspace, this.featureId, { create: true, trust: { graph: this.graph(), state: this.state() } });
  }

  /**
   * Run the E2E scenarios for the current candidate under a capacity-1
   * runtime lease, and back-propagate any failure to the suspect nodes.
   */
  private async runE2ENode(nodeId: string): Promise<NodeRunReport> {
    const evidence: EvidenceRecord[] = [];
    const node = this.node(nodeId);
    try {
      this.claim(nodeId, { mode: 'controller' });
      const state = this.state();
      const candidateId = state.current_candidate;
      if (candidateId === null) {
        return this.failAttempt(nodeId, null, 'NO_CANDIDATE', evidence);
      }
      const candidate = loadCandidate(this.paths.featureDir, candidateId);
      const scenarios = loadScenarios(this.paths.scenariosDir).filter(
        (s) => node.e2e_scenario === undefined || s.id === node.e2e_scenario,
      );
      if (scenarios.length === 0) {
        return this.failAttempt(nodeId, null, 'NO_E2E_SCENARIOS', evidence);
      }

      mutateState(this.paths.featureDir, (s) => {
        s.feature_state = 'E2E_RUNNING';
        return s;
      });

      const graph = this.graph();
      // An e2e node declares its runtime steps as named verifiers, so the
      // deploy/healthcheck/fixture-reset sequence is part of the graph rather
      // than hidden in a flag.
      const named = (id: string): string[] | undefined => {
        const verifier = node.verification_commands.find((v) => v.id === id);
        if (verifier?.shell) {
          // Runtime steps are argv-only; never reinterpret a script string.
          throw new CommandPolicyError(
            'SHELL_NOT_ALLOWED',
            `E2E runtime step "${id}" of ${node.id} declares shell: true; runtime steps must be argv arrays`,
          );
        }
        return verifier?.command;
      };

      const result = await runE2E({
        featureDir: this.paths.featureDir,
        evidenceRoot: join(this.paths.evidenceDir, 'e2e'),
        graph,
        candidate,
        scenarios,
        ...(named('deploy') ? { deployCommand: named('deploy') as string[] } : {}),
        ...(named('healthcheck') ? { healthcheckCommand: named('healthcheck') as string[] } : {}),
        ...(named('fixture-reset')
          ? { fixtureResetCommand: named('fixture-reset') as string[] }
          : {}),
        // The node already holds this feature's resource leases through its
        // claim, so the runner must not try to take them a second time.
        resources: Object.fromEntries(
          Object.entries(graph.resources).filter(
            ([name]) => !node.required_resources.includes(name),
          ),
        ),
        cwd: this.controlRoot,
        pathBase: this.controlRoot,
      });

      for (const scenarioResult of result.results) {
        for (const record of scenarioResult.evidence) evidence.push(record);
      }
      const last = evidence[evidence.length - 1];
      if (last) this.setEvidence(nodeId, { ...last, kind: 'e2e', node_id: nodeId });

      if (!result.passed) {
        const invalidated = new Set<string>();
        for (const scenarioResult of result.results) {
          if (scenarioResult.passed || !scenarioResult.attribution) continue;
          for (const suspect of scenarioResult.attribution.nodes) {
            if (suspect === nodeId) continue;
            for (const id of this.invalidateWithDependents(
              suspect,
              `E2E ${scenarioResult.scenario_id} failed; attributed by ${scenarioResult.attribution.strategy}`,
            )) {
              invalidated.add(id);
            }
          }
        }
        this.event('e2e.failed', nodeId, {
          candidate: candidateId,
          invalidated: [...invalidated],
        });
        const detail =
          result.preflight_failure ??
          `E2E failed; invalidated ${[...invalidated].join(', ') || '(nothing)'}`;
        return this.failAttempt(nodeId, null, detail, evidence);
      }

      this.advanceVerifiedGates(nodeId);
      this.transition(nodeId, 'INTEGRATED');
      this.transition(nodeId, 'DONE');
      this.releaseClaim(nodeId);
      mutateState(this.paths.featureDir, (s) => {
        s.feature_state = 'VERIFIED';
        return s;
      });
      return this.report(nodeId, 'DONE', null, `E2E passed on ${candidateId}`, evidence);
    } catch (err) {
      return this.failAttempt(
        nodeId,
        null,
        err instanceof Error ? err.message : String(err),
        evidence,
      );
    }
  }

  /**
   * Walk the node through the verified gates its required_evidence declares.
   * Each step is still checked by the transition engine against the evidence
   * actually recorded; this only drives the order.
   */
  private advanceVerifiedGates(nodeId: string): void {
    const node = this.node(nodeId);
    const required = new Set<EvidenceKind>(node.required_evidence);
    const order: { state: NodeState; needs?: EvidenceKind; pending?: NodeState }[] = [
      { state: 'RED_VERIFIED', needs: 'red', pending: 'RED_PENDING' },
      { state: 'GREEN_VERIFIED', needs: 'green', pending: 'GREEN_PENDING' },
      { state: 'REFACTOR_VERIFIED', needs: 'refactor' },
      { state: 'REGRESSION_VERIFIED', needs: 'regression' },
      { state: 'REVIEW_VERIFIED' },
    ];
    // Forward only: a node already at or past a gate is never moved back to
    // re-enter it (a verified state may return to RED_PENDING for a new RED
    // cycle, but settle never starts one).
    const rank = (s: NodeState | undefined): number =>
      s === undefined ? -1 : ['CLAIMED', 'RED_PENDING', 'RED_VERIFIED', 'GREEN_PENDING', 'GREEN_VERIFIED', 'REFACTOR_VERIFIED', 'REGRESSION_VERIFIED', 'REVIEW_VERIFIED'].indexOf(s);
    for (const step of order) {
      if (step.needs !== undefined && !required.has(step.needs)) continue;
      // A generation that needs no RED of its own (compatibility work alone) never passes through RED_VERIFIED.
      if (step.needs === 'red' && !redRequired(node, this.state().nodes[nodeId] ?? {})) continue;
      const current = this.state().nodes[nodeId]?.state;
      if (current === step.state || rank(current) >= rank(step.state)) continue;
      try {
        if (step.pending && current !== step.pending) this.transition(nodeId, step.pending);
        this.transition(nodeId, step.state);
      } catch (err) {
        if (err instanceof TransitionError && err.code === 'ILLEGAL_TRANSITION') continue;
        throw err;
      }
    }
    const current = this.state().nodes[nodeId]?.state;
    if (current !== 'REVIEW_VERIFIED') {
      this.transition(nodeId, 'REVIEW_VERIFIED');
    }
  }

  private recordDecisionRequest(nodeId: string, result: NodeResult): string | null {
    const request = result.decision_request;
    if (!request) return null;
    const id = `DEC-${createHash('sha256').update(request.question).digest('hex').slice(0, 8)}`;
    const entry =
      `\n## ${id} (${request.category ?? 'uncategorised'})\n\n` +
      `- Node: \`${nodeId}\`\n` +
      `- Status: PENDING\n` +
      `- Question: ${request.question}\n` +
      request.options.map((o) => `  - [ ] ${o}\n`).join('') +
      `\n`;
    const existing = existsSync(this.paths.decisions)
      ? readFileSync(this.paths.decisions, 'utf8')
      : `# Decisions for ${this.featureId}\n`;
    // Deduplicate: the same question from several workers is one decision.
    if (!existing.includes(id)) {
      writeTextAtomic(this.paths.decisions, existing + entry);
    }
    mutateState(this.paths.featureDir, (s) => {
      if (!s.pending_decisions.includes(id)) s.pending_decisions.push(id);
      return s;
    });
    this.event('decision.requested', nodeId, { decision_id: id, category: request.category ?? null });
    return id;
  }

  private failAttempt(
    nodeId: string,
    sessionId: string | null,
    fingerprint: string,
    evidence: EvidenceRecord[],
  ): NodeRunReport {
    const graph = this.graph();
    mutateState(this.paths.featureDir, (s) =>
      recordFailure(graph, s, nodeId, fingerprint, { actor: this.owner }),
    );
    const after = this.state().nodes[nodeId];
    if (after && after.state !== 'BLOCKED') {
      // Return the node to the pool for a bounded retry.
      try {
        this.transition(nodeId, 'READY');
      } catch {
        // Already in a state that cannot go back to READY; leave it.
      }
    }
    this.releaseClaim(nodeId);
    const state = this.state().nodes[nodeId]?.state ?? 'BLOCKED';
    return {
      node_id: nodeId,
      outcome: state === 'BLOCKED' ? 'BLOCKED' : 'RETRY',
      session_id: sessionId,
      state,
      detail: fingerprint,
      evidence,
    };
  }

  private report(
    nodeId: string,
    outcome: NodeRunReport['outcome'],
    sessionId: string | null,
    detail: string,
    evidence: EvidenceRecord[],
  ): NodeRunReport {
    return {
      node_id: nodeId,
      outcome,
      session_id: sessionId,
      state: this.state().nodes[nodeId]?.state ?? 'PLANNED',
      detail,
      evidence,
    };
  }

  // ---- cycles -----------------------------------------------------------

  async runOnce(): Promise<CycleReport> {
    const plan = this.plan();
    const reports: NodeRunReport[] = [];
    for (const scheduled of plan.scheduled) {
      const report = await this.runNode(scheduled.node_id);
      reports.push(report);
      // The adapter is down for everyone; do not burn through the batch.
      if (report.outcome === 'INFRASTRUCTURE_FAILURE') break;
    }
    return {
      scheduled: plan.scheduled.map((s) => s.node_id),
      deferred: plan.deferred.map((d) => ({ node_id: d.node_id, reason: d.reason })),
      reports,
    };
  }

  async runToCompletion(options: { maxCycles?: number } = {}): Promise<FeatureRunReport> {
    const maxCycles = options.maxCycles ?? 50;
    const all: NodeRunReport[] = [];
    let cycles = 0;

    for (; cycles < maxCycles; cycles++) {
      const state = this.state();
      if (cycles === 0 && this.preflight !== undefined && !this.adapterReady().ok) {
        return this.finish(0, 'ADAPTER_UNAVAILABLE', all);
      }
      if (state.feature_state === 'BUDGET_EXHAUSTED') {
        return this.finish(cycles, 'BUDGET_EXHAUSTED', all);
      }
      const nodes = Object.values(state.nodes);
      if (nodes.every((n) => n.state === 'DONE' || n.state === 'EXCLUDED')) {
        return this.finish(cycles, this.reviewPassed(state) ? 'ALL_SETTLED' : 'REVIEW_REQUIRED', all);
      }
      if (nodes.some((n) => n.state === 'NEEDS_DECISION')) {
        return this.finish(cycles, 'NEEDS_DECISION', all);
      }

      const cycle = await this.runOnce();
      all.push(...cycle.reports);
      if (cycle.reports.some((r) => r.outcome === 'INFRASTRUCTURE_FAILURE')) {
        return this.finish(cycles + 1, 'ADAPTER_UNAVAILABLE', all);
      }

      if (cycle.scheduled.length === 0) {
        const after = this.state();
        const blocked = Object.values(after.nodes).some(
          (n) => n.state === 'BLOCKED' || n.state === 'BUDGET_EXHAUSTED',
        );
        if (Object.values(after.nodes).every((n) => n.state === 'DONE' || n.state === 'EXCLUDED')) {
          return this.finish(cycles + 1, this.reviewPassed(after) ? 'ALL_SETTLED' : 'REVIEW_REQUIRED', all);
        }
        // The acceptance review is a plugin subagent run through dispatch; this loop never cuts a candidate before it.
        if (this.requiredReview(after) !== null && this.reviewable(after) && !this.reviewPassed(after)) return this.finish(cycles + 1, 'REVIEW_REQUIRED', all);
        return this.finish(cycles + 1, blocked ? 'BLOCKED' : 'NO_PROGRESS', all);
      }
    }
    return this.finish(cycles, 'MAX_CYCLES', all);
  }

  private finish(
    cycles: number,
    reason: FeatureRunReport['stop_reason'],
    reports: NodeRunReport[],
  ): FeatureRunReport {
    if (reason === 'ALL_SETTLED') this.promoteSettledFeature();
    this.event('feature.cycle_stopped', null, { reason, cycles });
    return {
      cycles,
      stop_reason: reason,
      reports,
      feature_state: this.state().feature_state,
      ...(this.preflightResult !== null ? { adapter: this.preflightResult } : {}),
    };
  }

  // ---- model-provider interruptions (CSET-203 r10) ------------------------

  /** The host session that most recently ran `dispatch` here, as the plugin's fence bound it (hooks/provider-binding.ts). */
  private hostBinding(): HostSessionBinding | null {
    try {
      return currentHostBinding(this.controlRoot);
    } catch {
      return null;
    }
  }

  /**
   * The active leases whose holder ended on a failure after it was issued
   * (engine/provider-interrupt.ts): the transient ones to interrupt, the
   * others kept. A lease with something to settle (a result in its slot, a
   * captured or sealed result, a verdict) is the settle's; a claim held for
   * its evidence correction or its challenge is re-issued as it always was;
   * a controller run is this process's own. Reads; changes nothing.
   */
  private providerFindings(state: FeatureState_ = this.state()): { failed: { lease: DispatchLease; holder: HolderFailure }[]; kept: ProviderInterruptReport['kept'] } {
    const failed: { lease: DispatchLease; holder: HolderFailure }[] = [];
    const kept: ProviderInterruptReport['kept'] = [];
    const open = state.acceptance_review?.open ?? null;
    for (const l of activeLeases(state)) {
      let launches: string[] = [];
      let host = l.host ?? null;
      if (l.kind === 'review') {
        if (open === null || open.dispatch_id !== l.dispatch_id || (open.provider_interrupted ?? null) !== null || this.verdictPresent(open)) continue;
        const safe = safeGenerationDir(this.controlRoot, open);
        launches = safe.ok ? launchFiles(safe.dir) : [];
        host = host ?? open.host_session ?? null;
      } else {
        const c = l.node_id !== null ? (state.nodes[l.node_id]?.claim ?? null) : null;
        if (c === null || c.mode !== 'host' || (c.dispatch_id ?? null) !== l.dispatch_id || (c.provider_interrupted ?? null) !== null) continue;
        if (c.evidence_correction || c.challenge_conversion || (c.review_rebase ?? null) !== null || (c.settling && settlerAlive(c.settling))) continue;
        if (slotTouched(c.worktree ?? this.controlRoot, c.result_file ?? WORKER_RESULT_FILE) || c.result_captured_sha256 !== undefined || (c.capture_pending ?? null) !== null || (c.seal ?? null) !== null) continue;
        launches = l.dispatch_id !== null ? launchFiles(workerLaunchDir(this.controlRoot, this.featureId, l.dispatch_id)) : [];
        host = host ?? c.host_session ?? null;
      }
      const h = holderFailure({ issuedAt: l.issued_at, host, launches });
      if (h === null) continue;
      if (h.failure.transient) failed.push({ lease: l, holder: h });
      else kept.push({ lease_id: l.lease_id, node_id: l.node_id, review_id: l.review_id, why: `its holder ended on ${h.failure.class}${h.failure.error !== null ? ` (${h.failure.error})` : ''}, not transient: not a provider interruption` });
    }
    return { failed, kept };
  }

  /** What a worker had made on its claim: commits past its base, the gates it passed (the node's state), what is uncommitted. */
  private workerProgress(nodeId: string, c: NodeClaim): ProviderProgress {
    const rt = this.state().nodes[nodeId] as NodeRuntime;
    const base = c.base_sha ?? rt.branch_base_sha ?? null;
    const wt = c.worktree;
    if (wt === null || !existsSync(wt)) return { state: rt.state, base_sha: base, head_sha: null, commits: 0, dirty: [] };
    const head = runGit(wt, ['rev-parse', 'HEAD']);
    const count = base !== null ? runGit(wt, ['rev-list', '--count', `${base}..HEAD`]) : null;
    const status = runGit(wt, ['status', '--porcelain', '--untracked-files=all']);
    const dirty = status.exitCode !== 0 ? [] : status.stdout.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((p) => !p.startsWith(`${WORKER_RESULT_DIR}/`) && p !== WORKER_RESULT_DIR);
    return { state: rt.state, base_sha: base, head_sha: head.exitCode === 0 ? head.stdout.trim() : null, commits: count !== null && count.exitCode === 0 ? Number(count.stdout.trim()) || 0 : 0, dirty: dirty.slice(0, 200) };
  }

  /**
   * A worker that made nothing durable (no commit, no gate) but left files:
   * they are kept, as a patch and a list, in the node's sessions directory
   * (never applied, never settled), and the worktree is put back to its
   * commit for the fresh worker.
   */
  private quarantineUncommitted(nodeId: string, c: NodeClaim, dispatchId: string | null): string | null {
    const wt = c.worktree;
    if (wt === null || !existsSync(wt)) return null;
    const dir = join(this.sessionDir(nodeId), 'provider');
    mkdirSync(dir, { recursive: true });
    const name = `${(dispatchId ?? c.claim_id).replace(/[^A-Za-z0-9-]/g, '')}.patch`;
    const untracked = runGit(wt, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n').filter((p) => p !== '' && !p.startsWith(`${WORKER_RESULT_DIR}/`));
    if (untracked.length > 0) runGit(wt, ['add', '--intent-to-add', '--', ...untracked]);
    const patch = runGit(wt, ['diff', 'HEAD', '--binary']).stdout;
    writeTextAtomic(join(dir, name), patch);
    runGit(wt, ['reset', '-q', '--hard', 'HEAD']);
    runGit(wt, ['clean', '-fdq', '-e', WORKER_RESULT_DIR]);
    return controlRelative(this.controlRoot, join(dir, name));
  }

  /**
   * Interrupt every active lease whose holder a model provider ended
   * (providerFindings), atomically per lease: the lease closed
   * `interrupted-provider` with the failure's class and sanitized ids, and
   *  - a worker with nothing durable made: its claim back READY, the attempt
   *    refunded, nothing counted against it; what it left uncommitted is
   *    quarantined; a fresh worker next;
   *  - a worker with commits or gates: the claim kept, its capability and
   *    dispatch rotated (the old one stops counting everywhere), for the next
   *    dispatch to hand the same generation out from exactly where it stands;
   *  - a review generation: revoked, for the next dispatch to hand out a fresh
   *    one — no format correction, no round, no usage spent.
   * Each counts against its ticket and `phase`; past either bound the feature
   * stops PROVIDER_UNAVAILABLE (its leases still reconciled; nothing BLOCKED).
   * Idempotent: a failure already reconciled is DUPLICATE, nothing changed.
   */
  providerInterrupt(options: { phase?: string | undefined; only?: (l: DispatchLease) => boolean } = {}): ProviderInterruptReport {
    const phase = typeof options.phase === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(options.phase) ? options.phase : 'session';
    const graph = this.graph();
    const found = this.providerFindings();
    const targets = found.failed.filter((x) => options.only === undefined || options.only(x.lease));
    const interrupted: ProviderInterruptReport['interrupted'] = [];
    for (const { lease, holder } of targets) {
      const mark = providerMark(holder);
      const reason = `${mark.class}${mark.category !== null ? ` ${mark.category}` : ''}${mark.request_id !== null ? ` (${mark.request_id})` : ''}: its holder was ended by the model provider (${mark.source})`;
      if (lease.kind === 'review') {
        let entry: ProviderInterruptReport['interrupted'][number] | null = null;
        mutateState(this.paths.featureDir, (s) => {
          const open = s.acceptance_review?.open ?? null;
          const live = (s.orchestration?.leases ?? []).find((l) => l.lease_id === lease.lease_id && l.status === 'active');
          if (open === null || open.dispatch_id !== lease.dispatch_id || live === undefined) return s;
          const ledger = (orchestrationOf(s).provider ??= emptyProviderLedger());
          const ticket = ticketOf(lease, null, open.refinement?.round ?? null);
          const count = countInterruption(ledger, ticket, phase);
          closeLeases(s, (l) => l === live, 'interrupted-provider', reason);
          live.provider = mark;
          open.provider_interrupted = mark;
          recordInterruption(ledger, { ...mark, lease_id: lease.lease_id, kind: 'review', node_id: null, review_id: lease.review_id, ticket, phase, action: 'review-reissue' });
          if (count.past !== null && ledger.unavailable === null) ledger.unavailable = { code: 'PROVIDER_UNAVAILABLE', at: new Date().toISOString(), reason: count.past.slice(0, 500) };
          entry = { lease_id: lease.lease_id, kind: 'review', node_id: null, review_id: lease.review_id, dispatch_id: lease.dispatch_id, action: 'review-reissue', failure: mark, ticket, count: { ticket: count.ticket, phase: count.phase } };
          return s;
        });
        if (entry !== null) {
          interrupted.push(entry);
          this.event('provider.interrupted', null, { ...(entry as object), reason: reason.slice(0, 300) });
        }
        continue;
      }
      const nodeId = lease.node_id as string;
      const before = this.state().nodes[nodeId]?.claim ?? null;
      if (before === null || (before.dispatch_id ?? null) !== lease.dispatch_id) continue;
      const progress = this.workerProgress(nodeId, before);
      const keep = progress.commits > 0 || progress.state !== 'CLAIMED';
      const quarantined = !keep && progress.dirty.length > 0 ? this.quarantineUncommitted(nodeId, before, lease.dispatch_id) : null;
      let entry: ProviderInterruptReport['interrupted'][number] | null = null;
      mutateState(this.paths.featureDir, (s) => {
        const rt = s.nodes[nodeId];
        const live = rt?.claim ?? null;
        const leased = (s.orchestration?.leases ?? []).find((l) => l.lease_id === lease.lease_id && l.status === 'active');
        if (!rt || live === null || live.claim_id !== before.claim_id || (live.dispatch_id ?? null) !== lease.dispatch_id || leased === undefined) return s;
        const ledger = (orchestrationOf(s).provider ??= emptyProviderLedger());
        const ticket = ticketOf(lease, live.attempt ?? rt.attempts);
        const count = countInterruption(ledger, ticket, phase);
        closeLeases(s, (l) => l === leased, 'interrupted-provider', reason);
        leased.provider = mark;
        const action = keep ? 'resumable' : 'released';
        recordInterruption(ledger, { ...mark, lease_id: lease.lease_id, kind: lease.kind, node_id: nodeId, review_id: null, ticket, phase, action });
        if (count.past !== null && ledger.unavailable === null) ledger.unavailable = { code: 'PROVIDER_UNAVAILABLE', at: new Date().toISOString(), reason: count.past.slice(0, 500) };
        entry = { lease_id: lease.lease_id, kind: lease.kind, node_id: nodeId, review_id: null, dispatch_id: lease.dispatch_id, action, failure: mark, ticket, count: { ticket: count.ticket, phase: count.phase }, ...(keep ? { progress } : {}) };
        if (!keep) return applyNodeTransition(graph, s, nodeId, 'READY', { actor: this.owner, reason: `provider interrupted: ${reason}${quarantined !== null ? `; uncommitted work quarantined at ${quarantined}` : ''}`.slice(0, 500), refundAttempt: true, provider: true });
        // The same generation, kept: the old capability stops counting now; the next dispatch reveals the new one.
        const capability = newCapability();
        const dispatchId = randomUUID();
        live.capability_sha256 = capability.sha256;
        live.dispatch_id = dispatchId;
        live.result_file = generationResultFile(dispatchId);
        live.host_session = null;
        live.settling = null;
        live.provider_interrupted = { ...mark, from_dispatch_id: lease.dispatch_id, progress };
        issueLease(s, { kind: live.lease_kind ?? 'worker', node_id: nodeId, review_id: null, claim_id: live.claim_id, dispatch_id: dispatchId, capability_sha256: capability.sha256, generation: live.generation ?? 0, worktree: live.worktree, result_file: live.result_file, host: null });
        return s;
      });
      if (entry === null) continue;
      if (!keep) releaseAllForNode(this.paths.featureDir, nodeId);
      interrupted.push(entry);
      this.event('provider.interrupted', nodeId, { ...(entry as object), reason: reason.slice(0, 300), ...(quarantined !== null ? { quarantined } : {}) });
    }
    const state = this.state();
    const ledger = state.orchestration?.provider ?? emptyProviderLedger();
    const unavailable = ledger.unavailable !== null;
    // Nothing new: a failure already reconciled (its request seen before) is a duplicate notice, answered as such.
    const seen = targets.length === 0 && ledger.interruptions.length > 0;
    const outcome: ProviderInterruptReport['outcome'] = interrupted.length > 0 ? (unavailable ? 'PROVIDER_UNAVAILABLE' : 'RECONCILED') : seen ? 'DUPLICATE' : unavailable ? 'PROVIDER_UNAVAILABLE' : 'NOTHING_INTERRUPTED';
    return { feature_id: this.featureId, outcome, idempotent: interrupted.length === 0, interrupted, kept: found.kept, provider: ledger, next_action: this.nextAction(state) };
  }

  /** Clear a PROVIDER_UNAVAILABLE stop (a person's decision): the counts start again; the history stays. */
  providerReset(): { feature_id: string; cleared: boolean; provider: ProviderLedger } {
    let cleared = false;
    mutateState(this.paths.featureDir, (s) => {
      const ledger = s.orchestration?.provider ?? null;
      if (ledger === null) return s;
      cleared = ledger.unavailable !== null;
      ledger.unavailable = null;
      ledger.tickets = {};
      ledger.phases = {};
      return s;
    });
    this.event('provider.reset', null, { cleared });
    return { feature_id: this.featureId, cleared, provider: this.state().orchestration?.provider ?? emptyProviderLedger() };
  }

  /**
   * A settle presented with the current capability of a claim whose worker
   * left no result because a model provider ended it (or its host): the
   * claim is interrupted (providerInterrupt), never charged RESULT_MISSING.
   */
  private providerSettle(nodeId: string, capability: string | undefined): SettleReport | null {
    if (capability === undefined) return null;
    const c = this.state().nodes[nodeId]?.claim ?? null;
    if (c === null || c.mode !== 'host' || c.capability_sha256 === undefined || !capabilityMatches(capability, c.capability_sha256)) return null;
    const r = this.providerInterrupt({ only: (l) => l.node_id === nodeId && l.dispatch_id === (c.dispatch_id ?? null) });
    const hit = r.interrupted.find((i) => i.node_id === nodeId);
    if (hit === undefined) return null;
    const state = this.state().nodes[nodeId]?.state ?? 'READY';
    const what = hit.action === 'released' ? 'its claim is back READY, the attempt refunded: dispatch hands it to a fresh worker' : 'the claim is kept with its commits and gates: dispatch hands the same generation out again';
    return {
      node_id: nodeId,
      outcome: 'PROVIDER_INTERRUPTED',
      session_id: null,
      state,
      detail: `PROVIDER_INTERRUPTED: the worker left no result: its model provider ended it (${hit.failure.class}${hit.failure.request_id !== null ? `, ${hit.failure.request_id}` : ''}). Nothing was charged; ${what}${r.outcome === 'PROVIDER_UNAVAILABLE' ? '. PROVIDER_UNAVAILABLE: past the bounds of provider failures, nothing more is dispatched until a person clears it' : ''}.`,
      evidence: [],
      idempotent: false,
      provider: hit.failure,
    };
  }

  /**
   * A settle presented with the current capability of a host claim whose slot is empty and nothing captured or sealed,
   * while the worker launched for its dispatch provably still runs (engine/worker-lifecycle.ts): WORKER_RUNNING, and
   * nothing is settled, written or charged. Null otherwise: the settle is judged as it always was.
   */
  private workerRunningSettle(nodeId: string, capability: string | undefined): SettleReport | null {
    if (capability === undefined) return null;
    const c = this.state().nodes[nodeId]?.claim ?? null;
    if (c === null || c.mode !== 'host' || c.capability_sha256 === undefined || !capabilityMatches(capability, c.capability_sha256)) return null;
    const dispatchId = c.dispatch_id ?? null;
    if (dispatchId === null) return null;
    if (slotTouched(c.worktree ?? this.controlRoot, c.result_file ?? WORKER_RESULT_FILE) || c.result_captured_sha256 !== undefined || (c.capture_pending ?? null) !== null || (c.seal ?? null) !== null) return null;
    let running: RunningWorker | null = null;
    try {
      running = runningWorker(this.controlRoot, this.featureId, { claim_id: c.claim_id, dispatch_id: dispatchId }, { timeoutMs: this.workspace.config.session_timeout_ms });
    } catch {
      running = null;
    }
    if (running === null) return null;
    const minutes = Math.round(running.elapsed_ms / 60_000);
    return {
      node_id: nodeId,
      outcome: 'WORKER_RUNNING',
      session_id: null,
      state: this.state().nodes[nodeId]?.state ?? 'CLAIMED',
      detail: `WORKER_RUNNING: the worker launched for ${nodeId} (Agent call ${running.tool_use_id}${running.agent_id !== null ? `, agent ${running.agent_id}` : ''}) has not completed (${minutes} min of its ${Math.round(running.timeout_ms / 60_000)} min wall-clock) and its result slot is empty. Nothing was settled, written or charged: wait for its completion notification, then run the same settle line; never write its result yourself and never dispatch it again while it runs.`,
      evidence: [],
      idempotent: false,
    };
  }

  /** The open review generation's reviewer (or host) ended by a model provider: interrupted, answered so; null otherwise. */
  private providerReview(open: OpenReview): ProviderInterruptReport['interrupted'][number] | null {
    const r = this.providerInterrupt({ only: (l) => l.kind === 'review' && l.dispatch_id === open.dispatch_id });
    return r.interrupted.find((i) => i.kind === 'review' && i.dispatch_id === open.dispatch_id) ?? null;
  }

  private providerReviewReport(open: OpenReview, mark: ProviderMark, idempotent: boolean): ReviewSettleReport {
    const unavailable = (this.state().orchestration?.provider?.unavailable ?? null) !== null;
    return {
      review_id: open.review_id,
      dispatch_id: open.dispatch_id,
      outcome: 'PROVIDER_INTERRUPTED',
      detail: `PROVIDER_INTERRUPTED: the reviewer of ${open.review_id} (generation ${open.dispatch_id}) was ended by its model provider (${mark.class}${mark.request_id !== null ? `, ${mark.request_id}` : ''}) before it answered. The generation is revoked; no format correction, round or usage was spent${unavailable ? '. PROVIDER_UNAVAILABLE: nothing more is dispatched until a person clears it' : '; dispatch hands a fresh reviewer generation out'}.`,
      code: null,
      receipt_path: null,
      receipt_sha256: null,
      reworked: [],
      gaps: [],
      blocked: false,
      idempotent,
      next: unavailable ? 'stop' : 'dispatch',
      provider: mark,
    };
  }

  // ---- reconciliation ---------------------------------------------------

  /**
   * Recover from a crashed controller or worker: reclaim dead leases, close
   * orphaned sessions and return their nodes to a safe state.
   */
  reconcile(options: { abandonDispatches?: boolean } = {}): ReconcileReport {
    // A holder a model provider ended (CSET-203 r10) is known now, from its own records: no expiry to wait for.
    const provider = this.providerInterrupt();
    const recovered = recoverLeases(this.paths.featureDir);
    const orphaned: string[] = [];
    const released: string[] = [];

    const live = liveSessions(this.paths.sessionsRegistry);
    const gone = new Set(
      findOrphanedSessions(live, {
        isAlive: isProcessAlive,
        // A live PID that has been silent past the session ceiling is treated
        // as reused by an unrelated process, not as a still-working worker.
        staleAfterMs: this.workspace.config.session_timeout_ms + 5 * 60 * 1000,
      }),
    );
    for (const session of live) {
      if (!gone.has(session.session_id)) continue;
      orphaned.push(session.session_id);
      markTerminal(this.paths.sessionsRegistry, session.session_id, 'failed');
      // The worker's process is gone (a killed controller, a reboot). That
      // says nothing about the task, so the claim is handed back as an
      // interruption rather than BLOCKing the node.
      const runtime = this.state().nodes[session.node_id];
      if (runtime?.claim?.claim_id === session.claim_id && IN_FLIGHT_STATES.has(runtime.state)) {
        this.interruptClaim(session.node_id, session.claim_id, `worker session ${session.session_id} disappeared`);
        released.push(session.node_id);
      }
    }

    // Host dispatches and settles. Their holders have no PID the controller
    // can watch: a dispatch is abandoned once its claim expires (or when the
    // caller says the previous host is gone); a settle marker whose process
    // died is cleared so the same capability can settle again.
    const pending: ReconcileReport['pending_dispatches'] = [];
    const abandoned: string[] = [];
    const interrupted: string[] = [];
    // A controller run whose controller died: handed back (or, run to the end, concluded).
    const interruptedRuns = this.recoverControllerRuns();
    const now = Date.now();
    for (const [nodeId, runtime] of Object.entries(this.state().nodes)) {
      const claim = runtime.claim;
      if (claim === null || claim.mode === 'controller') continue;
      if (claim.settling && !settlerAlive(claim.settling)) {
        this.clearSettling(nodeId, claim.claim_id);
        interrupted.push(nodeId);
      } else if (claim.settling) {
        continue; // A settle is running right now; leave it alone.
      }
      if (claim.mode !== 'host') continue;
      const expired = Date.parse(claim.expires_at ?? claim.claimed_at) <= now;
      const resultPresent =
        resultInSlot(claim.worktree ?? this.controlRoot, claim.result_file ?? WORKER_RESULT_FILE) ||
        this.capturedResultFor(nodeId, claim) !== null ||
        Boolean(claim.capture_pending);
      if (options.abandonDispatches === true || (expired && !resultPresent)) {
        this.interruptClaim(nodeId, claim.claim_id, `host dispatch abandoned (${expired ? 'claim expired' : 'abandoned by reconcile'})`);
        abandoned.push(nodeId);
      } else {
        const held = claim.seal != null || claim.result_captured_sha256 !== undefined || claim.capture_pending != null;
        // Held for its criterion evidence: `dispatch --resume` hands the correction to a fresh, genuine worker.
        const settlement = claim.evidence_correction ? 'correction' : held ? 'held' : 'none';
        pending.push({ node_id: nodeId, claim_id: claim.claim_id, result_present: resultPresent, expired, state: runtime.state, settlement });
      }
    }

    this.event('feature.reconciled', null, {
      recovered_leases: recovered.length,
      orphaned_sessions: orphaned.length,
      abandoned_dispatches: abandoned,
      interrupted_settles: interrupted,
      interrupted_controller_runs: interruptedRuns,
      pending_dispatches: pending.map((x) => x.node_id),
    });
    return {
      recoveredLeases: recovered.length,
      orphanedSessions: orphaned,
      releasedNodes: released,
      pending_dispatches: pending,
      abandoned_dispatches: abandoned,
      interrupted_settles: interrupted,
      interrupted_controller_runs: interruptedRuns,
      pending_review: this.pendingReview(),
      provider_interrupted: provider.interrupted,
    };
  }

  /**
   * Controller runs (a verification node, a candidate build, an E2E run)
   * whose controller died: no worker holds them, so nobody else would ever
   * finish them. One that reached INTEGRATED had done its work and is
   * concluded DONE; any other is handed back as an interruption (attempt
   * refunded, nothing recorded against it), with any checkout it left, and
   * the next dispatch runs it again. A run whose controller is alive (a
   * concurrent dispatch) is never touched. Returns the nodes recovered.
   */
  private recoverControllerRuns(): string[] {
    const recovered: string[] = [];
    for (const [nodeId, rt] of Object.entries(this.state().nodes)) {
      const claim = rt.claim;
      if (claim === null || claim.mode !== 'controller' || (claim.settling && settlerAlive(claim.settling))) continue;
      const why = `controller run interrupted: the controller that ran it (pid ${claim.settling?.pid ?? 'unknown'}) is gone`;
      this.removeVerificationCheckouts(nodeId);
      if (rt.state === 'INTEGRATED') {
        this.transition(nodeId, 'DONE', { reason: `${why}; its run had completed` });
        this.releaseClaim(nodeId);
      } else {
        this.interruptClaim(nodeId, claim.claim_id, why);
      }
      recovered.push(nodeId);
    }
    if (recovered.length > 0) this.event('controller.runs_recovered', null, { nodes: recovered });
    return recovered;
  }

  /** The fresh checkouts a verification node's runs make: `<verify>/<repository>__<node>__<run>`. */
  private verificationCheckoutPrefix(nodeId: string): { root: string; prefix: string } | null {
    const node = this.graph().nodes.find((n) => n.id === nodeId);
    if (node?.node_type !== 'verification' || node.repository === null) return null;
    return { root: join(this.workspace.paths.workDir, 'verify'), prefix: `${node.repository}__${safeNodeDir(nodeId)}__` };
  }

  /** Remove every checkout a (dead) run of the verification node left. */
  private removeVerificationCheckouts(nodeId: string): void {
    const where = this.verificationCheckoutPrefix(nodeId);
    const node = this.graph().nodes.find((n) => n.id === nodeId);
    if (where === null || node?.repository == null || !existsSync(where.root)) return;
    const repoPath = repositoryPath(this.workspace, node.repository);
    for (const name of readdirSync(where.root)) {
      if (name.startsWith(where.prefix)) removeWorkerWorktree(repoPath, join(where.root, name));
    }
  }

  /**
   * Hand back a claim whose holder vanished, as an interruption. Past
   * MAX_INTERRUPTIONS the node is parked BLOCKED instead (leaving needs a
   * recorded decision), so recovery cannot loop forever. Failure counts are
   * never touched: nothing is known about the task.
   */
  private interruptClaim(nodeId: string, claimId: string, reason: string): void {
    const count = (this.state().nodes[nodeId]?.interruptions ?? 0) + 1;
    if (count <= MAX_INTERRUPTIONS) {
      this.releaseForInfrastructure(nodeId, claimId, reason);
      return;
    }
    const graph = this.graph();
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (!rt?.claim || rt.claim.claim_id !== claimId) return s;
      rt.interruptions = count;
      closeLeases(s, (l) => l.node_id === nodeId && l.claim_id === claimId, 'abandoned', reason);
      return applyNodeTransition(graph, s, nodeId, 'BLOCKED', {
        actor: this.owner,
        reason: `${reason}; interrupted ${count} times`,
      });
    });
    releaseAllForNode(this.paths.featureDir, nodeId);
    this.event('node.interrupted', nodeId, { claim_id: claimId, reason: reason.slice(0, 300), parked: true });
  }

  /**
   * The controller copy a settle of this same claim captured before it was
   * interrupted. Only a copy whose bytes hash to what that settle recorded
   * in the claim is accepted, so a file a worker planted in the sessions
   * directory (claim ids are not secret) is never mistaken for one.
   */
  private capturedResultFor(nodeId: string, claim: NodeClaim): NodeResult | null {
    if (claim.result_captured_sha256 === undefined) return null;
    const attempt = claim.attempt ?? this.state().nodes[nodeId]?.attempts ?? 1;
    const name = claim.result_captured_file ?? `result.attempt-${attempt}.json`;
    const parsed = readControllerCopy(
      join(this.paths.sessionsDir, safeNodeDir(nodeId), name),
      claim.result_captured_sha256,
      nodeId,
      claim.claim_id,
      claim.result_captured_dispatch_id === claim.claim_id ? undefined : claim.result_captured_dispatch_id,
    );
    return parsed;
  }

  /** Compact status summary suitable for a hook or a CLI line. */
  statusSummary(): {
    feature_id: string;
    feature_state: string;
    counts: Record<string, number>;
    ready: string[];
    blocked: string[];
    pending_decisions: string[];
    leases: { resource: string; node_id: string }[];
    current_candidate: string | null;
    usage: FeatureState_['usage'];
    /** The acceptance review: its policy, rounds spent, the review out with a reviewer, the last verdict, a block. */
    acceptance_review: {
      required: boolean;
      max_rounds: number;
      rounds_used: number;
      passed: boolean;
      open: PendingReview | null;
      last: { review_id: string; overall: string; outcome: string; receipt_path: string } | null;
      blocked: AcceptanceReviewState['blocked'];
      usage: FeatureState_['usage'];
      /** Review-gap challenges: each one's review, node, gaps (round, decision) and status. */
      challenges: { challenge_id: string; review_id: string; node_id: string; status: ReviewChallengeRecord['status']; gaps: ReviewChallengeRecord['gaps']; receipt_path: string }[];
      /** Each criterion's own accepted-rework budget, what came of its gaps, and its next action (engine/review-lineage.ts). */
      criteria: Record<string, { accepted_reworks: number; max: number; remaining: number; ceiling: number; ceiling_remaining: number; challenges: number; withdrawals: number; duplicates: number; regressions: number; exhausted: boolean; closed: string | null; next_action: string }>;
      budget_line: string;
      review_sessions: { used: number; max: number };
      no_progress: { streak: number; max: number };
      /** The lineage: its chain head and length, whether it was migrated from a state before it, and why it cannot be trusted. */
      lineage: { head_sha256: string | null; events: number; migrated: boolean; problems: string[] };
      /** Each review's revisions (engine/review-revision.ts), oldest first: each receipt by hash, with the one it refines. */
      revisions: { review_id: string; revision: number; receipts: { revision: number; receipt_path: string; receipt_sha256: string; parent_sha256: string | null }[] }[];
      /** Each live review order: the revision of its review it is bound to, whether that is the current one, and its rebases. */
      orders: { node_id: string; review_id: string; revision: number | null; receipt_sha256: string | null; current: boolean; rebases: { from: number; to: number; by: string; sha256: string }[] }[];
    } | null;
    /** The orchestration epoch and the dispatch leases outstanding (state/orchestration.ts). */
    orchestration: { epoch: number; active_leases: { lease_id: string; kind: string; node_id: string | null; review_id: string | null; dispatch_id: string | null; epoch: number; lineage: number; issued_at: string }[]; provider: ProviderLedger | null };
    /** What the next controller step is, and whether a controller can take it without a person. */
    next_action: NextAction;
    resumable: boolean;
  } {
    const state = this.state();
    const next = this.nextAction(state);
    const counts: Record<string, number> = {};
    for (const runtime of Object.values(state.nodes)) {
      counts[runtime.state] = (counts[runtime.state] ?? 0) + 1;
    }
    const review = state.acceptance_review ?? null;
    const last = review?.reviews[review.reviews.length - 1];
    return {
      feature_id: this.featureId,
      feature_state: state.feature_state,
      counts,
      ready: this.ready(),
      blocked: Object.entries(state.nodes)
        .filter(([, r]) => r.state === 'BLOCKED' || r.state === 'BUDGET_EXHAUSTED')
        .map(([id]) => id),
      pending_decisions: state.pending_decisions,
      leases: listLeases(this.paths.featureDir).map((l) => ({
        resource: l.resource,
        node_id: l.node_id,
      })),
      current_candidate: state.current_candidate,
      usage: state.usage,
      acceptance_review:
        review === null
          ? null
          : {
              required: review.required,
              max_rounds: review.max_rounds,
              rounds_used: roundsUsed(review.reviews, this.lastAcceptedAt(state)),
              passed: review.required ? this.reviewPassed(state) : true,
              open: this.pendingReview(state),
              last: last === undefined ? null : { review_id: last.review_id, overall: last.overall, outcome: last.outcome, receipt_path: last.receipt_path },
              blocked: review.blocked,
              usage: review.usage,
              challenges: (review.challenges ?? []).map((c) => ({ challenge_id: c.challenge_id, review_id: c.review_id, node_id: c.node_id, status: c.status, gaps: c.gaps.map((g) => ({ ...g })), receipt_path: c.receipt_path, ...((c.partial ?? null) !== null ? { partial: structuredClone(c.partial as NonNullable<typeof c.partial>) } : {}) })),
              ...this.lineageStatus(state),
              ...this.revisionStatus(state),
            },
      orchestration: {
        epoch: currentEpoch(state),
        active_leases: activeLeases(state).map((l) => ({ lease_id: l.lease_id, kind: l.kind, node_id: l.node_id, review_id: l.review_id, dispatch_id: l.dispatch_id, epoch: l.epoch, lineage: l.lineage, issued_at: l.issued_at })),
        provider: state.orchestration?.provider ?? null,
      },
      next_action: next,
      resumable: next.resumable,
    };
  }

  /**
   * The next controller step of the feature, machine-readably (CSET-203 r4:
   * the corrective controller exited 0 with the cli READY in its rework
   * generation, one attempt of it refused, and nothing said the run could go
   * on). `stopped` (cancelled, superseded, out of budget) and `decision` (a
   * parked node, a pending decision, a blocked review, a generation whose
   * attempts are spent) need a person; `none` is a delivered feature; else
   * a controller invoked again has work: `reconcile` a claim whose worker
   * went with its session, `deliver` a settled candidate, or `dispatch`.
   */
  private nextAction(state: FeatureState_): NextAction {
    const graph = this.graph();
    const row = (id: string): NextActionNode => {
      const rt = state.nodes[id] as NodeRuntime;
      const node = graph.nodes.find((n) => n.id === id) as GraphNode;
      const rejection = rt.tdd_rejection ?? null;
      return {
        node_id: id,
        state: rt.state,
        rework_generation: rt.rework_brief?.generation ?? (rt.rework_history ?? []).filter(stoodRework).length,
        attempts_used: generationAttempts(rt),
        max_attempts: node.worker.max_attempts,
        last_refusal:
          rejection !== null
            ? { code: `TDD_HISTORY_INVALID:${rejection.code}`, commit: rejection.commit ?? rejection.head_sha }
            : rt.last_failure_fingerprint !== null
              ? { code: rt.last_failure_fingerprint, commit: null }
              : null,
      };
    };
    const describe = (n: NextActionNode): string =>
      `${n.node_id} is ${n.state}: ${n.rework_generation > 0 ? `rework generation ${n.rework_generation}, ` : ''}attempt ${n.attempts_used} of ${n.max_attempts} used${n.last_refusal !== null ? `; last refused ${n.last_refusal.code}${n.last_refusal.commit !== null ? ` at ${n.last_refusal.commit.slice(0, 12)}` : ''}` : ''}`;
    const make = (kind: NextAction['kind'], resumable: boolean, command: string | null, ids: string[], lead: string): NextAction => {
      const nodes = ids.map(row);
      return { kind, resumable, command, detail: [lead, ...nodes.map(describe)].filter((x) => x !== '').join('; ').slice(0, 2000), nodes };
    };
    const order = graph.nodes.map((n) => n.id).filter((id) => state.nodes[id] !== undefined);
    const f = this.featureId;
    if (state.feature_state === 'CANCELLED' || state.feature_state === 'BUDGET_EXHAUSTED' || typeof state.superseded_by === 'string') {
      return make('stopped', false, null, [], `${f} is ${typeof state.superseded_by === 'string' ? `superseded by ${state.superseded_by}` : state.feature_state}`);
    }
    if (state.feature_state === 'COMPLETED') return make('none', false, null, [], `${f} is delivered`);
    // Past the bounds of model-provider failures (CSET-203 r10): the provider, not the work; a person decides when to go on.
    const unavailable = state.orchestration?.provider?.unavailable ?? null;
    if (unavailable !== null) return make('stopped', false, null, [], `${f}: PROVIDER_UNAVAILABLE: ${unavailable.reason}; nothing is dispatched until a person clears it (session provider-reset ${f})`);
    // Evidence the delivered state stands on that no exact archive restores (engine/evidence-integrity.ts; the CSET-202
    // rerun): administrative — the controller repairs it or a person decides; never a worker, never a product rework.
    const evidenceRepair = repairRequired(state);
    if (evidenceRepair !== null) return make('evidence-repair', false, `evidence repair ${f}`, evidenceRepair.nodes.filter((id) => state.nodes[id] !== undefined), repairRequiredDetail(f, evidenceRepair));
    // Holders a model provider ended, known from their own records: reconciled at once, never waited for.
    const providerFailed = new Set(this.providerFindings(state).failed.map((x) => x.lease.lease_id));
    // A node parked only by an identity-shape refusal the canonical test identity resolves (PCM-101 final) is the controller's to
    // settle again, never a person's decision.
    const parkedAll = order.filter((id) => ['BLOCKED', 'NEEDS_DECISION', 'BUDGET_EXHAUSTED'].includes((state.nodes[id] as NodeRuntime).state));
    const reconcilable = parkedAll.filter((id) => this.parkedIdentityCandidate(id, state) !== null);
    const parked = parkedAll.filter((id) => !reconcilable.includes(id));
    const spent = order.filter((id) => {
      const rt = state.nodes[id] as NodeRuntime;
      const node = graph.nodes.find((n) => n.id === id) as GraphNode;
      return (rt.state === 'READY' || rt.state === 'INVALIDATED') && rt.claim === null && generationAttempts(rt) >= node.worker.max_attempts;
    });
    const reviewBlock = state.acceptance_review?.blocked ?? null;
    if (parked.length > 0 || spent.length > 0 || state.pending_decisions.length > 0 || reviewBlock !== null || state.feature_state === 'BLOCKED') {
      const why = [
        parked.length > 0 ? `${parked.join(', ')} parked (BLOCKED)` : '',
        spent.length > 0 ? `ATTEMPTS_EXHAUSTED: ${spent.join(', ')} spent the attempts of ${spent.length === 1 ? 'its' : 'their'} generation` : '',
        state.pending_decisions.length > 0 ? `pending decisions ${state.pending_decisions.join(', ')}` : '',
        reviewBlock !== null ? `the acceptance review is blocked (${reviewBlock.code})` : '',
      ].filter((x) => x !== '').join('; ');
      return make('decision', false, null, [...parked, ...spent], `${f} needs a person: ${why || state.feature_state}`);
    }
    if (reconcilable.length > 0) {
      return make('reconcile', true, `dispatch ${f}`, reconcilable, `${f}: ${reconcilable.join(', ')} ${reconcilable.length === 1 ? 'was' : 'were'} parked by an identity-shape refusal that the canonical test identity resolves: dispatch settles ${reconcilable.length === 1 ? 'its' : 'each'} captured answer administratively — no worker, attempt or correction`);
    }
    // Work in flight (CSET-203 r7): never a review, a refinement or a candidate past a live lease. A lease whose holder left
    // the controller something (a result to settle, a hold to re-issue, an interrupted settle) or is gone (expired) is the
    // controller's to reconcile; one still within its claim, nothing to settle yet, is a worker to wait for.
    const claimed = order.filter((id) => (state.nodes[id] as NodeRuntime).claim !== null);
    if (claimed.length > 0) {
      const now = Date.now();
      const actionable = claimed.filter((id) => {
        const c = (state.nodes[id] as NodeRuntime).claim as NodeClaim;
        if (c.mode !== 'host') return true;
        const held = (c.seal ?? null) !== null || c.result_captured_sha256 !== undefined || (c.capture_pending ?? null) !== null || (c.evidence_correction ?? null) !== null || (c.challenge_conversion ?? null) !== null || (c.provider_interrupted ?? null) !== null || (c.review_rebase ?? null) !== null || providerFailed.has(c.dispatch_id ?? c.claim_id);
        const deadSettle = c.settling !== undefined && c.settling !== null && !settlerAlive(c.settling);
        return held || deadSettle || Date.parse(c.expires_at ?? c.claimed_at) <= now || slotTouched(c.worktree ?? this.controlRoot, c.result_file ?? WORKER_RESULT_FILE);
      });
      if (actionable.length > 0) return make('reconcile', true, `session reconcile ${f}`, actionable, `${f} has work in flight the controller must take up: recover the controller key, reconcile, then dispatch (or dispatch --resume <node>)`);
      return make('await-worker', true, null, claimed, `${f} has work in flight: ${claimed.length === 1 ? 'a worker holds a live dispatch lease' : 'workers hold live dispatch leases'}; wait for ${claimed.length === 1 ? 'it' : 'them'} and settle each ticket — no review, refinement or candidate goes past ${claimed.length === 1 ? 'it' : 'them'}. A fresh controller, whose workers went with an earlier session, reconciles and re-issues each (dispatch --resume <node>)`);
    }
    // A review generation with its reviewer, nothing in its slot yet: waited for, never dispatched past.
    const openReview = state.acceptance_review?.open ?? null;
    if (openReview !== null && ((openReview.provider_interrupted ?? null) !== null || providerFailed.has(openReview.dispatch_id))) {
      return make('reconcile', true, `dispatch ${f}`, [], `${f}: acceptance review ${openReview.review_id}'s reviewer was ended by its model provider before it answered (generation ${openReview.dispatch_id}): dispatch revokes it and hands a fresh reviewer generation out; no correction, round or usage is spent`);
    }
    // Its reviewer interrupted (CSET-203 r13: past its wall-clock, its host or task ended): dispatch re-issues it, nothing spent.
    if (openReview !== null && (openReview.agent_interrupted ?? null) !== null) {
      const reviewer = this.reviewerStatus(openReview, this.interruptedLife(openReview), state);
      return { ...make('reconcile', true, `dispatch ${f}`, [], `${f}: acceptance review ${openReview.review_id}'s reviewer was interrupted (${openReview.agent_interrupted?.reason}) before it completed (generation ${openReview.dispatch_id}): dispatch hands a fresh reviewer generation out; no correction, reviewer attempt, round or usage is spent`), reviewer };
    }
    // The reviewer's lifecycle (CSET-203 r13): one running is waited for — never settled, corrected or re-issued — however long it runs.
    if (openReview !== null && !openReview.refused.some((r) => r.dispatch_id === openReview.dispatch_id) && !this.slotHolds(openReview)) {
      const life = this.lifecycleOf(openReview, {}, state);
      const reviewer = this.reviewerStatus(openReview, life, state);
      const what = `acceptance review ${openReview.review_id}${(openReview.refinement ?? null) !== null ? ' (a refinement)' : ''} (dispatch ${openReview.dispatch_id})`;
      const secs = (ms: number | null): number => Math.round((ms ?? 0) / 1000);
      if (life.state === 'RUNNING') {
        return { ...make('await-reviewer', true, `review await ${f} --review ${openReview.review_id}`, [], `${f}: ${what} is with its reviewer, running ${secs(reviewer.elapsed_ms)} s of its ${secs(reviewer.timeout_ms)} s wall-clock (${secs(reviewer.remaining_ms)} s left): wait for it (its ticket's await line, or review await ${f} --review ${openReview.review_id}), then ingest and settle it with its ticket's lines (a fresh controller: dispatch); never settle, correct or re-issue it while it runs`), reviewer };
      }
      if (life.state === 'TIMED_OUT' || life.state === 'LOST') {
        return { ...make('reconcile', true, `dispatch ${f}`, [], `${f}: ${what}: its reviewer ${life.state === 'TIMED_OUT' ? 'ran past its wall-clock' : `was lost (${life.reason})`} before it completed: dispatch interrupts it and hands a fresh reviewer generation out; nothing is spent`), reviewer };
      }
      if ((life.state === 'MISSING' || life.state === 'REJECTED') && Date.parse(openReview.expires_at) > Date.now()) {
        return { ...make('await-reviewer', true, `dispatch ${f} --resume ${openReview.review_id}`, [], `${f}: ${what} is handed out and no reviewer of it has answered${life.state === 'MISSING' ? ' (none was launched yet)' : ` (${life.code})`}: the host that holds its ticket launches the reviewer with the ticket's prompt and awaits it; a fresh controller, which holds no ticket, re-issues it (dispatch --resume ${openReview.review_id})`), reviewer };
      }
    }
    // A worker's valid challenge of a review gap: a fresh reviewer refines it, and the next dispatch hands it out.
    const challenged = (state.acceptance_review?.challenges ?? []).filter((c) => c.status === 'pending');
    const refining = state.acceptance_review?.open?.refinement ?? null;
    if (challenged.length > 0 || refining !== null) {
      const what = challenged.length > 0 ? challenged.map((c) => `${c.challenge_id} challenges ${c.gaps.map((g) => `${g.criterion} (round ${g.round} of ${MAX_CHALLENGE_ROUNDS})`).join(', ')} of ${c.review_id}${(c.partial ?? null) !== null && (c.partial?.done ?? []).length > 0 ? ` (${c.node_id} is DONE on ${(c.partial?.done ?? []).join(', ')}, awaiting the review of the rest)` : ''}`).join('; ') : `${state.acceptance_review?.open?.review_id}'s refinement is out with its reviewer`;
      return make('review-refine', true, `dispatch ${f}`, [...new Set(challenged.map((c) => c.node_id))], `${f}: ${what}: the exact reproduction passed on the unchanged head; a fresh reviewer refines the gap (dispatch hands out its ticket), then the loop goes on`);
    }
    const settled = order.every((id) => ['DONE', 'EXCLUDED'].includes((state.nodes[id] as NodeRuntime).state));
    if (settled && state.current_candidate !== null) return make('deliver', true, `deliver ${f}`, [], `${f}'s candidate ${state.current_candidate} is settled and not delivered`);
    const open = new Set([...this.ready(), ...order.filter((id) => ['READY', 'INVALIDATED'].includes((state.nodes[id] as NodeRuntime).state))]);
    return make('dispatch', true, `dispatch ${f}`, order.filter((id) => open.has(id)), `${f} is incomplete`);
  }

  /**
   * Which producer nodes own a failure, for the controller to rework: the
   * nodes whose repository and allowed (not forbidden) paths hold `paths`
   * (`<repository>:<path>`, or a bare path matched in every repository; a
   * `<dir>/` is owned by the nodes whose allowed paths lie in it),
   * those whose acceptance criteria include `acceptance`, and with
   * `sinceDelivery` the owners of every path changed on a delivered base
   * branch since the controller left the integration branch there (someone
   * committed on top of the delivery, as a defect QA reports may be). Each
   * owner comes with what `node rework` of it reopens. Changes nothing.
   */
  owners(options: { paths: string[]; acceptance: string[]; sinceDelivery: boolean }): OwnersReport {
    const graph = this.graph();
    const state = this.state();
    const known = new Set(graph.acceptance_criteria.map((a) => a.id));
    const unknown = options.acceptance.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`OWNERS_REFERENCE_INVALID: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not acceptance criteria of ${this.featureId}.`);
    }
    const repositories = new Set(this.workspace.repositories.repositories.map((r) => r.name));
    const targets = options.paths.map((p) => {
      const at = p.indexOf(':');
      return at > 0 && repositories.has(p.slice(0, at)) ? { repository: p.slice(0, at), path: p.slice(at + 1) } : { repository: null, path: p };
    });
    const sinceDelivery: OwnersReport['since_delivery'] = [];
    if (options.sinceDelivery) {
      for (const repo of this.workspace.repositories.repositories) {
        const path = repositoryPath(this.workspace, repo.name);
        if (!branchExists(path, integrationBranchName(this.featureId)) || !branchExists(path, repo.base_branch)) continue;
        const from = expectedIntegrationHead(this.workspace, repo.name, { graph, state });
        const to = resolveRef(path, repo.base_branch);
        if (from === to || !isAncestor(path, from, to)) continue;
        const changed = runGit(path, ['diff', '--name-only', '--no-renames', from, to]).stdout.split('\n').filter((l) => l !== '');
        sinceDelivery.push({ repository: repo.name, base_branch: repo.base_branch, from, to, paths: changed });
        targets.push(...changed.map((p) => ({ repository: repo.name, path: p })));
      }
    }
    const producers = graph.nodes.filter((n) => n.repository !== null && !CONTROLLER_NODE_TYPES.has(n.node_type));
    // A directory (`<dir>/`, a module QA names) is owned by the producers whose allowed paths lie in it.
    const owns = (n: GraphNode, t: { repository: string | null; path: string }): boolean =>
      (t.repository === null || t.repository === n.repository) &&
      (t.path.endsWith('/')
        ? n.allowed_paths.some((g) => g.startsWith(t.path) || matchGlob(g, t.path))
        : n.allowed_paths.some((g) => matchGlob(g, t.path)) && !(n.forbidden_paths ?? []).some((g) => matchGlob(g, t.path)));
    const owners = producers
      .map((n) => ({
        node_id: n.id,
        repository: n.repository as string,
        state: state.nodes[n.id]?.state ?? null,
        paths: [...new Set(targets.filter((t) => owns(n, t)).map((t) => `${n.repository}:${t.path}`))],
        acceptance: options.acceptance.filter((id) => (n.acceptance_criteria ?? []).includes(id)),
      }))
      .filter((o) => o.paths.length > 0 || o.acceptance.length > 0)
      .map((o) => ({ ...o, reopens: this.reworkCascade(graph, o.node_id) }));
    const unowned = [...new Set(targets.filter((t) => !producers.some((n) => owns(n, t))).map((t) => (t.repository === null ? t.path : `${t.repository}:${t.path}`)))];
    return { feature_id: this.featureId, current_candidate: state.current_candidate, since_delivery: sinceDelivery, owners, unowned };
  }

  /** Commit controller-managed feature state in the control repository. */
  commitState(message: string): string | null {
    if (isWorktreeClean(this.controlRoot)) return null;
    return commitAll(this.controlRoot, message);
  }
}

/**
 * Whether the slot holds something for settle to take: this generation's
 * result file, or a slot directory replaced by a link or a file (which the
 * capture refuses as an escape rather than reading as missing).
 */
function slotTouched(cwd: string, resultFile: string): boolean {
  try {
    if (!lstatSync(join(cwd, WORKER_RESULT_DIR)).isDirectory()) return true;
  } catch {
    return false;
  }
  try {
    lstatSync(join(cwd, WORKER_RESULT_DIR, resultFile));
    return true;
  } catch {
    return false;
  }
}

/** Whether `path` is a directory itself, never a link to one. */
function realDirectory(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeNodeDir(nodeId: string): string {
  return nodeId.replace(/[^\w.-]/g, '_');
}

/**
 * The orchestration epoch a result in a worker's slot names, read without
 * trusting anything else in it: a regular file under the size ceiling, JSON,
 * an integer `orchestration_epoch`. Null when it names none (or there is none).
 */
function slotEpoch(slot: string): number | null {
  if (!realDirectory(dirname(slot))) return null;
  try {
    const read = readRegular(slot, MAX_WORKER_RESULT_BYTES);
    if (read === null) return null;
    const value = (JSON.parse(read.bytes.toString('utf8')) as { orchestration_epoch?: unknown }).orchestration_epoch;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** The settle outcome a node's state implies, for a settle answered after it concluded. */
/** Put a node back exactly on the DONE generation a review rework replaced (a valid challenge of it, or a later revision of its review cancelling or replacing it). */
function restoreGenerationInto(n: NodeRuntime, restored: RestorableGeneration, at: string): void {
  n.state = 'DONE';
  n.attempts = restored.attempts;
  n.failure_counts = { ...restored.failure_counts };
  n.last_failure_fingerprint = restored.last_failure_fingerprint;
  n.integrated_sha = restored.integrated_sha;
  n.branch_base_sha = restored.branch_base_sha;
  n.evidence = restored.evidence;
  n.criteria = restored.criteria;
  n.tdd_history = restored.tdd_history;
  n.tdd_red_bindings = restored.tdd_red_bindings;
  n.last_settlement = restored.last_settlement;
  n.carried_criterion_proofs = restored.carried_criterion_proofs;
  n.worktree_setup = restored.worktree_setup;
  n.claim = null;
  n.rework_brief = null;
  n.blocked_reason = null;
  n.tdd_rejection = null;
  delete n.fresh_branch_required;
  n.updated_at = at;
}

/**
 * Each DONE product dependent a review rework reopened, still exactly as it
 * left it and every upstream DONE again, put back on its generation (CSET-203
 * r7), in dependency order. Returns those put back.
 */
function restoreDependentsInto(s: FeatureState_, candidates: Map<string, RestorableGeneration & { branch_head: string | null }>, graph: PortfolioGraph, at: string): string[] {
  const restored: string[] = [];
  for (const [id, snap] of candidates) {
    const d = s.nodes[id];
    const upstream = graph.nodes.find((x) => x.id === id)?.depends_on ?? [];
    if (!d || d.state !== 'INVALIDATED' || d.claim !== null || d.fresh_branch_required !== true || (d.integrated_sha ?? null) !== null) continue;
    if (!upstream.every((u) => s.nodes[u]?.state === 'DONE' || s.nodes[u]?.state === 'EXCLUDED')) continue;
    d.state = 'DONE';
    d.attempts = snap.attempts;
    d.failure_counts = { ...snap.failure_counts };
    d.last_failure_fingerprint = snap.last_failure_fingerprint;
    d.integrated_sha = snap.integrated_sha;
    d.branch_base_sha = snap.branch_base_sha;
    d.evidence = structuredClone(snap.evidence);
    d.criteria = structuredClone(snap.criteria);
    d.tdd_history = snap.tdd_history === null ? null : structuredClone(snap.tdd_history);
    d.tdd_red_bindings = structuredClone(snap.tdd_red_bindings);
    d.last_settlement = snap.last_settlement === null ? null : structuredClone(snap.last_settlement);
    d.carried_criterion_proofs = structuredClone(snap.carried_criterion_proofs);
    d.worktree_setup = snap.worktree_setup === null ? null : structuredClone(snap.worktree_setup);
    d.blocked_reason = null;
    delete d.fresh_branch_required;
    d.updated_at = at;
    restored.push(id);
  }
  return restored;
}

/** Each unresolved criterion's own reason, in one line. */
function unresolvedReason(unresolved: readonly UnresolvedCriterionRecord[]): string {
  return unresolved.map((u) => `${u.criterion} ${u.outcome}: ${u.reason}`).join('; ');
}

/** A NEEDS_DECISION criterion's question as the decision a person answers, named for its criterion. */
function criterionQuestion(u: UnresolvedCriterionRecord): NonNullable<NodeResult['decision_request']> {
  const asked = u.decision_request ?? { question: u.reason, options: ['decide', 'withdraw the gap'] };
  return { question: asked.question.startsWith(u.criterion) ? asked.question : `${u.criterion}: ${asked.question}`, options: [...asked.options], ...(asked.category !== undefined ? { category: asked.category } : {}) };
}

/** A challenged criterion's prior proof as the carried proof its revalidation matches (its archived output is the review's challenge evidence). */
function interimProof(k: AcceptedCriterionRecord): CarriedCriterionProof {
  return {
    criterion: k.criterion,
    test_id: k.test_id as string,
    test: { ...(k.test as { path: string; name: string }) },
    source_generation: k.carried_from?.generation ?? 0,
    source_claim_id: k.carried_from?.claim_id ?? null,
    source_dispatch_id: k.carried_from?.dispatch_id ?? null,
    repo_sha: k.carried_from?.repo_sha ?? null,
    gate: k.carried_from?.gate ?? k.gate,
    output_sha256: k.carried_from?.output_sha256 ?? k.output_sha256,
    output_path: '',
  };
}

function outcomeFromState(state: NodeState): NodeRunReport['outcome'] {
  if (state === 'DONE' || state === 'BLOCKED' || state === 'NEEDS_DECISION' || state === 'BUDGET_EXHAUSTED') return state;
  return 'RETRY';
}

/**
 * Read a controller copy of a worker result: a regular, single-named file
 * under the size ceiling, matching `sha256` when one was recorded,
 * schema-valid and bound to this node, claim and (when given) dispatch.
 */
function readControllerCopy(
  file: string,
  sha256: string | null,
  nodeId: string,
  claimId: string,
  dispatchId: string | undefined,
): NodeResult | null {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_WORKER_RESULT_BYTES || lstatSync(file).isSymbolicLink()) return null;
    const bytes = readFileSync(fd);
    if (sha256 !== null && createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
    const parsed = JSON.parse(bytes.toString('utf8')) as NodeResult;
    if (validateAgainstSchema('node-result', parsed).length > 0) return null;
    if (parsed.node_id !== nodeId || parsed.claim_id !== claimId) return null;
    if (dispatchId !== undefined && parsed.dispatch_id !== dispatchId) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function sha256OfFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
