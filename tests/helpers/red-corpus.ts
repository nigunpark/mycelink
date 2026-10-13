/**
 * Test reports and runner output the RED classification is judged on, in
 * core (src/evidence/red-classify.ts) and in the benchmark's authoritative
 * replay (evals-public-projects/lib/results.mjs) alike: the CSET-202 r1
 * cases exactly as the runners reported them, and the Maven ones.
 */

/** Vitest JSON (`--reporter=json`): the r1 with-normal errors RED, a domain exception, an assertion, and the r1 with-faults suite that could not link. */
export const VITEST_R1 = {
  numTotalTests: 6,
  testResults: [
    {
      name: '/ws/tree/packages/errors/src/index.test.ts',
      status: 'failed',
      message: '',
      assertionResults: [
        { ancestorTitles: ['Error classes', 'GitError class'], title: 'should include error message and exit code in error', status: 'passed', failureMessages: [] },
        {
          ancestorTitles: ['Error classes', 'ChangesetValidationError'],
          title: 'sorts issues and formats the message',
          status: 'failed',
          failureMessages: ['TypeError: ChangesetValidationError is not a constructor\n    at /ws/tree/packages/errors/src/index.test.ts:20:21'],
        },
        {
          ancestorTitles: ['ChangesetValidationError'],
          title: 'is exported as a class',
          status: 'failed',
          failureMessages: ["AssertionError: expected 'undefined' to be 'function' // Object.is equality\n    at /ws/tree/packages/errors/src/index.test.ts:31:52"],
        },
      ],
    },
    {
      name: '/ws/tree/packages/assemble-release-plan/src/index.test.ts',
      status: 'failed',
      message: '',
      assertionResults: [
        {
          ancestorTitles: ['assembleReleasePlan'],
          title: 'reports unknown packages and mixed changesets together',
          status: 'failed',
          failureMessages: ['Error: Found changeset strange-words-combine for package pkg-z which is not in the workspace\n    at mapGetOrThrow (/ws/tree/packages/assemble-release-plan/src/utils.ts:66:11)'],
        },
        {
          ancestorTitles: ['assembleReleasePlan'],
          title: 'throws the validation error of @changesets/errors',
          status: 'failed',
          failureMessages: ['ChangesetValidationError: Invalid changesets:\n- a: Found changeset a for package x which is not in the workspace\n    at getRelevantChangesets (/ws/tree/packages/assemble-release-plan/src/index.ts:292:11)'],
        },
      ],
    },
    {
      name: '/ws/tree/packages/cli/src/__tests__/validation-report.test.ts',
      status: 'failed',
      message: "SyntaxError: The requested module '@changesets/errors' does not provide an export named 'ChangesetValidationError'",
      assertionResults: [],
    },
    {
      name: '/ws/tree/packages/read/src/index.test.ts',
      status: 'failed',
      message: 'Failed to resolve import "../../errors/src/missing.ts" from "packages/read/src/index.test.ts". Does the file exist?',
      assertionResults: [],
    },
  ],
};

/** Surefire: an assertion, a domain exception from the code under test, a missing class, a missing method, an application context that does not start. */
export const SUREFIRE_VISITS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="org.example.visits.web.VisitResourceTest" time="2.7" tests="5" errors="3" skipped="0" failures="1">
  <testcase name="storesVetId" classname="org.example.visits.web.VisitResourceTest" time="0.1">
    <failure message="expected: &lt;3&gt; but was: &lt;null&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <3> but was: <null>
\tat org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)]]></failure>
  </testcase>
  <testcase name="rejectsUnknownVet" classname="org.example.visits.web.VisitResourceTest" time="0.1">
    <error message="Vet 42 not found" type="org.example.visits.web.ResourceNotFoundException"><![CDATA[org.example.visits.web.ResourceNotFoundException: Vet 42 not found
\tat org.example.visits.web.VisitResource.create(VisitResource.java:61)]]></error>
  </testcase>
  <testcase name="usesVetClient" classname="org.example.visits.web.VisitResourceTest" time="0.0">
    <error message="org/example/visits/client/VetClient" type="java.lang.NoClassDefFoundError">java.lang.NoClassDefFoundError: org/example/visits/client/VetClient</error>
  </testcase>
  <testcase name="readsVetId" classname="org.example.visits.web.VisitResourceTest" time="0.0">
    <error message="'java.lang.Integer org.example.visits.model.Visit.getVetId()'" type="java.lang.NoSuchMethodError">java.lang.NoSuchMethodError: 'java.lang.Integer org.example.visits.model.Visit.getVetId()'</error>
  </testcase>
  <testcase name="contextLoads" classname="org.example.visits.web.VisitResourceTest" time="0.0">
    <error message="Failed to load ApplicationContext for [WebMergedContextConfiguration@1a2b]" type="java.lang.IllegalStateException">java.lang.IllegalStateException: Failed to load ApplicationContext</error>
  </testcase>
