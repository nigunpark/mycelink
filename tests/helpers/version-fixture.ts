/**
 * A CSET-203-shaped portfolio, small enough for every platform: one
 * repository, `changesets`, whose `changeset version` applies a release plan
 * through the apply-release-plan module and is driven by the cli module, as
 * Changesets' are. Tests run with Node's own runner and a JUnit report.
 *
 * The feature, CSET-203 (crash-safe `changeset version`), with r1's node ids:
 *   AC-1 apply-release-plan  a failed apply restores every file, cause kept
 *   AC-2 apply-release-plan  a dot-named journal in .changeset while applying
 *   AC-3 cli                 version recovers an interrupted run, warns
 *   AC-4 cli                 a failed apply: no stack trace, exit 1, no commit
 *   AC-5 cli, compatibility  a successful run, status and add as before: the cli
 *                            produces it, the compatibility node proves it again
 *
 * The cli work comes in two cycles: AC-3's recovery first, then AC-4's
 * failure reporting, each with its own RED.
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

export const VER_FEATURE = 'CSET-203';
export const ARP = `${VER_FEATURE}.changesets.apply-release-plan.crash-safe`;
export const CLI = `${VER_FEATURE}.changesets.cli.version-recovery`;
export const COMPAT = `${VER_FEATURE}.changesets.compat.regression`;
export const VER_CANDIDATE = `${VER_FEATURE}.candidate.build`;

/** The whole suite, as the repository runs it (regression, candidate, acceptance). */
export const VER_FULL_SUITE = ['node', '--test', 'packages/*/test/**/*.test.mjs'];

export const VER_CRITERIA = [
  { id: 'AC-1', kind: 'new-behavior', text: 'AC-1 rollback (apply-release-plan): if applyReleasePlan fails after it started changing files, it restores every file it changed, created or deleted to its exact previous bytes (or absence), and only then rejects; the rejection\'s cause is the original error.' },
  { id: 'AC-2', kind: 'new-behavior', text: 'AC-2 journal (apply-release-plan): before its first change applyReleasePlan records what it is about to change in a recovery journal inside .changeset/ under a name that starts with ".", and removes it once the run completed, successfully or after a rollback.' },
  { id: 'AC-3', kind: 'new-behavior', text: 'AC-3 recovery (CLI): before it reads anything else, changeset version looks for a journal left by an interrupted run; if it finds one it restores the state recorded in it, removes the journal, prints a warning that contains the word "interrupted", then versions normally.' },
  { id: 'AC-4', kind: 'new-behavior', text: 'AC-4 failure (CLI): when applying the release plan fails, changeset version prints the failure without a stack trace and exits with code 1; it does not run git add or git commit for that run, even when commit is enabled.' },
  { id: 'AC-5', kind: 'compatibility', text: 'AC-5 compatibility: a run that succeeds produces exactly the same files as today and leaves no journal behind; changeset status and changeset add are unaffected by a journal.' },
] as const;

export const BASE_FILES: Record<string, string> = {
  'package.json': '{ "name": "changesets-lite", "private": true, "type": "module" }\n',
  'README.md': '# changesets-lite\n',
  'packages/apply-release-plan/src/index.mjs': `/** Apply a release plan: each change ({ path, content }, content null to delete) written to \`files\` (a Map) in turn, \`format\` run after each. */
export async function applyReleasePlan(files, changes, { format = async () => {} } = {}) {
  const touched = [];
  for (const change of changes) {
    if (change.content === null) files.delete(change.path);
    else files.set(change.path, change.content);
    touched.push(change.path);
    await format(change.path);
  }
  return touched;
}
`,
  'packages/apply-release-plan/test/apply.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReleasePlan } from '../src/index.mjs';

test('applies every change of the release plan', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/one.md', 'one']]);
  const touched = await applyReleasePlan(files, [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }]);
  assert.deepEqual(touched, ['packages/a/package.json', '.changeset/one.md']);
  assert.deepEqual([...files], [['packages/a/package.json', '{"version":"2.0.0"}']]);
});
`,
  'packages/cli/src/index.mjs': `import { applyReleasePlan } from '../../apply-release-plan/src/index.mjs';

/** \`changeset version\`: apply \`changes\` to \`files\`, commit them when \`config.commit\`. Returns the exit code. */
export async function version({ files, changes, config = {}, io, git, format }) {
  const touched = await applyReleasePlan(files, changes, { format });
  if (config.commit) {
    git.add(touched);
    git.commit('Version Packages');
  }
  io.log('versioned ' + touched.length + ' file(s)');
  return 0;
}

