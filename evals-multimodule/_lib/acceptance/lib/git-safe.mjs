/**
 * Running git inside a repository someone else wrote is not inert: a
 * repository's own configuration can name programs git will execute
 * (core.fsmonitor, filter drivers, hooks, includes that pull in more of the
 * same). The acceptance runner and the external verifier therefore:
 *
 *   1. refuse a repository whose local configuration contains anything outside
 *      a small allowlist of inert keys (fail closed, with the offending keys);
 *   2. run git with system/global configuration disabled and the remaining
 *      command-executing knobs overridden on the command line;
 *   3. export commits with `ls-tree` + `cat-file`, which apply no filters.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

let neutral = null;
function neutralPaths() {
  if (neutral === null) {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-git-safe-'));
    const empty = join(dir, 'empty-config');
    writeFileSync(empty, '');
    const hooks = join(dir, 'no-hooks');
    mkdirSync(hooks);
    neutral = { empty, hooks };
  }
  return neutral;
}

/**
 * A comparable identity for a path: symlinks, junctions and Windows 8.3 short
 * names resolved; case folded where the file system is case-insensitive.
 */
export function pathKey(p) {
  let real;
  try {
    real = realpathSync.native(p);
  } catch {
    real = resolve(p);
  }
  real = real.replace(/[\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Run git with configuration-driven program execution neutralised. */
export function safeGit(cwd, args, { input, encoding = 'utf8', env = {} } = {}) {
  const { empty, hooks } = neutralPaths();
  const r = spawnSync(
    'git',
    [
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${hooks}`,
      '-c', `core.attributesFile=${empty}`,
      '-c', 'core.pager=cat',
      '-c', 'diff.external=',
      '-c', 'protocol.allow=never',
      '-c', 'core.untrackedCache=false',
      ...args,
    ],
    {
      cwd,
      input,
      encoding: encoding === 'buffer' ? undefined : encoding,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: empty,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_ATTR_SOURCE: EMPTY_TREE,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        ...env,
      },
    },
  );
  const text = (v) => (v === undefined || v === null ? '' : Buffer.isBuffer(v) ? v : String(v));
  return {
    code: r.status ?? -1,
    stdout: encoding === 'buffer' ? r.stdout : text(r.stdout).trim(),
    stderr: String(r.stderr ?? '').trim(),
    error: r.error,
  };
}

/**
 * Open `path` once and classify it through that descriptor, so the type check
 * and the read cannot be split by a swap of the path in between:
 * `{ kind: 'missing' }`, `{ kind: 'directory' }`, `{ kind: 'file', text }`, or
 * `{ kind: 'other' }` (devices, FIFOs, ... — never read). Errors other than
 * "does not exist" propagate so callers fail closed.
 */
export function readEntry(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'missing' };
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) return { kind: 'directory' };
    if (!st.isFile()) return { kind: 'other' };
    return { kind: 'file', text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/** The repository's git dir and common dir (handles `.git` files of worktrees). */
export function gitDirs(repo) {
  const dotGit = join(repo, '.git');
  const entry = readEntry(dotGit);
  let gitDir;
  if (entry.kind === 'directory') gitDir = dotGit;
  else if (entry.kind === 'file') {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(entry.text);
    if (!m) return null;
    gitDir = isAbsolute(m[1]) ? m[1] : resolve(repo, m[1]);
  } else return null;
  let commonDir = gitDir;
  const common = readEntry(join(gitDir, 'commondir'));
  if (common.kind === 'file') {
    const rel = common.text.trim();
    commonDir = isAbsolute(rel) ? rel : resolve(gitDir, rel);
  } else if (common.kind !== 'missing') return null;
  return { gitDir, commonDir };
}

const SAFE_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|autocrlf|safecrlf|eol|precomposeunicode|longpaths|quotepath|checkstat|trustctime|fscache|editor|pager|whitespace)$/,
  /^user\.(name|email|usegitconfigonly)$/,
  /^author\.(name|email)$/,
  /^committer\.(name|email)$/,
  /^(commit|tag)\.gpgsign$/,
  /^init\.defaultbranch$/,
  /^branch\..+\.(remote|merge|rebase|description|vscode-merge-base)$/,
  /^remote\..+\.(url|fetch|pushurl|prune|tagopt)$/,
  /^extensions\.(worktreeconfig|objectformat|refstorage)$/,
  /^(pull\.(rebase|ff)|merge\.(ff|conflictstyle)|rebase\.autostash|fetch\.prune|push\.(default|autosetupremote))$/,
  /^(gc\.(auto|autodetach)|maintenance\.(auto|strategy)|rerere\.enabled|status\.showuntrackedfiles|advice\..+|color\..+|safe\.directory)$/,
];

/** Parse a git config file into lower-cased "section.subsection.key" names. */
export function configKeys(text) {
  const keys = [];
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (header) {
      section = header[2] === undefined ? header[1].toLowerCase() : `${header[1].toLowerCase()}.${header[2]}`;
      continue;
    }
    if (line.startsWith('[')) {
      keys.push('<unparseable section header>');
      continue;
    }
    const key = /^([A-Za-z][A-Za-z0-9-]*)/.exec(line);
    if (!key || section === null) {
      keys.push('<unparseable line>');
      continue;
    }
    keys.push(`${section}.${key[1].toLowerCase()}`);
  }
  return keys;
}

/** Keys (or files) that make running git in this repository unsafe; empty = safe. */
export function unsafeGitConfig(repo) {
  const dirs = gitDirs(repo);
  if (dirs === null) return ['<no git directory>'];
  const problems = [];
  const files = [join(dirs.commonDir, 'config'), join(dirs.gitDir, 'config.worktree'), join(dirs.commonDir, 'config.worktree')];
  for (const file of new Set(files)) {
    const entry = readEntry(file);
    if (entry.kind === 'missing') continue;
    if (entry.kind !== 'file') {
      problems.push(`${file} (not a regular file)`);
      continue;
    }
    for (const key of configKeys(entry.text)) {
      if (!SAFE_KEYS.some((re) => re.test(key))) problems.push(key);
    }
  }
  for (const dir of new Set([dirs.gitDir, dirs.commonDir])) {
    const attrs = readEntry(join(dir, 'info', 'attributes'));
    if (attrs.kind === 'missing') continue;
    if (attrs.kind !== 'file') problems.push('info/attributes (not a regular file)');
    else if (/\b(filter|diff|merge)\s*=/.test(attrs.text)) problems.push('info/attributes (filter/diff/merge drivers)');
  }
  return [...new Set(problems)];
}

/**
 * Write the tree of `sha` into `target` byte-for-byte (no filters, no line
 * ending conversion). Symlinks and submodules are refused.
 */
export function exportCommit(repo, sha, target) {
  const list = safeGit(repo, ['ls-tree', '-r', '-z', '--full-tree', sha], { encoding: 'buffer' });
  if (list.code !== 0) throw new Error(`git ls-tree ${sha} failed in ${repo}: ${list.stderr}`);
  const entries = [];
  for (const record of list.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(record);
    if (!m) throw new Error(`unexpected ls-tree output in ${repo}: ${record.slice(0, 80)}`);
    const [, mode, type, objectId, path] = m;
    if (type !== 'blob' || mode === '120000') throw new Error(`${repo}@${sha.slice(0, 12)}: ${path} is a ${mode === '120000' ? 'symlink' : type}; refusing to export`);
    if (path.split('/').some((seg) => seg === '..' || seg === '.git' || seg === '')) throw new Error(`unsafe path in tree: ${path}`);
    entries.push({ objectId, path });
  }
  mkdirSync(target, { recursive: true });
  if (entries.length === 0) return 0;
  const batch = safeGit(repo, ['cat-file', '--batch'], { input: entries.map((e) => e.objectId).join('\n') + '\n', encoding: 'buffer' });
  if (batch.code !== 0) throw new Error(`git cat-file --batch failed in ${repo}: ${batch.stderr}`);
  const out = batch.stdout;
  let offset = 0;
  for (const entry of entries) {
    const nl = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, nl).toString('utf8');
    const hm = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!hm || hm[1] !== entry.objectId) throw new Error(`cat-file header mismatch for ${entry.path}: ${header}`);
    const size = Number(hm[2]);
    const content = out.subarray(nl + 1, nl + 1 + size);
    offset = nl + 1 + size + 1;
    const file = join(target, ...entry.path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return entries.length;
}
