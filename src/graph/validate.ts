/**
 * Portfolio graph validation.
 *
 * JSON Schema covers shape; this module enforces the semantics the
 * execution model requires before any node may run:
 * acyclicity, ownership, contract ordering, resource sanity, budget presence,
 * acceptance-criteria traceability and path containment.
 */
import { createHash } from 'node:crypto';
import type {
  GraphNode,
  PortfolioGraph,
  Problem,
  RepositoryDecl,
  RepositoryManifest,
  ValidationResult,
} from '../model/types.js';
import { validateAgainstSchema } from '../schema/registry.js';
import { nodeIdProblem, refNameProblem } from '../security/names.js';
import { classifyLocationPath, classifyRelativePath } from '../security/paths.js';
import { worktreeSetupProblems } from '../engine/worktree-setup.js';
import { moduleProblems, modulesOf, modulesTouched, verifierFor } from '../engine/modules.js';
import { normalizeCriterionKind } from '../engine/criteria.js';

export interface GraphValidationContext {
  repositories?: unknown;
}

/** Node types that edit product code and therefore need an ownership fence. */
const WRITING_NODE_TYPES = new Set(['implementation', 'refactor', 'red-test', 'contract-lock']);

/** Node types that must always carry at least one deterministic verifier. */
const VERIFIED_NODE_TYPES = new Set([
  'contract-lock',
  'red-test',
  'implementation',
  'refactor',
  'regression',
  'integration',
  'candidate-build',
  'runtime-deploy',
  'e2e-scenario',
  'verification',
]);

/** Node types the controller runs itself: no worker, no worktree, nothing written. */
export const CONTROLLER_RUN_NODE_TYPES: ReadonlySet<string> = new Set(['candidate-build', 'e2e-scenario', 'verification']);

/** The evidence a verification node may record: its commands' passes, never a RED. */
const VERIFICATION_EVIDENCE: ReadonlySet<string> = new Set(['green', 'regression']);

/** Resources that must never exceed capacity 1 (single integration server). */
const SINGLETON_RESOURCES = new Set(['full-runtime', 'deploy-slot', 'fixture-global-reset']);

export function hashGraph(graph: unknown): string {
  return createHash('sha256').update(stableStringify(graph)).digest('hex');
}

/** Deterministic JSON serialisation: object keys sorted, arrays order-preserving. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
}

export function validateRepositories(value: unknown): ValidationResult {
  const problems: Problem[] = validateAgainstSchema('repositories', value);
  if (problems.length > 0) {
    return { ok: false, problems, graphHash: hashGraph(value) };
  }
  const manifest = value as RepositoryManifest;
  const seen = new Set<string>();
  manifest.repositories.forEach((repo, i) => {
    const refProblem = refNameProblem(repo.base_branch);
    if (refProblem !== null) {
      problems.push({
        code: 'UNSAFE_REF_NAME',
        path: `/repositories/${i}/base_branch`,
        detail: `Repository "${repo.name}" base branch ${JSON.stringify(repo.base_branch)} is not a safe git ref name: ${refProblem}.`,
      });
    }
    const pathProblem = classifyLocationPath(repo.path);
    if (pathProblem !== null) {
      problems.push({
        code: 'UNSAFE_REPOSITORY_PATH',
        path: `/repositories/${i}/path`,
        detail: `Repository "${repo.name}" path is not allowed (${pathProblem}); use a local relative or absolute path.`,
      });
    }
    if (seen.has(repo.name)) {
      problems.push({
        code: 'DUPLICATE_REPOSITORY',
        path: `/repositories/${i}`,
        detail: `Repository "${repo.name}" is declared more than once.`,
      });
    }
    seen.add(repo.name);
    if (repo.worktree_setup !== undefined) problems.push(...worktreeSetupProblems(repo.worktree_setup, `/repositories/${i}/worktree_setup`));
    problems.push(...moduleProblems(repo, `/repositories/${i}`));
  });
  return { ok: problems.length === 0, problems, graphHash: hashGraph(value) };
}

/**
 * A declared path must stay inside its repository: not absolute, not a UNC,
 * device or extended-length path, not a reserved device name, no traversal.
 */
function pathEscapes(p: string): boolean {
  return classifyRelativePath(p) !== null;
}

