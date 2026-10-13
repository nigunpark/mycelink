/**
 * The node's commit history, checked mechanically.
 *
 * In the second PCM-101 pilot the gateway worker committed its RED tests
 * alone and its production alone, as told, and then added one more commit:
 * `test: cover vetName enrichment ...`, new tests and a changed RED test
 * after the production code. Nothing in Mycelink looked at the history, so
 * the node was integrated and delivered, and the independent replay
 * rejected the whole delivery (tdd:test-after). The worker prompt was not
 * enough; the controller now reads the history from the repository itself:
 *
 *  - every production change starts with one or more test-only commits;
 *  - those test files are exactly the ones a valid red gate ran with
 *    (bound when the gate accepted the RED);
 *  - no declared test is added, changed or removed after production unless
 *    it starts a new complete RED -> production cycle;
 *  - a commit holding tests and production together, a merge, a cycle no
 *    red gate ran on, or a worker claim that does not match fails closed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import {
  DEFAULT_TDD_POLICY,
  isDeclarationPath,
  isTestPath,
  redBinding,
  tddPolicyFor,
  tddPolicySha256,
  verifyTddHistory,
  type RedBinding,
  type TddPolicy,
} from '../../src/engine/tdd-history.js';
import { declaredTests, testsInDelta } from '../../src/engine/test-declarations.js';

afterAll(() => cleanupTmpRoots());

const GW = 'spring-petclinic-api-gateway';
const GW_TEST = `${GW}/src/test/java/org/springframework/samples/petclinic/api/boundary/web/ApiGatewayControllerTest.java`;
const GW_PROD = `${GW}/src/main/java/org/springframework/samples/petclinic/api/boundary/web/ApiGatewayController.java`;
const GW_TEST_CONFIG = `${GW}/src/test/resources/config/application.yml`;

const javaTest = (methods: Record<string, string>): string =>
  [
    'package org.springframework.samples.petclinic.api.boundary.web;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class ApiGatewayControllerTest {',
    ...Object.entries(methods).flatMap(([name, body]) => ['', '    @Test', `    void ${name}() {`, `        ${body}`, '    }']),
    '}',
    '',
  ].join('\n');

const BASE_TEST = javaTest({ getOwnerDetails_withAvailableVisitsService: 'assertOk();' });

function petclinic(): string {
  return makeGitRepo(makeTmpDir('tdd-history-'), {
    files: {
      [GW_TEST]: BASE_TEST,
      [GW_PROD]: 'class ApiGatewayController { }\n',
      [`${GW}/pom.xml`]: '<project/>\n',
    },
  });
}

const head = (repo: string): string => git(repo, ['rev-parse', 'HEAD']);

/** Write `files`, take the red gate's binding the way `tdd red` does, and commit them alone. */
function redCycle(repo: string, files: Record<string, string>, policy: TddPolicy = DEFAULT_TDD_POLICY): { binding: RedBinding; commit: string } {
  writeFiles(repo, files);
  const { binding, production } = redBinding(repo, policy, 'e'.repeat(64));
  expect(production).toEqual([]);
  return { binding, commit: commitAll(repo, 'test: RED') };
}

function verify(repo: string, base: string, bindings: RedBinding[], extra: Partial<Parameters<typeof verifyTddHistory>[0]> = {}) {
  return verifyTddHistory({ repoPath: repo, base, head: head(repo), policy: DEFAULT_TDD_POLICY, bindings, requireRed: true, ...extra });
}

