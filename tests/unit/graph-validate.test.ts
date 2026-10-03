import { describe, expect, it } from 'vitest';
import { clone, VALID_GRAPH, VALID_REPOSITORIES } from '../helpers/graph-fixtures.js';
import {
  validateGraph,
  validateRepositories,
} from '../../src/graph/validate.js';

function codes(result: { problems: { code: string }[] }): string[] {
  return result.problems.map((p) => p.code).sort();
}

describe('repositories manifest validation', () => {
  it('accepts a valid manifest', () => {
    const result = validateRepositories(VALID_REPOSITORIES);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects duplicate repository names', () => {
    const bad = clone(VALID_REPOSITORIES);
    bad.repositories.push(clone(VALID_REPOSITORIES.repositories[0]!));
    expect(codes(validateRepositories(bad))).toContain('DUPLICATE_REPOSITORY');
  });

  it('rejects a repository without a test command', () => {
    const bad = clone(VALID_REPOSITORIES) as unknown as {
      repositories: { commands: Record<string, unknown> }[];
    };
    delete bad.repositories[0]!.commands.test;
    expect(validateRepositories(bad).ok).toBe(false);
  });
});

describe('portfolio graph validation', () => {
  it('accepts the reference 4-layer graph', () => {
    const result = validateGraph(VALID_GRAPH, { repositories: VALID_REPOSITORIES });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('computes a stable graph hash that changes with content', () => {
    const a = validateGraph(VALID_GRAPH, { repositories: VALID_REPOSITORIES });
    const b = validateGraph(clone(VALID_GRAPH), { repositories: VALID_REPOSITORIES });
    expect(a.graphHash).toBe(b.graphHash);

    const changed = clone(VALID_GRAPH);
    changed.nodes[0]!.allowed_paths = ['tests/**', 'docs/**'];
    expect(validateGraph(changed, { repositories: VALID_REPOSITORIES }).graphHash).not.toBe(
      a.graphHash,
    );
  });

  it('rejects a dependency cycle and names the cycle', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[0]!.depends_on = ['FEAT-101.core.publish.impl'];
    const result = validateGraph(bad, { repositories: VALID_REPOSITORIES });
    expect(codes(result)).toContain('DEPENDENCY_CYCLE');
    const cycle = result.problems.find((p) => p.code === 'DEPENDENCY_CYCLE');
    expect(cycle?.detail).toMatch(/FEAT-101\.core\.publish\.(red|impl)/);
  });

  it('rejects a duplicate node id', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes.push(clone(VALID_GRAPH.nodes[0]!));
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'DUPLICATE_NODE_ID',
    );
  });

  it('rejects a dependency on an unknown node', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[1]!.depends_on = ['FEAT-101.nowhere.node'];
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'UNKNOWN_DEPENDENCY',
    );
  });

  it('rejects a node referencing a repository not in the manifest', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[0]!.repository = 'ghost-repo';
    bad.repositories.push('ghost-repo');
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'UNKNOWN_REPOSITORY',
    );
  });

  it('rejects a node requiring a resource that has no declared capacity', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[3]!.required_resources = ['gpu-farm'];
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'UNKNOWN_RESOURCE',
    );
  });

  it('rejects a production node with no verification command', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[1]!.verification_commands = [];
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'MISSING_VERIFIER',
    );
  });

  it('rejects a node whose worker budget is missing or non-positive', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[1]!.worker.max_turns = 0;
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'INVALID_BUDGET',
    );
  });

  it('rejects a node that enables nested delegation', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[1]!.worker.nested_delegation = true;
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'NESTED_DELEGATION_FORBIDDEN',
    );
  });

  it('rejects an implementation node with no allowed paths', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[1]!.allowed_paths = [];
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'MISSING_ALLOWED_PATHS',
    );
  });

  it('rejects an absolute or escaping allowed path', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[1]!.allowed_paths = ['../other-repo/src/**'];
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'PATH_ESCAPES_REPOSITORY',
    );
  });

  it('rejects a contract input that no node in the graph produces', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[1]!.contract_outputs = [];
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'UNPRODUCED_CONTRACT_INPUT',
    );
  });

  it('rejects a consumer that does not depend on its contract producer', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[2]!.depends_on = [];
    const result = validateGraph(bad, { repositories: VALID_REPOSITORIES });
    expect(codes(result)).toContain('CONTRACT_HANDOFF_NOT_ORDERED');
  });

  it('rejects an acceptance criterion with no covering node', () => {
    const bad = clone(VALID_GRAPH);
    bad.acceptance_criteria.push({ id: 'AC-3', text: 'Never implemented' });
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'UNCOVERED_ACCEPTANCE_CRITERION',
    );
  });

  it('rejects a node citing an unknown acceptance criterion', () => {
    const bad = clone(VALID_GRAPH);
    bad.nodes[0]!.acceptance_criteria = ['AC-99'];
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'UNKNOWN_ACCEPTANCE_CRITERION',
    );
  });

  it('rejects a capability bound to a repository outside the feature', () => {
    const bad = clone(VALID_GRAPH);
    bad.capabilities[0]!.repository = 'web';
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'CAPABILITY_REPOSITORY_MISMATCH',
    );
  });

  it('rejects a full-runtime resource with capacity other than 1', () => {
    const bad = clone(VALID_GRAPH);
    bad.resources['full-runtime']!.capacity = 2;
    expect(codes(validateGraph(bad, { repositories: VALID_REPOSITORIES }))).toContain(
      'RUNTIME_CAPACITY_MUST_BE_ONE',
    );
  });

  it('reports a JSON Schema violation rather than throwing', () => {
    const result = validateGraph({ feature_id: 'nope' }, { repositories: VALID_REPOSITORIES });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('SCHEMA');
  });
});
