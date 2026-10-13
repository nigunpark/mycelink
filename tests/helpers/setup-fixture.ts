/**
 * A CSET-201-shaped portfolio for worktree setup: one repository whose
 * build and tests need an installed, untracked `node_modules` (a tool from
 * an offline "store"), with that `node_modules` present in the base
 * checkout only — as the benchmark scaffold left Changesets. The feature has
 * a declaration-only node (types, GREEN and regression only), then two
 * implementation nodes depending on it (reasons, then cli), then the
 * candidate build.
 *
 * The repository's worktree_setup, when given, runs an offline installer
 * outside every checkout. What it does is steered by a mode file, so a test
 * can make it fail, or change a tracked file, without changing the
 * configuration (which would itself be a config drift).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { main, type CliIo } from '../../src/cli/cli.js';
import { buildHookSettings } from '../../src/workspace/hook-settings.js';
import { ensureScratchIgnored } from '../../src/workspace/workspace.js';
import { asController } from './authority.js';
import { commitAll, git, makeGitRepo } from './git-fixture.js';
import { makeTmpDir } from './tmp.js';

export const SETUP_FEATURE = 'FEAT-777';
export const TYPES = `${SETUP_FEATURE}.app.types.impl`;
export const REASONS = `${SETUP_FEATURE}.app.reasons.impl`;
export const EXPLAIN = `${SETUP_FEATURE}.app.cli.impl`;
export const SETUP_CANDIDATE = `${SETUP_FEATURE}.release.candidate.build`;

/** The project's own build-and-test runner: it needs the installed tool, as Changesets needs tsdown. */
const RUNNER = `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const tool = join(root, 'node_modules', 'fixture-build', 'index.mjs');
if (!existsSync(tool)) {
  console.error('$ fixture-build');
  console.error('sh: 1: fixture-build: command not found');
  console.error('[WARN] Local package.json exists, but node_modules missing, did you mean to install?');
  process.exit(127);
}
const { build } = await import(pathToFileURL(tool).href);
build(root);
const checks = [
  ['tests/reasons/reasons.test.mjs', 'src/reasons/index.js', 'RECORDS_REASONS'],
  ['tests/cli/explain.test.mjs', 'src/cli/explain.js', 'EXPLAINS_REASONS'],
];
for (const [test, src, marker] of checks) {
  if (!existsSync(join(root, test))) continue;
  const file = join(root, src);
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes(marker)) {
    console.error('AssertionError: expected ' + src + ' to contain ' + marker);
    process.exit(1);
  }
}
console.log('ok - every check passed');
`;

/** The offline installer worktree_setup names. */
const INSTALLER = `import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const modeFile = process.env.FIXTURE_MODE_FILE;
const mode = modeFile && existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'ok';
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ cwd: process.cwd(), mode, env: process.env }) + '\\n');
if (mode === 'fail') {
  console.error('ERR_PNPM_NO_OFFLINE_TARBALL  A package is missing from the store but cannot download it in offline mode.');
  process.exit(1);
}
cpSync(process.env.FIXTURE_STORE, join(process.cwd(), 'node_modules'), { recursive: true });
if (mode === 'tracked') writeFileSync(join(process.cwd(), 'README.md'), '# rewritten by the installer\\n');
console.log('Done: installed offline');
`;

export interface SetupPortfolio {
  root: string;
  control: string;
  app: string;
  featureDir: string;
  store: string;
  installer: string;
  /** One JSON line per installer run: { cwd, mode, env }. */
  log: string;
  modeFile: string;
}

export interface SetupFixtureOptions {
  /** Configure worktree_setup (default true). */
  worktreeSetup?: boolean;
  /** Extra env for the installer's configuration (a config drift when changed later). */
  setupEnv?: Record<string, string>;
  /** The graph's nodes, defaults to types -> reasons -> cli -> candidate. */
  graph?: Record<string, unknown>;
  writerConcurrency?: number;
  /** Declaration paths of the repository's tdd policy (default src/types/**). */
  declarationPaths?: string[] | null;
}

