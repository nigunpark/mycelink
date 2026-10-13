/**
 * Which file a Node JUnit result is from (src/evidence/junit-attribution.ts).
 *
 * Node's JUnit reporter names each test's file (`file="..."`) from Node 24.11
 * on. Node 22's names none: every RED on Node 22 read its declared tests as
 * "not run" (CI 38347201692, both Node 22.12.0 legs). And a runner names the
 * file by the real path of its working directory: macOS reaches its temp
 * directory through `/var`, a link to `/private/var`, so every file came out
 * as `../../../private/var/...` and did not run either (both macOS legs).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupTmpRoots, linkedAlias, makeTmpDir } from '../helpers/tmp.js';
import { judgeRed, parseJUnit, parseVitestJson } from '../../src/evidence/red-classify.js';
import { attributeByDeclaration } from '../../src/evidence/junit-attribution.js';

afterAll(() => cleanupTmpRoots());

function tree(files: Record<string, string>): string {
  const root = makeTmpDir('junit-files-');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const ERRORS_TEST = `import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ChangesetValidationError } from '../src/index.mjs';
test('a git error carries its exit code', () => {});
describe('ChangesetValidationError', () => {
  test('sorts the issues and lists one per line', () => { assert.strictEqual(1, 2); });
});
test('works', () => {});
`;
const CLI_TEST = `import { missing } from '../src/nope.mjs';
import { test } from 'node:test';
test('works', () => {});
`;
const SHOP = {
  'packages/errors/test/errors.test.mjs': ERRORS_TEST,
  'packages/errors/src/index.mjs': "export class ChangesetValidationError extends Error {}\n// test('a git error carries its exit code') in a comment is no test\n",
  'packages/cli/test/report.test.mjs': CLI_TEST,
};

/** A report as Node 22.12.0's JUnit reporter writes it: no file attribute; a test file that failed to load is named by its path. */
function node22Report(root: string, stackFile = 'packages/errors/test/errors.test.mjs'): string {
  const url = pathToFileURL(join(root, stackFile)).href;
  return `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="packages/cli/test/report.test.mjs" time="0.031640" classname="test" failure="test failed">
\t\t<failure type="testCodeFailure" message="test failed">
[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 1, signal: null }
\t\t</failure>
\t</testcase>
\t<testcase name="a git error carries its exit code" time="0.000410" classname="test"/>
\t<testsuite name="ChangesetValidationError" time="0.001228" disabled="0" errors="0" tests="1" failures="1" skipped="0" hostname="h">
\t\t<testcase name="sorts the issues and lists one per line" time="0.000155" classname="test" failure="Expected values to be strictly equal:1 !== 2">
\t\t\t<failure type="testCodeFailure" message="Expected values to be strictly equal:1 !== 2">
Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

1 !== 2

    at async Promise.all (index 0) {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2

      at TestContext.&lt;anonymous&gt; (${url}:6:73)
      at Test.runInAsyncScope (node:async_hooks:211:14)
      at Test.run (node:internal/test_runner/test:934:25) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 2,
    operator: 'strictEqual'
  }
}
\t\t\t</failure>
\t\t</testcase>
\t</testsuite>
\t<testcase name="works" time="0.000086" classname="test"/>
\t<testcase name="works" time="0.000480" classname="test"/>
</testsuites>`;
}

const filesOf = (results: { file: string | null; name: string }[]) => results.map((r) => [r.name, r.file]);

describe('a reported file under the real path of a linked root', () => {
  it("is the same file: Node's JUnit `file` and Vitest's file name, relative to the root however it was reached", () => {
    const root = tree(SHOP);
    const alias = linkedAlias(root, 'worktree-alias');
    const real = realpathSync.native(root);
    const xml = `<testsuites><testcase name="works" classname="test" file="${join(real, 'packages', 'errors', 'test', 'errors.test.mjs')}"/></testsuites>`;
    expect(filesOf(parseJUnit(xml, { root: alias }))).toEqual([['works', 'packages/errors/test/errors.test.mjs']]);
    const vitest = { testResults: [{ name: join(real, 'packages', 'errors', 'test', 'errors.test.mjs'), status: 'passed', assertionResults: [{ title: 'works', ancestorTitles: [], status: 'passed' }] }] };
    expect(filesOf(parseVitestJson(vitest, { root: alias }))).toEqual([['works', 'packages/errors/test/errors.test.mjs']]);
  });

  it('keeps a file outside the root outside: it matches no declared test', () => {
    const root = tree(SHOP);
    const elsewhere = tree({ 'x.test.mjs': "test('works', () => {});\n" });
    const xml = `<testsuites><testcase name="works" classname="test" file="${join(realpathSync.native(elsewhere), 'x.test.mjs')}"/></testsuites>`;
    const [result] = parseJUnit(xml, { root: linkedAlias(root, 'worktree-alias') });
    expect(result!.file!.startsWith('../')).toBe(true);
  });
});

