/**
 * Worktree setup: what a fresh git worktree needs before anything runs in it.
 *
 * A git worktree carries the tracked files only. Dependencies a project
 * installs into an ignored directory (node_modules, a virtualenv, vendored
 * toolchains) exist in the checkout someone installed them in, never in a
 * new worktree. In the CSET-201 pilot the base repository had node_modules,
 * every node worktree had none, and the first worker's legitimate GREEN
 * (`pnpm build`) exited 127; the worker correctly rolled back and the whole
 * feature stopped there.
 *
 * A repository can therefore declare `worktree_setup` in repositories.yaml:
 * argv commands (never a shell), a timeout, environment values that may use
 * only the `${HOME}`, `${WORKTREE}` and `${TMPDIR}` placeholders, and the
 * paths the setup must leave behind. The controller runs it in every
 * worktree it creates (a worker's, a fresh verification's, delivery
 * acceptance's) before anything else runs there, and nothing is ever taken
 * from a README or guessed. It runs with the session's own toolchain
 * locations (PATH, HOME and the cache variables) and the configured values
 * only: no proxy, credential, controller or loader variable reaches it.
 *
 * What a setup may leave is ignored output (an untracked directory the
 * repository ignores). It may not change a tracked file, leave untracked
 * output git would see, move HEAD, change git configuration or hooks
 * (executables git would run later), or leave a link that leads out of the
 * worktree; any of those fails it, and the configuration it changed is put
 * back. Each run leaves a receipt in the evidence directory — status, the
 * exit code of each command, the hash of its output, and the worktree,
 * commit and configuration it binds — and a marker in the worktree's own git
 * directory, so a receipt is reused only for the same worktree, at the same
 * commit, with the same configuration, while its required paths exist.
 *
 * A setup may name its `inputs`: the tracked files it installs from (a
 * dependency manifest, a lockfile). The receipt binds their content, and a
 * gate that finds them changed in its worktree runs the same setup there
 * again before it runs anything (CSET-202 r1: a node that needed another
 * package of the same workspace could not link it, imported its source by
 * path instead, and broke the error class's identity). The worker declares
 * the dependency; it never runs an install. A changed input runs nothing the
 * worker's own tests could not: the same argv, environment and checks.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Problem } from '../model/types.js';
import { runGit } from '../git/git.js';
import { relativeInside } from '../evidence/paths.js';
import { matchGlob } from '../git/worktree.js';
import { CommandPolicyError, runCommandSync, validateArgv } from '../security/exec.js';
import { classifyRelativePath, isInsideReal, readRegular, realpathDeepest, samePath } from '../security/paths.js';
import { redactText } from '../security/redact.js';

export const DEFAULT_WORKTREE_SETUP_TIMEOUT_SECONDS = 900;

/** The setup of one repository, as it runs: every field present. */
export interface WorktreeSetupConfig {
  commands: string[][];
  timeout_seconds: number;
  env: Record<string, string>;
  required_paths: string[];
  /** Globs of the tracked files the setup installs from; changed in a worktree, the setup runs there again. */
  inputs?: string[];
}

/** `worktree_setup` as repositories.yaml may write it. */
export interface WorktreeSetupDecl {
  commands: string[][];
  timeout_seconds?: number;
  env?: Record<string, string>;
  required_paths?: string[];
  inputs?: string[];
}

export type WorktreeSetupFailure =
  | 'WORKTREE_INVALID'
  | 'ENVIRONMENT_INVALID'
  | 'SPAWN_FAILED'
  | 'COMMAND_FAILED'
  | 'TIMED_OUT'
  | 'HEAD_MOVED'
  | 'CONFIG_SIDE_EFFECT'
  | 'PATH_ESCAPE'
  | 'TRACKED_MUTATION'
  | 'UNTRACKED_OUTPUT'
  | 'REQUIRED_PATH_MISSING';

/** Failures after which the worktree is not what git checked out: it is removed and created again. */
const MUTATIONS: ReadonlySet<WorktreeSetupFailure> = new Set(['HEAD_MOVED', 'CONFIG_SIDE_EFFECT', 'PATH_ESCAPE', 'TRACKED_MUTATION', 'UNTRACKED_OUTPUT']);

export function setupMutatedWorktree(code: string | null): boolean {
  return code !== null && MUTATIONS.has(code as WorktreeSetupFailure);
}

