/**
 * Mycelink's own account of what it changed, for an operator who must tell
 * Mycelink's effects from anyone else's (CSET-203 r9: the benchmark's with
 * arm rolls back every change of a controller session that Mycelink did not
 * make, and a PreToolUse fence cannot know what a script will write).
 *
 * Off unless MYCELINK_PROVENANCE names an absolute directory. Then this
 * process records, in `<dir>/ledger.jsonl`, every file it changes through
 * node:fs: before the change, what it is about to change (an `intent`: a
 * process killed mid-write still says what it was writing), and after it,
 * each path's state (`done`: a file's SHA-256, size and mode, its bytes kept
 * once per digest in `<dir>/objects/`; a directory's mode; a symlink's
 * target; absence, and for a recursive removal everything under it). Around
 * every git command it runs that can change a repository it records the
 * repository's refs, indexes (what each stages) and metadata files before
 * and after (`git-intent`, `git-done`: only what changed). The first record
 * of a process names it by its command group and subcommand; no argument
 * value and nothing inside the ledger directory is recorded.
 *
 * What a change may rest on (CSET-203 r12: a change made after another is
 * not thereby made from it): just before each change, the paths the process
 * read through node:fs since its previous change — each with when it was
 * last read, never its content — and the git commands it ran meanwhile that
 * change nothing (where, and whether they could read every ref or the
 * stash), as one `reads` record. A process that only reads records nothing.
 *
 * One process appends whole lines, each with one write; several Mycelink
 * processes may append to the same ledger.
 *
 * One call is one change: what node:fs does inside one of the process's calls
 * (appendFileSync writes through the exported writeFileSync; on Node 22,
 * rmSync removes through rimraf's unlinkSync and rmdirSync) is part of that
 * call, recorded by its intent and done, and nothing node:fs reads for it is a
 * read of the process. The ledger is the same on every Node.
 *
 * Every path is recorded by its canonical name (security/paths.ts): the real
 * place, however the process spelled it. macOS reaches its temp directory
 * through `/var` (a link to `/private/var`), GitHub's Windows runners through
 * the 8.3 name `C:\Users\RUNNER~1`, while git names a repository's common
 * directory by its real path; a file the process wrote and the git metadata a
 * command changed must be named alike to be told apart from anyone else's.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, realpathDeepest } from '../security/paths.js';

const nodeRequire = createRequire(import.meta.url);
// The CommonJS face of node:fs: patching it and syncing reaches every ESM import of a function.
const fs = nodeRequire('node:fs') as typeof import('node:fs') & Record<string, unknown>;
/** The same object, written to (node:fs types some of its functions read-only). */
const patchable = fs as unknown as Record<string, unknown>;

export const PROVENANCE_ENV = 'MYCELINK_PROVENANCE';
export const LEDGER_SCHEMA = 'mycelink-provenance/1';
/** Bytes of a file the ledger keeps at most (larger files are recorded by digest only). */
export const MAX_KEPT_BYTES = 16 * 1024 * 1024;

const FUNCTIONS = [
  'writeFileSync',
  'appendFileSync',
  'renameSync',
  'unlinkSync',
  'rmSync',
  'rmdirSync',
  'mkdirSync',
  'mkdtempSync',
  'symlinkSync',
  'linkSync',
  'copyFileSync',
  'cpSync',
  'truncateSync',
  'chmodSync',
  'openSync',
  'closeSync',
  'createWriteStream',
] as const;
/** node:fs functions that read a path: what a later change of the process may rest on. */
const READ_FUNCTIONS = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'readlinkSync', 'opendirSync'] as const;
type Fn = (...args: any[]) => any;
const original = Object.fromEntries(FUNCTIONS.map((n) => [n, fs[n] as Fn])) as Record<(typeof FUNCTIONS)[number], Fn>;
const originalRead = Object.fromEntries(READ_FUNCTIONS.map((n) => [n, fs[n] as Fn])) as Record<(typeof READ_FUNCTIONS)[number], Fn>;
/** Above zero while the recorder itself reads (node's readFileSync opens through the exported openSync): nothing it reads is the process's. */
let quiet = 0;
/** Above zero while one of the process's node:fs calls runs: whatever node:fs does inside it is that call's. */
let depth = 0;

