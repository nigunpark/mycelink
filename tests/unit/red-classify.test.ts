/**
 * Core RED semantics (src/evidence/red-classify.ts): a RED is valid only when
 * the tests it declares fail for a missing behaviour — an assertion, or an
 * exception from the code under test. A syntax, import or missing-symbol
 * failure, a setup step that failed, a declared test that did not run, no
 * declared test at all, a timeout or a pass prove nothing. A nonzero exit
 * alone is never enough. The CSET-202 r1 cases are judged exactly as the
 * authoritative benchmark replay judged them.
 */
import { describe, expect, it } from 'vitest';
import {
  RED_VALID_CATEGORIES,
  classifyFailure,
  classifyRedOutput,
  judgeRed,
  parseJUnit,
  parseVitestJson,
  redReasonFor,
} from '../../src/evidence/red-classify.js';
import {
  MAVEN_TEXT_ASSERTION,
  MAVEN_TEXT_COMPILE,
  MAVEN_TEXT_DOMAIN_EXCEPTION,
  MAVEN_TEXT_MISSING_CLASS,
  NODE_JUNIT_LINK,
  SUREFIRE_VISITS,
  VITEST_R1,
  VITEST_TEXT_ASSERTION,
  VITEST_TEXT_DOMAIN_EXCEPTION,
  VITEST_TEXT_LINK,
  VITEST_TEXT_NOT_A_CONSTRUCTOR,
  VITEST_TEXT_NO_FILES,
} from '../helpers/red-corpus.js';

const ERRORS_TEST = 'packages/errors/src/index.test.ts';

describe('classifyFailure', () => {
  it.each([
    [{ details: 'TypeError: ChangesetValidationError is not a constructor\n    at index.test.ts:20:21' }, 'missing-symbol'],
    [{ details: 'TypeError: readChangesets is not a function' }, 'missing-symbol'],
    [{ details: "SyntaxError: The requested module '@changesets/errors' does not provide an export named 'ChangesetValidationError'" }, 'syntax'],
    [{ details: "The requested module './index.mjs' does not provide an export named 'X'" }, 'missing-symbol'],
    [{ details: "AssertionError: expected 'undefined' to be 'function'" }, 'assertion'],
    [{ details: 'Error: Found changeset a for package x which is not in the workspace' }, 'exception'],
    [{ details: 'ChangesetValidationError: Invalid changesets:\n- a: bad' }, 'exception'],
    [{ details: 'Error: Cannot find package \'@changesets/errors\' imported from /ws/tree/packages/read/src/index.ts' }, 'import'],
    [{ details: 'Failed to resolve import "./missing.ts" from "src/a.test.ts". Does the file exist?' }, 'import'],
    [{ type: 'org.opentest4j.AssertionFailedError', message: 'expected: <3> but was: <null>' }, 'assertion'],
    [{ type: 'org.example.visits.web.ResourceNotFoundException', message: 'Vet 42 not found' }, 'exception'],
    [{ type: 'java.lang.NoClassDefFoundError', message: 'org/example/visits/client/VetClient' }, 'import'],
    [{ type: 'java.lang.NoSuchMethodError', message: "'java.lang.Integer Visit.getVetId()'" }, 'missing-symbol'],
    [{ type: 'java.lang.IllegalStateException', message: 'Failed to load ApplicationContext for [X]' }, 'setup'],
    [{ details: 'Error: Test timed out in 5000ms.' }, 'timeout'],
  ])('%j -> %s', (failure, category) => {
    expect(classifyFailure(failure)).toBe(category);
  });

  it('accepts only assertion and code-under-test exceptions as a missing behaviour', () => {
    expect([...RED_VALID_CATEGORIES].sort()).toEqual(['assertion', 'exception']);
  });
});