/** \`changeset status\`: the pending changesets of \`files\`. */
export function status({ files, io }) {
  for (const path of [...files.keys()].filter((p) => /^\\.changeset\\/[^./][^/]*\\.md$/.test(p)).sort()) io.log(path);
  return 0;
}
`,
  'packages/cli/test/cli.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status, version } from '../src/index.mjs';

const quiet = { log() {}, warn() {}, error() {} };

test('version applies the release plan and commits it when commit is set', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/one.md', 'one']]);
  const calls = [];
  const git = { add: (paths) => calls.push(['add', paths]), commit: (message) => calls.push(['commit', message]) };
  const code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }], config: { commit: true }, io: quiet, git });
  assert.equal(code, 0);
  assert.deepEqual([...files], [['packages/a/package.json', '{"version":"2.0.0"}']]);
  assert.deepEqual(calls, [['add', ['packages/a/package.json', '.changeset/one.md']], ['commit', 'Version Packages']]);
});

test('status lists the pending changesets', () => {
  const lines = [];
  status({ files: new Map([['.changeset/b.md', 'b'], ['.changeset/a.md', 'a'], ['.changeset/config.json', '{}']]), io: { log: (l) => lines.push(l) } });
  assert.deepEqual(lines, ['.changeset/a.md', '.changeset/b.md']);
});
`,
};

/** AC-1 and AC-2: the apply-release-plan module rolls back and keeps a journal. */
export const ARP_IMPL = `export const JOURNAL = '.changeset/.version-journal.json';

function restore(files, before) {
  for (const { path, content } of [...before].reverse()) {
    if (content === null) files.delete(path);
    else files.set(path, content);
  }
}

/** Apply a release plan; a failure restores every file it changed and rejects with the failure as the cause. */
export async function applyReleasePlan(files, changes, { format = async () => {} } = {}) {
  const before = changes.map((c) => ({ path: c.path, content: files.has(c.path) ? files.get(c.path) : null }));
  files.set(JOURNAL, JSON.stringify({ before }));
  const touched = [];
  try {
    for (const change of changes) {
      if (change.content === null) files.delete(change.path);
      else files.set(change.path, change.content);
      touched.push(change.path);
      await format(change.path);
    }
  } catch (error) {
    restore(files, before);
    files.delete(JOURNAL);
    throw new Error('applying the release plan failed: ' + error.message, { cause: error });
  }
  files.delete(JOURNAL);
  return touched;
}

/** Restore what an interrupted run journaled; true when there was one. */
export function recoverInterruptedReleasePlan(files) {
  if (!files.has(JOURNAL)) return false;
  restore(files, JSON.parse(files.get(JOURNAL)).before);
  files.delete(JOURNAL);
  return true;
}
`;

export const ARP_RED = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReleasePlan } from '../src/index.mjs';

test('applies every change of the release plan', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/one.md', 'one']]);
  const touched = await applyReleasePlan(files, [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }]);
  assert.deepEqual(touched, ['packages/a/package.json', '.changeset/one.md']);
  assert.deepEqual([...files], [['packages/a/package.json', '{"version":"2.0.0"}']]);
});

test('restores every file it changed, created or deleted when the plan fails, with the original error as the cause', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/one.md', 'one']]);
  const failure = new Error('formatter crashed');
  const plan = [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: 'packages/a/CHANGELOG.md', content: '# a' }, { path: '.changeset/one.md', content: null }];
  const error = await applyReleasePlan(files, plan, { format: async (path) => { if (path === '.changeset/one.md') throw failure; } }).then(() => null, (e) => e);
  assert.ok(error instanceof Error, 'it rejects');
  assert.equal(error.cause, failure);
  assert.deepEqual([...files].sort(), [['.changeset/one.md', 'one'], ['packages/a/package.json', '{"version":"1.0.0"}']]);
});

test('keeps a dot-named journal in .changeset while applying and removes it afterwards', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}']]);
  const seen = [];
  await applyReleasePlan(files, [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }], { format: async () => seen.push([...files.keys()].filter((p) => p.startsWith('.changeset/.'))) });
  assert.equal(seen[0].length, 1, 'a journal while applying');
  assert.deepEqual([...files.keys()], ['packages/a/package.json'], 'and none afterwards');
});
`;

/** AC-3 alone: the cli recovers an interrupted run before it versions. */
export const CLI_RECOVERY_IMPL = `import { applyReleasePlan, recoverInterruptedReleasePlan } from '../../apply-release-plan/src/index.mjs';