describe('test-path classification', () => {
  it('JVM: everything under src/test is a test path; src/main never is, even in a package named test', () => {
    const p = DEFAULT_TDD_POLICY;
    expect(isTestPath(p, GW_TEST)).toBe(true);
    expect(isTestPath(p, GW_TEST_CONFIG)).toBe(true);
    expect(isTestPath(p, `${GW}/src/test/jmeter/petclinic_test_plan.jmx`)).toBe(true);
    expect(isTestPath(p, GW_PROD)).toBe(false);
    expect(isTestPath(p, `${GW}/pom.xml`)).toBe(false);
    expect(isTestPath(p, 'spring-test/src/main/java/org/springframework/test/web/MockMvc.java')).toBe(false);
    expect(isTestPath(p, 'core/src/main/resources/tests/fixture.json')).toBe(false);
  });

  it('JS/TS: *.test.* and *.spec.* files, __tests__ and test/ or tests/ directories; support modules in src stay production', () => {
    const p = DEFAULT_TDD_POLICY;
    for (const path of ['packages/cli/src/run.test.ts', 'src/view.spec.tsx', 'packages/cli/src/__tests__/run.ts', 'test/run.mjs', 'tests/run.mjs', 'packages/core/test/fixtures/a.json', 'src/__snapshots__/run.test.ts.snap']) {
      expect(`${path}: ${isTestPath(p, path)}`).toBe(`${path}: true`);
    }
    for (const path of ['src/test-utils.ts', 'src/testing/index.ts', 'src/contest.js', 'packages/cli/src/run.ts', 'package.json', 'src/latest/index.ts']) {
      expect(`${path}: ${isTestPath(p, path)}`).toBe(`${path}: false`);
    }
  });

  it('Python, Go and .NET conventions', () => {
    const p = DEFAULT_TDD_POLICY;
    for (const path of ['pkg/test_orders.py', 'pkg/orders_test.py', 'conftest.py', 'svc/orders_test.go', 'svc/testdata/in.json', 'Shop.Tests/OrderTests.cs']) {
      expect(`${path}: ${isTestPath(p, path)}`).toBe(`${path}: true`);
    }
    for (const path of ['pkg/orders.py', 'svc/orders.go', 'Shop/Order.cs', 'pkg/attest.py']) {
      expect(`${path}: ${isTestPath(p, path)}`).toBe(`${path}: false`);
    }
  });

  it('a repository policy replaces the defaults, and its hash binds it', () => {
    const custom = tddPolicyFor({ tdd: { test_paths: ['**/test-utils/**', '**/*.test.ts'], declaration_paths: ['packages/types/**'] } });
    expect(custom.source).toBe('repository');
    expect(isTestPath(custom, 'scripts/test-utils/git.ts')).toBe(true);
    expect(isTestPath(custom, 'test/run.mjs')).toBe(false);
    expect(isDeclarationPath(custom, 'packages/types/src/index.ts')).toBe(true);
    expect(isDeclarationPath(DEFAULT_TDD_POLICY, 'packages/types/src/index.ts')).toBe(false);
    expect(tddPolicyFor(undefined)).toEqual(DEFAULT_TDD_POLICY);
    expect(tddPolicySha256(custom)).toMatch(/^[0-9a-f]{64}$/);
    expect(tddPolicySha256(custom)).not.toBe(tddPolicySha256(DEFAULT_TDD_POLICY));
    expect(tddPolicySha256(tddPolicyFor(undefined))).toBe(tddPolicySha256(DEFAULT_TDD_POLICY));
  });
});

