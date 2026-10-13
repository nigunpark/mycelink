/**
 * Java criterion evidence judged by its canonical identity (PCM-101 final).
 *
 * The real normal arm (WSL ~/mycelink-pilot-results/PCM-101-final/with-normal,
 * trusted): both Java producers ran a valid RED (visits: six behaviour
 * failures; gateway: two), GREEN and the full regression, and committed
 * product work. The stale-RED guard (CSET-201 final) then compared each bound
 * JUnit result's class-qualified name
 * (`org.springframework....VisitVetTest#createWithVet...`) with the bare
 * methods the Java reader declares, and refused every criterion with
 * CRITERION_TEST_UNKNOWN — the visits worker found it in `tdd check` and
 * answered BLOCKED; the gateway's submission was held for an evidence
 * correction no worker could make.
 *
 * Here the run's own evidence — its gates' results files byte for byte, their
 * outputs with the evaluation host's paths neutralised and sealed again (each
 * output keeps the content-addressed name and hash its records give), its
 * workers' criterion evidence, its RED bindings, the Java test files at its
 * submitted heads — is judged again and accepted, each test named by
 * its source path and method, the class-qualified name kept as raw evidence
 * with an alias. And every way a wrong or ambiguous Java reference could slip
 * through stays CRITERION_TEST_UNKNOWN: the same method in two files or
 * nested classes, an overload, a fake class, a wrong path, a renamed or
 * deleted test, another module's file, a malformed `#`, a JS title ending in
 * a method's name, a stale head.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import { declaredAt, judgeCriteria, type JudgeCriteriaArgs } from '../../src/engine/criteria.js';
import { completionStanding } from '../../src/engine/criterion-coverage.js';
import { revalidateCompletion, sealCompletion, COMPLETION_SCHEMA } from '../../src/engine/criterion-ledger.js';
import { runVerification } from '../../src/evidence/runner.js';
import { TEST_IDENTITY_VERSION } from '../../src/evidence/test-identity.js';
import type { EvidenceRecord, GraphNode, NodeRuntime, PortfolioGraph } from '../../src/model/types.js';
import type { TddPolicy } from '../../src/engine/tdd-history.js';

afterAll(() => cleanupTmpRoots());

const FIXTURE = join(__dirname, '..', 'benchmark', 'fixtures', 'pcm101-final');
const FEATURE = 'PCM-101';
const VISITS = 'PCM-101.visits.vet.impl';
const GATEWAY = 'PCM-101.gateway.vetname.impl';
const VISIT_VET = 'spring-petclinic-visits-service/src/test/java/org/springframework/samples/petclinic/visits/web/VisitVetTest.java';
const VISIT_RESOURCE = 'spring-petclinic-visits-service/src/test/java/org/springframework/samples/petclinic/visits/web/VisitResourceTest.java';
const OWNER_DETAILS = 'spring-petclinic-api-gateway/src/test/java/org/springframework/samples/petclinic/api/boundary/web/OwnerDetailsVetNameTest.java';
const GATEWAY_CONTROLLER = 'spring-petclinic-api-gateway/src/test/java/org/springframework/samples/petclinic/api/boundary/web/ApiGatewayControllerTest.java';

const fixtureText = (...parts: string[]): string => readFileSync(join(FIXTURE, ...parts), 'utf8');
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** The repository's TDD policy the claims bound (STATE.json: claim.tdd_policy). */
const POLICY: TddPolicy = { test_paths: ['*/src/test/**'], production_roots: ['**/src/main/**'], declaration_paths: [], source: 'repository', sha256: 'dded94ab34a3198aa536db3eb9e4abf349eb92e019c6c807650cf0d0f838268d' } as TddPolicy;

interface Replay {
  control: string;
  repo: string;
  graph: PortfolioGraph;
  state: { nodes: Record<string, NodeRuntime> };
  heads: { visits: string; gateway: string; base: string };
}

