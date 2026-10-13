/**
 * What one Bash call writes — the benchmark's own reading, independent of
 * Mycelink's fence (src/security/shell-writes.ts) and kept in parity with it
 * (tests/benchmark/shell-writes-parity.test.ts).
 *
 * Each call has one directory, as its shell does: where it started, moved by
 * each `cd` (not one in a subshell, nor the alternative after `||`, nor,
 * given `exists`, one to a directory that is not there). A write is a
 * redirection; tee, touch, mkdir, rm, rmdir, unlink, truncate, shred, cp, mv,
 * install, ln, rsync, chmod, chown, chgrp, dd, patch; `sed -i`, `perl -i`,
 * `awk -i inplace`; `find ... -delete` / `-exec`; a git command that changes
 * commits, branches, the index or files, in the directory it runs in; code
 * an interpreter runs (python, node, perl, ruby, deno, bun: `-c`/`-e`, a
 * heredoc or here-string fed to it, a script the call itself wrote through a
 * heredoc or one on disk), at the paths its writing calls name
 * (lib/code-writes.mjs: what it only reads is no write) — a write to a path
 * the reader cannot tell, or a script it cannot read, is `unknown` — or the
 * commands it runs, read from its literals as shell; or a shell script run
 * by `bash` / `sh`, `source` or `.`, read like the call. A worker gate run
 * through Mycelink's CLI (`tdd red|green|regression|refactor`, `evidence
 * record`) is named apart: it records evidence. Mycelink's other commands,
 * reads, builds and tests are not writes.
 */
import { posix, win32 } from 'node:path';
import { codeWrites } from './code-writes.mjs';
import { SHELLS, commandIndex, directoryAfter, evaluate, readShell, wordText } from './shell.mjs';

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
const slash = (p) => p.replace(/\\/g, '/');

function absolute(path, cwd, home) {
  let t = path;
  if (home && (t === '~' || t.startsWith('~/'))) t = home + t.slice(1);
  if (driveForm.test(t)) return slash(win32.normalize(t));
  if (t.startsWith('/')) return posix.normalize(t);
  if (!cwd) return null;
  return driveForm.test(cwd) ? slash(win32.join(cwd, t)) : posix.join(slash(cwd), t);
}

/** Mycelink's own CLI (`mycelink ...`, `node .../mycelink.mjs ...`): its argv from the group on, or null. */
export function mycelinkArgv(words) {
  const k = commandIndex(words);
  const all = words.slice(k).map(wordText);
  const name = posix.basename(slash(all[0] ?? ''));
  if (name === 'mycelink' || name === 'mycelink.mjs') return all.slice(1);
  if (!/^node(\.exe)?$/.test(name)) return null;
  const at = all.findIndex((w, i) => i > 0 && !w.startsWith('-'));
  if (at < 0 || !/(^|\/)mycelink(\.mjs)?$/.test(slash(all[at]))) return null;
  return all.slice(at + 1);
}

function operandsOf(words, valueOptions) {
  const operands = [];
  const options = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
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
    else if (valueOptions.has(w.text)) options.push([w.text, words[++i]?.text ?? null, words[i]?.word]);
    else options.push([w.text, null]);
  }
  return { operands, options };
}

/**
 * Every write and worker gate of one Bash call: `{ writes: [{ action, path,
 * git?, gate?, node? }], gates: [{ action, node }], dir }` — paths absolute,
 * git writes the directory they changed (`git: true`), a gate run in its
 * place among them (`gate: true`, its node); `dir` where the call's shell
 * ended.
 */
