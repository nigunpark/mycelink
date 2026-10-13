/**
 * Model-free CSET-202 on the real Changesets source, through the with arm
 * under the real boundary (WSL/Linux with bubblewrap and the prepared cache;
 * opt-in with MYCELINK_BENCH_REAL_CSET=1, an hour or more).
 *
 * The r1 findings, end to end: the generated manifest's module allowlist
 * gives every node a module-scoped verifier; four module workers (the
 * reference's changes per module, each file as another author would write
 * it) prove REDs the core classifier accepts, read declares its new
 * workspace dependency on @changesets/errors (package.json and the lockfile)
 * and its next gate installs it (setup inputs), every criterion names its
 * test, C001 is delivered; the evaluator's late defect reverts the errors
 * module's production, QA's hidden checks fail, and the rework's errors RED
 * runs the errors module alone (the dependents' tests no longer link), the
 * dependents re-verify, C002 is delivered, and the independent verifier
 * accepts the delivery — hidden acceptance, mutants, the TDD replay.
 *
 * And CSET-202 r2's exact shape, end to end: the first task controller
 * writes its running errors worker's result itself — the plugin's fence
 * refuses it, the harness stops the session and discards that dispatch, and
 * one corrective controller session re-dispatches it to a fresh, genuine
 * worker; the graph's criteria are the requirement's exact text and kinds
 * (the workspace's sidecar, through `feature acceptance`); the cli worker's
 * first evidence names AC-4's test by its id under a wrong display name and
 * AC-5 by an id no gate published — settle holds the same claim, charges
 * nothing, and a fresh worker corrects only the evidence: AC-4 by the RED's
 * failing test, AC-5 (compatibility) by an existing test green passed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { ISOLATED, TEST_ISOLATION } from './isolation-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { findPrd, loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadEvaluator, unbundleReference } from '../../evals-public-projects/lib/evaluator.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { independentCopy } from '../../evals-public-projects/lib/selftest.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { changedPaths, isTestPath, moduleOf } from '../../evals-public-projects/lib/scope.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { importSource } from '../../evals-public-projects/lib/source.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { resolveCacheRoot } from '../../evals-public-projects/lib/toolchain.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { runArm } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const cacheRoot = resolveCacheRoot();
const REAL = ISOLATED && process.env['MYCELINK_BENCH_REAL_CSET'] === '1' && existsSync(join(cacheRoot, 'toolchains.json')) && existsSync(join(cacheRoot, 'pnpm', 'changesets'));
const suite = loadSuite(join(REPO_ROOT, 'evals-public-projects'));
const cset = findPrd(suite, 'CSET-202');

/** The rework's regression test of the errors module: the export, inspected dynamically, so it fails an assertion. */
const ERRORS_REGRESSION = `import { describe, expect, it } from "vitest";

describe("ChangesetValidationError export", () => {
  it("is exported for the packages that throw it", async () => {
    const errors: Record<string, unknown> = await import("./index.ts");
    expect(errors.ChangesetValidationError).toBeTypeOf("function");
  });
});
`;

const firstTest = (source: string): string => /(?<![\w$.])it\s*\(\s*"((?:\\.|[^"\\])*)"/.exec(source)?.[1] as string;

interface ModuleWork {
  tests: Record<string, string>;
  impl: Record<string, string>;
  criteria: { criterion: string; path: string; name: string; gate: 'red' | 'green' | 'regression' }[];
}

/** The reference's changes per module, each file an independent copy; the lockfile with read's change. */
async function referencePlan(scratch: string): Promise<Record<string, ModuleWork>> {
  const project = cset.project;
  const adapter = project.adapter;
  const src = join(scratch, 'reference-src');
  await importSource({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file), target: src });
  const evaluator = loadEvaluator({ cacheRoot, project, prdId: 'CSET-202' });
  const head = unbundleReference({ evaluator, repo: src });
  const modules: Record<string, ModuleWork> = {};
  for (const change of changedPaths(src, project.lock.commit, head) as { path: string; status: string }[]) {
    if (change.status === 'D') throw new Error(`the reference deletes ${change.path}`);
    const module = change.path === 'pnpm-lock.yaml' ? 'read' : moduleOf(adapter, change.path);
    if (module === null || module === undefined) continue; // the release note
    const body = independentCopy(change.path, execFileSync('git', ['-C', src, 'show', `${head}:${change.path}`])).toString('utf8');
    const m = (modules[module] ??= { tests: {}, impl: {}, criteria: [] });
    (isTestPath(adapter, change.path) ? m.tests : m.impl)[change.path] = body;
  }
  rmSync(src, { recursive: true, force: true });
  const test = (module: string, file: string) => ({ path: file, source: modules[module]!.tests[file] as string });
  const errors = test('errors', 'packages/errors/src/index.test.ts');
  const read = test('read', 'packages/read/src/index.test.ts');
  const assemble = test('assemble-release-plan', 'packages/assemble-release-plan/src/index.test.ts');
  const status = test('cli', 'packages/cli/src/commands/status/__tests__/status.test.ts');
  modules['errors']!.criteria = [{ criterion: 'AC-1', path: errors.path, name: 'should sort the issues by changeset id, code and message', gate: 'red' }];
  modules['read']!.criteria = [
    { criterion: 'AC-2', path: read.path, name: 'should report every changeset that cannot be parsed at once', gate: 'red' },
    { criterion: 'AC-5', path: read.path, name: firstTest(read.source), gate: 'green' },
  ];
  modules['assemble-release-plan']!.criteria = [
    { criterion: 'AC-3', path: assemble.path, name: 'should report every package that is not in the workspace at once', gate: 'red' },
    { criterion: 'AC-5', path: assemble.path, name: firstTest(assemble.source), gate: 'green' },
  ];
  modules['cli']!.criteria = [
    { criterion: 'AC-4', path: status.path, name: 'should report every invalid changeset once', gate: 'red' },
    { criterion: 'AC-5', path: status.path, name: firstTest(status.source), gate: 'green' },
  ];
  return modules;
}

