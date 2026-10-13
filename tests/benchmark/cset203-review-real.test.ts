/**
 * CSET-203 r3 shape, model-free, on the real Changesets source, through the
 * with arm under the real boundary (WSL/Linux with bubblewrap and the
 * prepared cache; opt-in with MYCELINK_BENCH_REAL_CSET=1, an hour or more).
 *
 * r2: both with arms matched and trusted, every node strict-TDD DONE,
 * C001/C002 delivered, the controller clean — and both failed exactly one
 * hidden check, AC-1 "when a changelog cannot be written, every file is
 * restored". Here the workers' first submissions are r2's own commits
 * (fixtures/cset203-r2): apply-release-plan's rollback tested only where a
 * package.json write fails, its journal recording a path it cannot read as
 * a file as absent. Then, through the sealed plugin's loop:
 *
 *  - every product node and the compatibility verification node DONE, the
 *    acceptance review is handed out before any candidate; the stand-in
 *    reviewer answers GAP on AC-1 with the public reproduction "inject
 *    changelog writer failure after package/version writes and assert exact
 *    rollback";
 *  - settle reworks apply-release-plan (the graph's producer of AC-1) with
 *    that reason; its fresh worker writes the focused RED (pkg-b's changelog
 *    path is a directory, so the write fails after the package versions
 *    were written; the tree must be exactly as before), the red gate fails
 *    it on r2's code, then the fix; AC-2 keeps its proof; the cli re-proves
 *    GREEN; the compatibility node runs again;
 *  - the review runs again and passes; only then the candidate, delivered;
 *  - the independent verifier accepts it: hidden acceptance (the changelog
 *    check included), mutants, the TDD replay of every cycle.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { ISOLATED, TEST_ISOLATION } from './isolation-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { resolveCacheRoot } from '../../evals-public-projects/lib/toolchain.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { runArm } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const cacheRoot = resolveCacheRoot();
const REAL = ISOLATED && process.env['MYCELINK_BENCH_REAL_CSET'] === '1' && existsSync(join(cacheRoot, 'toolchains.json')) && existsSync(join(cacheRoot, 'pnpm', 'changesets'));

const ARP = 'CSET-203.changesets.apply-release-plan.crash-safe';
const CLI = 'CSET-203.changesets.cli.version-recovery';
const COMPAT = 'CSET-203.changesets.compat.regression';
const CANDIDATE = 'CSET-203.candidate.build';
const ARP_TESTS = 'packages/apply-release-plan/src/index.test.ts';
const ARP_SRC = 'packages/apply-release-plan/src/index.ts';
const VERSION_TESTS = 'packages/cli/src/commands/version/version.test.ts';
const PUBLIC_REASON = 'inject changelog writer failure after package/version writes and assert exact rollback';
const FOCUSED = 'restores every file exactly when the changelog cannot be written after the package versions were written';

/** The focused RED the reworked worker writes from the review's gap, in r2's own test style (a directory where a file is written). */
const FOCUSED_RED = `
    it("${FOCUSED}", async () => {
      const { releasePlan, tempDir, packages } = await setupTwoPackages();
      // pkg-b is applied after pkg-a: its changelog is a directory, so the changelog writer
      // fails once pkg-a's files and pkg-b's package.json were written.
      await fs.mkdir(path.join(tempDir, "packages/pkg-b/CHANGELOG.md"));
      await fs.writeFile(path.join(tempDir, "packages/pkg-b/CHANGELOG.md/keep"), "");
      const tree = async (rel = "", out: Record<string, string> = {}) => {
        for (const entry of await fs.readdir(path.join(tempDir, rel), { withFileTypes: true })) {
          const p = path.join(rel, entry.name);
          if (entry.isDirectory()) {
            out[\`\${p}/\`] = "";
            await tree(p, out);
          } else out[p] = (await fs.readFile(path.join(tempDir, p))).toString("base64");
        }
        return out;
      };
      const before = await tree();
      let error: unknown;
      try {
        await applyReleasePlan(releasePlan.getReleasePlan(), packages, {
          ...releasePlan.config,
          changelog: [changesetsCliChangelogPath, null],
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect(await tree()).toEqual(before);
    });
`;

/** The repair: a directory standing where a file is written is no file the run changes; a rollback leaves it as it is. */
const FIX_FIND = '      if (err?.code !== "ENOENT" && err?.code !== "EISDIR") throw err;\n      entries.push({ path: p, content: null });';
const FIX_REPLACE = '      // A directory stands where a file was to be written: the write fails, and a rollback leaves it as it is.\n      if (err?.code === "EISDIR") continue;\n      if (err?.code !== "ENOENT") throw err;\n      entries.push({ path: p, content: null });';

