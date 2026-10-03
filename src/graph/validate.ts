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
  PortfolioGraph,
  Problem,
  RepositoryManifest,
  ValidationResult,
} from '../model/types.js';
import { validateAgainstSchema } from '../schema/registry.js';

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
]);

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
    if (seen.has(repo.name)) {
      problems.push({
        code: 'DUPLICATE_REPOSITORY',
        path: `/repositories/${i}`,
        detail: `Repository "${repo.name}" is declared more than once.`,
      });
    }
    seen.add(repo.name);
  });
  return { ok: problems.length === 0, problems, graphHash: hashGraph(value) };
}

/** A declared path must stay inside its repository and must not be absolute. */
function pathEscapes(p: string): boolean {
  if (p === '') return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true; // C:\...
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  const parts = p.replace(/\\/g, '/').split('/');
  let depth = 0;
  for (const part of parts) {
    if (part === '..') {
      depth--;
      if (depth < 0) return true;
    } else if (part !== '.' && part !== '' && part !== '**') {
      depth++;
    }
  }
  return false;
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

export function validateGraph(
  value: unknown,
  context: GraphValidationContext = {},
): ValidationResult {
  const graphHash = hashGraph(value);
  const problems: Problem[] = validateAgainstSchema('portfolio-graph', value);
  if (problems.length > 0) return { ok: false, problems, graphHash };

  const graph = value as PortfolioGraph;

  let knownRepos: Set<string> | null = null;
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