describe('structured reports', () => {
  it('reads Vitest JSON: the r1 errors RED is a missing symbol, a suite that cannot link is a syntax failure of its file', () => {
    const results = parseVitestJson(VITEST_R1, { root: '/ws/tree' });
    expect(results.map((r) => [r.file, r.name, r.status, r.category])).toEqual([
      [ERRORS_TEST, 'should include error message and exit code in error', 'passed', 'passed'],
      [ERRORS_TEST, 'sorts issues and formats the message', 'failed', 'missing-symbol'],
      [ERRORS_TEST, 'is exported as a class', 'failed', 'assertion'],
      ['packages/assemble-release-plan/src/index.test.ts', 'reports unknown packages and mixed changesets together', 'failed', 'exception'],
      ['packages/assemble-release-plan/src/index.test.ts', 'throws the validation error of @changesets/errors', 'failed', 'exception'],
      ['packages/cli/src/__tests__/validation-report.test.ts', '<suite>', 'failed', 'syntax'],
      ['packages/read/src/index.test.ts', '<suite>', 'failed', 'import'],
    ]);
    expect(results[1]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reads Surefire reports: assertion, domain exception, missing class, missing method, context that does not load', () => {
    const results = parseJUnit(SUREFIRE_VISITS, { root: '/ws/tree', moduleDir: 'spring-petclinic-visits-service' });
    expect(results.map((r) => [r.name, r.category])).toEqual([
      ['storesVetId', 'assertion'],
      ['rejectsUnknownVet', 'exception'],
      ['usesVetClient', 'import'],
      ['readsVetId', 'missing-symbol'],
      ['contextLoads', 'setup'],
    ]);
    expect(results[0]!.file).toBe('spring-petclinic-visits-service/src/test/java/org/example/visits/web/VisitResourceTest.java');
  });

  it("reads Node's JUnit reporter: a file that failed to link reports under its own path, not its tests' names", () => {
    const results = parseJUnit(NODE_JUNIT_LINK, { root: '/ws/tree' });
    expect(results.map((r) => [r.file, r.name, r.status])).toEqual([
      ['packages/errors/test/errors.test.mjs', 'sorts the issues', 'failed'],
      ['packages/cli/test/report.test.mjs', 'packages/cli/test/report.test.mjs', 'failed'],
    ]);
    expect(results[0]!.category).toBe('assertion');
  });
});

describe('classifyRedOutput (no structured report: conservative patterns)', () => {
  it.each([
    [VITEST_TEXT_NOT_A_CONSTRUCTOR, 'missing-symbol'],
    [VITEST_TEXT_LINK, 'syntax'],
    [VITEST_TEXT_NO_FILES, 'no-test'],
    [MAVEN_TEXT_COMPILE, 'compile'],
    [MAVEN_TEXT_MISSING_CLASS, 'import'],
    [VITEST_TEXT_ASSERTION, 'assertion'],
    [MAVEN_TEXT_ASSERTION, 'assertion'],
    [VITEST_TEXT_DOMAIN_EXCEPTION, 'exception'],
    [MAVEN_TEXT_DOMAIN_EXCEPTION, 'exception'],
    ["Error: Cannot find module './nope'", 'import'],
    ['npm ERR! missing script: test', 'setup'],
    ['Error: connect ECONNREFUSED 127.0.0.1:6379', 'environment'],
    ["TS1005: ';' expected.", 'syntax'],
    ['AssertionError: expected publish() to emit', 'assertion'],
    ['1 failing\n  expected 2 to equal 3', 'assertion'],
    ['the process exited with code 1', 'crash'],
  ])('%#: -> %s', (output, category) => {
    expect(classifyRedOutput(output, 1).category).toBe(category);
  });

  it('never calls a nonzero exit alone a RED, and a pass or a timeout never one either', () => {
    expect(classifyRedOutput('', 1).category).toBe('crash');
    expect(classifyRedOutput('AssertionError: expected 1 to equal 2', 0).category).toBe('passed');
    expect(classifyRedOutput('AssertionError: expected 1 to equal 2', 124, { timedOut: true }).category).toBe('timeout');
  });

  it('maps every category to the coarse red_reason, with only a missing behaviour valid', () => {
    expect(redReasonFor('assertion')).toBe('behaviour-missing');
    expect(redReasonFor('exception')).toBe('behaviour-missing');
    expect(redReasonFor('syntax')).toBe('syntax-error');
    expect(redReasonFor('compile')).toBe('syntax-error');
    expect(redReasonFor('environment')).toBe('environment-error');
    for (const c of ['import', 'missing-symbol', 'setup', 'timeout', 'crash', 'not-run', 'no-test', 'passed'] as const) expect(redReasonFor(c)).toBe('setup-error');
  });
});

describe('judgeRed', () => {
  const results = parseVitestJson(VITEST_R1, { root: '/ws/tree' });
  const declared = (...names: string[]) => names.map((name) => ({ file: ERRORS_TEST, name }));

  it('refuses the r1 with-normal errors RED: its declared test failed on a missing symbol', () => {
    const j = judgeRed({ exitCode: 1, timedOut: false, output: '', results, declared: declared('sorts issues and formats the message') });
    expect(j).toMatchObject({ valid: false, category: 'missing-symbol' });
    expect(j.tests).toEqual([expect.objectContaining({ file: ERRORS_TEST, name: 'sorts issues and formats the message', status: 'failed', category: 'missing-symbol' })]);
    expect(j.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(j.detail).toMatch(/sorts issues and formats the message \(missing-symbol\)/);
  });

  it('accepts a declared test that fails an assertion, whatever an undeclared test of the same run did', () => {
    const j = judgeRed({ exitCode: 1, timedOut: false, output: '', results, declared: declared('is exported as a class') });
    expect(j).toMatchObject({ valid: true, category: 'assertion' });
  });

  it('accepts a RED whose file change also declares an unchanged test that passes, as the replay does', () => {
    // The real model-free CSET-202 run: the errors test file's import line changed, so its existing
    // GitError test is declared too; it passes, the new test fails an assertion. The replay accepts it.
    const j = judgeRed({ exitCode: 1, timedOut: false, output: '', results, declared: declared('should include error message and exit code in error', 'is exported as a class') });
    expect(j).toMatchObject({ valid: true, category: 'assertion' });
    expect(j.tests.map((t) => [t.name, t.status])).toEqual([
      ['should include error message and exit code in error', 'passed'],
      ['is exported as a class', 'failed'],
    ]);
    // Only passing declared tests: still no RED.
    expect(judgeRed({ exitCode: 1, timedOut: false, output: '', results, declared: declared('should include error message and exit code in error') })).toMatchObject({ valid: false, category: 'passed' });
  });

  it('accepts an expected domain exception from the code under test, never as setup', () => {
    const j = judgeRed({ exitCode: 1, timedOut: false, output: '', results, declared: [{ file: 'packages/assemble-release-plan/src/index.test.ts', name: 'throws the validation error of @changesets/errors' }] });
    expect(j).toMatchObject({ valid: true, category: 'exception' });
  });

  it('refuses a declared test that did not run (its file failed to link)', () => {
    const j = judgeRed({ exitCode: 1, timedOut: false, output: '', results, declared: [{ file: 'packages/cli/src/__tests__/validation-report.test.ts', name: 'prints once' }] });
    expect(j).toMatchObject({ valid: false, category: 'not-run' });
  });

  it('refuses a RED that declares no test, a RED that passed, a failed setup step and a timeout', () => {
    expect(judgeRed({ exitCode: 1, timedOut: false, output: 'AssertionError: x', results: null, declared: [] })).toMatchObject({ valid: false, category: 'no-test' });
    expect(judgeRed({ exitCode: 0, timedOut: false, output: '', results, declared: declared('is exported as a class') })).toMatchObject({ valid: false, category: 'passed' });
    expect(judgeRed({ exitCode: 1, timedOut: false, output: '', results: null, declared: null, failedStep: { argv: ['pnpm', 'build'], exit_code: 1 } })).toMatchObject({ valid: false, category: 'setup' });
    expect(judgeRed({ exitCode: 124, timedOut: true, output: 'AssertionError: x', results: null, declared: null })).toMatchObject({ valid: false, category: 'timeout' });
  });

  it('refuses a structured run whose report holds no result at all', () => {
    expect(judgeRed({ exitCode: 1, timedOut: false, output: 'AssertionError: x', results: [], declared: declared('is exported as a class') })).toMatchObject({ valid: false, category: 'not-run' });
  });

  it('judges by the conservative patterns when there is no report', () => {
    expect(judgeRed({ exitCode: 1, timedOut: false, output: VITEST_TEXT_NOT_A_CONSTRUCTOR, results: null, declared: declared('sorts issues and formats the message') })).toMatchObject({ valid: false, category: 'missing-symbol' });
    expect(judgeRed({ exitCode: 1, timedOut: false, output: MAVEN_TEXT_COMPILE, results: null, declared: null })).toMatchObject({ valid: false, category: 'compile' });
    expect(judgeRed({ exitCode: 1, timedOut: false, output: VITEST_TEXT_ASSERTION, results: null, declared: declared('is exported as a class') })).toMatchObject({ valid: true, category: 'assertion' });
  });

  it('matches a parameterised Surefire report to the method a test file declares', () => {
    const surefire = parseJUnit(SUREFIRE_VISITS.replace('name="storesVetId"', 'name="storesVetId(int)[1]"'), { root: '/ws/tree', moduleDir: 'spring-petclinic-visits-service' });
    const file = 'spring-petclinic-visits-service/src/test/java/org/example/visits/web/VisitResourceTest.java';
    expect(judgeRed({ exitCode: 1, timedOut: false, output: '', results: surefire, declared: [{ file, name: 'storesVetId' }] })).toMatchObject({ valid: true, category: 'assertion' });
    expect(judgeRed({ exitCode: 1, timedOut: false, output: '', results: surefire, declared: [{ file, name: 'readsVetId' }] })).toMatchObject({ valid: false, category: 'missing-symbol' });
  });
});
