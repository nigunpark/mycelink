/**
 * The model-free selftest, run end to end on the toy suite: the same code
 * the real projects go through (tools/selftest.mjs in WSL), with no cache.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { CONVERGENT_REFERENCE, TOY_PRD, buildToy, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { independentCopy, runScaffold, selftest } from '../../evals-public-projects/lib/selftest.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { declaredTests, testsInDelta } from '../../evals-public-projects/lib/testids.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { writeCases } from '../../evals-public-projects/lib/cases.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { qualifyPrd } from '../../evals-public-projects/lib/qualify.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { findPrd, loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { importEvaluator } from '../../evals-public-projects/lib/evaluator.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { baselineRecord, runFrozenBaseline } from '../../evals-public-projects/lib/baseline.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { createAdapter } from '../../evals-public-projects/lib/adapters/index.mjs';

afterAll(() => cleanupTmpRoots());

let toy: Toy;
let prdDir: string;

beforeAll(async () => {
  // A reference with production and test support an independent delivery may converge on (the leakage checks need both).
  toy = buildToy(CONVERGENT_REFERENCE);
  const { project, prd } = findPrd(loadSuite(toy.suite), TOY_PRD);
  prdDir = prd.dir;
  importEvaluator({ project, prdId: TOY_PRD, from: toy.authoring, cacheRoot: toy.cacheRoot });
  const runs = [await runFrozenBaseline({ project, bundlePath: toy.bundle, adapter: createAdapter(project.adapter), workRoot: makeTmpDir('bench-s-base-'), ctx: { isolation: TEST_ISOLATION }, label: 'b' })];
  writeFileSync(join(project.dir, 'baseline-tests.json'), JSON.stringify(baselineRecord({ project, runs }).record, null, 2) + '\n');
  const q = await qualifyPrd({ project, prd, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-s-q-'), repeat: 1, isolation: TEST_ISOLATION });
  expect(q.ok).toBe(true);
  writeCases(loadSuite(toy.suite), join(toy.suite, 'cases'));
}, 300_000);

// TOY-002 and TOY-003 complete the archetypes only; they have no evaluator artifacts.
const run = () => selftest({ suiteRoot: toy.suite, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-s-work-'), prds: [TOY_PRD], isolation: TEST_ISOLATION });
const failed = (r: any) => r.checks.filter((c: any) => !c.ok).map((c: any) => c.id);

describe('selftest', () => {
  it('passes every check on a qualified suite: clean scaffold, baseline rejected, reference accepted test-first, mutations rejected, faults detected', async () => {
    const r = await run();
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c: any) => c.id)).toEqual([
      'suite',
      'cases-current',
      'source:toyshop',
      `evaluator:${TOY_PRD}`,
      `qualified:${TOY_PRD}`,
      `scaffold-within-harness-limit:${TOY_PRD}`,
      `scaffold-clean:${TOY_PRD}`,
      `baseline-rejected:${TOY_PRD}`,
      `reference-accepted:${TOY_PRD}`,
      `rejects-dirty:${TOY_PRD}`,
      `rejects-unsafe-config:${TOY_PRD}`,
      `rejects-rewritten-history:${TOY_PRD}`,
      `rejects-smuggled-hidden:${TOY_PRD}`,
      `reference-production-convergence:${TOY_PRD}`,
      `rejects-reference-tests:${TOY_PRD}`,
      `rejects-reference-objects:${TOY_PRD}`,
      `rejects-store-copy:${TOY_PRD}`,
      `rejects-tampered-evaluator:${TOY_PRD}`,
      `fault-teammate-commit:${TOY_PRD}`,
      `fault-late-defect:${TOY_PRD}`,
    ]);
  }, 300_000);

  it('runs the generated scaffold as the harness does, and fails one that would not finish well within its 120 s kill', () => {
    const ok = runScaffold({ suiteRoot: toy.suite, caseName: 'toyshop-reserve-stock', target: join(makeTmpDir('bench-s-sc-'), 'ws'), home: makeTmpDir('bench-s-home-'), cacheRoot: toy.cacheRoot });
    expect(ok).toMatchObject({ ok: true, detail: expect.stringMatching(/finished in \d+ s \(budget 90 s, harness kill 120 s\)/) });
    const slow = runScaffold({ suiteRoot: toy.suite, caseName: 'toyshop-reserve-stock', target: join(makeTmpDir('bench-s-sc-'), 'ws'), home: makeTmpDir('bench-s-home-'), cacheRoot: toy.cacheRoot, budgetMs: 1 });
    expect(slow.ok).toBe(false);
  }, 120_000);

  it('fails on drifted cases and on a PRD without qualification evidence', async () => {
    const caseFile = join(toy.suite, 'cases', 'toyshop-reserve-stock', 'case.yaml');
    const original = readFileSync(caseFile, 'utf8');
    writeFileSync(caseFile, original.replace('runs: 3', 'runs: 1'));
    try {
      expect(failed(await run())).toEqual(['cases-current']);
    } finally {
      writeFileSync(caseFile, original);
    }
    const summaryFile = join(prdDir, 'qualification.json');
    const summary = readFileSync(summaryFile);
    rmSync(summaryFile);
    try {
      // Without qualification the verifier refuses to judge the PRD at all: every verdict on it fails.
      expect(failed(await run())).toEqual([`qualified:${TOY_PRD}`, `baseline-rejected:${TOY_PRD}`, `reference-accepted:${TOY_PRD}`]);
    } finally {
      writeFileSync(summaryFile, summary);
    }
  }, 600_000);

  it('copies a test independently: another blob, the same code', () => {
    expect(independentCopy('a/Test.java', Buffer.from('class T {}\n')).toString()).toBe('// independent copy (selftest)\nclass T {}\n');
    expect(independentCopy('a/__tests__/fixture.json', Buffer.from('{}\n')).toString()).toBe('{}\n\n');
  });

  it('copies a test file without changing any test it declares, the last one included', () => {
    // A declaration block runs to the next declaration or the end of the file: a trailing marker would change the last test.
    const java = 'package a;\n\nclass T {\n    @Test\n    void first() {}\n\n    @Test\n    void last() {}\n}\n';
    const ts = "import { it } from 'vitest';\n\nit('first', () => {});\n\nit('last', () => {});\n";
    for (const [path, source] of [['a/src/test/java/a/T.java', java], ['a/test/t.test.ts', ts]]) {
      const copy = independentCopy(path, Buffer.from(source)).toString();
      expect(copy).not.toBe(source);
      expect(declaredTests(path, copy)).toEqual(declaredTests(path, source));
      expect(testsInDelta([{ path, before: source, after: copy }], { isTestPath: () => true })).toEqual([]);
    }
    // A shebang stays the first line; a snapshot keeps its header first.
    expect(independentCopy('bin/cli.js', Buffer.from('#!/usr/bin/env node\nrun();\n')).toString()).toBe('#!/usr/bin/env node\n// independent copy (selftest)\nrun();\n');
    expect(independentCopy('a/__snapshots__/t.test.ts.snap', Buffer.from('// Vitest Snapshot v1\n')).toString()).toMatch(/^\/\/ Vitest Snapshot v1\n/);
  });
});
