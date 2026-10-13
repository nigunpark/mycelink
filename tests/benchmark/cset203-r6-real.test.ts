/**
 * CSET-203 r6 shape, model-free, on the real Changesets source, through the
 * with arm under the real boundary (WSL/Linux with bubblewrap and the
 * prepared cache; opt-in with MYCELINK_BENCH_REAL_CSET=1, an hour or more).
 *
 * r6 with-normal: R001's AC-1, AC-3 and AC-5 gaps were valid hypotheses and
 * both producers were reworked. apply-release-plan's rework worker wrote the
 * reviewer's exact AC-1 reproductions as focused tests — a CHANGELOG.md the
 * run created removed when a later package.json write fails; in pre mode a
 * failed changeset rename restoring the changesets and removing the pre
 * directory — and the red gate ran them on the unchanged integrated head:
 * they passed. The worker answered BLOCKED REVIEW_GAP_NOT_REPRODUCED:AC-1,
 * the node was parked, and the run failed with no candidate. Here, with r2's
 * own commits as the first submissions (every hidden check but AC-1's
 * changelog passes on them), through the sealed plugin's loop:
 *
 *  - R001 finds AC-1 with r6's exact reproduction, AC-3 and AC-5;
 *  - apply-release-plan's worker writes r6's two focused tests, the red gate
 *    passes them, and it challenges the gap (REVIEW_GAP_CHALLENGE): no
 *    attempt charged, the node DONE again, R001 CHALLENGED;
 *  - the session exits 0 there, the feature incomplete; the with arm
 *    continues it with a fresh session (feature status: review-refine);
 *  - a fresh reviewer REFINEs AC-1 to the boundary hidden acceptance checks
 *    (pkg-b's CHANGELOG.md a directory, so its write fails after the package
 *    versions were written; exact rollback); its focused RED fails on r2's
 *    code and the fix settles DONE;
 *  - the cli's own rework (AC-3's RED, AC-5's compatibility unit); the
 *    compatibility node; R002 PASS; C001 delivered;
 *  - the independent verifier accepts it: hidden acceptance (AC-1, AC-3,
 *    AC-5 among them), mutants and the TDD replay — the challenge's tests
 *    never integrated.
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

/** R001's AC-1 reproduction, exactly as r6's reviewer wrote it. */
const AC1_R6 =
  "In applyReleasePlan tests: (a) changelog enabled with no CHANGELOG.md, fail the package.json write of a later package; assert CHANGELOG.md is absent. (b) preState.mode 'pre' with no .changeset/pre dir, fail fs.rename/rm of a changeset; assert .changeset/pre is gone, changesets back byte-exact, no dot journal, error.cause is the injected error.";
const AC3_REPRODUCTION = 'leave a journal that parses but records no entries ({}) in .changeset beside a changeset, run changeset version, and assert it resolves, warns interrupted, removes the journal and versions once';
const AC5_REPRODUCTION = 'put .changeset/.apply-release-plan.journal beside a changeset, run status, and assert the same release object as without it, the journal untouched';
/** The refinement: the boundary hidden acceptance checks. */
const AC1_REFINED = 'make packages/pkg-b/CHANGELOG.md a directory holding a file, so the changelog write fails after both package versions were written; assert every file and directory is exactly as before (the directory and its file kept), and that the rejection carries the failure as its cause';

