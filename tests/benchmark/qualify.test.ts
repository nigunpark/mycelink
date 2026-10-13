/**
 * Qualification of a PRD's evaluator artifacts, before any agent runs:
 *
 * - the hidden tests run on the frozen commit, every one of them, and fail
 *   only for missing behaviour (assertions or code-under-test exceptions);
 * - they all pass on the reference solution, whose trusted full suite keeps
 *   every baseline test but the upstream tests the reference itself had to
 *   change (superseded), whose own tests pass, whose history replays as
 *   test-first and which stays in scope and passes the harness checks;
 * - every gating mutant of the reference is killed, run after run, and
 *   every required module with runtime behaviour has one;
 * - repeated runs agree; a tmp root claimed as another file system must be one.
 *
 * Qualification writes expected.json into the evaluator store, re-locks
 * it, and commits only a counts-and-hashes summary next to the PRD — bound
 * to the evaluator digest, the source identity, the cache lock, the
 * toolchains and the trusted commands, with the file systems it used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { TOY, TOY_PRD, buildToy, commitFiles, toyGit, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { filesystemOf, qualifyPrd } from '../../evals-public-projects/lib/qualify.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { main as qualifyTool } from '../../evals-public-projects/tools/qualify.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { findPrd, loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { importEvaluator, loadEvaluator } from '../../evals-public-projects/lib/evaluator.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { baselineRecord, runFrozenBaseline } from '../../evals-public-projects/lib/baseline.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { createAdapter } from '../../evals-public-projects/lib/adapters/index.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadSchema, validate } from '../../evals-public-projects/lib/schema.mjs';

afterAll(() => cleanupTmpRoots());

async function qualifiedToy({ spoil, tmpRoots = [] }: { spoil?: (toy: Toy) => void; tmpRoots?: string[] } = {}): Promise<{ toy: Toy; project: any; prd: any; result: any }> {
  const toy = buildToy();
  spoil?.(toy);
  const suite = loadSuite(toy.suite);
  const { project, prd } = findPrd(suite, TOY_PRD);
  importEvaluator({ project, prdId: TOY_PRD, from: toy.authoring, cacheRoot: toy.cacheRoot });
  const adapter = createAdapter(project.adapter);
  const runs = [await runFrozenBaseline({ project, bundlePath: toy.bundle, adapter, workRoot: makeTmpDir('bench-q-base-'), ctx: { isolation: TEST_ISOLATION }, label: 'b' })];
  writeFileSync(join(project.dir, 'baseline-tests.json'), JSON.stringify(baselineRecord({ project, runs }).record, null, 2) + '\n');
  const result = await qualifyPrd({ project, prd, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-q-work-'), repeat: 2, tmpRoots, isolation: TEST_ISOLATION });
  return { toy, project, prd, result };
}

const failed = (r: any) => r.checks.filter((c: any) => !c.ok).map((c: any) => c.id);
const hex64 = expect.stringMatching(/^[0-9a-f]{64}$/);

/**
 * A requirement that adds a field to reserve()'s result: the frozen upstream
 * shape test no longer holds, the hidden tests check fields one by one, and
 * the reference (when `updatesUpstreamTest`) changes the upstream test with it.
 */
