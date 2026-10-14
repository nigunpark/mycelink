/**
 * The Mycelink quickstart workspace: two independent Git repositories
 * (orders-api, orders-web) and the control repository that coordinates them,
 * created from the templates beside this file.
 *
 * Every process is spawned with an argv array and no shell. Git gets a local
 * identity per repository and fixed dates for the baseline commits, so the
 * baseline SHAs are the same on every machine.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES = { api: join(HERE, 'repos', 'orders-api'), web: join(HERE, 'repos', 'orders-web'), control: join(HERE, 'control') };
/** The Mycelink launcher of the checkout this example lives in. */
export const CHECKOUT_LAUNCHER = resolve(HERE, '..', '..', 'bin', 'mycelink.mjs');

export const FEATURE_ID = 'ORD-101';
export const API_NODE = 'ORD-101.api.status.impl';
export const WEB_NODE = 'ORD-101.web.status.impl';
export const CANDIDATE_NODE = 'ORD-101.release.candidate.build';
/** Directory names inside the output directory, by registered repository name. */
export const REPOS = Object.freeze({ api: 'orders-api', web: 'orders-web' });
export const CONTROL = 'control';
export const MARKER = '.mycelink-quickstart.json';

export const IDENTITY = Object.freeze({ name: 'Mycelink Quickstart', email: 'quickstart@example.invalid' });
/** Every commit the quickstart makes itself is dated here. */
export const FIXED_DATE = '2026-01-01T00:00:00Z';
/** The baseline commits setup.mjs makes: the same tree, identity, date and message everywhere. */
export const BASELINE_SHAS = Object.freeze({ api: '884eed990cb0819a4494f0347299eeef87ab0072', web: '8846c66e4225c51a96b25051ca104216aa3ff916' });

/** Appended to the CLAUDE.md `mycelink init` writes: the plan is approved, so a run uses it as it is. */
export const CONTROL_CLAUDE_NOTE = `
## This quickstart

Feature ORD-101 is already specified, approved and planned. The Mycelink
quickstart committed \`features/ORD-101/PRD.md\`, \`ACCEPTANCE.json\` (the
approved criteria, cut from the PRD) and \`PORTFOLIO-GRAPH.yaml\`, and
\`contracts/order-status.v2.json\`. \`/mycelink:run ORD-101\` skips the PRD
phase; in the plan phase, validate this graph and initialise the feature
with it unchanged. The two product repositories are \`../orders-api\` and
\`../orders-web\`; nothing in them is to be edited outside a dispatched
worker's worktree.
`;

/** Settings for the commits the quickstart makes, never written to any config: no signing, LF kept as is. */
const COMMIT_FLAGS = ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];

