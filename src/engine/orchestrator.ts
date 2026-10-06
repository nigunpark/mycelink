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
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ClaimMode,
  EvidenceKind,
  EvidenceRecord,
  FeatureState,
  FeatureState_,
  GraphNode,
  NodeClaim,
  NodeRuntime,
  NodeState,
  PortfolioGraph,
  ReworkHistoryEntry,
  ReworkRecord,
  SettlementReceipt,
  UsageTotals,
} from '../model/types.js';
import { featurePaths, nodeEvidenceDir, type FeaturePaths } from '../workspace/paths.js';
import { loadWorkspace, repositoryPath, type Workspace } from '../workspace/workspace.js';
import { loadGraph } from '../workspace/workspace.js';
import { loadState, mutateState } from '../state/feature-state.js';
import {
  accumulateUsage,
  applyNodeTransition,
  recordFailure,
  TransitionError,
} from '../state/transition.js';
import { IN_FLIGHT_STATES, canSchedule, computeReady, scheduleBatch, type SchedulePlan } from '../scheduler/ready.js';
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
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync } from 'node:fs';
import type { PreflightResult } from '../sessions/preflight.js';
import { hostname } from 'node:os';
import { isPidAlive } from '../state/process-lock.js';
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
  removeWorkerWorktree,
  verifyChangedPaths,
  workerBranchName,
  worktreeDirName,
} from '../git/worktree.js';
import { createCandidate, loadCandidate } from '../git/candidate.js';
import { portfolioRefs, trustedIntegrationHead } from './portfolio.js';
import { withLock } from '../state/process-lock.js';
import { loadScenarios, runE2E } from '../e2e/runner.js';
import { DirtyWorktreeError, integrateNodeBranch } from '../git/integrate.js';
import { branchExists, commitAll, isAncestor, isWorktreeClean, listWorktrees, resolveRef, runGit } from '../git/git.js';
import { assertDecisionUsable, markDecisionApplied } from '../state/decisions.js';
import { buildContextPack, type MemoryRef } from '../sessions/context-pack.js';
import { mycelinkCliPath } from '../workspace/hook-settings.js';
import { runVerification, verifierInvocation } from '../evidence/runner.js';
import { appendEvent } from '../state/event-log.js';
import { writeTextAtomic } from '../state/atomic-json.js';
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
}

/** Where a settle can die with something already done that a retry must not redo. */
export type SettleFaultPoint = 'result-captured' | 'result-attested' | 'attempt-concluded';

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
    | 'PRECONDITION_FAILED';
  session_id: string | null;
  state: NodeState;
  detail: string;
  evidence: EvidenceRecord[];
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
    | 'ADAPTER_UNAVAILABLE';
  reports: NodeRunReport[];
  feature_state: string;
  /** The adapter preflight, when one ran. */
  adapter?: PreflightResult;
}

/** Node types the controller runs itself; never a rework target. */
const CONTROLLER_NODE_TYPES: ReadonlySet<string> = new Set(['candidate-build', 'e2e-scenario']);

export type ReworkReport = ReworkRecord & {
  feature_id: string;
  idempotent: boolean;
  /** Archive refs the reopened nodes' old branches were kept under. */
  archived_refs: string[];
};

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
  /** Unsettled host dispatches still within their claim (resume with dispatch --resume). */
  pending_dispatches: { node_id: string; claim_id: string; result_present: boolean; expired: boolean }[];
  /** Host dispatches handed back as interruptions (no failure recorded). */
  abandoned_dispatches: string[];
  /** Settles whose process died; their marker was cleared. */
  interrupted_settles: string[];
}

/** How long past its wall-clock budget an unsettled claim is still presumed alive. */
const CLAIM_GRACE_MS = 15 * 60 * 1000;

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
  | 'MAX_STEPS';

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
  verification_commands: GraphNode['verification_commands'];
  gate_commands: { gate: string; command: string }[];
  result_slot: string;
  settle_command: string;
  context_pack_path: string;
  budget: { model: string; max_turns: number; max_wall_clock_minutes: number };
  prompt: string;
  resumed: boolean;
  result_present: boolean;
}

