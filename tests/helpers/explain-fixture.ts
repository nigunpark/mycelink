/**
 * A CSET-201-shaped portfolio, small enough for every platform: one
 * repository, `changesets`, whose release planner (assemble-release-plan)
 * records why each package is in the plan and whose `changeset status
 * --explain` (cli) prints those reasons — as Changesets' would. Tests run with
 * Node's own runner and a JUnit report.
 *
 * The feature, CSET-201 (explain why each package is in the release plan),
 * with the real run's node ids:
 *   AC-1 types (declaration)  ReleaseReason and ComprehensiveRelease.reasons
 *   AC-2 assemble (behaviour) with explain, every release keeps its reasons:
 *        one changeset reason per changeset (none included), a dependent's
 *        range exactly as written (workspace: prefix included)
 *   AC-3 cli (behaviour)      status --explain prints one line per reason
 *   AC-4 cli (compatibility)  without --explain, status is unchanged
 *
 * The planner's first generation holds two latent defects the real run's
 * reviews found one after the other: it strips a dependent's `workspace:`
 * prefix (R002) and records a changeset reason only for the first changeset
 * of a package or one that raises its bump (R003).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { main, type CliIo } from '../../src/cli/cli.js';
import { modulesOf, verifierFor, type ResolvedModule } from '../../src/engine/modules.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import type { RepositoryDecl } from '../../src/model/types.js';
import { buildHookSettings } from '../../src/workspace/hook-settings.js';
import { ensureScratchIgnored } from '../../src/workspace/workspace.js';
import { asController } from './authority.js';
import { commitAll, git, makeGitRepo } from './git-fixture.js';
import { makeTmpDir } from './tmp.js';
import type { VerdictOverride } from './review-agent.js';

export const EXP_FEATURE = 'CSET-201';
export const TYPES = `${EXP_FEATURE}.types.reason.decl`;
export const ASSEMBLE = `${EXP_FEATURE}.assemble.reasons.impl`;
export const CLI = `${EXP_FEATURE}.cli.explain.impl`;
export const COMPAT = `${EXP_FEATURE}.changesets.compat.verify`;
export const CANDIDATE = `${EXP_FEATURE}.release.candidate.build`;

export const FULL_SUITE = ['node', '--test', 'packages/*/test/**/*.test.mjs'];

export const EXP_CRITERIA = [
  { id: 'AC-1', kind: 'declaration', text: 'AC-1 types: @changesets/types exports a ReleaseReason union (changeset, dependent, fixed, linked, prerelease-exit) and ComprehensiveRelease gains an optional reasons?: ReleaseReason[]; a changeset reason is listed once per changeset that lists the package, including none; a dependent reason keeps the range exactly as written in package.json, including any workspace: prefix.' },
  { id: 'AC-2', kind: 'new-behavior', text: 'AC-2 causal recording (assemble-release-plan): with explain: true every release has a non-empty reasons array, appended at the moment the planner adds the package or changes its bump, in that order, never the same reason twice; a dependent reason names the dependency whose release caused it, also when that dependency was itself added by a group; without explain releases have no reasons property.' },
  { id: 'AC-3', kind: 'new-behavior', text: 'AC-3 CLI: changeset status --explain prints the usual list and under each package line one line per reason, in order, indented by four spaces: "    - reason: changeset .changeset/<id>.md (<bumpType>)", "    - reason: dependent of <dependency> (<dependencyType> <versionRange>) -> <bumpType>", "    - reason: fixed group [<names>] -> <bumpType>"; with --output it writes the plan JSON with each release\'s reasons.' },
  { id: 'AC-4', kind: 'compatibility', text: 'AC-4 compatibility: without --explain, everything changeset status prints and everything it writes with --output is byte-identical to today.' },
] as const;

export const TYPES_SRC = 'packages/types/src/index.d.ts';
export const ASM_SRC = 'packages/assemble-release-plan/src/index.mjs';
export const ASM_TESTS = 'packages/assemble-release-plan/test/assemble.test.mjs';
export const CLI_SRC = 'packages/cli/src/index.mjs';
export const CLI_TESTS = 'packages/cli/test/status.test.mjs';

