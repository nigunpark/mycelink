/**
 * Verification nodes: compatibility proven by existing tests, run by the controller.
 *
 * CSET-203 r1 with-faults: the planner gave AC-5 ("a run that succeeds
 * produces exactly the same files as today ...") a node of its own,
 * `compat.regression` — a `regression` worker node with no allowed paths,
 * the full suite as its verifier. Both producers reached DONE; the controller
 * dispatched a module-worker to it, the worker ran green and regression,
 * changed nothing and submitted, and settle refused its history
 * (NO_DECLARATION_COMMIT) twice: the node BLOCKED and nothing was delivered.
 * A proof that changes no product code is a controller operation, never a
 * worker's no-op commit. The graph now says so:
 *
 *  - `node_type: verification`: a repository, no allowed paths (it writes
 *    nothing), green and/or regression evidence only (never a RED), every
 *    verifier from the repository's allowlist (any module's command, or a
 *    repository command: it owns no module, it reads them);
 *  - it depends, directly or not, on every producer of its repository, and
 *    the candidate build depends on it;
 *  - every criterion it carries, compatibility included, is one an upstream
 *    product producer serves too: it proves again, never alone (CSET-203 r3
 *    gave AC-5 to its verification node alone, and a gap in it had no node
 *    to rework);
 *  - a worker node with a repository and no allowed paths can only ever
 *    submit nothing: refused, pointing at a verification node.
 */
import { describe, expect, it } from 'vitest';
import { clone } from '../helpers/graph-fixtures.js';
import { validateGraph } from '../../src/graph/validate.js';
import { modulesOf, verifierFor } from '../../src/engine/modules.js';
import type { RepositoryDecl } from '../../src/model/types.js';
import { escapeRegExp } from '../helpers/regex.js';

const FULL_SUITE = ['sh', '-c', 'pnpm build && git checkout -- packages/config/package.json && pnpm vitest run'];

const REPO: RepositoryDecl = {
  name: 'changesets',
  path: '../repos/changesets',
  base_branch: 'main',
  commands: { test: FULL_SUITE },
  module_defaults: {
    build: [['pnpm', 'build']],
    test: ['pnpm', 'vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile.json=${REPORT}', '${MODULE_PATH}/'],
    report: { format: 'vitest-json' },
    timeout_seconds: 1800,
  },
  modules: [
    { id: 'apply-release-plan', path: 'packages/apply-release-plan' },
    { id: 'cli', path: 'packages/cli' },
    { id: 'types', path: 'packages/types', runtime_tests: false, test: ['pnpm', 'tsc'], report: null },
  ],
};
const REPOSITORIES = { schema_version: 1, repositories: [REPO] };
const verifier = (id: string) => verifierFor(modulesOf(REPO).find((m) => m.id === id)!);

const ARP = 'CSET-203.changesets.apply-release-plan.crash-safe';
const CLI = 'CSET-203.changesets.cli.version-recovery';
const COMPAT = 'CSET-203.changesets.compat.regression';
const CANDIDATE = 'CSET-203.candidate.build';

const worker = { model: 'sonnet', effort: 'high', max_turns: 40, max_wall_clock_minutes: 60, max_attempts: 2, nested_delegation: false };

type Node = Record<string, any>;