function addsAField(updatesUpstreamTest: boolean) {
  return (toy: Toy) => {
    const a = toy.authoring;
    const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
    toyGit(a, ['checkout', '-q', '-B', `hidden/${TOY_PRD}`, toy.start]);
    commitFiles(
      a,
      {
        'mod-a/test/reserve.acceptance.test.mjs': `${T}import { reserve } from '../src/stock.mjs';\ntest('AC-1 reserving reduces the stock', () => {\n  const r = reserve(5, 2);\n  assert.equal(r.stock, 3);\n  assert.equal(r.reserved, 2);\n});\ntest('AC-1 the reservation names what is left', () => {\n  assert.equal(reserve(5, 2).left, 3);\n});\n`,
        'mod-b/test/orders.acceptance.test.mjs': TOY.hidden['mod-b/test/orders.acceptance.test.mjs'],
      },
      'hidden acceptance tests',
    );
    toyGit(a, ['checkout', '-q', '-B', `reference/${TOY_PRD}`, toy.start]);
    const shape = TOY.upstream['mod-a/test/stock.test.mjs'].replace("['reserved', 'stock']", "['left', 'reserved', 'stock']");
    const ownTest = `${T}import { reserve } from '../src/stock.mjs';\ntest('reserve takes the quantity out of the stock', () => {\n  const r = reserve(10, 3);\n  assert.equal(r.stock, 7);\n  assert.equal(r.left, 7);\n});\n`;
    commitFiles(a, { ...TOY.referenceTests, 'mod-a/test/reserve.test.mjs': ownTest, ...(updatesUpstreamTest ? { 'mod-a/test/stock.test.mjs': shape } : {}) }, 'test: reservations name what is left');
    const code = { ...TOY.referenceCode, 'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock: stock - qty, reserved: qty, left: stock - qty };\n}\n' };
    const head = commitFiles(a, code, 'feat: reservations name what is left');
    for (const [id, files] of Object.entries({ 'no-reduce': { 'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock, reserved: qty, left: stock };\n}\n' }, 'no-reject': TOY.mutants['no-reject'] })) {
      toyGit(a, ['checkout', '-q', '-B', `mutant/${TOY_PRD}/${id}`, head]);
      commitFiles(a, files, `mutant ${id}`);
    }
    toyGit(a, ['checkout', '-q', 'main']);
  };
}

