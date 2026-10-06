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
} from '../git/worktree.js';
import { createCandidate, loadCandidate } from '../git/candidate.js';
import { loadScenarios, runE2E } from '../e2e/runner.js';
import { integrateNodeBranch } from '../git/integrate.js';
import { commitAll, isWorktreeClean, resolveRef, runGit } from '../git/git.js';
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
    | 'INFRASTRUCTURE_FAILURE';
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
        const repoPath = repositoryPath(this.workspace, node.repository);
        const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === node.repository);
        const created = createWorkerWorktree({
          repoPath,
          featureId: this.featureId,
          nodeId,
          baseBranch: repoDecl?.base_branch ?? 'main',
          worktreeRoot: this.workspace.paths.worktreesDir,
          repositoryName: node.repository,
        });
        worktree = created.worktree;
        branch = created.branch;
        mutateState(this.paths.featureDir, (s) => {
          const claim = s.nodes[nodeId]?.claim;
          if (claim?.claim_id === claimId) {
            claim.worktree = worktree;
            claim.branch = branch;
          }
          return s;
        });
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
      const base = resolveRef(repoPath, baseBranch);
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
    const result = integrateNodeBranch({
      repoPath,
      featureId: this.featureId,
      nodeBranch: workerBranchName(this.featureId, nodeId),
      baseBranch: repoDecl?.base_branch ?? 'main',
      integrationRoot: this.workspace.paths.integrationDir,
      repositoryName: node.repository,
      ...(expectedSha !== undefined ? { expectedSha } : {}),
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
      if (!isCurrent && last !== null && capability !== undefined && capabilityMatches(capability, last.capability_sha256)) {
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
        reports.push(await this.runNode(node.id));
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
    const attested = before.result_captured_sha256 === undefined ? this.attestSlot(nodeId, before) : null;

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
      attempt = held.attempt ?? (next.nodes[nodeId] as NodeRuntime).attempts;
      claim = structuredClone(held);
      return next;
    });
    const held = claim as unknown as NodeClaim;
    if (node.repository !== null && held.worktree === null) {
      // The dispatch was interrupted between claiming and creating the
      // worktree; finish that instead of pointing a worker at the control root.
      const repoDecl = this.workspace.repositories.repositories.find((r) => r.name === node.repository);
      const created = createWorkerWorktree({
        repoPath: repositoryPath(this.workspace, node.repository),
        featureId: this.featureId,
        nodeId,
        baseBranch: repoDecl?.base_branch ?? 'main',
        worktreeRoot: this.workspace.paths.worktreesDir,
        repositoryName: node.repository,
      });
      held.worktree = created.worktree;
      held.branch = created.branch;
      mutateState(this.paths.featureDir, (s) => {
        const c = s.nodes[nodeId]?.claim;
        if (c?.claim_id === held.claim_id) {
          c.worktree = created.worktree;
          c.branch = created.branch;
        }
        return s;
      });
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
      const started = Date.parse(claim.claimed_at);
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
      usage: hostUsage(collected.result, Date.parse(claim.claimed_at)),
    };
  }

  /**
   * A settle that died after writing its controller copy but before
   * recording it: finish that capture from the copy it announced, after the
   * same checks as any captured copy.
   */
  private finishPendingCapture(nodeId: string, claim: NodeClaim, started: number): NodeResult | null {
    const pending = claim.capture_pending;
    if (!pending) return null;
    const file = join(this.sessionDir(nodeId), pending.file);
    const parsed = readControllerCopy(file, null, nodeId, claim.claim_id, claim.dispatch_id);
    if (parsed === null) return null;
    const captured = { file: pending.file, sha256: sha256OfFile(file), dispatchId: pending.dispatch_id, usage: hostUsage(parsed, started) };
    mutateState(this.paths.featureDir, (s) => this.recordCapture(s, nodeId, captured, claim.claim_id));
    return parsed;
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
    try {
      this.claim(nodeId, { mode: 'controller' });
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
      return this.failAttempt(
        nodeId,
        null,
        err instanceof Error ? err.message : String(err),
        evidence,
      );
    }
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

  private integrationRefs(): { name: string; path: string; branch: string }[] {
    const branch = integrationBranchName(this.featureId);
    return this.workspace.repositories.repositories
      .filter((repo) => {
        const path = repositoryPath(this.workspace, repo.name);
        return (
          runGit(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
            allowFail: true,
          }).exitCode === 0
        );
      })
      .map((repo) => ({ name: repo.name, path: repositoryPath(this.workspace, repo.name), branch }));
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