const ASM_BASE = `const ORDER = { none: 0, patch: 1, minor: 2, major: 3 };
const higher = (a, b) => (ORDER[b] > ORDER[a] ? b : a);

/**
 * The release plan of \`changesets\` ({ id, releases: [{ name, type }] }) over \`packages\`
 * ({ name, version, dependencies?, peerDependencies? }): each package a changeset lists, at its
 * highest bump; each \`config.fixed\` group aligned to its highest bump; each dependent of a
 * package released with a major bump released as a patch.
 */
export function assembleReleasePlan(changesets, packages, config = {}) {
  const releases = new Map();
  for (const changeset of changesets) {
    for (const r of changeset.releases) {
      const rel = releases.get(r.name);
      if (rel === undefined) releases.set(r.name, { name: r.name, type: r.type });
      else rel.type = higher(rel.type, r.type);
    }
  }
  for (const group of config.fixed ?? []) {
    const inPlan = group.filter((name) => releases.has(name));
    if (inPlan.length === 0) continue;
    const type = inPlan.map((name) => releases.get(name).type).reduce(higher, 'none');
    for (const name of group) {
      const rel = releases.get(name);
      if (rel === undefined) releases.set(name, { name, type });
      else rel.type = type;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const pkg of packages) {
      if (releases.has(pkg.name)) continue;
      for (const dependencyType of ['dependencies', 'peerDependencies']) {
        const hit = Object.keys(pkg[dependencyType] ?? {}).find((dep) => releases.get(dep)?.type === 'major');
        if (hit === undefined) continue;
        releases.set(pkg.name, { name: pkg.name, type: 'patch' });
        changed = true;
        break;
      }
    }
  }
  return { releases: [...releases.values()] };
}
`;

/** The planner's first generation: reasons recorded — a dependent's range stripped of workspace:, a changeset reason only on a first listing or a raise. */
export const ASM_GEN0 = `const ORDER = { none: 0, patch: 1, minor: 2, major: 3 };
const higher = (a, b) => (ORDER[b] > ORDER[a] ? b : a);

/**
 * The release plan of \`changesets\` ({ id, releases: [{ name, type }] }) over \`packages\`
 * ({ name, version, dependencies?, peerDependencies? }): each package a changeset lists, at its
 * highest bump; each \`config.fixed\` group aligned to its highest bump; each dependent of a
 * package released with a major bump released as a patch. With \`options.explain\`, every release
 * keeps the reasons the planner gave it, in the order it decided them.
 */
export function assembleReleasePlan(changesets, packages, config = {}, options = {}) {
  const explain = options.explain === true;
  const releases = new Map();
  const add = (name, type) => {
    const rel = { name, type, ...(explain ? { reasons: [] } : {}) };
    releases.set(name, rel);
    return rel;
  };
  const reason = (rel, r) => {
    if (!explain) return;
    const key = JSON.stringify(r);
    if (!rel.reasons.some((x) => JSON.stringify(x) === key)) rel.reasons.push(r);
  };
  for (const changeset of changesets) {
    for (const r of changeset.releases) {
      const rel = releases.get(r.name);
      if (rel === undefined) reason(add(r.name, r.type), { type: 'changeset', changeset: changeset.id, bumpType: r.type });
      else if (ORDER[r.type] > ORDER[rel.type]) {
        rel.type = r.type;
        reason(rel, { type: 'changeset', changeset: changeset.id, bumpType: r.type });
      }
    }
  }
  for (const group of config.fixed ?? []) {
    const inPlan = group.filter((name) => releases.has(name));
    if (inPlan.length === 0) continue;
    const type = inPlan.map((name) => releases.get(name).type).reduce(higher, 'none');
    for (const name of group) {
      const rel = releases.get(name);
      if (rel === undefined) reason(add(name, type), { type: 'fixed', group: [...group], bumpType: type });
      else if (rel.type !== type) {
        rel.type = type;
        reason(rel, { type: 'fixed', group: [...group], bumpType: type });
      }
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const pkg of packages) {
      if (releases.has(pkg.name)) continue;
      for (const dependencyType of ['dependencies', 'peerDependencies']) {
        const hit = Object.entries(pkg[dependencyType] ?? {}).find(([dep]) => releases.get(dep)?.type === 'major');
        if (hit === undefined) continue;
        const [dependency, range] = hit;
        reason(add(pkg.name, 'patch'), { type: 'dependent', dependency, dependencyType, versionRange: range.replace(/^workspace:/, ''), bumpType: 'patch' });
        changed = true;
        break;
      }
    }
  }
  return { releases: [...releases.values()] };
}
`;

