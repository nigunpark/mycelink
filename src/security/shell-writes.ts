/**
 * What one Bash call writes, as the shell would run it (security/shell.ts).
 *
 * The controller fence (hooks/fence.ts) refuses a controller's write under a
 * product repository, a worker worktree, a result slot or the evidence before
 * it runs; the benchmark's monitor names the same writes independently
 * (evals-public-projects/lib/transcripts.mjs), in parity
 * (tests/benchmark/shell-writes-parity.test.ts). Each call has one directory,
 * as its shell does: where it started, moved by each `cd` (not one in a
 * subshell, nor the alternative after `||`, nor, given `exists`, one to a
 * directory that is not there). A write is:
 *
 *  - a redirection (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`);
 *  - tee, touch, mkdir, rm, rmdir, unlink, truncate, shred, cp, mv, install,
 *    ln, rsync, chmod, chown, chgrp, dd, patch (their operands, or for the
 *    copying ones their destination), `sed -i`, `perl -i`, `awk -i inplace`,
 *    `find ... -delete` / `-exec`;
 *  - a git command that changes commits, branches, the index or files, in the
 *    directory it runs in (`-C` options add up);
 *  - code an interpreter runs (python, node, perl, ruby, deno, bun: `-c`/`-e`,
 *    a heredoc or here-string fed to it, a script this call wrote through a
 *    heredoc or one on disk), at the paths its writing calls name
 *    (security/code-writes.ts: what it only reads is no write); a write to a
 *    path the reader cannot tell is `unknown` (at where the code runs), and
 *    so is a script an interpreter runs that cannot be read; a literal that
 *    is itself a shell command is read as one;
 *  - a shell script run by `bash` / `sh` (and the like), `source` or `.`:
 *    what its commands write, read like this call's (a script that cannot be
 *    read is an `unknown` write). `nohup`, `command`, `exec` and `time`, like
 *    `env`, `timeout` and `xargs`, run the command after them.
 *
 * Mycelink's own CLI is not a write, but a worker's gate run (`mycelink tdd
 * red|green|regression|refactor`, `evidence record`) is named apart: it
 * records evidence. Reads, builds and tests are not writes.
 */
import { posix, win32 } from 'node:path';
import { codeWrites } from './code-writes.js';
import { SHELLS, commandIndex, directoryAfter, evaluate, readShell, wordText, type Scope, type SimpleCommand, type Word } from './shell.js';

export interface ShellWrite {
  /** What wrote: `write` (a redirection), the command (`tee`, `sed -i`), `git <sub>`, `<interpreter> -c`. */
  action: string;
  /** Absolute, '/'-separated: the file written, or for git the directory it changed; for an unknown write, where it runs. */
  path: string;
  /** The writer names no path the reader can tell: it may write anywhere. */
  unknown?: true;
}

export interface ShellWrites {
  writes: ShellWrite[];
  /** Worker gate runs: `mycelink tdd <gate>` (or `evidence record`) and the node it names. */
  gates: { action: string; node: string | null }[];
  /**
   * Every `git stash` it runs (CSET-203 r12: worktrees share one stash): the
   * directory it runs in (null when the reader cannot tell), its subcommand
   * (`push` when none is given) and the entry it names, if any.
   */
  stashes: { path: string | null; sub: string; entry: string | null }[];
}

export interface ShellScope {
  cwd: string | null;
  home: string | null;
  /** Whether a directory exists (a running session's do): a `cd` to one that does not went nowhere. */
  exists?: (dir: string) => boolean;
  /** A script on disk an interpreter runs, at most a few hundred KiB, or null. */
  readFile?: (path: string) => string | null;
}