/**
 * The run's control root (features/PCM-101 as the run left it: STATE.json, the gates' outputs and results, the
 * captured results) and a repository holding the Java test files exactly as the submitted heads held them: the base
 * with the module's existing tests, the visits branch's RED commit, the gateway's.
 */
function replay(): Replay {
  const root = makeTmpDir('pcm101-identity-');
  const control = join(root, 'control');
  mkdirSync(control, { recursive: true });
  cpSync(join(FIXTURE, 'features'), join(control, 'features'), { recursive: true });
  const repo = makeGitRepo(join(root, 'petclinic'), {
    files: {
      'README.md': '# petclinic (the test files of the submitted heads)\n',
      [VISIT_RESOURCE]: fixtureText('repo', 'visits', VISIT_RESOURCE),
      [GATEWAY_CONTROLLER]: fixtureText('repo', 'gateway', GATEWAY_CONTROLLER),
    },
  });
  const base = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'visits']);
  writeFiles(repo, { [VISIT_VET]: fixtureText('repo', 'visits', VISIT_VET) });
  const visits = commitAll(repo, 'Test vet on visits');
  git(repo, ['checkout', '-q', base]);
  git(repo, ['checkout', '-q', '-b', 'gateway']);
  writeFiles(repo, { [OWNER_DETAILS]: fixtureText('repo', 'gateway', OWNER_DETAILS) });
  const gateway = commitAll(repo, 'Add failing tests for vet name in owner details');
  const graph = YAML.parse(fixtureText('features', FEATURE, 'PORTFOLIO-GRAPH.yaml')) as PortfolioGraph;
  const state = JSON.parse(fixtureText('features', FEATURE, 'STATE.json')).data as { nodes: Record<string, NodeRuntime> };
  return { control, repo, graph, state, heads: { visits, gateway, base } };
}

const nodeOf = (r: Replay, id: string): GraphNode => r.graph.nodes.find((n) => n.id === id) as GraphNode;