/** \`changeset version\`: apply \`changes\` to \`files\`, commit them when \`config.commit\`. Returns the exit code. */
export async function version({ files, changes, config = {}, io, git, format }) {
  if (recoverInterruptedReleasePlan(files)) io.warn('A previous changeset version run was interrupted: the files it changed were restored, versioning again.');
  const touched = await applyReleasePlan(files, changes, { format });
  if (config.commit) {
    git.add(touched);
    git.commit('Version Packages');
  }
  io.log('versioned ' + touched.length + ' file(s)');
  return 0;
}

/** \`changeset status\`: the pending changesets of \`files\`. */
export function status({ files, io }) {
  for (const path of [...files.keys()].filter((p) => /^\\.changeset\\/[^./][^/]*\\.md$/.test(p)).sort()) io.log(path);
  return 0;
}
`;

/** AC-3 and AC-4: ... and reports a failed apply without a stack trace, exit 1, nothing committed. */
export const CLI_IMPL = `import { applyReleasePlan, recoverInterruptedReleasePlan } from '../../apply-release-plan/src/index.mjs';

function messages(error) {
  const out = [];
  for (let e = error; e instanceof Error && out.length < 5; e = e.cause) out.push(e.message);
  return out.join('\\nCaused by: ');
}

/** \`changeset version\`: apply \`changes\` to \`files\`, commit them when \`config.commit\`. Returns the exit code. */
export async function version({ files, changes, config = {}, io, git, format }) {
  if (recoverInterruptedReleasePlan(files)) io.warn('A previous changeset version run was interrupted: the files it changed were restored, versioning again.');
  let touched;
  try {
    touched = await applyReleasePlan(files, changes, { format });
  } catch (error) {
    io.error(messages(error));
    return 1;
  }
  if (config.commit) {
    git.add(touched);
    git.commit('Version Packages');
  }
  io.log('versioned ' + touched.length + ' file(s)');
  return 0;
}

