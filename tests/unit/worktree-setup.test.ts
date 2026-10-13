/**
 * Worktree setup: the dependencies a git worktree does not carry (an
 * untracked node_modules, say) are materialised by the controller, in each
 * worktree, before anything runs there. CSET-201 r1: the base repository had
 * node_modules, every node worktree had none, and the first worker's
 * legitimate GREEN (`pnpm build`) exited 127.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKTREE_SETUP_TIMEOUT_SECONDS,
  reusableSetup,
  runWorktreeSetup,
  setupEnvironment,
  setupInputs,
  worktreeSetupOf,
  worktreeSetupSha256,
  type WorktreeSetupConfig,
} from '../../src/engine/worktree-setup.js';
import { validateRepositories } from '../../src/graph/validate.js';
import { git, makeGitRepo } from '../helpers/git-fixture.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

afterAll(() => cleanupTmpRoots());

/** The offline installer a repository's worktree_setup names: copies a store into ./node_modules, and logs what it saw. */
const INSTALLER = `import { appendFileSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const mode = process.env.FIXTURE_MODE ?? 'ok';
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env: process.env }) + '\\n');
const id = { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.invalid' };
if (mode === 'fail') { console.error('ERR_PNPM_NO_OFFLINE_TARBALL: a package is missing from the store'); process.exit(3); }
if (mode === 'sleep') { await new Promise((r) => setTimeout(r, 20000)); }
if (mode === 'escape') { symlinkSync(process.env.FIXTURE_OUTSIDE, join(process.cwd(), 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); process.exit(0); }
cpSync(process.env.FIXTURE_STORE, join(process.cwd(), 'node_modules'), { recursive: true });
if (mode === 'tracked') writeFileSync(join(process.cwd(), 'src', 'index.js'), 'export const rewritten = true;\\n');
if (mode === 'untracked') writeFileSync(join(process.cwd(), 'setup-output.txt'), 'left behind\\n');
if (mode === 'git-config') spawnSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: process.cwd() });
if (mode === 'hook') writeFileSync(join(process.env.FIXTURE_HOOKS, 'pre-commit'), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
if (mode === 'commit') spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'setup committed'], { cwd: process.cwd(), env: id });
console.log('installed ' + (process.argv[2] ?? ''));
`;

interface Fixture {
  root: string;
  repo: string;
  worktrees: string;
  worktree: string;
  store: string;
  log: string;
  installer: string;
  evidence: string;
  outside: string;
}

function fixture(name = 'node'): Fixture {
  const root = makeTmpDir('wt-setup-');
  const repo = makeGitRepo(join(root, 'repo'), {
    files: {
      '.gitignore': 'node_modules/\n',
      'package.json': '{ "name": "fixture", "private": true }\n',
      'src/index.js': 'export const value = 1;\n',
    },
  });
  const store = join(root, 'store');
  mkdirSync(join(store, '.bin'), { recursive: true });
  mkdirSync(join(store, 'fixture-tool'), { recursive: true });
  writeFileSync(join(store, 'fixture-tool', 'index.mjs'), 'export const tool = true;\n');
  writeFileSync(join(store, '.bin', 'fixture-build'), '#!/bin/sh\necho built\n');
  const installer = join(root, 'toolchain', 'install.mjs');
  mkdirSync(join(root, 'toolchain'), { recursive: true });
  writeFileSync(installer, INSTALLER);
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  const worktrees = join(root, 'control', '.mycelink', 'worktrees');
  mkdirSync(worktrees, { recursive: true });
  const worktree = join(worktrees, `repo__${name}`);
  git(repo, ['worktree', 'add', '-q', '-b', `wip/${name}`, worktree, 'main']);
  const evidence = join(root, 'control', 'features', 'F-1', 'evidence', 'node');
  return { root, repo, worktrees, worktree, store, log: join(root, 'setup-runs.jsonl'), installer, evidence, outside };
}