export interface DispatchResult {
  status: DispatchStatus;
  detail: string;
  ticket?: DispatchTicket;
  controller_reports: NodeRunReport[];
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

/** A settle that started over this long ago is presumed dead even on another host. */
const SETTLE_STALE_MS = 2 * 60 * 60 * 1000;

export class SettleInProgressError extends Error {
  readonly code = 'SETTLE_IN_PROGRESS';
  constructor(nodeId: string, settling: { pid: number; host: string; started_at: string }) {
    super(
      `SETTLE_IN_PROGRESS: ${nodeId} is already being settled by pid ${settling.pid} on ${settling.host} since ${settling.started_at}.`,
    );
    this.name = 'SettleInProgressError';
  }
}

function settlerAlive(settling: { pid: number; host: string; started_at: string }): boolean {
  const started = Date.parse(settling.started_at);
  if (Number.isNaN(started) || Date.now() - started > SETTLE_STALE_MS) return false;
  return settling.host === hostname() ? isPidAlive(settling.pid) : true;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  }

  /** The adapter preflight, run at most once per orchestrator. */
  adapterReady(): PreflightResult {
    if (this.preflightResult === null) this.preflightResult = this.preflight ? this.preflight() : { ok: true };
    return this.preflightResult;
  }

  graph(): PortfolioGraph {
    return loadGraph(this.controlRoot, this.featureId);
  }

  state(): FeatureState_ {
    const doc = loadState(this.paths.featureDir);
    if (doc === null) throw new Error(`Feature "${this.featureId}" has no STATE.json.`);
    return doc.data;
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
    return scheduleBatch(this.graph(), state, {
      writerConcurrency: state.budget.max_writer_concurrency,
    });
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
    mutateState(this.paths.featureDir, (s) =>
      applyNodeTransition(graph, s, nodeId, to, {
        actor: this.owner,
        ...(options as { reason?: string; decisionId?: string; integratedSha?: string }),
      }),
    );
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
  claim(nodeId: string, options: { mode?: ClaimMode } = {}): ClaimResult {
    const graph = this.graph();
    const node = this.node(nodeId);
    const mode = options.mode ?? 'adapter';
    const capability = newCapability();
    const claimId = randomUUID();
    const dispatchId = mode === 'host' ? randomUUID() : undefined;
    const resultFile = dispatchId !== undefined ? generationResultFile(dispatchId) : undefined;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.claimTtlMs(node)).toISOString();
    let attempt = 0;

    mutateState(this.paths.featureDir, (s) => {
      if (STOPPED_FEATURE_STATES.has(s.feature_state)) {
        throw new NotSchedulableError(nodeId, 'FEATURE_STOPPED', `feature is ${s.feature_state}`);
      }
      if (typeof s.superseded_by === 'string') {
        throw new NotSchedulableError(nodeId, 'FEATURE_STOPPED', `feature is superseded by ${s.superseded_by}`);
      }
      const check = canSchedule(graph, s, nodeId, { writerConcurrency: s.budget.max_writer_concurrency });
      if (!check.ok) throw new NotSchedulableError(nodeId, check.reason, check.detail);
      let next = s;
      if (next.nodes[nodeId]?.state !== 'READY') {
        next = applyNodeTransition(graph, next, nodeId, 'READY', { actor: this.owner });
      }
      next = applyNodeTransition(graph, next, nodeId, 'CLAIMED', { actor: this.owner });
      const rt = next.nodes[nodeId] as NodeRuntime;
      attempt = rt.attempts;
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
        settling: null,
        ...(dispatchId !== undefined ? { dispatch_id: dispatchId, result_file: resultFile as string } : {}),
      };
      return next;
    });

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

