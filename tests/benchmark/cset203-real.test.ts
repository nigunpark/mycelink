/**
 * Model-free CSET-203 on the real Changesets source, through the with arm
 * under the real boundary (WSL/Linux with bubblewrap and the prepared cache;
 * opt-in with MYCELINK_BENCH_REAL_CSET=1, an hour or more).
 *
 * CSET-203 r1's two orchestration findings, end to end on the reference's
 * own changes (each file as another author would write it):
 *
 *  - with-normal: the cli worker's first submission proves AC-3 by its RED
 *    but maps AC-4 (a new behaviour) to an existing GREEN test. Settle holds
 *    the same claim (CRITERION_RED_REQUIRED, nothing charged); reconcile
 *    names it (`settlement: "correction"`); `dispatch --resume` hands a
 *    genuine worker the correction naming AC-4, its kind and the red gate;
 *    it adds AC-4's own RED cycle (the reference's failure tests alone, red,
 *    then the reference's failure reporting) and settles DONE;
 *  - with-faults: r1's `compat.regression` node (AC-5, no allowed paths, the
 *    full suite) is a verification node: dispatch runs both modules and the
 *    full suite on the integrated head itself, with no worker.
 *
 * C001 is delivered and the independent verifier accepts it — hidden
 * acceptance, mutants, the TDD replay of both cli cycles.
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
import { runArm, runVerdict } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const cacheRoot = resolveCacheRoot();
const REAL = ISOLATED && process.env['MYCELINK_BENCH_REAL_CSET'] === '1' && existsSync(join(cacheRoot, 'toolchains.json')) && existsSync(join(cacheRoot, 'pnpm', 'changesets'));
const suite = loadSuite(join(REPO_ROOT, 'evals-public-projects'));
const cset = findPrd(suite, 'CSET-203');

const ARP_TESTS = 'packages/apply-release-plan/src/rollback.test.ts';
const INTERRUPTED = 'packages/cli/src/commands/version/interrupted.test.ts';
const VERSION_TESTS = 'packages/cli/src/commands/version/version.test.ts';
const VERSION = 'packages/cli/src/commands/version/index.ts';

/** Cut `piece` out of `text`, failing loudly when the reference no longer holds it. */
function cut(text: string, piece: string | RegExp, by = ''): string {
  const found = typeof piece === 'string' ? text.includes(piece) : piece.test(text);
  if (!found) throw new Error(`the reference no longer holds ${String(piece).slice(0, 120)}`);
  return text.replace(piece, by);
}

interface Work {
  tests: Record<string, string>;
  impl: Record<string, string>;
  criteria: { criterion: string; path: string; name: string; gate: 'red' | 'green' | 'regression'; held?: boolean }[];
}

