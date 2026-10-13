/**
 * Deterministic TDD replay on a toy project (node --test, CI-safe).
 *
 * A unit of delivered work (a linear run of commits on top of an immutable
 * start) is credited as test-first only when its leading commits change
 * test files alone, that exact test delta — applied independently to the
 * start — fails with the expected tests for a missing behaviour (not a
 * syntax, import, missing-symbol, setup or timeout failure), and the same
 * test blobs pass with the same command once the production commits are
 * applied. Every input and output is hashed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { replayUnit, segmentUnits } from '../../evals-public-projects/lib/tdd.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { createAdapter } from '../../evals-public-projects/lib/adapters/index.mjs';

afterAll(() => cleanupTmpRoots());

const TOY = {
  schema: 'mycelink-bench/project-adapter@1',
  id: 'toy',
  name: 'Toy',
  implementation: 'node-test',
  source_lock: 'source.lock.json',
  workspace: { repo_dir: 'repos/toy', branch: 'main' },
  modules: [
    { id: 'mod-a', path: 'mod-a', description: 'stock' },
    { id: 'mod-b', path: 'mod-b', description: 'orders' },
  ],
  shared_paths: [],
  test_paths: ['*/test/**'],
  toolchain: { runtime: 'node', versions: {}, cache: { kind: 'none', dir: '' } },
  env: { TZ: 'UTC' },
  commands: { timeout_seconds: 60 },
  tolerated_build_mutations: [],
  baseline_exclusions: [],
};

let tick = 0;
function g(cwd: string, args: string[]): string {
  tick += 1;
  const date = new Date(Date.UTC(2026, 1, 1, 0, tick)).toISOString();
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '' },
  }).trim();
}
function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', message]);
  return g(repo, ['rev-parse', 'HEAD']);
}

const BASE_STOCK = 'export function reserve(stock, qty) {\n  return { stock, reserved: 0 };\n}\n';
const GOOD_STOCK = 'export function reserve(stock, qty) {\n  return { stock: stock - qty, reserved: qty };\n}\n';
const EXISTING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { reserve } from '../src/stock.mjs';\ntest('keeps the stock object shape', () => {\n  assert.deepEqual(Object.keys(reserve(1, 0)).sort(), ['reserved', 'stock']);\n});\n";
const RED_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { reserve } from '../src/stock.mjs';\ntest('reserving reduces the stock', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });\n});\n";

function toyRepo(): { repo: string; start: string } {
  const repo = join(makeTmpDir('bench-tdd-'), 'toy');
  mkdirSync(repo, { recursive: true });
  g(repo, ['init', '-q', '-b', 'main']);
  const start = commit(repo, { 'mod-a/src/stock.mjs': BASE_STOCK, 'mod-a/test/stock.test.mjs': EXISTING_TEST, 'mod-b/src/orders.mjs': 'export const orders = [];\n' }, 'upstream');
  return { repo, start };
}
const adapter = () => createAdapter(TOY, { projectDir: null });
const ctx = (timeoutMs = 60_000) => ({ workRoot: makeTmpDir('bench-tdd-work-'), cacheRoot: null, timeoutMs });
async function replay(repo: string, start: string, head: string, timeoutMs?: number) {
  const units = segmentUnits(repo, start, head, adapter());
  expect(units).toHaveLength(1);
  return replayUnit({ repo, unit: units[0], adapter: adapter(), ctx: ctx(timeoutMs) });
}

describe('segmentUnits', () => {
  it('splits delivered history into linear runs on top of their bases, following merges', () => {
    const { repo, start } = toyRepo();
    const a1 = commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: reserve');
    const a2 = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: reserve');
    g(repo, ['checkout', '-q', '-b', 'side', start]);
    const b1 = commit(repo, { 'mod-b/test/orders.test.mjs': "import { test } from 'node:test';\ntest('orders', () => {});\n" }, 'test: orders');
    g(repo, ['checkout', '-q', 'main']);
    g(repo, ['merge', '-q', '--no-ff', '-m', 'integrate side', 'side']);
    const merge = g(repo, ['rev-parse', 'HEAD']);
    const c1 = commit(repo, { 'mod-b/src/orders.mjs': 'export const orders = [1];\n' }, 'feat: after merge');
    expect(segmentUnits(repo, start, c1, adapter())).toEqual([
      { base: start, commits: [a1, a2], after_production: false },
      { base: start, commits: [b1], after_production: false },
      { base: merge, commits: [c1], after_production: true },
    ]);
  });
});

describe('segmentUnits: red-green cycles', () => {
  it('starts a new unit whenever a test-only commit follows production code, so each cycle replays on its own base', () => {
    const { repo, start } = toyRepo();
    const t1 = commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: a');
    const p1 = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: a');
    const t2 = commit(repo, { 'mod-b/test/orders.test.mjs': "import { test } from 'node:test';\ntest('orders', () => {});\n" }, 'test: b');
    const p2 = commit(repo, { 'mod-b/src/orders.mjs': 'export const orders = [2];\n' }, 'feat: b');
    const p3 = commit(repo, { 'mod-b/src/orders.mjs': 'export const orders = [3];\n' }, 'refactor: b');
    const m = commit(repo, { 'mod-a/test/more.test.mjs': EXISTING_TEST, 'mod-a/src/extra.mjs': 'export {};\n' }, 'mixed');
    expect(segmentUnits(repo, start, m, adapter())).toEqual([
      { base: start, commits: [t1, p1], after_production: false },
      { base: p1, commits: [t2, p2, p3, m], after_production: true },
    ]);
  });
});

describe('replayUnit', () => {
  it('credits a test-first unit: the exact test delta fails on the start for a missing behaviour, the same blobs pass after production code', async () => {
    const { repo, start } = toyRepo();
    const red = commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: reserve reduces stock');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: reserve');
    const r = await replay(repo, start, head);
    expect(r).toMatchObject({ ok: true, verdict: 'valid', base: start, red_commit: red, head });
    expect(r.expected_tests).toEqual([{ file: 'mod-a/test/reserve.test.mjs', name: 'reserving reduces the stock' }]);
    expect(r.start_tree).toBe(g(repo, ['rev-parse', `${start}^{tree}`]));
    expect(r.red_tree).toBe(g(repo, ['rev-parse', `${red}^{tree}`]));
    expect(r.green_tree).toBe(g(repo, ['rev-parse', `${head}^{tree}`]));
    expect(r.red.run.exit_code).not.toBe(0);
    expect(r.red.expected.map((t: any) => [t.status, t.category])).toEqual([['failed', 'assertion']]);
    expect(r.green.expected.map((t: any) => t.status)).toEqual(['passed']);
    for (const key of ['argv_sha256', 'env_sha256', 'red_stdout_sha256', 'red_stderr_sha256', 'green_stdout_sha256', 'green_stderr_sha256', 'red_tests_sha256']) {
      expect(r.hashes[key], key).toMatch(/^[0-9a-f]{64}$/);
    }

    // Deterministic: a second replay names the same trees, tests, command and failure.
    const again = await replay(repo, start, head);
    expect([again.start_tree, again.red_tree, again.green_tree]).toEqual([r.start_tree, r.red_tree, r.green_tree]);
    expect(again.hashes.argv_sha256).toBe(r.hashes.argv_sha256);
    expect(again.hashes.env_sha256).toBe(r.hashes.env_sha256);
    expect(again.red.expected.map((t: any) => t.fingerprint)).toEqual(r.red.expected.map((t: any) => t.fingerprint));
  });

  it('credits a declarations-only unit (only modules without runtime tests, no test) without a RED, and nothing more', async () => {
    // CSET-201's types node: packages/types is declarations only (runtime_tests: false); its change carries no runtime test.
    const typed = { ...TOY, modules: [...TOY.modules, { id: 'types', path: 'types', description: 'declarations', runtime_tests: false }] };
    const typedAdapter = createAdapter(typed, { projectDir: null });
    const run = async (repo: string, start: string, head: string) => {
      const units = segmentUnits(repo, start, head, typedAdapter);
      expect(units).toHaveLength(1);
      return replayUnit({ repo, unit: units[0], adapter: typedAdapter, ctx: ctx() });
    };
    const decl = toyRepo();
    const head = commit(decl.repo, { 'types/index.d.ts': 'export type Reason = { type: "changeset" };\n' }, 'feat(types): Reason');
    expect(await run(decl.repo, decl.start, head)).toMatchObject({ ok: true, verdict: 'declarations-only' });
    // A runtime module beside it still needs its RED.
    const mixed = toyRepo();
    const both = commit(mixed.repo, { 'types/index.d.ts': 'export type Reason = {};\n', 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: types and code');
    expect(await run(mixed.repo, mixed.start, both)).toMatchObject({ ok: false, verdict: 'no-test-first' });
    // So does a path outside every module.
    const shared = toyRepo();
    const loose = commit(shared.repo, { 'types/index.d.ts': 'export type Reason = {};\n', 'notes.md': 'x\n' }, 'feat: types and a shared file');
    expect(await run(shared.repo, shared.start, loose)).toMatchObject({ ok: false, verdict: 'no-test-first' });
  });

  it('refuses a unit whose first commit already changes production code', async () => {
    const { repo, start } = toyRepo();
    const head = commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST, 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: tests and code together');
    expect(await replay(repo, start, head)).toMatchObject({ ok: false, verdict: 'no-test-first' });
  });

  it.each([
    ['a syntax error', "import { test } from 'node:test';\ntest('reserving reduces the stock', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3 ;\n});\n", 'syntax'],
    ['an import of a module that does not exist', "import { test } from 'node:test';\nimport { reserve } from '../src/reservations.mjs';\ntest('reserving reduces the stock', () => { reserve(5, 2); });\n", 'import'],
    ['a call to an export that does not exist', "import { test } from 'node:test';\nimport * as stock from '../src/stock.mjs';\ntest('reserving reduces the stock', () => { stock.release(5, 2); });\n", 'missing-symbol'],
  ])('rejects a RED that fails because of %s', async (_label, test, category) => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': test }, 'test: broken red');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: reserve');
    const r = await replay(repo, start, head);
    expect(r).toMatchObject({ ok: false, verdict: 'red-invalid' });
    expect(r.red.categories).toContain(category === 'syntax' || category === 'import' ? 'not-run' : category);
  });

  it('rejects a RED that does not fail on the start', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/shape.test.mjs': EXISTING_TEST.replace('keeps the stock object shape', 'still keeps the shape') }, 'test: already green');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: reserve');
    expect(await replay(repo, start, head)).toMatchObject({ ok: false, verdict: 'red-passed' });
  });

  it('rejects production code that does not make the same tests pass', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: reserve');
    const head = commit(repo, { 'mod-a/src/stock.mjs': BASE_STOCK.replace('reserved: 0', 'reserved: qty') }, 'feat: half done');
    expect(await replay(repo, start, head)).toMatchObject({ ok: false, verdict: 'green-failed' });
  });

  it('refuses a test weakened after RED: it is declared after the production code', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: reserve');
    commit(repo, { 'mod-a/src/stock.mjs': BASE_STOCK.replace('reserved: 0', 'reserved: qty') }, 'feat: half done');
    // The weakening rides along with more production code, so it stays in the same unit.
    const head = commit(
      repo,
      { 'mod-a/test/reserve.test.mjs': RED_TEST.replace('{ stock: 3, reserved: 2 }', '{ stock: 5, reserved: 2 }'), 'mod-b/src/orders.mjs': 'export const orders = [1];\n' },
      'feat: more, and a weaker test',
    );
    const r = await replay(repo, start, head);
    expect(r).toMatchObject({ ok: false, verdict: 'test-after', tests_changed_after_red: ['mod-a/test/reserve.test.mjs'] });
  });

  it('rejects a RED that only times out', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': "import { test } from 'node:test';\ntest('reserving reduces the stock', async () => { await new Promise(() => setInterval(() => {}, 1000)); });\n" }, 'test: hangs');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: reserve');
    const r = await replay(repo, start, head, 5_000);
    expect(r).toMatchObject({ ok: false, verdict: 'red-invalid' });
    expect(r.red.run.timed_out).toBe(true);
  });

  it('does not ask for a RED from a unit without production code before any production change', async () => {
    const { repo, start } = toyRepo();
    const head = commit(repo, { 'mod-a/test/more.test.mjs': EXISTING_TEST }, 'test: more coverage');
    expect(await replay(repo, start, head)).toMatchObject({ ok: true, verdict: 'no-production-change' });
  });
});

describe('replayUnit: every module test-first, nothing declared after production', () => {
  const ORDERS_RED = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { orders } from '../src/orders.mjs';\ntest('an order is recorded', () => {\n  assert.equal(orders.length, 1);\n});\n";
  const ORDERS_GREEN_ALREADY = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { orders } from '../src/orders.mjs';\ntest('orders is a list', () => {\n  assert.ok(Array.isArray(orders));\n});\n";
  const ORDERS_CODE = 'export const orders = [1];\n';

  it('credits a unit whose RED fails for a missing behaviour in every module it changes', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST, 'mod-b/test/orders.test.mjs': ORDERS_RED }, 'test: both modules first');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK, 'mod-b/src/orders.mjs': ORDERS_CODE }, 'feat: both modules');
    expect(await replay(repo, start, head)).toMatchObject({ ok: true, verdict: 'valid' });
  });

  it('refuses credit when a module changes production code without a RED test of its own', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: one module only');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK, 'mod-b/src/orders.mjs': ORDERS_CODE }, 'feat: both modules');
    const r = await replay(repo, start, head);
    expect(r).toMatchObject({ ok: false, verdict: 'red-missing-module' });
    expect(r.detail).toMatch(/mod-b/);
  });

  it('refuses credit when a module’s RED tests do not fail', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST, 'mod-b/test/orders.test.mjs': ORDERS_GREEN_ALREADY }, 'test: mod-b only nominally');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK, 'mod-b/src/orders.mjs': ORDERS_CODE }, 'feat: both modules');
    const r = await replay(repo, start, head);
    expect(r).toMatchObject({ ok: false, verdict: 'red-missing-module' });
    expect(r.detail).toMatch(/mod-b/);
  });

  it('asks no RED of a module that cannot have runtime tests (declarations only)', async () => {
    const declared = createAdapter({ ...TOY, modules: TOY.modules.map((m) => (m.id === 'mod-b' ? { ...m, runtime_tests: false } : m)) });
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: mod-a');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK, 'mod-b/src/orders.mjs': ORDERS_CODE }, 'feat: both modules');
    const [unit] = segmentUnits(repo, start, head, declared);
    expect(await replayUnit({ repo, unit, adapter: declared, ctx: ctx() })).toMatchObject({ ok: true, verdict: 'valid' });
  });

  it('refuses credit for tests declared together with the production code, after the RED', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: a trivial-looking RED');
    const head = commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK, 'mod-b/src/orders.mjs': ORDERS_CODE, 'mod-b/test/orders.test.mjs': ORDERS_RED }, 'feat: code, and its tests with it');
    const r = await replay(repo, start, head);
    expect(r).toMatchObject({ ok: false, verdict: 'test-after' });
    expect(r.detail).toMatch(/an order is recorded/);
  });

  it('refuses credit for tests declared after the production code, in a later test-only commit', async () => {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST, 'mod-b/test/orders.test.mjs': ORDERS_RED }, 'test: first');
    commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK, 'mod-b/src/orders.mjs': ORDERS_CODE }, 'feat: both modules');
    const head = commit(repo, { 'mod-a/test/thorough.test.mjs': RED_TEST.replace('reserving reduces the stock', 'reserving more than the stock') }, 'test: the real tests, afterwards');
    const units = segmentUnits(repo, start, head, adapter());
    expect(units).toHaveLength(2);
    const later = await replayUnit({ repo, unit: units[1], adapter: adapter(), ctx: ctx() });
    expect(later).toMatchObject({ ok: false, verdict: 'test-after' });
    expect(later.detail).toMatch(/reserving more than the stock/);
  });

  it('allows test-support maintenance after the RED, but runs GREEN on the RED commit’s tests, so weakening support code cannot pass it', async () => {
    const HELPER = "import assert from 'node:assert/strict';\nexport const expectStock = (r, n) => assert.equal(r.stock, n);\n";
    const USES_HELPER = "import { test } from 'node:test';\nimport { reserve } from '../src/stock.mjs';\nimport { expectStock } from './helpers.mjs';\ntest('reserving reduces the stock', () => {\n  expectStock(reserve(5, 2), 3);\n});\n";
    // An upstream test helper the RED test uses (so it is not part of the RED delta).
    const withHelper = () => {
      const { repo, start } = toyRepo();
      const base = commit(repo, { 'mod-a/test/helpers.mjs': HELPER }, 'upstream: a test helper');
      void start;
      return { repo, start: base };
    };
    // Honest maintenance: the helper gains an unrelated export; the unit is credited and the change recorded.
    const honest = withHelper();
    commit(honest.repo, { 'mod-a/test/reserve.test.mjs': USES_HELPER }, 'test: reserve');
    const honestHead = commit(honest.repo, { 'mod-a/src/stock.mjs': GOOD_STOCK, 'mod-a/test/helpers.mjs': `${HELPER}export const unused = 1;\n` }, 'feat: reserve, helper tidy-up');
    const ok = await replay(honest.repo, honest.start, honestHead);
    expect(ok).toMatchObject({ ok: true, verdict: 'valid', test_maintenance_after_red: ['mod-a/test/helpers.mjs'] });
    // A helper emptied together with a wrong implementation does not turn GREEN.
    const weakened = withHelper();
    commit(weakened.repo, { 'mod-a/test/reserve.test.mjs': USES_HELPER }, 'test: reserve');
    const weakHead = commit(weakened.repo, { 'mod-a/src/stock.mjs': BASE_STOCK.replace('reserved: 0', 'reserved: qty'), 'mod-a/test/helpers.mjs': 'export const expectStock = () => {};\n' }, 'feat: reserve, and a quieter helper');
    expect(await replay(weakened.repo, weakened.start, weakHead)).toMatchObject({ ok: false, verdict: 'green-failed' });
  });
});

/**
 * CSET-203 r3: AC-5 (compatibility) was found untested; its honest repair is a
 * regression test alone, after the code, which the replay refused as
 * test-after. A test-only unit after production is now a
 * compatibility-regression unit — never a RED — when every commit names
 * compatibility criteria of the case in a `Mycelink-Compatibility:` trailer,
 * it only adds tests, and the tests it adds pass on its own tree (the code as
 * it was) and on the delivered tree with its test side.
 */
