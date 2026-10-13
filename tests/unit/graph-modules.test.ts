/**
 * A node verifies its own module.
 *
 * CSET-202 r1: the planner gave every per-package node the whole suite
 * (`sh -c 'pnpm build && ... && pnpm vitest run'`) although each owned one
 * package. With module descriptors declared, graph validation selects a
 * node's verification from the module its fence owns: an unscoped
 * whole-repository command for a runtime module is refused, and so is any
 * command outside the repository's allowlist (its module commands and its
 * own repository commands). A module verifier is bound by the module's hash.
 */
import { describe, expect, it } from 'vitest';
import { validateGraph } from '../../src/graph/validate.js';
import { modulesOf, verifierFor } from '../../src/engine/modules.js';
import type { RepositoryDecl } from '../../src/model/types.js';

const FULL = ['sh', '-c', 'pnpm build && git checkout -- packages/config/package.json && pnpm vitest run'];

const repo: RepositoryDecl = {
  name: 'changesets',
  path: '../repos/changesets',
  base_branch: 'main',
  commands: { test: FULL },
  module_defaults: {
    build: [['pnpm', 'build'], ['git', 'checkout', '--', 'packages/config/package.json']],
    test: ['pnpm', 'vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile.json=${REPORT}', '${MODULE_PATH}/'],
    report: { format: 'vitest-json' },
  },
  modules: [
    { id: 'errors', path: 'packages/errors' },
    { id: 'read', path: 'packages/read' },
    { id: 'cli', path: 'packages/cli' },
    { id: 'types', path: 'packages/types', runtime_tests: false, test: ['pnpm', 'tsc'], report: null },
  ],
};
const manifest = { schema_version: 1, repositories: [repo] };
const mod = Object.fromEntries(modulesOf(repo).map((m) => [m.id, m]));
const v = (id: string) => verifierFor(mod[id]!);

function node(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `CSET-202.changesets.${id}`,
    level: 'executable-node',
    repository: 'changesets',
    capability: 'CAP',
    node_type: 'implementation',
    depends_on: [],
    allowed_paths: [`packages/${id}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: mod[id] ? [v(id)] : [],
    worker: { model: 'sonnet', max_turns: 10, max_wall_clock_minutes: 10, max_attempts: 2, nested_delegation: false },
    acceptance_criteria: ['AC-1'],
    ...extra,
  };
}

function graph(...nodes: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema_version: 1,
    feature_id: 'CSET-202',
    title: 'Report every invalid changeset at once',
    acceptance_criteria: [{ id: 'AC-1', text: 'x' }],
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['changesets'],
    capabilities: [{ id: 'CAP', repository: 'changesets', title: 'cap' }],
    nodes,
  };
}

const codes = (g: Record<string, unknown>, repositories: unknown = manifest) => validateGraph(g, { repositories }).problems.map((p) => p.code);

describe('graph validation selects a node verifier from its module', () => {
  it('accepts per-module nodes that each run their own module command, bound by its hash', () => {
    const r = validateGraph(graph(node('errors', {}), node('read', {}), node('cli', {}), node('types', { node_type: 'contract-lock', required_evidence: ['green', 'regression'] })), { repositories: manifest });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses the r1 graph: a runtime module node verified by the repository's whole suite", () => {
    const r = validateGraph(graph(node('errors', { verification_commands: [{ id: 'test', command: FULL }] })), { repositories: manifest });
    expect(r.problems.map((p) => p.code)).toEqual(['UNSCOPED_VERIFICATION']);
    // The detail is the verifier to use instead, ready to paste.
    expect(r.problems[0]!.detail).toContain(JSON.stringify(v('errors')));
  });

  it('refuses a command outside the allowlist (module commands and repository commands)', () => {
    expect(codes(graph(node('errors', { verification_commands: [{ id: 'test', command: ['pnpm', 'vitest', 'run', 'packages/errors'] }] })))).toEqual(
      expect.arrayContaining(['COMMAND_NOT_ALLOWLISTED', 'MODULE_VERIFIER_REQUIRED']),
    );
    // A node in no module (shared paths) may use a repository command, never another.
    const docs = (command: string[]) => graph(node('docs', { allowed_paths: ['docs/**', 'pnpm-lock.yaml'], verification_commands: [{ id: 'check', command }] }));
    expect(codes(docs(FULL))).toEqual([]);
    expect(codes(docs(['node', 'scripts/anything.mjs']))).toEqual(['COMMAND_NOT_ALLOWLISTED']);
    // A second verifier must be allowlisted too.
    expect(codes(graph(node('errors', { verification_commands: [v('errors'), { id: 'extra', command: ['node', '-e', '0'] }] })))).toEqual(['COMMAND_NOT_ALLOWLISTED']);
  });

  it("refuses a module verifier that is not exactly the module's command, a stale hash, an unknown module, another node's module", () => {
    expect(codes(graph(node('errors', { verification_commands: [{ ...v('errors'), command: ['pnpm', 'vitest', 'run', 'packages/errors/'] }] })))).toEqual(['MODULE_COMMAND_MISMATCH']);
    expect(codes(graph(node('errors', { verification_commands: [{ ...v('errors'), module_sha256: 'a'.repeat(64) }] })))).toEqual(['MODULE_DRIFT']);
    expect(codes(graph(node('errors', { verification_commands: [{ ...v('errors'), module: 'nope' }] })))).toEqual(expect.arrayContaining(['UNKNOWN_MODULE']));
    expect(codes(graph(node('cli', { verification_commands: [v('errors')] })))).toEqual(expect.arrayContaining(['MODULE_NOT_OWNED']));
    // A module verifier always carries its hash.
    const { module_sha256: _drop, ...unbound } = v('errors');
    expect(codes(graph(node('errors', { verification_commands: [unbound] })))).not.toEqual([]);
  });

  it('refuses a node whose fence spans two runtime modules; a declaration module beside one is fine', () => {
    expect(codes(graph(node('errors', { allowed_paths: ['packages/errors/**', 'packages/read/**'] })))).toEqual(['MODULE_SPAN']);
    expect(codes(graph(node('cli', { allowed_paths: ['packages/cli/**', 'packages/types/**'] })))).toEqual([]);
  });

  it('holds a declaration-only module node to its own module command too', () => {
    const types = (verifier: unknown) => graph(node('types', { node_type: 'contract-lock', required_evidence: ['green', 'regression'], verification_commands: [verifier] }));
    expect(codes(types(v('types')))).toEqual([]);
    expect(codes(types({ id: 'test', command: FULL }))).toEqual(['UNSCOPED_VERIFICATION']);
  });

  it('leaves a repository without modules as it was: its graph names any command', () => {
    const legacy = { schema_version: 1, repositories: [{ name: 'changesets', path: '../repos/changesets', base_branch: 'main', commands: { test: FULL } }] };
    expect(codes(graph(node('errors', { verification_commands: [{ id: 'test', command: FULL }] })), legacy)).toEqual([]);
    expect(codes(graph(node('errors', { verification_commands: [{ id: 'test', command: ['node', 'x.mjs'] }] })), legacy)).toEqual([]);
    // ... and a module verifier there names a module that does not exist.
    expect(codes(graph(node('errors', {})), legacy)).toEqual(['UNKNOWN_MODULE']);
  });
});