/** A worker's captured result, as the run kept it. */
function capturedResult(nodeId: string): { outcome: string; criterion_evidence: JudgeCriteriaArgs['evidence']; failure_fingerprint: string | null } {
  const dir = join(FIXTURE, 'features', FEATURE, 'sessions', nodeId);
  const file = nodeId === VISITS ? 'result.46b82f93-0b80-4604-ac8b-cc6746291835.44aab2cb3d10075f0730c6706abefa68.json' : 'result.4d95ebee-0bf5-408f-8ec1-1001ca50844d.2409f4318b73129888cc7c758ec3c7b6.json';
  return JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

/** The visits node as settle judged it: its gates, its RED binding. */
function visitsArgs(r: Replay): JudgeCriteriaArgs {
  const rt = r.state.nodes[VISITS] as NodeRuntime;
  return { controlRoot: r.control, featureId: FEATURE, graph: r.graph, node: nodeOf(r, VISITS), runtime: rt, evidence: capturedResult(VISITS).criterion_evidence, repoPath: r.repo, head: r.heads.visits, policy: POLICY, modulePath: 'spring-petclinic-visits-service' };
}

/** The gateway node exactly as it was held: the evidence the hold kept, its bindings. */
function gatewayArgs(r: Replay): JudgeCriteriaArgs {
  const rt = r.state.nodes[GATEWAY] as NodeRuntime;
  const held = (rt.claim as NonNullable<NodeRuntime['claim']>).evidence_correction?.held;
  return { controlRoot: r.control, featureId: FEATURE, graph: r.graph, node: nodeOf(r, GATEWAY), runtime: { ...rt, evidence: held?.evidence ?? rt.evidence }, evidence: capturedResult(GATEWAY).criterion_evidence, repoPath: r.repo, head: r.heads.gateway, policy: POLICY, modulePath: 'spring-petclinic-api-gateway' };
}

describe('PCM-101 final, replayed from its own evidence', () => {
  it("the fixture is the run's evidence, sealed: every results file and output its gates recorded hashes as recorded", () => {
    const r = replay();
    for (const id of [VISITS, GATEWAY]) {
      const rt = r.state.nodes[id] as NodeRuntime;
      const evidence = id === GATEWAY ? (rt.claim?.evidence_correction?.held?.evidence ?? rt.evidence) : rt.evidence;
      for (const kind of ['red', 'green'] as const) {
        const rec = evidence[kind] as EvidenceRecord;
        expect(sha256(readFileSync(join(r.control, rec.output_path))), `${id} ${kind} output`).toBe(rec.output_sha256);
        expect(sha256(readFileSync(join(r.control, rec.results!.path))), `${id} ${kind} results`).toBe(rec.results!.sha256);
      }
    }
    // The class-qualified names its reports published, and the bare methods its RED declared.
    expect((r.state.nodes[VISITS]!.tdd_red_bindings ?? [])[0]!.red_tests!.map((t) => t.full_name)).toContain('org.springframework.samples.petclinic.visits.web.VisitVetTest#createWithVetStoresAndReturnsIt');
    expect(r.state.nodes[VISITS]!.evidence.red!.red_declared!.map((d) => d.name)).toContain('createWithVetStoresAndReturnsIt');
    expect(capturedResult(VISITS)).toMatchObject({ outcome: 'BLOCKED', failure_fingerprint: 'CRITERION_TEST_UNKNOWN:java-full_name-class-prefix-never-matches-declaredAt' });
  });

  it("visits: every criterion its worker named is accepted — AC-1..AC-4 by the RED's failing tests, AC-7 by an existing test green passed — each by path and method, the class kept as raw evidence", () => {
    const r = replay();
    const judged = judgeCriteria(visitsArgs(r));
    expect(judged, JSON.stringify(judged).slice(0, 1500)).toMatchObject({ ok: true });
    if (!judged.ok) return;
    expect(judged.accepted.map((a) => [a.criterion, a.gate, a.test_id, a.identity?.key])).toEqual([
      ['AC-1', 'red', '53ad4ca8e8338410', 'visitsTableHasNullableVetIdAndSeedVisitsHaveNoVet'],
      ['AC-2', 'red', 'fb06cc2d15596817', 'createWithNonPositiveVetIsRejectedAndNotStored'],
      ['AC-3', 'red', '6ab37a4687726b87', 'createWithVetStoresAndReturnsIt'],
      ['AC-4', 'red', '6973d51231220890', 'vetVisitsOrderedByDateThenId'],
      ['AC-7', 'green', '574528af1b3fa73b', 'shouldFetchVisits'],
    ]);
    for (const a of judged.accepted) {
      expect(a.identity).toMatchObject({ version: TEST_IDENTITY_VERSION, runner: 'junit', path: a.test?.path });
      // The raw identity, as the report named it, is kept: the test's class-qualified full name.
      expect(a.test?.name).toMatch(/^org\.springframework\.samples\.petclinic\.visits\.web\.Visit(?:Vet|Resource)Test#/);
      // Published before identities were: an alias says how the old name maps to the canonical one, at this head.
      expect(a.identity_alias).toMatchObject({ raw: { test_id: a.test_id, full_name: a.test?.name }, head_sha: r.heads.visits, declaration: { path: a.test?.path, method: a.identity?.key } });
    }
  });

  it('gateway: the held submission is accepted as it was held — AC-5, AC-6 by the RED, AC-7 by green', () => {
    const r = replay();
    const judged = judgeCriteria(gatewayArgs(r));
    expect(judged, JSON.stringify(judged).slice(0, 1500)).toMatchObject({ ok: true });
    if (!judged.ok) return;
    expect(judged.accepted.map((a) => [a.criterion, a.gate, a.identity?.key])).toEqual([
      ['AC-5', 'red', 'visitsCarryVetIdAndVetName'],
      ['AC-6', 'red', 'vetNameIsNullWhenVetsServiceErrors'],
      ['AC-7', 'green', 'getOwnerDetails_withAvailableVisitsService'],
    ]);
  });

  it("a completion settled on them stands at the head, and stands again at a later head; an edit of its Java test is a changed proof", () => {
    const r = replay();
    const judged = judgeCriteria(visitsArgs(r));
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;
    const ac3 = judged.accepted.find((a) => a.criterion === 'AC-3')!;
    expect(declaredAt(r.repo, r.heads.visits, VISIT_VET, ac3.test!.name)).toBe(true);
    const record = sealCompletion({
      schema: COMPLETION_SCHEMA,
      node_id: VISITS,
      criterion: 'AC-3',
      kind: 'new-behavior',
      generation: 0,
      basis: 'red',
      source: null,
      parent: null,
      claim_id: '6c039c8f-7ce5-49d6-8e78-51cdd165f634',
      dispatch_id: '46b82f93-0b80-4604-ac8b-cc6746291835',
      settled_at: '2026-10-12T03:35:03.761Z',
      order: null,
      repo: { repository: 'spring-petclinic-microservices', base_sha: r.heads.base, head_sha: r.heads.visits, integrated_sha: r.heads.visits },
      production: { paths: [], sha256: sha256('[]') },
      proof: { test_id: ac3.test_id, test: ac3.test, test_blob: null, gate: 'red', output_sha256: ac3.output_sha256 },
      red: null,
      history: null,
      reproof: null,
      archive: null,
      migrated: true,
    });
    const standing = completionStanding({ controlRoot: r.control, featureId: FEATURE, record, ledger: [record], repoPath: r.repo, head: r.heads.visits, policy: POLICY });
    expect(standing, JSON.stringify(standing)).toMatchObject({ holds: true, tests: [{ path: VISIT_VET, declared: true }] });
    // A later head where a sibling weakened the test: what proved AC-3 is not there now.
    git(r.repo, ['checkout', '-q', 'visits']);
    writeFiles(r.repo, { [VISIT_VET]: fixtureText('repo', 'visits', VISIT_VET).replace('.andExpect(jsonPath("$[0].vetId").value(3));', '.andExpect(status().isOk());') });
    const weakened = commitAll(r.repo, 'a sibling weakens the vet assertion');
    expect(revalidateCompletion({ controlRoot: r.control, featureId: FEATURE, record, ledger: [record], repoPath: r.repo, head: weakened, policy: POLICY })).toMatchObject({ ok: false, code: 'COMPLETION_TEST_CHANGED' });
    // A later head that renamed it away: the completion is lost there (its proved test removed), never silently held.
    writeFiles(r.repo, { [VISIT_VET]: fixtureText('repo', 'visits', VISIT_VET).replace('void createWithVetStoresAndReturnsIt()', 'void createsWithVet()') });
    const renamed = commitAll(r.repo, 'a sibling renames the test');
    expect(completionStanding({ controlRoot: r.control, featureId: FEATURE, record, ledger: [record], repoPath: r.repo, head: renamed, policy: POLICY })).toMatchObject({ holds: false, code: 'COMPLETION_TEST_CHANGED', tests: [{ path: VISIT_VET, declared: false }] });
    expect(declaredAt(r.repo, renamed, VISIT_VET, ac3.test!.name)).toBe(false);
  });
});

// ---- the security cases, on a small Maven-shaped module with real gate runs ---------------------------------------------

const MOD = 'clinic-visits';
const PKG = 'org/example/clinic';
const VISIT_TEST = `${MOD}/src/test/java/${PKG}/VisitTest.java`;
const VET_TEST = `${MOD}/src/test/java/${PKG}/VetTest.java`;
const ORDER_TEST = `${MOD}/src/test/java/${PKG}/OrderTest.java`;
const OTHER_MODULE_TEST = `clinic-gateway/src/test/java/${PKG}/VisitTest.java`;

const VISIT_SRC = `package org.example.clinic;

class VisitTest {
    @Test
    void stores() { }

    @Test
    void lists() { }
}
`;
const VET_SRC = `package org.example.clinic;

class VetTest {
    @Test
    void stores() { }
}
`;
const ORDER_SRC = `package org.example.clinic;

class OrderTest {
    @Nested
    class WhenEmpty {
        @Test
        void rejects() { }
    }

    @Nested
    class WhenFull {
        @Test
        void rejects() { }
    }

    @Test
    void prices() { }

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void prices(int quantity) { }

    @ParameterizedTest
    @CsvSource({"a", "b"})
    void discounts(String code) { }

    @DisplayName("ships the order once")
    @Test
    void shipsOnce() { }
}
`;

type Case = { classname: string; name: string; failed: boolean };

/** A Surefire report directory as the module's command writes it: one TEST-<class>.xml per top-level class. */
function surefireScript(cases: Case[]): string {
  const byFile = new Map<string, Case[]>();
  for (const c of cases) {
    const top = c.classname.split('$')[0] as string;
    byFile.set(top, [...(byFile.get(top) ?? []), c]);
  }
  const files = [...byFile].map(([top, cs]) => ({
    name: `TEST-${top}.xml`,
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${top}" tests="${cs.length}">\n${cs.map((c) => `  <testcase name="${c.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" classname="${c.classname}" time="0.01">${c.failed ? `<failure message="expected: &lt;true&gt; but was: &lt;false&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;true&gt; but was: &lt;false&gt;</failure>` : ''}</testcase>`).join('\n')}\n</testsuite>\n`,
  }));
  return `const fs=require('fs');const d=${JSON.stringify(`${MOD}/target/surefire-reports`)};fs.mkdirSync(d,{recursive:true});for(const f of ${JSON.stringify(files)})fs.writeFileSync(d+'/'+f.name,f.body);process.exit(${cases.some((c) => c.failed) ? 1 : 0});`;
}

interface Module {
  control: string;
  repo: string;
  base: string;
  graph: PortfolioGraph;
  node: GraphNode;
}

function clinic(): Module {
  const root = makeTmpDir('clinic-identity-');
  const control = join(root, 'control');
  mkdirSync(join(control, 'features', 'CLN-1'), { recursive: true });
  const repo = makeGitRepo(join(root, 'clinic'), { files: { 'README.md': '# clinic\n', [`${MOD}/src/main/java/${PKG}/Visit.java`]: 'package org.example.clinic;\nclass Visit { }\n' } });
  const base = git(repo, ['rev-parse', 'HEAD']);
  const node = {
    id: 'CLN-1.visits.impl',
    level: 'executable-node',
    repository: 'clinic',
    capability: 'CAP-VISITS',
    node_type: 'implementation',
    depends_on: [],
    allowed_paths: [`${MOD}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [{ id: 'module-visits', command: ['node', '-e', '0'] }],
    worker: { model: 'sonnet', effort: 'high', max_turns: 10, max_wall_clock_minutes: 5, max_attempts: 2, nested_delegation: false },
    invalidation_rules: [],
    acceptance_criteria: ['AC-1'],
  } as unknown as GraphNode;
  const graph = { schema_version: 1, feature_id: 'CLN-1', title: 'clinic', acceptance_criteria: [{ id: 'AC-1', text: 'a visit stores its vet' }], nodes: [node] } as unknown as PortfolioGraph;
  return { control, repo, base, graph, node };
}

/** A gate run in `cwd` that writes `cases` as Surefire would, recorded exactly as a gate records it (results with ids). */
function gate(m: Module, kind: 'red' | 'green', cases: Case[], declared: { file: string; name: string }[] | null = null): EvidenceRecord {
  return runVerification({
    kind,
    nodeId: m.node.id,
    repository: 'clinic',
    command: ['node', '-e', surefireScript(cases)],
    cwd: m.repo,
    evidenceDir: join(m.control, 'features', 'CLN-1', 'evidence', m.node.id),
    pathBase: m.control,
    report: { format: 'junit-xml', dir: `${MOD}/target/surefire-reports` },
    module: { id: 'visits', sha256: 'a'.repeat(64), path: MOD, plan_sha256: 'b'.repeat(64) },
    ...(kind === 'red' ? { redDeclared: declared } : {}),
  });
}

function args(m: Module, red: EvidenceRecord, item: Record<string, unknown>, head: string, extra: Partial<NodeRuntime> = {}): JudgeCriteriaArgs {
  const runtime = { state: 'REGRESSION_VERIFIED', attempts: 1, claim: null, evidence: { red }, failure_counts: {}, last_failure_fingerprint: null, integrated_sha: null, blocked_reason: null, ...extra } as unknown as NodeRuntime;
  return { controlRoot: m.control, featureId: 'CLN-1', graph: m.graph, node: m.node, runtime, evidence: [{ criterion: 'AC-1', gate: 'red', output_sha256: red.output_sha256, ...item }] as JudgeCriteriaArgs['evidence'], repoPath: m.repo, head, policy: POLICY, modulePath: MOD };
}

const idOf = (m: Module, red: EvidenceRecord, full: string): string => {
  const results = JSON.parse(readFileSync(join(m.control, red.results!.path), 'utf8')).results as { test_id: string; full_name: string; identity?: unknown }[];
  const hit = results.find((r) => r.full_name === full);
  if (hit === undefined) throw new Error(`no ${full} in ${results.map((r) => r.full_name).join(', ')}`);
  return hit.test_id;
};

describe('a wrong or ambiguous Java reference stays unknown', () => {
  it('a new gate publishes each JUnit result with its versioned identity and raw class', () => {
    const m = clinic();
    writeFiles(m.repo, { [VISIT_TEST]: VISIT_SRC });
    const red = gate(m, 'red', [{ classname: 'org.example.clinic.VisitTest', name: 'stores', failed: true }], [{ file: VISIT_TEST, name: 'stores' }]);
    const results = JSON.parse(readFileSync(join(m.control, red.results!.path), 'utf8')).results;
    expect(results[0]).toMatchObject({ file: VISIT_TEST, name: 'stores', classname: 'org.example.clinic.VisitTest', full_name: 'org.example.clinic.VisitTest#stores', identity: { version: TEST_IDENTITY_VERSION, runner: 'junit', path: VISIT_TEST, key: 'stores', classes: ['VisitTest'] } });
    const head = commitAll(m.repo, 'test: stores');
    const judged = judgeCriteria(args(m, red, { test_id: idOf(m, red, 'org.example.clinic.VisitTest#stores') }, head));
    expect(judged, JSON.stringify(judged).slice(0, 800)).toMatchObject({ ok: true, accepted: [{ identity: { key: 'stores', classes: ['VisitTest'] } }] });
    // Its identity was published with it: no alias is needed.
    if (judged.ok) expect(judged.accepted[0]!.identity_alias ?? null).toBeNull();
  });

  it('the same method in two files: each id is its own file\'s test; a name with the other class is refused', () => {
    const m = clinic();
    writeFiles(m.repo, { [VISIT_TEST]: VISIT_SRC, [VET_TEST]: VET_SRC });
    const red = gate(m, 'red', [
      { classname: 'org.example.clinic.VisitTest', name: 'stores', failed: true },
      { classname: 'org.example.clinic.VetTest', name: 'stores', failed: true },
    ], [{ file: VISIT_TEST, name: 'stores' }, { file: VET_TEST, name: 'stores' }]);
    const head = commitAll(m.repo, 'test: stores twice');
    expect(judgeCriteria(args(m, red, { test_id: idOf(m, red, 'org.example.clinic.VetTest#stores') }, head))).toMatchObject({ ok: true, accepted: [{ test: { path: VET_TEST }, identity: { path: VET_TEST, key: 'stores' } }] });
    expect(judgeCriteria(args(m, red, { test: { path: VISIT_TEST, name: 'org.example.clinic.VetTest#stores' } }, head))).toMatchObject({ ok: false, code: 'CRITERION_TEST_UNKNOWN' });
    expect(judgeCriteria(args(m, red, { test: { path: VISIT_TEST, name: 'VisitTest#stores' } }, head))).toMatchObject({ ok: true, accepted: [{ test: { path: VISIT_TEST } }] });
  });

  it('nested classes and overloads: told apart by the report, never by a bare name; a bare overloaded name is unknown', () => {
    const m = clinic();
    writeFiles(m.repo, { [ORDER_TEST]: ORDER_SRC });
    const red = gate(m, 'red', [
      { classname: 'org.example.clinic.OrderTest$WhenEmpty', name: 'rejects', failed: true },
      { classname: 'org.example.clinic.OrderTest$WhenFull', name: 'rejects', failed: true },
      { classname: 'org.example.clinic.OrderTest', name: 'prices', failed: true },
      { classname: 'org.example.clinic.OrderTest', name: 'prices(int)[1]', failed: true },
      { classname: 'org.example.clinic.OrderTest', name: 'prices(int)[2]', failed: true },
      { classname: 'org.example.clinic.OrderTest', name: 'discounts(String)[1]', failed: true },
    ], [{ file: ORDER_TEST, name: 'rejects' }, { file: ORDER_TEST, name: 'prices' }, { file: ORDER_TEST, name: 'discounts' }]);
    const head = commitAll(m.repo, 'test: orders');
    const accept = (full: string) => judgeCriteria(args(m, red, { test_id: idOf(m, red, full) }, head));
    expect(accept('org.example.clinic.OrderTest$WhenEmpty#rejects')).toMatchObject({ ok: true, accepted: [{ identity: { key: 'rejects', classes: ['OrderTest', 'WhenEmpty'] } }] });
    expect(accept('org.example.clinic.OrderTest$WhenFull#rejects')).toMatchObject({ ok: true, accepted: [{ identity: { key: 'rejects', classes: ['OrderTest', 'WhenFull'] } }] });
    expect(accept('org.example.clinic.OrderTest#prices(int)[2]')).toMatchObject({ ok: true, accepted: [{ identity: { key: 'prices', params: ['int'] } }] });
    expect(accept('org.example.clinic.OrderTest#discounts(String)[1]')).toMatchObject({ ok: true, accepted: [{ identity: { key: 'discounts' } }] });
    // `prices` alone: the no-argument test and the parameterized one share the name.
    expect(accept('org.example.clinic.OrderTest#prices')).toMatchObject({ ok: false, code: 'CRITERION_TEST_UNKNOWN' });
    // A legacy name that two nested classes answer to.
    expect(judgeCriteria(args(m, red, { test: { path: ORDER_TEST, name: 'rejects' } }, head))).toMatchObject({ ok: false, code: 'CRITERION_TEST_AMBIGUOUS' });
  });

  it('a binding naming a fake class, a wrong package or a malformed `#` for a real file is unknown', () => {
    const m = clinic();
    writeFiles(m.repo, { [VISIT_TEST]: VISIT_SRC });
    const red = gate(m, 'red', [{ classname: 'org.example.clinic.VisitTest', name: 'stores', failed: true }], [{ file: VISIT_TEST, name: 'stores' }]);
    const head = commitAll(m.repo, 'test: stores');
    // An earlier RED of the branch, kept as its binding (STATE.json), naming the file under another class.
    for (const full of ['org.example.clinic.FakeTest#stores', 'org.other.VisitTest#stores', 'org.example.clinic.VisitTest##stores', '#stores']) {
      const binding = { head_sha: m.base, tests: [{ path: VISIT_TEST, blob: null }], tests_sha256: 'c'.repeat(64), evidence_sha256: 'd'.repeat(64), recorded_at: new Date().toISOString(), red_tests: [{ id: 'e'.repeat(16), path: VISIT_TEST, full_name: full, status: 'failed', category: 'assertion' }] };
      const a = args(m, red, { test_id: 'e'.repeat(16), output_sha256: 'd'.repeat(64) }, head, { tdd_red_bindings: [binding] } as Partial<NodeRuntime>);
      expect(judgeCriteria(a), full).toMatchObject({ ok: false, code: 'CRITERION_TEST_UNKNOWN' });
    }
  });

  it('a test renamed or deleted after its RED, a head before it was committed, another module\'s file: refused', () => {
    const m = clinic();
    writeFiles(m.repo, { [VISIT_TEST]: VISIT_SRC });
    const red = gate(m, 'red', [{ classname: 'org.example.clinic.VisitTest', name: 'stores', failed: true }], [{ file: VISIT_TEST, name: 'stores' }]);
    const id = idOf(m, red, 'org.example.clinic.VisitTest#stores');
    const committed = commitAll(m.repo, 'test: stores');
    writeFiles(m.repo, { [VISIT_TEST]: VISIT_SRC.replace('void stores()', 'void storesVet()') });
    const renamed = commitAll(m.repo, 'test: rename');
    expect(judgeCriteria(args(m, red, { test_id: id }, renamed))).toMatchObject({ ok: false, code: 'CRITERION_TEST_UNKNOWN' });
    writeFiles(m.repo, { [VISIT_TEST]: VISIT_SRC.replace(/ {4}@Test\n {4}void stores\(\) \{ \}\n\n/, '') });
    const deleted = commitAll(m.repo, 'test: delete');
    expect(judgeCriteria(args(m, red, { test_id: id }, deleted))).toMatchObject({ ok: false, code: 'CRITERION_TEST_UNKNOWN' });
    // A stale head: the base, before the test was committed.
    expect(judgeCriteria(args(m, red, { test_id: id }, m.base))).toMatchObject({ ok: false, code: 'CRITERION_TEST_UNKNOWN' });
    expect(judgeCriteria(args(m, red, { test_id: id }, committed))).toMatchObject({ ok: true });
    // The same class in another module's file is never this module's test.
    writeFiles(m.repo, { [OTHER_MODULE_TEST]: VISIT_SRC });
    const other = commitAll(m.repo, 'test: other module');
    expect(judgeCriteria(args(m, red, { test: { path: OTHER_MODULE_TEST, name: 'org.example.clinic.VisitTest#stores' } }, other))).toMatchObject({ ok: false, code: 'CRITERION_TEST_OUTSIDE_MODULE' });
  });

  it('a JS title that ends in a Java method string is not that method: JS keeps its exact titles', () => {
    const m = clinic();
    const jsTest = `${MOD}/src/test/js/visits.test.mjs`;
    writeFiles(m.repo, { [jsTest]: "import { test } from 'node:test';\ntest('stores', () => {});\n" });
    const head = commitAll(m.repo, 'test: js');
    const red = runVerification({
      kind: 'red',
      nodeId: m.node.id,
      repository: 'clinic',
      command: ['node', '-e', `const fs=require('fs');fs.writeFileSync(process.argv[1] || 'r.xml','');`],
      cwd: m.repo,
      evidenceDir: join(m.control, 'features', 'CLN-1', 'evidence', m.node.id),
      pathBase: m.control,
      redDeclared: [{ file: jsTest, name: 'stores' }],
    });
    const binding = { head_sha: m.base, tests: [{ path: jsTest, blob: null }], tests_sha256: 'c'.repeat(64), evidence_sha256: 'f'.repeat(64), recorded_at: new Date().toISOString(), red_tests: [{ id: '1'.repeat(16), path: jsTest, full_name: 'visits > org.example.clinic.VisitTest#stores', status: 'failed', category: 'assertion' }] };
    const a = args(m, red, { test_id: '1'.repeat(16), output_sha256: 'f'.repeat(64) }, head, { tdd_red_bindings: [binding] } as Partial<NodeRuntime>);
    expect(judgeCriteria(a)).toMatchObject({ ok: false, code: 'CRITERION_TEST_UNKNOWN' });
  });
});