      if (node.repository !== null) {
        const created = this.ensureWorktree(nodeId, claimId);
        worktree = created.worktree;
        branch = created.branch;
      }
    } catch (err) {
      this.releaseForInfrastructure(nodeId, claimId, `claim setup failed: ${errorText(err)}`);
      if (err instanceof ResourceBusyError) throw err;
      throw new ClaimSetupError(nodeId, err);
    }

    this.event('node.claimed', nodeId, { claim_id: claimId, mode, attempt, worktree, branch });
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
      } else if (adopted !== null && !rt.branch_base_sha) {
        rt.branch_base_sha = adopted;
      }
      baseSha = rt.branch_base_sha ?? null;
      const claim = rt.claim;
      if (claim?.claim_id === claimId) {
        claim.worktree = created.worktree;
        claim.branch = created.branch;
        if (baseSha !== null) claim.base_sha = baseSha;
      }
      return s;
    });
    return { worktree: created.worktree, branch: created.branch, baseSha };
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
    options: { labelPrefix?: string } = {},
  ): { ok: boolean; evidence: EvidenceRecord[]; detail: string; sha?: string } {
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
      for (const verifier of node.verification_commands) {
        const record = runVerification({
          kind: 'green',
          nodeId,
          repository: node.repository,
          ...verifierInvocation(verifier),
          cwd: verifier.cwd ? join(verifyDir, verifier.cwd) : verifyDir,
          evidenceDir,
          label: `${labelPrefix}-${verifier.id}`,
          baselineFailures: repoDecl?.baseline_failures ?? [],
          allowShell: this.workspace.config.allow_shell_commands,
          pathBase: this.controlRoot,
          ...(verifier.expect_exit !== undefined ? { expectExit: verifier.expect_exit } : {}),
        });
        evidence.push(record);
        if (record.failure_fingerprint !== null) {
          return {
            ok: false,
            evidence,
            detail: `verifier "${verifier.id}" exited ${record.exit_code} (${record.failure_fingerprint})`,
          };
        }
      }

      if (node.required_evidence.includes('regression')) {
        const command = repoDecl?.commands.regression ?? repoDecl?.commands.test;
        if (command) {
          const record = runVerification({
            kind: 'regression',
            nodeId,
            repository: node.repository,
            command,
            cwd: verifyDir,
            evidenceDir,
            label: `${labelPrefix}-regression`,
            baselineFailures: repoDecl?.baseline_failures ?? [],
            pathBase: this.controlRoot,
          });
          evidence.push(record);
          if (record.failure_fingerprint !== null) {
            return {
              ok: false,
              evidence,
              detail: `regression exited ${record.exit_code} (${record.failure_fingerprint})`,
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

  /** Merge a verified node branch into its repository integration branch. */
  integrate(nodeId: string, expectedSha?: string): string | null {
    const node = this.node(nodeId);
    if (node.repository === null) return null;
    const repoPath = repositoryPath(this.workspace, node.repository);
    const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === node.repository);
    try {
      trustedIntegrationHead(this.workspace, this.featureId, node.repository, { graph: this.graph(), state: this.state() });
    } catch (err) {
      // A finalize that died after merging this very commit left the branch
      // one step past the recorded head; that resumes. Anything else refuses.
      const head = resolveRef(repoPath, integrationBranchName(this.featureId));
      const resumed =
        expectedSha !== undefined &&
        isAncestor(repoPath, expectedSha, head) &&
        (head === expectedSha ||
          runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${head}^1`], { allowFail: true }).stdout.trim() ===
            (err as { expected?: string }).expected);
      if (!resumed) throw err;
    }
    const result = integrateNodeBranch({
      repoPath,
      featureId: this.featureId,
      nodeBranch: workerBranchName(this.featureId, nodeId),
      baseBranch: repoDecl?.base_branch ?? 'main',
      integrationRoot: this.workspace.paths.integrationDir,
      repositoryName: node.repository,
      ...(expectedSha !== undefined ? { expectedSha } : {}),
    });
    const repository = node.repository;
    mutateState(this.paths.featureDir, (s) => {
      s.integration_heads = { ...(s.integration_heads ?? {}), [repository]: result.sha };
      return s;
    });
    this.event('node.integrated', nodeId, {
      repository: node.repository,
      sha: result.sha,
      strategy: result.strategy,
    });
    return result.sha;
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
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof ResourceBusyError || err instanceof NotSchedulableError) {
        // Nothing was claimed (or the claim was already released): no failure.
        return this.report(nodeId, 'RETRY', sessionId, detail, evidence);
      }
      if (err instanceof ClaimSetupError) {
        // The claim was released with its attempt refunded by claim() itself.
        return this.report(nodeId, 'INFRASTRUCTURE_FAILURE', sessionId, detail, evidence);
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

    return this.finalizeVerified(nodeId, sessionId, evidence);
  }

  /**
   * The only road to DONE for a node with a worker: fresh verification on a
   * clean checkout of the node branch (the worker's own files and claims
   * count for nothing), gate advancement against the evidence actually
   * recorded, integration into the repository's feature branch, DONE, and
   * release of the claim, its leases and its worktree. Any refusal along the
   * way is a recorded attempt failure, never a node left half-way.
   */
  finalizeVerified(nodeId: string, sessionId: string | null, evidence: EvidenceRecord[] = []): NodeRunReport {
    const verification = this.freshVerify(nodeId);
    for (const record of verification.evidence) {
      evidence.push(record);
      this.setEvidence(nodeId, record);
    }

    if (!verification.ok) {
      const ownership = verification.detail.startsWith('OWNERSHIP_VIOLATION');
      const outcome = ownership ? 'OWNERSHIP_VIOLATION' : 'VERIFICATION_FAILED';
      const report = this.failAttempt(nodeId, sessionId, verification.detail, evidence);
      return { ...report, outcome };
    }

    try {
      // A finalize interrupted after integration resumes at DONE: the merge
      // already happened (and integrating again would be a no-op anyway).
      if (this.state().nodes[nodeId]?.state !== 'INTEGRATED') {
        this.advanceVerifiedGates(nodeId);
        const sha = this.integrate(nodeId, verification.sha);
        this.transition(nodeId, 'INTEGRATED', sha !== null ? { integratedSha: sha } : {});
      }
    } catch (err) {
      return this.failAttempt(nodeId, sessionId, errorText(err), evidence);
    }

    // DONE drops the claim, so remember the worktree before it goes.
    const worktree = this.state().nodes[nodeId]?.claim?.worktree ?? null;
    this.transition(nodeId, 'DONE');
    this.releaseClaim(nodeId);
    this.removeWorktree(nodeId, worktree);
    return this.report(nodeId, 'DONE', sessionId, verification.detail, evidence);
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
  ): SettleReport {
    let receipt: SettlementReceipt | null = null;
    let claim: NodeClaim | null = null;
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      const last = rt?.last_settlement ?? null;
      const current = rt?.claim ?? null;
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
      assertClaimCapability(nodeId, rt, capability);
      const live = (rt as NodeRuntime).claim as NodeClaim;
      if (live.settling && settlerAlive(live.settling)) throw new SettleInProgressError(nodeId, live.settling);
      live.settling = { pid: process.pid, host: hostname(), started_at: new Date().toISOString() };
      // A provisional receipt, in the same write: a settle that dies after
      // concluding the attempt (the claim is gone) is still answered when the
      // same capability settles again, instead of NOT_CLAIMED.
      (rt as NodeRuntime).last_settlement = {
        capability_sha256: live.capability_sha256 as string,
        claim_id: live.claim_id,
        outcome: 'PENDING',
        state: (rt as NodeRuntime).state,
        detail: 'settle started and did not record an outcome',
        settled_at: new Date().toISOString(),
      };
      claim = structuredClone(live);
      return s;
    });

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
    try {
      report = work(held);
    } catch (err) {
      this.clearSettling(nodeId, held.claim_id);
      throw err;
    }
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (!rt) return s;
      rt.last_settlement = {
        capability_sha256: held.capability_sha256 as string,
        claim_id: held.claim_id,
        outcome: report.outcome,
        state: rt.state,
        detail: report.detail.slice(0, 1000),
        settled_at: new Date().toISOString(),
      };
      if (rt.claim?.claim_id === held.claim_id) rt.claim.settling = null;
      return s;
    });
    this.event('node.settled', nodeId, { claim_id: held.claim_id, outcome: report.outcome, state: report.state });
    return { ...report, idempotent: false };
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
    const reports: NodeRunReport[] = [];
    const maxSteps = options.maxControllerSteps ?? 10;
    for (let step = 0; step <= maxSteps; step++) {
      const state = this.state();
      const pending = this.pendingDispatches(state);
      const stop = (status: DispatchStatus, detail: string): DispatchResult => {
        this.event('dispatch.stopped', null, { status, detail: detail.slice(0, 500) });
        return { status, detail, controller_reports: reports, pending, deferred: [] };
      };

      if (state.feature_state === 'BUDGET_EXHAUSTED') return stop('BUDGET_EXHAUSTED', state.blocked_reason ?? '');
      if (state.feature_state === 'CANCELLED') return stop('CANCELLED', state.blocked_reason ?? '');
      if (typeof state.superseded_by === 'string') return stop('CANCELLED', `superseded by ${state.superseded_by}`);
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
      if (node.node_type === 'candidate-build' || node.node_type === 'e2e-scenario') {
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
        // Lost a race to another dispatcher, or a lease is busy: look again.
        if (err instanceof NotSchedulableError || err instanceof ResourceBusyError) continue;
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
    const node = this.node(nodeId);
    const before = this.state().nodes[nodeId]?.claim ?? null;
    if (before === null) throw new CapabilityError('NOT_CLAIMED', `${nodeId} has no claim to resume.`);
    if (before.mode !== 'host') {
      throw new Error(`NOT_HOST_DISPATCH: ${nodeId} is claimed in ${before.mode ?? 'legacy'} mode, not by a host dispatch.`);
    }
    if (before.settling && settlerAlive(before.settling)) throw new SettleInProgressError(nodeId, before.settling);

    // Attest before rotating: a result the current generation already wrote
    // is taken into the controller now, checked against that generation, or
    // not at all. After the rotation nothing that generation writes counts.
    // A settle of this generation that died after writing its copy counts as
    // captured before the rotation too.
    const attested =
      before.result_captured_sha256 === undefined
        ? (this.pendingCapture(nodeId, before, Date.parse(before.dispatched_at ?? before.claimed_at))?.captured ??
          this.attestSlot(nodeId, before))
        : null;

    const capability = newCapability();
    const dispatchId = randomUUID();
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
      attempt = held.attempt ?? (next.nodes[nodeId] as NodeRuntime).attempts;
      claim = structuredClone(held);
      return next;
    });
    const held = claim as unknown as NodeClaim;
    if (node.repository !== null && held.worktree === null) {
      // The dispatch was interrupted between claiming and creating the
      // worktree; finish that instead of pointing a worker at the control root.
      const created = this.ensureWorktree(nodeId, held.claim_id);
      held.worktree = created.worktree;
      held.branch = created.branch;
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
      { resumed: true, resultPresent: this.capturedResultFor(nodeId, held) !== null },
    );
    this.event('dispatch.resumed', nodeId, {
      claim_id: held.claim_id,
      attempt,
      dispatch_id: dispatchId,
      attested: attested !== null,
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

  /** The structured ticket the host's Agent tool fulfils. */
  private buildTicket(
    nodeId: string,
    claim: ClaimResult,
    options: { resumed: boolean; resultPresent?: boolean },
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
    return {
      schema: 'mycelink-dispatch-ticket/1',
      feature_id: this.featureId,
      node_id: nodeId,
      claim_id: claim.claimId,
      dispatch_id: claim.dispatchId ?? null,
      attempt: claim.attempt,
      capability: claim.capability,
      expires_at: claim.expiresAt,
      agent: HOST_WORKER_AGENT,
      repository: node.repository,
      worktree: claim.worktree,
      branch: claim.branch,
      allowed_paths: [...node.allowed_paths],
      forbidden_paths: [...(node.forbidden_paths ?? [])],
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
      prompt: buildHostWorkerPrompt({
        pack,
        worktree: claim.worktree,
        resultSlot,
        gates,
        ...(claim.dispatchId !== undefined ? { dispatchId: claim.dispatchId } : {}),
      }),
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
  settle(nodeId: string, capability: string | undefined): SettleReport {
    return this.settleGuard(nodeId, capability, (claim) => {
      if (claim.mode !== 'host') {
        throw new Error(`NOT_HOST_DISPATCH: ${nodeId} is claimed in ${claim.mode ?? 'legacy'} mode; use node finalize for a manual claim.`);
      }
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
          { resultFile, ...(claim.worktree === null ? { fallbackQuarantineDir: null } : {}) },
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
      const collected = { result, failure };
      const status: SessionStatus = result === null ? 'failed' : statusForOutcome(result.outcome);
      const failureReason =
        collected.failure ?? (status === 'failed' && result !== null ? `WORKER_${result.outcome}` : null);
      appendRun(this.paths.runs, {
        attempt_id: `${nodeId}#${attempt}`,
        idempotency_key: `${nodeId}#${attempt}#${claim.claim_id}#${generation}`,
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
    });
  }

  private fault(point: SettleFaultPoint): void {
    this.settleFault?.(point);
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
    try {
      claimId = this.claim(nodeId, { mode: 'controller' }).claimId;
      const repoRefs = this.integrationRefs();
      if (repoRefs.length === 0) {
        return this.failAttempt(nodeId, null, 'NO_INTEGRATION_BRANCHES', evidence);
      }
      const contracts = existsSync(this.workspace.paths.contractsDir)
        ? readdirSync(this.workspace.paths.contractsDir)
            .filter((f) => !f.startsWith('.'))
            .map((f) => `contracts/${f}`)
        : [];

      const manifest = createCandidate({
        controlRepo: this.controlRoot,
        featureDir: this.paths.featureDir,
        featureId: this.featureId,
        repositories: repoRefs,
        contracts,
      });

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

      mutateState(this.paths.featureDir, (s) => {
        if (!s.candidates.includes(manifest.candidate_id)) s.candidates.push(manifest.candidate_id);
        s.current_candidate = manifest.candidate_id;
        if (s.feature_state === 'RUNNING') s.feature_state = 'CANDIDATE_READY';
        return s;
      });

      this.advanceVerifiedGates(nodeId);
      this.transition(nodeId, 'INTEGRATED');
      this.transition(nodeId, 'DONE');
      this.releaseClaim(nodeId);
      return this.report(nodeId, 'DONE', null, manifest.candidate_id, evidence);
    } catch (err) {
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
   * branch that has since moved past the integration branch, the node's
   * attempt budget or rework limit spent. Then, in one STATE.json write: the
   * node goes DONE -> INVALIDATED keeping its attempts and fingerprints (no
   * fresh budget) with the replaced work in its rework_history; every DONE
   * or parked dependent, and every candidate-build and E2E node, is
   * invalidated in dependency order; the current candidate stops being
   * current and the feature returns to RUNNING. Worker branches of reopened
   * nodes are archived, so each is dispatched again from the current
   * integration state and fenced to its own new delta. Repeating the same
   * rework before the node is DONE again changes nothing.
   */
  rework(nodeId: string, options: { reason: string; decisionId?: string }): ReworkReport {
    // Never concurrently with a delivery of this feature (or a supersede).
    const lockDir = join(this.paths.featureDir, 'deliveries');
    mkdirSync(lockDir, { recursive: true });
    return withLock(join(lockDir, 'deliver.lock'), () => this.reworkLocked(nodeId, options), {
      timeoutMs: 2_000,
      pollMs: 50,
      purpose: 'feature rework',
    });
  }

  private reworkLocked(nodeId: string, options: { reason: string; decisionId?: string }): ReworkReport {
    const reason = options.reason.trim();
    const decisionId = options.decisionId ?? null;
    if (reason === '') throw new ReworkRefusedError('REWORK_REASON_REQUIRED', `${nodeId}: say why the node's DONE work is wrong (--reason).`);
    const graph = this.graph();
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Node "${nodeId}" is not in the graph.`);
    if (node.repository === null || CONTROLLER_NODE_TYPES.has(node.node_type)) {
      throw new ReworkRefusedError(
        'REWORK_NOT_A_PRODUCER',
        `${nodeId} is a ${node.node_type} node; rework the producer node the failure is attributed to (controller nodes are re-run after it).`,
      );
    }
    const state = this.state();
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
        return { feature_id: this.featureId, ...record, idempotent: true, archived_refs: this.plannedArchives(record.reopened) };
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
    const busy = Object.entries(state.nodes)
      .filter(([, rt]) => rt.claim !== null || IN_FLIGHT_STATES.has(rt.state))
      .map(([id, rt]) => `${id}=${rt.state}`);
    if (busy.length > 0) {
      throw new ReworkRefusedError('REWORK_IN_FLIGHT', `settle or reconcile the work in flight first: ${busy.join(', ')}.`);
    }
    const reworked = runtime.rework_history?.length ?? 0;
    if (reworked >= state.budget.max_same_failure) {
      throw new ReworkRefusedError(
        'REWORK_LIMIT',
        `${nodeId} was already reworked ${reworked} time(s), the limit (max_same_failure ${state.budget.max_same_failure}); report it instead.`,
      );
    }
    if (runtime.attempts >= node.worker.max_attempts) {
      throw new ReworkRefusedError(
        'REWORK_BUDGET_EXHAUSTED',
        `${nodeId} has used ${runtime.attempts} of ${node.worker.max_attempts} attempts; a rework would have none left.`,
      );
    }

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
    if (delivered) {
      const moved = this.movedBases();
      if (moved.length > 0) {
        throw new ReworkRefusedError(
          'REWORK_BASE_MOVED',
          `the delivered base moved past the feature's integration branch in ${moved.join('; ')}; a replacement candidate could not fast-forward it. Reconcile those bases by hand first.`,
        );
      }
    }

    // What the rework replaces, before anything changes.
    const at = new Date().toISOString();
    const repoPath = repositoryPath(this.workspace, node.repository);
    const branch = workerBranchName(this.featureId, nodeId);
    const head = branchExists(repoPath, branch) ? resolveRef(repoPath, branch) : null;
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
      evidence: Object.fromEntries(
        Object.entries(runtime.evidence).map(([kind, r]) => [
          kind,
          { output_path: r.output_path, output_sha256: r.output_sha256, exit_code: r.exit_code, commit_sha: r.commit_sha },
        ]),
      ),
    };

    const reopened: string[] = [];
    let candidate: string | null = null;
    mutateState(this.paths.featureDir, (s) => {
      // Re-checked under the lock: nothing may have started meanwhile.
      if (s.nodes[nodeId]?.state !== 'DONE') throw new ReworkRefusedError('REWORK_NOT_DONE', `${nodeId} changed while it was being reworked.`);
      if (typeof s.superseded_by === 'string') throw new ReworkRefusedError('REWORK_FEATURE_STOPPED', `${this.featureId} was superseded meanwhile.`);
      const started = Object.entries(s.nodes).find(([, rt]) => rt.claim !== null || IN_FLIGHT_STATES.has(rt.state));
      if (started) throw new ReworkRefusedError('REWORK_IN_FLIGHT', `${started[0]} started while the rework was prepared.`);
      let next = s;
      for (const id of cascade) {
        const rt = next.nodes[id] as NodeRuntime;
        const root = id === nodeId;
        const from = rt.state;
        if (root) {
          rt.rework_history = [...(rt.rework_history ?? []), entry];
          next = applyNodeTransition(graph, next, id, 'INVALIDATED', { actor: this.owner, reason: `rework: ${reason}`, rework: true });
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
      candidate = next.current_candidate;
      next.current_candidate = null;
      if (['CANDIDATE_READY', 'E2E_RUNNING', 'VERIFIED', 'COMPLETED'].includes(next.feature_state)) next.feature_state = 'RUNNING';
      const record: ReworkRecord = { node_id: nodeId, reason, decision_id: decisionId, at, reopened, invalidated_candidate: candidate, delivered };
      next.reworks = [...(next.reworks ?? []), record];
      return next;
    });
    if (decisionId !== null) markDecisionApplied(this.paths.events, this.featureId, decisionId, `node rework ${nodeId}`);
    this.event('node.reworked', nodeId, {
      reason: reason.slice(0, 500),
      decision_id: decisionId,
      reopened,
      invalidated_candidate: candidate,
      delivered,
      archived_ref: entry.archived_ref,
    });
    // The branches are archived by the next claim of each node (under its
    // claim, so never racing a dispatch); report where they will go.
    const archived = this.plannedArchives(reopened);
    return {
      feature_id: this.featureId,
      node_id: nodeId,
      reason,
      decision_id: decisionId,
      at,
      reopened,
      invalidated_candidate: candidate,
      delivered,
      idempotent: false,
      archived_refs: archived,
    };
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

  /** Whether any delivery of this feature moved (or tried to move) its base branches. */
  private featureDelivered(state: FeatureState_): boolean {
    if (Object.keys(state.accepted_deliveries ?? {}).length > 0) return true;
    const dir = join(this.paths.featureDir, 'deliveries');
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'));
  }

  /** Repositories whose base branch is no longer an ancestor of this feature's integration branch. */
  private movedBases(): string[] {
    const branch = integrationBranchName(this.featureId);
    const moved: string[] = [];
    for (const repo of this.workspace.repositories.repositories) {
      const path = repositoryPath(this.workspace, repo.name);
      if (!branchExists(path, branch) || !branchExists(path, repo.base_branch)) continue;
      const base = resolveRef(path, repo.base_branch);
      const integration = resolveRef(path, branch);
      if (!isAncestor(path, base, integration)) moved.push(`${repo.name} (${repo.base_branch} at ${base.slice(0, 12)})`);
    }
    return moved;
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
    const expected = resolve(join(this.workspace.paths.worktreesDir, worktreeDirName(node.repository, nodeId)));
    for (const w of listWorktrees(repoPath)) {
      if (w.branch === branch || resolve(w.path) === expected) removeWorkerWorktree(repoPath, w.path);
    }
    // Compare-and-swap: only the branch head that was archived is deleted.
    runGit(repoPath, ['update-ref', '-d', `refs/heads/${branch}`, head]);
    return ref;
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
    for (const step of order) {
      if (step.needs !== undefined && !required.has(step.needs)) continue;
      const current = this.state().nodes[nodeId]?.state;
      if (current === step.state) continue;
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

  private recordDecisionRequest(nodeId: string, result: NodeResult): void {
    const request = result.decision_request;
    if (!request) return;
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
        return this.finish(cycles, 'ALL_SETTLED', all);
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
          return this.finish(cycles + 1, 'ALL_SETTLED', all);
        }
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

  // ---- reconciliation ---------------------------------------------------

  /**
   * Recover from a crashed controller or worker: reclaim dead leases, close
   * orphaned sessions and return their nodes to a safe state.
   */
  reconcile(options: { abandonDispatches?: boolean } = {}): ReconcileReport {
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
    const now = Date.now();
    for (const [nodeId, runtime] of Object.entries(this.state().nodes)) {
      const claim = runtime.claim;
      if (claim === null) continue;
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
        pending.push({ node_id: nodeId, claim_id: claim.claim_id, result_present: resultPresent, expired });
      }
    }

    this.event('feature.reconciled', null, {
      recovered_leases: recovered.length,
      orphaned_sessions: orphaned.length,
      abandoned_dispatches: abandoned,
      interrupted_settles: interrupted,
      pending_dispatches: pending.map((x) => x.node_id),
    });
    return {
      recoveredLeases: recovered.length,
      orphanedSessions: orphaned,
      releasedNodes: released,
      pending_dispatches: pending,
      abandoned_dispatches: abandoned,
      interrupted_settles: interrupted,
    };
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
  } {
    const state = this.state();
    const counts: Record<string, number> = {};
    for (const runtime of Object.values(state.nodes)) {
      counts[runtime.state] = (counts[runtime.state] ?? 0) + 1;
    }
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
    };
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

function safeNodeDir(nodeId: string): string {
  return nodeId.replace(/[^\w.-]/g, '_');
}

/** The settle outcome a node's state implies, for a settle answered after it concluded. */
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