</testsuite>`;

/** Node's JUnit reporter: an assertion, and a file whose static import of a missing export failed before any test ran. */
export const NODE_JUNIT_LINK = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="sorts the issues" classname="test" file="/ws/tree/packages/errors/test/errors.test.mjs" failure="Expected values to be strictly equal:&#10;&#10;1 !== 2&#10;">
\t\t<failure type="testCodeFailure" message="Expected values to be strictly equal:&#10;&#10;1 !== 2">
[Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

1 !== 2
] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
\t\t</failure>
\t</testcase>
\t<testcase name="packages/cli/test/report.test.mjs" time="0.041395" classname="test" file="/ws/tree/packages/cli/test/report.test.mjs" failure="test failed">
\t\t<failure type="testCodeFailure" message="test failed">
[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 1, signal: null }
\t\t</failure>
\t</testcase>
</testsuites>`;

/** What Vitest's default reporter printed for the r1 with-normal errors RED (text only, no report). */
export const VITEST_TEXT_NOT_A_CONSTRUCTOR = ` RUN  v5.0.0 /ws/tree

 ❯ packages/errors/src/index.test.ts (3 tests | 1 failed) 9ms
   ❯ Error classes (3)
     ❯ ChangesetValidationError (1)
       × sorts issues and formats the message 4ms

 Test Files  1 failed | 38 passed (39)
      Tests  1 failed | 816 passed | 2 todo (819)

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/errors/src/index.test.ts > Error classes > ChangesetValidationError > sorts issues and formats the message
TypeError: ChangesetValidationError is not a constructor
 ❯ packages/errors/src/index.test.ts:20:21
`;

/** ... and for the r1 with-faults rework RED: a suite that could not link the export the defect removed. */
export const VITEST_TEXT_LINK = ` FAIL  packages/cli/src/__tests__/validation-report.test.ts [ packages/cli/src/__tests__/validation-report.test.ts ]
SyntaxError: The requested module '@changesets/errors' does not provide an export named 'ChangesetValidationError'

 Test Files  1 failed | 38 passed (39)
`;

export const VITEST_TEXT_ASSERTION = ` FAIL  packages/errors/src/index.test.ts > ChangesetValidationError > is exported as a class
AssertionError: expected 'undefined' to be 'function' // Object.is equality

- Expected
+ Received

- function
+ undefined

 Test Files  1 failed | 0 passed (1)
`;

export const VITEST_TEXT_DOMAIN_EXCEPTION = ` FAIL  packages/assemble-release-plan/src/index.test.ts > assembleReleasePlan > reports every invalid changeset
Error: Found changeset strange-words-combine for package pkg-z which is not in the workspace
 ❯ mapGetOrThrow packages/assemble-release-plan/src/utils.ts:66:11

 Test Files  1 failed | 0 passed (1)
`;

export const VITEST_TEXT_NO_FILES = `No test files found, exiting with code 1

filter: packages/nope/
include: **/*.{test,spec}.?(c|m)[jt]s?(x)
`;

export const MAVEN_TEXT_COMPILE = `[INFO] --- compiler:3.13.0:testCompile (default-testCompile) @ spring-petclinic-visits-service ---
[ERROR] COMPILATION ERROR :
[ERROR] /ws/tree/spring-petclinic-visits-service/src/test/java/org/example/visits/web/VisitResourceTest.java:[41,9] cannot find symbol
  symbol:   method getVetId()
  location: class org.example.visits.model.Visit
[INFO] BUILD FAILURE
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:testCompile (default-testCompile) on project spring-petclinic-visits-service: Compilation failure
`;

export const MAVEN_TEXT_MISSING_CLASS = `[INFO] Running org.example.visits.web.VisitResourceTest
[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 0.2 s <<< FAILURE! -- in org.example.visits.web.VisitResourceTest
[ERROR] org.example.visits.web.VisitResourceTest.usesVetClient -- Time elapsed: 0.01 s <<< ERROR!
java.lang.NoClassDefFoundError: org/example/visits/client/VetClient
\tat org.example.visits.web.VisitResourceTest.usesVetClient(VisitResourceTest.java:52)
[INFO] BUILD FAILURE
`;

