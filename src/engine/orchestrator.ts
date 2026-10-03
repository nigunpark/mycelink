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
import { randomUUID } from 'node:crypto';
import type {
  EvidenceKind,
  EvidenceRecord,
  FeatureState_,
  GraphNode,
  NodeState,
  PortfolioGraph,
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
import { computeReady, scheduleBatch, type SchedulePlan } from '../scheduler/ready.js';
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
import { runVerification } from '../evidence/runner.js';
import { appendEvent } from '../state/event-log.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import type { NodeResult, SessionAdapter, SpawnRequest } from '../sessions/adapter.js';
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
    | 'OWNERSHIP_VIOLATION';
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
    | 'MAX_CYCLES';
  reports: NodeRunReport[];
  feature_state: string;
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

  constructor(options: OrchestratorOptions) {
    this.controlRoot = resolve(options.controlRoot);
    this.featureId = options.featureId;
    this.paths = featurePaths(this.controlRoot, options.featureId);
    this.workspace = loadWorkspace(this.controlRoot);
    this.adapter = options.adapter;
    this.owner = options.owner ?? 'mycelink';
    this.workerEnv = options.workerEnv ?? {};
    this.recall = options.recall;
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
   * Claim a node: reserve its resources, create its isolated worktree, record
   * the claim and write its bounded context pack.
   */
  claim(nodeId: string): { claimId: string; worktree: string | null; branch: string | null } {
    const graph = this.graph();
    const node = this.node(nodeId);
    const before = this.state();
    const runtime = before.nodes[nodeId];
    if (!runtime) throw new Error(`Node "${nodeId}" has no runtime state.`);

    if (runtime.state === 'PLANNED' || runtime.state === 'INVALIDATED') {
      this.transition(nodeId, 'READY');
    }

    const claimId = randomUUID();

    for (const resource of node.required_resources) {
      acquireResource(this.paths.featureDir, resource, {
        nodeId,
        owner: this.owner,
        capacities: graph.resources,
        idempotencyKey: `${nodeId}:${resource}:${claimId}`,
      });
    }

    let worktree: string | null = null;
    let branch: string | null = null;
    if (node.repository !== null) {
      const repoPath = repositoryPath(this.workspace, node.repository);
      const repoDecl = this.workspace.repositories.repositories.find(
        (r) => r.name === node.repository,
      );
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
    }

    this.transition(nodeId, 'CLAIMED');
    mutateState(this.paths.featureDir, (s) => {
      const rt = s.nodes[nodeId];
      if (rt) {
        rt.claim = {
          claim_id: claimId,
          owner: this.owner,
          worktree,
          branch,
          claimed_at: new Date().toISOString(),
        };
      }
      return s;
    });

    this.event('node.claimed', nodeId, { claim_id: claimId, worktree, branch });
    return { claimId, worktree, branch };
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
  freshVerify(nodeId: string): { ok: boolean; evidence: EvidenceRecord[]; detail: string } {
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
    const verifyDir = join(verifyRoot, `${node.repository}__${nodeId.replace(/[^\w.-]/g, '_')}`);

    // A clean checkout of exactly the node branch.
    runGit(repoPath, ['worktree', 'remove', '--force', verifyDir], { allowFail: true });
    runGit(repoPath, ['worktree', 'prune'], { allowFail: true });
    runGit(repoPath, ['worktree', 'add', '--detach', verifyDir, branch]);
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
          detail: `OWNERSHIP_VIOLATION: ${fence.violations.slice(0, 10).join(', ')}`,
        };
      }

      const evidenceDir = nodeEvidenceDir(this.controlRoot, this.featureId, nodeId);
      for (const verifier of node.verification_commands) {
        const record = runVerification({
          kind: 'green',
          nodeId,
          repository: node.repository,
          command: verifier.command,
          cwd: verifier.cwd ? join(verifyDir, verifier.cwd) : verifyDir,
          evidenceDir,
          label: `fresh-${verifier.id}`,
          baselineFailures: repoDecl?.baseline_failures ?? [],
          shell: verifier.shell === true,
          allowShell: this.workspace.config.allow_shell_commands,
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
            label: 'fresh-regression',
            baselineFailures: repoDecl?.baseline_failures ?? [],
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

      return { ok: true, evidence, detail: 'fresh verification passed' };
    } finally {
      runGit(repoPath, ['worktree', 'remove', '--force', verifyDir], { allowFail: true });
      runGit(repoPath, ['worktree', 'prune'], { allowFail: true });
    }
  }

  /** Merge a verified node branch into its repository integration branch. */
  integrate(nodeId: string): string | null {
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

    try {
      const { claimId, worktree, branch } = this.claim(nodeId);
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
        env: {
          MYCELINK_CONTROL_ROOT: this.controlRoot,
          MYCELINK_BRANCH: branch ?? '',
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

      const result = observation.result;

      if (observation.status === 'needs-decision' && result?.decision_request) {
        this.recordDecisionRequest(nodeId, result);
        this.transition(nodeId, 'NEEDS_DECISION', {
          reason: result.decision_request.question.slice(0, 300),
        });
        this.releaseClaim(nodeId);
        return this.report(nodeId, 'NEEDS_DECISION', sessionId, result.decision_request.question, evidence);
      }

      if (observation.status === 'budget-exhausted') {
        this.transition(nodeId, 'BUDGET_EXHAUSTED', {
          reason: observation.failure_reason ?? 'worker budget exhausted',
        });
        this.releaseClaim(nodeId);
        return this.report(nodeId, 'BUDGET_EXHAUSTED', sessionId, observation.failure_reason ?? '', evidence);
      }

      if (observation.status === 'blocked') {
        this.transition(nodeId, 'BLOCKED', {
          reason: result?.failure_fingerprint ?? observation.failure_reason ?? 'worker blocked',
        });
        this.releaseClaim(nodeId);
        return this.report(nodeId, 'BLOCKED', sessionId, observation.failure_reason ?? 'blocked', evidence);
      }

      if (observation.status !== 'done' || result === null) {
        return this.failAttempt(
          nodeId,
          sessionId,
          result?.failure_fingerprint ?? observation.failure_reason ?? 'WORKER_FAILED',
          evidence,
        );
      }

      // The worker submitted. Independently verify before believing it.
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

      this.advanceVerifiedGates(nodeId);

      const sha = this.integrate(nodeId);
      if (sha !== null) {
        this.transition(nodeId, 'INTEGRATED', { integratedSha: sha });
      } else {
        this.transition(nodeId, 'INTEGRATED');
      }
      this.transition(nodeId, 'DONE');
      this.releaseClaim(nodeId, { removeWorktree: true });

      return this.report(nodeId, 'DONE', sessionId, verification.detail, evidence);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof ResourceBusyError) {
        return this.report(nodeId, 'RETRY', sessionId, detail, evidence);
      }
      return this.failAttempt(nodeId, sessionId, detail, evidence);
    }
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
      this.claim(nodeId);
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
        cwd: this.controlRoot,
        repository: null,
        commit_sha: manifest.control_commit,
        output_path: join(this.paths.candidatesDir, `${manifest.candidate_id}.yaml`),
        output_sha256: manifest.manifest_sha256,
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
  invalidateWithDependents(nodeId: string, reason: string): string[] {
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
      try {
        this.transition(id, 'INVALIDATED', {
          reason: id === nodeId ? reason : `upstream ${nodeId} was invalidated: ${reason}`,
        });
        invalidated.push(id);
      } catch {
        // Already in a state from which INVALIDATED is not reachable.
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
      this.claim(nodeId);
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
      reports.push(await this.runNode(scheduled.node_id));
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
    const state = this.state();
    if (reason === 'ALL_SETTLED' && state.feature_state === 'RUNNING') {
      mutateState(this.paths.featureDir, (s) => {
        s.feature_state = 'VERIFIED';
        return s;
      });
    }
    this.event('feature.cycle_stopped', null, { reason, cycles });
    return {
      cycles,
      stop_reason: reason,
      reports,
      feature_state: this.state().feature_state,
    };
  }

  // ---- reconciliation ---------------------------------------------------

  /**
   * Recover from a crashed controller or worker: reclaim dead leases, close
   * orphaned sessions and return their nodes to a safe state.
   */
  reconcile(): { recoveredLeases: number; orphanedSessions: string[]; releasedNodes: string[] } {
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

      const runtime = this.state().nodes[session.node_id];
      if (runtime && ['CLAIMED', 'RED_PENDING', 'GREEN_PENDING'].includes(runtime.state)) {
        try {
          this.transition(session.node_id, 'BLOCKED', {
            reason: `Worker session ${session.session_id} disappeared; claim reclaimed.`,
          });
        } catch {
          // Node already moved on.
        }
        this.releaseClaim(session.node_id);
        released.push(session.node_id);
      }
    }

    this.event('feature.reconciled', null, {
      recovered_leases: recovered.length,
      orphaned_sessions: orphaned.length,
    });
    return { recoveredLeases: recovered.length, orphanedSessions: orphaned, releasedNodes: released };
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
