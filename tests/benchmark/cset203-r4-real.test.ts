/**
 * CSET-203 r4 shape, model-free, on the real Changesets source, through the
 * with arm under the real boundary (WSL/Linux with bubblewrap and the
 * prepared cache; opt-in with MYCELINK_BENCH_REAL_CSET=1, an hour or more).
 *
 * r3 with-normal: every node DONE, the read-only reviewer found public GAPs
 * on AC-1, AC-3 and AC-5 before any candidate; AC-5 belonged to the
 * verification node alone, settle reworked nothing, blocked, and the
 * controller exited incomplete. Here the workers' first submissions are r2's
 * own commits (fixtures/cset203-r2: every hidden check but AC-1's changelog
 * passes on them) and the graph gives AC-5 to the cli as its producer, the
 * compatibility node proving it again. Through the sealed plugin's loop:
 *
 *  - R001 finds AC-1 (a changelog that cannot be written after the package
 *    versions were), AC-3 (a journal that parses but records no entries, cut
 *    short at a JSON boundary, crashes r2's recovery instead of being taken
 *    as cut short) and AC-5 (no test runs status beside a journal) — naming the verification node for AC-5,
 *    as r3's reviewer did;
 *  - one settle reworks apply-release-plan (AC-1) and the cli (AC-3, AC-5);
 *    the loop goes on at once;
 *  - apply-release-plan: AC-1's focused RED and fix; the cli: AC-3's focused
 *    RED and fix, then AC-5's status test alone after the code as a
 *    compatibility-regression unit (it passes on r2's code), green again;
 *  - the compatibility node runs again; R002 passes (AC-5 now on the test the
 *    gates passed); C001 is delivered;
 *  - the independent verifier accepts it: hidden acceptance, mutants, and the
 *    TDD replay, the cli's AC-5 unit replayed as compatibility-regression.
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
const VERSION_SRC = 'packages/cli/src/commands/version/index.ts';
const STATUS_TESTS = 'packages/cli/src/commands/status/__tests__/status.test.ts';

const AC1_REPRODUCTION = 'inject changelog writer failure after package/version writes and assert exact rollback';
const AC3_REPRODUCTION = 'leave a journal that parses but records no entries ({}) in .changeset beside a changeset, run changeset version, and assert it resolves, warns interrupted, removes the journal and versions once';
const AC5_REPRODUCTION = 'put .changeset/.apply-release-plan.journal beside a changeset, run status, and assert the same release object as without it, the journal untouched';

const FOCUSED = 'restores every file exactly when the changelog cannot be written after the package versions were written';
/** AC-1's focused RED, as the r3-shape run writes it: pkg-b's changelog is a directory, so its write fails after the package versions. */
const FOCUSED_RED = `
    it("${FOCUSED}", async () => {
      const { releasePlan, tempDir, packages } = await setupTwoPackages();
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
const ARP_FIND = '      if (err?.code !== "ENOENT" && err?.code !== "EISDIR") throw err;\n      entries.push({ path: p, content: null });';
const ARP_REPLACE = '      // A directory stands where a file was to be written: the write fails, and a rollback leaves it as it is.\n      if (err?.code === "EISDIR") continue;\n      if (err?.code !== "ENOENT") throw err;\n      entries.push({ path: p, content: null });';

const EMPTY = 'treats a journal that records no entries as cut short, warns, and versions once';
/** AC-3's focused RED, in r2's own test style: a journal cut short at a JSON boundary, `{}`. */
const EMPTY_RED = `
  it("${EMPTY}", async () => {
    const cwd = await testdir(files(modifiedDefaultConfig));
    await writeChangesets([changeset], cwd);
    const journalPath = path.join(cwd, ".changeset/.apply-release-plan.journal");
    await fs.writeFile(journalPath, "{}");

    const err = await version({ cwd }).then(
      () => undefined,
      (e) => e,
    );

    expect(err).toBeUndefined();
    expect(mockedLogger.warn.mock.calls.flat().join("\\n")).toContain("interrupted");
    await expect(fs.stat(journalPath)).rejects.toThrow();
    expect((await getPkgJSON("pkg-a", cwd)).version).toBe("1.1.0");
    await expect(fs.stat(path.join(cwd, ".changeset/some-id-0.md"))).rejects.toThrow();
  });