/** Git subcommands that change a repository's commits, branches, index or files. */
const GIT_WRITES = new Set(['commit', 'revert', 'cherry-pick', 'merge', 'rebase', 'am', 'apply', 'reset', 'restore', 'add', 'rm', 'mv', 'clean', 'pull', 'update-index', 'update-ref', 'commit-tree', 'read-tree', 'filter-branch', 'replace']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const BRANCH_MOVES = new Set(['-f', '--force', '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy']);
const FILE_WRITERS = new Set(['tee', 'touch', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'shred', 'cp', 'mv', 'install', 'ln', 'rsync', 'chmod', 'chown', 'chgrp', 'dd', 'patch']);
const DESTINATION = new Set(['cp', 'install', 'ln', 'rsync']);
const MODE_FIRST = new Set(['chmod', 'chown', 'chgrp']);
const WRITER_VALUE_OPTIONS = new Set(['-m', '-o', '-g', '-s', '-t', '-S', '-r', '-d', '--target-directory', '--suffix', '--mode', '--owner', '--group', '--size', '--reference']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|perl|ruby|deno|bun)(\.exe)?$/;

const driveForm = /^([A-Za-z]):[\\/]/;
const slash = (p: string): string => p.replace(/\\/g, '/');

/** A path made absolute: `~` against `home`, relative against `cwd`; null when there is no cwd. */
function absolute(path: string, cwd: string | null, home: string | null): string | null {
  let t = path;
  if (home && (t === '~' || t.startsWith('~/'))) t = home + t.slice(1);
  if (driveForm.test(t)) return slash(win32.normalize(t));
  if (t.startsWith('/')) return posix.normalize(t);
  if (t.startsWith('\\')) return slash(win32.normalize(t));
  if (!cwd) return null;
  return driveForm.test(cwd) ? slash(win32.join(cwd, t)) : posix.join(slash(cwd), t);
}

/** Is this simple command Mycelink's own CLI (`mycelink ...`, `node .../mycelink.mjs ...`)? Its argv from the group on, or null. */
export function mycelinkArgs(words: readonly Word[]): string[] | null {
  const k = commandIndex(words);
  const all = words.slice(k).map(wordText);
  const name = posix.basename(slash(all[0] ?? ''));
  if (name === 'mycelink' || name === 'mycelink.mjs') return all.slice(1);
  if (!/^node(\.exe)?$/.test(name)) return null;
  const at = all.findIndex((w, i) => i > 0 && !w.startsWith('-'));
  if (at < 0 || !/(^|\/)mycelink(\.mjs)?$/.test(slash(all[at] as string))) return null;
  return all.slice(at + 1);
}

/** Words with their options split off; after `--` everything is an operand. */
function operandsOf(words: { text: string; word: Word }[], valueOptions: ReadonlySet<string>): { operands: { text: string; word: Word }[]; options: [string, string | null, Word?][] } {
  const operands: { text: string; word: Word }[] = [];
  const options: [string, string | null, Word?][] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as { text: string; word: Word };
    if (w.text === '--') {
      operands.push(...words.slice(i + 1));
      break;
    }
    if (!w.text.startsWith('-') || w.text === '-') {
      operands.push(w);
      continue;
    }
    const eq = w.text.indexOf('=');
    if (w.text.startsWith('--') && eq > 0) options.push([w.text.slice(0, eq), w.text.slice(eq + 1)]);
    else if (valueOptions.has(w.text)) {
      const next = words[++i];
      options.push([w.text, next?.text ?? null, next?.word]);
    } else options.push([w.text, null]);
  }
  return { operands, options };
}

/**
 * Every write and worker gate of `command`, in order, with paths made
 * absolute against the directory each part runs in.
 */