export interface WorktreeSetupReceipt {
  schema: 'mycelink-worktree-setup/1';
  status: 'complete' | 'failed';
  code: WorktreeSetupFailure | null;
  detail: string;
  repository: string;
  worktree: string;
  git_dir: string | null;
  head_sha: string | null;
  branch: string | null;
  config_sha256: string;
  config: WorktreeSetupConfig;
  commands: { argv: string[]; exit_code: number; timed_out: boolean; duration_ms: number }[];
  env_names: string[];
  required_paths: string[];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  /** Relative to the control root. */
  output_path: string;
  output_sha256: string;
  /** The module verification (engine/modules.ts) the worktree was prepared for, when the claim binds one. */
  verification?: { module: string; module_sha256: string };
  /** The setup's inputs as it found them (when it declares any): each file's hash, and their hash together. */
  inputs_sha256?: string;
  input_files?: Record<string, string>;
}

/** What STATE.json keeps of a node's last setup: enough to find and check its receipt. */
export interface WorktreeSetupRecord {
  status: 'complete' | 'failed';
  code: string | null;
  config_sha256: string;
  receipt_path: string;
  receipt_sha256: string;
  worktree: string;
  head_sha: string | null;
  at: string;
}

export interface WorktreeSetupRun {
  receipt: WorktreeSetupReceipt;
  /** Relative to the control root. */
  receipt_path: string;
  receipt_sha256: string;
  record: WorktreeSetupRecord;
}

/** A setup that did not complete, for callers that stop on it. */
export class WorktreeSetupError extends Error {
  readonly code = 'WORKTREE_SETUP_FAILED';
  readonly failure: string;
  readonly receiptPath: string | null;
  readonly outputPath: string | null;
  constructor(subject: string, receipt: Pick<WorktreeSetupReceipt, 'code' | 'detail' | 'output_path'> | null, receiptPath: string | null, detail?: string) {
    const failure = receipt?.code ?? 'ENVIRONMENT_INVALID';
    const what = detail ?? receipt?.detail ?? 'the worktree setup did not complete';
    super(
      `WORKTREE_SETUP_FAILED: ${subject}: ${failure}: ${what}` +
        (receipt?.output_path ? `; log ${receipt.output_path}` : '') +
        (receiptPath ? `, receipt ${receiptPath}` : '') +
        '. Nothing was charged to the node; fix the environment or the repository\'s worktree_setup, then dispatch again.',
    );
    this.name = 'WorktreeSetupError';
    this.failure = failure;
    this.receiptPath = receiptPath;
    this.outputPath = receipt?.output_path ?? null;
  }
}

// ---- configuration ---------------------------------------------------------

const PLACEHOLDERS: ReadonlySet<string> = new Set(['HOME', 'WORKTREE', 'TMPDIR']);

/** Variables a setup may not set: the session's own locations, loaders and repository redirection, and Mycelink's. */
const DENIED_ENV: readonly RegExp[] = [
  /^PATH$/i,
  /^HOME$/i,
  /^USERPROFILE$/i,
  /^NODE_OPTIONS$/i,
  /^LD_/i,
  /^DYLD_/i,
  /^MYCELINK_/i,
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i,
];