`;
const CLI_FIND = '  for (const entry of journal.entries) {\n';
const CLI_REPLACE = `  if (!journal || !Array.isArray(journal.entries)) {
    // A journal that parses but records nothing was cut short before the first change: there is nothing to restore.
    await fs.rm(journalPath, { force: true });
    log.warn(
      "A previous \`changeset version\` run was interrupted before it changed any file. Its incomplete journal has been removed.",
    );
    return;
  }
  for (const entry of journal.entries) {
`;

const COMPAT_TEST = 'is unaffected by a version journal left in .changeset';
/** AC-5's regression test, as r3's reviewer reproduced the gap: status beside a journal. r2's code passes it. */
const COMPAT_RED = `
  it("${COMPAT_TEST}", async () => {
    const cwd = await gitdir({
      "package.json": JSON.stringify({
        private: true,
        name: "root-pkg",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "",
      "packages/pkg-a/package.json": JSON.stringify({
        name: "pkg-a",
        version: "1.0.0",
      }),
      ".changeset/config.json": JSON.stringify({}),
    });
    await exec("git", ["checkout", "-b", "new-branch"], {
      nodeOptions: { cwd },
    });
    await outputFile(
      path.join(cwd, "packages/pkg-a/a.js"),
      'export default "updated a"',
    );
    await writeChangeset(
      {
        summary: "This is a summary",
        releases: [{ name: "pkg-a", type: "minor" }],
      },
      cwd,
    );
    await git.add(".", cwd);
    await git.commit("updated a", cwd);
    const without = replaceHumanIds(await status({ cwd, since: "main" }));
    const journal = path.join(cwd, ".changeset/.apply-release-plan.journal");
    await outputFile(
      journal,
      JSON.stringify({ version: 1, entries: [], createdDir: path.join(cwd, ".changeset/pre"), dirExisted: true }),
    );
    expect(replaceHumanIds(await status({ cwd, since: "main" }))).toEqual(without);
    expect(JSON.parse(await fs.readFile(journal, "utf8")).entries).toEqual([]);
  });
`;

describe.runIf(REAL)('CSET-203 r4 shape, model-free, on the real Changesets source', () => {
  it("R001's GAPs on AC-1, AC-3 and AC-5 rework both producers in one settle; AC-5 closed by a compatibility-regression unit; R002 passes; C001 accepted by the verifier", async () => {
    const dir = makeTmpDir('cset203-r4-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
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
          'AC-1': { missing: 'rollback is tested only where a package.json write fails; no test makes the changelog write fail after the package/version writes', reproduction: AC1_REPRODUCTION, producer: { node_id: ARP } },
          'AC-3': { missing: 'recovery is tested with a complete journal and an unparseable one only; a journal that parses but records no entries (cut short at a JSON boundary) is never recovered from', reproduction: AC3_REPRODUCTION, producer: { node_id: CLI } },
          // As r3's reviewer named it: the verification node that proves AC-5, which changes no code. The graph decides.
          'AC-5': { missing: 'no regression evidence runs changeset status with a journal file present in .changeset', reproduction: AC5_REPRODUCTION, producer: { node_id: COMPAT } },
        },
      },
      rework: {
        'apply-release-plan': {
          cycles: [{ testEdits: [{ path: ARP_TESTS, find: '  });\n});\n', replace: `${FOCUSED_RED}  });\n});\n`, last: true }], implEdits: [{ path: ARP_SRC, find: ARP_FIND, replace: ARP_REPLACE }], testMessage: 'test(apply-release-plan): AC-1 a changelog that cannot be written is rolled back exactly', implMessage: 'fix(apply-release-plan): a directory where a file is written is left as it is' }],
          criteria: [{ criterion: 'AC-1', path: ARP_TESTS, name: FOCUSED, gate: 'red', cycle: 0 }],
        },
        cli: {
          cycles: [{ testEdits: [{ path: VERSION_TESTS, find: '  });\n});\n', replace: `  });\n${EMPTY_RED}});\n`, last: true }], implEdits: [{ path: VERSION_SRC, find: CLI_FIND, replace: CLI_REPLACE }], testMessage: 'test(cli): AC-3 a journal that records no entries is taken as cut short', implMessage: 'fix(cli): a journal with no entries changed nothing yet; remove it' }],
          compat: { testEdits: [{ path: STATUS_TESTS, find: '  });\n});\n', replace: `  });\n${COMPAT_RED}});\n`, last: true }], message: 'test(cli): AC-5 status is unaffected by a version journal', criteria: 'AC-5' },
          criteria: [
            { criterion: 'AC-3', path: VERSION_TESTS, name: EMPTY, gate: 'red', cycle: 0 },
            { criterion: 'AC-5', path: STATUS_TESTS, name: COMPAT_TEST, gate: 'green' },
          ],
        },
      },
    };
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-203',
      arm: 'with',
      faultPlan: null,
      outDir: join(makeTmpDir('cset203-r4-run-'), 'run'),
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
    // R001: three gaps, both producers reworked in the one settle; R002 passes.
    expect(seen.filter((e) => e.review).map((e) => [e.review.review_id, e.review.outcome, e.review.reworked])).toEqual([
      ['CSET-203-R001', 'GAPS', [CLI, ARP]],
      ['CSET-203-R002', 'PASS', []],
    ]);
    const order = seen.filter((e) => e.settled || e.review || e.controller).map((e) => (e.settled ? `settle ${e.settled.node}` : e.review ? `review ${e.review.outcome}` : `controller ${e.controller.node}`));
    expect(order).toEqual([`settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review GAPS', `settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review PASS', `controller ${CANDIDATE}`]);
    const workers = seen.filter((e) => e.worker).map((e) => e.worker);
    expect(workers.map((w: any) => w.node)).toEqual([ARP, CLI, ARP, CLI]);
    expect(workers[2].rework).toMatchObject({ acceptance_criteria: ['AC-1'], carried: ['AC-2'] });
    expect(workers[3].rework).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-5'], origin: { kind: 'acceptance-review', review_id: 'CSET-203-R001' }, carried: ['AC-4'] });
    expect(workers[3].rework.reason).toContain(AC3_REPRODUCTION);
    expect(workers[3].rework.reason).toContain('Mycelink-Compatibility: AC-5');
    expect(workers[3].red_tests.find((t: any) => t.name.endsWith(EMPTY))).toMatchObject({ status: 'failed' });
    expect(workers[3].compat).toMatchObject({ criteria: 'AC-5' });
    expect(workers[3].gates.map((g: any) => g.gate)).toEqual(['red', 'green', 'green', 'regression']);
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([{ status: 'ACCEPTED', candidate_id: 'CSET-203-C001' }]);
    const control = join(run.workspace, 'platform');
    const state = JSON.parse(readFileSync(join(control, 'features', 'CSET-203', 'STATE.json'), 'utf8')).data;
    expect(state.acceptance_review).toMatchObject({ required: true, blocked: null, usage: { sessions: 2 } });
    expect(state.acceptance_review.reviews.map((r: any) => [r.review_id, r.outcome, r.reworks, r.reworks_applied])).toEqual([
      ['CSET-203-R001', 'GAPS', [CLI, ARP], true],
      ['CSET-203-R002', 'PASS', [], false],
    ]);
    expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', tdd_history: { cycles: 1, compatibility_units: 1 } });
    // The verdict: hidden acceptance and the TDD replay, the AC-5 unit as compatibility-regression.
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    const units = verification.sections.tdd.units as { verdict: string; ok: boolean; criteria?: string[] }[];
    expect(units.filter((u) => u.verdict === 'compatibility-regression')).toEqual([expect.objectContaining({ ok: true, criteria: ['AC-5'] })]);
    expect(units.every((u) => u.ok)).toBe(true);
    expect(run.verified).toBe(true);
  }, 7_200_000);
});