/** \`changeset status\`: the pending changesets of \`files\`. */
export function status({ files, io }) {
  for (const path of [...files.keys()].filter((p) => /^\\.changeset\\/[^./][^/]*\\.md$/.test(p)).sort()) io.log(path);
  return 0;
}
`;

const CLI_TESTS_HEAD = BASE_FILES['packages/cli/test/cli.test.mjs'] as string;

export const CLI_RECOVERY_TEST = 'version restores an interrupted run, warns that it was interrupted, then versions once';
export const CLI_FAILURE_TEST = 'version reports a failed apply without a stack trace, exits 1 and does not commit';
export const CLI_EXISTING_TEST = 'version applies the release plan and commits it when commit is set';
/** The cli's existing status test: AC-5's evidence as a first submission names it, through GREEN (a compatibility criterion). */
export const CLI_STATUS_TEST = 'status lists the pending changesets';

/** A cli test's canonical id, as its gates publish it (the module command's JUnit report). */
export const verCliTestId = (name: string): string => canonicalTestId('junit-xml', 'packages/cli/test/cli.test.mjs', name);

/**
 * AC-5's evidence in a cli submission: the existing status test its green
 * gate passed (a gate prints only the node's own and failed tests; a worker
 * finds an existing one with `tdd tests`, here by its id).
 */
export const CLI_AC5 = { criterion: 'AC-5', gate: 'green' as const, test_id: verCliTestId(CLI_STATUS_TEST) };
export const ARP_ROLLBACK_TEST = 'restores every file it changed, created or deleted when the plan fails, with the original error as the cause';
export const ARP_JOURNAL_TEST = 'keeps a dot-named journal in .changeset while applying and removes it afterwards';

/** The cli's first RED: AC-3's recovery. */
export const CLI_RECOVERY_RED = `${CLI_TESTS_HEAD}
test('${CLI_RECOVERY_TEST}', async () => {
  const journal = JSON.stringify({ before: [{ path: 'packages/a/package.json', content: '{"version":"1.0.0"}' }, { path: '.changeset/one.md', content: 'one' }] });
  const files = new Map([['packages/a/package.json', '{"version":"2.0.0"}'], ['.changeset/.version-journal.json', journal]]);
  const warnings = [];
  const code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }], io: { log() {}, warn: (m) => warnings.push(m), error() {} }, git: { add() {}, commit() {} } });
  assert.equal(code, 0);
  assert.ok(warnings.some((w) => /interrupted/.test(w)), 'it warns that the last run was interrupted');
  assert.deepEqual([...files], [['packages/a/package.json', '{"version":"2.0.0"}']], 'versioned once, no journal left');
});
`;

/** The cli's second RED: AC-4's failure reporting. */
export const CLI_FAILURE_RED = `${CLI_RECOVERY_RED}
test('${CLI_FAILURE_TEST}', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}']]);
  const errors = [];
  const calls = [];
  let code;
  try {
    code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }], config: { commit: true }, io: { log() {}, warn() {}, error: (m) => errors.push(m) }, git: { add: () => calls.push('add'), commit: () => calls.push('commit') }, format: async () => { throw new Error('formatter crashed'); } });
  } catch (error) {
    code = 'threw ' + error.message;
  }
  assert.equal(code, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /formatter crashed/);
  assert.doesNotMatch(errors[0], /\\n\\s+at /);
  assert.deepEqual(calls, []);
  assert.deepEqual([...files], [['packages/a/package.json', '{"version":"1.0.0"}']]);
});
`;

export type VerModules = 'structured' | 'text';

export function verModules(mode: VerModules = 'structured'): Record<string, unknown> {
  const test =
    mode === 'structured'
      ? ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=${REPORT}', '${MODULE_PATH}/test/**/*.test.mjs']
      : ['node', '--test', '${MODULE_PATH}/test/**/*.test.mjs'];
  return {
    module_defaults: { test, ...(mode === 'structured' ? { report: { format: 'junit-xml' } } : {}), timeout_seconds: 300 },
    modules: [
      { id: 'apply-release-plan', path: 'packages/apply-release-plan' },
      { id: 'cli', path: 'packages/cli' },
    ],
  };
}

/** The repository as repositories.yaml declares it (path aside). */
export function verRepository(mode: VerModules = 'structured', commands: Record<string, string[]> = {}): RepositoryDecl {
  return { name: 'changesets', path: '../changesets', base_branch: 'main', commands: { test: VER_FULL_SUITE, ...commands }, ...verModules(mode) } as RepositoryDecl;
}

/** The verifier `repo modules` offers for a module: what a planner selects. */
export function verVerifier(module: string, mode: VerModules = 'structured'): { id: string; module: string; module_sha256: string; command: string[] } {
  return verifierFor(modulesOf(verRepository(mode)).find((m) => m.id === module) as ResolvedModule);
}

function worker(): Record<string, unknown> {
  return { model: 'sonnet', effort: 'high', max_turns: 40, max_wall_clock_minutes: 5, max_attempts: 2, nested_delegation: false };
}

export interface VerGraphOptions {
  /** The compatibility node's verifiers; default both modules and the full suite. */
  compatVerifiers?: { id: string; command: string[]; module?: string; module_sha256?: string }[];
  /** Leave the candidate build out (as r1 with-faults' planner did). */
  candidate?: boolean;
  /** Override the compatibility node's fields. */
  compat?: Record<string, unknown>;
  /**
   * AC-5 on the compatibility verification node alone, as r1 to r3's planners
   * graphed it: graph validation refuses it now (CRITERION_NO_PRODUCER), so a
   * test initialises the feature with the owned graph and swaps this one in,
   * as a feature initialised before the rule would have it.
   */
  legacyCompat?: boolean;
}

/**
 * CSET-203 as r1 with-faults' planner graphed it — apply-release-plan, then
 * cli, then the compatibility node over both — with its compatibility node a
 * verification node, and a candidate build after all three; AC-5 is the
 * cli's as well (every criterion has a product producer).
 */
export function verGraph(options: VerGraphOptions = {}): Record<string, unknown> {
  const impl = (id: string, module: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    id,
    level: 'executable-node',
    repository: 'changesets',
    capability: module === 'cli' ? 'CAP-CLI-RECOVER-FAIL' : 'CAP-ARP-ROLLBACK-JOURNAL',
    node_type: 'implementation',
    allowed_paths: [`packages/${module}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [verVerifier(module)],
    worker: worker(),
    invalidation_rules: [],
    ...extra,
  });
  const compat: Record<string, unknown> = {
    id: COMPAT,
    level: 'executable-node',
    repository: 'changesets',
    capability: 'CAP-COMPAT',
    node_type: 'verification',
    depends_on: [ARP, CLI],
    allowed_paths: [],
    forbidden_paths: ['packages/**'],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['regression'],
    verification_commands: options.compatVerifiers ?? [verVerifier('apply-release-plan'), verVerifier('cli'), { id: 'full-suite', command: VER_FULL_SUITE }],
    worker: { ...worker(), effort: 'medium', max_turns: 15 },
    invalidation_rules: [{ when: 'any upstream node result changes', action: 'RERUN_REGRESSION' }],
    acceptance_criteria: ['AC-5'],
    ...(options.compat ?? {}),
  };
  return {
    schema_version: 1,
    feature_id: VER_FEATURE,
    title: 'Crash-safe changeset version',
    prd: 'PRD.md',
    acceptance_criteria: VER_CRITERIA.map((c) => ({ ...c })),
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['changesets'],
    capabilities: [
      { id: 'CAP-ARP-ROLLBACK-JOURNAL', repository: 'changesets', title: 'applyReleasePlan rolls back on failure and keeps a recovery journal', acceptance_criteria: ['AC-1', 'AC-2'] },
      { id: 'CAP-CLI-RECOVER-FAIL', repository: 'changesets', title: 'changeset version recovers an interrupted run and reports failures cleanly', acceptance_criteria: options.legacyCompat === true ? ['AC-3', 'AC-4'] : ['AC-3', 'AC-4', 'AC-5'] },
      { id: 'CAP-COMPAT', repository: 'changesets', title: 'successful runs, status and add unchanged', acceptance_criteria: ['AC-5'] },
    ],
    nodes: [
      impl(ARP, 'apply-release-plan', { depends_on: [], acceptance_criteria: ['AC-1', 'AC-2'] }),
      impl(CLI, 'cli', { depends_on: [ARP], acceptance_criteria: options.legacyCompat === true ? ['AC-3', 'AC-4'] : ['AC-3', 'AC-4', 'AC-5'] }),
      compat,
      ...(options.candidate === false
        ? []
        : [
            {
              id: VER_CANDIDATE,
              level: 'executable-node',
              repository: null,
              capability: null,
              node_type: 'candidate-build',
              depends_on: [ARP, CLI, COMPAT],
              allowed_paths: [],
              forbidden_paths: [],
              contract_inputs: [],
              contract_outputs: [],
              required_resources: [],
              required_evidence: ['candidate'],
              verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', VER_FEATURE] }],
              worker: { ...worker(), max_turns: 1 },
              invalidation_rules: [],
              acceptance_criteria: [],
            },
          ]),
    ],
  };
}