const CREATED = 'removes a CHANGELOG.md it created when a later write fails';
const PRE = 'removes the pre dir it created and restores changesets when consuming fails';
/** r6's worker's two focused tests, self-contained beside r2's tests: the reviewer's exact reproductions. */
const CHALLENGE_TESTS = 'packages/apply-release-plan/src/rollback-challenge.test.ts';
const CHALLENGE_FILE = `import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { testdir } from "@changesets/test-utils";
import type { Config, ReleasePlan } from "@changesets/types";
import { getPackages } from "@manypkg/get-packages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyReleasePlan } from "./index.ts";

const config: Config = {
  changelog: false,
  commit: false,
  fixed: [],
  linked: [],
  access: "restricted",
  changedFilePatterns: ["**"],
  baseBranch: "main",
  updateInternalDependencies: "patch",
  ignore: [],
  format: false,
  privatePackages: { version: true, tag: false },
  snapshot: { useCalculatedVersion: false, prereleaseTemplate: null },
  ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: {
    onlyUpdatePeerDependentsWhenOutOfRange: false,
    updateInternalDependents: "out-of-range",
  },
};

const plan: ReleasePlan = {
  changesets: [
    {
      id: "quick-lions-devour",
      summary: "hi",
      releases: [
        { name: "pkg-a", type: "minor" },
        { name: "pkg-b", type: "minor" },
      ],
    },
  ],
  releases: ["pkg-a", "pkg-b"].map((name) => ({
    name,
    type: "minor" as const,
    oldVersion: "1.0.0",
    newVersion: "1.1.0",
    changesets: ["quick-lions-devour"],
  })),
  preState: {
    mode: "exit",
    initialVersions: {},
    changesets: [],
    tag: "next",
  },
};

const pkgJson = (name: string) =>
  JSON.stringify({ name, version: "1.0.0" }, null, 2);

async function setup() {
  const dir = await testdir({
    "package.json": JSON.stringify({
      private: true,
      workspaces: ["packages/*"],
    }),
    "package-lock.json": "",
    "packages/pkg-a/package.json": pkgJson("pkg-a"),
    "packages/pkg-b/package.json": pkgJson("pkg-b"),
    ".changeset/pre.json": '{"mode":"exit"}',
    ".changeset/quick-lions-devour.md": "---\\n---\\n\\nhi\\n",
  });
  return { dir, packages: await getPackages(dir) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyReleasePlan rollback of created and consumed paths", () => {
  it("${CREATED}", async () => {
    const { dir, packages } = await setup();
    const boom = new Error("disk exploded");
    const real = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: any[]) => {
      if (String(args[0]).endsWith(path.join("pkg-b", "package.json"))) {
        throw boom;
      }
      return (real as any)(...args);
    });

    const error = await applyReleasePlan(
      plan,
      packages,
      {
        ...config,
        changelog: [
          path.resolve(import.meta.dirname, "test-utils/simple-functions.ts"),
          null,
        ],
      },
      undefined,
    ).then(
      () => undefined,
      (e) => e,
    );
    vi.restoreAllMocks();

    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(boom);
    expect(existsSync(path.join(dir, "packages/pkg-a/CHANGELOG.md"))).toBe(
      false,
    );
    expect(existsSync(path.join(dir, "packages/pkg-b/CHANGELOG.md"))).toBe(
      false,
    );
  });

  it("${PRE}", async () => {
    const { dir, packages } = await setup();
    await fs.rm(path.join(dir, ".changeset/pre.json"));
    const csPath = path.join(dir, ".changeset/quick-lions-devour.md");
    const before = await fs.readFile(csPath);
    const pkgBefore = await fs.readFile(
      path.join(dir, "packages/pkg-a/package.json"),
    );
    const boom = new Error("rename exploded");
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      throw boom;
    });

    const error = await applyReleasePlan(
      {
        ...plan,
        preState: {
          mode: "pre",
          initialVersions: {},
          changesets: [],
          tag: "next",
        },
      },
      packages,
      config,
    ).then(
      () => undefined,
      (e) => e,
    );
    vi.restoreAllMocks();

    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(boom);
    expect(existsSync(path.join(dir, ".changeset/pre"))).toBe(false);
    expect((await fs.readFile(csPath)).equals(before)).toBe(true);
    expect(
      (await fs.readFile(path.join(dir, "packages/pkg-a/package.json"))).equals(
        pkgBefore,
      ),
    ).toBe(true);
    const left = await fs.readdir(path.join(dir, ".changeset"));
    expect(left.filter((n) => n.startsWith("."))).toEqual([]);
  });
});
`;
const SIMPLE_FUNCTIONS = `// plugin, must have a default export
/* eslint-disable import-lite/no-default-export */

import type { ChangelogFunctions } from "@changesets/types";

export default {
  getReleaseLine: async () => "- a line",
  getDependencyReleaseLine: async () => "- a dep line",
} satisfies ChangelogFunctions;
`;

/** AC-1's refined focused RED, as the r3/r4-shape runs write it: pkg-b's changelog is a directory, so its write fails after the package versions. */
const FOCUSED = 'restores every file exactly when the changelog cannot be written after the package versions were written';
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

