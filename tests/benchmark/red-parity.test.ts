/**
 * Core and the authoritative replay agree on what a RED proves.
 *
 * In CSET-202 r1 core accepted the errors node's RED (`TypeError:
 * ChangesetValidationError is not a constructor`) and settled it; the
 * independent replay rejected the same RED as `missing-symbol`. Core's
 * classifier (src/evidence/red-classify.ts) now reads the same reports the
 * same way: every normalised result — file, suite, name, status, category,
 * exception type and fingerprint — is identical to the benchmark's
 * (evals-public-projects/lib/results.mjs), and so is the verdict on every
 * declared test.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// @ts-expect-error -- plain ESM module without type declarations
import * as bench from '../../evals-public-projects/lib/results.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { attributeAmong } from '../../evals-public-projects/lib/junit-files.mjs';
import { attributeByDeclaration } from '../../src/evidence/junit-attribution.js';
import { cleanupTmpRoots, linkedAlias, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { summarizeExpected } from '../../evals-public-projects/lib/tdd.mjs';
import * as core from '../../src/evidence/red-classify.js';
import { NODE_JUNIT_LINK, SUREFIRE_VISITS, VITEST_R1 } from '../helpers/red-corpus.js';

afterAll(() => cleanupTmpRoots());

const shape = (rs: Record<string, unknown>[]) => rs.map((r) => ({ id: r['id'], file: r['file'], suite: r['suite'], name: r['name'], status: r['status'], category: r['category'], type: r['type'], fingerprint: r['fingerprint'] }));

const REPORTS = [
  { label: 'vitest json (CSET-202 r1)', bench: () => bench.parseVitestJson(VITEST_R1, { root: '/ws/tree' }), core: () => core.parseVitestJson(VITEST_R1, { root: '/ws/tree' }) },
  { label: 'surefire', bench: () => bench.parseJUnit(SUREFIRE_VISITS, { root: '/ws/tree', moduleDir: 'spring-petclinic-visits-service' }), core: () => core.parseJUnit(SUREFIRE_VISITS, { root: '/ws/tree', moduleDir: 'spring-petclinic-visits-service' }) },
  { label: "node's junit reporter", bench: () => bench.parseJUnit(NODE_JUNIT_LINK, { root: '/ws/tree' }), core: () => core.parseJUnit(NODE_JUNIT_LINK, { root: '/ws/tree' }) },
];

describe('RED classification parity with the authoritative replay', () => {
  it.each(REPORTS)('$label: identical normalised results', ({ bench: b, core: c }) => {
    const expected = shape(b());
    expect(expected.length).toBeGreaterThan(0);
    expect(shape(c() as unknown as Record<string, unknown>[])).toEqual(expected);
  });

  it.each(REPORTS)('$label: the same verdict for every test the report names, declared alone', ({ bench: b, core: c }) => {
    const results = b();
    const adapter = { matches: (r: { file: string; name: string }, e: { file: string; name: string }) => r.file === e.file && (r.name === e.name || r.name.startsWith(`${e.name}(`) || r.name.startsWith(`${e.name}[`)) };
    for (const r of results as { file: string; name: string; status: string }[]) {
      const declared = [{ file: r.file, name: r.name }];
      const [summary] = summarizeExpected(results, declared, adapter);
      const benchValid = r.status === 'failed' && bench.RED_VALID_CATEGORIES.has(summary.category);
      const judged = core.judgeRed({ exitCode: 1, timedOut: false, output: '', results: c(), declared });
      expect({ test: r.name, valid: judged.valid, category: judged.category }).toEqual({ test: r.name, valid: benchValid, category: summary.category === 'passed' ? 'passed' : summary.category });
    }
  });

  it('agrees on the classification vocabulary: the same valid and invalid categories', () => {
    expect([...core.RED_VALID_CATEGORIES].sort()).toEqual([...bench.RED_VALID_CATEGORIES].sort());
    for (const category of bench.INVALID_RED_CATEGORIES) expect(core.INVALID_RED_CATEGORIES.has(category)).toBe(true);
  });

  it.each([
    { details: 'TypeError: ChangesetValidationError is not a constructor' },
    { details: "SyntaxError: The requested module '@changesets/errors' does not provide an export named 'ChangesetValidationError'" },
    { details: "AssertionError: expected 'undefined' to be 'function'" },
    { details: 'ChangesetValidationError: Invalid changesets:\n- a: bad' },
    { type: 'java.lang.NoClassDefFoundError', message: 'org/example/Vet' },
    { type: 'java.lang.NoSuchMethodError', message: 'Visit.getVetId()' },
    { type: 'org.opentest4j.AssertionFailedError', message: 'expected: <200> but was: <404>' },
    { type: 'java.lang.IllegalStateException', message: 'Failed to load ApplicationContext for [X]' },
    { details: 'Error: Hook timed out in 10000ms.' },
  ])('classifyFailure(%j) is the same in both', (failure) => {
    expect(core.classifyFailure(failure)).toBe(bench.classifyFailure(failure));
  });
});

describe("a report's files, as the run wrote them, read alike", () => {
  const sources = {
    'packages/errors/test/errors.test.mjs':
      "import { test, describe } from 'node:test';\ntest('a git error carries its exit code', () => {});\ndescribe('ChangesetValidationError', () => {\n  test('sorts the issues and lists one per line', () => {});\n});\ntest('works', () => {});\n",
    'packages/cli/test/report.test.mjs': "import { missing } from '../src/nope.mjs';\nimport { test } from 'node:test';\ntest('works', () => {});\n",
  };
  const node22 = `<testsuites>
<testcase name="packages/cli/test/report.test.mjs" classname="test" failure="test failed"><failure type="testCodeFailure" message="test failed">[Error: test failed]</failure></testcase>
<testcase name="a git error carries its exit code" classname="test"/>
<testsuite name="ChangesetValidationError"><testcase name="sorts the issues and lists one per line" classname="test"/></testsuite>
<testcase name="works" classname="test"/>
<testcase name="works" classname="test"/>
</testsuites>`;

  it("Node 22's JUnit, which names no file: the same file for every test, or none", () => {
    const root = makeTmpDir('parity-files-');
    for (const [rel, text] of Object.entries(sources)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const benchResults = bench.parseJUnit(node22, { root, attribute: attributeAmong({ root, files: Object.keys(sources) }) });
    const coreResults = core.parseJUnit(node22, { root, attribute: attributeByDeclaration({ root, scope: root }) });
    expect(shape(coreResults as unknown as Record<string, unknown>[])).toEqual(shape(benchResults));
    expect(benchResults.map((r: { file: string | null }) => r.file)).toEqual([
      'packages/cli/test/report.test.mjs',
      'packages/errors/test/errors.test.mjs',
      'packages/errors/test/errors.test.mjs',
      null,
      null,
    ]);
  });

  it('a file under the real path of a linked root (macOS: /private/var for /var): the same relative file', () => {
    const root = makeTmpDir('parity-files-');
    mkdirSync(join(root, 'mod-a', 'test'), { recursive: true });
    writeFileSync(join(root, 'mod-a', 'test', 'a.test.mjs'), "test('works', () => {});\n");
    const alias = linkedAlias(root, 'tree');
    const xml = `<testsuites><testcase name="works" classname="test" file="${join(realpathSync.native(root), 'mod-a', 'test', 'a.test.mjs')}"/></testsuites>`;
    expect(bench.parseJUnit(xml, { root: alias })[0].file).toBe('mod-a/test/a.test.mjs');
    expect(core.parseJUnit(xml, { root: alias })[0]!.file).toBe('mod-a/test/a.test.mjs');
  });
});