/** The environment without variables that would point git at another repository. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|PREFIX|COMMON_DIR)$/.test(k)) delete env[k];
  return { ...env, ...extra };
}

export function fixedDateEnv() {
  return { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
}

/** Run argv without a shell. Never throws for a non-zero exit; the caller decides. */
export function run(argv, { cwd, env, input, timeoutMs = 120_000 } = {}) {
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd, args, { cwd, env: env ?? cleanEnv(), input, encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { code: 127, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error.message}` };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run argv and fail loudly on a non-zero exit. */
export function must(argv, options = {}) {
  const r = run(argv, options);
  if (r.code !== 0) throw new QuickstartError(`"${argv.join(' ')}" exited ${r.code}\n${r.stdout}${r.stderr}`.trimEnd());
  return r;
}

export function git(cwd, args, env) {
  return must(['git', ...args], { cwd, env: cleanEnv(env) }).stdout.trim();
}

export class QuickstartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuickstartError';
  }
}

/** Repository-relative files of a template directory, sorted, '/'-separated. */
export function templateFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const full = join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out;
}

/** Copy a template tree, text normalised to LF so the bytes (and the SHAs) match on every platform. */
export function copyTemplate(from, to) {
  const files = templateFiles(from);
  for (const rel of files) {
    const target = join(to, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(from, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n'));
  }
  return files;
}

function gitVersion() {
  const r = run(['git', '--version']);
  const m = /(\d+)\.(\d+)/.exec(r.stdout);
  return r.code === 0 && m ? [Number(m[1]), Number(m[2])] : null;
}

/** The nearest existing ancestor of `dir` (itself included). */
function existingAncestor(dir) {
  let d = resolve(dir);
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) return d;
    d = up;
  }
  return d;
}

/** Where ownership and permission bits apply. Windows has neither; its temp directory is the user's own. */
const POSIX = typeof process.getuid === 'function';

/**
 * setup's output when no --out is given: a new directory under the OS temp directory, its name unique and created
 * exclusively (mkdtemp), mode 0700 where modes apply. No one can have made it, or a link by its name, first.
 */
export function freshTempOutput() {
  return mkdtempSync(join(tmpdir(), 'mycelink-quickstart-'));
}

/** The lookup of `path` without following a final link, or null when nothing is there. */
function lookup(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Two lookups name one file. Node 22.12 on Windows leaves a path lookup's `dev` at 0; the file id still tells files apart. */
function sameFile(a, b) {
  return a.ino === b.ino && (a.dev === b.dev || a.dev === 0n || b.dev === 0n);
}

/**
 * Why someone else could write into, rename or replace a directory, or null (POSIX only). The output directory must
 * be the user's own and writable by no one else. A directory above it may also belong to root, and may be writable
 * by others when it is sticky (like /tmp), where only an entry's owner may rename or remove it. Group write counts
 * only for a group other than the user's own primary group: with user private groups (umask 002) that group is the
 * user alone.
 */
function foreignControl(st, { output }) {
  if (!POSIX) return null;
  const uid = BigInt(process.getuid());
  if (st.uid !== uid && (output || st.uid !== 0n)) return `belongs to uid ${st.uid}, not to you (uid ${uid})`;
  const othersWrite = (st.mode & 0o002n) !== 0n || ((st.mode & 0o020n) !== 0n && st.gid !== BigInt(process.getgid()));
  if (othersWrite && (output || (st.mode & 0o1000n) === 0n)) return 'is writable by other users';
  return null;
}

/** Refuse a location under a directory that would let someone else rename the workspace away and put theirs in its place. */
function refuseForeignAncestors(root) {
  if (!POSIX) return;
  for (let d = realpathSync.native(existingAncestor(dirname(root))); ; d = dirname(d)) {
    const why = foreignControl(statSync(d, { bigint: true }), { output: false });
    if (why !== null) throw new QuickstartError(`${root} lies under ${d}, which ${why}. Nothing was changed; choose an --out under directories only you control.`);
    if (dirname(d) === d) return;
  }
}

/** Refuse an output that is a link, not a directory, or (POSIX) a directory someone else controls. */
function refuseUnclaimable(root, st) {
  if (st.isSymbolicLink()) throw new QuickstartError(`${root} is a symbolic link or junction. Setup writes only into a real directory; nothing was changed. Choose another --out.`);
  if (!st.isDirectory()) throw new QuickstartError(`${root} exists and is not a directory.`);
  const why = foreignControl(st, { output: true });
  if (why !== null) throw new QuickstartError(`${root} ${why}. Nothing was changed; choose another --out, or make it yours and writable by you alone.`);
}

function changedWhileClaimed(root) {
  return new QuickstartError(`${root} changed while setup was claiming it: it is no longer the directory setup checked. Nothing more was written; choose another --out.`);
}

/**
 * Write the marker as a new file (O_CREAT|O_EXCL: never through an existing name or a final link) through its own
 * descriptor, then confirm the directory is still the one checked (`dir`) and the marker the file written. A
 * directory replaced by a link between the check and the write is refused, and O_EXCL leaves any file reached through
 * that link untouched.
 */
function writeMarker(root, dir) {
  const path = join(root, MARKER);
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ELOOP') throw changedWhileClaimed(root);
    throw err;
  }
  let written;
  try {
    writeFileSync(fd, JSON.stringify({ schema: 'mycelink-quickstart/1', feature_id: FEATURE_ID, repositories: { ...REPOS }, control: CONTROL }, null, 2) + '\n');
    written = fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
  const now = lookup(root);
  const marker = lookup(path);
  if (now === null || now.isSymbolicLink() || !sameFile(now, dir) || marker === null || marker.isSymbolicLink() || !marker.isFile() || marker.ino !== written.ino) {
    throw changedWhileClaimed(root);
  }
}

/**
 * Refuse anything but a fresh directory, or one an earlier setup made (with `force`). A missing directory is created
 * here, exclusively; an existing one must be a real directory, not a link or junction, and (POSIX) the user's own,
 * writable by no one else, under directories no one else can rename it in. The marker is written last, as a new
 * file, and the directory confirmed unchanged.
 */
export function prepareOutput(out, { force = false } = {}) {
  const root = resolve(out);
  const inside = run(['git', 'rev-parse', '--show-toplevel'], { cwd: existingAncestor(root) });
  if (inside.code === 0) {
    throw new QuickstartError(`${root} is inside the Git work tree ${inside.stdout.trim()}. The quickstart's repositories must be independent: choose an output directory outside any repository (for example under your temp directory).`);
  }
  refuseForeignAncestors(root);
  let dir = lookup(root);
  if (dir !== null) {
    refuseUnclaimable(root, dir);
    const entries = readdirSync(root);
    if (entries.length > 0) {
      if (!entries.includes(MARKER)) throw new QuickstartError(`${root} is not empty and was not created by the quickstart (no ${MARKER}). Nothing was changed; choose another --out.`);
      if (!force) throw new QuickstartError(`${root} holds an earlier quickstart. Re-run with --force to delete and recreate it, or choose another --out.`);
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      dir = null;
    }
  }
  if (dir === null) {
    // Missing parents writable by no one else; the directory itself only if nothing (not even a link) took its name.
    mkdirSync(dirname(root), { recursive: true, mode: 0o755 });
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (err) {
      if (err.code === 'EEXIST') throw new QuickstartError(`${root} appeared while setup was creating it. Nothing was written into it; choose another --out.`);
      throw err;
    }
    dir = lookup(root);
    if (dir === null) throw changedWhileClaimed(root);
    refuseUnclaimable(root, dir);
  }
  writeMarker(root, dir);
  // The long form of the path, as Git reports it (a Windows temp directory may be an 8.3 alias such as RUNNER~1).
  const real = realpathSync.native(root);
  if (!sameFile(statSync(real, { bigint: true }), dir)) throw changedWhileClaimed(root);
  return real;
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  // The only configuration the quickstart writes: a local identity.
  git(dir, ['config', '--local', 'user.name', IDENTITY.name]);
  git(dir, ['config', '--local', 'user.email', IDENTITY.email]);
}