describe.runIf(REAL)('model-free CSET-202 on the real Changesets source', () => {
  it('C001 from four module workers, the late defect, the errors rework on its module alone, dependents re-verified, C002 accepted by the verifier', async () => {
    const dir = makeTmpDir('cset202-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const modules = await referencePlan(makeTmpDir('cset202-ref-'));
    expect(Object.keys(modules).sort()).toEqual(['assemble-release-plan', 'cli', 'errors', 'read']);
    expect(Object.keys(modules['read']!.impl).sort()).toEqual(['packages/read/package.json', 'packages/read/src/index.ts', 'pnpm-lock.yaml']);
    const plan = join(dir, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        log,
        modules,
        regression: {
          errors: {
            tests: { 'packages/errors/src/validation-export.test.ts': ERRORS_REGRESSION },
            criteria: [{ criterion: 'AC-1', path: 'packages/errors/src/validation-export.test.ts', name: 'is exported for the packages that throw it', gate: 'red' }],
          },
        },
        takeover: true,
        evidenceMistake: true,
      }),
    );
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-202',
      arm: 'with',
      faultPlan: { schema: 'mycelink-bench/fault-plan@1', id: 'late', faults: [{ kind: 'late-hidden-defect', trigger: { on: 'session-end' } }] },
      outDir: join(makeTmpDir('cset202-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset202-host.mjs')],
      pollMs: 1000,
      env: { FAKE_CLAUDE_PLAN: plan },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      requireTdd: true,
    });
    const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const report = JSON.stringify(seen.filter((e) => e.error || e.settled || e.delivery || e.owners), null, 1).slice(0, 6000);
    expect(seen.filter((e) => e.error), report).toEqual([]);
    expect(seen.filter((e) => e.phase).map((e) => e.phase)).toEqual(['task', 'task', 'rework']);
    // The first controller wrote its running worker's result itself: refused, stopped, its dispatch discarded, corrected once.
    expect(run.sessions.map((x: any) => [x.index, x.purpose, x.phase, x.ended_by, x.corrects ?? null])).toEqual([
      [1, 'task', 'task', 'controller-violation', null],
      [2, 'corrective', 'task', 'exit', 1],
      [3, 'rework', 'rework', 'exit', null],
    ]);
    expect(seen.find((e) => e.takeover)?.takeover).toMatchObject({ node: 'CSET-202.errors.impl', blocked: expect.stringMatching(/^Blocked: the Mycelink controller never writes a worker's result slot/) });
    expect(run.sessions[0].controller_edits[0]).toMatchObject({ tool: 'Write', action: 'Write', path: expect.stringMatching(/changesets__CSET-202\.errors\.impl\/\.mycelink-worker\/result-[0-9a-f-]+\.json$/) });
    expect(run.sessions[0].discarded).toEqual([expect.objectContaining({ node_id: 'CSET-202.errors.impl', discarded: true, archived_ref: expect.stringMatching(/^refs\/mycelink\/archive\//) })]);
    expect(run.controller).toMatchObject({ ok: true, failures: [], recovered: [expect.stringMatching(/the evaluator discarded the dispatch of CSET-202\.errors\.impl\. Recovered by session 2 \(corrective\)/)] });
    // The criteria are the requirement's, verbatim, with their kinds.
    const sidecar = JSON.parse(readFileSync(join(run.workspace, 'platform', 'requirements', 'CSET-202.acceptance.json'), 'utf8'));
    expect(seen.find((e) => e.acceptance)?.acceptance).toEqual({ from: 'sidecar', criteria: sidecar.criteria.map((c: any) => ({ id: c.id, kind: c.kind, sha256: c.sha256 })) });
    expect(sidecar.criteria.map((c: any) => [c.id, c.kind])).toEqual([['AC-1', 'new-behavior'], ['AC-2', 'new-behavior'], ['AC-3', 'new-behavior'], ['AC-4', 'new-behavior'], ['AC-5', 'compatibility']]);
    // The cli evidence was held on the same claim, nothing charged, and a fresh worker corrected only it.
    const held = seen.filter((e) => e.held).map((e) => e.held);
    expect(held).toEqual([expect.objectContaining({ node: 'CSET-202.cli.impl', attempts: 1, failures: 0, detail: expect.stringMatching(/^CRITERION_EVIDENCE_INVALID:CRITERION_TEST_UNKNOWN: AC-5 \(test_id 0000000000000000, green\)/) })]);
    const correction = seen.find((e) => e.correction)?.correction;
    expect(correction).toMatchObject({ node: 'CSET-202.cli.impl', code: 'CRITERION_TEST_UNKNOWN', corrections: 0 });
    expect(correction.criteria).toEqual(sidecar.criteria.filter((c: any) => ['AC-4', 'AC-5'].includes(c.id)).map((c: any) => ({ id: c.id, kind: c.kind, sha256: c.sha256 })));
    const cliSettles = seen.filter((e) => e.settled?.node === 'CSET-202.cli.impl').map((e) => e.settled.outcome);
    expect(cliSettles).toEqual(['EVIDENCE_CORRECTION_REQUIRED', 'DONE', 'DONE']);
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([
      { status: 'ACCEPTED', candidate_id: 'CSET-202-C001' },
      { status: 'ACCEPTED', candidate_id: 'CSET-202-C002' },
    ]);
    const workers = seen.filter((e) => e.worker).map((e) => e.worker);
    // Every node verified its own module; read's green installed the dependency it declared.
    expect(workers.slice(0, 4).map((w) => [w.node, w.module])).toEqual([
      ['CSET-202.errors.impl', 'errors'],
      expect.arrayContaining([expect.stringMatching(/^CSET-202\.(read|assemble-release-plan)\.impl$/)]),
      expect.arrayContaining([expect.stringMatching(/^CSET-202\.(read|assemble-release-plan)\.impl$/)]),
      ['CSET-202.cli.impl', 'cli'],
    ]);
    const readWorker = workers.find((w) => w.node === 'CSET-202.read.impl')!;
    expect(readWorker.gates.find((g: { gate: string }) => g.gate === 'green')).toMatchObject({ exit: 0, rerun: true });
    // The late defect, QA's report, the rework of the errors node.
    const late = run.faults.find((f: { kind: string }) => f.kind === 'late-hidden-defect');
    expect(late, JSON.stringify(run.faults)).toMatchObject({ applied: true, module: 'errors' });
    expect(late.reported.length).toBeGreaterThan(0);
    expect(seen.find((e) => e.owners)?.owners).toEqual(['CSET-202.errors.impl']);
    const rework = workers.slice(4);
    expect(rework[0]).toMatchObject({ node: 'CSET-202.errors.impl', rework: true, next_required_gate: 'RED_VERIFIED' });
    expect(rework[0].gates.map((g: { gate: string; exit: number }) => [g.gate, g.exit])).toEqual([['red', 0], ['green', 0], ['regression', 0]]);
    expect(rework.slice(1).map((w: { node: string; next_required_gate: string }) => [w.node, w.next_required_gate]).sort()).toEqual([
      ['CSET-202.assemble-release-plan.impl', 'GREEN_VERIFIED'],
      ['CSET-202.cli.impl', 'GREEN_VERIFIED'],
      ['CSET-202.read.impl', 'GREEN_VERIFIED'],
    ]);
    // The rework RED ran the errors module alone and failed an assertion.
    const control = join(run.workspace, 'platform');
    const state = JSON.parse(readFileSync(join(control, 'features', 'CSET-202', 'STATE.json'), 'utf8')).data;
    const red = state.nodes['CSET-202.errors.impl'].evidence.red;
    expect(red).toMatchObject({ module: 'errors', red_reason: 'behaviour-missing', red_category: 'assertion' });
    const results = JSON.parse(readFileSync(join(control, red.results.path), 'utf8')).results as { file: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.file.startsWith('packages/errors/'))).toBe(true);
    for (const id of ['errors', 'read', 'assemble-release-plan', 'cli']) expect(state.nodes[`CSET-202.${id}.impl`]).toMatchObject({ state: 'DONE' });
    // The verdict.
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    expect(run.verified).toBe(true);
  }, 7_200_000);
});