describe('replayUnit: a compatibility-regression unit after the production code', () => {
  const SHAPE_TEST = (name: string, body = "assert.deepEqual(Object.keys(reserve(1, 0)).sort(), ['reserved', 'stock']);") =>
    `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { reserve } from '../src/stock.mjs';\ntest('${name}', () => {\n  ${body}\n});\n`;
  function commitWith(repo: string, files: Record<string, string>, message: string, trailer: string | null): string {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), body);
    }
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', message, ...(trailer === null ? [] : ['-m', trailer])]);
    return g(repo, ['rev-parse', 'HEAD']);
  }
  /** A RED cycle, then a compatibility test alone after it. */
  function delivered(trailer: string | null, files: Record<string, string> = { 'mod-a/test/compat.test.mjs': SHAPE_TEST('a reservation keeps the stock shape') }) {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: reserve');
    commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: reserve');
    const head = commitWith(repo, files, 'test: AC-5 compatibility', trailer);
    const units = segmentUnits(repo, start, head, adapter());
    expect(units).toHaveLength(2);
    return { repo, head, unit: units[1] };
  }
  const run = (d: ReturnType<typeof delivered>, compatibility: string[] = ['AC-5'], finalHead?: string) =>
    replayUnit({ repo: d.repo, unit: d.unit, adapter: adapter(), ctx: ctx(), compatibility, ...(finalHead !== undefined ? { finalHead } : {}) });

  it('credits it with the trailer naming a compatibility criterion of the case: its tests pass on its own tree and on the delivered one', async () => {
    const d = delivered('Mycelink-Compatibility: AC-5');
    const r = await run(d);
    expect(r).toMatchObject({ ok: true, verdict: 'compatibility-regression', criteria: ['AC-5'], expected_tests: [{ file: 'mod-a/test/compat.test.mjs', name: 'a reservation keeps the stock shape' }] });
    expect(r.compatibility.base.expected.map((t: any) => t.status)).toEqual(['passed']);
    expect(r.compatibility.final.expected.map((t: any) => t.status)).toEqual(['passed']);
  });

  it('without the trailer, or naming a new behaviour or a criterion the case does not have, it stays test-after', async () => {
    expect(await run(delivered(null))).toMatchObject({ ok: false, verdict: 'test-after' });
    expect(await run(delivered('Mycelink-Compatibility: AC-3'))).toMatchObject({ ok: false, verdict: 'compatibility-invalid' });
    expect(await run(delivered('Mycelink-Compatibility: AC-5'), [])).toMatchObject({ ok: false, verdict: 'compatibility-invalid' });
  });

  it('a test that fails on the code as it is proves no compatibility: it is a regression, which needs its fix', async () => {
    const d = delivered('Mycelink-Compatibility: AC-5', { 'mod-a/test/compat.test.mjs': SHAPE_TEST('reserving nothing keeps everything', 'assert.deepEqual(reserve(5, 0), { stock: 4, reserved: 0 });') });
    const r = await run(d);
    expect(r).toMatchObject({ ok: false, verdict: 'compatibility-failed' });
  });

  it('weakening or removing a test that was there is refused', async () => {
    const weakened = delivered('Mycelink-Compatibility: AC-5', { 'mod-a/test/compat.test.mjs': SHAPE_TEST('a reservation keeps the stock shape'), 'mod-a/test/reserve.test.mjs': RED_TEST.replace('assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });', 'assert.ok(reserve(5, 2));') });
    expect(await run(weakened)).toMatchObject({ ok: false, verdict: 'compatibility-invalid' });
    expect((await run(weakened)).detail).toMatch(/reserving reduces the stock/);
  });

  it('a later production change that breaks it fails it on the delivered tree', async () => {
    const d = delivered('Mycelink-Compatibility: AC-5');
    const broken = commit(d.repo, { 'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { left: stock - qty };\n}\n' }, 'feat: a later change');
    expect(await run(d, ['AC-5'], broken)).toMatchObject({ ok: false, verdict: 'compatibility-failed' });
  });
});