export function setupConfig(p: Pick<SetupPortfolio, 'installer' | 'store' | 'log' | 'modeFile'>, env: Record<string, string> = {}): Record<string, unknown> {
  return {
    commands: [['node', p.installer, '--frozen-lockfile', '--offline']],
    timeout_seconds: 120,
    env: { FIXTURE_STORE: p.store, FIXTURE_LOG: p.log, FIXTURE_MODE_FILE: p.modeFile, ...env },
    required_paths: ['node_modules'],
  };
}

function worker(): Record<string, unknown> {
  return { model: 'sonnet', effort: 'high', max_turns: 20, max_wall_clock_minutes: 5, max_attempts: 2, nested_delegation: false };
}

function node(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    level: 'executable-node',
    repository: 'app',
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    verification_commands: [{ id: 'build-and-test', command: ['node', 'tests/run.mjs'] }],
    worker: worker(),
    invalidation_rules: [],
    ...extra,
  };
}

/** types (declaration-only) -> reasons -> cli -> candidate, as the CSET-201 r1 controller planned it. */
export function setupGraph(): Record<string, unknown> {
  return {
    schema_version: 1,
    feature_id: SETUP_FEATURE,
    title: 'Explain why each package is in the release plan',
    prd: 'PRD.md',
    acceptance_criteria: [
      { id: 'AC-1', text: 'types: ReleaseReason union and optional reasons' },
      { id: 'AC-2', text: 'the planner records reasons' },
      { id: 'AC-3', text: 'status --explain prints them' },
    ],
    resources: { workspace: { capacity: 1 } },
    repositories: ['app'],
    capabilities: [
      { id: 'CAP-TYPES', repository: 'app', title: 'ReleaseReason types', acceptance_criteria: ['AC-1'] },
      { id: 'CAP-REASONS', repository: 'app', title: 'Record release reasons', acceptance_criteria: ['AC-2'] },
      { id: 'CAP-CLI', repository: 'app', title: 'status --explain', acceptance_criteria: ['AC-3'] },
    ],
    nodes: [
      node(TYPES, { capability: 'CAP-TYPES', node_type: 'contract-lock', depends_on: [], allowed_paths: ['src/types/**'], required_evidence: ['green', 'regression'], acceptance_criteria: ['AC-1'] }),
      node(REASONS, { capability: 'CAP-REASONS', node_type: 'implementation', depends_on: [TYPES], allowed_paths: ['src/reasons/**', 'tests/reasons/**'], required_evidence: ['red', 'green', 'regression'], acceptance_criteria: ['AC-2'] }),
      node(EXPLAIN, { capability: 'CAP-CLI', node_type: 'implementation', depends_on: [REASONS], allowed_paths: ['src/cli/**', 'tests/cli/**'], required_evidence: ['red', 'green', 'regression'], acceptance_criteria: ['AC-3'] }),
      {
        id: SETUP_CANDIDATE,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: [TYPES, REASONS, EXPLAIN],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', SETUP_FEATURE] }],
        worker: { ...worker(), max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

/** What each node's worker does: the declaration change alone, then two complete RED -> GREEN cycles. */
export const SETUP_WORK = {
  [TYPES]: { impl: { 'src/types/index.d.ts': 'export type ReleaseReason = { type: "changeset"; changeset: string };\n' } },
  [REASONS]: {
    tests: { 'tests/reasons/reasons.test.mjs': "import { test } from 'node:test';\n\ntest('records one reason per decision', () => {});\n" },
    impl: { 'src/reasons/index.js': 'export const RECORDS_REASONS = true;\n' },
  },
  [EXPLAIN]: {
    tests: { 'tests/cli/explain.test.mjs': "import { test } from 'node:test';\n\ntest('prints one line per reason', () => {});\n" },
    impl: { 'src/cli/explain.js': 'export const EXPLAINS_REASONS = true;\n' },
  },
};

/** Run the CLI in-process as the controller at `control`. */
export async function cliAt(control: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const withAuthority = asController(argv, control);
  const dd = withAuthority.indexOf('--');
  const withRoot = dd === -1 ? [...withAuthority, '--control-root', control] : [...withAuthority.slice(0, dd), '--control-root', control, ...withAuthority.slice(dd)];
  const code = await main(withRoot, io);
  return { code, out, err };
}

/** Build the portfolio, install the base checkout's dependencies, initialise the feature and commit the control repository. */
export async function setupPortfolio(options: SetupFixtureOptions = {}): Promise<SetupPortfolio> {
  // A space in every path: setup, gates and verification must never split one.
  const root = makeTmpDir('setup portfolio-');
  const store = join(root, 'offline store');
  mkdirSync(join(store, 'fixture-build'), { recursive: true });
  writeFileSync(join(store, 'fixture-build', 'index.mjs'), "export function build(root) { console.log('built ' + root); }\n");
  mkdirSync(join(store, '.bin'), { recursive: true });
  writeFileSync(join(store, '.bin', 'fixture-build'), '#!/bin/sh\necho built\n');
  const installer = join(root, 'toolchain', 'install.mjs');
  mkdirSync(join(root, 'toolchain'), { recursive: true });
  writeFileSync(installer, INSTALLER);
  const log = join(root, 'setup-runs.jsonl');
  const modeFile = join(root, 'setup-mode');

  const app = makeGitRepo(join(root, 'app'), {
    files: {
      '.gitignore': 'node_modules/\n',
      'package.json': '{ "name": "app", "private": true, "scripts": { "build": "fixture-build" } }\n',
      'README.md': '# app\n',
      'src/types/.gitkeep': '',
      'tests/run.mjs': RUNNER,
    },
  });
  // The base checkout's dependencies, installed as the scaffold installs them: untracked and ignored.
  const install = spawnSync(process.execPath, [installer], { cwd: app, env: { ...process.env, FIXTURE_STORE: store, FIXTURE_LOG: join(root, 'base-install.jsonl') }, encoding: 'utf8' });
  if (install.status !== 0) throw new Error(`base install failed: ${install.stderr}`);
  if (git(app, ['status', '--porcelain', '--untracked-files=all']) !== '') throw new Error('the base checkout is not clean after its install');

  const control = join(root, 'control');
  const repo: Record<string, unknown> = {
    name: 'app',
    path: relative(control, app).replace(/\\/g, '/'),
    base_branch: 'main',
    commands: { test: ['node', 'tests/run.mjs'] },
    ...(options.declarationPaths === null ? {} : { tdd: { declaration_paths: options.declarationPaths ?? ['src/types/**'] } }),
    ...(options.worktreeSetup === false ? {} : { worktree_setup: setupConfig({ installer, store, log, modeFile }, options.setupEnv) }),
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
            context_pack_max_bytes: 16384,
            hook_session_start_max_bytes: 4096,
            hook_prompt_delta_max_bytes: 2048,
            brain_dir: null,
            // These fixtures predate the acceptance review (engine/acceptance-review.ts); its own tests turn it on.
            acceptance_review: { required: false },
          },
          null,
          2,
        ) + '\n',
      'repositories.yaml': YAML.stringify({ schema_version: 1, repositories: [repo] }, { lineWidth: 0 }),
    },
  });
  ensureScratchIgnored(control);
  commitAll(control, 'ignore the mycelink scratch area');
  const featureDir = join(control, 'features', SETUP_FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'PRD.md'), `# ${SETUP_FEATURE}\n\n- AC-1 types\n- AC-2 reasons\n- AC-3 cli\n`);
  writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(options.graph ?? setupGraph(), { lineWidth: 0 }));
  const init = await cliAt(control, ['feature', 'init', SETUP_FEATURE, ...(options.writerConcurrency ? ['--writer-concurrency', String(options.writerConcurrency)] : [])]);
  if (init.code !== 0) throw new Error(`feature init failed: ${init.err}`);
  commitAll(control, 'feature scaffolding');
  return { root, control, app, featureDir, store, installer, log, modeFile };
}

/** The installer runs so far. */
export function setupRuns(p: SetupPortfolio): { cwd: string; mode: string; env: Record<string, string> }[] {
  return existsSync(p.log) ? readFileSync(p.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export function setMode(p: SetupPortfolio, mode: 'ok' | 'fail' | 'tracked'): void {
  writeFileSync(p.modeFile, mode + '\n');
}

export function featureState(p: SetupPortfolio): Record<string, any> {
  return JSON.parse(readFileSync(join(p.featureDir, 'STATE.json'), 'utf8')).data;
}

export function commitControlRepo(p: SetupPortfolio, message: string): void {
  if (git(p.control, ['status', '--porcelain']) === '') return;
  commitAll(p.control, message);
}
