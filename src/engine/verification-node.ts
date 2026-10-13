/**
 * Verification nodes: criteria proven by existing tests, run by the controller.
 *
 * CSET-203 r1 with-faults: the planner gave AC-5 (compatibility: a run that
 * succeeds produces exactly the same files as today) a node of its own with
 * no allowed paths and the full suite as its verifier. The controller
 * dispatched a module-worker to it; the worker ran green and regression,
 * changed nothing and submitted, and settle refused it twice for having no
 * declaration commit: the node BLOCKED and nothing was delivered. A proof
 * that changes nothing is not a worker's job. A `verification` node
 * (graph/validate.ts) is run by `dispatch` itself, like a candidate build:
 *
 *  - every verifier is resolved and bound before anything is claimed: a
 *    module's command exactly as the graph was planned against it (a changed
 *    module is MODULE_DRIFT), or a command of the repository;
 *  - they run in a fresh, set-up checkout of the repository's integrated
 *    head (the commit the candidate will bind), never in a worktree of the
 *    node's own: it has no branch, no commit, no TDD history;
 *  - one receipt binds what ran: the head, each command with its module, plan
 *    and output hashes, the setup's config and receipt, the canonical id of
 *    every test that passed, and how each criterion is evidenced — a
 *    compatibility criterion by the run itself, a new behaviour (or a
 *    declaration) only re-verified here, its proof the upstream producer's.
 */
import { createHash } from 'node:crypto';
import type { ClaimVerification, EvidenceRecord, FeatureState_, GraphNode, PortfolioGraph, RepositoryDecl } from '../model/types.js';
import { ModuleDriftError, claimVerificationFor, modulesOf } from './modules.js';
import { normalizeCriterionKind } from './criteria.js';
import { readGateTests } from '../evidence/gate-tests.js';
import { transitiveDependencies } from '../graph/validate.js';

/** One verifier of a verification node, bound: its module's plan, or a repository command. */
export interface VerificationStep {
  verifier: { id: string; command: string[]; cwd?: string; shell?: boolean; expect_exit?: number };
  /** Set for a module verifier: the plan the graph was planned against, checked now. */
  module: ClaimVerification | null;
}

/**
 * Bind every verifier of a verification node; throws ModuleDriftError when a
 * module is not what the graph planned, or (where the repository declares
 * modules) a plain verifier is no longer exactly one of its commands.
 */
export function verificationSteps(nodeId: string, node: GraphNode, repo: RepositoryDecl): VerificationStep[] {
  const allowlisted = modulesOf(repo).length === 0 ? null : Object.values(repo.commands).filter((c): c is string[] => Array.isArray(c));
  for (const v of node.verification_commands) {
    if (v.module !== undefined || allowlisted === null) continue;
    if (v.shell === true || !allowlisted.some((c) => c.length === v.command.length && c.every((a, i) => a === v.command[i]))) {
      throw new ModuleDriftError(nodeId, `COMMAND_NOT_ALLOWLISTED: verifier "${v.id}" runs ${JSON.stringify(v.command)}, which is no longer a command of repository "${repo.name}"`);
    }
  }
  return node.verification_commands.map((v) => ({
    verifier: { id: v.id, command: [...v.command], ...(v.cwd !== undefined ? { cwd: v.cwd } : {}), ...(v.shell !== undefined ? { shell: v.shell } : {}), ...(v.expect_exit !== undefined ? { expect_exit: v.expect_exit } : {}) },
    module: claimVerificationFor(nodeId, v, repo),
  }));
}

/** How a verification node evidences each of its criteria. */
export interface VerificationCriterion {
  criterion: string;
  kind: 'new-behavior' | 'compatibility' | 'declaration';
  /** `passed`: the run is the evidence (a compatibility criterion); `reverified`: an upstream producer owns its proof. */
  evidence: 'passed' | 'reverified';
  owner?: string;
}

/**
 * How each criterion of the node is evidenced, or the criterion no DONE
 * upstream producer owns (graph validation refuses such a graph; this holds
 * the run to it).
 */