export function lineWrites(command, { cwd = null, home = null, exists = null, readFile = null } = {}, depth = 0) {
  const out = { writes: [], gates: [], dir: cwd };
  if (depth > 4) return out;
  const vars = {};
  let dir = cwd;
  const scripts = new Map();
  for (const cmd of readShell(command)) {
    const scope = { vars, home, cwd: dir };
    const resolve = (word) => {
      const v = evaluate(word, scope);
      let p = v.literal;
      if (p === null) {
        if (!word.length || !('text' in word[0])) return null;
        const fixed = /^(?:\\.|[^*?[\\])*/.exec(v.pattern)[0].replace(/\\(.)/g, '$1');
        p = fixed.includes('/') ? fixed.slice(0, fixed.lastIndexOf('/')) || '/' : '.';
      }
      return absolute(p, dir, home);
    };
    // A target the reader cannot resolve (a substitution, an unknown variable) is judged where the call runs: never skipped.
    const write = (action, path, git = false) => {
      const at = path ?? (dir === null ? null : absolute('.', dir, home));
      if (at !== null) out.writes.push({ action, path: at, ...(git ? { git: true } : {}) });
    };
    simpleWrites({ cmd, scope, resolve, write, out, scripts, dir, home, exists, readFile, depth });
    for (const a of cmd.assigns) {
      const v = evaluate(a.value, scope);
      if (v.literal !== null) vars[a.name] = v.literal;
      else delete vars[a.name];
    }
    const next = cmd.nested || cmd.after === '||' ? null : directoryAfter(cmd, scope);
    if (next && (exists === null || exists(next))) dir = next;
  }
  out.dir = dir;
  return out;
}

function simpleWrites({ cmd, scope, resolve, write, out, scripts, dir, home, exists, readFile, depth }) {
  const redirected = cmd.redirects.filter((r) => WRITE_REDIRECTS.has(r.op));
  for (const r of redirected) write('write', resolve(r.target));
  const k = commandIndex(cmd.words);
  const words = cmd.words.slice(k).map((w) => ({ text: wordText(w), word: w }));
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
  const mycelink = mycelinkArgv(cmd.words);
  if (mycelink !== null) {
    const [group, sub, , node] = mycelink;
    if ((group === 'tdd' && ['red', 'green', 'regression', 'refactor'].includes(sub ?? '')) || (group === 'evidence' && sub === 'record')) {
      out.gates.push({ action: `mycelink ${group} ${sub}`, node: node ?? null });
      // In order among the writes too: a gate records evidence.
      out.writes.push({ action: `mycelink ${group} ${sub}`, path: null, node: node ?? null, gate: true });
    }
    return;
  }
  const name = posix.basename(slash(words[0].text));
  const args = words.slice(1);
  if (name === 'git') {
    let i = 0;
    const dirs = [];
    while (i < args.length && args[i].text.startsWith('-')) {
      if (args[i].text === '-C' && args[i + 1]) dirs.push(args[i + 1].word);
      i += GIT_VALUE_OPTIONS.has(args[i].text) ? 2 : 1;
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
    if (!writes) return;
    // `-C` options add up, each relative to the one before it (an absolute one starts over).
    let at = dir;
    for (const d of dirs) {
      const v = evaluate(d, scope).literal;
      at = v === null || at === null ? null : absolute(v, at, home);
    }
    write(`git ${sub}`, at, true);
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
    const at = args.findIndex((w, i) => w.text === '-i' && args[i + 1]?.text === 'inplace');
    if (at >= 0) for (const w of args.slice(at + 2).filter((x) => !x.text.startsWith('-')).slice(1)) write(`${name} -i inplace`, resolve(w.word));
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
    interpreted({ name: name.replace(/\.exe$/, ''), args, cmd, resolve, write, out, scripts, dir, home, exists, readFile, depth });
    return;
  }
  // A shell script it runs (not `-c`, read as a nested shell): what its commands write.
  const sourced = name === 'source' || name === '.';
  if (sourced || (SHELLS.has(name) && !args.some((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text)))) {
    const script = sourced ? args[0] : args.find((w) => !w.text.startsWith('-'));
    if (script === undefined) return;
    const p = resolve(script.word);
    const body = p === null ? null : (scripts.get(p) ?? readFile?.(p) ?? null);
    const action = `${name} ${posix.basename(script.text)}`;
    if (body === null) {
      out.writes.push({ action, path: dir === null ? '.' : absolute('.', dir, home), unknown: true });
      return;
    }
    const inner = lineWrites(body, { cwd: dir, home, exists, readFile }, depth + 1);
    for (const w of inner.writes) out.writes.push(w.gate ? w : { ...w, action });
    out.gates.push(...inner.gates);
    return;
  }
  if (!FILE_WRITERS.has(name)) return;
  if (name === 'dd') {
    for (const w of args) if (w.text.startsWith('of=')) write('dd', absolute(w.text.slice(3), dir, home));
    return;
  }
  const { operands, options } = operandsOf(args, WRITER_VALUE_OPTIONS);
  const target = options.find(([o]) => o === '-t' || o === '--target-directory');
  let files = MODE_FIRST.has(name) ? operands.slice(1) : operands;
  if (name === 'patch') files = files.length ? files.slice(0, 1) : [{ text: '.', word: [{ text: '.', quoted: true }] }];
  else if (DESTINATION.has(name) && !(name === 'install' && options.some(([o]) => o === '-d'))) files = target ? [] : files.slice(-1);
  for (const w of files) write(name, resolve(w.word));
  if (target) write(name, target[2] ? resolve(target[2]) : absolute(target[1] ?? '', dir, home));
}

function interpreted({ name, args, cmd, resolve, write, out, scripts, dir, home, exists, readFile, depth }) {
  const codes = [];
  const inline = /^python/.test(name) ? ['-c'] : name === 'deno' ? ['eval'] : ['-e', '-E', '--eval', '-p', '--print'];
  let script = null;
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (inline.includes(a.text) && args[i + 1]) {
      codes.push({ action: `${name} ${a.text}`, code: args[i + 1].text });
      // What follows inline code is its arguments, not a script.
      break;
    }
    if (a.text === '-') {
      stdin = true;
      break;
    }
    if (a.text.startsWith('-')) continue;
    if ((name === 'deno' || name === 'bun') && a.text === 'run') continue;
    script = a;
    break;
  }
  if (codes.length === 0 && script === null) stdin = true;
  if (stdin) for (const d of cmd.heredocs) codes.push({ action: `${name} -`, code: d.body });
  if (stdin) for (const w of cmd.strings) codes.push({ action: `${name} -`, code: wordText(w) });
  const here = dir === null ? '.' : absolute('.', dir, home);
  if (script !== null) {
    const p = resolve(script.word);
    const body = p === null ? null : (scripts.get(p) ?? readFile?.(p) ?? null);
    if (body !== null) codes.push({ action: `${name} ${posix.basename(script.text)}`, code: body });
    // A script it cannot read may write anything.
    else out.writes.push({ action: `${name} ${posix.basename(script.text)}`, path: here, unknown: true });
  }
  for (const { action, code } of codes) {
    const read = codeWrites(code, name);
    for (const line of read.commands) {
      const inner = lineWrites(line, { cwd: dir, home, exists, readFile }, depth + 1);
      for (const w of inner.writes) out.writes.push(w.gate ? w : { ...w, action });
      out.gates.push(...inner.gates);
    }
    for (const w of read.writes) {
      const p = w.path === null ? null : absolute(w.path, dir, home);
      if (p === null) out.writes.push({ action, path: here, unknown: true });
      else write(action, p);
    }
  }
}
