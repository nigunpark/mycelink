/**
 * Hardened git access for the public-project benchmark.
 *
 * Every git the verifier starts — its own, and the git the Mycelink CLI
 * starts — runs with a scrubbed environment: nothing of the operator's but
 * PATH (and what Windows needs), a neutral HOME, system and global
 * configuration off, and command-line configuration (`-c` and
 * GIT_CONFIG_COUNT, which outranks every repository's own) that turns off
 * fsmonitor, hooks, attribute files, external diff, pagers, credential and
 * ssh helpers and every transport protocol, with optional locks off (so
 * read-only commands never rewrite an index). Replace refs and grafts are
 * ignored, so a repository under judgement cannot make one commit pass for
 * another. Repositories whose own configuration could still make git run a
 * program are refused by `unsafeGitConfig` before any git runs in them.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { configKeys, gitDirs, pathKey, readEntry, unsafeGitConfig } from '../../evals-multimodule/_lib/acceptance/lib/git-safe.mjs';
import { assertNoPathCollisions, assertSafeTreePath } from './hash.mjs';

export { configKeys, gitDirs, pathKey, readEntry, unsafeGitConfig };

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

let neutral = null;
function neutralPaths() {
  if (neutral === null) {
    const dir = mkdtempSync(join(tmpdir(), 'bench-git-'));
    const empty = join(dir, 'empty');
    writeFileSync(empty, '');
    mkdirSync(join(dir, 'hooks'));
    mkdirSync(join(dir, 'home'));
    neutral = { empty, hooks: join(dir, 'hooks'), home: join(dir, 'home') };
  }
  return neutral;
}

/** The directory holding the neutral HOME, empty config and hooks every hardened child uses (bound into sandboxes read-only). */
export function neutralDir() {
  return dirname(neutralPaths().empty);
}

/** Configuration every git child runs with: nothing in it can make git run a program. */
export function hardenedGitConfig() {
  const { empty, hooks } = neutralPaths();
  return [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', hooks],
    ['core.attributesFile', empty],
    ['core.pager', 'cat'],
    ['core.untrackedCache', 'false'],
    ['core.sshCommand', 'false'],
    ['core.askPass', ''],
    ['credential.helper', ''],
    ['diff.external', ''],
    ['protocol.allow', 'never'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['advice.graftFileDeprecated', 'false'],
  ];
}

/**
 * The complete environment of a git child — or of a program that runs git,
 * such as the Mycelink CLI: nothing of the operator's environment but PATH
 * (and what Windows needs to start a process), the hardened configuration
 * as GIT_CONFIG_COUNT entries, and `extra`.
 */
export function hardenedGitEnv(extra = {}) {
  const { empty, home } = neutralPaths();
  const config = hardenedGitConfig();
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: empty,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: empty,
    GIT_CONFIG_COUNT: String(config.length),
  };
  for (const [i, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  if (process.platform === 'win32') {
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k] !== undefined) env[k] = process.env[k];
    env.USERPROFILE = home;
  }
  return { ...env, ...extra };
}

/** The environment of a Mycelink CLI child: hardened git, this Node first on PATH, nothing else of the operator's. */
export function mycelinkEnv(extra = {}) {
  return hardenedGitEnv({ PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, TZ: 'UTC', NO_COLOR: '1', ...extra });
}

/** How long a git fed its input may run (the product's bound for the same, src/util/child-stdin.ts). */
const INPUT_TIMEOUT_MS = 120_000;

/**
 * git (always git, never a shell) with `input` as its stdin, a finished file: never spawnSync's `input`, a stream written while the
 * child runs, whose end a child on macOS (Node 22) can wait for forever, the caller blocked with it (CI 38635817750).
 * Bounded: killed past INPUT_TIMEOUT_MS. The file and its private directory are removed once the child has ended.
 */
function gitWithInput(args, input, options) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-git-stdin-'));
  let fd = null;
  try {
    const path = join(dir, 'input');
    writeFileSync(path, input, { flag: 'wx', mode: 0o600 });
    fd = openSync(path, 'r');
    return spawnSync('git', args, { ...options, stdio: [fd, 'pipe', 'pipe'], shell: false, timeout: INPUT_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      // Windows can refuse an unlink for a moment (a scanner, a handle still closing): tried again, and a directory still
      // refused is left, private; the child's result stands either way.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // left in the temporary directory
    }
  }
}

/**
 * Run git hardened (see above); blind to replace refs and grafts. `input`, when given, is its stdin as a finished file,
 * the child bounded (gitWithInput).
 *
 * Note: stdout is trimmed unless `encoding: 'buffer'` is passed; read
 * porcelain output (whose first column may be a space) as a buffer.
 */
export function safeGit(cwd, args, { input, encoding = 'utf8', env = {} } = {}) {
  const argv = [...hardenedGitConfig().flatMap(([k, v]) => ['-c', `${k}=${v}`]), ...args];
  const options = {
    cwd,
    encoding: encoding === 'buffer' ? undefined : encoding,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    shell: false,
    env: hardenedGitEnv({ GIT_ATTR_SOURCE: EMPTY_TREE, ...env }),
  };
  const r = input === undefined ? spawnSync('git', argv, options) : gitWithInput(argv, input, options);
  const text = (v) => (v === undefined || v === null ? '' : Buffer.isBuffer(v) ? v : String(v));
  return {
    code: r.status ?? -1,
    stdout: encoding === 'buffer' ? r.stdout : text(r.stdout).trim(),
    stderr: `${r.error?.code === 'ETIMEDOUT' ? `killed past its ${INPUT_TIMEOUT_MS} ms bound (${Buffer.byteLength(input ?? '')} bytes of input) ` : ''}${String(r.stderr ?? '').trim()}`,
    error: r.error,
  };
}