/** The normalised setup of a repository declaration, or null when it declares none. */
export function worktreeSetupOf(repo: { worktree_setup?: WorktreeSetupDecl } | undefined | null): WorktreeSetupConfig | null {
  const decl = repo?.worktree_setup;
  if (decl === undefined || decl === null) return null;
  return {
    commands: decl.commands.map((argv) => [...argv]),
    timeout_seconds: decl.timeout_seconds ?? DEFAULT_WORKTREE_SETUP_TIMEOUT_SECONDS,
    env: { ...(decl.env ?? {}) },
    required_paths: [...(decl.required_paths ?? [])],
    ...(decl.inputs !== undefined && decl.inputs.length > 0 ? { inputs: [...decl.inputs] } : {}),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** The hash a claim, ticket, pack and receipt bind: what runs, not how it was written down. */
export function worktreeSetupSha256(config: WorktreeSetupConfig): string {
  const inputs = config.inputs ?? [];
  return sha256(canonical({ commands: config.commands, timeout_seconds: config.timeout_seconds, env: config.env, required_paths: config.required_paths, ...(inputs.length > 0 ? { inputs } : {}) }));
}

/**
 * The setup's inputs in a worktree as they are now: every file git sees
 * (tracked, or untracked and not ignored) that an input glob matches, by
 * content. A symlinked input is hashed as the link (`link:` and the hash
 * of its target's name), never followed out of the worktree. Null when the
 * setup declares no inputs.
 */
export function setupInputs(worktree: string, config: Pick<WorktreeSetupConfig, 'inputs'>): { sha256: string; files: Record<string, string> } | null {
  const globs = config.inputs ?? [];
  if (globs.length === 0) return null;
  const listed = runGit(worktree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { allowFail: true });
  const files: Record<string, string> = {};
  for (const rel of [...new Set(listed.stdout.split('\0').filter((p) => p !== ''))].sort()) {
    if (!globs.some((g) => matchGlob(g, rel))) continue;
    const file = join(worktree, rel);
    let link: string | null = null;
    try {
      if (lstatSync(file).isSymbolicLink()) link = readlinkSync(file);
    } catch {
      continue;
    }
    if (link !== null) {
      files[rel] = `link:${sha256(link)}`;
      continue;
    }
    const content = bytes(file);
    if (content !== null) files[rel] = sha256(content);
  }
  return { sha256: sha256(canonical(files)), files };
}

/** The inputs that differ between a receipt's and now's: added, changed or removed paths. */
export function changedInputs(before: Record<string, string> | undefined, now: Record<string, string>): string[] {
  const was = before ?? {};
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((p) => was[p] !== now[p]).sort();
}

/** A required path, split into its segments (`\` and `/` alike). */
function segments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
}

/** Problems with a declared setup that its schema cannot express. */
export function worktreeSetupProblems(decl: WorktreeSetupDecl, at: string): Problem[] {
  const problems: Problem[] = [];
  const problem = (path: string, detail: string): void => {
    problems.push({ code: 'WORKTREE_SETUP_INVALID', path: `${at}${path}`, detail });
  };
  decl.commands.forEach((argv, i) => {
    try {
      validateArgv(argv);
    } catch (err) {
      problem(`/commands/${i}`, `worktree_setup command ${i + 1} is not a safe argv: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  for (const [name, value] of Object.entries(decl.env ?? {})) {
    if (DENIED_ENV.some((rx) => rx.test(name))) {
      problem(`/env/${name}`, `worktree_setup may not set ${name}: the session's PATH and HOME, loaders, repository redirection and Mycelink's own variables are not configurable`);
      continue;
    }
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) problem(`/env/${name}`, `worktree_setup env ${name} contains a control character`);
    for (const m of value.matchAll(/\$\{([^}]*)\}/g)) {
      if (!PLACEHOLDERS.has(m[1] as string)) problem(`/env/${name}`, `worktree_setup env ${name} uses \${${m[1]}}; only \${HOME}, \${WORKTREE} and \${TMPDIR} are placeholders`);
    }
    if (value.replace(/\$\{[^}]*\}/g, '').includes('${')) problem(`/env/${name}`, `worktree_setup env ${name} has an unterminated \${`);
  }
  (decl.required_paths ?? []).forEach((p, i) => {
    const unsafe = classifyRelativePath(p);
    const parts = segments(p);
    if (unsafe !== null) problem(`/required_paths/${i}`, `required path ${JSON.stringify(p)} is not a path inside the worktree (${unsafe})`);
    else if (parts.length === 0) problem(`/required_paths/${i}`, `required path ${JSON.stringify(p)} names the worktree itself`);
    else if (parts.some((s) => s === '..')) problem(`/required_paths/${i}`, `required path ${JSON.stringify(p)} may not use ..`);
    else if (parts.some((s) => s.toLowerCase() === '.git')) problem(`/required_paths/${i}`, `required path ${JSON.stringify(p)} lies in git's own directory`);
    else if (/[*?[\]{}]/.test(p)) problem(`/required_paths/${i}`, `required path ${JSON.stringify(p)} is a glob; name the path itself`);
  });
  (decl.inputs ?? []).forEach((p, i) => {
    const unsafe = classifyRelativePath(p);
    const parts = segments(p);
    if (unsafe !== null) problem(`/inputs/${i}`, `input ${JSON.stringify(p)} is not a path inside the worktree (${unsafe})`);
    else if (parts.length === 0) problem(`/inputs/${i}`, `input ${JSON.stringify(p)} names the worktree itself`);
    else if (parts.some((s) => s === '..')) problem(`/inputs/${i}`, `input ${JSON.stringify(p)} may not use ..`);
    else if (parts.some((s) => s.toLowerCase() === '.git')) problem(`/inputs/${i}`, `input ${JSON.stringify(p)} lies in git's own directory`);
  });
  return problems;
}

// ---- environment -------------------------------------------------------------

/** What a setup takes from the session on POSIX: its toolchain and cache locations, its locale and user. */
const PASSED_POSIX = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'COREPACK_HOME',
  'JAVA_HOME',
];

/** ... and on Windows, what starting a process needs besides. */
const PASSED_WIN32 = [
  ...PASSED_POSIX,
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'ComSpec',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'USERNAME',
];

export interface SetupEnvironmentArgs {
  config: WorktreeSetupConfig;
  worktree: string;
  /** A private temporary directory, outside the worktree. */
  tmp: string;
  base?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/**
 * The environment a setup command runs with: the session's toolchain and
 * cache locations (so its sealed offline HOME is used), a private TMPDIR,
 * and the configured values with their placeholders filled in. Nothing else
 * is inherited.
 */
export function setupEnvironment(args: SetupEnvironmentArgs): Record<string, string> {
  const platform = args.platform ?? process.platform;
  const base = args.base ?? process.env;
  const passed = platform === 'win32' ? PASSED_WIN32 : PASSED_POSIX;
  const wanted = new Set(passed.map((n) => (platform === 'win32' ? n.toLowerCase() : n)));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (wanted.has(platform === 'win32' ? name.toLowerCase() : name)) env[name] = value;
  }
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key];
    env[name] = args.tmp;
  }
  const home = base['HOME'] ?? (platform === 'win32' ? base['USERPROFILE'] : undefined);
  const fill = (name: string, value: string): string =>
    value.replace(/\$\{(HOME|WORKTREE|TMPDIR)\}/g, (_m, key: string) => {
      if (key === 'WORKTREE') return args.worktree;
      if (key === 'TMPDIR') return args.tmp;
      if (home === undefined || home === '') {
        throw new Error(`worktree_setup env ${name} uses \${HOME}, but the session has no HOME${platform === 'win32' ? ' or USERPROFILE' : ''}`);
      }
      return home;
    });
  for (const [name, value] of Object.entries(args.config.env)) env[name] = fill(name, value);
  return env;
}

// ---- the worktree ------------------------------------------------------------

interface GitLayout {
  gitDir: string;
  commonDir: string;
}

function gitPath(worktree: string, flag: '--git-dir' | '--git-common-dir' | '--show-toplevel'): string | null {
  const r = runGit(worktree, ['rev-parse', '--path-format=absolute', flag], { allowFail: true });
  const out = r.stdout.trim();
  return r.exitCode === 0 && out !== '' ? resolve(out) : null;
}

/** Why `worktree` is not a worktree of `repoPath` inside `root`, or null. */
function worktreeProblem(worktree: string, root: string, repoPath: string): string | null {
  let st;
  try {
    st = lstatSync(worktree);
  } catch {
    return `${worktree} does not exist`;
  }
  if (st.isSymbolicLink()) return `${worktree} is a link`;
  if (!st.isDirectory()) return `${worktree} is not a directory`;
  if (!isInsideReal(root, worktree)) return `${worktree} is outside ${root}`;
  const top = gitPath(worktree, '--show-toplevel');
  if (top === null || !samePath(top, worktree)) return `${worktree} is not the top of a git worktree`;
  const common = gitPath(worktree, '--git-common-dir');
  const repoCommon = gitPath(repoPath, '--git-common-dir');
  if (common === null || repoCommon === null || !samePath(common, repoCommon)) return `${worktree} is not a worktree of ${repoPath}`;
  return null;
}

function layoutOf(worktree: string): GitLayout | null {
  const gitDir = gitPath(worktree, '--git-dir');
  const commonDir = gitPath(worktree, '--git-common-dir');
  return gitDir !== null && commonDir !== null ? { gitDir, commonDir } : null;
}

/** File bytes, or null when absent or not a regular file (read through one descriptor, never through a link). */
function bytes(path: string): Buffer | null {
  return readRegular(path)?.bytes ?? null;
}

interface Snapshot {
  head: string | null;
  branch: string | null;
  /** Porcelain status entries (`XY path`) of tracked changes, with what each file holds. */
  tracked: Map<string, string>;
  untracked: Map<string, string>;
  /** git configuration and hooks: path -> bytes and mode (null when absent). */
  control: Map<string, { data: Buffer; mode: number } | null>;
  /** Top-level links of the worktree: name -> target. */
  links: Map<string, string>;
}

function fileDigest(path: string): string {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return `link:${readlinkSync(path)}`;
    if (st.isFile()) {
      // Read through one descriptor: a file swapped since the look is digested as what it is now, or not at all.
      const read = readRegular(path);
      return read === null ? 'other' : `file:${sha256(read.bytes)}:${read.mode & 0o111 ? 'x' : '-'}`;
    }
    return st.isDirectory() ? 'dir' : 'other';
  } catch {
    return 'absent';
  }
}

