/**
 * A complete, tiny benchmark project for the harness's own CI-safe tests:
 * a two-module `node --test` project ("toyshop") frozen in a git bundle,
 * its adapter and source lock, one PRD that spans both modules, and an
 * evaluator authoring repository with `hidden/`, `reference/` and
 * `mutant/` branches — the same shape the real projects use.
 *
 * It is a fixture for testing the harness, not a benchmark case.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
// @ts-expect-error -- plain ESM module without type declarations
import { findPrd, loadSuite, sourceIdentity } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { describeCommit } from '../../evals-public-projects/lib/source.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { importEvaluator } from '../../evals-public-projects/lib/evaluator.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { baselineRecord, runFrozenBaseline } from '../../evals-public-projects/lib/baseline.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { createAdapter } from '../../evals-public-projects/lib/adapters/index.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { qualifyPrd } from '../../evals-public-projects/lib/qualify.mjs';

export const TOY_PRD = 'TOY-001';

let tick = 0;
export function toyGit(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  tick += 1;
  const date = new Date(Date.UTC(2026, 2, 1, 0, tick)).toISOString();
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Toy',
      GIT_AUTHOR_EMAIL: 'toy@example.invalid',
      GIT_COMMITTER_NAME: 'Toy',
      GIT_COMMITTER_EMAIL: 'toy@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '',
      ...extraEnv,
    },
  }).trim();
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

export function commitFiles(repo: string, files: Record<string, string>, message: string): string {
  writeTree(repo, files);
  toyGit(repo, ['add', '-A']);
  toyGit(repo, ['commit', '-q', '-m', message]);
  return toyGit(repo, ['rev-parse', 'HEAD']);
}

const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
export const TOY = {
  upstream: {
    'LICENSE': 'MIT License (toy fixture)\n',
    'README.md': '# toyshop\n',
    'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock, reserved: 0 };\n}\n',
    'mod-a/test/stock.test.mjs': `${T}import { reserve } from '../src/stock.mjs';\ntest('reserve keeps the result shape', () => {\n  assert.deepEqual(Object.keys(reserve(1, 0)).sort(), ['reserved', 'stock']);\n});\n`,
    'mod-b/src/orders.mjs': "import { reserve } from '../../mod-a/src/stock.mjs';\nexport function placeOrder(stock, qty) {\n  reserve(stock, qty);\n  return { status: 'placed' };\n}\n",
    'mod-b/test/orders.test.mjs': `${T}import { placeOrder } from '../src/orders.mjs';\ntest('an order is placed', () => {\n  assert.equal(placeOrder(5, 1).status, 'placed');\n});\n`,
  },
  hidden: {
    'mod-a/test/reserve.acceptance.test.mjs': `${T}import { reserve } from '../src/stock.mjs';\ntest('AC-1 reserving reduces the stock', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });\n});\ntest('AC-1 compat: reserving nothing keeps the stock', () => {\n  assert.equal(reserve(4, 0).stock, 4);\n});\n`,
    'mod-b/test/orders.acceptance.test.mjs': `${T}import { placeOrder } from '../src/orders.mjs';\ntest('AC-2 an order reports the remaining stock', () => {\n  assert.deepEqual(placeOrder(5, 2), { status: 'placed', stock: 3 });\n});\ntest('AC-2 an order larger than the stock is rejected', () => {\n  assert.deepEqual(placeOrder(1, 2), { status: 'rejected', stock: 1 });\n});\n`,
  },
  referenceTests: {
    'mod-a/test/reserve.test.mjs': `${T}import { reserve } from '../src/stock.mjs';\ntest('reserve takes the quantity out of the stock', () => {\n  assert.deepEqual(reserve(10, 3), { stock: 7, reserved: 3 });\n});\n`,
    'mod-b/test/place.test.mjs': `${T}import { placeOrder } from '../src/orders.mjs';\ntest('placing an order returns the remaining stock', () => {\n  assert.deepEqual(placeOrder(3, 1), { status: 'placed', stock: 2 });\n});\ntest('placing too large an order is rejected', () => {\n  assert.equal(placeOrder(0, 1).status, 'rejected');\n});\n`,
  },
  referenceCode: {
    'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock: stock - qty, reserved: qty };\n}\n',
    'mod-b/src/orders.mjs':
      "import { reserve } from '../../mod-a/src/stock.mjs';\nexport function placeOrder(stock, qty) {\n  if (qty > stock) return { status: 'rejected', stock };\n  return { status: 'placed', stock: reserve(stock, qty).stock };\n}\n",
  },
  mutants: {
    'no-reduce': { 'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock, reserved: qty };\n}\n' },
    'no-reject': {
      'mod-b/src/orders.mjs': "import { reserve } from '../../mod-a/src/stock.mjs';\nexport function placeOrder(stock, qty) {\n  return { status: 'placed', stock: reserve(stock, qty).stock };\n}\n",
    },
  },
};

export const TOY_ADAPTER = {
  schema: 'mycelink-bench/project-adapter@1',
  id: 'toyshop',
  name: 'Toy shop (harness fixture)',
  implementation: 'node-test',
  source_lock: 'source.lock.json',
  workspace: { repo_dir: 'repos/toyshop', branch: 'main' },
  modules: [
    { id: 'mod-a', path: 'mod-a', description: 'stock' },
    { id: 'mod-b', path: 'mod-b', description: 'orders' },
  ],
  shared_paths: ['README.md', 'LICENSE'],
  test_paths: ['*/test/**'],
  toolchain: { runtime: 'node', versions: { node: process.versions.node }, cache: { kind: 'none', dir: '' } },
  env: { TZ: 'UTC' },
  commands: { timeout_seconds: 120 },
  tolerated_build_mutations: [],
  baseline_exclusions: [],
  harness: { frozen: ['package.json'], forbidden_new: ['**/package.json', '**/.noderc*'], framework_modules: ['node:test', 'node:assert', 'node:assert/strict', 'assert', 'assert/strict'], manifests: 'none' },
  workspace_notes: ['Run `node --test` from a module directory.'],
};