/** R002's repair: the range exactly as written. */
export const ASM_GEN2 = ASM_GEN0.replace("versionRange: range.replace(/^workspace:/, '')", 'versionRange: range');

/** R003's repair (the real run's flattenReleases gap): one changeset reason per changeset that lists the package, none included. */
export const ASM_GEN3 = ASM_GEN2.replace(
  `      else if (ORDER[r.type] > ORDER[rel.type]) {
        rel.type = r.type;
        reason(rel, { type: 'changeset', changeset: changeset.id, bumpType: r.type });
      }`,
  `      else {
        rel.type = higher(rel.type, r.type);
        reason(rel, { type: 'changeset', changeset: changeset.id, bumpType: r.type });
      }`,
);

export const CLI_BASE = `import { assembleReleasePlan } from '../../assemble-release-plan/src/index.mjs';

/** \`changeset status\`: the packages to be bumped, one line each; with \`output\`, the plan as JSON written to \`files\`. */
export function status({ changesets, packages, config = {}, output = null, files = new Map() }) {
  const plan = assembleReleasePlan(changesets, packages, config);
  const lines = ['Packages to be bumped:'];
  for (const rel of plan.releases) lines.push(\`  \${rel.name}: \${rel.type}\`);
  if (output !== null) files.set(output, JSON.stringify(plan, null, 2));
  return lines;
}
`;

/** The cli's first generation: every reason kind printed (what R001's AC-3 gap asks about is there already). */
export const CLI_GEN0 = `import { assembleReleasePlan } from '../../assemble-release-plan/src/index.mjs';

const LINES = {
  changeset: (r) => \`    - reason: changeset .changeset/\${r.changeset}.md (\${r.bumpType})\`,
  dependent: (r) => \`    - reason: dependent of \${r.dependency} (\${r.dependencyType} \${r.versionRange}) -> \${r.bumpType}\`,
  fixed: (r) => \`    - reason: fixed group [\${r.group.join(', ')}] -> \${r.bumpType}\`,
  linked: (r) => \`    - reason: linked group [\${r.group.join(', ')}] -> \${r.bumpType}\`,
  'prerelease-exit': () => '    - reason: exiting prerelease mode -> patch',
};

/**
 * \`changeset status\`: the packages to be bumped, one line each, and with \`explain\` one line per
 * reason under each, in order; with \`output\`, the plan as JSON written to \`files\` (its reasons with \`explain\`).
 */
export function status({ changesets, packages, config = {}, explain = false, output = null, files = new Map() }) {
  const plan = assembleReleasePlan(changesets, packages, config, { explain });
  const lines = ['Packages to be bumped:'];
  for (const rel of plan.releases) {
    lines.push(\`  \${rel.name}: \${rel.type}\`);
    if (explain) for (const r of rel.reasons ?? []) lines.push(LINES[r.type](r));
  }
  if (output !== null) files.set(output, JSON.stringify(plan, null, 2));
  return lines;
}
`;

const ASM_TESTS_BASE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReleasePlan } from '../src/index.mjs';

test('plans every package a changeset lists at its highest bump', () => {
  const plan = assembleReleasePlan([{ id: 'one', releases: [{ name: 'pkg-a', type: 'patch' }] }, { id: 'two', releases: [{ name: 'pkg-a', type: 'minor' }] }], [{ name: 'pkg-a', version: '1.0.0' }]);
  assert.deepEqual(plan.releases, [{ name: 'pkg-a', type: 'minor' }]);
});
`;

export const CLI_TESTS_BASE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status } from '../src/index.mjs';

const packages = [{ name: 'pkg-a', version: '1.0.0' }, { name: 'pkg-b', version: '1.0.0', dependencies: { 'pkg-a': '^1.0.0' } }];
const changesets = [{ id: 'brave-cats', releases: [{ name: 'pkg-a', type: 'major' }] }];

test('status lists the packages to be bumped', () => {
  assert.deepEqual(status({ changesets, packages }), ['Packages to be bumped:', '  pkg-a: major', '  pkg-b: patch']);
});

test('status writes the plan with --output', () => {
  const files = new Map();
  status({ changesets, packages, output: 'plan.json', files });
  assert.deepEqual(JSON.parse(files.get('plan.json')), { releases: [{ name: 'pkg-a', type: 'major' }, { name: 'pkg-b', type: 'patch' }] });
});
`;