/** Run one of the process's node:fs calls: nothing inside it is recorded on its own, nothing it reads is the process's. */
function within<T>(call: () => T): T {
  depth += 1;
  quiet += 1;
  try {
    return call();
  } finally {
    quiet -= 1;
    depth -= 1;
  }
}

/** The canonical name of the entry an absolute path names, looked up unrecorded: naming a path reads nothing of the process's. */
function named(abs: string): string {
  quiet += 1;
  try {
    return canonicalPath(abs);
  } finally {
    quiet -= 1;
  }
}

/** The real place of a directory (a git command's working directory, a common directory, the ledger's), looked up unrecorded. */
function place(abs: string): string {
  quiet += 1;
  try {
    return realpathDeepest(abs);
  } finally {
    quiet -= 1;
  }
}
const lstat = fs.lstatSync;
const readFileOriginal = fs.readFileSync;
const readFile = ((...args: Parameters<typeof fs.readFileSync>) => {
  quiet += 1;
  try {
    return readFileOriginal(...args);
  } finally {
    quiet -= 1;
  }
}) as typeof fs.readFileSync;
const readlink = fs.readlinkSync;
const readdir = fs.readdirSync;
const exists = fs.existsSync;
/** Distinct paths, and git commands, one `reads` record names at most (the rest: `truncated`). */
export const MAX_READ_PATHS = 4096;
export const MAX_GIT_READS = 1024;

export type PathState =
  | { t: 'f'; sha256: string; size: number; mode: number; kept: boolean }
  | { t: 'd'; mode: number }
  | { t: 'l'; target: string }
  | { t: 'o' }
  | { t: 'absent'; recursive?: true };

/** A git command that changes nothing, as a later change may rest on it: where, when, and which refs it could read. */
export interface GitRead {
  sub: string;
  cwd: string;
  t: string;
  /** It could read every ref (an enumeration, `--all`, refs given on stdin). */
  all_refs: boolean;
  /** It names or reads the stash. */
  stash: boolean;
}

interface Recorder {
  dir: string;
  ledger: string;
  group: string;
  sub: string;
  seq: number;
  intents: number;
  started: boolean;
  fds: Map<number, string>;
  crashAfterIntent: number | null;
  /** Paths read since the last change, each with when it was last read. */
  reads: Map<string, string>;
  /** Git commands that changed nothing, run since the last change. */
  gitReads: GitRead[];
  readsTruncated: boolean;
}

let active: Recorder | null = null;

/** Wall-clock nanoseconds (microsecond resolution), as a decimal string: comparable with a file's ctime. */
function now(): string {
  return (BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n).toString();
}

function append(r: Recorder, record: Record<string, unknown>): void {
  if (!r.started) {
    r.started = true;
    (original.mkdirSync as Fn)(r.dir, { recursive: true });
    write(r, { schema: LEDGER_SCHEMA, kind: 'proc', pid: process.pid, ppid: process.ppid, t: now(), group: r.group, sub: r.sub });
  }
  write(r, record);
}

function write(r: Recorder, record: Record<string, unknown>): void {
  (original.appendFileSync as Fn)(r.ledger, `${JSON.stringify(record)}\n`);
}

