/**
 * The authoritative post-run verifier, end to end on the toy project.
 *
 * Completion needs: a verified source and evaluator, hygiene, scope, no
 * leakage, no regression of the qualified baseline, new tests in every
 * required module, and every hidden acceptance test passing. TDD replay is
 * reported for every delivery and gates the verdict with requireTdd.
 * Orchestration evidence (a genuine Mycelink delivery) gates it with
 * requireMycelink, and each kind of broken evidence is named.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { ISOLATED, TEST_ISOLATION } from './isolation-fixture.js';
import { TOY, TOY_PRD, commitFiles, preparedToy, toyGit, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { verifyDelivery } from '../../evals-public-projects/lib/verify.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { buildWorkspace } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { mycelink, orchestrate } from '../../evals-public-projects/tools/mycelink-fixture.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { checkoutPluginArtifact } from '../../evals-public-projects/lib/plugin.mjs';

afterAll(() => cleanupTmpRoots());


let toy: Toy;
let suite: any;
let project: any;
let prd: any;

/** Agent-written tests: the reference tests' behaviour, not their bytes. */
const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));
const testsOf = (module: string) => Object.fromEntries(Object.entries(AGENT_TESTS).filter(([p]) => p.startsWith(`${module}/`)));
const codeOf = (module: string) => Object.fromEntries(Object.entries(TOY.referenceCode).filter(([p]) => p.startsWith(`${module}/`)));

beforeAll(async () => {
  ({ toy, project, prd } = await preparedToy());
  suite = loadSuite(toy.suite);
  expect(suite.problems).toEqual([]);
}, 300_000);

async function workspace(): Promise<{ ws: string; repo: string; home: string }> {
  const ws = join(makeTmpDir('bench-v-ws-'), 'ws');
  const home = makeTmpDir('bench-v-home-');
  await buildWorkspace({ project, prd, target: ws, home, cacheRoot: toy.cacheRoot });
  return { ws, repo: join(ws, 'repos', 'toyshop'), home };
}

function verify(ws: string, options: Record<string, unknown> = {}) {
  return verifyDelivery({ suiteRoot: toy.suite, caseKey: TOY_PRD, workspace: ws, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-v-work-'), isolation: TEST_ISOLATION, ...options });
}

/** Failed checks of every section that counts toward the verdict (orchestration only when required). */
const failed = (r: any) =>
  Object.entries(r.sections ?? {})
    .filter(([name, s]: [string, any]) => name !== 'orchestration' || s?.required)
    .flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));

/** Test-first, module by module, as a disciplined agent without Mycelink would. */
function deliverTestFirst(repo: string): void {
  commitFiles(repo, AGENT_TESTS, 'test: stock reservation and orders (failing)');
  commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
}