function findCycle(nodes: { id: string; depends_on: string[] }[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      const start = stack.indexOf(id);
      return stack.slice(start === -1 ? 0 : start).concat(id);
    }
    if (s === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/** All nodes reachable from `id` by following depends_on edges. */
export function transitiveDependencies(graph: PortfolioGraph, id: string): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const queue = [...(byId.get(id)?.depends_on ?? [])];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (out.has(next)) continue;
    out.add(next);
    for (const dep of byId.get(next)?.depends_on ?? []) queue.push(dep);
  }
  return out;
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** A product producer: a node with a repository that a worker changes, never one the controller runs (engine/acceptance-review.ts gapTargets). */
export const isProductProducer = (n: GraphNode): boolean => n.repository !== null && !CONTROLLER_RUN_NODE_TYPES.has(n.node_type);

/**
 * Every criterion some node names is served by a product producer: the node
 * a gap in it is reworked on. CSET-203 r3's planner gave AC-5 (compatibility)
 * to a verification node alone; the acceptance review found it untested,
 * had no product node to rework, and its other gaps went unrepaired too. A
 * verification node, a candidate build or an E2E scenario may prove a
 * criterion as well, never instead of a producer.
 */
function criterionProducerProblems(graph: PortfolioGraph): Problem[] {
  const problems: Problem[] = [];
  for (const ac of graph.acceptance_criteria) {
    const naming = graph.nodes.filter((n) => (n.acceptance_criteria ?? []).includes(ac.id));
    if (naming.length === 0 || naming.some(isProductProducer)) continue;
    problems.push({
      code: 'CRITERION_NO_PRODUCER',
      path: '/acceptance_criteria',
      detail: `Acceptance criterion "${ac.id}" (${normalizeCriterionKind(ac.kind)}) is served by no product node: only ${naming.map((n) => `${n.id} (${n.node_type})`).join(', ')} name${naming.length === 1 ? 's' : ''} it. Give it to the implementation (or declaration) node whose code it is about, as well: a verification node may prove a criterion by existing tests, never as its only owner, because a gap in it is reworked on the product node that serves it.`,
    });
  }
  return problems;
}

/**
 * Where verification nodes sit and what they may prove: each runs after
 * every producer of its repository (it verifies their integrated work), the
 * candidate build waits for each, and each criterion one carries, whatever
 * its kind, is one an upstream producer serves too (the producer proves it;
 * the verification node proves it again on the integrated state).
 */
function verificationOrderProblems(graph: PortfolioGraph): Problem[] {
  const problems: Problem[] = [];
  const verifications = graph.nodes.filter((n) => n.node_type === 'verification');
  if (verifications.length === 0) return problems;
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const producer = isProductProducer;
  for (const v of verifications) {
    const at = `/nodes/${index.get(v.id) ?? 0}`;
    const upstream = transitiveDependencies(graph, v.id);
    const missing = graph.nodes.filter((n) => producer(n) && n.repository === v.repository && !upstream.has(n.id)).map((n) => n.id);
    if (missing.length > 0) {
      problems.push({
        code: 'VERIFICATION_DEPENDENCY_MISSING',
        path: `${at}/depends_on`,
        detail: `Verification node "${v.id}" verifies the integrated state of repository "${v.repository}", so it must depend (directly or not) on every producer of it; it does not wait for ${missing.join(', ')}.`,
      });
    }
    for (const ac of v.acceptance_criteria ?? []) {
      const kind = normalizeCriterionKind(graph.acceptance_criteria.find((a) => a.id === ac)?.kind);
      const owner = graph.nodes.some((n) => producer(n) && upstream.has(n.id) && (n.acceptance_criteria ?? []).includes(ac));
      if (!owner) {
        problems.push({
          code: 'VERIFICATION_CRITERION_UNOWNED',
          path: `${at}/acceptance_criteria`,
          detail: `Verification node "${v.id}" carries ${ac} (${kind}), which no producer it depends on serves. A criterion is produced by the implementation node that owns its code (a new behaviour by its RED, a compatibility criterion by an existing or regression test its green gate passed, a declaration by its GREEN); a verification node may prove it again on the integrated state, after that node, never as its only owner.`,
        });
      }
    }
  }
  for (const c of graph.nodes.filter((n) => n.node_type === 'candidate-build')) {
    const upstream = transitiveDependencies(graph, c.id);
    const skipped = verifications.filter((v) => !upstream.has(v.id)).map((v) => v.id);
    if (skipped.length > 0) {
      problems.push({
        code: 'VERIFICATION_NOT_BEFORE_CANDIDATE',
        path: `/nodes/${index.get(c.id) ?? 0}/depends_on`,
        detail: `Candidate build "${c.id}" must depend (directly or not) on every verification node: a candidate binds only verified work; it does not wait for ${skipped.join(', ')}.`,
      });
    }
  }
  return problems;
}

/**
 * Where a repository declares modules, a node's verifiers come from its
 * allowlist — each module's command (bound by `module` and its hash) and
 * the repository's own commands — and a writing node that owns a module
 * verifies first with that module's command: a whole-repository command
 * there is unscoped. One node owns at most one runtime module.
 */
function nodeModuleProblems(node: GraphNode, decl: RepositoryDecl, at: string): Problem[] {
  const out: Problem[] = [];
  const modules = modulesOf(decl);
  const byId = new Map(modules.map((m) => [m.id, m]));
  const repoCommands = Object.values(decl.commands).filter((c): c is string[] => Array.isArray(c));
  const isRepoCommand = (command: readonly string[]): boolean => repoCommands.some((c) => sameArgv(c, command));
  const touched = modulesTouched(modules, node.allowed_paths);
  const problem = (code: string, detail: string): void => {
    out.push({ code, path: at, detail: `Node "${node.id}": ${detail}` });
  };
  for (const v of node.verification_commands) {
    if (v.module === undefined) {
      if (modules.length > 0 && (v.shell === true || !isRepoCommand(v.command))) {
        problem('COMMAND_NOT_ALLOWLISTED', `verifier "${v.id}" runs ${JSON.stringify(v.command)}, which is neither a module command nor a command of repository "${decl.name}"; select one from \`mycelink repo modules\``);
      }
      continue;
    }
    const m = byId.get(v.module);
    if (m === undefined) {
      problem('UNKNOWN_MODULE', `verifier "${v.id}" names module "${v.module}", which repository "${decl.name}" does not declare`);
      continue;
    }
    if (v.shell === true || v.cwd !== undefined || !sameArgv(v.command, m.test)) {
      problem('MODULE_COMMAND_MISMATCH', `verifier "${v.id}" names module "${m.id}" but is not exactly its command; use ${JSON.stringify(verifierFor(m))}`);
    } else if (v.module_sha256 !== m.sha256) {
      problem('MODULE_DRIFT', `verifier "${v.id}" was planned against module "${m.id}" ${String(v.module_sha256).slice(0, 12)}, but repository "${decl.name}" now declares it as ${m.sha256.slice(0, 12)}; restore the module, or plan again with ${JSON.stringify(verifierFor(m))}`);
    }
    // A verification node owns no module: it runs any module's command, read-only.
    if (!touched.includes(m) && node.node_type !== 'verification') problem('MODULE_NOT_OWNED', `verifier "${v.id}" runs module "${m.id}", which the node's allowed_paths do not reach`);
  }
  if (modules.length === 0 || !WRITING_NODE_TYPES.has(node.node_type)) return out;
  const runtime = touched.filter((m) => m.runtime_tests);
  if (runtime.length > 1) {
    problem('MODULE_SPAN', `allowed_paths reach the runtime modules ${runtime.map((m) => m.id).join(', ')}; one node owns one module, so its gates run that module's tests (split the node)`);
    return out;
  }
  const owned = runtime[0] ?? (touched.length === 1 ? touched[0] : undefined);
  const first = node.verification_commands[0];
  if (owned === undefined || first === undefined || first.module !== undefined) return out;
  if (isRepoCommand(first.command)) {
    problem('UNSCOPED_VERIFICATION', `owns module "${owned.id}" but verifies with repository "${decl.name}"'s whole-suite command; the gates run the module's own tests (the full suite stays regression's). Use ${JSON.stringify(verifierFor(owned))}`);
  } else {
    problem('MODULE_VERIFIER_REQUIRED', `owns module "${owned.id}"; its first verifier must be the module's command: ${JSON.stringify(verifierFor(owned))}`);
  }
  return out;
}

export function validateGraph(
  value: unknown,
  context: GraphValidationContext = {},
): ValidationResult {
  const graphHash = hashGraph(value);
  const problems: Problem[] = validateAgainstSchema('portfolio-graph', value);
  if (problems.length > 0) return { ok: false, problems, graphHash };

  const graph = value as PortfolioGraph;

  let knownRepos: Set<string> | null = null;
  let repoDecls: Map<string, RepositoryDecl> | null = null;
  if (context.repositories !== undefined) {
    const repoResult = validateRepositories(context.repositories);
    if (!repoResult.ok) {
      problems.push({
        code: 'INVALID_REPOSITORY_MANIFEST',
        path: '/repositories',
        detail: repoResult.problems.map((p) => `${p.code}:${p.detail}`).join('; '),
      });
    } else {
      knownRepos = new Set(
        (context.repositories as RepositoryManifest).repositories.map((r) => r.name),
      );
      repoDecls = new Map((context.repositories as RepositoryManifest).repositories.map((r) => [r.name, r]));
    }
  }

  const featureRepos = new Set(graph.repositories);
  const acIds = new Set(graph.acceptance_criteria.map((a) => a.id));
  const capById = new Map(graph.capabilities.map((c) => [c.id, c]));

  // ---- repository layer -------------------------------------------------
  for (const [i, repo] of graph.repositories.entries()) {
    if (knownRepos && !knownRepos.has(repo)) {
      problems.push({
        code: 'UNKNOWN_REPOSITORY',
        path: `/repositories/${i}`,
        detail: `Feature repository "${repo}" is not in the portfolio manifest.`,
      });
    }
  }

  // ---- capability layer -------------------------------------------------
  const capSeen = new Set<string>();
  graph.capabilities.forEach((cap, i) => {
    if (capSeen.has(cap.id)) {
      problems.push({
        code: 'DUPLICATE_CAPABILITY_ID',
        path: `/capabilities/${i}`,
        detail: `Capability "${cap.id}" is declared more than once.`,
      });
    }
    capSeen.add(cap.id);
    if (!featureRepos.has(cap.repository)) {
      problems.push({
        code: 'CAPABILITY_REPOSITORY_MISMATCH',
        path: `/capabilities/${i}/repository`,
        detail: `Capability "${cap.id}" targets repository "${cap.repository}" which this feature does not include.`,
      });
    }
    for (const ac of cap.acceptance_criteria ?? []) {
      if (!acIds.has(ac)) {
        problems.push({
          code: 'UNKNOWN_ACCEPTANCE_CRITERION',
          path: `/capabilities/${i}/acceptance_criteria`,
          detail: `Capability "${cap.id}" cites unknown acceptance criterion "${ac}".`,
        });
      }
    }
  });

  // ---- resource layer ---------------------------------------------------
  for (const [name, decl] of Object.entries(graph.resources)) {
    if (SINGLETON_RESOURCES.has(name) && decl.capacity !== 1) {
      problems.push({
        code: 'RUNTIME_CAPACITY_MUST_BE_ONE',
        path: `/resources/${name}/capacity`,
        detail: `"${name}" must have capacity 1; only one full runtime can exist at a time.`,
      });
    }
  }

  // ---- node layer -------------------------------------------------------
  const nodeIds = new Set<string>();
  const producersByContract = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const out of node.contract_outputs ?? []) {
      producersByContract.set(out, [...(producersByContract.get(out) ?? []), node.id]);
    }
  }

  const coveredAcs = new Set<string>();

  graph.nodes.forEach((node, i) => {
    const at = (suffix = '') => `/nodes/${i}${suffix}`;

    if (nodeIds.has(node.id)) {
      problems.push({
        code: 'DUPLICATE_NODE_ID',
        path: at('/id'),
        detail: `Node id "${node.id}" is declared more than once.`,
      });
    }
    nodeIds.add(node.id);

    const idProblem = nodeIdProblem(node.id);
    if (idProblem !== null) {
      problems.push({
        code: 'UNSAFE_NODE_ID',
        path: at('/id'),
        detail: `Node id ${JSON.stringify(node.id)} is unsafe as a branch or directory name: ${idProblem}.`,
      });
    }

    if (!node.id.startsWith(graph.feature_id + '.')) {
      problems.push({
        code: 'NODE_ID_FEATURE_MISMATCH',
        path: at('/id'),
        detail: `Node id "${node.id}" must be prefixed with the feature id "${graph.feature_id}.".`,
      });
    }

    if (node.repository !== null) {
      if (!featureRepos.has(node.repository)) {
        problems.push({
          code: 'UNKNOWN_REPOSITORY',
          path: at('/repository'),
          detail: `Node "${node.id}" targets repository "${node.repository}" which this feature does not include.`,
        });
      } else if (knownRepos && !knownRepos.has(node.repository)) {
        problems.push({
          code: 'UNKNOWN_REPOSITORY',
          path: at('/repository'),
          detail: `Node "${node.id}" targets repository "${node.repository}" which is not in the portfolio manifest.`,
        });
      }
    }

    if (node.capability !== null) {
      const cap = capById.get(node.capability);
      if (!cap) {
        problems.push({
          code: 'UNKNOWN_CAPABILITY',
          path: at('/capability'),
          detail: `Node "${node.id}" references unknown capability "${node.capability}".`,
        });
      } else if (node.repository !== null && cap.repository !== node.repository) {
        problems.push({
          code: 'CAPABILITY_REPOSITORY_MISMATCH',
          path: at('/capability'),
          detail: `Node "${node.id}" is in "${node.repository}" but capability "${cap.id}" belongs to "${cap.repository}".`,
        });
      }
    }

    for (const dep of node.depends_on) {
      if (!graph.nodes.some((n) => n.id === dep)) {
        problems.push({
          code: 'UNKNOWN_DEPENDENCY',
          path: at('/depends_on'),
          detail: `Node "${node.id}" depends on unknown node "${dep}".`,
        });
      }
    }

    for (const res of node.required_resources) {
      if (!(res in graph.resources)) {
        problems.push({
          code: 'UNKNOWN_RESOURCE',
          path: at('/required_resources'),
          detail: `Node "${node.id}" requires resource "${res}" which has no declared capacity.`,
        });
      }
    }

    if (VERIFIED_NODE_TYPES.has(node.node_type) && node.verification_commands.length === 0) {
      problems.push({
        code: 'MISSING_VERIFIER',
        path: at('/verification_commands'),
        detail: `Node "${node.id}" (${node.node_type}) has no deterministic verification command.`,
      });
    }

    const w = node.worker;
    if (
      w.max_turns <= 0 ||
      w.max_attempts <= 0 ||
      w.max_wall_clock_minutes <= 0 ||
      (w.max_same_failure !== undefined && w.max_same_failure <= 0)
    ) {
      problems.push({
        code: 'INVALID_BUDGET',
        path: at('/worker'),
        detail: `Node "${node.id}" has a non-positive worker budget; every loop needs a real stop condition.`,
      });
    }
    if (w.nested_delegation) {
      problems.push({
        code: 'NESTED_DELEGATION_FORBIDDEN',
        path: at('/worker/nested_delegation'),
        detail: `Node "${node.id}" enables nested delegation; recursive agent spawning is forbidden.`,
      });
    }

    if (WRITING_NODE_TYPES.has(node.node_type)) {
      if (node.repository === null) {
        problems.push({
          code: 'WRITING_NODE_NEEDS_REPOSITORY',
          path: at('/repository'),
          detail: `Node "${node.id}" writes code and must name its repository.`,
        });
      }
      if (node.allowed_paths.length === 0) {
        problems.push({
          code: 'MISSING_ALLOWED_PATHS',
          path: at('/allowed_paths'),
          detail: `Node "${node.id}" writes code and must declare allowed_paths.`,
        });
      }
    } else if (!CONTROLLER_RUN_NODE_TYPES.has(node.node_type) && node.repository !== null && node.allowed_paths.length === 0) {
      // CSET-203 r1 with-faults: a worker dispatched to a node it may change nothing in ran its gates,
      // committed nothing and was refused (NO_DECLARATION_COMMIT) until the node BLOCKED.
      problems.push({
        code: 'WORKER_NODE_CHANGES_NOTHING',
        path: at('/node_type'),
        detail: `Node "${node.id}" (${node.node_type}) has a repository but no allowed_paths: a worker could only submit nothing. To prove existing behaviour (a compatibility or regression check) without changing product code, make it node_type: verification; the controller runs its commands itself.`,
      });
    }

    if (node.node_type === 'verification') {
      if (node.repository === null) {
        problems.push({
          code: 'VERIFICATION_NEEDS_REPOSITORY',
          path: at('/repository'),
          detail: `Verification node "${node.id}" must name the repository whose integrated state it checks out and verifies.`,
        });
      }
      if (node.allowed_paths.length > 0) {
        problems.push({
          code: 'VERIFICATION_NODE_WRITES',
          path: at('/allowed_paths'),
          detail: `Verification node "${node.id}" changes nothing: its allowed_paths must be empty (a change, with its RED, belongs to an implementation node).`,
        });
      }
      const evidence = node.required_evidence;
      if (evidence.length === 0 || evidence.some((k) => !VERIFICATION_EVIDENCE.has(k))) {
        problems.push({
          code: 'VERIFICATION_EVIDENCE',
          path: at('/required_evidence'),
          detail: `Verification node "${node.id}" requires ${JSON.stringify(evidence)}; it records what its commands passed, so its evidence is green and/or regression (e.g. [regression]), never a RED.`,
        });
      }
    }

    for (const p of [...node.allowed_paths, ...(node.forbidden_paths ?? [])]) {
      if (pathEscapes(p)) {
        problems.push({
          code: 'PATH_ESCAPES_REPOSITORY',
          path: at('/allowed_paths'),
          detail: `Node "${node.id}" declares path "${p}", which is absolute or escapes the repository root.`,
        });
      }
    }

    for (const v of node.verification_commands) {
      if (v.cwd !== undefined && pathEscapes(v.cwd)) {
        problems.push({
          code: 'PATH_ESCAPES_REPOSITORY',
          path: at('/verification_commands'),
          detail: `Node "${node.id}" verifier "${v.id}" runs in "${v.cwd}", which is absolute or escapes the repository.`,
        });
      }
    }

    // Module-scoped verification: a node runs its own module's command, from the repository's allowlist.
    const decl = node.repository !== null ? repoDecls?.get(node.repository) : undefined;
    if (decl !== undefined) problems.push(...nodeModuleProblems(node, decl, at('/verification_commands')));

    for (const p of [...(node.contract_inputs ?? []), ...(node.contract_outputs ?? [])]) {
      if (pathEscapes(p)) {
        problems.push({
          code: 'PATH_ESCAPES_CONTROL_REPOSITORY',
          path: at('/contract_inputs'),
          detail: `Node "${node.id}" declares contract "${p}", which is absolute or escapes the control repository.`,
        });
      }
    }

    if (node.node_type === 'implementation' && !node.required_evidence.includes('red')) {
      problems.push({
        code: 'IMPLEMENTATION_REQUIRES_RED',
        path: at('/required_evidence'),
        detail: `Node "${node.id}" is an implementation node and must require RED evidence.`,
      });
    }

    for (const ac of node.acceptance_criteria ?? []) {
      if (!acIds.has(ac)) {
        problems.push({
          code: 'UNKNOWN_ACCEPTANCE_CRITERION',
          path: at('/acceptance_criteria'),
          detail: `Node "${node.id}" cites unknown acceptance criterion "${ac}".`,
        });
      }
      coveredAcs.add(ac);
    }

    // Contract handoff: a consumer must both have a producer and depend on it.
    for (const input of node.contract_inputs ?? []) {
      const producers = (producersByContract.get(input) ?? []).filter((p) => p !== node.id);
      if (producers.length === 0) {
        problems.push({
          code: 'UNPRODUCED_CONTRACT_INPUT',
          path: at('/contract_inputs'),
          detail: `Node "${node.id}" consumes contract "${input}" that no node in this graph produces.`,
        });
        continue;
      }
      const reachable = transitiveDependencies(graph, node.id);
      if (!producers.some((p) => reachable.has(p))) {
        problems.push({
          code: 'CONTRACT_HANDOFF_NOT_ORDERED',
          path: at('/depends_on'),
          detail:
            `Node "${node.id}" consumes contract "${input}" but does not (transitively) depend on ` +
            `its producer(s): ${producers.join(', ')}.`,
        });
      }
    }
  });

  for (const ac of acIds) {
    if (!coveredAcs.has(ac)) {
      problems.push({
        code: 'UNCOVERED_ACCEPTANCE_CRITERION',
        path: '/acceptance_criteria',
        detail: `Acceptance criterion "${ac}" is not covered by any graph node.`,
      });
    }
  }

  problems.push(...criterionProducerProblems(graph));
  problems.push(...verificationOrderProblems(graph));

  const cycle = findCycle(graph.nodes);
  if (cycle) {
    problems.push({
      code: 'DEPENDENCY_CYCLE',
      path: '/nodes',
      detail: `Dependency cycle: ${cycle.join(' -> ')}`,
    });
  }

  return { ok: problems.length === 0, problems, graphHash };
}