/** A path argument by its canonical name, or null (a descriptor, or nothing a path names). */
function pathOf(p: unknown): string | null {
  if (typeof p === 'string') return named(resolve(p));
  if (Buffer.isBuffer(p)) return named(resolve(p.toString('utf8')));
  if (p instanceof URL) return named(resolve(fileURLToPath(p)));
  return null;
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/** Keep a file's bytes in the ledger's object store, once per digest. */
function keep(r: Recorder, sha: string, bytes: Buffer): void {
  const target = join(r.dir, 'objects', sha.slice(0, 2), sha);
  if (exists(target)) return;
  (original.mkdirSync as Fn)(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  (original.writeFileSync as Fn)(tmp, bytes, { flag: 'wx' });
  (original.renameSync as Fn)(tmp, target);
}

/** What is at a path now, its bytes kept when it is a file the ledger may keep. */
export function stateOf(path: string, r: Recorder | null = active): PathState {
  let st;
  try {
    st = lstat(path);
  } catch {
    return { t: 'absent' };
  }
  if (st.isFile()) {
    let bytes: Buffer;
    try {
      bytes = readFile(path) as Buffer;
    } catch {
      return { t: 'o' };
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    const kept = r !== null && bytes.length <= MAX_KEPT_BYTES;
    if (kept && r) keep(r, sha, bytes);
    return { t: 'f', sha256: sha, size: bytes.length, mode: st.mode & 0o7777, kept };
  }
  if (st.isDirectory()) return { t: 'd', mode: st.mode & 0o7777 };
  if (st.isSymbolicLink()) {
    try {
      return { t: 'l', target: String(readlink(path)) };
    } catch {
      return { t: 'o' };
    }
  }
  return { t: 'o' };
}

/** What the process read since its last change, recorded just before the next one (nothing when it read nothing). */
function flushReads(r: Recorder): void {
  if (r.reads.size === 0 && r.gitReads.length === 0) return;
  const paths = [...r.reads];
  const git = r.gitReads;
  const truncated = r.readsTruncated;
  r.reads = new Map();
  r.gitReads = [];
  r.readsTruncated = false;
  append(r, { kind: 'reads', pid: process.pid, t: now(), paths, git, ...(truncated ? { truncated: true } : {}) });
}

/** Note a path the process read (outside its own ledger). */
function noteRead(r: Recorder, path: string | null): void {
  if (quiet > 0 || path === null || inside(path, r.dir)) return;
  if (!r.reads.has(path) && r.reads.size >= MAX_READ_PATHS) {
    r.readsTruncated = true;
    return;
  }
  r.reads.delete(path);
  r.reads.set(path, now());
}

function intent(r: Recorder, op: string, paths: string[]): number {
  flushReads(r);
  const seq = ++r.seq;
  append(r, { kind: 'intent', pid: process.pid, seq, t: now(), op, paths });
  r.intents += 1;
  // Crash-recovery testing: killed right after the n-th intent, before the change it announced.
  if (r.crashAfterIntent !== null && r.intents >= r.crashAfterIntent) process.kill(process.pid, 'SIGKILL');
  return seq;
}

function done(r: Recorder, seq: number, op: string, states: { path: string; state: PathState }[]): void {
  append(r, { kind: 'done', pid: process.pid, seq, t: now(), op, states });
}

/** Everything under `dir`, deepest last: what a copy or a recursive creation left there. */
function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdir(dir) as string[];
  } catch {
    return out;
  }
  for (const n of names.sort()) {
    const p = join(dir, n);
    out.push(p);
    try {
      if (lstat(p).isDirectory()) walk(p, out);
    } catch {
      // gone
    }
  }
  return out;
}

const WRITE_FLAGS = (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND) >>> 0;
const writes = (flags: unknown): boolean => (typeof flags === 'number' ? (flags & WRITE_FLAGS) !== 0 : typeof flags === 'string' ? /[wax+]/.test(flags) : false);

/** The wrapped form of one node:fs function. */
function wrapped(name: (typeof FUNCTIONS)[number]): Fn {
  const fn = original[name];
  return function (this: unknown, ...args: any[]) {
    const r = active;
    // Inside one of the process's calls, a call node:fs makes for itself is part of that one.
    if (r === null || depth > 0) return fn.apply(this, args);
    const call = (): any => within(() => fn.apply(this, args));
    const outside = (p: string | null): p is string => p !== null && !inside(p, r.dir);
    switch (name) {
      case 'openSync': {
        // A read inside a read already noted (readFileSync opens through the exported openSync), or the recorder's own.
        if (quiet > 0 && !writes(args[1] ?? 'r')) return call();
        const path = pathOf(args[0]);
        if (!outside(path)) return call();
        if (!writes(args[1] ?? 'r')) {
          noteRead(r, path);
          return call();
        }
        const seq = intent(r, name, [path]);
        let fd: number;
        try {
          fd = call();
        } catch (error) {
          done(r, seq, name, [{ path, state: stateOf(path, r) }]);
          throw error;
        }
        r.fds.set(fd, `${seq}\0${path}`);
        return fd;
      }
      case 'closeSync': {
        const tracked = typeof args[0] === 'number' ? r.fds.get(args[0]) : undefined;
        const result = call();
        if (tracked !== undefined) {
          r.fds.delete(args[0]);
          const [seq, path] = tracked.split('\0') as [string, string];
          done(r, Number(seq), 'openSync', [{ path, state: stateOf(path, r) }]);
        }
        return result;
      }
      case 'createWriteStream': {
        const path = pathOf(args[0]);
        if (!outside(path)) return call();
        const seq = intent(r, name, [path]);
        const stream = call();
        stream.on('close', () => {
          if (active === r) done(r, seq, name, [{ path, state: stateOf(path, r) }]);
        });
        return stream;
      }
      case 'mkdtempSync': {
        const made = call() as string;
        const path = pathOf(made);
        if (outside(path)) {
          flushReads(r);
          done(r, ++r.seq, name, [{ path, state: stateOf(path, r) }]);
        }
        return made;
      }
      default:
        break;
    }
    // Every other function names its target(s) by path; a descriptor's change is recorded when it is closed.
    const targets: string[] =
      name === 'renameSync' ? [pathOf(args[0]), pathOf(args[1])].filter(outside) : name === 'symlinkSync' || name === 'linkSync' || name === 'copyFileSync' || name === 'cpSync' ? [pathOf(args[1])].filter(outside) : [pathOf(args[0])].filter(outside);
    if (targets.length === 0) return call();
    const seq = intent(r, name, targets);
    let result: unknown;
    try {
      result = call();
    } finally {
      const states: { path: string; state: PathState }[] = [];
      for (const path of targets) {
        const state = stateOf(path, r);
        if (name === 'rmSync' && state.t === 'absent' && (args[1] as { recursive?: boolean } | undefined)?.recursive) states.push({ path, state: { t: 'absent', recursive: true } });
        else states.push({ path, state });
      }
      // A recursive mkdir names the first directory it made: every one from there down.
      if (name === 'mkdirSync' && typeof result === 'string') {
        // Windows answers with a `\\?\` long-path prefix.
        const first = named(resolve(result.replace(/^\\\\\?\\/, '')));
        for (let p = dirname(targets[0] as string); inside(p, first) && p !== targets[0]; p = dirname(p)) states.unshift({ path: p, state: stateOf(p, r) });
      }
      if (name === 'cpSync') for (const p of walk(targets[0] as string)) states.push({ path: p, state: stateOf(p, r) });
      // A directory renamed into place moves what is in it: those are this call's too (a result slot into its quarantine,
      // whose removal can fail on Windows while another handle holds a file, leaving them where the rename put them).
      if (name === 'renameSync') {
        const to = targets.find((p) => p === pathOf(args[1]));
        if (to !== undefined && states.find((s) => s.path === to)?.state.t === 'd') for (const p of walk(to)) states.push({ path: p, state: stateOf(p, r) });
      }
      done(r, seq, name, states);
    }
    return result;
  };
}

/** The wrapped form of one node:fs function that reads a path: the path noted, the call unchanged. */
function readWrapped(name: (typeof READ_FUNCTIONS)[number]): Fn {
  const fn = originalRead[name];
  return function (this: unknown, ...args: any[]) {
    const r = active;
    // Nothing is noted while the recorder reads, or node:fs reads inside one of the process's calls.
    if (r === null || quiet > 0) return fn.apply(this, args);
    try {
      noteRead(r, pathOf(args[0]));
    } catch {
      // a path nothing can name: no read to note
    }
    // Noted once: what node does inside the call (readFileSync opens through openSync) is the same read.
    quiet += 1;
    try {
      return fn.apply(this, args);
    } finally {
      quiet -= 1;
    }
  };
}

/**
 * Install the recorder when `env` names an absolute ledger directory, for
 * the command `argv` (only its group and subcommand are recorded). Returns
 * whether it is on.
 */
export function installProvenance(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env[PROVENANCE_ENV];
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return false;
  if (active !== null) return true;
  const crash = Number(env['MYCELINK_PROVENANCE_CRASH_AFTER_INTENT']);
  const positional = argv.filter((a) => !a.startsWith('-'));
  active = {
    dir: place(resolve(dir)),
    ledger: join(place(resolve(dir)), 'ledger.jsonl'),
    group: positional[0] ?? '',
    sub: positional[1] ?? '',
    seq: 0,
    intents: 0,
    started: false,
    fds: new Map(),
    crashAfterIntent: Number.isInteger(crash) && crash > 0 ? crash : null,
    reads: new Map(),
    gitReads: [],
    readsTruncated: false,
  };
  for (const n of FUNCTIONS) fs[n] = wrapped(n);
  for (const n of READ_FUNCTIONS) patchable[n] = readWrapped(n);
  syncBuiltinESMExports();
  process.on('exit', flushOpenDescriptors);
  return true;
}

/** Descriptors still open at exit: what each left. */
function flushOpenDescriptors(): void {
  const r = active;
  if (r === null) return;
  for (const [, tracked] of r.fds) {
    const [seq, path] = tracked.split('\0') as [string, string];
    try {
      done(r, Number(seq), 'openSync', [{ path, state: stateOf(path, r) }]);
    } catch {
      // the ledger itself is gone
    }
  }
  r.fds.clear();
}

/** Remove the recorder (tests): node:fs as it was. */
export function uninstallProvenance(): void {
  if (active === null) return;
  flushOpenDescriptors();
  process.removeListener('exit', flushOpenDescriptors);
  active = null;
  for (const n of FUNCTIONS) fs[n] = original[n];
  for (const n of READ_FUNCTIONS) patchable[n] = originalRead[n];
  syncBuiltinESMExports();
}

export function provenanceActive(): boolean {
  return active !== null;
}

/** Run `fn` with nothing it reads noted: an observation of the workspace (the hooks' own), never an input a change rests on. */
export function unrecorded<T>(fn: () => T): T {
  quiet += 1;
  try {
    return fn();
  } finally {
    quiet -= 1;
  }
}

/** A ledger's records in order, and the lines that are not one (a process killed mid-line). */
export function readLedger(dir: string): { records: any[]; problems: string[] } {
  let text: string;
  try {
    text = String(readFile(join(dir, 'ledger.jsonl'), 'utf8'));
  } catch {
    return { records: [], problems: [] };
  }
  const records: any[] = [];
  const problems: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      problems.push(`line ${i + 1} is not a record`);
    }
  }
  return { records, problems };
}