describe.runIf(REAL)('CSET-203 r3 shape, model-free, on the real Changesets source', () => {
  it("r2's workers' code, the review's GAP on AC-1's changelog boundary, the producer's focused RED and fix, the review's PASS, C001 accepted by the verifier", async () => {
    const dir = makeTmpDir('cset203-review-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    // r2's commits, where the sandboxed session can read them.
    const patch = (name: string): string => {
      const to = join(dir, name);
      copyFileSync(join(REPO_ROOT, 'tests', 'benchmark', 'fixtures', 'cset203-r2', name), to);
      return to;
    };
    const plan = {
      log,
      modules: {
        'apply-release-plan': {
          cycles: [{ testPatch: patch('1-9d29583.patch'), implPatch: patch('2-71f62c6.patch'), testMessage: 'test: rollback and journal for applyReleasePlan', implMessage: 'feat: journal and roll back applyReleasePlan' }],
          criteria: [
            { criterion: 'AC-1', path: ARP_TESTS, name: 'restores files and rejects with the original error as cause', gate: 'red', cycle: 0 },
            { criterion: 'AC-2', path: ARP_TESTS, name: 'writes a dot-prefixed journal in .changeset before the first change and removes it after success', gate: 'red', cycle: 0 },
          ],
        },
        cli: {
          cycles: [{ testPatch: [patch('3-d98563d.patch'), patch('5-77e69f4.patch')], implPatch: [patch('4-b57676d.patch'), patch('6-2d42e5f.patch')], testMessage: 'test(cli): version recovers from journal and fails cleanly', implMessage: 'feat(cli): recover interrupted version runs and fail cleanly' }],
          criteria: [
            { criterion: 'AC-3', path: VERSION_TESTS, name: 'restores an interrupted run from its journal, warns, and versions once', gate: 'red', cycle: 0 },
            { criterion: 'AC-4', path: VERSION_TESTS, name: 'prints the failure without a stack, exits 1 and does not commit', gate: 'red', cycle: 0 },
            { criterion: 'AC-5', path: VERSION_TESTS, name: 'should git add the expected files if commit config is set', gate: 'green' },
          ],
        },
      },
      reviewGaps: {
        'CSET-203-R001': {
          'AC-1': {
            missing: 'rollback is tested only where a package.json write fails; no test makes the changelog write fail after the package/version writes, where every file must still come back to its exact previous bytes or absence',
            reproduction: PUBLIC_REASON,
            producer: { node_id: ARP, module: 'changesets:packages/apply-release-plan' },
          },
        },
      },
      rework: {
        'apply-release-plan': {
          cycles: [{ testEdits: [{ path: ARP_TESTS, find: '  });\n});\n', replace: `${FOCUSED_RED}  });\n});\n`, last: true }], implEdits: [{ path: ARP_SRC, find: FIX_FIND, replace: FIX_REPLACE }], testMessage: 'test(apply-release-plan): AC-1 a changelog that cannot be written is rolled back exactly', implMessage: 'fix(apply-release-plan): a directory where a file is written is left as it is' }],
          criteria: [{ criterion: 'AC-1', path: ARP_TESTS, name: FOCUSED, gate: 'red', cycle: 0 }],
        },
      },
    };
    // The cli, reopened by the upstream rework, re-proves GREEN with its kept RED: its first submission's criteria.
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-203',
      arm: 'with',
      faultPlan: null,
      outDir: join(makeTmpDir('cset203-review-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset203-host.mjs')],
      pollMs: 1000,
      env: { FAKE_CLAUDE_PLAN: planFile },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      requireTdd: true,
    });
    const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const report = JSON.stringify(seen.filter((e) => e.error || e.settled || e.delivery || e.review || e.controller), null, 1).slice(0, 8000);
    expect(seen.filter((e) => e.error), report).toEqual([]);
    expect(run.sessions.map((x: any) => [x.index, x.purpose, x.ended_by])).toEqual([[1, 'task', 'exit']]);
    // The reviews: R001 found AC-1's changelog boundary untested before any candidate, R002 passed the repair.
    expect(seen.filter((e) => e.review).map((e) => [e.review.review_id, e.review.outcome, e.review.reworked])).toEqual([
      ['CSET-203-R001', 'GAPS', [ARP]],
      ['CSET-203-R002', 'PASS', []],
    ]);
    // The order: producers, compatibility, review GAP, the reworked producer, the re-verified cli, compatibility, review PASS, candidate.
    const order = seen.filter((e) => e.settled || e.review || e.controller).map((e) => (e.settled ? `settle ${e.settled.node}` : e.review ? `review ${e.review.outcome}` : `controller ${e.controller.node}`));
    expect(order).toEqual([`settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review GAPS', `settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review PASS', `controller ${CANDIDATE}`]);
    const workers = seen.filter((e) => e.worker).map((e) => e.worker);
    expect(workers.map((w: any) => w.node)).toEqual([ARP, CLI, ARP, CLI]);
    // The reworked worker got the gap verbatim, proved it with a RED its code failed, and kept AC-2's proof.
    expect(workers[2].rework).toMatchObject({ acceptance_criteria: ['AC-1'], origin: { kind: 'acceptance-review', review_id: 'CSET-203-R001' }, carried: ['AC-2'] });
    expect(workers[2].rework.reason).toContain(PUBLIC_REASON);
    expect(workers[2].red_tests.find((t: any) => t.name.endsWith(FOCUSED))).toMatchObject({ status: 'failed' });
    expect(workers[3].gates.map((g: any) => g.gate)).toEqual(['green', 'regression']);
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([{ status: 'ACCEPTED', candidate_id: 'CSET-203-C001' }]);
    const control = join(run.workspace, 'platform');
    const state = JSON.parse(readFileSync(join(control, 'features', 'CSET-203', 'STATE.json'), 'utf8')).data;
    expect(state.acceptance_review).toMatchObject({ required: true, blocked: null, usage: { sessions: 2 } });
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE', criteria: expect.arrayContaining([expect.objectContaining({ criterion: 'AC-2', carried: true })]) });
    // The bench records the reviewer apart from the workers.
    expect(run.reviewers.map((r: any) => [r.review_id, r.verdict?.overall, r.settlement?.outcome])).toEqual([
      ['CSET-203-R001', 'GAPS', 'GAPS'],
      ['CSET-203-R002', 'PASS', 'PASS'],
    ]);
    expect(run.workers.every((w: any) => w.node_id !== null)).toBe(true);
    // The verdict: hidden acceptance, the changelog check included, and the TDD replay of every cycle.
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    const changelog = verification.sections.acceptance.checks.find((c: any) => /changelog cannot be written/.test(c.id));
    expect(changelog).toMatchObject({ ok: true });
    expect(run.verified).toBe(true);
  }, 7_200_000);
});