describe("Node 22's JUnit reporter, which names no file", () => {
  it('attributes each test to the one test file of the module that declares it, and a file that failed to load to its own path', () => {
    const root = tree(SHOP);
    const results = parseJUnit(node22Report(root), { root, attribute: attributeByDeclaration({ root, scope: root }) });
    expect(results.map((r) => [r.suite, r.name, r.file, r.status])).toEqual([
      ['', 'packages/cli/test/report.test.mjs', 'packages/cli/test/report.test.mjs', 'failed'],
      ['', 'a git error carries its exit code', 'packages/errors/test/errors.test.mjs', 'passed'],
      ['ChangesetValidationError', 'sorts the issues and lists one per line', 'packages/errors/test/errors.test.mjs', 'failed'],
      // Declared by two files: no one file it is from.
      ['', 'works', null, 'passed'],
      ['', 'works', null, 'passed'],
    ]);
    expect(results[2]!.id).toBe('packages/errors/test/errors.test.mjs::ChangesetValidationError > sorts the issues and lists one per line');
    expect(results[2]!.category).toBe('assertion');
    // The RED reads its declared test as it would on Node 24.
    const declared = [{ file: 'packages/errors/test/errors.test.mjs', name: 'sorts the issues and lists one per line' }];
    expect(judgeRed({ exitCode: 1, timedOut: false, output: '', results, declared })).toMatchObject({ valid: true, category: 'assertion' });
  });

  it('looks only inside the module it is given', () => {
    const root = tree(SHOP);
    const results = parseJUnit(node22Report(root), { root, attribute: attributeByDeclaration({ root, scope: join(root, 'packages', 'errors') }) });
    expect(filesOf(results)).toEqual([
      ['packages/cli/test/report.test.mjs', null],
      ['a git error carries its exit code', 'packages/errors/test/errors.test.mjs'],
      ['sorts the issues and lists one per line', 'packages/errors/test/errors.test.mjs'],
      // Declared once in the module, reported twice: neither is its.
      ['works', null],
      ['works', null],
    ]);
  });

  it('never guesses: a suite chain the file does not declare, a test reported more often than declared, a name a template elsewhere could produce, a failure whose stack names another test file', () => {
    const suiteless = tree({ ...SHOP, 'packages/errors/test/errors.test.mjs': ERRORS_TEST.replace("describe('ChangesetValidationError'", "describe('Another'") });
    expect(parseJUnit(node22Report(suiteless), { root: suiteless, attribute: attributeByDeclaration({ root: suiteless, scope: suiteless }) })[2]!.file).toBeNull();

    const once = tree({ ...SHOP, 'packages/cli/test/report.test.mjs': CLI_TEST.replace("test('works'", "test('only here'") });
    // Two results named `works`, one declaration: neither is attributed.
    expect(filesOf(parseJUnit(node22Report(once), { root: once, attribute: attributeByDeclaration({ root: once, scope: once }) })).filter(([n]) => n === 'works')).toEqual([['works', null], ['works', null]]);

    const templated = tree({ ...SHOP, 'packages/cli/test/report.test.mjs': "import { test } from 'node:test';\nfor (const x of ['git error']) test(`a ${x} carries its exit code`, () => {});\n" });
    expect(parseJUnit(node22Report(templated), { root: templated, attribute: attributeByDeclaration({ root: templated, scope: templated }) })[1]!.file).toBeNull();

    const root = tree(SHOP);
    const stack = parseJUnit(node22Report(root, 'packages/cli/test/report.test.mjs'), { root, attribute: attributeByDeclaration({ root, scope: root }) });
    expect(stack[2]!.file).toBeNull();
  });

  it('attributes the tests of a template-titled loop to the one file whose template carries them (CSET-203 r17: a reproduction in a loop)', () => {
    const loop = "import { test } from 'node:test';\nfor (const label of ['a changelog', 'a release note']) {\n  test(`removes ${label} it created`, () => {});\n}\n";
    const root = tree({ ...SHOP, 'packages/errors/test/rollback.test.mjs': loop });
    const xml = '<testsuites><testcase name="removes a changelog it created" classname="test"/><testcase name="removes a release note it created" classname="test"/></testsuites>';
    expect(filesOf(parseJUnit(xml, { root, attribute: attributeByDeclaration({ root, scope: root }) }))).toEqual([
      ['removes a changelog it created', 'packages/errors/test/rollback.test.mjs'],
      ['removes a release note it created', 'packages/errors/test/rollback.test.mjs'],
    ]);
    // The same template in two files: neither.
    const twice = tree({ ...SHOP, 'packages/errors/test/rollback.test.mjs': loop, 'packages/cli/test/rollback.test.mjs': loop });
    expect(parseJUnit(xml, { root: twice, attribute: attributeByDeclaration({ root: twice, scope: twice }) }).map((r) => r.file)).toEqual([null, null]);
  });

  it('attributes nothing it was not asked to: without an attribution every file-less test stays file-less', () => {
    const root = tree(SHOP);
    expect(parseJUnit(node22Report(root), { root }).map((r) => r.file)).toEqual([null, null, null, null, null]);
  });
});