/**
 * Apply a patch to an exported tree (a plain directory, no repository).
 * Outside a repository git refuses GIT_ATTR_SOURCE, and there is no
 * repository configuration to neutralise.
 */
export function applyPatchToTree(dir, patchFile) {
  const r = spawnSync('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: dir, encoding: 'utf8', windowsHide: true, env: hardenedGitEnv({ HOME: dir }) });
  if (r.status !== 0) throw new Error(`git apply failed: ${String(r.stderr).trim()}`);
}

export class GitError extends Error {
  constructor(cwd, args, result) {
    super(`git ${args.join(' ')} failed in ${cwd} (exit ${result.code}): ${String(result.stderr).split('\n')[0]}`);
    this.result = result;
  }
}

/** Run git; throw on a non-zero exit. Returns trimmed stdout (or a Buffer with encoding 'buffer'). */
export function git(cwd, args, options = {}) {
  const r = safeGit(cwd, args, options);
  if (r.code !== 0) throw new GitError(cwd, args, r);
  return r.stdout;
}

export function gitOk(cwd, args, options = {}) {
  return safeGit(cwd, args, options).code === 0;
}

export function revParse(repo, rev) {
  const r = safeGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}`]);
  return r.code === 0 ? r.stdout : null;
}

export function isAncestor(repo, ancestor, descendant) {
  return gitOk(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
}

/** Every entry of a commit's tree: `{ mode, type, sha, path }`, recursive. */
export function lsTree(repo, rev) {
  const out = git(repo, ['ls-tree', '-r', '-z', '--full-tree', rev], { encoding: 'buffer' });
  const entries = [];
  for (const record of out.toString('utf8').split('\0')) {
    if (record === '') continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(record);
    if (!m) throw new Error(`unexpected ls-tree output in ${repo}: ${record.slice(0, 80)}`);
    entries.push({ mode: m[1], type: m[2], sha: m[3], path: m[4] });
  }
  return entries;
}

/** Object contents by id, read in one `cat-file --batch` (no filters, no index). */
export function catFileBatch(repo, shas) {
  const unique = [...new Set(shas)];
  const result = new Map();
  if (unique.length === 0) return result;
  const out = git(repo, ['cat-file', '--batch'], { input: unique.join('\n') + '\n', encoding: 'buffer' });
  let offset = 0;
  for (const sha of unique) {
    const nl = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, nl).toString('utf8');
    const m = /^([0-9a-f]{40}) (\w+) (\d+)$/.exec(header);
    if (!m || m[1] !== sha) throw new Error(`cat-file: unexpected header for ${sha}: ${header}`);
    const size = Number(m[3]);
    result.set(sha, out.subarray(nl + 1, nl + 1 + size));
    offset = nl + 1 + size + 1;
  }
  return result;
}

/**
 * Write the tree of `rev` into `target` byte for byte (no filters, no line
 * ending conversion), keeping the executable bit. Symlinks and submodules
 * are refused, as are unsafe paths. `overrides` maps a path to a Buffer
 * (written instead of the tree's blob) or to null (left out). Returns the
 * entries written, with their blob ids.
 */
export function exportTree(repo, rev, target, { overrides = new Map(), extra = [], platform = process.platform } = {}) {
  const entries = lsTree(repo, rev);
  for (const e of entries) {
    if (e.type !== 'blob' || e.mode === '120000') throw new Error(`${rev.slice(0, 12)}: ${e.path} is a ${e.mode === '120000' ? 'symlink' : e.type}; refusing to export`);
    assertSafeTreePath(e.path, { platform });
  }
  assertNoPathCollisions([...entries.map((e) => e.path), ...extra.map((x) => x.path), ...[...overrides].filter(([, v]) => v !== null).map(([p]) => p)], { platform });
  const blobs = catFileBatch(repo, entries.filter((e) => !overrides.has(e.path)).map((e) => e.sha));
  mkdirSync(target, { recursive: true });
  const written = [];
  const write = (path, mode, content) => {
    assertSafeTreePath(path, { platform });
    const file = join(target, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (mode === '100755') chmodSync(file, 0o755);
    written.push({ path, mode });
  };
  // An override is a Buffer (keeping the tree's mode), `{ content, mode }`, or null (left out).
  const override = (value, mode) => (value === null ? null : Buffer.isBuffer(value) ? { content: value, mode } : { content: value.content, mode: value.mode ?? mode });
  for (const e of entries) {
    if (overrides.has(e.path)) {
      const o = override(overrides.get(e.path), e.mode);
      if (o !== null) write(e.path, o.mode, o.content);
      continue;
    }
    write(e.path, e.mode, blobs.get(e.sha));
  }
  const present = new Set(entries.filter((e) => !(overrides.has(e.path) && overrides.get(e.path) === null)).map((e) => e.path));
  for (const { path, mode = '100644', content } of extra) {
    if (present.has(path)) throw new Error(`extra file ${path} collides with a tracked file`);
    write(path, mode, content);
  }
  const tracked = new Set(entries.map((e) => e.path));
  for (const [path, value] of overrides) {
    const o = override(value, '100644');
    if (!tracked.has(path) && o !== null) write(path, o.mode, o.content);
  }
  return written;
}