describe('verifyDelivery: completion', () => {
  it('rejects the untouched baseline', async () => {
    const { ws } = await workspace();
    const r = await verify(ws);
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(expect.arrayContaining(['hygiene:delivered', 'acceptance:hidden:AC-1 reserving reduces the stock', 'regression:tests-added:mod-a']));
    expect(r.sections.acceptance.checks.find((c: any) => c.id === 'hidden:AC-1 compat: reserving nothing keeps the stock').ok).toBe(true);
  }, 120_000);

  it('accepts an independent test-first delivery in both modules and credits its TDD replay', async () => {
    const { ws, repo } = await workspace();
    deliverTestFirst(repo);
    const r = await verify(ws);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.sections.tdd).toMatchObject({ ok: true, required: false });
    expect(r.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid']);
    expect(r.sections.orchestration).toMatchObject({ required: false, present: false });
    expect(r.evidence.acceptance.command.argv_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.evidence.delivered_tree).toBe(toyGit(repo, ['rev-parse', 'HEAD^{tree}']));
  }, 180_000);

  it('reports a delivery without test-first commits, and fails it only when TDD is required', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, { ...AGENT_TESTS, ...TOY.referenceCode }, 'feat: tests and code together');
    const r = await verify(ws);
    expect(r.ok).toBe(true);
    expect(r.sections.tdd).toMatchObject({ ok: false });
    expect(r.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['no-test-first']);
    expect((await verify(ws, { requireTdd: true })).ok).toBe(false);
  }, 180_000);

  it('rejects a delivery that ships a mutant: the hidden acceptance kills it', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, AGENT_TESTS, 'test: first');
    commitFiles(repo, { ...TOY.referenceCode, ...TOY.mutants['no-reject'] }, 'feat: without the rejection');
    const r = await verify(ws);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('acceptance:hidden:AC-2 an order larger than the stock is rejected');
  }, 180_000);

  it('rejects a regression of a qualified baseline test, and a required module without new tests', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, testsOf('mod-a'), 'test: a');
    commitFiles(repo, { ...codeOf('mod-a'), 'mod-b/src/orders.mjs': TOY.referenceCode['mod-b/src/orders.mjs'].replace("status: 'placed'", "status: 'accepted'") }, 'feat: renamed status');
    const r = await verify(ws);
    expect(failed(r)).toEqual(expect.arrayContaining(['regression:baseline-tests-pass', 'regression:tests-added:mod-b']));
  }, 180_000);

  it('requires no new tests in a declarations-only module, but still its production change', async () => {
    // The same suite, with mod-b declared declarations-only (a project fact, like @changesets/types).
    const declared = join(makeTmpDir('bench-v-suite-'), 'suite');
    cpSync(toy.suite, declared, { recursive: true });
    const adapterFile = join(declared, 'projects', 'toyshop', 'adapter.json');
    const adapter = JSON.parse(readFileSync(adapterFile, 'utf8'));
    adapter.modules.find((m: any) => m.id === 'mod-b').runtime_tests = false;
    writeFileSync(adapterFile, JSON.stringify(adapter, null, 2));

    const { ws, repo } = await workspace();
    commitFiles(repo, testsOf('mod-a'), 'test: a');
    commitFiles(repo, TOY.referenceCode, 'feat: both modules');
    const r = await verify(ws, { suiteRoot: declared, tdd: false });
    const check = r.sections.regression.checks.find((c: any) => c.id === 'tests-added:mod-b');
    expect(check).toMatchObject({ ok: true, detail: 'not required: mod-b is declarations only (no runtime behaviour to test)' });
    expect(r.sections.regression.ok).toBe(true);

    // Its production change is still required.
    const { ws: ws2, repo: repo2 } = await workspace();
    commitFiles(repo2, testsOf('mod-a'), 'test: a');
    commitFiles(repo2, codeOf('mod-a'), 'feat: a only');
    expect(failed(await verify(ws2, { suiteRoot: declared, tdd: false }))).toContain('scope:scope-required:mod-b');
  }, 240_000);

  it('rejects hidden acceptance content smuggled into the delivery', async () => {
    const { ws, repo } = await workspace();
    deliverTestFirst(repo);
    commitFiles(repo, { 'mod-a/test/copied.test.mjs': TOY.hidden['mod-a/test/reserve.acceptance.test.mjs'] }, 'test: copied');
    expect(failed(await verify(ws))).toContain('leakage:no-evaluator-blobs');
  }, 180_000);

  it('fails closed, before running anything, when the evaluator store no longer matches its lock', async () => {
    const { ws, repo } = await workspace();
    deliverTestFirst(repo);
    const hidden = join(toy.cacheRoot, 'evaluator', 'toyshop', TOY_PRD, 'hidden', 'mod-b', 'test', 'orders.acceptance.test.mjs');
    const original = readFileSync(hidden);
    try {
      writeFileSync(hidden, original.toString().replace("status: 'rejected'", "status: 'placed'"));
      const r = await verify(ws);
      expect(r.ok).toBe(false);
      expect(failed(r)).toEqual(['identity:evaluator-lock']);
      expect(r.sections.acceptance).toBeNull();
    } finally {
      writeFileSync(hidden, original);
    }
  }, 120_000);

  it('rejects a baseline recorded with another command than the one the verifier runs', async () => {
    const { ws, repo } = await workspace();
    deliverTestFirst(repo);
    const file = join(project.dir, 'baseline-tests.json');
    const original = readFileSync(file);
    try {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(original.toString()), command_sha256: '0'.repeat(64) }, null, 2) + '\n');
      const r = await verify(ws, { tdd: false });
      expect(r.ok).toBe(false);
      expect(failed(r)).toContain('regression:baseline-command');
    } finally {
      writeFileSync(file, original);
    }
    const good = await verify(ws, { tdd: false });
    expect(good.sections.regression.checks.find((c: any) => c.id === 'baseline-command')).toMatchObject({ ok: true });
  }, 240_000);

  it('refuses to run delivered code without an isolation boundary (or the tests\u2019 explicit stand-in), and records the one it used', async () => {
    const { ws, repo } = await workspace();
    deliverTestFirst(repo);
    const refused = await verifyDelivery({ suiteRoot: toy.suite, caseKey: TOY_PRD, workspace: ws, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-v-noiso-') });
    expect(refused.ok).toBe(false);
    expect(refused.errors.join('\n')).toMatch(/no isolation/);
    expect(refused.sections.regression).toBeNull();
    const r = await verify(ws, { tdd: false });
    expect(r.ok).toBe(true);
    expect(r.isolation).toMatchObject({ kind: ISOLATED ? 'bubblewrap' : 'none', enforced: ISOLATED });
    // The toy suite is not pinned and its qualification used one file system: confined or not, never trusted.
    expect(r.trust).toEqual({ isolation: ISOLATED, suite_pinned: false, qualification_filesystems: false });
    expect(r.trusted).toBe(false);
  }, 240_000);

  it('fails closed on a missing workspace or an unknown case', async () => {
    expect((await verify(join(makeTmpDir('bench-v-none-'), 'absent'))).ok).toBe(false);
    const { ws } = await workspace();
    await expect(verifyDelivery({ suiteRoot: toy.suite, caseKey: 'NOPE-404', workspace: ws, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('w-'), isolation: TEST_ISOLATION })).resolves.toMatchObject({ ok: false, errors: [expect.stringMatching(/unknown case NOPE-404/)] });
  }, 120_000);
});