// ---- git -------------------------------------------------------------------------

/** Git subcommands that never change a repository's refs, indexes or metadata. */
const GIT_READS = new Set(['rev-parse', 'diff', 'status', 'merge-base', 'ls-files', 'show', 'rev-list', 'log', 'diff-tree', 'cat-file', 'ls-tree', 'merge-tree', 'for-each-ref', 'check-ignore', 'check-attr', 'describe', 'name-rev', 'var', 'version', 'grep', 'shortlog', 'blame', 'count-objects', 'show-ref', 'cherry', 'diff-index', 'diff-files', 'ls-remote', 'hash-object']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The subcommand of a git argv, the arguments after it, and whether it can change the repository. */
function gitSubcommand(args: readonly string[]): { sub: string; rest: readonly string[]; changes: boolean } {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) i += GIT_VALUE_OPTIONS.has(args[i] as string) ? 2 : 1;
  const sub = args[i] ?? '';
  const rest = args.slice(i + 1);
  if (GIT_READS.has(sub)) return { sub, rest, changes: sub === 'hash-object' && rest.includes('-w') };
  if (sub === 'worktree' && rest[0] === 'list') return { sub, rest, changes: false };
  if (sub === 'stash' && ['list', 'show'].includes(rest[0] ?? '')) return { sub, rest, changes: false };
  if (sub === 'config' && rest.some((a) => /^--(get|get-all|get-regexp|list|get-urlmatch)$/.test(a) || a === '-l')) return { sub, rest, changes: false };
  if (sub === 'symbolic-ref' && rest.filter((a) => !a.startsWith('-')).length < 2) return { sub, rest, changes: false };
  if (sub === 'branch' && (rest.length === 0 || rest.every((a) => /^(--list|-l|-a|-r|--all|--show-current|-v|-vv|--contains|--merged|--no-merged|--format=.*)$/.test(a)))) return { sub, rest, changes: false };
  return { sub, rest, changes: sub !== '' };
}