describe('qualifyPrd', () => {
  let good: Awaited<ReturnType<typeof qualifiedToy>>;
  beforeAll(async () => {
    good = await qualifiedToy();
  }, 300_000);

  it('qualifies the toy PRD: RED at baseline for missing behaviour, GREEN on the reference, every mutant killed', () => {
    expect(failed(good.result)).toEqual([]);
    expect(good.result.ok).toBe(true);
    const red = good.result.expected.baseline_red;
    expect(red.filter((t: any) => t.status === 'failed').map((t: any) => t.name).sort()).toEqual([
      'AC-1 reserving reduces the stock',
      'AC-2 an order larger than the stock is rejected',
      'AC-2 an order reports the remaining stock',
    ]);
    expect(red.find((t: any) => t.name === 'AC-1 compat: reserving nothing keeps the stock').status).toBe('passed');
    expect(new Set(red.filter((t: any) => t.status === 'failed').map((t: any) => t.category))).toEqual(new Set(['assertion']));
    expect(good.result.expected.mutants).toMatchObject({
      'no-reduce': { gating: true, killed: true, killed_by: expect.arrayContaining(['AC-1 reserving reduces the stock']) },
      'no-reject': { gating: true, killed: true, killed_by: ['AC-2 an order larger than the stock is rejected'] },
    });
    expect(good.result.expected.reference.tdd.map((u: any) => u.verdict)).toEqual(['valid']);
    expect(good.result.expected.superseded_tests).toEqual([]);
  });

  it('stores expected.json in the evaluator store, re-locks it, and commits only counts and hashes', () => {
    const ev = loadEvaluator({ cacheRoot: good.toy.cacheRoot, project: good.project, prdId: TOY_PRD });
    expect(ev.expected).toEqual(good.result.expected);
    expect(ev.lock.files.expected).toBe(1);
    const summary = readFileSync(join(good.prd.dir, 'qualification.json'), 'utf8');
    expect(JSON.parse(summary)).toMatchObject({
      schema: 'mycelink-bench/qualification@2',
      prd: TOY_PRD,
      evaluator_digest_sha256: ev.lock.digest_sha256,
      hidden_tests: { total: 4, failing_at_baseline: 3, passing_at_baseline: 1 },
      mutants: { gating: 2, killed: 2, by_module: { 'mod-a': 1, 'mod-b': 1 } },
      runs: 2,
    });
    for (const name of ['reserving', 'rejected', 'remaining', 'no-reduce', 'no-reject']) expect(summary).not.toContain(name);
  });

  it('binds the committed qualification to the source, evaluator, cache, toolchain and command hashes, with the file systems it used', () => {
    const q = JSON.parse(readFileSync(join(good.prd.dir, 'qualification.json'), 'utf8'));
    expect(validate(loadSchema('qualification'), q)).toEqual([]);
    expect(q).toMatchObject({
      source_identity_sha256: good.project.lock.identity_sha256,
      bindings: {
        cache_lock_sha256: null,
        toolchains: { node: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') },
        commands: { full_suite_sha256: hex64, hidden_sha256: hex64 },
      },
      superseded_tests: 0,
      reference: { own_tests: 3 },
      filesystems: { distinct: 1, roots: [{ role: 'work' }] },
    });
    expect(good.result.bindings).toEqual(q.bindings);
  });

  it('refuses a tmp root claimed as another file system that is the work directory’s own', async () => {
    const workFs = filesystemOf(makeTmpDir('bench-q-fs-'));
    expect(workFs).toMatchObject({ device: expect.any(Number) });
    const { result } = await qualifiedToy({ tmpRoots: [makeTmpDir('bench-q-tmp-')] });
    expect(result.ok).toBe(false);
    expect(failed(result)).toEqual(['tmp-roots-distinct']);
    expect(result.filesystems.map((f: any) => f.role)).toEqual(['work', 'tmp-root-1']);
  }, 300_000);

  it('supersedes exactly the upstream tests the reference itself had to change', async () => {
    const { result } = await qualifiedToy({ spoil: addsAField(true) });
    expect(failed(result)).toEqual([]);
    expect(result.expected.superseded_tests).toEqual(['mod-a/test/stock.test.mjs::reserve keeps the result shape']);
    // A reference that breaks an upstream test without changing it does not qualify.
    const { result: careless } = await qualifiedToy({ spoil: addsAField(false) });
    expect(careless.ok).toBe(false);
    expect(failed(careless)).toEqual(['reference-full-suite']);
  }, 600_000);

  it('refuses to qualify without an isolation boundary (or the tests\u2019 explicit stand-in)', async () => {
    await expect(qualifyPrd({ project: good.project, prd: good.prd, cacheRoot: good.toy.cacheRoot, workRoot: makeTmpDir('bench-q-noiso-'), repeat: 1 })).rejects.toThrow(/no isolation/);
  });

  it('the qualify tool refuses to qualify on a single file system', async () => {
    const r = await qualifyTool(['--prd', 'CSET-202']);
    expect(r).toMatchObject({ ok: false, exit: 2 });
    expect(r.errors.join('\n')).toMatch(/--tmp-root/);
  });

  it('fails a mutant the hidden tests do not kill', async () => {
    const { result } = await qualifiedToy({
      spoil: (toy) => {
        toyGit(toy.authoring, ['checkout', '-q', '-b', `mutant/${TOY_PRD}/cosmetic`, toy.referenceHead]);
        commitFiles(toy.authoring, { 'mod-a/src/stock.mjs': `// reformatted\n${TOY.referenceCode['mod-a/src/stock.mjs']}` }, 'mutant cosmetic');
        toyGit(toy.authoring, ['checkout', '-q', 'main']);
      },
    });
    expect(result.ok).toBe(false);
    expect(failed(result)).toEqual(['mutant:cosmetic']);
  }, 300_000);

  it('fails a required module that no gating mutant breaks: nothing proves the hidden tests need its behaviour', async () => {
    const { result } = await qualifiedToy({ spoil: (toy) => toyGit(toy.authoring, ['branch', '-D', `mutant/${TOY_PRD}/no-reject`]) });
    expect(result.ok).toBe(false);
    expect(failed(result)).toEqual(['mutant-coverage']);
    expect(result.checks.find((c: any) => c.id === 'mutant-coverage').detail).toMatch(/mod-b/);
  }, 300_000);

  it('fails hidden tests that do not fail on the frozen commit', async () => {
    const { result } = await qualifiedToy({
      spoil: (toy) => {
        toyGit(toy.authoring, ['checkout', '-q', '-B', `hidden/${TOY_PRD}`, toy.start]);
        commitFiles(toy.authoring, { 'mod-a/test/trivial.acceptance.test.mjs': "import { test } from 'node:test';\ntest('trivially true', () => {});\n" }, 'hidden but trivial');
        toyGit(toy.authoring, ['checkout', '-q', 'main']);
      },
    });
    expect(result.ok).toBe(false);
    expect(failed(result)).toEqual(expect.arrayContaining(['hidden-red-at-baseline']));
  }, 300_000);
});