describe('verifyDelivery: a qualified PRD, its inputs checked before and after', () => {
  const qualificationFile = () => join(prd.dir, 'qualification.json');
  async function withQualification(edit: ((q: any) => void) | null, run: () => Promise<void>): Promise<void> {
    const original = readFileSync(qualificationFile());
    try {
      if (edit === null) rmSync(qualificationFile());
      else {
        const q = JSON.parse(original.toString());
        edit(q);
        writeFileSync(qualificationFile(), JSON.stringify(q, null, 2) + '\n');
      }
      await run();
    } finally {
      writeFileSync(qualificationFile(), original);
    }
  }

  it('refuses, before running anything, a PRD without a qualification or with one made for another evaluator, source or toolchain', async () => {
    const { ws, repo } = await workspace();
    deliverTestFirst(repo);
    for (const edit of [null, (q: any) => (q.evaluator_digest_sha256 = 'f'.repeat(64)), (q: any) => (q.source_identity_sha256 = 'f'.repeat(64)), (q: any) => (q.bindings.toolchains.node = 'f'.repeat(64)), (q: any) => (q.mutants.killed = 1), (q: any) => (q.mutants.by_module = { 'mod-a': 1 })]) {
      await withQualification(edit, async () => {
        const r = await verify(ws, { tdd: false });
        expect(r.ok).toBe(false);
        expect(failed(r)).toEqual(['identity:qualification']);
        expect(r.sections.regression).toBeNull();
      });
    }
  }, 300_000);

  it('refuses trusted runs whose command is not the one qualified', async () => {
    const { ws, repo } = await workspace();
    deliverTestFirst(repo);
    await withQualification((q) => (q.bindings.commands.full_suite_sha256 = 'f'.repeat(64)), async () => {
      expect(failed(await verify(ws, { tdd: false }))).toEqual(['regression:qualified-command']);
    });
    await withQualification((q) => (q.bindings.commands.hidden_sha256 = 'f'.repeat(64)), async () => {
      expect(failed(await verify(ws, { tdd: false }))).toEqual(['acceptance:qualified-command']);
    });
    const good = await verify(ws, { tdd: false });
    expect(good.ok).toBe(true);
    expect(good.sections.integrity.checks.map((c: any) => [c.id, c.ok])).toEqual([
      ['evaluator-after', true],
      ['toolchains-after', true],
      ['cache-after', true],
    ]);
  }, 300_000);

  it('never trusts an evaluator store the delivered code changed while it ran', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, AGENT_TESTS, 'test: first');
    const hidden = join(toy.cacheRoot, 'evaluator', 'toyshop', TOY_PRD, 'hidden', 'mod-b', 'test', 'orders.acceptance.test.mjs');
    const original = readFileSync(hidden);
    // Production code that, once a test imports it, appends to a hidden test in the evaluator store.
    const tamper = `import { appendFileSync } from 'node:fs';\ntry {\n  appendFileSync(${JSON.stringify(hidden)}, '\\n// weakened\\n');\n} catch {}\n`;
    commitFiles(repo, { ...TOY.referenceCode, 'mod-a/src/stock.mjs': tamper + TOY.referenceCode['mod-a/src/stock.mjs'] }, 'feat: orders reserve stock');
    try {
      const r = await verify(ws, { tdd: false });
      const changed = !readFileSync(hidden).equals(original);
      // Either the isolation boundary kept the store out of reach, or the check after the runs catches the change.
      expect(failed(r).includes('integrity:evaluator-after')).toBe(changed);
      if (changed) expect(r.ok).toBe(false);
      // Inside the boundary the store does not exist for the delivered code; without it, the check after the runs is what catches the write.
      expect(changed).toBe(!ISOLATED);
    } finally {
      writeFileSync(hidden, original);
    }
  }, 300_000);
});