export const TOY_CASE = {
  schema: 'mycelink-bench/prd-case@1',
  id: TOY_PRD,
  case: 'toyshop-reserve-stock',
  project: 'toyshop',
  archetype: 'additive-vertical-slice',
  title: 'Orders reserve stock',
  requirement: 'requirement.md',
  modules: { required: ['mod-a', 'mod-b'], allowed: ['mod-a', 'mod-b'] },
  allowed_shared_paths: ['README.md'],
  acceptance_criteria: [
    { id: 'AC-1', modules: ['mod-a'] },
    { id: 'AC-2', modules: ['mod-b'] },
    { id: 'AC-3', modules: ['mod-a', 'mod-b'] },
  ],
  budget: { max_turns: 40, timeout_seconds: 900 },
  evaluator_lock: 'evaluator.lock.json',
};

export const TOY_REQUIREMENT = `# ${TOY_PRD} — Orders reserve stock

## Acceptance criteria

**AC-1 (mod-a).** \`reserve(stock, qty)\` returns \`{ stock: stock - qty, reserved: qty }\`.

**AC-2 (mod-b).** \`placeOrder(stock, qty)\` returns \`{ status: 'placed', stock: <remaining> }\`, or \`{ status: 'rejected', stock }\` when \`qty > stock\`.

**AC-3 (mod-a, mod-b).** Existing behaviour is unchanged.
`;

export interface Toy {
  root: string;
  suite: string;
  cacheRoot: string;
  upstream: string;
  bundle: string;
  lock: any;
  start: string;
  authoring: string;
  referenceHead: string;
}

/** Files the reference adds to its test-first commit and to its code commit, besides TOY's. */
export interface ToyReferenceExtras {
  referenceTests?: Record<string, string>;
  referenceCode?: Record<string, string>;
}

/** A production module of the reference long enough to be fingerprinted (TOY's own edits are too small). */
export const LEDGER = 'export class Ledger {\n  #rows = [];\n  add(row) {\n    this.#rows.push(row);\n    return this.#rows.length;\n  }\n  get size() {\n    return this.#rows.length;\n  }\n}\n';
/** An upstream test the reference touched without adding a test: a line above its first test. */
export const SUPPORT = { 'mod-a/test/stock.test.mjs': `// shared by the stock tests\n${TOY.upstream['mod-a/test/stock.test.mjs']}` };
/** A reference with content an independent delivery may converge on: the ledger, and the test support change. */
export const CONVERGENT_REFERENCE: ToyReferenceExtras = { referenceTests: SUPPORT, referenceCode: { 'mod-a/src/ledger.mjs': LEDGER } };

/**
 * Build the toy: an upstream repository, its bundle in a cache root, a
 * suite directory (schemas copied from the real suite) and an evaluator
 * authoring repository with hidden/reference/mutant branches.
 */