export function shellWrites(command: string, scope: ShellScope, depth = 0): ShellWrites {
  const out: ShellWrites = { writes: [], gates: [], stashes: [] };
  if (depth > 4) return out;
  const vars: Record<string, string> = {};
  let dir = scope.cwd;
  /** Files this call wrote through a heredoc: an interpreter that runs one runs that body. */
  const scripts = new Map<string, string>();
  for (const cmd of readShell(command)) {
    const s: Scope = { vars, home: scope.home, cwd: dir };
    // A path a word names: a literal, or the directory a glob starts in.
    const resolve = (word: Word): string | null => {
      const v = evaluate(word, s);
      let p = v.literal;
      if (p === null) {
        if (!word.length || !('text' in (word[0] as object))) return null;
        const fixed = ((/^(?:\\.|[^*?[\\])*/.exec(v.pattern) as RegExpExecArray)[0] ?? '').replace(/\\(.)/g, '$1');
        p = fixed.includes('/') ? fixed.slice(0, fixed.lastIndexOf('/')) || '/' : '.';
      }
      return absolute(p, dir, scope.home);
    };
    // A target the reader cannot resolve (a substitution, an unknown variable) is judged where the call runs: never skipped.
    const write = (action: string, path: string | null): void => {
      const at = path ?? (dir === null ? null : absolute('.', dir, scope.home));
      if (at !== null) out.writes.push({ action, path: at });
    };
    commandWrites(cmd, s, resolve, write, out, scripts, scope, dir, depth);
    for (const a of cmd.assigns) {
      const v = evaluate(a.value, s);
      if (v.literal !== null) vars[a.name] = v.literal;
      else delete vars[a.name];
    }
    // A cd moves this shell unless it ran in a subshell, is the alternative after `||`, or went nowhere.
    const next = cmd.nested || cmd.after === '||' ? null : directoryAfter(cmd, s);
    if (next && (scope.exists === undefined || scope.exists(next))) dir = next;
  }
  return out;
}

function commandWrites(
  cmd: SimpleCommand,
  s: Scope,
  resolve: (word: Word) => string | null,
  write: (action: string, path: string | null) => void,
  out: ShellWrites,
  scripts: Map<string, string>,
  scope: ShellScope,
  dir: string | null,
  depth: number,
): void {
  const redirected = cmd.redirects.filter((r) => WRITE_REDIRECTS.has(r.op));
  for (const r of redirected) write('write', resolve(r.target));
  const k = commandIndex(cmd.words);
  const words = cmd.words.slice(k).map((w) => ({ text: wordText(w), word: w }));
  // A heredoc this command writes to a file is a script an interpreter may run next.
  const body = cmd.heredocs.find((h) => h.data !== false)?.body;
  if (body !== undefined) {
    for (const r of redirected) {
      const p = resolve(r.target);
      if (p !== null) scripts.set(p, body);
    }
    if (words[0] && posix.basename(words[0].text) === 'tee') for (const w of words.slice(1)) if (!w.text.startsWith('-')) {
      const p = resolve(w.word);
      if (p !== null) scripts.set(p, body);
    }
  }
  if (words.length === 0) return;
  const mycelink = mycelinkArgs(cmd.words);
  if (mycelink !== null) {
    // The CLI is the controller's tool; a gate run records a worker's evidence.
    const [group, sub, , node] = mycelink;
    if ((group === 'tdd' && ['red', 'green', 'regression', 'refactor', 'cycle'].includes(sub ?? '')) || (group === 'evidence' && sub === 'record')) out.gates.push({ action: `mycelink ${group} ${sub}`, node: node ?? null });
    return;
  }
  const name = posix.basename(slash((words[0] as { text: string }).text));
  const args = words.slice(1);
  if (name === 'git') {
    let i = 0;
    const dirs: Word[] = [];
    while (i < args.length && (args[i] as { text: string }).text.startsWith('-')) {
      const a = args[i] as { text: string; word: Word };
      if (a.text === '-C' && args[i + 1]) dirs.push((args[i + 1] as { word: Word }).word);
      i += GIT_VALUE_OPTIONS.has(a.text) ? 2 : 1;
    }
    const sub = args[i]?.text ?? '';
    const rest = args.slice(i + 1);
    const { operands, options } = operandsOf(rest, new Set(['-b', '-B', '--orphan']));
    const flags = new Set(options.map(([o]) => o));
    const writes =
      GIT_WRITES.has(sub) ||
      (sub === 'checkout' && (rest.some((w) => w.text === '--') || flags.has('-p') || flags.has('--patch') || operands.length >= 2 || operands.some((w) => w.text === '.'))) ||
      (sub === 'branch' && [...flags].some((f) => BRANCH_MOVES.has(f))) ||
      ((sub === 'stash' || sub === 'notes') && !['list', 'show'].includes(operands[0]?.text ?? 'push'));
    // `-C` options add up, each relative to the one before it (an absolute one starts over).
    let at: string | null = dir;
    for (const d of dirs) {
      const v = evaluate(d, s).literal;
      at = v === null || at === null ? null : absolute(v, at, scope.home);
    }
    if (sub === 'stash') out.stashes.push({ path: at === null ? null : absolute('.', at, scope.home), sub: operands[0]?.text ?? 'push', entry: operands[1]?.text ?? null });
    if (!writes) return;
    write(`git ${sub}`, at);
    return;
  }
  if (name === 'sed' || name === 'perl') {
    const inPlace = args.some((w) => w.text === '--in-place' || w.text.startsWith('--in-place=') || (/^-[A-Za-z0-9]*i/.test(w.text) && !w.text.startsWith('--')));
    if (inPlace) {
      const scriptOptions = name === 'sed' ? new Set(['-e', '-f', '--expression', '--file']) : new Set(['-e', '-E']);
      const { operands, options } = operandsOf(args, scriptOptions);
      const files = options.some(([o]) => scriptOptions.has(o)) ? operands : operands.slice(1);
      for (const w of files) write(`${name} -i`, resolve(w.word));
      return;
    }
    if (name === 'sed') return;
  }
  if (name === 'awk' || name === 'gawk') {
    const inplace = args.findIndex((w, i) => w.text === '-i' && args[i + 1]?.text === 'inplace');
    if (inplace >= 0) {
      const operands = args.slice(inplace + 2).filter((w) => !w.text.startsWith('-'));
      for (const w of operands.slice(1)) write(`${name} -i inplace`, resolve(w.word));
    }
    return;
  }
  if (name === 'find') {
    const at = args.findIndex((w) => w.text.startsWith('-') || w.text === '(' || w.text === '!');
    const expr = at < 0 ? [] : args.slice(at);
    if (expr.some((w) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(w.text))) {
      for (const w of at < 0 ? args : args.slice(0, at)) write('find', resolve(w.word));
    }
    return;
  }
  if (INTERPRETERS.test(name)) {
    interpreterWrites(name.replace(/\.exe$/, ''), args, cmd, resolve, write, out, scripts, scope, dir, depth);
    return;
  }
  // A shell script it runs (not `-c`, read as a nested shell): what its commands write.
  const sourced = name === 'source' || name === '.';
  if (sourced || (SHELLS.has(name) && !args.some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text)))) {
    const script = sourced ? args[0] : args.find((w) => !w.text.startsWith('-'));
    if (script === undefined) return;
    const p = resolve(script.word);
    const body = p === null ? null : (scripts.get(p) ?? scope.readFile?.(p) ?? null);
    if (body === null) {
      out.writes.push({ action: `${name} ${posix.basename(script.text)}`, path: dir === null ? '.' : (absolute('.', dir, scope.home) as string), unknown: true });
      return;
    }
    const inner = shellWrites(body, { ...scope, cwd: dir }, depth + 1);
    for (const w of inner.writes) out.writes.push({ ...w, action: `${name} ${posix.basename(script.text)}` });
    out.gates.push(...inner.gates);
    out.stashes.push(...inner.stashes);
    return;
  }
  if (!FILE_WRITERS.has(name)) return;
  if (name === 'dd') {
    for (const w of args) if (w.text.startsWith('of=')) write('dd', absolute(w.text.slice(3), dir, scope.home));
    return;
  }
  const { operands, options } = operandsOf(args, WRITER_VALUE_OPTIONS);
  const target = options.find(([o]) => o === '-t' || o === '--target-directory');
  let files = MODE_FIRST.has(name) ? operands.slice(1) : operands;
  if (name === 'patch') files = files.length ? files.slice(0, 1) : [{ text: '.', word: [{ text: '.', quoted: true }] }];
  else if (DESTINATION.has(name) && !(name === 'install' && options.some(([o]) => o === '-d'))) files = target ? [] : files.slice(-1);
  for (const w of files) write(name, resolve(w.word));
  if (target) write(name, target[2] ? resolve(target[2]) : absolute(target[1] ?? '', dir, scope.home));
}