export interface Ver {
  root: string;
  control: string;
  repo: string;
  featureDir: string;
}

export interface VerOptions {
  graph?: Record<string, unknown>;
  /** Extra repository commands (each one a verifier a node may name). */
  commands?: Record<string, string[]>;
  /** Give the repository a worktree setup (default true): receipts are written and bound. */
  worktreeSetup?: boolean | Record<string, unknown>;
  init?: boolean;
  /**
   * The control repository's acceptance review policy (engine/acceptance-review.ts).
   * Default: off, as these fixtures predate it; `{}` takes Mycelink's default (required, two rounds).
   */
  review?: { required?: boolean; max_rounds?: number; criterion_ceiling?: number; max_review_sessions?: number; review_wall_clock_minutes?: number };
}

/** Run the CLI in-process as the controller at `control`. */
export async function verCli(s: Pick<Ver, 'control'>, argv: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const withAuthority = asController(argv, s.control);
  const dd = withAuthority.indexOf('--');
  const withRoot = dd === -1 ? [...withAuthority, '--control-root', s.control] : [...withAuthority.slice(0, dd), '--control-root', s.control, ...withAuthority.slice(dd)];
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const code = await main(withRoot, io);
    return { code, out, err };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Build the repository, its control repository and (by default) the initialised feature. */
export async function createVer(options: VerOptions = {}): Promise<Ver> {
  const root = makeTmpDir('cset203-');
  const repo = makeGitRepo(join(root, 'changesets'), { files: BASE_FILES });
  const control = join(root, 'control');
  const setup = options.worktreeSetup ?? true;
  const entry: Record<string, unknown> = {
    name: 'changesets',
    path: relative(control, repo).replace(/\\/g, '/'),
    base_branch: 'main',
    commands: { test: VER_FULL_SUITE, ...(options.commands ?? {}) },
    tdd: { test_paths: ['packages/*/test/**'] },
    ...verModules('structured'),
    ...(setup === true ? { worktree_setup: { commands: [['node', '-e', '0']], timeout_seconds: 60 } } : typeof setup === 'object' ? { worktree_setup: setup } : {}),
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
            acceptance_review: options.review ?? { required: false },
          },
          null,
          2,
        ) + '\n',
      'repositories.yaml': YAML.stringify({ schema_version: 1, repositories: [entry] }, { lineWidth: 0 }),
    },
  });
  ensureScratchIgnored(control);
  commitAll(control, 'ignore the mycelink scratch area');
  const featureDir = join(control, 'features', VER_FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'PRD.md'), `# ${VER_FEATURE} Crash-safe changeset version\n\n${VER_CRITERIA.map((c) => `- ${c.text}`).join('\n')}\n`);
  const s: Ver = { root, control, repo, featureDir };
  writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(options.graph ?? verGraph(), { lineWidth: 0 }));
  if (options.init !== false) {
    const init = await verCli(s, ['feature', 'init', VER_FEATURE]);
    if (init.code !== 0) throw new Error(`feature init failed: ${init.err}`);
  }
  commitAll(control, 'feature scaffolding');
  return s;
}

