/**
 * Test results from three runners (Node's JUnit reporter, Maven Surefire,
 * Vitest JSON) normalised to one shape, and the failure classification that
 * decides whether a RED fails for a missing behaviour (assertion, or an
 * exception from the code under test) or for a reason that proves nothing
 * (syntax, import, missing symbol, setup, timeout, crash, not run).
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without type declarations
import { RED_VALID_CATEGORIES, classifyFailure, failureFingerprint, parseJUnit, parseVitestJson, parseXml } from '../../evals-public-projects/lib/results.mjs';

const NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testsuite name="inventory" tests="3" failures="1" skipped="1">
\t\t<testcase name="reserves stock" classname="test" file="/ws/tree/mod-a/test/a.test.mjs" failure="Expected values to be strictly equal:&#10;&#10;1 !== 2&#10;">
\t\t\t<failure type="testCodeFailure" message="Expected values to be strictly equal:&#10;&#10;1 !== 2">
Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:
  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
      at TestContext.&lt;anonymous> (file:///ws/tree/mod-a/test/a.test.mjs:4:41)
\t\t\t</failure>
\t\t</testcase>
\t\t<testcase name="passes" classname="test" file="/ws/tree/mod-a/test/a.test.mjs"/>
\t\t<testcase name="todo one" classname="test" file="/ws/tree/mod-a/test/a.test.mjs"><skipped type="todo" message="true"/></testcase>
\t</testsuite>
\t<testcase name="calls a missing export" classname="test" file="/ws/tree/mod-b/test/b.test.mjs" failure="reserve is not a function">
\t\t<failure type="testCodeFailure" message="reserve is not a function">
[Error [ERR_TEST_FAILURE]: reserve is not a function] {
  cause: TypeError: reserve is not a function
\t\t</failure>
\t</testcase>
\t<!-- tests 4 -->
</testsuites>`;

const SUREFIRE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="org.example.visits.web.VisitResourceTest" time="2.7" tests="3" errors="1" skipped="0" failures="1">
  <properties><property name="java.version" value="21"/></properties>
  <testcase name="shouldFetchVisits" classname="org.example.visits.web.VisitResourceTest" time="0.4"/>
  <testcase name="storesVetId" classname="org.example.visits.web.VisitResourceTest" time="0.1">
    <failure message="JSON path &quot;$.vetId&quot; expected:&lt;3&gt; but was:&lt;null&gt;" type="java.lang.AssertionError"><![CDATA[java.lang.AssertionError: JSON path "$.vetId" expected:<3> but was:<null>
\tat org.springframework.test.util.AssertionErrors.fail(AssertionErrors.java:61)]]></failure>
    <system-out><![CDATA[log line]]></system-out>
  </testcase>
  <testcase name="contextLoads" classname="org.example.visits.web.VisitResourceTest" time="0.0">
    <error message="Failed to load ApplicationContext for [WebMergedContextConfiguration@1a2b]" type="java.lang.IllegalStateException">java.lang.IllegalStateException: Failed to load ApplicationContext</error>
  </testcase>
</testsuite>`;

const VITEST = {
  numTotalTests: 3,
  testResults: [
    {
      name: '/ws/tree/packages/cli/src/commands/status/__tests__/explain.test.ts',
      status: 'failed',
      message: '',
      assertionResults: [
        { ancestorTitles: ['status', '--explain'], title: 'prints a reason per package', fullName: 'status --explain prints a reason per package', status: 'failed', failureMessages: ["AssertionError: expected 'x' to contain 'reason: changeset'\n    at /ws/tree/packages/cli/src/commands/status/__tests__/explain.test.ts:41:21"] },
        { ancestorTitles: ['status'], title: 'is unchanged without --explain', fullName: 'status is unchanged without --explain', status: 'passed', failureMessages: [] },
        { ancestorTitles: [], title: 'todo case', fullName: 'todo case', status: 'todo', failureMessages: [] },
      ],
    },
    {
      name: '/ws/tree/packages/errors/src/broken.test.ts',
      status: 'failed',
      message: 'Failed to resolve import "../missing.ts" from "packages/errors/src/broken.test.ts". Does the file exist?',
      assertionResults: [],
    },
  ],
};

describe('parseXml', () => {
  it('parses elements, attributes, entities, CDATA and comments', () => {
    const doc = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'&lt;&#65;&#x42;&gt;\'><b/>text<![CDATA[<raw>]]></a>');
    expect(doc).toMatchObject({ name: 'a', attrs: { x: '1 & 2', y: '<AB>' }, children: [{ name: 'b', attrs: {}, children: [] }] });
    expect(doc.text).toBe('text<raw>');
    expect(() => parseXml('<a><b></a>')).toThrow(/mismatched/);
  });
});

describe('parseJUnit', () => {
  it("normalises Node's JUnit reporter with nested suites and repository-relative files", () => {
    const results = parseJUnit(NODE_JUNIT, { root: '/ws/tree' });
    expect(results.map((r: any) => [r.file, r.suite, r.name, r.status, r.category])).toEqual([
      ['mod-a/test/a.test.mjs', 'inventory', 'reserves stock', 'failed', 'assertion'],
      ['mod-a/test/a.test.mjs', 'inventory', 'passes', 'passed', 'passed'],
      ['mod-a/test/a.test.mjs', 'inventory', 'todo one', 'skipped', 'skipped'],
      ['mod-b/test/b.test.mjs', '', 'calls a missing export', 'failed', 'missing-symbol'],
    ]);
    expect(results[0].id).toBe('mod-a/test/a.test.mjs::inventory > reserves stock');
    expect(results[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('normalises Surefire reports, mapping classes to their test source files', () => {
    const results = parseJUnit(SUREFIRE, { root: '/ws/tree', moduleDir: 'spring-petclinic-visits-service' });
    expect(results.map((r: any) => [r.id, r.status, r.category, r.type])).toEqual([
      ['spring-petclinic-visits-service/org.example.visits.web.VisitResourceTest#shouldFetchVisits', 'passed', 'passed', null],
      ['spring-petclinic-visits-service/org.example.visits.web.VisitResourceTest#storesVetId', 'failed', 'assertion', 'java.lang.AssertionError'],
      ['spring-petclinic-visits-service/org.example.visits.web.VisitResourceTest#contextLoads', 'failed', 'setup', 'java.lang.IllegalStateException'],
    ]);
    expect(results[1].file).toBe('spring-petclinic-visits-service/src/test/java/org/example/visits/web/VisitResourceTest.java');
  });
});

describe('parseVitestJson', () => {
  it('normalises assertion results and turns a suite that failed to load into not-run results for its file', () => {
    const results = parseVitestJson(VITEST, { root: '/ws/tree' });
    expect(results.map((r: any) => [r.id, r.status, r.category])).toEqual([
      ['packages/cli/src/commands/status/__tests__/explain.test.ts::status > --explain > prints a reason per package', 'failed', 'assertion'],
      ['packages/cli/src/commands/status/__tests__/explain.test.ts::status > is unchanged without --explain', 'passed', 'passed'],
      ['packages/cli/src/commands/status/__tests__/explain.test.ts::todo case', 'skipped', 'skipped'],
      ['packages/errors/src/broken.test.ts::<suite>', 'failed', 'import'],
    ]);
  });
});

describe('classifyFailure', () => {
  it.each([
    [{ type: 'org.opentest4j.AssertionFailedError', message: 'expected: <200> but was: <404>' }, 'assertion'],
    [{ type: 'java.lang.AssertionError', message: 'Status expected:<201> but was:<200>' }, 'assertion'],
    [{ details: "AssertionError: expected [] to have a length of 3 but got +0" }, 'assertion'],
    [{ type: 'java.lang.NullPointerException', message: 'Cannot invoke "Visit.getVetId()"' }, 'exception'],
    [{ details: "TypeError: Cannot read properties of undefined (reading 'reasons')" }, 'exception'],
    [{ details: 'TypeError: assembleReleasePlan is not a function' }, 'missing-symbol'],
    [{ type: 'java.lang.NoSuchMethodError', message: 'Visit.getVetId()' }, 'missing-symbol'],
    [{ details: "SyntaxError: Unexpected token '}'" }, 'syntax'],
    [{ details: 'Error: Cannot find module ../src/vets.mjs' }, 'import'],
    [{ type: 'java.lang.NoClassDefFoundError', message: 'org/example/Vet' }, 'import'],
    [{ type: 'java.lang.IllegalStateException', message: 'Failed to load ApplicationContext for [X]' }, 'setup'],
    [{ details: 'Error: Hook timed out in 10000ms.' }, 'timeout'],
    [{ type: 'org.junit.jupiter.api.AssertionFailedError', message: 'execution timed out after 5000 ms' }, 'timeout'],
    [{ details: 'Error: Test timed out in 5000ms.' }, 'timeout'],
    [{ type: 'java.lang.OutOfMemoryError', message: 'Java heap space' }, 'crash'],
  ])('%j -> %s', (failure, category) => {
    expect(classifyFailure(failure)).toBe(category);
  });

  it('accepts only assertion and code-under-test exceptions as evidence of a missing behaviour', () => {
    expect([...RED_VALID_CATEGORIES].sort()).toEqual(['assertion', 'exception']);
  });
});

describe('failureFingerprint', () => {
  it('ignores volatile detail (paths, line numbers, durations, ids) but not the failure itself', () => {
    const a = failureFingerprint({ category: 'assertion', type: 'AssertionError', message: 'expected 201 but got 200 at /tmp/run-1/tree/a.test.ts:41:21 after 35ms' });
    const b = failureFingerprint({ category: 'assertion', type: 'AssertionError', message: 'expected 201 but got 200 at /tmp/run-2/tree/a.test.ts:52:7 after 1200ms' });
    const c = failureFingerprint({ category: 'assertion', type: 'AssertionError', message: 'expected 409 but got 201' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