function config(f: Fixture, mode = 'ok', extra: Partial<WorktreeSetupConfig> = {}): WorktreeSetupConfig {
  return {
    commands: [['node', f.installer, '--offline']],
    timeout_seconds: 60,
    env: { FIXTURE_MODE: mode, FIXTURE_STORE: f.store, FIXTURE_LOG: f.log, FIXTURE_OUTSIDE: f.outside, FIXTURE_HOOKS: join(f.repo, '.git', 'hooks'), WHERE: '${WORKTREE}' },
    required_paths: ['node_modules'],
    ...extra,
  };
}

function run(f: Fixture, cfg: WorktreeSetupConfig, worktree = f.worktree, base: NodeJS.ProcessEnv = process.env) {
  return runWorktreeSetup({
    controlRoot: join(f.root, 'control'),
    repository: 'repo',
    repoPath: f.repo,
    worktree,
    root: f.worktrees,
    config: cfg,
    evidenceDir: f.evidence,
    label: 'node.setup-test',
    base,
  });
}

const runs = (f: Fixture): { cwd: string; argv: string[]; env: Record<string, string> }[] =>
  existsSync(f.log) ? readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

describe('worktree_setup in repositories.yaml', () => {
  const repo = (setup: unknown): unknown => ({
    schema_version: 1,
    repositories: [{ name: 'changesets', path: '../repos/changesets', base_branch: 'main', commands: { test: ['pnpm', 'test'] }, worktree_setup: setup }],
  });
  const install = ['pnpm', 'install', '--frozen-lockfile', '--offline', '--filter=!@changesets/e2e', '--package-import-method=copy'];

  it('is optional, and normalised with defaults when present', () => {
    expect(worktreeSetupOf({})).toBeNull();
    expect(worktreeSetupOf({ worktree_setup: { commands: [install] } })).toEqual({
      commands: [install],
      timeout_seconds: DEFAULT_WORKTREE_SETUP_TIMEOUT_SECONDS,
      env: {},
      required_paths: [],
    });
    expect(validateRepositories(repo({ commands: [install], timeout_seconds: 900, env: { pnpm_config_store_dir: '${HOME}/.local/share/pnpm/store', CI: '1' }, required_paths: ['node_modules'] })).ok).toBe(true);
  });

  it('accepts argv commands only: a shell string, an empty or option-like executable is refused', () => {
    for (const bad of [
      { commands: 'pnpm install' },
      { commands: [] },
      { commands: [[]] },
      { commands: [['-rf', '/']] },
      { commands: [['pnpm\ninstall']] },
    ]) {
      expect(validateRepositories(repo(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('allows only the ${HOME}, ${WORKTREE} and ${TMPDIR} placeholders, and no environment that would hijack the session', () => {
    expect(validateRepositories(repo({ commands: [install], env: { STORE: '${HOME}/s', WT: '${WORKTREE}', T: '${TMPDIR}/x' } })).ok).toBe(true);
    for (const env of [{ X: '${CLAUDE_AUTHORITY}' }, { X: '${HOME' }, { X: '$HOME/${PATH}' }, { PATH: '/tmp' }, { HOME: '/tmp' }, { NODE_OPTIONS: '--require /tmp/x.js' }, { LD_PRELOAD: '/tmp/x.so' }, { DYLD_INSERT_LIBRARIES: 'x' }, { MYCELINK_CAPABILITY: 'x' }, { 'BAD NAME': 'x' }]) {
      const r = validateRepositories(repo({ commands: [install], env }));
      expect(r.ok, JSON.stringify(env)).toBe(false);
      expect(r.problems.map((p) => p.code).join(',')).toMatch(/WORKTREE_SETUP|schema|SCHEMA|must/i);
    }
  });

  it('keeps required paths inside the worktree, outside .git, on every platform', () => {
    expect(validateRepositories(repo({ commands: [install], required_paths: ['node_modules', 'node_modules/.bin/tsdown', 'packages\\types\\node_modules'] })).ok).toBe(true);
    for (const p of ['../outside', '/etc/passwd', 'C:\\Windows', 'C:node_modules', '\\\\server\\share\\x', '//?/C:/x', 'node_modules:stream', '.git', '.git/hooks', 'a/../../b', 'nul', 'node_modules/*']) {
      expect(validateRepositories(repo({ commands: [install], required_paths: [p] })).ok, p).toBe(false);
    }
  });

  it('bounds the timeout', () => {
    expect(validateRepositories(repo({ commands: [install], timeout_seconds: 0 })).ok).toBe(false);
    expect(validateRepositories(repo({ commands: [install], timeout_seconds: 7201 })).ok).toBe(false);
  });

  it('hashes what runs: argv, timeout, env and required paths, not their key order', () => {
    const a: WorktreeSetupConfig = { commands: [install], timeout_seconds: 900, env: { A: '1', B: '2' }, required_paths: ['node_modules'] };
    const b: WorktreeSetupConfig = { required_paths: ['node_modules'], env: { B: '2', A: '1' }, timeout_seconds: 900, commands: [install] };
    expect(worktreeSetupSha256(a)).toBe(worktreeSetupSha256(b));
    expect(worktreeSetupSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(worktreeSetupSha256({ ...a, commands: [[...install, '--prod']] })).not.toBe(worktreeSetupSha256(a));
    expect(worktreeSetupSha256({ ...a, env: { A: '1', B: '3' } })).not.toBe(worktreeSetupSha256(a));
  });
});

describe('the setup environment', () => {
  const cfg: WorktreeSetupConfig = { commands: [['pnpm', 'install']], timeout_seconds: 60, env: { pnpm_config_store_dir: '${HOME}/.local/share/pnpm/store', WT: '${WORKTREE}/x', T: '${TMPDIR}', npm_config_registry: 'http://127.0.0.1:9/' }, required_paths: [] };
  const base = {
    PATH: '/opt/node/bin:/usr/bin',
    HOME: '/sandbox/home',
    LANG: 'C.UTF-8',
    XDG_CACHE_HOME: '/sandbox/home/.cache',
    COREPACK_HOME: '/sandbox/home/.cache/node/corepack',
    HTTPS_PROXY: 'http://127.0.0.1:3128',
    http_proxy: 'http://127.0.0.1:3128',
    ALL_PROXY: 'socks5://x',
    NO_PROXY: 'localhost',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    MYCELINK_CAPABILITY: 'cap',
    MYCELINK_CONTROL_ROOT: '/ctl',
    CLAUDE_PID: '123',
    NODE_OPTIONS: '--require /tmp/evil.js',
    GIT_DIR: '/elsewhere/.git',
    npm_config_registry: 'https://registry.npmjs.org/',
    GITHUB_TOKEN: 'ghp_x',
    SSH_AUTH_SOCK: '/tmp/agent',
  };

  it("is the session's toolchain locations and the configured values: no proxy, credential, controller or loader variable", () => {
    const env = setupEnvironment({ config: cfg, worktree: '/ws/wt', tmp: '/ws/.tmp/setup', base, platform: 'linux' });
    expect(env).toMatchObject({
      PATH: '/opt/node/bin:/usr/bin',
      HOME: '/sandbox/home',
      LANG: 'C.UTF-8',
      XDG_CACHE_HOME: '/sandbox/home/.cache',
      COREPACK_HOME: '/sandbox/home/.cache/node/corepack',
      pnpm_config_store_dir: '/sandbox/home/.local/share/pnpm/store',
      WT: '/ws/wt/x',
      T: '/ws/.tmp/setup',
      TMPDIR: '/ws/.tmp/setup',
      TMP: '/ws/.tmp/setup',
      TEMP: '/ws/.tmp/setup',
      npm_config_registry: 'http://127.0.0.1:9/',
    });
    for (const k of ['HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'NO_PROXY', 'ANTHROPIC_API_KEY', 'MYCELINK_CAPABILITY', 'MYCELINK_CONTROL_ROOT', 'CLAUDE_PID', 'NODE_OPTIONS', 'GIT_DIR', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) {
      expect(env[k], k).toBeUndefined();
    }
  });

  it('keeps what Windows needs to start a process, and takes HOME from USERPROFILE there', () => {
    const env = setupEnvironment({
      config: cfg,
      worktree: 'C:\\ws\\wt',
      tmp: 'C:\\ws\\tmp',
      base: { Path: 'C:\\node;C:\\Windows\\System32', SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE;.CMD', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', HTTPS_PROXY: 'x' },
      platform: 'win32',
    });
    expect(env).toMatchObject({ Path: 'C:\\node;C:\\Windows\\System32', SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE;.CMD', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', pnpm_config_store_dir: 'C:\\Users\\me/.local/share/pnpm/store' });
    expect(env['HTTPS_PROXY']).toBeUndefined();
  });

  it('refuses to run when a placeholder has nothing to stand for', () => {
    expect(() => setupEnvironment({ config: cfg, worktree: '/ws/wt', tmp: '/t', base: { PATH: '/usr/bin' }, platform: 'linux' })).toThrow(/HOME/);
  });
});

describe('runWorktreeSetup', () => {
  it('materialises the dependencies in the worktree, with argv and no shell, and records a receipt bound to the worktree, its commit and the config', () => {
    const f = fixture();
    expect(existsSync(join(f.repo, '.git'))).toBe(true);
    expect(existsSync(join(f.worktree, 'node_modules'))).toBe(false);
    const cfg = config(f, 'ok', { commands: [['node', f.installer, '$(touch pwned); echo `id`']] });
    const r = run(f, cfg, f.worktree, { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:3128', MYCELINK_CAPABILITY: 'cap-secret' });
    expect(r.receipt).toMatchObject({
      schema: 'mycelink-worktree-setup/1',
      status: 'complete',
      code: null,
      repository: 'repo',
      head_sha: git(f.worktree, ['rev-parse', 'HEAD']),
      config_sha256: worktreeSetupSha256(cfg),
      required_paths: ['node_modules'],
    });
    expect(r.receipt.commands).toEqual([expect.objectContaining({ argv: ['node', f.installer, '$(touch pwned); echo `id`'], exit_code: 0, timed_out: false })]);
    expect(existsSync(join(f.worktree, 'node_modules', 'fixture-tool', 'index.mjs'))).toBe(true);
    expect(existsSync(join(f.worktree, 'pwned'))).toBe(false);
    const seen = runs(f)[0] as { cwd: string; argv: string[]; env: Record<string, string> };
    expect(resolve(seen.cwd).toLowerCase()).toBe(resolve(f.worktree).toLowerCase());
    expect(seen.argv).toEqual(['$(touch pwned); echo `id`']);
    expect(seen.env['WHERE']).toBe(f.worktree);
    expect(seen.env['HTTPS_PROXY']).toBeUndefined();
    expect(seen.env['MYCELINK_CAPABILITY']).toBeUndefined();
    // The receipt and the log are evidence: inside the control root, hashed.
    const control = join(f.root, 'control');
    expect(r.receipt_path).not.toMatch(/^[\\/]|^[A-Za-z]:/);
    expect(existsSync(join(control, r.receipt_path))).toBe(true);
    expect(existsSync(join(control, r.receipt.output_path))).toBe(true);
    expect(readFileSync(join(control, r.receipt.output_path), 'utf8')).toContain('installed');
    expect(r.record).toMatchObject({ status: 'complete', receipt_sha256: r.receipt_sha256, config_sha256: worktreeSetupSha256(cfg), head_sha: r.receipt.head_sha });
    expect(git(f.worktree, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('fails a command that exits non-zero, keeping its log', () => {
    const f = fixture();
    const r = run(f, config(f, 'fail'));
    expect(r.receipt).toMatchObject({ status: 'failed', code: 'COMMAND_FAILED' });
    expect(r.receipt.commands[0]).toMatchObject({ exit_code: 3 });
    expect(readFileSync(join(f.root, 'control', r.receipt.output_path), 'utf8')).toContain('ERR_PNPM_NO_OFFLINE_TARBALL');
  });

  it('stops a setup at its timeout', () => {
    const f = fixture();
    const started = Date.now();
    const r = run(f, config(f, 'sleep', { timeout_seconds: 1 }));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.receipt).toMatchObject({ status: 'failed', code: 'TIMED_OUT' });
  });

  it('refuses a setup that changes a tracked file, leaves untracked output, moves HEAD or touches git configuration', () => {
    const tracked = fixture('tracked');
    expect(run(tracked, config(tracked, 'tracked')).receipt).toMatchObject({ status: 'failed', code: 'TRACKED_MUTATION' });

    const untracked = fixture('untracked');
    expect(run(untracked, config(untracked, 'untracked')).receipt).toMatchObject({ status: 'failed', code: 'UNTRACKED_OUTPUT' });

    const commit = fixture('commit');
    expect(run(commit, config(commit, 'commit')).receipt).toMatchObject({ status: 'failed', code: 'HEAD_MOVED' });

    const cfgChange = fixture('config');
    const r = run(cfgChange, config(cfgChange, 'git-config'));
    expect(r.receipt).toMatchObject({ status: 'failed', code: 'CONFIG_SIDE_EFFECT' });
    // ... and the shared repository configuration is put back.
    expect(() => git(cfgChange.repo, ['config', '--get', 'core.hooksPath'])).toThrow();

    const hook = fixture('hook');
    expect(run(hook, config(hook, 'hook')).receipt).toMatchObject({ status: 'failed', code: 'CONFIG_SIDE_EFFECT' });
    expect(existsSync(join(hook.repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('requires every required path, inside the worktree', () => {
    const missing = fixture('missing');
    expect(run(missing, config(missing, 'ok', { required_paths: ['node_modules/.bin/tsdown'] })).receipt).toMatchObject({ status: 'failed', code: 'REQUIRED_PATH_MISSING' });

    const escape = fixture('escape');
    expect(run(escape, config(escape, 'escape')).receipt).toMatchObject({ status: 'failed', code: 'PATH_ESCAPE' });
  });

  it('runs only in a real worktree of the repository, inside the worktree root', () => {
    const f = fixture();
    const elsewhere = join(f.root, 'elsewhere');
    git(f.repo, ['worktree', 'add', '-q', '--detach', elsewhere, 'main']);
    expect(run(f, config(f), elsewhere).receipt).toMatchObject({ status: 'failed', code: 'WORKTREE_INVALID' });
    expect(runs(f)).toEqual([]);

    const link = join(f.worktrees, 'repo__link');
    symlinkSync(f.worktree, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(run(f, config(f), link).receipt).toMatchObject({ status: 'failed', code: 'WORKTREE_INVALID' });

    const plain = join(f.worktrees, 'repo__plain');
    mkdirSync(plain);
    expect(run(f, config(f), plain).receipt).toMatchObject({ status: 'failed', code: 'WORKTREE_INVALID' });
    expect(runs(f)).toEqual([]);
  });

  it('handles a worktree root with spaces and a Windows-style spelling of the same path', () => {
    const f = fixture();
    const spaced = join(f.root, 'control', '.mycelink', 'work tree root');
    mkdirSync(spaced, { recursive: true });
    const wt = join(spaced, 'repo__node two');
    git(f.repo, ['worktree', 'add', '-q', '-b', 'wip/two', wt, 'main']);
    const r = runWorktreeSetup({
      controlRoot: join(f.root, 'control'),
      repository: 'repo',
      repoPath: f.repo,
      worktree: process.platform === 'win32' ? wt.replace(/\\/g, '/') : wt,
      root: spaced,
      config: config(f),
      evidenceDir: f.evidence,
      label: 'node.setup-spaced',
    });
    expect(r.receipt).toMatchObject({ status: 'complete' });
    expect(existsSync(join(wt, 'node_modules', 'fixture-tool'))).toBe(true);
  });
});

describe('reusableSetup', () => {
  function completed(name = 'node') {
    const f = fixture(name);
    const cfg = config(f);
    const r = run(f, cfg);
    expect(r.receipt.status).toBe('complete');
    const args = { controlRoot: join(f.root, 'control'), record: r.record, worktree: f.worktree, headSha: git(f.worktree, ['rev-parse', 'HEAD']), config: cfg };
    return { f, cfg, r, args };
  }

  it('reuses a receipt that binds this worktree, its commit and this config, with every required path present', () => {
    const { args } = completed();
    expect(reusableSetup(args)).toEqual({ ok: true });
  });

  it('refuses a tampered receipt', () => {
    const { f, r, args } = completed();
    const file = join(f.root, 'control', r.receipt_path);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"complete"', '"complete" '));
    expect(reusableSetup(args)).toMatchObject({ ok: false, reason: expect.stringMatching(/RECEIPT_TAMPERED/) });
  });

  it('refuses after the worktree moved to another commit (commit drift)', () => {
    const { f, args } = completed();
    writeFileSync(join(f.worktree, 'package.json'), '{ "name": "fixture", "private": true, "dependencies": { "x": "1" } }\n');
    git(f.worktree, ['commit', '-q', '-am', 'a dependency changed']);
    expect(reusableSetup({ ...args, headSha: git(f.worktree, ['rev-parse', 'HEAD']) })).toMatchObject({ ok: false, reason: expect.stringMatching(/COMMIT_DRIFT/) });
  });

  it('refuses after the configured setup changed (config drift)', () => {
    const { cfg, args } = completed();
    expect(reusableSetup({ ...args, config: { ...cfg, commands: [[...(cfg.commands[0] as string[]), '--prod']] } })).toMatchObject({ ok: false, reason: expect.stringMatching(/CONFIG_DRIFT/) });
  });

  it('refuses when a required path is gone', () => {
    const { f, args } = completed();
    rmSync(join(f.worktree, 'node_modules'), { recursive: true, force: true });
    expect(reusableSetup(args)).toMatchObject({ ok: false, reason: expect.stringMatching(/REQUIRED_PATH_MISSING/) });
  });

  it('refuses for a worktree recreated at the same path, even with its dependencies copied back', () => {
    const { f, args } = completed();
    const saved = join(f.root, 'saved-node_modules');
    // Keep a copy of the installed tree, recreate the worktree, put the copy back.
    git(f.repo, ['worktree', 'remove', '--force', f.worktree]);
    git(f.repo, ['worktree', 'add', '-q', f.worktree, 'wip/node']);
    mkdirSync(join(f.worktree, 'node_modules', 'fixture-tool'), { recursive: true });
    appendFileSync(join(f.worktree, 'node_modules', 'fixture-tool', 'index.mjs'), 'export const tool = true;\n');
    void saved;
    expect(reusableSetup(args)).toMatchObject({ ok: false, reason: expect.stringMatching(/WORKTREE_CHANGED/) });
  });

  describe('with declared inputs', () => {
    const INPUTS = { inputs: ['package.json', '**/package.json'] };
    function withInputs(name = 'node') {
      const f = fixture(name);
      const cfg = config(f, 'ok', INPUTS);
      const r = run(f, cfg);
      expect(r.receipt.status).toBe('complete');
      const args = { controlRoot: join(f.root, 'control'), record: r.record, worktree: f.worktree, headSha: git(f.worktree, ['rev-parse', 'HEAD']), config: cfg };
      return { f, cfg, r, args };
    }

    it('binds the inputs git sees, by content, and not what the setup installed under an ignored directory', () => {
      const { f, r } = withInputs();
      // The installed tree has manifests of its own; they are ignored output, not inputs.
      mkdirSync(join(f.worktree, 'node_modules', 'fixture-tool'), { recursive: true });
      writeFileSync(join(f.worktree, 'node_modules', 'fixture-tool', 'package.json'), '{}\n');
      expect(Object.keys(r.receipt.input_files ?? {})).toEqual(['package.json']);
      expect(setupInputs(f.worktree, { inputs: INPUTS.inputs })).toEqual({ sha256: r.receipt.inputs_sha256, files: r.receipt.input_files });
    });

    it('reuses a receipt at another commit when the commit changed no input: an integration that moved other packages', () => {
      const { f, args } = withInputs();
      writeFileSync(join(f.worktree, 'src', 'index.js'), 'export const value = 2;\n');
      git(f.worktree, ['commit', '-q', '-am', 'a dependent changed its sources']);
      expect(reusableSetup({ ...args, headSha: git(f.worktree, ['rev-parse', 'HEAD']) })).toEqual({ ok: true });
    });

    it('refuses once an input changed, committed or not, and names it', () => {
      const { f, args } = withInputs();
      mkdirSync(join(f.worktree, 'packages', 'read'), { recursive: true });
      writeFileSync(join(f.worktree, 'packages', 'read', 'package.json'), '{ "name": "read", "dependencies": { "errors": "workspace:^" } }\n');
      expect(reusableSetup(args)).toMatchObject({ ok: false, reason: expect.stringMatching(/INPUTS_CHANGED: packages\/read\/package\.json/) });
      git(f.worktree, ['add', '-A']);
      git(f.worktree, ['commit', '-q', '-m', 'read depends on errors']);
      expect(reusableSetup({ ...args, headSha: git(f.worktree, ['rev-parse', 'HEAD']) })).toMatchObject({ ok: false, reason: expect.stringMatching(/INPUTS_CHANGED: packages\/read\/package\.json/) });
    });

    it('hashes a symlinked input as the link, never what it points to outside the worktree', (ctx) => {
      const { f } = withInputs();
      const outsideFile = join(f.outside, 'secret.json');
      writeFileSync(outsideFile, '{ "secret": 1 }\n');
      mkdirSync(join(f.worktree, 'packages', 'evil'), { recursive: true });
      try {
        symlinkSync(outsideFile, join(f.worktree, 'packages', 'evil', 'package.json'), 'file');
      } catch {
        ctx.skip();
      }
      const first = setupInputs(f.worktree, { inputs: INPUTS.inputs });
      writeFileSync(outsideFile, '{ "secret": 2 }\n');
      expect(setupInputs(f.worktree, { inputs: INPUTS.inputs })).toEqual(first);
      expect(first?.files['packages/evil/package.json']).toMatch(/^link:/);
    });

    it('without inputs a moved commit still re-runs the setup (commit drift)', () => {
      const { f, args } = completed();
      writeFileSync(join(f.worktree, 'src', 'index.js'), 'export const value = 2;\n');
      git(f.worktree, ['commit', '-q', '-am', 'sources only']);
      expect(reusableSetup({ ...args, headSha: git(f.worktree, ['rev-parse', 'HEAD']) })).toMatchObject({ ok: false, reason: expect.stringMatching(/COMMIT_DRIFT/) });
    });

    it('hashes the config with its inputs, and as before without them', () => {
      const f = fixture();
      const plain = config(f);
      expect(worktreeSetupSha256({ ...plain, inputs: [] })).toBe(worktreeSetupSha256(plain));
      expect(worktreeSetupSha256(config(f, 'ok', INPUTS))).not.toBe(worktreeSetupSha256(plain));
    });
  });

  it('refuses a failed setup and a missing record', () => {
    const f = fixture();
    const cfg = config(f, 'fail');
    const r = run(f, cfg);
    const args = { controlRoot: join(f.root, 'control'), record: r.record, worktree: f.worktree, headSha: git(f.worktree, ['rev-parse', 'HEAD']), config: cfg };
    expect(reusableSetup(args)).toMatchObject({ ok: false, reason: expect.stringMatching(/NOT_COMPLETE/) });
    expect(reusableSetup({ ...args, record: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/NO_RECEIPT/) });
  });
});