export function verState(s: Ver): Record<string, any> {
  return JSON.parse(readFileSync(join(s.featureDir, 'STATE.json'), 'utf8')).data;
}

export function commitVerControl(s: Ver, message: string): void {
  if (git(s.control, ['status', '--porcelain']) === '') return;
  commitAll(s.control, message);
}

/** What each producer's worker does in its first submission: the tests, then the production change. */
export const VER_WORK: Record<string, { tests: Record<string, string>; impl: Record<string, string> }> = {
  [ARP]: { tests: { 'packages/apply-release-plan/test/apply.test.mjs': ARP_RED }, impl: { 'packages/apply-release-plan/src/index.mjs': ARP_IMPL } },
  [CLI]: { tests: { 'packages/cli/test/cli.test.mjs': CLI_RECOVERY_RED }, impl: { 'packages/cli/src/index.mjs': CLI_RECOVERY_IMPL } },
};

// ---- CSET-203 r2: AC-1 tested at one failure boundary only ------------------

export const ARP_TESTS = 'packages/apply-release-plan/test/apply.test.mjs';
export const ARP_SRC = 'packages/apply-release-plan/src/index.mjs';
export const CLI_TESTS = 'packages/cli/test/cli.test.mjs';
export const CLI_SRC = 'packages/cli/src/index.mjs';

/**
 * CSET-203 r2's apply-release-plan, in this fixture: it journals every file
 * it is about to change (AC-2) and a formatter crash after the files were
 * written rolls all of them back (the boundary its own test covers), but a
 * rollback restores only the changes that completed: a write that failed
 * part-way (a changelog it could not finish writing) is left as it was
 * left, half-written. Hidden acceptance's "when a changelog cannot be
 * written, every file is restored" fails on it.
 */
export const ARP_GAPPY_IMPL = `export const JOURNAL = '.changeset/.version-journal.json';

function restore(files, before) {
  for (const { path, content } of [...before].reverse()) {
    if (content === null) files.delete(path);
    else files.set(path, content);
  }
}

/** Apply a release plan; a failure restores what it changed and rejects with the failure as the cause. */
export async function applyReleasePlan(files, changes, { format = async () => {} } = {}) {
  const planned = changes.map((c) => ({ path: c.path, content: files.has(c.path) ? files.get(c.path) : null }));
  files.set(JOURNAL, JSON.stringify({ before: planned }));
  const changed = [];
  const touched = [];
  try {
    for (const [i, change] of changes.entries()) {
      if (change.content === null) files.delete(change.path);
      else files.set(change.path, change.content);
      changed.push(planned[i]);
      touched.push(change.path);
      await format(change.path);
    }
  } catch (error) {
    restore(files, changed);
    files.delete(JOURNAL);
    throw new Error('applying the release plan failed: ' + error.message, { cause: error });
  }
  files.delete(JOURNAL);
  return touched;
}

/** Restore what an interrupted run journaled; true when there was one. */
export function recoverInterruptedReleasePlan(files) {
  if (!files.has(JOURNAL)) return false;
  restore(files, JSON.parse(files.get(JOURNAL)).before);
  files.delete(JOURNAL);
  return true;
}
`;

/** The repair the review's gap drives: every file the plan was about to change is restored, the one that failed included. */
export const ARP_FIXED_IMPL = ARP_GAPPY_IMPL.replace('    restore(files, changed);\n', '    restore(files, planned);\n').replace('  const changed = [];\n', '').replace('      changed.push(planned[i]);\n', '');

export const ARP_CHANGELOG_TEST = 'restores every file exactly when the changelog writer fails part-way after the package version was written';