export const MAVEN_TEXT_ASSERTION = `[INFO] Running org.example.visits.web.VisitResourceTest
[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 2.1 s <<< FAILURE! -- in org.example.visits.web.VisitResourceTest
[ERROR] org.example.visits.web.VisitResourceTest.storesVetId -- Time elapsed: 0.1 s <<< FAILURE!
org.opentest4j.AssertionFailedError: expected: <3> but was: <null>
[INFO] BUILD FAILURE
`;

export const MAVEN_TEXT_DOMAIN_EXCEPTION = `[INFO] Running org.example.visits.web.VisitResourceTest
[ERROR] Tests run: 3, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 2.1 s <<< FAILURE! -- in org.example.visits.web.VisitResourceTest
[ERROR] org.example.visits.web.VisitResourceTest.rejectsUnknownVet -- Time elapsed: 0.1 s <<< ERROR!
org.example.visits.web.ResourceNotFoundException: Vet 42 not found
\tat org.example.visits.web.VisitResource.create(VisitResource.java:61)
[INFO] BUILD FAILURE
`;

/*
 * What `node --test` printed on Node 22.12.0 with stdout not a terminal (a gate's pipe): TAP, its default there, where
 * Node 24 prints spec everywhere. A failure's class and message are YAML fields of their own (`name:`, `error:`;
 * no `name:` for a plain Error), its place an absolute `location:`; a suite that failed through a subtest is a
 * `not ok` of `type: 'suite'`, which `# fail` does not count. Recorded at /ws/tree.
 */
const tap = (body: string, fail: number, tests = fail, suites = 0): string =>
  `TAP version 13\n${body}1..${tests}\n# tests ${tests}\n# suites ${suites}\n# pass ${tests - fail}\n# fail ${fail}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 41.98\n`;

/** The r1 errors RED, on Node 22: its declared test calls a constructor that does not exist yet. */
export const NODE22_TAP_NOT_A_CONSTRUCTOR = tap(
  `# Subtest: ChangesetValidationError sorts the issues and lists one per line
not ok 1 - ChangesetValidationError sorts the issues and lists one per line
  ---
  duration_ms: 0.507416
  location: '/ws/tree/packages/errors/test/errors.test.mjs:3:1'
  failureType: 'testCodeFailure'
  error: 'm.ChangesetValidationError is not a constructor'
  code: 'ERR_TEST_FAILURE'
  name: 'TypeError'
  stack: |-
    TestContext.<anonymous> (file:///ws/tree/packages/errors/test/errors.test.mjs:4:3)
    Test.runInAsyncScope (node:async_hooks:211:14)
    Test.run (node:internal/test_runner/test:934:25)
  ...
`,
  1,
);

/** An assertion failing inside a suite, on Node 22: the test, then its suite. */
export const NODE22_TAP_ASSERTION = tap(
  `# Subtest: git
    # Subtest: reads git
    not ok 1 - reads git
      ---
      duration_ms: 1.123184
      location: '/ws/tree/packages/read/test/git.test.mjs:5:3'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:
        
        1 !== 2
        
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 2
      actual: 1
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///ws/tree/packages/read/test/git.test.mjs:5:36)
        Test.runInAsyncScope (node:async_hooks:211:14)
      ...
    # Subtest: passes
    ok 2 - passes
      ---
      duration_ms: 0.102512
      ...
    1..2
not ok 1 - git
  ---
  duration_ms: 2.029674
  type: 'suite'
  location: '/ws/tree/packages/read/test/git.test.mjs:4:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
`,
  1,
  2,
  1,
);

/** The code under test throwing its own Error, on Node 22 (no `name:` field for a plain Error). */
export const NODE22_TAP_DOMAIN_EXCEPTION = tap(
  `# Subtest: reserves
not ok 1 - reserves
  ---
  duration_ms: 0.127839
  location: '/ws/tree/packages/read/test/git.test.mjs:8:1'
  failureType: 'testCodeFailure'
  error: 'stock is short'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    reserve (file:///ws/tree/packages/errors/src/index.mjs:2:47)
    TestContext.<anonymous> (file:///ws/tree/packages/read/test/git.test.mjs:8:26)
    Test.runInAsyncScope (node:async_hooks:211:14)
  ...
`,
  1,
);

/** A test file that exits 1 before any test runs, on Node 22: the file fails, with no error of a test. */
export const NODE22_TAP_FILE_EXIT = tap(
  `# Subtest: packages/cli/test/report.test.mjs
not ok 1 - packages/cli/test/report.test.mjs
  ---
  duration_ms: 38.088485
  location: '/ws/tree/packages/cli/test/report.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
`,
  1,
);