function controlFiles(worktree: string, layout: GitLayout): string[] {
  const files = [
    join(layout.commonDir, 'config'),
    join(layout.gitDir, 'config.worktree'),
    join(layout.commonDir, 'info', 'attributes'),
    join(layout.commonDir, 'info', 'exclude'),
    join(worktree, '.git'),
  ];
  const hooks = join(layout.commonDir, 'hooks');
  try {
    for (const name of readdirSync(hooks)) files.push(join(hooks, name));
  } catch {
    // no hooks directory
  }
  return files;
}

function snapshot(worktree: string, layout: GitLayout): Snapshot {
  const head = runGit(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }).stdout.trim() || null;
  const branch = runGit(worktree, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true }).stdout.trim() || null;
  const tracked = new Map<string, string>();
  const untracked = new Map<string, string>();
  const status = runGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).stdout;
  for (const entry of status.split('\0')) {
    if (entry.length < 4) continue;
    const digest = fileDigest(join(worktree, entry.slice(3)));
    if (entry.startsWith('??')) untracked.set(entry, digest);
    else tracked.set(entry, digest);
  }
  const control = new Map<string, { data: Buffer; mode: number } | null>();
  for (const file of controlFiles(worktree, layout)) {
    const data = bytes(file);
    control.set(file, data === null ? null : { data, mode: lstatSync(file).mode & 0o777 });
  }
  const links = new Map<string, string>();
  for (const entry of readdirSync(worktree, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      try {
        links.set(entry.name, readlinkSync(join(worktree, entry.name)));
      } catch {
        links.set(entry.name, '?');
      }
    }
  }
  return { head, branch, tracked, untracked, control, links };
}