describe('verifyDelivery: orchestration evidence from a genuine Mycelink delivery', () => {
  let ws: string;
  let repo: string;
  let control: string;
  let authority: string;

  beforeAll(async () => {
    ({ ws, repo } = await workspace());
    const plan = {
      test_command: ['node', '--test'],
      nodes: [
        { module: 'mod-a', allowed: ['mod-a/**'], verification: ['node', '--test', 'mod-a/test/reserve.test.mjs'], tests: testsOf('mod-a'), impl: codeOf('mod-a') },
        { module: 'mod-b', allowed: ['mod-b/**'], after: ['mod-a'], verification: ['node', '--test', 'mod-b/test/place.test.mjs'], tests: testsOf('mod-b'), impl: codeOf('mod-b') },
      ],
    };
    ({ control, authority } = orchestrate({ workspace: ws, project, prd, plan }));
  }, 600_000);

  it('accepts the delivery with complete orchestration evidence, and credits each node as test-first', async () => {
    const r = await verify(ws, { requireMycelink: true });
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.sections.orchestration).toMatchObject({ required: true, present: true, ok: true });
    expect(r.sections.tdd.units.filter((u: any) => u.verdict === 'valid').length).toBe(2);
    expect(r.sections.tdd.ok).toBe(true);
    // The worker contract's history: per node, the test-only RED commit, then production alone.
    const subjects = toyGit(repo, ['log', '--reverse', '--format=%s', `${toy.start}..HEAD`]).split('\n');
    expect(subjects.filter((s) => /\.impl/.test(s))).toEqual([`test: ${TOY_PRD}.mod-a.impl (RED)`, `feat: ${TOY_PRD}.mod-a.impl`, `test: ${TOY_PRD}.mod-b.impl (RED)`, `feat: ${TOY_PRD}.mod-b.impl`]);
  }, 300_000);

  it('Mycelink itself refuses a worker that committed tests and production together, as the first pilot’s workers did', async () => {
    const { ws: mixedWs, repo: mixedRepo } = await workspace();
    const plan = {
      test_command: ['node', '--test'],
      nodes: [{ module: 'mod-a', allowed: ['mod-a/**', 'mod-b/**'], verification: ['node', '--test', 'mod-a/test/reserve.test.mjs'], tests: AGENT_TESTS, impl: TOY.referenceCode, history: 'mixed' }],
    };
    const before = toyGit(mixedRepo, ['rev-parse', 'main']);
    // Settle refuses the history before integration: the orchestration never reaches delivery.
    expect(() => orchestrate({ workspace: mixedWs, project, prd, plan })).toThrow(/TDD_HISTORY_INVALID:MIXED_COMMIT/);
    expect(toyGit(mixedRepo, ['rev-parse', 'main'])).toBe(before);
    const r = await verify(mixedWs, { requireMycelink: true, requireTdd: true });
    expect(r.ok).toBe(false);
    expect(r.sections.orchestration.ok).toBe(false);
  }, 600_000);

  it.each([
    ['a leaked lease', () => mycelink(['resource', 'acquire', TOY_PRD, 'full-runtime', '--node', 'stray', '--control-root', control, '--authority', authority]), () => mycelink(['resource', 'release', TOY_PRD, 'node:stray', '--control-root', control, '--authority', authority]), `no-leaked-leases:${TOY_PRD}`],
    ['a live session', () => liveSession(), () => rmSync(join(control, 'features', TOY_PRD, 'sessions'), { recursive: true, force: true }), `no-live-sessions:${TOY_PRD}`],
    ['corrupted feature state', () => writeFileSync(join(control, 'features', TOY_PRD, 'STATE.json'), '{"revision": 1, "data": '), null, `state-readable:${TOY_PRD}`],
    ['a missing evidence file', () => rmSync(firstEvidence(), { force: true }), null, `evidence-files:${TOY_PRD}`],
    ['a feature state that never reached COMPLETED', () => editDoc(featureFile('STATE.json'), (d) => (d.feature_state = 'RUNNING')), null, `feature-completed:${TOY_PRD}`],
    ['a missing delivery manifest', () => rmSync(deliveryManifest(), { force: true }), null, `delivery-accepted:${TOY_PRD}`],
    ['a delivery manifest that is not the accepted one', () => appendFileSync(deliveryManifest(), '\n'), null, `delivery-accepted:${TOY_PRD}`],
    ['a changed acceptance output', () => appendFileSync(acceptanceOutput(), 'edited\n'), null, `delivery-accepted:${TOY_PRD}`],
    ['an event log without the delivery', () => writeFileSync(featureFile('events.jsonl'), readFileSync(featureFile('events.jsonl'), 'utf8').split('\n').filter((l) => !l.includes('"delivery.delivered"')).join('\n')), null, `delivery-accepted:${TOY_PRD}`],
  ])('rejects %s', async (_label, spoil, undo, check) => {
    const snapshot = snapshotFeature();
    try {
      spoil();
      const r = await verify(ws, { requireMycelink: true, tdd: false });
      expect(r.ok).toBe(false);
      expect(failed(r)).toContain(`orchestration:${check}`);
    } finally {
      if (undo) undo();
      restoreFeature(snapshot);
    }
  }, 300_000);

  it('runs only the pinned Mycelink artifact: a tampered CLI is refused before any of it runs', async () => {
    const pinned = checkoutPluginArtifact();
    const copy = join(makeTmpDir('bench-v-cli-'), 'plugin');
    cpSync(pinned.dir, copy, { recursive: true });
    const marker = join(makeTmpDir('bench-v-cli-marker-'), 'tampered-cli-ran');
    const bin = join(copy, 'bin', 'mycelink.mjs');
    chmodSync(bin, 0o755);
    writeFileSync(bin, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nprocess.stdout.write(JSON.stringify({ ok: true, problems: [] }));\n`);
    const r = await verify(ws, { requireMycelink: true, tdd: false, mycelink: { ...pinned, dir: copy } });
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('orchestration:mycelink-artifact');
    expect(existsSync(marker)).toBe(false);
    // The verdict names the artifact it ran.
    const good = await verify(ws, { requireMycelink: true, tdd: false, mycelink: pinned });
    expect(good.ok).toBe(true);
    expect(good.evidence.mycelink_artifact).toMatchObject({ zip_sha256: pinned.zip_sha256, tree_sha256: pinned.tree_sha256, before: true, after: true });
  }, 300_000);

  it('judges the delivery the same whatever git or Mycelink environment the operator has', async () => {
    const elsewhere = makeTmpDir('bench-v-env-');
    const hostile: Record<string, string> = {
      GIT_DIR: join(elsewhere, 'not-a-repo'),
      GIT_WORK_TREE: elsewhere,
      GIT_INDEX_FILE: join(elsewhere, 'index'),
      GIT_OBJECT_DIRECTORY: join(elsewhere, 'objects'),
      MYCELINK_CONTROL_ROOT: elsewhere,
      MYCELINK_CLAIM_TOKEN: 'b'.repeat(64),
    };
    const saved = Object.fromEntries(Object.keys(hostile).map((k) => [k, process.env[k]]));
    Object.assign(process.env, hostile);
    let r: any;
    try {
      r = await verify(ws, { requireMycelink: true, tdd: false });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
  }, 300_000);

  it('refuses to run Mycelink while any registered repository could make git run a program, or lies outside the workspace', async () => {
    const registry = join(control, 'repositories.yaml');
    const original = readFileSync(registry);
    const marker = join(makeTmpDir('bench-v-marker-'), 'fsmonitor-ran');
    const extra = join(ws, 'repos', 'extra');
    mkdirSync(extra, { recursive: true });
    toyGit(extra, ['init', '-q', '-b', 'main']);
    commitFiles(extra, { 'README.md': '# extra\n' }, 'extra: initial');
    try {
      mycelink(['repo', 'register', '--control-root', control, '--authority', authority, '--name', 'extra', '--path', '../repos/extra', '--base-branch', 'main', '--', 'node', '--test']);
      appendFileSync(join(extra, '.git', 'config'), `[core]\n\tfsmonitor = node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'x')"\n`);
      const r = await verify(ws, { requireMycelink: true, tdd: false });
      expect(r.ok).toBe(false);
      expect(failed(r)).toContain('orchestration:registered-repositories-safe');
      expect(existsSync(marker)).toBe(false);

      // A registered repository outside the workspace is refused too.
      writeFileSync(join(extra, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
      const outside = join(makeTmpDir('bench-v-outside-'), 'repo');
      mkdirSync(outside, { recursive: true });
      toyGit(outside, ['init', '-q', '-b', 'main']);
      commitFiles(outside, { 'README.md': '# outside\n' }, 'outside: initial');
      writeFileSync(registry, readFileSync(registry, 'utf8').replace('../repos/extra', relative(control, outside).replace(/\\/g, '/')));
      expect(failed(await verify(ws, { requireMycelink: true, tdd: false }))).toContain('orchestration:registered-repositories-safe');
    } finally {
      writeFileSync(registry, original);
      rmSync(extra, { recursive: true, force: true });
    }
  }, 300_000);

  it('rejects a second current feature and a delivery that drifted from the candidate', async () => {
    const snapshot = snapshotFeature();
    const second = 'TOY-777';
    mkdirSync(join(control, 'features', second), { recursive: true });
    writeFileSync(join(control, 'features', second, 'PRD.md'), '# follow-up\n');
    writeFileSync(join(control, 'features', second, 'PORTFOLIO-GRAPH.yaml'), readFileSync(join(control, 'features', TOY_PRD, 'PORTFOLIO-GRAPH.yaml'), 'utf8').replaceAll(TOY_PRD, second));
    mycelink(['feature', 'init', second, '--control-root', control, '--authority', authority, '--json']);
    let r = await verify(ws, { requireMycelink: true, tdd: false });
    expect(failed(r)).toContain('orchestration:exactly-one-current-feature');
    rmSync(join(control, 'features', second), { recursive: true, force: true });
    restoreFeature(snapshot);

    const head = toyGit(repo, ['rev-parse', 'HEAD']);
    commitFiles(repo, { 'mod-b/src/late.mjs': 'export const late = true;\n' }, 'late change outside the candidate');
    r = await verify(ws, { requireMycelink: true, tdd: false });
    expect(failed(r)).toContain(`orchestration:candidate-equals-delivery:${TOY_PRD}`);
    toyGit(repo, ['reset', '-q', '--hard', head]);
  }, 300_000);

  function liveSession(): void {
    const dir = join(control, 'features', TOY_PRD, 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ revision: 1, data: { schema_version: 1, sessions: { ghost: { session_id: 'ghost', status: 'working', pid: process.pid } } } }));
  }
  function editDoc(path: string, edit: (data: any) => void): void {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    edit(doc.data);
    doc.revision += 1;
    writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  }
  function featureFile(name: string): string {
    return join(control, 'features', TOY_PRD, name);
  }
  function deliveryManifest(): string {
    const candidate = JSON.parse(readFileSync(featureFile('STATE.json'), 'utf8')).data.current_candidate;
    return featureFile(join('deliveries', `${candidate}.json`));
  }
  function acceptanceOutput(): string {
    const manifest = JSON.parse(readFileSync(deliveryManifest(), 'utf8'));
    return join(control, manifest.acceptance[0].output_path);
  }
  function firstEvidence(): string {
    const dir = join(control, 'features', TOY_PRD, 'evidence');
    const node = readdirSync(dir).sort()[0]!;
    return join(dir, node, readdirSync(join(dir, node)).sort()[0]!);
  }
  function snapshotFeature(): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const walk = (d: string) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, n.name);
        if (n.isDirectory()) walk(p);
        else files.set(p, readFileSync(p));
      }
    };
    walk(join(control, 'features', TOY_PRD));
    return files;
  }
  function restoreFeature(files: Map<string, Buffer>): void {
    for (const [p, body] of files) {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
    }
    void appendFileSync;
  }
});