/** Subcommands that enumerate or rewrite every ref. */
const GIT_ALL_REFS = new Set(['for-each-ref', 'show-ref', 'fsck', 'gc', 'pack-refs', 'reflog', 'repack', 'prune', 'fetch', 'push', 'clone']);
/** Options that make a command read every ref, or refs it is handed on stdin. */
const ALL_REFS_OPTION = /^--(all|branches|tags|remotes|glob|exclude|reflog|bisect|stdin|indexed-objects)(=|$)/;

/** Which refs a git command could read: every ref, and whether the stash. */
function refReach(sub: string, rest: readonly string[]): { all_refs: boolean; stash: boolean } {
  return { all_refs: GIT_ALL_REFS.has(sub) || rest.some((a) => ALL_REFS_OPTION.test(a)), stash: sub === 'stash' || rest.some((a) => /(?:^|[^A-Za-z0-9_-])stash(?:$|[^A-Za-z0-9_-])/.test(a)) };
}

type GitMeta = { refs: Record<string, string>; files: Record<string, PathState>; indexes: Record<string, string | null> };

/** Scratch files git rewrites by itself on ordinary commands. */
const GIT_SCRATCH = new Set(['ORIG_HEAD', 'FETCH_HEAD', 'COMMIT_EDITMSG', 'AUTO_MERGE', 'gc.log']);