export function verificationCriteria(graph: PortfolioGraph, state: FeatureState_, node: GraphNode): { ok: true; criteria: VerificationCriterion[] } | { ok: false; criterion: string; kind: string } {
  const upstream = transitiveDependencies(graph, node.id);
  const out: VerificationCriterion[] = [];
  for (const ac of node.acceptance_criteria ?? []) {
    const kind = normalizeCriterionKind(graph.acceptance_criteria.find((a) => a.id === ac)?.kind);
    if (kind === 'compatibility') {
      out.push({ criterion: ac, kind, evidence: 'passed' });
      continue;
    }
    const owner = graph.nodes.find(
      (n) => upstream.has(n.id) && n.repository !== null && !['candidate-build', 'e2e-scenario', 'verification'].includes(n.node_type) && (n.acceptance_criteria ?? []).includes(ac) && state.nodes[n.id]?.state === 'DONE',
    );
    if (owner === undefined) return { ok: false, criterion: ac, kind };
    out.push({ criterion: ac, kind, evidence: 'reverified', owner: owner.id });
  }
  return { ok: true, criteria: out };
}

export interface VerificationRun {
  step: VerificationStep;
  record: EvidenceRecord;
}

export interface VerificationReceipt {
  schema: 'mycelink-verification/1';
  feature_id: string;
  node_id: string;
  claim_id: string;
  repository: string;
  /** The commit verified: the repository's integrated head the controller recorded, or its base before anything was integrated. */
  head_sha: string;
  head_source: 'integration' | 'base';
  status: 'passed' | 'failed';
  setup: { config_sha256: string; receipt_path: string; receipt_sha256: string } | null;
  runs: {
    verifier: string;
    module: string | null;
    module_sha256: string | null;
    plan_sha256: string | null;
    command: string[];
    exit_code: number;
    failure_fingerprint: string | null;
    output_path: string;
    output_sha256: string;
    results: EvidenceRecord['results'] | null;
  }[];
  /** The canonical id (evidence/test-ids.ts) of every test a run with a structured report passed. */
  tests: { total: number; passed: { id: string; path: string; full_name: string; verifier: string }[]; ids_sha256: string };
  criteria: VerificationCriterion[];
  verified_at: string;
}

/** The receipt of a verification node's run. */
export function verificationReceipt(args: {
  controlRoot: string;
  featureId: string;
  nodeId: string;
  claimId: string;
  repository: string;
  head: string;
  headSource: 'integration' | 'base';
  setup: VerificationReceipt['setup'];
  runs: VerificationRun[];
  criteria: VerificationCriterion[];
}): VerificationReceipt {
  let total = 0;
  const passed: VerificationReceipt['tests']['passed'] = [];
  for (const { step, record } of args.runs) {
    const tests = readGateTests(args.controlRoot, record) ?? [];
    total += tests.length;
    for (const t of tests) if (t.status === 'passed') passed.push({ id: t.id, path: t.path, full_name: t.full_name, verifier: step.verifier.id });
  }
  const ids = [...new Set(passed.map((t) => t.id))].sort();
  const failed = args.runs.some((r) => r.record.failure_fingerprint !== null);
  return {
    schema: 'mycelink-verification/1',
    feature_id: args.featureId,
    node_id: args.nodeId,
    claim_id: args.claimId,
    repository: args.repository,
    head_sha: args.head,
    head_source: args.headSource,
    status: failed ? 'failed' : 'passed',
    setup: args.setup,
    runs: args.runs.map(({ step, record }) => ({
      verifier: step.verifier.id,
      module: step.module?.module ?? null,
      module_sha256: step.module?.module_sha256 ?? null,
      plan_sha256: step.module?.plan_sha256 ?? null,
      command: [...record.command],
      exit_code: record.exit_code,
      failure_fingerprint: record.failure_fingerprint,
      output_path: record.output_path,
      output_sha256: record.output_sha256,
      results: record.results ?? null,
    })),
    tests: { total, passed, ids_sha256: createHash('sha256').update(JSON.stringify(ids)).digest('hex') },
    criteria: args.criteria,
    verified_at: new Date().toISOString(),
  };
}
