/**
 * A module gate's JUnit report, read as the run wrote it (evidence/runner.ts).
 *
 * CI 38347201692: on Node 22.12.0 Node's JUnit reporter names no test file,
 * and on macOS the runner names files by the real path of the worktree
 * (`/private/var/...` for `/var/...`); either way every declared RED test read
 * "not run" and the shop fixtures' REDs were refused on four of six legs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupTmpRoots, linkedAlias, makeTmpDir } from '../helpers/tmp.js';
import { makeGitRepo } from '../helpers/git-fixture.js';
import { runVerification } from '../../src/evidence/runner.js';

afterAll(() => cleanupTmpRoots());

const ERRORS_TEST = 'packages/errors/test/errors.test.mjs';
const DECLARED = 'sorts the issues and lists one per line';
const MODULE = { id: 'errors', sha256: 'a'.repeat(64), path: 'packages/errors', plan_sha256: 'b'.repeat(64) };

function shop(): { repo: string; evidence: string } {
  const dir = makeTmpDir('junit-gate-');
  const repo = join(dir, 'shop');
  makeGitRepo(repo, {
    files: {
      [ERRORS_TEST]: `import { test, describe } from 'node:test';
import assert from 'node:assert';
test('a git error carries its exit code', () => {});
describe('ChangesetValidationError', () => {
  test('${DECLARED}', () => { assert.strictEqual(1, 2); });
});
`,
      'packages/errors/src/index.mjs': 'export {};\n',
      'packages/cli/test/cli.test.mjs': "import { test } from 'node:test';\ntest('a git error carries its exit code', () => {});\n",
    },
  });
  const evidence = join(dir, 'evidence');
  mkdirSync(evidence, { recursive: true });
  return { repo, evidence };
}

/** The errors module's RED report as Node 22.12.0 writes it: no file attribute. */
function node22Report(repo: string): string {
  const url = pathToFileURL(join(repo, ERRORS_TEST)).href;
  return `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="a git error carries its exit code" time="0.000410" classname="test"/>
\t<testsuite name="ChangesetValidationError" time="0.001" disabled="0" errors="0" tests="1" failures="1" skipped="0" hostname="h">
\t\t<testcase name="${DECLARED}" time="0.0002" classname="test" failure="Expected values to be strictly equal:1 !== 2">
\t\t\t<failure type="testCodeFailure" message="Expected values to be strictly equal:1 !== 2">
Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

1 !== 2

  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
      at TestContext.&lt;anonymous&gt; (${url}:5:65)
\t\t\t</failure>
\t\t</testcase>
\t</testsuite>
</testsuites>`;
}

describe('a module gate reads its JUnit report as the run wrote it', () => {
  it("judges a RED on Node 22's report, which names no file: the declared test is the one its module's test file declares", () => {
    const { repo, evidence } = shop();
    const write = `require('node:fs').writeFileSync(process.argv[1], ${JSON.stringify(node22Report(repo))}); process.exit(1);`;
    const record = runVerification({
      kind: 'red',
      nodeId: 'SHOP-1.errors.impl',
      repository: 'shop',
      command: ['node', '-e', write, '${REPORT}'],
      cwd: repo,
      evidenceDir: evidence,
      report: { format: 'junit-xml' },
      module: MODULE,
      redDeclared: [{ file: ERRORS_TEST, name: DECLARED }],
    });
    expect(record).toMatchObject({ red_reason: 'behaviour-missing', red_category: 'assertion' });
    expect(record.red_tests).toEqual([expect.objectContaining({ file: ERRORS_TEST, name: DECLARED, status: 'failed', category: 'assertion' })]);
    const results = JSON.parse(readFileSync(record.results!.path, 'utf8')).results;
    // The other module's same-named test is outside the errors module: this one is the errors module's.
    expect(results.map((r: any) => [r.file, r.full_name])).toEqual([
      [ERRORS_TEST, 'a git error carries its exit code'],
      [ERRORS_TEST, `ChangesetValidationError > ${DECLARED}`],
    ]);
  });

  it("judges a RED run in a worktree reached through a link: Node's runner names the real path, the test is the declared one", () => {
    const { repo, evidence } = shop();
    const worktree = linkedAlias(repo, 'worktree');
    const record = runVerification({
      kind: 'red',
      nodeId: 'SHOP-1.errors.impl',
      repository: 'shop',
      command: ['node', '--test', '--test-reporter=junit', '--test-reporter-destination=${REPORT}', 'packages/errors/test/**/*.test.mjs'],
      cwd: worktree,
      evidenceDir: evidence,
      report: { format: 'junit-xml' },
      module: MODULE,
      redDeclared: [{ file: ERRORS_TEST, name: DECLARED }],
    });
    expect(record.red_detail).not.toMatch(/not-run/);
    expect(record).toMatchObject({ red_reason: 'behaviour-missing', red_category: 'assertion' });
    expect(record.red_tests).toEqual([expect.objectContaining({ file: ERRORS_TEST, name: DECLARED, status: 'failed' })]);
  });
});