export const ASM_RED_TEST = 'explain records a changeset reason for each package it plans, and no reasons without it';
export const ASM_GROUP_TEST = 'a dependent of a package a fixed group added names that package as its dependency';
export const ASM_PEER_TEST = 'a peerDependencies dependent records dependencyType peerDependencies';
export const ASM_WORKSPACE_TEST = 'a dependent reason keeps versionRange exactly as written, its workspace: prefix included';
export const ASM_FLATTEN_TEST = 'one changeset reason per changeset that lists the package, none included';
export const CLI_RED_TEST = '--explain prints a changeset reason line under its package';
export const CLI_OUTPUT_TEST = '--explain writes each release with its reasons with --output';
export const CLI_DEPENDENT_TEST = '--explain prints a dependent reason line with its dependency type and range';
export const CLI_FIXED_TEST = '--explain prints a fixed group reason line under the package the group aligned';
/** AC-4's evidence: the existing status test a green gate passes (a compatibility criterion). */
export const CLI_COMPAT_TEST = 'status lists the packages to be bumped';

/** The planner's first RED. */
export const ASM_RED = `${ASM_TESTS_BASE}
test('${ASM_RED_TEST}', () => {
  const changesets = [{ id: 'one', releases: [{ name: 'pkg-a', type: 'minor' }] }];
  const packages = [{ name: 'pkg-a', version: '1.0.0' }];
  assert.deepEqual(assembleReleasePlan(changesets, packages, {}, { explain: true }).releases, [{ name: 'pkg-a', type: 'minor', reasons: [{ type: 'changeset', changeset: 'one', bumpType: 'minor' }] }]);
  for (const options of [undefined, { explain: false }]) {
    const [release] = assembleReleasePlan(changesets, packages, {}, options).releases;
    assert.equal('reasons' in release, false);
  }
});
`;

/** R001's exact AC-2 reproduction, as the planner's worker writes it: both pass on the first generation's code (a re-proof). */
export const ASM_R001_REPRODUCTION = `${ASM_RED}
test('${ASM_GROUP_TEST}', () => {
  const packages = [{ name: 'pkg-a', version: '1.0.0' }, { name: 'pkg-b', version: '1.0.0' }, { name: 'pkg-c', version: '1.0.0', dependencies: { 'pkg-b': '^1.0.0' } }];
  const plan = assembleReleasePlan([{ id: 'one', releases: [{ name: 'pkg-a', type: 'major' }] }], packages, { fixed: [['pkg-a', 'pkg-b']] }, { explain: true });
  const c = plan.releases.find((r) => r.name === 'pkg-c');
  assert.deepEqual(c.reasons, [{ type: 'dependent', dependency: 'pkg-b', dependencyType: 'dependencies', versionRange: '^1.0.0', bumpType: 'patch' }]);
});

test('${ASM_PEER_TEST}', () => {
  const packages = [{ name: 'pkg-a', version: '1.0.0' }, { name: 'pkg-d', version: '1.0.0', peerDependencies: { 'pkg-a': '^1.0.0' } }];
  const plan = assembleReleasePlan([{ id: 'one', releases: [{ name: 'pkg-a', type: 'major' }] }], packages, {}, { explain: true });
  assert.deepEqual(plan.releases.find((r) => r.name === 'pkg-d').reasons, [{ type: 'dependent', dependency: 'pkg-a', dependencyType: 'peerDependencies', versionRange: '^1.0.0', bumpType: 'patch' }]);
});
`;