const sameMap = <V>(a: Map<string, V>, b: Map<string, V>, eq: (x: V, y: V) => boolean = (x, y) => x === y): boolean =>
  a.size === b.size && [...a].every(([k, v]) => b.has(k) && eq(v, b.get(k) as V));

const sameControl = (x: { data: Buffer; mode: number } | null, y: { data: Buffer; mode: number } | null): boolean =>
  x === null || y === null ? x === y : x.mode === y.mode && x.data.equals(y.data);

/** Put git configuration and hooks back as they were before the setup. */
function restoreControl(before: Snapshot, worktree: string, layout: GitLayout): string[] {
  const restored: string[] = [];
  const now = new Set([...before.control.keys(), ...controlFiles(worktree, layout)]);
  for (const file of now) {
    const was = before.control.get(file) ?? null;
    const is = bytes(file);
    if (was === null) {
      if (is !== null || existsSync(file)) {
        rmSync(file, { force: true, recursive: true });
        restored.push(`removed ${file}`);
      }
      continue;
    }
    const mode = is === null ? -1 : lstatSync(file).mode & 0o777;
    if (is !== null && is.equals(was.data) && mode === was.mode) continue;
    rmSync(file, { force: true, recursive: true });
    writeFileSync(file, was.data);
    try {
      chmodSync(file, was.mode);
    } catch {
      // modes are advisory on Windows
    }
    restored.push(`restored ${file}`);
  }
  return restored;
}

/** Move the branch a setup committed on back to where it was. */
function restoreRefs(before: Snapshot, worktree: string): void {
  if (before.branch === null || before.head === null) return;
  const now = runGit(worktree, ['rev-parse', '--verify', '--quiet', before.branch], { allowFail: true }).stdout.trim();
  if (now !== '' && now !== before.head) runGit(worktree, ['update-ref', before.branch, before.head, now], { allowFail: true });
}

/** Why `rel` does not exist inside the worktree, or leads out of it; null when it is there. */
function requiredPathProblem(worktree: string, rel: string): { code: 'REQUIRED_PATH_MISSING' | 'PATH_ESCAPE'; detail: string } | null {
  const full = join(worktree, ...segments(rel));
  try {
    lstatSync(full);
  } catch {
    return { code: 'REQUIRED_PATH_MISSING', detail: `required path ${rel} does not exist after the setup` };
  }
  if (!isInsideReal(worktree, full)) return { code: 'PATH_ESCAPE', detail: `required path ${rel} resolves outside the worktree, to ${realpathDeepest(full)}` };
  return null;
}