/** The code an interpreter runs here, and what it writes. */
function interpreterWrites(
  name: string,
  args: { text: string; word: Word }[],
  cmd: SimpleCommand,
  resolve: (word: Word) => string | null,
  write: (action: string, path: string | null) => void,
  out: ShellWrites,
  scripts: Map<string, string>,
  scope: ShellScope,
  dir: string | null,
  depth: number,
): void {
  const codes: { action: string; code: string }[] = [];
  const inline = /^python/.test(name) ? ['-c'] : name === 'deno' ? ['eval'] : ['-e', '-E', '--eval', '-p', '--print'];
  let script: { text: string; word: Word } | null = null;
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as { text: string; word: Word };
    if (inline.includes(a.text) && args[i + 1]) {
      codes.push({ action: `${name} ${a.text}`, code: (args[i + 1] as { text: string }).text });
      // What follows inline code is its arguments, not a script.
      break;
    }
    if (a.text === '-') {
      stdin = true;
      break;
    }
    if (a.text.startsWith('-')) continue;
    if (name === 'deno' || name === 'bun') {
      if (a.text === 'run') continue;
    }
    script = a;
    break;
  }
  if (codes.length === 0 && script === null) stdin = true;
  if (stdin) for (const d of cmd.heredocs) codes.push({ action: `${name} -`, code: d.body });
  if (stdin) for (const w of cmd.strings) codes.push({ action: `${name} -`, code: wordText(w) });
  const here = dir === null ? '.' : (absolute('.', dir, scope.home) as string);
  if (script !== null) {
    const p = resolve(script.word);
    const body = p === null ? null : (scripts.get(p) ?? scope.readFile?.(p) ?? null);
    if (body !== null) codes.push({ action: `${name} ${posix.basename(script.text)}`, code: body });
    // A script it cannot read may write anything.
    else out.writes.push({ action: `${name} ${posix.basename(script.text)}`, path: here, unknown: true });
  }
  for (const { action, code } of codes) {
    const read = codeWrites(code, name);
    // The commands it runs: a literal that is a command line, and its literals joined (an argv array).
    for (const line of read.commands) {
      const inner = shellWrites(line, { ...scope, cwd: dir }, depth + 1);
      for (const w of inner.writes) out.writes.push({ ...w, action });
      out.gates.push(...inner.gates);
      out.stashes.push(...inner.stashes);
    }
    for (const w of read.writes) {
      const p = w.path === null ? null : absolute(w.path, dir, scope.home);
      if (p === null) out.writes.push({ action, path: here, unknown: true });
      else write(action, p);
    }
  }
}