/** r6's plan on the real source: r2's commits first, R001 (AC-1 r6's, AC-3, AC-5), the challenge, the refinement, the reworks. */
function r6Plan(dir: string, log: string): Record<string, any> {
  const patch = (name: string): string => {
    const to = join(dir, name);
    copyFileSync(join(REPO_ROOT, 'tests', 'benchmark', 'fixtures', 'cset203-r2', name), to);
    return to;
  };
  return {
    log,
    exitAfterChallenge: true,
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
        'AC-1': { missing: 'Rollback of created files, created directories and consumed (removed/renamed) changesets is never exercised; changelog:false and non-pre mode in the only test mean createdDirs and null-content restore paths have no assertion.', reproduction: AC1_R6, producer: { module: `changesets:${ARP_SRC}` } },
        'AC-3': { missing: 'recovery is tested with a complete journal and an unparseable one only; a journal that parses but records no entries (cut short at a JSON boundary) is never recovered from', reproduction: AC3_REPRODUCTION, producer: { node_id: CLI } },
        'AC-5': { missing: 'no regression evidence runs changeset status with a journal file present in .changeset', reproduction: AC5_REPRODUCTION, producer: { node_id: COMPAT } },
      },
    },
    challenge: {
      'apply-release-plan': {
        tests: { [CHALLENGE_TESTS]: CHALLENGE_FILE, 'packages/apply-release-plan/src/test-utils/simple-functions.ts': SIMPLE_FUNCTIONS },
        tests_named: [CREATED, PRE],
        clauses: [
          { clause: 'AC-1.1', test: CREATED, needles: ['expect(existsSync(path.join(dir, "packages/pkg-a/CHANGELOG.md"))).toBe('], trace: 'the CHANGELOG.md the run created is absent after the injected package.json write failure of a later package' },
          { clause: 'AC-1.2', test: CREATED, needles: ['expect(error.cause).toBe(boom);'], trace: 'the rejection cause is the injected write failure itself' },
        ],
        explanation: "R001's exact reproductions (a) and (b), written as focused tests, pass on the unchanged integrated head: the rollback already removes a CHANGELOG.md the run created and the pre directory it created, and restores consumed changesets byte for byte.",
      },
    },
    refinements: {
      'CSET-203-R001': { 'AC-1': { decision: 'REFINE', gap: { missing: 'a changelog that cannot be written (a directory stands where it goes) after the package versions were written is never exercised: the rollback may remove what stood there', reproduction: AC1_REFINED }, producer: { module: `changesets:${ARP_SRC}` } } },
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
}