export function buildToy(extras: ToyReferenceExtras = {}): Toy {
  const root = makeTmpDir('bench-toy-');
  const upstream = join(root, 'upstream');
  mkdirSync(upstream, { recursive: true });
  toyGit(upstream, ['init', '-q', '-b', 'main']);
  commitFiles(upstream, TOY.upstream, 'toyshop: initial');
  const start = commitFiles(upstream, { 'README.md': '# toyshop\n\nStock and orders.\n' }, 'toyshop: docs');

  const cacheRoot = join(root, 'cache');
  mkdirSync(join(cacheRoot, 'sources'), { recursive: true });
  const bundle = join(cacheRoot, 'sources', 'toyshop.bundle');
  toyGit(upstream, ['bundle', 'create', bundle, 'HEAD']);
  const described = describeCommit({ repo: upstream, commit: start });
  const lock: any = {
    schema: 'mycelink-bench/source-lock@2',
    project: 'toyshop',
    remote: 'https://example.invalid/toy/toyshop.git',
    commit: start,
    tree: described.tree,
    object_format: 'sha1',
    content: described.content,
    history: { kind: 'complete', commits: 2, shallow_boundary: [], digest_sha256: described.history.digest_sha256 },
    bundle: { file: 'toyshop.bundle', version: 2, refs: [{ name: 'HEAD', sha: start }], prerequisites: [], transport: { sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'), size: statSync(bundle).size } },
    license: { spdx: 'MIT', files: [{ path: 'LICENSE', blob: toyGit(upstream, ['rev-parse', 'HEAD:LICENSE']) }] },
  };
  lock.identity_sha256 = sourceIdentity(lock);

  const suite = join(root, 'suite');
  cpSync(join(REPO_ROOT, 'evals-public-projects', 'schemas'), join(suite, 'schemas'), { recursive: true });
  const projectDir = join(suite, 'projects', 'toyshop');
  // Two metadata-only PRDs complete the three archetypes the suite rules demand.
  const sibling = (n: number, archetype: string) => ({
    [`prds/TOY-00${n}/case.json`]: JSON.stringify({ ...TOY_CASE, id: `TOY-00${n}`, case: `toyshop-sibling-${n}`, archetype }, null, 2) + '\n',
    [`prds/TOY-00${n}/requirement.md`]: TOY_REQUIREMENT.replace(TOY_PRD, `TOY-00${n}`),
  });
  writeTree(projectDir, {
    'adapter.json': JSON.stringify(TOY_ADAPTER, null, 2) + '\n',
    'source.lock.json': JSON.stringify(lock, null, 2) + '\n',
    [`prds/${TOY_PRD}/case.json`]: JSON.stringify(TOY_CASE, null, 2) + '\n',
    [`prds/${TOY_PRD}/requirement.md`]: TOY_REQUIREMENT,
    ...sibling(2, 'backward-compatible-behavioral-change'),
    ...sibling(3, 'failure-concurrency-recovery'),
  });

  const authoring = join(root, 'authoring');
  toyGit(root, ['clone', '-q', upstream, authoring]);
  toyGit(authoring, ['checkout', '-q', '-b', `hidden/${TOY_PRD}`, start]);
  commitFiles(authoring, TOY.hidden, 'hidden acceptance tests');
  toyGit(authoring, ['checkout', '-q', '-b', `reference/${TOY_PRD}`, start]);
  commitFiles(authoring, { ...TOY.referenceTests, ...extras.referenceTests }, 'test: stock reservation');
  const referenceHead = commitFiles(authoring, { ...TOY.referenceCode, ...extras.referenceCode }, 'feat: orders reserve stock');
  for (const [id, files] of Object.entries(TOY.mutants)) {
    toyGit(authoring, ['checkout', '-q', '-b', `mutant/${TOY_PRD}/${id}`, referenceHead]);
    commitFiles(authoring, files, `mutant ${id}`);
  }
  toyGit(authoring, ['checkout', '-q', 'main']);
  return { root, suite, cacheRoot, upstream, bundle, lock, start, authoring, referenceHead };
}

/**
 * The toy as a verification needs it: the evaluator artifacts imported, the
 * frozen baseline recorded, and the PRD qualified (expected.json in the
 * store, qualification.json with its bindings next to the PRD).
 */
export async function preparedToy(extras: ToyReferenceExtras = {}): Promise<{ toy: Toy; project: any; prd: any }> {
  const toy = buildToy(extras);
  const { project, prd } = findPrd(loadSuite(toy.suite), TOY_PRD);
  importEvaluator({ project, prdId: TOY_PRD, from: toy.authoring, cacheRoot: toy.cacheRoot });
  const runs = [await runFrozenBaseline({ project, bundlePath: toy.bundle, adapter: createAdapter(project.adapter), workRoot: makeTmpDir('bench-toy-base-'), ctx: { isolation: TEST_ISOLATION }, label: 'b' })];
  writeFileSync(join(project.dir, 'baseline-tests.json'), JSON.stringify(baselineRecord({ project, runs }).record, null, 2) + '\n');
  const q = await qualifyPrd({ project, prd, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-toy-q-'), repeat: 1, isolation: TEST_ISOLATION });
  if (!q.ok) throw new Error(`the toy does not qualify: ${JSON.stringify(q.checks.filter((c: any) => !c.ok))}`);
  // The suite as the tools pin it: a clean, committed checkout.
  toyGit(toy.suite, ['init', '-q', '-b', 'main']);
  toyGit(toy.suite, ['add', '--all']);
  toyGit(toy.suite, ['commit', '-q', '-m', 'toy suite']);
  return { toy, project, prd };
}