function compare(before: Snapshot, after: Snapshot, worktree: string, config: WorktreeSetupConfig): { code: WorktreeSetupFailure; detail: string } | null {
  if (before.head !== after.head || before.branch !== after.branch) {
    return { code: 'HEAD_MOVED', detail: `the setup moved HEAD from ${before.branch ?? 'detached'} ${String(before.head).slice(0, 12)} to ${after.branch ?? 'detached'} ${String(after.head).slice(0, 12)}` };
  }
  if (!sameMap(before.control, after.control, sameControl)) {
    const changed = [...new Set([...before.control.keys(), ...after.control.keys()])].filter((k) => !sameControl(before.control.get(k) ?? null, after.control.get(k) ?? null));
    return { code: 'CONFIG_SIDE_EFFECT', detail: `the setup changed git configuration or hooks: ${changed.slice(0, 5).join(', ')}` };
  }
  for (const [name, target] of after.links) {
    if (before.links.get(name) === target) continue;
    if (!isInsideReal(worktree, join(worktree, name))) return { code: 'PATH_ESCAPE', detail: `the setup left ${name} linking outside the worktree (${target})` };
  }
  for (const rel of config.required_paths) {
    const p = requiredPathProblem(worktree, rel);
    if (p?.code === 'PATH_ESCAPE') return p;
  }
  if (!sameMap(before.tracked, after.tracked)) {
    const changed = [...new Set([...before.tracked.keys(), ...after.tracked.keys()])].filter((k) => before.tracked.get(k) !== after.tracked.get(k));
    return { code: 'TRACKED_MUTATION', detail: `the setup changed tracked files: ${changed.slice(0, 5).map((e) => e.slice(3)).join(', ')}` };
  }
  if (!sameMap(before.untracked, after.untracked)) {
    const left = [...after.untracked.keys()].filter((k) => before.untracked.get(k) !== after.untracked.get(k));
    return { code: 'UNTRACKED_OUTPUT', detail: `the setup left untracked files git would commit (ignore them in the repository or keep them out): ${left.slice(0, 5).map((e) => e.slice(3)).join(', ')}` };
  }
  return null;
}

const MARKER = 'mycelink-setup';

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

export interface RunWorktreeSetupArgs {
  /** Stored paths are relative to it; the evidence directory must be inside it. */
  controlRoot: string;
  repository: string;
  repoPath: string;
  worktree: string;
  /** The worktree must lie inside this directory. */
  root: string;
  config: WorktreeSetupConfig;
  /** Optional absolute host deadline, without changing the bound setup declaration. */
  deadline?: number;
  evidenceDir: string;
  /** File name stem of the log and the receipt (a unique suffix is added). */
  label: string;
  /** The session environment the setup takes its locations from. Default: this process's. */
  base?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** The module verification the worktree is prepared for (engine/modules.ts), recorded in the receipt. */
  verification?: { module: string; module_sha256: string } | null;
}

/**
 * Run `config` in `worktree` and record what happened. Never throws for a
 * setup that failed: the receipt says how.
 */