/** A repository's refs (packed overlaid by loose), metadata files and what each index stages. */
export function gitMeta(common: string, keepIn: Recorder | null = null): GitMeta {
  const refs: Record<string, string> = {};
  try {
    for (const line of String(readFile(join(common, 'packed-refs'), 'utf8')).split('\n')) {
      const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\S+)$/.exec(line);
      if (m) refs[m[2] as string] = m[1] as string;
    }
  } catch {
    // no packed refs
  }
  for (const p of walk(join(common, 'refs'))) {
    try {
      if (!lstat(p).isFile()) continue;
      const text = String(readFile(p, 'utf8')).trim();
      if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text) || /^ref: \S+$/.test(text)) refs[p.slice(common.length + 1).split(sep).join('/')] = text;
    } catch {
      // gone
    }
  }
  const sha256 = /^\s*objectformat\s*=\s*sha256\s*$/im.test((() => {
    try {
      return String(readFile(join(common, 'config'), 'utf8'));
    } catch {
      return '';
    }
  })());
  const files: Record<string, PathState> = {};
  const indexes: Record<string, string | null> = {};
  const visit = (dir: string, relParts: string[]) => {
    let names: string[];
    try {
      names = readdir(dir) as string[];
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const p = join(dir, n);
      const parts = [...relParts, n];
      const top = parts.length === 1;
      const inWorktree = parts[0] === 'worktrees' && parts.length === 3;
      if ((top && ['objects', 'logs', 'refs', 'packed-refs', 'modules'].includes(n)) || (inWorktree && ['logs', 'refs'].includes(n))) continue;
      if ((top || inWorktree) && GIT_SCRATCH.has(n)) continue;
      if ((top || inWorktree) && n === 'index') {
        let bytes: Buffer | null = null;
        try {
          bytes = readFile(p) as Buffer;
        } catch {
          bytes = null;
        }
        indexes[p] = bytes === null ? null : indexSemantics(bytes, sha256 ? 32 : 20);
        continue;
      }
      let st;
      try {
        st = lstat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(p, parts);
      else files[p] = stateOf(p, keepIn);
    }
  };
  visit(common, []);
  return { refs, files, indexes };
}

/**
 * What an index stages: SHA-256 over each entry's mode, object id, stage,
 * extended flags and path, in index order — stat data and extensions left
 * out (a status that refreshes them changes nothing). Versions 2 to 4; null
 * for what it cannot read whole (a split index). The benchmark reads indexes
 * the same way (evals-public-projects/lib/snapshot.mjs).
 */