const ASM_WORKSPACE_BODY = `
test('${ASM_WORKSPACE_TEST}', () => {
  const packages = [{ name: 'pkg-a', version: '1.0.0' }, { name: 'pkg-c', version: '1.0.0', dependencies: { 'pkg-a': 'workspace:^1.0.0' } }, { name: 'pkg-d', version: '1.0.0', dependencies: { 'pkg-a': 'workspace:*' } }];
  const plan = assembleReleasePlan([{ id: 'one', releases: [{ name: 'pkg-a', type: 'major' }] }], packages, {}, { explain: true });
  assert.deepEqual(plan.releases.filter((r) => r.name !== 'pkg-a').map((r) => [r.name, r.reasons[0].versionRange]), [['pkg-c', 'workspace:^1.0.0'], ['pkg-d', 'workspace:*']]);
});
`;

/** R002's RED, on the head that holds the planner's re-proof unit. */
export const ASM_WORKSPACE_RED = `${ASM_R001_REPRODUCTION}${ASM_WORKSPACE_BODY}`;
/** The stale worker's RED: written on the head before any re-proof unit, so R001's reproduction is not in it. */
export const ASM_WORKSPACE_RED_STALE = `${ASM_RED}${ASM_WORKSPACE_BODY}`;

/** R003's RED (the real run's flattenReleases gap). */
export const ASM_FLATTEN_RED = `${ASM_WORKSPACE_RED}
test('${ASM_FLATTEN_TEST}', () => {
  const changesets = [
    { id: 'one', releases: [{ name: 'pkg-a', type: 'patch' }] },
    { id: 'two', releases: [{ name: 'pkg-a', type: 'patch' }] },
    { id: 'three', releases: [{ name: 'pkg-a', type: 'none' }] },
  ];
  const [a] = assembleReleasePlan(changesets, [{ name: 'pkg-a', version: '1.0.0' }], {}, { explain: true }).releases;
  assert.equal(a.type, 'patch');
  assert.deepEqual(a.reasons, [
    { type: 'changeset', changeset: 'one', bumpType: 'patch' },
    { type: 'changeset', changeset: 'two', bumpType: 'patch' },
    { type: 'changeset', changeset: 'three', bumpType: 'none' },
  ]);
});
`;

/** The cli's first RED. */
export const CLI_RED = `${CLI_TESTS_BASE}
test('${CLI_RED_TEST}', () => {
  const lines = status({ changesets: [{ id: 'brave-cats', releases: [{ name: 'pkg-a', type: 'minor' }] }], packages: [{ name: 'pkg-a', version: '1.0.0' }], explain: true });
  assert.deepEqual(lines, ['Packages to be bumped:', '  pkg-a: minor', '    - reason: changeset .changeset/brave-cats.md (minor)']);
});

test('${CLI_OUTPUT_TEST}', () => {
  const files = new Map();
  status({ changesets: [{ id: 'brave-cats', releases: [{ name: 'pkg-a', type: 'minor' }] }], packages: [{ name: 'pkg-a', version: '1.0.0' }], explain: true, output: 'plan.json', files });
  assert.deepEqual(JSON.parse(files.get('plan.json')).releases[0].reasons, [{ type: 'changeset', changeset: 'brave-cats', bumpType: 'minor' }]);
});
`;

/** R001's exact AC-3 reproduction, as the cli's worker writes it: both pass on the first generation's code (a re-proof). */
export const CLI_R001_REPRODUCTION = `${CLI_RED}
test('${CLI_DEPENDENT_TEST}', () => {
  const lines = status({ changesets, packages, explain: true });
  assert.deepEqual(lines, ['Packages to be bumped:', '  pkg-a: major', '    - reason: changeset .changeset/brave-cats.md (major)', '  pkg-b: patch', '    - reason: dependent of pkg-a (dependencies ^1.0.0) -> patch']);
});

test('${CLI_FIXED_TEST}', () => {
  const lines = status({ changesets: [{ id: 'calm-owls', releases: [{ name: 'pkg-a', type: 'minor' }] }], packages: [{ name: 'pkg-a', version: '1.0.0' }, { name: 'pkg-b', version: '1.0.0' }], config: { fixed: [['pkg-a', 'pkg-b']] }, explain: true });
  assert.deepEqual(lines.slice(3), ['  pkg-b: minor', '    - reason: fixed group [pkg-a, pkg-b] -> minor']);
});
`;