export function runWorktreeSetup(args: RunWorktreeSetupArgs): WorktreeSetupRun {
  const startedAt = new Date();
  const worktree = resolve(args.worktree);
  const config = args.config;
  const configSha = worktreeSetupSha256(config);
  mkdirSync(args.evidenceDir, { recursive: true });
  const stem = `${safe(args.label)}-${randomUUID().slice(0, 8)}`;
  const logFile = join(args.evidenceDir, `${stem}.log`);
  const receiptFile = join(args.evidenceDir, `${stem}.json`);
  const commands: WorktreeSetupReceipt['commands'] = [];
  let output = `[mycelink] worktree setup of ${args.repository} in ${worktree}\n`;
  let code: WorktreeSetupFailure | null = null;
  let detail = 'the worktree setup completed';
  let envNames: string[] = [];
  let before: Snapshot | null = null;
  let layout: GitLayout | null = null;

  const invalid = worktreeProblem(worktree, args.root, args.repoPath);
  if (invalid !== null) {
    code = 'WORKTREE_INVALID';
    detail = invalid;
  } else {
    layout = layoutOf(worktree);
    if (layout === null) {
      code = 'WORKTREE_INVALID';
      detail = `git cannot name the directories of ${worktree}`;
    }
  }
  let inputs: ReturnType<typeof setupInputs> = null;
  if (code === null && layout !== null) {
    before = snapshot(worktree, layout);
    inputs = setupInputs(worktree, config);
    const tmp = mkdtempSync(join(tmpdir(), 'mycelink-setup-'));
    try {
      let env: Record<string, string> | null = null;
      try {
        env = setupEnvironment({ config, worktree, tmp, ...(args.base !== undefined ? { base: args.base } : {}) });
        envNames = Object.keys(env).sort();
      } catch (err) {
        code = 'ENVIRONMENT_INVALID';
        detail = err instanceof Error ? err.message : String(err);
      }
      const deadline = Math.min(Date.now() + config.timeout_seconds * 1000, args.deadline ?? Infinity);
      for (const argv of env === null ? [] : config.commands) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          code = 'TIMED_OUT';
          detail = `the setup ran out of its ${config.timeout_seconds} s before ${argv.join(' ')}`;
          break;
        }
        const t0 = Date.now();
        output += `\n$ ${argv.join(' ')}\n`;
        let r;
        try {
          r = runCommandSync(argv, { cwd: worktree, env: env as Record<string, string>, cleanEnv: true, timeoutMs: remaining, maxBuffer: 64 * 1024 * 1024 });
        } catch (err) {
          if (!(err instanceof CommandPolicyError)) throw err;
          commands.push({ argv: [...argv], exit_code: 127, timed_out: false, duration_ms: Date.now() - t0 });
          output += `[mycelink] refused: ${err.message}\n`;
          code = 'SPAWN_FAILED';
          detail = `${argv.join(' ')} was refused: ${err.message}`;
          break;
        }
        output += r.stdout + r.stderr;
        commands.push({ argv: [...argv], exit_code: r.exitCode, timed_out: r.timedOut, duration_ms: Date.now() - t0 });
        if (r.timedOut) {
          output += `\n[mycelink] timed out after ${config.timeout_seconds} s\n`;
          code = 'TIMED_OUT';
          detail = `${argv.join(' ')} did not finish within the setup's ${config.timeout_seconds} s`;
          break;
        }
        if (r.spawnError !== null) {
          output += `\n[mycelink] failed to start: ${r.spawnError}\n`;
          code = 'SPAWN_FAILED';
          detail = `${argv.join(' ')} could not start: ${r.spawnError}`;
          break;
        }
        if (r.exitCode !== 0) {
          code = 'COMMAND_FAILED';
          detail = `${argv.join(' ')} exited ${r.exitCode}`;
          break;
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }

    // What the setup left behind decides as much as its exit codes.
    const after = snapshot(worktree, layout);
    const effect = compare(before, after, worktree, config);
    if (effect !== null) {
      detail = code === null ? effect.detail : `${effect.detail} (and ${detail})`;
      code = effect.code;
      if (effect.code === 'HEAD_MOVED') restoreRefs(before, worktree);
      const restored = restoreControl(before, worktree, layout);
      if (restored.length > 0) output += `\n[mycelink] ${restored.join('; ')}\n`;
    } else if (code === null) {
      for (const rel of config.required_paths) {
        const p = requiredPathProblem(worktree, rel);
        if (p !== null) {
          code = p.code;
          detail = p.detail;
          break;
        }
      }
    }
  }

  const finishedAt = new Date();
  output += `\n[mycelink] ${code === null ? 'complete' : `failed: ${code}: ${detail}`}\n`;
  const text = redactText(output);
  rmSync(logFile, { force: true });
  writeFileSync(logFile, text, { encoding: 'utf8', flag: 'wx' });
  const rel = (file: string): string => relativeInside(args.controlRoot, file) ?? file.replace(/\\/g, '/');
  const receipt: WorktreeSetupReceipt = {
    schema: 'mycelink-worktree-setup/1',
    status: code === null ? 'complete' : 'failed',
    code,
    detail: redactText(detail).slice(0, 2000),
    repository: args.repository,
    worktree,
    git_dir: layout?.gitDir ?? null,
    head_sha: before?.head ?? null,
    branch: before?.branch ?? null,
    config_sha256: configSha,
    config,
    commands,
    env_names: envNames,
    required_paths: [...config.required_paths],
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    output_path: rel(logFile),
    output_sha256: sha256(Buffer.from(text, 'utf8')),
    ...(args.verification ? { verification: { module: args.verification.module, module_sha256: args.verification.module_sha256 } } : {}),
    ...(inputs !== null ? { inputs_sha256: inputs.sha256, input_files: inputs.files } : {}),
  };
  const body = JSON.stringify(receipt, null, 2) + '\n';
  rmSync(receiptFile, { force: true });
  writeFileSync(receiptFile, body, { encoding: 'utf8', flag: 'wx' });
  const receiptSha = sha256(Buffer.from(body, 'utf8'));
  if (receipt.status === 'complete' && layout !== null) {
    // The worktree's own git directory goes when the worktree does: a receipt never outlives it.
    const marker = join(layout.gitDir, MARKER);
    rmSync(marker, { force: true });
    writeFileSync(marker, receiptSha + '\n', 'utf8');
  }
  return {
    receipt,
    receipt_path: rel(receiptFile),
    receipt_sha256: receiptSha,
    record: {
      status: receipt.status,
      code,
      config_sha256: configSha,
      receipt_path: rel(receiptFile),
      receipt_sha256: receiptSha,
      worktree,
      head_sha: receipt.head_sha,
      at: finishedAt.toISOString(),
    },
  };
}