/** The focused RED the review rework adds: the changelog writer fails after the package/version write. */
export const ARP_REVIEW_RED = `${ARP_RED}
test('${ARP_CHANGELOG_TEST}', async () => {
  // A store whose next changelog write fails part-way, as a full disk would.
  class PartialChangelog extends Map {
    set(path, content) {
      if (this.armed && path.endsWith('CHANGELOG.md')) {
        this.armed = false;
        super.set(path, String(content).slice(0, 2));
        throw new Error('ENOSPC: no space left on device, write ' + path);
      }
      return super.set(path, content);
    }
  }
  const files = new PartialChangelog([['packages/a/package.json', '{"version":"1.0.0"}'], ['packages/a/CHANGELOG.md', '# a\\n\\n## 1.0.0\\n']]);
  files.armed = true;
  const plan = [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: 'packages/a/CHANGELOG.md', content: '# a\\n\\n## 2.0.0\\n\\n## 1.0.0\\n' }];
  const error = await applyReleasePlan(files, plan).then(() => null, (e) => e);
  assert.ok(error instanceof Error, 'it rejects');
  assert.match(String(error.cause?.message), /ENOSPC/);
  assert.deepEqual([...files].sort(), [['packages/a/CHANGELOG.md', '# a\\n\\n## 1.0.0\\n'], ['packages/a/package.json', '{"version":"1.0.0"}']]);
});
`;

/** The cli in one cycle: AC-3's recovery and AC-4's failure reporting together. */
export const CLI_FULL_WORK = { tests: { [CLI_TESTS]: CLI_FAILURE_RED }, impl: { [CLI_SRC]: CLI_IMPL } };

// ---- CSET-203 r3: AC-3's truncated journal and AC-5's status beside a journal ----

export const CLI_TRUNCATED_TEST = 'version recovers from a journal cut short by a kill, warns that the run was interrupted, then versions once';

/** The focused RED AC-3's review gap drives: a journal the kill cut short while it was written (r3's reviewer: "a truncated journal ... is unexercised"). */
export const CLI_TRUNCATED_RED = `${CLI_FAILURE_RED}
test('${CLI_TRUNCATED_TEST}', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/one.md', 'one'], ['.changeset/.version-journal.json', '{"before":[{"path":"packages/a/pack']]);
  const warnings = [];
  let code;
  try {
    code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }], io: { log() {}, warn: (m) => warnings.push(m), error() {} }, git: { add() {}, commit() {} } });
  } catch (error) {
    code = 'threw ' + error.message;
  }
  assert.equal(code, 0);
  assert.ok(warnings.some((w) => /interrupted/.test(w)), 'it warns that the last run was interrupted');
  assert.deepEqual([...files].sort(), [['packages/a/package.json', '{"version":"2.0.0"}']], 'versioned once, no journal left');
});
`;

/** The repair: a journal that cannot be read was cut short before the run changed anything, so it is removed, with the warning. */
export const CLI_TRUNCATED_IMPL = CLI_IMPL.replace(
  "import { applyReleasePlan, recoverInterruptedReleasePlan } from '../../apply-release-plan/src/index.mjs';\n",
  `import { JOURNAL, applyReleasePlan, recoverInterruptedReleasePlan } from '../../apply-release-plan/src/index.mjs';

/** Restore an interrupted run; a journal the kill cut short while it was written changed nothing yet, and is removed. */
function recover(files) {
  try {
    return recoverInterruptedReleasePlan(files);
  } catch {
    files.delete(JOURNAL);
    return true;
  }
}
`,
).replace('  if (recoverInterruptedReleasePlan(files)) io.warn(', '  if (recover(files)) io.warn(');

export const CLI_JOURNAL_STATUS_TEST = 'status is unaffected by a journal left in .changeset';

/** AC-5's regression test, as r3's reviewer reproduced the gap: status beside a journal. It passes on the code as it is. */
export const CLI_COMPAT_TEST_BODY = `
test('${CLI_JOURNAL_STATUS_TEST}', () => {
  const lines = [];
  status({ files: new Map([['.changeset/b.md', 'b'], ['.changeset/.version-journal.json', '{"before":[]}'], ['.changeset/a.md', 'a']]), io: { log: (l) => lines.push(l) } });
  assert.deepEqual(lines, ['.changeset/a.md', '.changeset/b.md']);
});
`;

/**
 * AC-5's regression test in a test file of its own (CSET-203 r4's journal-compat.test.ts): a
 * compatibility-regression unit after the code never touches a test file a RED of the rework bound.
 */