export const TYPES_BASE = `export type VersionType = 'none' | 'patch' | 'minor' | 'major';

export interface ComprehensiveRelease {
  name: string;
  type: VersionType;
}
`;

/** AC-1: the declaration change alone. */
export const TYPES_DECL = `export type VersionType = 'none' | 'patch' | 'minor' | 'major';
export type DependencyType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';

export type ReleaseReason =
  | { type: 'changeset'; changeset: string; bumpType: VersionType }
  | { type: 'dependent'; dependency: string; dependencyType: DependencyType; versionRange: string; bumpType: VersionType }
  | { type: 'fixed'; group: string[]; bumpType: VersionType }
  | { type: 'linked'; group: string[]; bumpType: VersionType }
  | { type: 'prerelease-exit'; bumpType: 'patch' };

export interface ComprehensiveRelease {
  name: string;
  type: VersionType;
  reasons?: ReleaseReason[];
}
`;

export const BASE_FILES: Record<string, string> = {
  'package.json': '{ "name": "changesets-lite", "private": true, "type": "module" }\n',
  'README.md': '# changesets-lite\n',
  [TYPES_SRC]: TYPES_BASE,
  [ASM_SRC]: ASM_BASE,
  [ASM_TESTS]: ASM_TESTS_BASE,
  [CLI_SRC]: CLI_BASE,
  [CLI_TESTS]: CLI_TESTS_BASE,
};

/** A test's canonical id, as its module gate publishes it (JUnit report). */
export const asmTestId = (name: string): string => canonicalTestId('junit-xml', ASM_TESTS, name);
export const cliTestId = (name: string): string => canonicalTestId('junit-xml', CLI_TESTS, name);

// ---- the reviews' gaps, as the real run's reviewers put them --------------------------

export const GAP_R001_AC2: VerdictOverride = {
  gap: {
    missing: 'No test for a dependent caused by a package added through a fixed group, or for a dependent through peerDependencies.',
    reproduction: 'Using assembleReleasePlan with explain:true: fixed group [pkg-a, pkg-b] with pkg-b depended on by pkg-c, changeset major only on pkg-a, assert the pkg-c dependent reason names dependency pkg-b; pkg-d with peerDependencies on pkg-a, assert the dependent reason dependencyType peerDependencies.',
    producer: { node_id: ASSEMBLE },
  },
};
export const GAP_R001_AC3: VerdictOverride = {
  gap: {
    missing: 'Line formats for dependent and fixed reasons are never asserted.',
    reproduction: "Run status({explain:true}) where pkg-b depends on pkg-a ^1.0.0 with a major changeset on pkg-a and assert the exact line '    - reason: dependent of pkg-a (dependencies ^1.0.0) -> patch'; with a fixed group [pkg-a, pkg-b] assert '    - reason: fixed group [pkg-a, pkg-b] -> minor'.",
    producer: { node_id: CLI },
  },
};
export const GAP_R002_AC2: VerdictOverride = {
  gap: {
    missing: 'The criterion requires versionRange exactly as written in package.json, including any workspace: prefix; the code records the range with the prefix stripped.',
    reproduction: "pkg-c has dependencies {pkg-a:'workspace:^1.0.0'}, pkg-d {pkg-a:'workspace:*'}; changeset major on pkg-a; assembleReleasePlan(...,{explain:true}); expect each dependent reason versionRange to equal 'workspace:^1.0.0' and 'workspace:*' respectively.",
    producer: { module: 'changesets:packages/assemble-release-plan/src/index.mjs' },
  },
};
export const GAP_R003_AC2: VerdictOverride = {
  gap: {
    missing: 'One changeset reason per changeset including none is required, but the planner adds a reason only for the first changeset of a package or one that raises its bump; a second changeset at the same or a lower bump, or a none changeset, gets no reason.',
    reproduction: "assembleReleasePlan with two changesets both listing pkg-a as patch and a third listing it as 'none', explain:true: expect three changeset reasons, one per changeset id, the last with bumpType none.",
    producer: { module: 'changesets:packages/assemble-release-plan/src/index.mjs' },
  },
};

// ---- the portfolio ----------------------------------------------------------------------