/**
 * CSET-201 final: a completed criterion re-proved on a rework's unchanged base — the review's exact reproduction, passing
 * there — is committed by Mycelink settle as a re-proof unit (`Mycelink-Reproof: <AC>`): tests alone of behaviour an
 * earlier RED drove. The replay credits it only as that: its own unit (never folded into the next cycle's RED), every
 * commit naming criteria of the case, adding tests only, passing on its own tree and on the delivered one.
 */
describe('replayUnit: a re-proof unit after the production code', () => {
  const REPROOF = (name: string, body = 'assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });') =>
    `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { reserve } from '../src/stock.mjs';\ntest('${name}', () => {\n  ${body}\n});\n`;
  function delivered(trailer: string | null, files: Record<string, string> = { 'mod-a/test/reproof.test.mjs': REPROOF('reserving everything leaves nothing', 'assert.deepEqual(reserve(2, 2), { stock: 0, reserved: 2 });') }, next = false) {
    const { repo, start } = toyRepo();
    commit(repo, { 'mod-a/test/reserve.test.mjs': RED_TEST }, 'test: reserve');
    commit(repo, { 'mod-a/src/stock.mjs': GOOD_STOCK }, 'feat: reserve');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), body);
    }
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'test(mod-a): re-proof of AC-1 for F-1-R001', ...(trailer === null ? [] : ['-m', trailer])]);
    let head = g(repo, ['rev-parse', 'HEAD']);
    // The next cycle's RED and fix right after it: a unit of their own.
    if (next) {
      commit(repo, { 'mod-b/test/orders.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { orders } from '../src/orders.mjs';\ntest('orders start with one', () => { assert.deepEqual(orders, [1]); });\n" }, 'test: orders');
      head = commit(repo, { 'mod-b/src/orders.mjs': 'export const orders = [1];\n' }, 'feat: orders');
    }
    return { repo, head, start, units: segmentUnits(repo, start, head, adapter()) };
  }
  const run = (repo: string, unit: unknown, criteria: string[] = ['AC-1'], finalHead?: string) => replayUnit({ repo, unit, adapter: adapter(), ctx: ctx(), compatibility: [], criteria, ...(finalHead !== undefined ? { finalHead } : {}) });

  it('is a unit of its own, credited as a re-proof: its tests pass on its own tree and on the delivered one; the next cycle replays on its own', async () => {
    const d = delivered('Mycelink-Reproof: AC-1', undefined, true);
    expect(d.units).toHaveLength(3);
    expect(d.units[1]).toMatchObject({ commits: [expect.any(String)], reproof: true });
    const r = await run(d.repo, d.units[1], ['AC-1'], d.head);
    expect(r).toMatchObject({ ok: true, verdict: 'reproof', criteria: ['AC-1'], expected_tests: [{ file: 'mod-a/test/reproof.test.mjs', name: 'reserving everything leaves nothing' }] });
    expect((await run(d.repo, d.units[2], ['AC-1'], d.head))).toMatchObject({ ok: true, verdict: 'valid' });
  });

  it('without the trailer it stays test-after; naming a criterion the case does not have, weakening a test, or failing on the code as it is, it is refused', async () => {
    const bare = delivered(null);
    expect(await run(bare.repo, bare.units[1])).toMatchObject({ ok: false, verdict: 'test-after' });
    const other = delivered('Mycelink-Reproof: AC-9');
    expect(await run(other.repo, other.units[1])).toMatchObject({ ok: false, verdict: 'reproof-invalid' });
    const weakened = delivered('Mycelink-Reproof: AC-1', { 'mod-a/test/reproof.test.mjs': REPROOF('reserving everything leaves nothing'), 'mod-a/test/reserve.test.mjs': RED_TEST.replace('assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });', 'assert.ok(true);') });
    expect(await run(weakened.repo, weakened.units[1])).toMatchObject({ ok: false, verdict: 'reproof-invalid' });
    const failing = delivered('Mycelink-Reproof: AC-1', { 'mod-a/test/reproof.test.mjs': REPROOF('reserving one keeps four', 'assert.deepEqual(reserve(5, 1), { stock: 5, reserved: 1 });') });
    expect(await run(failing.repo, failing.units[1])).toMatchObject({ ok: false, verdict: 'reproof-failed' });
  });
});