export const CLI_COMPAT_TESTS = 'packages/cli/test/journal-compat.test.mjs';
export const CLI_COMPAT_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status } from '../src/index.mjs';
${CLI_COMPAT_TEST_BODY}`;
/** The canonical id of AC-5's regression test in its own file. */
export const CLI_COMPAT_TEST_ID = canonicalTestId('junit-xml', CLI_COMPAT_TESTS, CLI_JOURNAL_STATUS_TEST);

/**
 * Hidden-like acceptance of r3's three gaps, run from outside on a checkout:
 * AC-1 at the changelog boundary (VER_CHANGELOG_ACCEPTANCE), AC-3 with a
 * journal cut short by a kill, AC-5 with status beside a journal and a
 * successful run that leaves no journal.
 */
export const VER_R3_ACCEPTANCE = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const cli = await import(pathToFileURL(join(root, 'packages/cli/src/index.mjs')).href);
const quiet = { log() {}, error() {} };
// AC-3: a journal cut short by a kill.
{
  const files = new Map([['packages/b/package.json', '{"version":"0.1.0"}'], ['.changeset/two.md', 'two'], ['.changeset/.version-journal.json', '{"bef']]);
  const warnings = [];
  const code = await cli.version({ files, changes: [{ path: 'packages/b/package.json', content: '{"version":"0.2.0"}' }, { path: '.changeset/two.md', content: null }], io: { ...quiet, warn: (m) => warnings.push(m) }, git: { add() {}, commit() {} } }).catch((e) => 'threw ' + e.message);
  assert.equal(code, 0, 'AC-3 a truncated journal is recovered from');
  assert.ok(warnings.some((w) => /interrupted/.test(w)), 'AC-3 warns interrupted');
  assert.deepEqual([...files].sort(), [['packages/b/package.json', '{"version":"0.2.0"}']], 'AC-3 versioned once, the journal gone');
}
// AC-5: status beside a journal, and a successful run leaves none.
{
  const lines = [];
  cli.status({ files: new Map([['.changeset/z.md', 'z'], ['.changeset/.version-journal.json', '{"before":[]}']]), io: { log: (l) => lines.push(l) } });
  assert.deepEqual(lines, ['.changeset/z.md'], 'AC-5 status is unaffected by a journal');
  const files = new Map([['packages/c/package.json', '{"version":"1.0.0"}']]);
  assert.equal(await cli.version({ files, changes: [{ path: 'packages/c/package.json', content: '{"version":"1.0.1"}' }], io: { ...quiet, warn() {} }, git: { add() {}, commit() {} } }), 0);
  assert.deepEqual([...files], [['packages/c/package.json', '{"version":"1.0.1"}']], 'AC-5 a successful run leaves no journal');
}
console.log('r3 acceptance: ok');
`;

/**
 * Hidden-like acceptance of AC-1 at the boundary r2's worker never tested,
 * run from outside on a checkout: two packages' versions written, then the
 * changelog of the first fails part-way; every file must be back to its
 * exact previous content or absence, and the cause kept.
 */
export const VER_CHANGELOG_ACCEPTANCE = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const arp = await import(pathToFileURL(join(root, 'packages/apply-release-plan/src/index.mjs')).href);
class UnwritableChangelog extends Map {
  set(path, content) {
    if (this.armed && path === 'packages/a/CHANGELOG.md') {
      this.armed = false;
      super.set(path, String(content).slice(0, 5));
      throw new Error('EACCES: permission denied, open ' + path);
    }
    return super.set(path, content);
  }
}
const before = [['.changeset/one.md', 'one'], ['packages/a/package.json', '{"version":"1.0.0"}'], ['packages/b/package.json', '{"version":"3.1.0"}']];
const files = new UnwritableChangelog(before);
files.armed = true;
const plan = [
  { path: 'packages/a/package.json', content: '{"version":"1.1.0"}' },
  { path: 'packages/b/package.json', content: '{"version":"3.2.0"}' },
  { path: 'packages/a/CHANGELOG.md', content: '# a\\n\\n## 1.1.0\\n' },
  { path: '.changeset/one.md', content: null },
];
const error = await arp.applyReleasePlan(files, plan).then(() => null, (e) => e);
assert.ok(error instanceof Error, 'AC-1 rejects');
assert.match(String(error.cause?.message), /EACCES/, 'AC-1 cause');
assert.deepEqual([...files].sort(), before, 'AC-1 every file restored to its exact previous content or absence');
console.log('changelog acceptance: ok');
`;