export function indexSemantics(bytes: Buffer, hashLength = 20): string | null {
  try {
    if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'DIRC') return null;
    const version = bytes.readUInt32BE(4);
    if (version < 2 || version > 4) return null;
    const count = bytes.readUInt32BE(8);
    const hash = createHash('sha256');
    let at = 12;
    let previous: Buffer = Buffer.alloc(0);
    for (let i = 0; i < count; i++) {
      const start = at;
      const mode = bytes.readUInt32BE(at + 24);
      const oid = bytes.toString('hex', at + 40, at + 40 + hashLength);
      at += 40 + hashLength;
      const flags = bytes.readUInt16BE(at);
      at += 2;
      let extended = 0;
      if (version >= 3 && flags & 0x4000) {
        extended = bytes.readUInt16BE(at);
        at += 2;
      }
      let path: Buffer;
      if (version === 4) {
        let b = bytes[at++] as number;
        let strip = b & 0x7f;
        while (b & 0x80) {
          b = bytes[at++] as number;
          strip = ((strip + 1) << 7) | (b & 0x7f);
        }
        const end = bytes.indexOf(0, at);
        if (end < 0 || strip > previous.length) return null;
        path = Buffer.concat([previous.subarray(0, previous.length - strip), bytes.subarray(at, end)]);
        at = end + 1;
      } else {
        const end = bytes.indexOf(0, at);
        if (end < 0) return null;
        path = bytes.subarray(at, end);
        at = start + Math.ceil((end - start + 1) / 8) * 8;
      }
      if (at > bytes.length) return null;
      previous = path;
      hash.update(`${mode.toString(8)} ${oid} ${(flags >> 12) & 3} ${extended & 0x6000}\t`);
      hash.update(path);
      hash.update('\0');
    }
    for (let x = at; x + 8 <= bytes.length - hashLength; ) {
      if (bytes.toString('latin1', x, x + 4) === 'link') return null;
      x += 8 + bytes.readUInt32BE(x + 4);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/** A recorded git command in flight: what it was, where, and the repository before it. */
export interface GitToken {
  seq: number;
  sub: string;
  common: string | null;
  before: GitMeta | null;
}

/** Before a git command: null when it cannot change anything (or nothing is recorded); else the repository as it was. */
export function gitIntent(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): GitToken | null {
  const r = active;
  if (r === null) return null;
  const { sub, rest, changes } = gitSubcommand(args);
  if (!changes) {
    // A read a later change may rest on: where, when, and which refs it could see.
    if (sub !== '') {
      if (r.gitReads.length < MAX_GIT_READS) r.gitReads.push({ sub, cwd: place(resolve(cwd)), t: now(), ...refReach(sub, rest) });
      else r.readsTruncated = true;
    }
    return null;
  }
  const q = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', env, windowsHide: true });
  const common = q.status === 0 && q.stdout.trim() !== '' ? place(resolve(cwd, q.stdout.trim())) : null;
  flushReads(r);
  const seq = ++r.seq;
  append(r, { kind: 'git-intent', pid: process.pid, seq, t: now(), sub, cwd: place(resolve(cwd)), common_dir: common, ...refReach(sub, rest) });
  r.intents += 1;
  if (r.crashAfterIntent !== null && r.intents >= r.crashAfterIntent) process.kill(process.pid, 'SIGKILL');
  return { seq, sub, common, before: common === null ? null : gitMeta(common, r) };
}

/** After a git command: the refs, indexes and metadata files it changed (their bytes kept). */
export function gitDone(token: GitToken, exit: number): void {
  const r = active;
  if (r === null) return;
  const changed = { refs: {} as Record<string, [string | null, string | null]>, files: {} as Record<string, [PathState, PathState]>, indexes: {} as Record<string, [string | null, string | null]> };
  if (token.common !== null && token.before !== null) {
    const after = gitMeta(token.common);
    for (const ref of new Set([...Object.keys(token.before.refs), ...Object.keys(after.refs)])) {
      const a = token.before.refs[ref] ?? null;
      const b = after.refs[ref] ?? null;
      if (a !== b) changed.refs[ref] = [a, b];
    }
    for (const p of new Set([...Object.keys(token.before.files), ...Object.keys(after.files)])) {
      const a = token.before.files[p] ?? ({ t: 'absent' } as PathState);
      const b = after.files[p] ?? ({ t: 'absent' } as PathState);
      // Compared by what each is (whether its bytes were kept is the ledger's, not the file's).
      const what = (x: PathState) => JSON.stringify(x.t === 'f' ? { ...x, kept: undefined } : x);
      if (what(a) !== what(b)) changed.files[p] = [a, b.t === 'f' ? stateOf(p, r) : b];
    }
    for (const p of new Set([...Object.keys(token.before.indexes), ...Object.keys(after.indexes)])) {
      const a = token.before.indexes[p] ?? null;
      const b = after.indexes[p] ?? null;
      if (a !== b) changed.indexes[p] = [a, b];
    }
  }
  append(r, { kind: 'git-done', pid: process.pid, seq: token.seq, t: now(), sub: token.sub, exit, common_dir: token.common, changed });
}