describe('declared tests', () => {
  it('Java: @Test methods; a test counts as changed when its block changed', () => {
    const before = javaTest({ a: 'one();', b: 'two();' });
    const after = javaTest({ a: 'one();', b: 'TWO();', c: 'three();' });
    expect(declaredTests(GW_TEST, after).map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(testsInDelta([{ path: GW_TEST, before, after }]).declared).toEqual([
      { file: GW_TEST, name: 'b' },
      { file: GW_TEST, name: 'c' },
    ]);
    // A test inside a comment or a string is not a test.
    expect(declaredTests('A.java', 'class A {\n  // @Test void no() {}\n  String s = "@Test void no2() {}";\n}\n')).toEqual([]);
  });

  it('JS/TS: it/test calls with static names, ignoring strings and comments', () => {
    const src = "test('adds', () => {});\nit.skip(`skips`, () => {});\n// test('commented', () => {})\nconst s = \"test('in a string')\";\ndescribe('d', () => { it('nested', () => {}); });\n";
    expect(declaredTests('a.test.ts', src).map((t) => t.name)).toEqual(['adds', 'skips', 'nested']);
  });

  it('Python def test_*, Go func Test*, Rust #[test], C# [Fact]', () => {
    expect(declaredTests('t/test_a.py', 'def helper():\n    pass\n\ndef test_one():\n    assert 1\n\nclass T:\n    async def test_two(self):\n        pass\n').map((t) => t.name)).toEqual(['test_one', 'test_two']);
    expect(declaredTests('a_test.go', 'func helper() {}\nfunc TestOne(t *testing.T) {}\nfunc (s *S) TestTwo(t *testing.T) {}\n').map((t) => t.name)).toEqual(['TestOne', 'TestTwo']);
    expect(declaredTests('tests/a.rs', '#[test]\nfn one() {}\n#[tokio::test]\nasync fn two() {}\nfn helper() {}\n').map((t) => t.name)).toEqual(['one', 'two']);
    expect(declaredTests('T.Tests/A.cs', 'public class A {\n  [Fact]\n  public void One() {}\n  [Theory]\n  public async Task Two() {}\n}\n').map((t) => t.name)).toEqual(['One', 'Two']);
  });

  it('data files declare no tests; test code Mycelink cannot read is opaque, never silently empty', () => {
    expect(testsInDelta([{ path: GW_TEST_CONFIG, before: null, after: 'a: 1\n' }])).toEqual({ declared: [], opaque: [], removed: [] });
    expect(testsInDelta([{ path: 'spec/orders_spec.rb', before: null, after: "it 'works' do\nend\n" }])).toEqual({ declared: [], opaque: ['spec/orders_spec.rb'], removed: [] });
    // A removed test is reported, so a deletion after production is not maintenance.
    expect(testsInDelta([{ path: GW_TEST, before: javaTest({ a: 'x();', b: 'y();' }), after: javaTest({ a: 'x();' }) }]).removed).toEqual([{ file: GW_TEST, name: 'b' }]);
  });
});

describe('the red gate binding', () => {
  it('binds the test-side working-tree delta by blob and lists every production edit beside it', () => {
    const repo = petclinic();
    writeFiles(repo, { [GW_TEST]: javaTest({ getOwnerDetails_withAvailableVisitsService: 'assertOk();', exposesVetId: 'assertVetId();' }), [GW_TEST_CONFIG]: 'spring.cloud.config.enabled: false\n' });
    const clean = redBinding(repo, DEFAULT_TDD_POLICY, null);
    expect(clean.production).toEqual([]);
    expect(clean.binding.head_sha).toBe(head(repo));
    expect(clean.binding.tests.map((t) => t.path)).toEqual([GW_TEST_CONFIG, GW_TEST].sort());
    const blob = git(repo, ['hash-object', '--', GW_TEST]);
    expect(clean.binding.tests.find((t) => t.path === GW_TEST)?.blob).toBe(blob);
    expect(clean.binding.tests_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The with-faults gateway worker made production stubs before its RED: the gate lists them.
    writeFiles(repo, { [`${GW}/src/main/java/org/springframework/samples/petclinic/api/dto/VetDetails.java`]: 'record VetDetails() {}\n', [`${GW}/pom.xml`]: '<project><build/></project>\n' });
    expect(redBinding(repo, DEFAULT_TDD_POLICY, null).production).toEqual([`${GW}/pom.xml`, `${GW}/src/main/java/org/springframework/samples/petclinic/api/dto/VetDetails.java`]);
    // A deleted test file is bound as deleted.
    rmSync(join(repo, GW_TEST));
    expect(redBinding(repo, DEFAULT_TDD_POLICY, null).binding.tests.find((t) => t.path === GW_TEST)?.blob).toBeNull();
  });
});

describe('verifyTddHistory', () => {
  it('accepts one complete cycle: a RED-bound test-only commit, then production alone', () => {
    const repo = petclinic();
    const base = head(repo);
    const red = redCycle(repo, { [GW_TEST]: javaTest({ getOwnerDetails_withAvailableVisitsService: 'assertOk();', exposesVetId: 'assertVetId();' }) });
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int vetId; }\n' });
    const green = commitAll(repo, 'feat: vetId');
    const h = verify(repo, base, [red.binding]);
    expect(h.violation).toBeNull();
    expect(h.ok).toBe(true);
    // As in the independent replay, a block runs to the next declaration: appending a test
    // after the last one also changes that one's block.
    expect(h.cycles).toEqual([
      expect.objectContaining({
        red_commits: [red.commit],
        green_commits: [green],
        declared: [
          { file: GW_TEST, name: 'getOwnerDetails_withAvailableVisitsService' },
          { file: GW_TEST, name: 'exposesVetId' },
        ],
      }),
    ]);
    expect(h.cycles[0]?.red_tests).toEqual([{ path: GW_TEST, blob: git(repo, ['rev-parse', `${red.commit}:${GW_TEST}`]) }]);
    expect(h.cycles[0]?.production).toEqual([{ path: GW_PROD, blob: git(repo, ['rev-parse', `${green}:${GW_PROD}`]) }]);
    expect(h).toMatchObject({ base_sha: base, head_sha: green, policy_sha256: tddPolicySha256(DEFAULT_TDD_POLICY) });
  });

  it('refuses the PCM-101 gateway history: test-only, production, then tests added and changed after it (TEST_AFTER)', () => {
    const repo = petclinic();
    const base = head(repo);
    const red = redCycle(repo, {
      [GW_TEST]: javaTest({ getOwnerDetails_withAvailableVisitsService: 'assertOk();', getOwnerDetails_exposesVetIdAndNullVetName: 'assertVetId();' }),
      [GW_TEST_CONFIG]: 'spring.cloud.config.enabled: false\n',
    });
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { String vetName; }\n' });
    commitAll(repo, 'feat: gateway enriches visits with vetId and vetName');
    // 044f5f9: new tests, and the RED test itself changed (a stub added), after production.
    writeFiles(repo, {
      [GW_TEST]: javaTest({
        getOwnerDetails_withAvailableVisitsService: 'assertOk();',
        getOwnerDetails_exposesVetIdAndNullVetName: 'stubVets(); assertVetId();',
        getOwnerDetails_enrichesVetName: 'assertVetName();',
        getOwnerDetails_vetsServiceDown_vetNameNull: 'assertNullName();',
      }),
    });
    const after = commitAll(repo, 'test: cover vetName enrichment and vets-service failure');
    const h = verify(repo, base, [red.binding]);
    expect(h.ok).toBe(false);
    expect(h.violation).toMatchObject({ code: 'TEST_AFTER', commit: after });
    expect(h.violation?.detail).toMatch(/getOwnerDetails_enrichesVetName/);
    expect(h.violation?.detail).toMatch(/getOwnerDetails_exposesVetIdAndNullVetName/);
    expect(h.violation?.detail).toMatch(/new RED cycle/i);
  });

  it('refuses a commit holding tests and production together (MIXED_COMMIT)', () => {
    const repo = petclinic();
    const base = head(repo);
    writeFiles(repo, { [GW_TEST]: javaTest({ a: 'x();' }), [`${GW}/pom.xml`]: '<project><build/></project>\n' });
    const { binding } = redBinding(repo, DEFAULT_TDD_POLICY, null);
    const mixed = commitAll(repo, 'test: gateway (red); surefire disables config server');
    const h = verify(repo, base, [binding]);
    expect(h.violation).toMatchObject({ code: 'MIXED_COMMIT', commit: mixed });
    expect(h.violation?.paths).toEqual([`${GW}/pom.xml`, GW_TEST]);
  });

  it('refuses production before any test-only commit (NO_TEST_FIRST)', () => {
    const repo = petclinic();
    const base = head(repo);
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int vetId; }\n' });
    const first = commitAll(repo, 'feat first');
    redCycle(repo, { [GW_TEST]: javaTest({ a: 'x();' }) });
    expect(verify(repo, base, []).violation).toMatchObject({ code: 'NO_TEST_FIRST', commit: first });
  });

  it('refuses test-only commits no red gate ran on (RED_NOT_BOUND)', () => {
    const repo = petclinic();
    const base = head(repo);
    writeFiles(repo, { [GW_TEST]: javaTest({ a: 'x();' }) });
    const t = commitAll(repo, 'test without a gate');
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int a; }\n' });
    commitAll(repo, 'feat');
    expect(verify(repo, base, []).violation).toMatchObject({ code: 'RED_NOT_BOUND', commit: t });
  });

  it('refuses committed RED tests that differ from what the red gate ran (CHANGED_RED_BLOBS)', () => {
    const repo = petclinic();
    const base = head(repo);
    writeFiles(repo, { [GW_TEST]: javaTest({ a: 'strict();' }) });
    const { binding } = redBinding(repo, DEFAULT_TDD_POLICY, null);
    // The worker weakens the test after the gate accepted it, then commits.
    writeFiles(repo, { [GW_TEST]: javaTest({ a: 'lenient();' }) });
    const t = commitAll(repo, 'test');
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int a; }\n' });
    commitAll(repo, 'feat');
    const h = verify(repo, base, [binding]);
    expect(h.violation).toMatchObject({ code: 'CHANGED_RED_BLOBS', commit: t });
    expect(h.violation?.paths).toEqual([GW_TEST]);
  });

  it('accepts the tests of one RED committed in several test-only commits, and a RED re-run after a test changed', () => {
    const repo = petclinic();
    const base = head(repo);
    writeFiles(repo, { [GW_TEST]: javaTest({ a: 'x();' }), [GW_TEST_CONFIG]: 'k: v\n' });
    const { binding } = redBinding(repo, DEFAULT_TDD_POLICY, null);
    git(repo, ['add', '--', GW_TEST]);
    git(repo, ['commit', '-q', '-m', 'test part 1']);
    const t2 = commitAll(repo, 'test part 2');
    // Second RED after another test change, bound on top of the first test commit.
    const second = redCycle(repo, { [GW_TEST]: javaTest({ a: 'x();', b: 'y();' }) });
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int a; }\n' });
    commitAll(repo, 'feat');
    const h = verify(repo, base, [binding, second.binding]);
    expect(h.violation).toBeNull();
    expect(h.cycles).toHaveLength(1);
    expect(h.cycles[0]?.red_commits).toHaveLength(3);
    expect(h.cycles[0]?.red_commits[1]).toBe(t2);
  });

  it('accepts two complete cycles, each bound to its own RED (a rework adding a test the right way)', () => {
    const repo = petclinic();
    const base = head(repo);
    const r1 = redCycle(repo, { [GW_TEST]: javaTest({ a: 'x();' }) });
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int a; }\n' });
    const p1 = commitAll(repo, 'feat a');
    const r2 = redCycle(repo, { [GW_TEST]: javaTest({ a: 'x();', b: 'y();' }) });
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int a; int b; }\n' });
    const p2 = commitAll(repo, 'feat b');
    const h = verify(repo, base, [r1.binding, r2.binding]);
    expect(h.violation).toBeNull();
    expect(h.cycles.map((c) => [c.red_commits, c.green_commits])).toEqual([
      [[r1.commit], [p1]],
      [[r2.commit], [p2]],
    ]);
    // Without the second RED, the second cycle is not bound.
    expect(verify(repo, base, [r1.binding]).violation).toMatchObject({ code: 'RED_NOT_BOUND', commit: r2.commit });
  });

  it('accepts a declarations-only change without a RED cycle, and a declaration change before the cycle', () => {
    const policy = tddPolicyFor({ tdd: { declaration_paths: ['packages/types/**'] } });
    const repo = makeGitRepo(makeTmpDir('tdd-decl-'), { files: { 'packages/types/src/index.ts': 'export type A = 1;\n', 'packages/cli/src/run.ts': 'export {};\n', 'packages/cli/test/run.test.ts': "test('base', () => {});\n" } });
    const base = head(repo);
    writeFiles(repo, { 'packages/types/src/index.ts': 'export type A = 1;\nexport type B = 2;\n' });
    commitAll(repo, 'types only');
    const only = verifyTddHistory({ repoPath: repo, base, head: head(repo), policy, bindings: [], requireRed: true });
    expect(only).toMatchObject({ ok: true, declarations_only: true, cycles: [] });
    const red = redCycle(repo, { 'packages/cli/test/run.test.ts': "test('base', () => {});\ntest('uses B', () => {});\n" }, policy);
    writeFiles(repo, { 'packages/cli/src/run.ts': 'export const b = 2;\n' });
    commitAll(repo, 'feat');
    const both = verifyTddHistory({ repoPath: repo, base, head: head(repo), policy, bindings: [red.binding], requireRed: true });
    expect(both).toMatchObject({ ok: true, declarations_only: false });
    // The same declaration change is runtime production without the repository's declaration paths.
    expect(verifyTddHistory({ repoPath: repo, base, head: head(repo), policy: DEFAULT_TDD_POLICY, bindings: [red.binding], requireRed: true }).violation).toMatchObject({ code: 'NO_TEST_FIRST' });
  });

  it('allows test-data maintenance after production, but not a removed test', () => {
    const repo = petclinic();
    const base = head(repo);
    const red = redCycle(repo, { [GW_TEST]: javaTest({ getOwnerDetails_withAvailableVisitsService: 'assertOk();', b: 'y();' }) });
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int b; }\n' });
    commitAll(repo, 'feat');
    writeFiles(repo, { [GW_TEST_CONFIG]: 'logging.level.root: warn\n' });
    const maintenance = commitAll(repo, 'test config');
    const ok = verify(repo, base, [red.binding]);
    expect(ok).toMatchObject({ ok: true, maintenance: [{ commit: maintenance, paths: [GW_TEST_CONFIG] }] });
    writeFiles(repo, { [GW_TEST]: javaTest({ getOwnerDetails_withAvailableVisitsService: 'assertOk();' }) });
    const removal = commitAll(repo, 'drop a test');
    expect(verify(repo, base, [red.binding]).violation).toMatchObject({ code: 'TEST_AFTER', commit: removal });
  });

  it('refuses a RED delta that declares no test (NO_DECLARED_TESTS)', () => {
    const repo = petclinic();
    const base = head(repo);
    const red = redCycle(repo, { [GW_TEST_CONFIG]: 'k: v\n' });
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int a; }\n' });
    commitAll(repo, 'feat');
    expect(verify(repo, base, [red.binding]).violation).toMatchObject({ code: 'NO_DECLARED_TESTS', commit: red.commit });
  });

  it('refuses a merge inside the node history (MERGE_IN_HISTORY)', () => {
    const repo = petclinic();
    const base = head(repo);
    git(repo, ['checkout', '-q', '-b', 'side']);
    writeFiles(repo, { 'README.md': 'side\n' });
    commitAll(repo, 'side');
    git(repo, ['checkout', '-q', 'main']);
    redCycle(repo, { [GW_TEST]: javaTest({ a: 'x();' }) });
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
    expect(verify(repo, base, []).violation).toMatchObject({ code: 'MERGE_IN_HISTORY' });
  });

  it('binds the worker claim: a lied head, base or cycle fails closed (TDD_CLAIM_MISMATCH)', () => {
    const repo = petclinic();
    const base = head(repo);
    const red = redCycle(repo, { [GW_TEST]: javaTest({ a: 'x();' }) });
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int a; }\n' });
    const green = commitAll(repo, 'feat');
    const honest = { base_sha: base, head_sha: green, cycles: [{ red_commits: [red.commit], green_commits: [green] }] };
    expect(verify(repo, base, [red.binding], { claimed: honest }).violation).toBeNull();
    const withBlobs = { ...honest, cycles: [{ red_commits: [red.commit], green_commits: [green], red_tests: [{ path: GW_TEST, blob: git(repo, ['rev-parse', `${red.commit}:${GW_TEST}`]) }] }] };
    expect(verify(repo, base, [red.binding], { claimed: withBlobs }).violation).toBeNull();
    for (const lie of [
      { ...honest, head_sha: red.commit },
      { ...honest, base_sha: red.commit },
      { ...honest, cycles: [{ red_commits: [red.commit, green], green_commits: [] }] },
      { ...honest, cycles: [{ red_commits: [red.commit], green_commits: [green], red_tests: [{ path: GW_TEST, blob: 'f'.repeat(40) }] }] },
    ]) {
      expect(verify(repo, base, [red.binding], { claimed: lie }).violation).toMatchObject({ code: 'TDD_CLAIM_MISMATCH' });
    }
  });

  it('a refactor node, which requires no red evidence, is not held to cycles', () => {
    const repo = petclinic();
    const base = head(repo);
    writeFiles(repo, { [GW_PROD]: 'class ApiGatewayController { int a; }\n' });
    commitAll(repo, 'refactor');
    expect(verify(repo, base, [], { requireRed: false })).toMatchObject({ ok: true, violation: null });
  });

  describe('a declaration-only node (no red gate, not a refactor)', () => {
    // CSET-201's types node: packages/types/src/index.ts, declarations only, no runtime test.
    const policy = tddPolicyFor({ tdd: { declaration_paths: ['packages/types/**'] } });
    const changesets = (): string =>
      makeGitRepo(makeTmpDir('tdd-decl-node-'), {
        files: {
          'packages/types/src/index.ts': 'export type VersionType = "major" | "minor" | "patch" | "none";\n',
          'packages/assemble-release-plan/src/index.ts': 'export {};\n',
          'packages/assemble-release-plan/src/index.test.ts': "test('base', () => {});\n",
        },
      });
    const declarationOnly = (repo: string, base: string, p: TddPolicy = policy) =>
      verifyTddHistory({ repoPath: repo, base, head: head(repo), policy: p, bindings: [], requireRed: false, declarationsOnly: true });

    it('accepts production-only commits inside the claim-bound declaration paths, with no RED and no test commit', () => {
      const repo = changesets();
      const base = head(repo);
      writeFiles(repo, { 'packages/types/src/index.ts': 'export type VersionType = "major" | "minor" | "patch" | "none";\nexport type ReleaseReason = { type: "changeset"; changeset: string };\n' });
      const commit = commitAll(repo, 'feat(types): ReleaseReason');
      expect(declarationOnly(repo, base)).toMatchObject({ ok: true, violation: null, declarations_only: true, cycles: [], declarations: ['packages/types/src/index.ts'], commits: [{ sha: commit, kind: 'production' }] });
    });

    it('refuses it when the claim binds no declaration paths', () => {
      const repo = changesets();
      const base = head(repo);
      writeFiles(repo, { 'packages/types/src/index.ts': 'export type A = 1;\n' });
      commitAll(repo, 'feat(types)');
      expect(declarationOnly(repo, base, DEFAULT_TDD_POLICY).violation).toMatchObject({ code: 'DECLARATION_PATHS_UNBOUND' });
    });

    it('refuses runtime production code or tests: those need a RED', () => {
      const runtime = changesets();
      const base = head(runtime);
      writeFiles(runtime, { 'packages/types/src/index.ts': 'export type A = 1;\n' });
      commitAll(runtime, 'feat(types)');
      writeFiles(runtime, { 'packages/assemble-release-plan/src/index.ts': 'export const reasons = [];\n' });
      const sneaked = commitAll(runtime, 'feat(assemble)');
      expect(declarationOnly(runtime, base).violation).toMatchObject({ code: 'NOT_DECLARATION_ONLY', commit: sneaked, paths: ['packages/assemble-release-plan/src/index.ts'] });

      const tests = changesets();
      const base2 = head(tests);
      writeFiles(tests, { 'packages/types/src/index.ts': 'export type A = 1;\n', 'packages/assemble-release-plan/src/index.test.ts': "test('base', () => {});\ntest('more', () => {});\n" });
      const mixed = commitAll(tests, 'types and a test');
      expect(declarationOnly(tests, base2).violation).toMatchObject({ code: 'NOT_DECLARATION_ONLY', commit: mixed });
    });

    it('refuses a node that committed nothing', () => {
      const repo = changesets();
      expect(declarationOnly(repo, head(repo)).violation).toMatchObject({ code: 'NO_DECLARATION_COMMIT' });
    });

    it('binds the worker claim the same way', () => {
      const repo = changesets();
      const base = head(repo);
      writeFiles(repo, { 'packages/types/src/index.ts': 'export type A = 1;\n' });
      const commit = commitAll(repo, 'feat(types)');
      const honest = { base_sha: base, head_sha: commit, cycles: [] };
      expect(verifyTddHistory({ repoPath: repo, base, head: commit, policy, bindings: [], requireRed: false, declarationsOnly: true, claimed: honest }).violation).toBeNull();
      expect(verifyTddHistory({ repoPath: repo, base, head: commit, policy, bindings: [], requireRed: false, declarationsOnly: true, claimed: { ...honest, cycles: [{ red_commits: [commit], green_commits: [] }] } }).violation).toMatchObject({ code: 'TDD_CLAIM_MISMATCH' });
    });
  });

  it('refuses a base that is not in the history (BASE_NOT_ANCESTOR)', () => {
    const repo = petclinic();
    redCycle(repo, { [GW_TEST]: javaTest({ a: 'x();' }) });
    expect(verify(repo, '0123456789abcdef0123456789abcdef01234567', []).violation).toMatchObject({ code: 'BASE_NOT_ANCESTOR' });
  });
});