export interface ReusableSetupArgs {
  controlRoot: string;
  record: WorktreeSetupRecord | null | undefined;
  worktree: string;
  headSha: string;
  config: WorktreeSetupConfig;
}

/**
 * Whether a recorded setup still holds: the receipt is the one recorded
 * (unchanged), it completed, for this very worktree (its git directory still
 * carries the receipt's marker), at this commit, with this configuration, and
 * every required path is still there.
 */
export function reusableSetup(args: ReusableSetupArgs): { ok: true } | { ok: false; reason: string } {
  const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  const record = args.record;
  if (record === null || record === undefined) return no('NO_RECEIPT: this worktree has no setup on record');
  if (record.status !== 'complete') return no(`NOT_COMPLETE: the last setup ${record.code ?? 'failed'}`);
  const file = resolve(args.controlRoot, record.receipt_path);
  if (classifyRelativePath(record.receipt_path) !== null || !isInsideReal(args.controlRoot, file)) return no(`RECEIPT_MISSING: ${record.receipt_path} is not inside the control root`);
  const data = bytes(file);
  if (data === null) return no(`RECEIPT_MISSING: ${record.receipt_path}`);
  if (sha256(data) !== record.receipt_sha256) return no(`RECEIPT_TAMPERED: ${record.receipt_path} no longer hashes to the recorded receipt`);
  let receipt: WorktreeSetupReceipt;
  try {
    receipt = JSON.parse(data.toString('utf8')) as WorktreeSetupReceipt;
  } catch {
    return no(`RECEIPT_TAMPERED: ${record.receipt_path} is not a receipt`);
  }
  if (receipt.schema !== 'mycelink-worktree-setup/1' || receipt.status !== 'complete') return no('NOT_COMPLETE: the receipt is not a completed setup');
  if (typeof receipt.worktree !== 'string' || !samePath(receipt.worktree, args.worktree)) return no(`WORKTREE_CHANGED: the receipt is for ${receipt.worktree}`);
  // With declared inputs, what was installed depends on them alone: a commit that changed none of them
  // (an integration that moved other packages) keeps the receipt. Without, any commit re-runs the setup.
  const declaresInputs = (args.config.inputs ?? []).length > 0;
  if (!declaresInputs && receipt.head_sha !== args.headSha) return no(`COMMIT_DRIFT: the setup ran at ${String(receipt.head_sha).slice(0, 12)}, the worktree is at ${args.headSha.slice(0, 12)}`);
  if (receipt.config_sha256 !== worktreeSetupSha256(args.config)) return no('CONFIG_DRIFT: the repository\'s worktree_setup changed since this setup ran');
  const inputs = setupInputs(args.worktree, args.config);
  if (inputs !== null && inputs.sha256 !== receipt.inputs_sha256) {
    return no(`INPUTS_CHANGED: ${changedInputs(receipt.input_files, inputs.files).slice(0, 10).join(', ') || 'the inputs'} changed since this setup ran`);
  }
  const gitDir = gitPath(args.worktree, '--git-dir');
  const marker = gitDir === null ? null : bytes(join(gitDir, MARKER));
  if (marker === null || marker.toString('utf8').trim() !== record.receipt_sha256) return no('WORKTREE_CHANGED: the worktree was created again since this setup ran');
  for (const rel of args.config.required_paths) {
    const p = requiredPathProblem(args.worktree, rel);
    if (p !== null) return no(`${p.code}: ${p.detail.replace(' after the setup', '')}`);
  }
  return { ok: true };
}