describe.runIf(REAL)('CSET-203 r6 shape, model-free, on the real Changesets source', () => {
  it("R001's AC-1 reproduction passes on r2's code: challenged, not BLOCKED; a fresh session's reviewer refines it to the hidden boundary; RED, fix, the cli rework, R002 PASS, C001 accepted by the verifier", async () => {
    const dir = makeTmpDir('cset203-r6-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const plan = r6Plan(dir, log);
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-203',
      arm: 'with',
      faultPlan: null,
      outDir: join(makeTmpDir('cset203-r6-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset203-host.mjs')],
      pollMs: 1000,
      env: { FAKE_CLAUDE_PLAN: planFile },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      requireTdd: true,
    });
    const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const report = JSON.stringify(seen.filter((e) => e.error || e.settled || e.delivery || e.review || e.controller || e.challenged || e.exit), null, 1).slice(0, 8000);
    expect(seen.filter((e) => e.error), report).toEqual([]);
    // The session exits after the challenge, as r4's corrective did; the with arm continues it, told what comes next.
    expect(seen.filter((e) => e.exit).map((e) => e.exit)).toEqual([{ after: 'challenge', next_action: 'review-refine', resumable: true }]);
    expect(run.sessions.map((x: any) => [x.index, x.purpose, x.ended_by, x.continuation ?? false])).toEqual([[1, 'task', 'exit', false], [2, 'resume', 'exit', true]]);
    expect(run.continuations).toEqual([expect.objectContaining({ after_session: 1, session: 2, outcome: 'resumed', next_action: expect.objectContaining({ kind: 'review-refine', resumable: true }) })]);
    expect(run.faults).toEqual([]);
    // R001 GAPS; its AC-1 challenged and refined; R002 PASS.
    expect(seen.filter((e) => e.review).map((e) => [e.review.review_id, e.review.outcome, e.review.refinement])).toEqual([
      ['CSET-203-R001', 'GAPS', null],
      ['CSET-203-R001', 'GAPS', [['AC-1', 'REFINE']]],
      ['CSET-203-R002', 'PASS', null],
    ]);
    const order = seen.filter((e) => e.settled || e.review || e.controller || e.challenged).map((e) => (e.challenged ? `challenged ${e.challenged.node}` : e.settled ? `settle ${e.settled.node}` : e.review ? `review ${e.review.outcome}` : `controller ${e.controller.node}`));
    expect(order).toEqual([`settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review GAPS', `settle ${ARP}`, `challenged ${ARP}`, 'review GAPS', `settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review PASS', `controller ${CANDIDATE}`]);
    const workers = seen.filter((e) => e.worker).map((e) => e.worker);
    expect(workers[2]).toMatchObject({ node: ARP, challenge: true, red: { passing: true }, check: { ok: true }, outcome: 'REVIEW_GAP_CHALLENGE' });
    expect(workers[3]).toMatchObject({ node: ARP, rework: { acceptance_criteria: ['AC-1'], origin: { review_id: 'CSET-203-R001', refinement: { challenge_id: 'CSET-203-R001-C1', round: 1 } } } });
    expect(workers[3].rework.reason).toContain(AC1_REFINED);
    expect(workers[3].red_tests.find((t: any) => t.name.endsWith(FOCUSED))).toMatchObject({ status: 'failed' });
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([{ status: 'ACCEPTED', candidate_id: 'CSET-203-C001' }]);
    const control = join(run.workspace, 'platform');
    const state = JSON.parse(readFileSync(join(control, 'features', 'CSET-203', 'STATE.json'), 'utf8')).data;
    expect(state.acceptance_review).toMatchObject({ required: true, blocked: null, usage: { sessions: 3 } });
    expect(state.acceptance_review.challenges.map((c: any) => [c.challenge_id, c.node_id, c.status])).toEqual([['CSET-203-R001-C1', ARP, 'refined']]);
    expect(state.acceptance_review.reviews.map((r: any) => [r.review_id, r.outcome])).toEqual([['CSET-203-R001', 'GAPS'], ['CSET-203-R002', 'PASS']]);
    // The reviewers' records: the refinement summarised apart, with its decisions.
    expect(run.reviewers.map((r: any) => [r.review_id, r.refinement ?? null, r.settlement?.outcome])).toEqual([['CSET-203-R001', null, 'GAPS'], ['CSET-203-R001', 1, 'GAPS'], ['CSET-203-R002', null, 'PASS']]);
    // The verdict: hidden acceptance, mutants and the TDD replay; the challenge's tests never delivered.
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    expect(verification.sections.tdd.units.every((u: { ok: boolean }) => u.ok)).toBe(true);
    expect(run.verified).toBe(true);
  }, 7_200_000);
});

/**
 * CSET-203 r8 shape on the same source and loop: every reviewer's verdict
 * reaches the controller its own way, through the sealed plugin's ingest
 * line before each settle line. R001's first reviewer writes and answers the
 * same verdict with AC-5 as r8's (a compatibility GAP naming no clause no test
 * covers): refused for its form, corrected. The correction's reviewer
 * answers its corrected verdict and writes nothing (r8's): ingested from
 * Claude Code's records, GAPS, no further correction. The refinement — in
 * the continuation session, a session of its own — answers in one ```json
 * fence and writes nothing; R002 writes its PASS and answers only that it
 * did. C001 is delivered and the verifier accepts it; the run record names
 * each reviewer's transport and the hashes of its answer and transcript.
 */
describe.runIf(REAL)('CSET-203 r8 shape, model-free, on the real Changesets source', () => {
  it("R001 refused for AC-5's trace, its correction answered without a Write and ingested; the refinement answered in a fence in the continuation; R002 written; C001 accepted by the verifier", async () => {
    const dir = makeTmpDir('cset203-r8-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const base = r6Plan(dir, log);
    const plan = {
      ...base,
      reviewTransport: { 'CSET-203-R001': ['both', 'agent-result', 'fenced'], 'CSET-203-R002': ['file'] },
      reviewFirst: { 'CSET-203-R001': { 'AC-5': { ...base.reviewGaps['CSET-203-R001']['AC-5'], untested: [] } } },
    };
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-203',
      arm: 'with',
      faultPlan: null,
      outDir: join(makeTmpDir('cset203-r8-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset203-host.mjs')],
      pollMs: 1000,
      env: { FAKE_CLAUDE_PLAN: planFile },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      requireTdd: true,
    });
    const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const report = JSON.stringify(seen.filter((e) => e.error || e.settled || e.delivery || e.review || e.controller || e.challenged || e.exit), null, 1).slice(0, 8000);
    expect(seen.filter((e) => e.error), report).toEqual([]);
    expect(seen.filter((e) => e.exit).map((e) => e.exit)).toEqual([{ after: 'challenge', next_action: 'review-refine', resumable: true }]);
    expect(run.sessions.map((x: any) => [x.index, x.purpose, x.ended_by])).toEqual([[1, 'task', 'exit'], [2, 'resume', 'exit']]);
    // Each reviewer's verdict, the way it came.
    expect(seen.filter((e) => e.review).map((e) => [e.review.review_id, e.review.transport, e.review.ingest, e.review.outcome, e.review.code, e.review.correction, e.review.refinement !== null])).toEqual([
      ['CSET-203-R001', 'both', 'WRITTEN', 'REVIEW_INVALID', 'REVIEW_TRACE_INCOMPLETE', null, false],
      ['CSET-203-R001', 'agent-result', 'INGESTED', 'GAPS', null, 1, false],
      ['CSET-203-R001', 'fenced', 'INGESTED', 'GAPS', null, null, true],
      ['CSET-203-R002', 'file', 'WRITTEN', 'PASS', null, null, false],
    ]);
    const order = seen.filter((e) => e.settled || e.review || e.controller || e.challenged).map((e) => (e.challenged ? `challenged ${e.challenged.node}` : e.settled ? `settle ${e.settled.node}` : e.review ? `review ${e.review.outcome}` : `controller ${e.controller.node}`));
    expect(order).toEqual([`settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review REVIEW_INVALID', 'review GAPS', `settle ${ARP}`, `challenged ${ARP}`, 'review GAPS', `settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review PASS', `controller ${CANDIDATE}`]);
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([{ status: 'ACCEPTED', candidate_id: 'CSET-203-C001' }]);
    const control = join(run.workspace, 'platform');
    const state = JSON.parse(readFileSync(join(control, 'features', 'CSET-203', 'STATE.json'), 'utf8')).data;
    expect(state.acceptance_review).toMatchObject({ required: true, blocked: null, usage: { sessions: 4 } });
    expect(state.acceptance_review.reviews.map((r: any) => [r.review_id, r.outcome])).toEqual([['CSET-203-R001', 'GAPS'], ['CSET-203-R002', 'PASS']]);
    // The run record: each reviewer, its transport, its answer's and transcript's hashes; the answers scanned like every tool call.
    expect(run.reviewers.map((r: any) => [r.review_id, r.transport, r.settlement?.outcome, r.answer])).toEqual([
      ['CSET-203-R001', 'both', 'REVIEW_INVALID', 'json'],
      ['CSET-203-R001', 'agent-result', 'GAPS', 'json'],
      ['CSET-203-R001', 'agent-result', 'GAPS', 'fenced-json'],
      ['CSET-203-R002', 'file', 'PASS', 'prose'],
    ]);
    for (const r of run.reviewers) expect(r, r.dispatch_id).toMatchObject({ agent_id: expect.stringMatching(/^a[0-9a-f]{16}$/), result_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), transcript_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(run.workers.every((w: any) => w.node_id !== null)).toBe(true);
    // The evaluator scan read every transcript, the reviewers' final answers included: nothing reached it.
    expect(run.evaluator_access.hits).toEqual([]);
    expect(run.plugin_exposure).toEqual([]);
    expect(run.trust.problems.filter((p: string) => !/suite_pinned/.test(p))).toEqual([]);
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    expect(run.verified).toBe(true);
  }, 7_200_000);
});

/**
 * CSET-203 r10 shape on the same source and loop, in one task session as r10
 * ran: the first submissions, R001 GAPS, the challenge, the refinement, and
 * apply-release-plan's rework settle; then the cli's rework is dispatched
 * (its second ticket) and the controller's very next request is refused by
 * the provider (`reasoning_extraction`), recorded by Claude Code in the
 * stream and the session's transcript; the session exits 1 with the claim
 * live. The harness has Mycelink reconcile it from that transcript — the
 * lease interrupted-provider, the claim back READY, nothing charged — and a
 * fresh resume session, told so, presents the old ticket late (stale), has a
 * fresh worker do the cli's rework, and goes on through the compatibility
 * node and R002 to C001, which the verifier accepts.
 */
describe.runIf(REAL)('CSET-203 r10 shape, model-free, on the real Changesets source', () => {
  it("the controller refused right after the cli's rework ticket: exit 1, reconciled, resumed by a fresh session to C001; nothing charged; the old ticket stale; the run trusted and verified", async () => {
    const dir = makeTmpDir('cset203-r10-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const plan = { ...r6Plan(dir, log), exitAfterChallenge: false, providerRefusal: { module: 'cli', dispatch: 2 } };
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-203',
      arm: 'with',
      faultPlan: null,
      outDir: join(makeTmpDir('cset203-r10-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset203-host.mjs')],
      pollMs: 1000,
      env: { FAKE_CLAUDE_PLAN: planFile },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      requireTdd: true,
    });
    const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const report = JSON.stringify(seen.filter((e) => e.error || e.settled || e.delivery || e.review || e.controller || e.challenged || e.refused || e.late), null, 1).slice(0, 8000);
    expect(seen.filter((e) => e.error), report).toEqual([]);
    expect(seen.filter((e) => e.refused).map((e) => e.refused.node)).toEqual([CLI]);
    expect(run.sessions.map((x: any) => [x.index, x.purpose, x.ended_by, x.exit_code, x.resumes ?? null, x.provider_recovery ?? false])).toEqual([
      [1, 'task', 'exit', 1, null, false],
      [2, 'resume', 'exit', 0, 1, true],
    ]);
    expect(run.sessions[0].provider_failure).toMatchObject({ class: 'provider-refusal', transient: true, category: 'reasoning_extraction' });
    expect(run.continuations).toEqual([]);
    expect(run.faults).toEqual([]);
    expect(run.provider_recoveries).toEqual([expect.objectContaining({ phase: 'task', session: 1, resumed_by: 2, outcome: 'resumed', reconciled: expect.objectContaining({ outcome: 'RECONCILED', interrupted: [expect.objectContaining({ kind: 'worker', node_id: CLI, action: 'released', class: 'provider-refusal', source: 'host-transcript', count: { ticket: 1, phase: 1 } })] }) })]);
    expect(seen.filter((e) => e.late).map((e) => [e.late.node, e.late.outcome])).toEqual([[CLI, 'STALE_ORCHESTRATION_EPOCH']]);
    const order = seen.filter((e) => e.settled || e.review || e.controller || e.challenged).map((e) => (e.challenged ? `challenged ${e.challenged.node}` : e.settled ? `settle ${e.settled.node}` : e.review ? `review ${e.review.outcome}` : `controller ${e.controller.node}`));
    expect(order).toEqual([`settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review GAPS', `settle ${ARP}`, `challenged ${ARP}`, 'review GAPS', `settle ${ARP}`, `settle ${CLI}`, `controller ${COMPAT}`, 'review PASS', `controller ${CANDIDATE}`]);
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([{ status: 'ACCEPTED', candidate_id: 'CSET-203-C001' }]);
    const state = JSON.parse(readFileSync(join(run.workspace, 'platform', 'features', 'CSET-203', 'STATE.json'), 'utf8')).data;
    // Nothing charged: the cli's rework took one attempt of its generation, no interruption, no failure.
    expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', failure_counts: {} });
    expect(state.nodes[CLI].interruptions ?? 0).toBe(0);
    expect(state.orchestration.leases.filter((l: any) => l.status === 'interrupted-provider').map((l: any) => [l.node_id, l.provider.class, l.provider.source])).toEqual([[CLI, 'provider-refusal', 'host-transcript']]);
    expect(state.orchestration.provider).toMatchObject({ unavailable: null, phases: { task: 1 } });
    expect(run.controller).toMatchObject({ ok: true, failures: [] });
    expect(run.controller.recovered).toEqual([expect.stringMatching(/^provider-interrupted: session 1 \(task\)/)]);
    expect(run.evaluator_access.hits).toEqual([]);
    expect(run.plugin_exposure).toEqual([]);
    expect(run.trust.problems.filter((p: string) => !/suite_pinned/.test(p))).toEqual([]);
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    expect(run.verified).toBe(true);
  }, 7_200_000);
});

/**
 * CSET-203 r13 shape on the same source and loop, in one task session: the
 * challenge of AC-1 as r6's, then its refinement goes to a reviewer in the
 * background that runs for more than three minutes. The host does what
 * r13's did — the ticket's ingest and settle lines together, at once — and
 * both answer that the reviewer runs, spending nothing; then the await line,
 * again while it runs. Its completion is enqueued mid-turn, as 2.1.290
 * records it: ingested, the refinement settles in the same generation, and
 * the rest goes on to C001, which the verifier accepts; the sessions' own
 * streams attest the reviewer's lifecycle.
 */
describe.runIf(REAL)('CSET-203 r13 shape, model-free, on the real Changesets source', () => {
  it('the refinement reviewer runs over three minutes: polled, never settled or re-issued while it runs; its answer taken once; C001 accepted by the verifier', async () => {
    const dir = makeTmpDir('cset203-r13-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const plan = { ...r6Plan(dir, log), exitAfterChallenge: false, slowRefinementMs: 190_000 };
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-203',
      arm: 'with',
      faultPlan: null,
      outDir: join(makeTmpDir('cset203-r13-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset203-host.mjs')],
      pollMs: 1000,
      env: { FAKE_CLAUDE_PLAN: planFile },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      requireTdd: true,
    });
    const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const report = JSON.stringify(seen.filter((e) => e.error || e.review || e.slow_reviewer || e.delivery), null, 1).slice(0, 8000);
    expect(seen.filter((e) => e.error), report).toEqual([]);
    const slow = seen.filter((e) => e.slow_reviewer).map((e) => e.slow_reviewer);
    expect(slow, report).toHaveLength(1);
    expect(slow[0].early).toEqual({ ingest: 'REVIEWER_RUNNING', settle: 'REVIEWER_RUNNING', lifecycle: 'RUNNING' });
    const awaits = slow[0].awaits as { state: string; elapsed_ms: number }[];
    expect(awaits.slice(0, -1).every((a) => a.state === 'RUNNING')).toBe(true);
    expect(awaits.at(-1)!.state).toBe('COMPLETED');
    expect(Math.max(...awaits.map((a) => a.elapsed_ms ?? 0))).toBeGreaterThan(180_000);
    const reviews = seen.filter((e) => e.review).map((e) => e.review);
    expect(reviews.map((r: any) => [r.review_id, r.refinement !== null, r.ingest, r.outcome])).toEqual([
      ['CSET-203-R001', false, 'WRITTEN', 'GAPS'],
      ['CSET-203-R001', true, 'INGESTED', 'GAPS'],
      ['CSET-203-R002', false, 'WRITTEN', 'PASS'],
    ]);
    expect(reviews[1].dispatch_id).toBe(slow[0].dispatch_id);
    expect(seen.filter((e) => e.delivery).map((e) => e.delivery)).toEqual([{ status: 'ACCEPTED', candidate_id: 'CSET-203-C001' }]);
    const events = readFileSync(join(run.workspace, 'platform', 'features', 'CSET-203', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(events.filter((e: any) => e.type === 'review.refused' || e.type === 'review.reissued' || e.type === 'review.reviewer_interrupted')).toEqual([]);
    expect(run.reviewer_lifecycle).toMatchObject({ streamed: true, tasks: [expect.objectContaining({ status: 'completed' })], ingested: [expect.objectContaining({ outcome: 'INGESTED' })], interrupted: [] });
    expect(run.sessions).toHaveLength(1);
    expect(run.trust.problems.filter((p: string) => !/suite_pinned/.test(p))).toEqual([]);
    const verification = JSON.parse(readFileSync(run.verification, 'utf8'));
    const failing = Object.entries(verification.sections ?? {}).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}: ${String(c.detail).slice(0, 300)}`));
    expect(failing, JSON.stringify(verification.errors ?? [])).toEqual([]);
    expect(run.verified).toBe(true);
  }, 7_200_000);
});