/** The reference's changes per module; the cli's split into AC-3's cycle and AC-4's correction cycle. */
async function referencePlan(scratch: string): Promise<{ modules: Record<string, Work>; correction: Record<string, Work> }> {
  const project = cset.project;
  const adapter = project.adapter;
  const src = join(scratch, 'reference-src');
  await importSource({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file), target: src });
  const evaluator = loadEvaluator({ cacheRoot, project, prdId: 'CSET-203' });
  const head = unbundleReference({ evaluator, repo: src });
  const raw: Record<string, string> = {};
  const base: Record<string, string> = {};
  for (const change of changedPaths(src, project.lock.commit, head) as { path: string; status: string }[]) {
    const module = moduleOf(adapter, change.path);
    if (module !== 'apply-release-plan' && module !== 'cli') continue; // the release note and the docs
    raw[change.path] = execFileSync('git', ['-C', src, 'show', `${head}:${change.path}`]).toString('utf8');
    if (change.status !== 'A') base[change.path] = execFileSync('git', ['-C', src, 'show', `${project.lock.commit}:${change.path}`]).toString('utf8');
  }
  rmSync(src, { recursive: true, force: true });
  const copy = (path: string, body: string): string => independentCopy(path, Buffer.from(body, 'utf8')).toString('utf8');
  const files = (paths: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(paths).map(([p, b]) => [p, copy(p, b)]));
  const arpTests = Object.keys(raw).filter((p) => p.startsWith('packages/apply-release-plan/') && isTestPath(adapter, p));
  const arpImpl = Object.keys(raw).filter((p) => p.startsWith('packages/apply-release-plan/') && !isTestPath(adapter, p));
  expect(arpTests).toEqual([ARP_TESTS]);
  // AC-3 alone: the recovery, without the failure reporting (AC-4) the reference adds in the same file.
  const recoveryOnly = cut(
    cut(
      cut(raw[VERSION] as string, 'import { inspect } from "node:util";\n'),
      /  let touchedFiles: string\[\];\n  try \{\n    touchedFiles = await applyReleasePlan\(\n([\s\S]*?)    \);\n  \} catch \(error\) \{[\s\S]*?\n  \}\n/,
      '  const [...touchedFiles] = await applyReleasePlan(\n$1  );\n',
    ),
    /\nfunction formatErrorWithCauses\(error: unknown\) \{[\s\S]*?\n\}\n/,
  );
  const interruptedRecovery = cut(raw[INTERRUPTED] as string, /\n\n    it\("should roll back and exit with code 1[\s\S]*?\n    \}\);\n(?=  \},\n\);)/, '\n');
  const modules: Record<string, Work> = {
    'apply-release-plan': {
      tests: files({ [ARP_TESTS]: raw[ARP_TESTS] as string }),
      impl: files(Object.fromEntries(arpImpl.map((p) => [p, raw[p] as string]))),
      criteria: [
        { criterion: 'AC-1', path: ARP_TESTS, name: 'should restore every file it changed or created and reject with the original error as the cause', gate: 'red' },
        { criterion: 'AC-2', path: ARP_TESTS, name: 'should keep a journal in the .changeset directory while applying the release plan', gate: 'red' },
      ],
    },
    cli: {
      tests: files({ [INTERRUPTED]: interruptedRecovery }),
      impl: files({ [VERSION]: recoveryOnly }),
      criteria: [
        { criterion: 'AC-3', path: INTERRUPTED, name: 'should recover from a version process that got killed while applying the release plan', gate: 'red' },
        // r1's worker: AC-4, a new behaviour, mapped to an existing test the green gate passed.
        { criterion: 'AC-4', path: VERSION_TESTS, name: 'should not commit the result if commit config is not set', gate: 'green' },
        { criterion: 'AC-5', path: VERSION_TESTS, name: 'should git add the expected files if commit config is set', gate: 'green' },
      ],
    },
  };
  const correction: Record<string, Work> = {
    cli: {
      tests: files({ [INTERRUPTED]: raw[INTERRUPTED] as string, [VERSION_TESTS]: raw[VERSION_TESTS] as string }),
      impl: files({ [VERSION]: raw[VERSION] as string }),
      criteria: [
        { criterion: 'AC-3', path: INTERRUPTED, name: 'should recover from a version process that got killed while applying the release plan', gate: 'red', held: true },
        { criterion: 'AC-4', path: VERSION_TESTS, name: 'should report the failure without committing and exit with code 1', gate: 'red' },
        { criterion: 'AC-5', path: VERSION_TESTS, name: 'should git add the expected files if commit config is set', gate: 'green' },
      ],
    },
  };
  void base;
  return { modules, correction };
}

describe.runIf(REAL)('model-free CSET-203 on the real Changesets source', () => {
  it("the cli's AC-4 corrected by its own RED cycle, r1's compat node run as a verification node, C001 accepted by the verifier", async () => {
    const dir = makeTmpDir('cset203-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const { modules, correction } = await referencePlan(makeTmpDir('cset203-ref-'));
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ log, modules, correction }));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-203',
      arm: 'with',
      faultPlan: null,
      outDir: join(makeTmpDir('cset203-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset203-host.mjs')],
      pollMs: 1000,
      env: { FAKE_CLAUDE_PLAN: plan },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      requireTdd: true,
    });
    const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const report = JSON.stringify(seen.filter((e) => e.error || e.settled || e.delivery || e.held || e.controller), null, 1).slice(0, 8000);
    expect(seen.filter((e) => e.error), report).toEqual([]);
    expect(run.sessions.map((x: any) => [x.index, x.purpose, x.ended_by])).toEqual([[1, 'task', 'exit']]);
    // The criteria are the requirement's, verbatim, with their kinds.
    const sidecar = JSON.parse(readFileSync(join(run.workspace, 'platform', 'requirements', 'CSET-203.acceptance.json'), 'utf8'));
    expect(sidecar.criteria.map((c: any) => [c.id, c.kind])).toEqual([['AC-1', 'new-behavior'], ['AC-2', 'new-behavior'], ['AC-3', 'new-behavior'], ['AC-4', 'new-behavior'], ['AC-5', 'compatibility']]);
    // Every first worker's brief opened with its criteria (the correction's opens with the correction, checked below); the cli's check named AC-4 before it submitted.
    const workers = seen.filter((e) => e.worker).map((e) => e.worker);
    expect(workers.map((w: any) => [w.node, w.brief])).toEqual([
      ['CSET-203.changesets.apply-release-plan.crash-safe', true],
      ['CSET-203.changesets.cli.version-recovery', true],
      ['CSET-203.changesets.cli.version-recovery', false],
    ]);
    expect(workers[1].check).toMatchObject({ ok: false, code: 'CRITERION_RED_REQUIRED', criterion: 'AC-4', required_gate: 'red' });
    // Held on the same claim, nothing charged; reconcile named it; a genuine worker added AC-4's RED cycle.
    expect(seen.find((e) => e.held)?.held).toMatchObject({ node: 'CSET-203.changesets.cli.version-recovery', attempts: 1, failures: 0, correction: { criterion: 'AC-4', cycle: true } });
    expect(seen.find((e) => e.reconciled)?.reconciled).toEqual([{ node: 'CSET-203.changesets.cli.version-recovery', settlement: 'correction' }]);
    expect(seen.find((e) => e.correction)?.correction).toMatchObject({ criterion: 'AC-4', kind: 'new-behavior', required_gate: 'red', cycle: true, corrections: 0, top: expect.stringMatching(/Evidence correction: AC-4 \(new behavior\) needs gate "red"/) });
    expect(workers[2].gates.map((g: any) => [g.gate, g.exit])).toEqual([['red', 0], ['green', 0], ['regression', 0]]);
    expect(seen.filter((e) => e.settled).map((e) => [e.settled.node, e.settled.outcome])).toEqual([
      ['CSET-203.changesets.apply-release-plan.crash-safe', 'DONE'],
      ['CSET-203.changesets.cli.version-recovery', 'EVIDENCE_CORRECTION_REQUIRED'],
      ['CSET-203.changesets.cli.version-recovery', 'DONE'],
    ]);
    // r1's compat node ran inside dispatch, no worker; then the candidate.
    expect(seen.filter((e) => e.controller).map((e) => [e.controller.node, e.controller.outcome])).toEqual([
      ['CSET-203.changesets.compat.regression', 'DONE'],
      ['CSET-203.candidate.build', 'DONE'],
    ]);
    // The acceptance review ran between the compatibility node and the candidate, and passed.
    expect(seen.filter((e) => e.review).map((e) => [e.review.review_id, e.review.outcome])).toEqual([['CSET-203-R001', 'PASS']]);
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([{ status: 'ACCEPTED', candidate_id: 'CSET-203-C001' }]);
    const control = join(run.workspace, 'platform');
    const state = JSON.parse(readFileSync(join(control, 'features', 'CSET-203', 'STATE.json'), 'utf8')).data;
    expect(state.nodes['CSET-203.changesets.cli.version-recovery']).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {}, tdd_history: { cycles: 2 } });
    const compat = state.nodes['CSET-203.changesets.compat.regression'];
    expect(compat).toMatchObject({ state: 'DONE', attempts: 1, criteria: [expect.objectContaining({ criterion: 'AC-5', gate: 'regression' })], worktree_setup: { status: 'complete' } });
    const receipt = JSON.parse(readFileSync(join(control, compat.evidence.regression.output_path), 'utf8'));
    expect(receipt.runs.map((r: any) => [r.verifier, r.exit_code])).toEqual([['module-apply-release-plan', 0], ['module-cli', 0], ['full-suite', 0]]);
    expect(receipt.tests.passed.length).toBeGreaterThan(50);
    // The verdict.
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    expect(run.verified).toBe(true);
  }, 7_200_000);
  /**
   * CSET-203 r9, exactly: Mycelink initialised and the key open, the first
   * controller runs a graph generator of its own (gen.py) that writes
   * ACCEPTANCE.json through a path it computes — the plugin's fence never
   * sees it — flips an index mode bit in the product repository and leaves a
   * symlink in the workspace. The harness finds all of it by the workspace,
   * stops the session, rolls exactly that back (Mycelink's init and key
   * kept), verifies it, and starts one corrective session told nothing is
   * left to clean up, whose first action is /mycelink:run: it recovers the
   * key, writes the acceptance manifest through `feature acceptance`, and
   * goes on to C001, which the verifier accepts.
   */
  it('r9: a helper script writes ACCEPTANCE.json outside the fence; rolled back automatically, the corrective session initialises the feature legitimately and delivers C001', async () => {
    const dir = makeTmpDir('cset203-r9-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const { modules, correction } = await referencePlan(makeTmpDir('cset203-r9-ref-'));
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ log, modules, correction, r9: true }));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-203',
      arm: 'with',
      faultPlan: null,
      outDir: join(makeTmpDir('cset203-r9-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset203-host.mjs')],
      pollMs: 1000,
      lightCheckMs: 5000,
      env: { FAKE_CLAUDE_PLAN: plan },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      requireTdd: true,
    });
    const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(seen.filter((e) => e.error), JSON.stringify(seen.filter((e) => e.error))).toEqual([]);
    expect(seen.filter((e) => e.forged)).toEqual([{ forged: 'r9' }]);
    expect(run.sessions.map((x: any) => [x.index, x.purpose, x.ended_by, x.corrects ?? null])).toEqual([
      [1, 'task', 'controller-violation', null],
      [2, 'corrective', 'exit', 1],
    ]);
    const [first, second] = run.sessions;
    expect(first.violation).toMatchObject({ mode: 'selective', verified: true });
    expect(first.violation.summary).toEqual(
      expect.arrayContaining([
        'platform/features/CSET-203/ACCEPTANCE.json (created; a Mycelink-managed file)',
        'platform/gen.py (created; a helper or scratch file in the workspace)',
        expect.stringMatching(/^repos\/changesets\/\.git\/index \(modified; /),
        expect.stringMatching(/^plat \(created; /),
      ]),
    );
    expect(first.controller_txn.rollback).toMatchObject({ verified: true, removed: expect.arrayContaining(['platform/features/CSET-203/ACCEPTANCE.json', 'platform/gen.py', 'plat']), restored: expect.arrayContaining(['repos/changesets/.git/index']) });
    expect(first.controller_txn.authorized.core).toBeGreaterThan(0);
    expect(second.violation ?? null).toBeNull();
    // The manifest is Mycelink's: the requirement's criteria, verbatim.
    const control = join(run.workspace, 'platform');
    const manifest = JSON.parse(readFileSync(join(control, 'features', 'CSET-203', 'ACCEPTANCE.json'), 'utf8'));
    expect(manifest.criteria.map((c: any) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5']);
    expect(existsSync(join(control, 'gen.py'))).toBe(false);
    expect(existsSync(join(run.workspace, 'plat'))).toBe(false);
    expect(execFileSync('git', ['ls-files', '-s', 'package.json'], { cwd: join(run.workspace, 'repos', 'changesets'), encoding: 'utf8' })).toMatch(/^100644 /);
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([{ status: 'ACCEPTED', candidate_id: 'CSET-203-C001' }]);
    expect(run.controller).toMatchObject({ ok: true, failures: [], authority_recovered: true });
    expect(run.controller.recovered).toEqual([expect.stringMatching(/^controller-violation: session 1 \(task\) changed the workspace itself: .*rolled back \(selective, verified\)\. Recovered by session 2 \(corrective\), which completed it through Mycelink to CSET-203-C001$/)]);
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    expect(run.verified).toBe(true);
    // The rollback, attested again against the run's end: the manifest the record names, nothing the controller wrote left.
    expect(run.controller_rollbacks).toEqual({ ok: true, problems: [], sessions: [{ session: 1, ok: true, mode: 'selective', manifest_sha256: first.violation.manifest_sha256, checked: 4, quarantined: [] }] });
    // A test checkout is never pinned (lib/suite-pin.mjs), so the verifier withholds its trust for that alone;
    // the same record under a pinned suite is verified — the violation recovered, its rollback attested.
    expect(run.trust.problems).toEqual(['the verification is not trusted: suite_pinned']);
    expect(runVerdict({ record: run, verification: { ...verification, trusted: true, trust: { ...verification.trust, suite_pinned: true } } })).toMatchObject({ verdict: 'verified', trust: { ok: true, problems: [] }, delivery: { ok: true, failures: [] } });
  }, 7_200_000);
});