/** CSET-203 as the with-faults planner wrote it, but with its compatibility node a verification node. */
function graph(): { acceptance_criteria: Node[]; nodes: Node[]; [k: string]: unknown } {
  const impl = (id: string, module: string, extra: Node): Node => ({
    id,
    level: 'executable-node',
    repository: 'changesets',
    capability: module === 'cli' ? 'CAP-CLI' : 'CAP-ARP',
    node_type: 'implementation',
    allowed_paths: [`packages/${module}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [verifier(module)],
    worker,
    invalidation_rules: [],
    ...extra,
  });
  return {
    schema_version: 1,
    feature_id: 'CSET-203',
    title: 'Crash-safe changeset version',
    acceptance_criteria: [
      { id: 'AC-1', kind: 'new-behavior', text: 'rollback (apply-release-plan)' },
      { id: 'AC-2', kind: 'new-behavior', text: 'journal (apply-release-plan)' },
      { id: 'AC-3', kind: 'new-behavior', text: 'recovery (CLI)' },
      { id: 'AC-4', kind: 'new-behavior', text: 'failure (CLI)' },
      { id: 'AC-5', kind: 'compatibility', text: 'a run that succeeds produces exactly the same files as today' },
    ],
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['changesets'],
    capabilities: [
      { id: 'CAP-ARP', repository: 'changesets', title: 'roll back and journal', acceptance_criteria: ['AC-1', 'AC-2'] },
      { id: 'CAP-CLI', repository: 'changesets', title: 'recover and fail cleanly', acceptance_criteria: ['AC-3', 'AC-4', 'AC-5'] },
      { id: 'CAP-COMPAT', repository: 'changesets', title: 'successful runs, status and add unchanged', acceptance_criteria: ['AC-5'] },
    ],
    nodes: [
      impl(ARP, 'apply-release-plan', { depends_on: [], acceptance_criteria: ['AC-1', 'AC-2'] }),
      impl(CLI, 'cli', { depends_on: [ARP], acceptance_criteria: ['AC-3', 'AC-4', 'AC-5'] }),
      {
        id: COMPAT,
        level: 'executable-node',
        repository: 'changesets',
        capability: 'CAP-COMPAT',
        node_type: 'verification',
        depends_on: [ARP, CLI],
        allowed_paths: [],
        forbidden_paths: ['packages/**'],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['regression'],
        verification_commands: [verifier('apply-release-plan'), verifier('cli'), { id: 'full-suite', command: FULL_SUITE }],
        worker: { ...worker, effort: 'medium', max_turns: 15 },
        invalidation_rules: [{ when: 'any upstream node result changes', action: 'RERUN_REGRESSION' }],
        acceptance_criteria: ['AC-5'],
      },
      {
        id: CANDIDATE,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: [ARP, CLI, COMPAT],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', 'CSET-203'] }],
        worker: { ...worker, max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

const node = (g: ReturnType<typeof graph>, id: string): Node => g.nodes.find((n) => n['id'] === id)!;
const validate = (g: unknown) => validateGraph(g, { repositories: REPOSITORIES });
const codes = (g: unknown): string[] => validate(g).problems.map((p) => p.code).sort();

describe('a verification node proves compatibility by existing tests, without a worker', () => {
  it('accepts a compatibility node that runs any module of its repository and the full suite, after every producer, before the candidate', () => {
    const result = validate(graph());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts r1's exact compat node once it is a verification node: green and regression, the full suite alone, no candidate build", () => {
    const g = graph();
    g.nodes = g.nodes.filter((n) => n['id'] !== CANDIDATE);
    Object.assign(node(g, COMPAT), { required_evidence: ['green', 'regression'], verification_commands: [{ id: 'full-suite', command: FULL_SUITE }] });
    expect(validate(g).problems).toEqual([]);
  });

  it("refuses r1's exact compat node as a regression worker: a worker with no allowed paths can only submit nothing", () => {
    const g = graph();
    g.nodes = g.nodes.filter((n) => n['id'] !== CANDIDATE);
    Object.assign(node(g, COMPAT), { node_type: 'regression', required_evidence: ['green', 'regression'], verification_commands: [{ id: 'full-suite', command: FULL_SUITE }] });
    const result = validate(g);
    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.code === 'WORKER_NODE_CHANGES_NOTHING');
    expect(problem?.detail).toMatch(new RegExp(`${escapeRegExp(COMPAT)}.*node_type: verification`));
    for (const type of ['review', 'integration', 'knowledge', 'runtime-deploy']) {
      Object.assign(node(g, COMPAT), { node_type: type });
      expect(codes(g), type).toContain('WORKER_NODE_CHANGES_NOTHING');
    }
  });

  it('refuses a verification node that would write: its allowed paths stay empty', () => {
    const g = graph();
    node(g, COMPAT)['allowed_paths'] = ['packages/cli/**'];
    expect(codes(g)).toContain('VERIFICATION_NODE_WRITES');
  });

  it('refuses a verification node without a repository: there would be nothing to check out', () => {
    const g = graph();
    Object.assign(node(g, COMPAT), { repository: null, capability: null });
    expect(codes(g)).toContain('VERIFICATION_NEEDS_REPOSITORY');
  });

  it.each([
    [['red', 'green', 'regression']],
    [['regression', 'review']],
    [['candidate']],
    [[]],
  ])('refuses a verification node whose evidence is %j: green and/or regression only, never a RED', (required) => {
    const g = graph();
    node(g, COMPAT)['required_evidence'] = required;
    expect(codes(g)).toContain('VERIFICATION_EVIDENCE');
  });

  it('refuses a verification node with no command', () => {
    const g = graph();
    node(g, COMPAT)['verification_commands'] = [];
    expect(codes(g)).toContain('MISSING_VERIFIER');
  });

  it("runs only the repository's allowlist: a module's own command (any module: it owns none), or a repository command", () => {
    const g = graph();
    expect(validate(g).problems.filter((p) => p.code === 'MODULE_NOT_OWNED')).toEqual([]);
    node(g, COMPAT)['verification_commands'] = [{ id: 'adhoc', command: ['pnpm', 'vitest', 'run'] }];
    expect(codes(g)).toContain('COMMAND_NOT_ALLOWLISTED');
    const drift = graph();
    node(drift, COMPAT)['verification_commands'] = [{ ...verifier('cli'), module_sha256: 'e'.repeat(64) }];
    expect(codes(drift)).toContain('MODULE_DRIFT');
  });

  it('refuses a verification node that does not come after every producer of its repository', () => {
    const transitive = graph();
    node(transitive, COMPAT)['depends_on'] = [CLI];
    expect(validate(transitive).problems).toEqual([]);
    const g = graph();
    node(g, COMPAT)['depends_on'] = [ARP];
    const result = validate(g);
    expect(result.problems.map((p) => p.code)).toContain('VERIFICATION_DEPENDENCY_MISSING');
    expect(result.problems.find((p) => p.code === 'VERIFICATION_DEPENDENCY_MISSING')?.detail).toContain(CLI);
  });

  it('refuses a candidate build that does not wait for a verification node', () => {
    const g = graph();
    node(g, CANDIDATE)['depends_on'] = [ARP, CLI];
    const result = validate(g);
    expect(result.problems.map((p) => p.code)).toContain('VERIFICATION_NOT_BEFORE_CANDIDATE');
    expect(result.problems.find((p) => p.code === 'VERIFICATION_NOT_BEFORE_CANDIDATE')?.detail).toContain(COMPAT);
  });

  it('a new behaviour on a verification node only when an upstream producer owns it; a declaration likewise', () => {
    const owned = graph();
    node(owned, COMPAT)['acceptance_criteria'] = ['AC-4', 'AC-5'];
    expect(validate(owned).problems).toEqual([]);

    const unowned = graph();
    unowned.acceptance_criteria.push({ id: 'AC-6', text: 'status explains a journal' });
    node(unowned, COMPAT)['acceptance_criteria'] = ['AC-5', 'AC-6'];
    const result = validate(unowned);
    expect(result.problems.map((p) => p.code).sort()).toEqual(['CRITERION_NO_PRODUCER', 'VERIFICATION_CRITERION_UNOWNED']);
    expect(result.problems.find((p) => p.code === 'VERIFICATION_CRITERION_UNOWNED')?.detail).toMatch(/AC-6 \(new-behavior\)/);

    const declaration = graph();
    declaration.acceptance_criteria.push({ id: 'AC-6', kind: 'declaration', text: 'the journal type is declared' });
    node(declaration, COMPAT)['acceptance_criteria'] = ['AC-5', 'AC-6'];
    expect(codes(declaration)).toEqual(['CRITERION_NO_PRODUCER', 'VERIFICATION_CRITERION_UNOWNED']);

    // Owned, but by a producer that runs after the verification node: not upstream.
    const later = graph();
    later.acceptance_criteria.push({ id: 'AC-6', text: 'status explains a journal' });
    later.nodes.push({ ...clone(node(later, CLI)), id: 'CSET-203.changesets.cli.status', depends_on: [COMPAT], acceptance_criteria: ['AC-6'], allowed_paths: ['packages/cli/src/commands/status/**'] });
    node(later, COMPAT)['acceptance_criteria'] = ['AC-5', 'AC-6'];
    expect(codes(later)).toEqual(expect.arrayContaining(['VERIFICATION_CRITERION_UNOWNED']));
  });

  it('a compatibility criterion on the verification node alone has no product producer (r3): refused', () => {
    const g = graph();
    node(g, CLI)['acceptance_criteria'] = ['AC-3', 'AC-4'];
    expect(codes(g)).toEqual(['CRITERION_NO_PRODUCER', 'VERIFICATION_CRITERION_UNOWNED']);
    // The cli producing it is enough on its own; on no node at all it is uncovered.
    const producerOnly = graph();
    node(producerOnly, COMPAT)['acceptance_criteria'] = [];
    expect(validate(producerOnly).problems).toEqual([]);
    node(producerOnly, CLI)['acceptance_criteria'] = ['AC-3', 'AC-4'];
    expect(codes(producerOnly)).toEqual(['UNCOVERED_ACCEPTANCE_CRITERION']);
  });
});