export function commitAll(dir, message, { fixedDate = true } = {}) {
  git(dir, [...COMMIT_FLAGS, 'add', '-A']);
  git(dir, [...COMMIT_FLAGS, 'commit', '-q', '-m', message], fixedDate ? fixedDateEnv() : {});
  return git(dir, ['rev-parse', 'HEAD']);
}

/** `node <launcher> ...args` without a shell. */
export function mycelinkArgv(launcher, args) {
  return [process.execPath, launcher, ...args];
}

export function baselineMessage(name) {
  return `${name}: baseline for the Mycelink quickstart (contract v1)`;
}

/**
 * Create the workspace: the two product repositories with their baseline
 * commits, then the control repository (`mycelink init`, the approved PRD,
 * acceptance manifest, contract and graph), validated and committed.
 * Opens no controller key: the session that runs the feature opens its own.
 */
export function createWorkspace({ out, launcher = CHECKOUT_LAUNCHER, force = false, log = () => {} }) {
  const version = gitVersion();
  if (version === null) throw new QuickstartError('git was not found on PATH. Install Git 2.30 or later.');
  if (version[0] < 2 || (version[0] === 2 && version[1] < 30)) throw new QuickstartError(`git ${version.join('.')} is too old; the quickstart needs Git 2.30 or later.`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new QuickstartError(`Node.js ${process.versions.node} is too old; Mycelink needs 22.12 or later.`);
  const mycelink = resolve(launcher);
  if (!existsSync(mycelink)) throw new QuickstartError(`No Mycelink launcher at ${mycelink}. Pass --mycelink <plugin>/bin/mycelink.mjs.`);
  const cliVersion = must(mycelinkArgv(mycelink, ['--version'])).stdout.trim();

  const root = prepareOutput(out, { force });
  const repos = {};
  const baseline = {};
  for (const [name, dirName] of Object.entries(REPOS)) {
    const dir = join(root, dirName);
    initRepo(dir);
    copyTemplate(TEMPLATES[name], dir);
    baseline[name] = commitAll(dir, baselineMessage(dirName));
    repos[name] = dir;
    log(`created ${dirName} (main ${baseline[name].slice(0, 12)})`);
  }

  const control = join(root, CONTROL);
  initRepo(control);
  must(mycelinkArgv(mycelink, ['init', control]), { cwd: root });
  // The approved plan: repositories.yaml replaces init's empty manifest.
  copyTemplate(TEMPLATES.control, control);
  const claudeMd = join(control, 'CLAUDE.md');
  writeFileSync(claudeMd, `${readFileSync(claudeMd, 'utf8').trimEnd()}\n${CONTROL_CLAUDE_NOTE}`);
  for (const check of [['graph', 'validate', FEATURE_ID], ['repo', 'audit']]) {
    const r = run(mycelinkArgv(mycelink, [...check, '--control-root', control]), { cwd: root });
    if (r.code !== 0) throw new QuickstartError(`mycelink ${check.join(' ')} failed (exit ${r.code}):\n${r.stdout}${r.stderr}`);
  }
  const controlSha = commitAll(control, `mycelink control plane: ${FEATURE_ID} approved PRD, acceptance criteria and graph`);
  log(`created control (main ${controlSha.slice(0, 12)})`);
  return { root, control, repos, baseline, controlSha, launcher: mycelink, cliVersion };
}