export function expModules(): Record<string, unknown> {
  return {
    module_defaults: {
      test: ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=${REPORT}', '${MODULE_PATH}/test/**/*.test.mjs'],
      report: { format: 'junit-xml' },
      timeout_seconds: 300,
    },
    modules: [
      { id: 'types', path: 'packages/types', runtime_tests: false, test: ['node', '-e', '0'], report: null },
      { id: 'assemble-release-plan', path: 'packages/assemble-release-plan' },
      { id: 'cli', path: 'packages/cli' },
    ],
  };
}

export function expRepository(): RepositoryDecl {
  return { name: 'changesets', path: '../changesets', base_branch: 'main', commands: { test: FULL_SUITE }, ...expModules() } as RepositoryDecl;
}

export function expVerifier(module: string): { id: string; module: string; module_sha256: string; command: string[] } {
  return verifierFor(modulesOf(expRepository()).find((m) => m.id === module) as ResolvedModule);
}

function worker(): Record<string, unknown> {
  return { model: 'sonnet', effort: 'high', max_turns: 40, max_wall_clock_minutes: 5, max_attempts: 3, nested_delegation: false };
}

/** CSET-201 as its real planner graphed it: types (declaration), assemble, cli, the compatibility verification, the candidate. */
export function expGraph(): Record<string, unknown> {
  const node = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    id,
    level: 'executable-node',
    repository: 'changesets',
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    worker: worker(),
    invalidation_rules: [],
    ...extra,
  });
  return {
    schema_version: 1,
    feature_id: EXP_FEATURE,
    title: 'Explain why each package is in the release plan',
    prd: 'PRD.md',
    acceptance_criteria: EXP_CRITERIA.map((c) => ({ ...c })),
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['changesets'],
    capabilities: [
      { id: 'CAP-TYPES', repository: 'changesets', title: 'ReleaseReason types', acceptance_criteria: ['AC-1'] },
      { id: 'CAP-ASSEMBLE', repository: 'changesets', title: 'Record release reasons in the planner', acceptance_criteria: ['AC-2'] },
      { id: 'CAP-CLI', repository: 'changesets', title: 'changeset status --explain', acceptance_criteria: ['AC-3', 'AC-4'] },
    ],
    nodes: [
      node(TYPES, { capability: 'CAP-TYPES', node_type: 'contract-lock', depends_on: [], allowed_paths: ['packages/types/**'], required_evidence: ['green', 'regression'], verification_commands: [expVerifier('types')], acceptance_criteria: ['AC-1'] }),
      node(ASSEMBLE, { capability: 'CAP-ASSEMBLE', node_type: 'implementation', depends_on: [TYPES], allowed_paths: ['packages/assemble-release-plan/**'], required_evidence: ['red', 'green', 'regression'], verification_commands: [expVerifier('assemble-release-plan')], acceptance_criteria: ['AC-2'] }),
      node(CLI, { capability: 'CAP-CLI', node_type: 'implementation', depends_on: [ASSEMBLE], allowed_paths: ['packages/cli/**'], required_evidence: ['red', 'green', 'regression'], verification_commands: [expVerifier('cli')], acceptance_criteria: ['AC-3', 'AC-4'] }),
      node(COMPAT, {
        capability: 'CAP-CLI',
        node_type: 'verification',
        depends_on: [CLI],
        allowed_paths: [],
        forbidden_paths: ['packages/**'],
        required_evidence: ['regression'],
        verification_commands: [expVerifier('cli'), { id: 'full-suite', command: FULL_SUITE }],
        worker: { ...worker(), effort: 'medium', max_turns: 15 },
        invalidation_rules: [{ when: 'any upstream node result changes', action: 'RERUN_REGRESSION' }],
        acceptance_criteria: ['AC-4'],
      }),
      {
        id: CANDIDATE,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: [TYPES, ASSEMBLE, CLI, COMPAT],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', EXP_FEATURE] }],
        worker: { ...worker(), max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

export interface Exp {
  root: string;
  control: string;
  repo: string;
  featureDir: string;
}

/** The control repository's acceptance review policy (engine/acceptance-review.ts): `{}` takes Mycelink's default. */
export async function createExplain(options: { review?: Record<string, unknown>; graph?: Record<string, unknown>; writerConcurrency?: number } = {}): Promise<Exp> {
  const root = makeTmpDir('cset201-');
  const repo = makeGitRepo(join(root, 'changesets'), { files: BASE_FILES });
  const control = join(root, 'control');
  const entry: Record<string, unknown> = {
    name: 'changesets',
    path: relative(control, repo).replace(/\\/g, '/'),
    base_branch: 'main',
    commands: { test: FULL_SUITE },
    tdd: { test_paths: ['packages/*/test/**'], declaration_paths: ['packages/types/**'] },
    ...expModules(),
    worktree_setup: { commands: [['node', '-e', '0']], timeout_seconds: 60 },
  };
  const mycelink = join(process.cwd(), 'bin', 'mycelink.mjs');
  makeGitRepo(control, {
    files: {
      'README.md': '# control\n',
      '.claude/settings.json': JSON.stringify({ hooks: buildHookSettings(mycelink) }, null, 2) + '\n',
      'mycelink.config.json':
        JSON.stringify(
          {
            schema_version: 1,
            claude_executable: join(root, 'no-such-claude'),
            session_adapter: 'claude-background',
            claude_extra_args: [],
            session_timeout_ms: 120000,
            context_pack_max_bytes: 24576,
            hook_session_start_max_bytes: 4096,
            hook_prompt_delta_max_bytes: 2048,
            brain_dir: null,
            acceptance_review: options.review ?? {},
          },
          null,
          2,
        ) + '\n',
      'repositories.yaml': YAML.stringify({ schema_version: 1, repositories: [entry] }, { lineWidth: 0 }),
    },
  });
  ensureScratchIgnored(control);
  commitAll(control, 'ignore the mycelink scratch area');
  const featureDir = join(control, 'features', EXP_FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'PRD.md'), `# ${EXP_FEATURE} Explain why each package is in the release plan\n\n${EXP_CRITERIA.map((c) => `- ${c.text}`).join('\n')}\n`);
  writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(options.graph ?? expGraph(), { lineWidth: 0 }));
  const s: Exp = { root, control, repo, featureDir };
  const init = await expCli(s, ['feature', 'init', EXP_FEATURE, ...(options.writerConcurrency ? ['--writer-concurrency', String(options.writerConcurrency)] : [])]);
  if (init.code !== 0) throw new Error(`feature init failed: ${init.err}`);
  commitAll(control, 'feature scaffolding');
  return s;
}

/** Run the CLI in-process as the controller at `control`. */
export async function expCli(s: Pick<Exp, 'control'>, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const withAuthority = asController(argv, s.control);
  const dd = withAuthority.indexOf('--');
  const withRoot = dd === -1 ? [...withAuthority, '--control-root', s.control] : [...withAuthority.slice(0, dd), '--control-root', s.control, ...withAuthority.slice(dd)];
  const code = await main(withRoot, io);
  return { code, out, err };
}

export function expState(s: Exp): Record<string, any> {
  return JSON.parse(readFileSync(join(s.featureDir, 'STATE.json'), 'utf8')).data;
}

export function commitExpControl(s: Exp, message: string): void {
  if (git(s.control, ['status', '--porcelain']) === '') return;
  commitAll(s.control, message);
}

/** The project adapter the benchmark's TDD replay reads this repository with (evals-public-projects/lib/adapters). */
export const EXP_BENCH_MANIFEST = {
  schema: 'mycelink-bench/project-adapter@1',
  id: 'changesets-lite',
  name: 'changesets-lite',
  implementation: 'node-test',
  source_lock: 'source.lock.json',
  workspace: { repo_dir: 'repos/changesets', branch: 'main' },
  modules: [
    { id: 'types', path: 'packages/types', description: 'types', runtime_tests: false },
    { id: 'assemble-release-plan', path: 'packages/assemble-release-plan', description: 'planner' },
    { id: 'cli', path: 'packages/cli', description: 'cli' },
  ],
  shared_paths: [],
  test_paths: ['packages/*/test/**'],
  toolchain: { runtime: 'node', versions: {}, cache: { kind: 'none', dir: '' } },
  env: { TZ: 'UTC' },
  commands: { timeout_seconds: 120 },
  tolerated_build_mutations: [],
  baseline_exclusions: [],
};
