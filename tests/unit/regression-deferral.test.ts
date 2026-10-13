/**
 * Which test files a full-suite run failed in, read from the runner's own
 * output (src/engine/regression-deferral.ts): Vitest's FAIL lines, Node's
 * "test at <file>" lines, Surefire's failing classes. An attribution is
 * complete only when the runner's own count agrees; a run that crashed,
 * did not compile or timed out is never attributed.
 */
import { describe, expect, it } from 'vitest';
import { failingTestFiles } from '../../src/engine/regression-deferral.js';
import { NODE22_TAP_ASSERTION, NODE22_TAP_FILE_EXIT, NODE22_TAP_NOT_A_CONSTRUCTOR } from '../helpers/red-corpus.js';

describe('failingTestFiles', () => {
  it("reads Vitest's failures, test and suite level, and checks them against its file count", () => {
    const out = ` ❯ packages/cli/src/commands/status/__tests__/status.test.ts (3 tests | 1 failed) 9ms
 FAIL  packages/cli/src/commands/status/__tests__/status.test.ts > status > prints once
AssertionError: expected 'x' to be 'y'
 FAIL  packages/cli/src/__tests__/validation-report.test.ts [ packages/cli/src/__tests__/validation-report.test.ts ]
SyntaxError: The requested module '@changesets/errors' does not provide an export named 'ChangesetValidationError'

 Test Files  2 failed | 37 passed (39)
      Tests  1 failed | 816 passed (817)
`;
    expect(failingTestFiles(out, 1)).toEqual({ complete: true, files: ['packages/cli/src/__tests__/validation-report.test.ts', 'packages/cli/src/commands/status/__tests__/status.test.ts'], classes: [] });
    // A count that does not match what the FAIL lines name is not an attribution.
    expect(failingTestFiles(out.replace('2 failed | 37', '3 failed | 36'), 1).complete).toBe(false);
  });

  it("reads Node's runner: every failing test names its file", () => {
    const out = `✖ describes a git failure (0.9ms)
ℹ tests 4
ℹ pass 3
ℹ fail 1

✖ failing tests:

test at packages\\cli\\test\\git.test.mjs:5:1
✖ describes a git failure (0.9ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
`;
    expect(failingTestFiles(out, 1)).toEqual({ complete: true, files: ['packages/cli/test/git.test.mjs'], classes: [] });
    expect(failingTestFiles(out.replace('ℹ fail 1', 'ℹ fail 2'), 1).complete).toBe(false);
  });

  it("reads Node 22's TAP (its default into a pipe): every failing test's location, relative to the checkout; a suite failing through it is not counted", () => {
    expect(failingTestFiles(NODE22_TAP_ASSERTION, 1, '/ws/tree')).toEqual({ complete: true, files: ['packages/read/test/git.test.mjs'], classes: [] });
    expect(failingTestFiles(NODE22_TAP_NOT_A_CONSTRUCTOR, 1, '/ws/tree')).toEqual({ complete: true, files: ['packages/errors/test/errors.test.mjs'], classes: [] });
    expect(failingTestFiles(NODE22_TAP_FILE_EXIT, 1, '/ws/tree')).toEqual({ complete: true, files: ['packages/cli/test/report.test.mjs'], classes: [] });
    // Counts that do not agree, a location outside the checkout, or no checkout to read it from: nothing is attributed.
    expect(failingTestFiles(NODE22_TAP_ASSERTION.replace('# fail 1', '# fail 2'), 1, '/ws/tree').complete).toBe(false);
    expect(failingTestFiles(NODE22_TAP_ASSERTION, 1, '/ws/other').complete).toBe(false);
    expect(failingTestFiles(NODE22_TAP_ASSERTION, 1).complete).toBe(false);
  });

  it('reads Surefire classes, and refuses a compile failure', () => {
    const out = `[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 2.1 s <<< FAILURE! -- in org.example.visits.web.VisitResourceTest
[ERROR] Tests run: 5, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 1.1 s <<< FAILURE! -- in org.example.gateway.ApiGatewayTest
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.2:test (default-test) on project x: There are test failures.
`;
    expect(failingTestFiles(out, 1)).toEqual({ complete: true, files: [], classes: ['org.example.gateway.ApiGatewayTest', 'org.example.visits.web.VisitResourceTest'] });
    expect(failingTestFiles('[ERROR] COMPILATION ERROR :\n[ERROR] x.java:[1,1] cannot find symbol\n', 1).complete).toBe(false);
  });

  it('never attributes a pass, a timeout or output it cannot read', () => {
    expect(failingTestFiles('all good', 0).complete).toBe(false);
    expect(failingTestFiles(' FAIL  a.test.ts > x\n Test Files  1 failed (1)\n\n[mycelink] command timed out after 1000 ms\n', 124).complete).toBe(false);
    expect(failingTestFiles('Segmentation fault', 139).complete).toBe(false);
  });
});
