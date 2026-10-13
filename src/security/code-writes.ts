/**
 * What code an interpreter runs writes, read from its text (security/shell-writes.ts).
 *
 * CSET-203 r4, r5, r6 and r9: a controller generated its graph with a script
 * that read the approved criteria (`open('features/X/ACCEPTANCE.json')`) and
 * wrote the graph; reading every path-like literal of code that writes
 * anything as a write target refused those reads as writes of the criteria.
 * Here a write is a call that writes, at the path its arguments name:
 *
 *  - Python: `open(path, mode)` (and `io.open`, `codecs.open`) with a mode
 *    that writes (`w`, `a`, `x`, `+`; no mode reads); `os.remove`, `unlink`,
 *    `rmdir`, `removedirs`, `makedirs`, `mkdir`, `truncate`, `chmod`, `chown`;
 *    `os.rename` / `replace` / `renames` (both paths), `os.symlink` / `link`
 *    (the link); `shutil.copy*` / `copytree` (the destination), `move` (both),
 *    `rmtree` and any other `shutil` call (its first path); a `Path(...)`'s
 *    `write_text`, `write_bytes`, `touch`, `mkdir`, `unlink`, `rmdir`,
 *    `chmod`, `symlink_to`, `hardlink_to`, `open` with a writing mode, and
 *    `rename` / `replace` (both paths);
 *  - JavaScript: `fs` (`fs.`, `fsp.`, `promises.`, or a bare `...Sync` name)
 *    `writeFile`, `appendFile`, `createWriteStream`, `mkdir`, `mkdtemp`, `rm`,
 *    `rmdir`, `unlink`, `truncate`, `chmod`, `utimes` (the path),
 *    `copyFile`, `cp`, `link`, `symlink` (the destination), `rename` (both),
 *    `open` with flags that write;
 *  - code that runs commands (`subprocess`, `os.system`, `child_process`):
 *    its literals, read as shell commands.
 *
 * A path argument is a string literal (no interpolation), a `path.join` /
 * `os.path.join` / `resolve` of literals, a `Path(...)` of literals joined
 * with `/`, or a name assigned once to one of those; anything else is a
 * write to a path the reader cannot tell (`path: null`), which a fence must
 * not take for a write nowhere. Other languages' code is read as before:
 * when it writes at all, every path-like literal it holds.
 */

export interface CodeWrite {
  /** The path as the code names it (relative to where it runs), or null when the reader cannot tell. */
  path: string | null;
  /** The call that writes (`open`, `os.replace`, `writeFileSync`, ...). */
  call: string;
}

export interface CodeWrites {
  writes: CodeWrite[];
  /** Command lines it runs: its string literals that contain whitespace, and all of them joined (an argv array). */
  commands: string[];
}

type Lang = 'python' | 'js' | 'other';

interface Literal {
  start: number;
  end: number;
  value: string | null;
}

/** A literal's place in the masked code: not a space (an argument that is only a literal stays one), nothing the structure reads. */
export const HOLE = '\u0001';

/**
 * The string literals of code (their values; null when interpolated), and
 * the code with each literal (its prefix included) filled with HOLE and each
 * comment blanked, so calls and arguments are read on what is left.
 */
function scan(code: string, lang: Lang): { literals: Literal[]; masked: string } {
  const literals: Literal[] = [];
  const out = code.split('');
  const fill = (a: number, b: number, ch: string) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ch;
  };
  const blank = (a: number, b: number) => fill(a, b, ' ');
  let i = 0;
  while (i < code.length) {
    const c = code[i] as string;
    if (lang === 'python' && c === '#') {
      const end = code.indexOf('\n', i);
      blank(i, end < 0 ? code.length : end);
      i = end < 0 ? code.length : end;
      continue;
    }
    if (lang === 'js' && c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      blank(i, end < 0 ? code.length : end);
      i = end < 0 ? code.length : end;
      continue;
    }
    if (lang === 'js' && c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      blank(i, end < 0 ? code.length : end + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || (lang === 'js' && c === '`')) {
      // A Python string's prefix (r, b, f, u and pairs) sits just before the quote.
      let prefix = '';
      if (lang === 'python') {
        let p = i - 1;
        while (p >= 0 && /[rRbBfFuU]/.test(code[p] as string) && i - p <= 2) p--;
        if (p < 0 || !/[A-Za-z0-9_]/.test(code[p] as string)) prefix = code.slice(p + 1, i).toLowerCase();
      }
      const triple = lang === 'python' && code.slice(i, i + 3) === c.repeat(3);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      let value = '';
      let interpolated = prefix.includes('f');
      while (j < code.length) {
        if (code.startsWith(quote, j)) break;
        const ch = code[j] as string;
        if (ch === '\\' && !prefix.includes('r')) {
          const next = code[j + 1] ?? '';
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
          continue;
        }
        if (!triple && ch === '\n' && c !== '`') break;
        if (c === '`' && ch === '$' && code[j + 1] === '{') interpolated = true;
        value += ch;
        j += 1;
      }
      const end = Math.min(code.length, j + quote.length);
      const start = i - prefix.length;
      literals.push({ start, end, value: interpolated ? null : value });
      fill(start, end, HOLE);
      i = end;
      continue;
    }
    i += 1;
  }
  return { literals, masked: out.join('') };
}

/** The top-level argument spans of the call whose `(` is at `open`. */
function argsOf(masked: string, open: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = open + 1;
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        if (masked.slice(start, k).trim() !== '') spans.push({ start, end: k });
        return spans;
      }
      continue;
    }
    if (ch === ',' && depth === 1) {
      spans.push({ start, end: k });
      start = k + 1;
    }
  }
  return spans;
}

const JOINERS = /^(?:os\.path\.join|path\.join|posix\.join|win32\.join|join|path\.resolve|resolve|Path|pathlib\.Path|PurePath|PurePosixPath)$/;

/**
 * What an expression names as a path: one literal; a joiner (path.join,
 * os.path.join, resolve, Path) of literals; a Path joined with `/`
 * literals; a name assigned once to one of those. Null otherwise.
 */
function pathValue(code: string, masked: string, literals: Literal[], start: number, end: number, names: Map<string, string | null>, depth = 0): string | null {
  if (depth > 4) return null;
  const text = masked.slice(start, end);
  const trimmedStart = start + (text.length - text.trimStart().length);
  const trimmedEnd = end - (text.length - text.trimEnd().length);
  if (trimmedStart >= trimmedEnd) return null;
  const inner = literals.filter((l) => l.start >= trimmedStart && l.end <= trimmedEnd);
  const skeleton = masked.slice(trimmedStart, trimmedEnd);
  // One literal, nothing else.
  if (inner.length === 1 && inner[0]?.start === trimmedStart && inner[0].end === trimmedEnd) return inner[0].value;
  // `Path(...) / 'a' / 'b'`, or a joiner call of literals.
  const parts = splitTopLevel(skeleton, '/');
  if (parts.length > 1 && /^\s*(?:Path|pathlib\.Path|PurePath|PurePosixPath)\s*\(/.test(skeleton)) {
    const values: string[] = [];
    let at = trimmedStart;
    for (const p of parts) {
      const v = pathValue(code, masked, literals, at, at + p.length, names, depth + 1);
      if (v === null) return null;
      values.push(v);
      at += p.length + 1;
    }
    return values.join('/');
  }
  const call = /^\s*([A-Za-z_][\w.]*)\s*\(/.exec(skeleton);
  if (call && JOINERS.test(call[1] as string)) {
    const open = trimmedStart + skeleton.indexOf('(');
    const close = matching(masked, open);
    if (close !== trimmedEnd - 1) return null;
    const values: string[] = [];
    for (const a of argsOf(masked, open)) {
      const v = pathValue(code, masked, literals, a.start, a.end, names, depth + 1);
      if (v === null) return null;
      values.push(v);
    }
    if (values.length === 0) return null;
    // A later absolute part starts over, as join and resolve do.
    let joined = '';
    for (const v of values) joined = v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) ? v : joined === '' ? v : `${joined.replace(/\/+$/, '')}/${v}`;
    return joined;
  }
  const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(skeleton)?.[1];
  if (name !== undefined && names.has(name)) return names.get(name) ?? null;
  return null;
}

function matching(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === sep && depth === 0 && text[k + 1] !== sep && text[k - 1] !== sep) {
      out.push(text.slice(start, k));
      start = k + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Names assigned exactly once, to what they name as a path (null when it is no path the reader can tell). */
function assignments(code: string, masked: string, literals: Literal[]): Map<string, string | null> {
  const seen = new Map<string, { start: number; end: number }[]>();
  const rx = /(?:^|[\n;{(]\s*|\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*=(?!=)\s*/g;
  for (let m = rx.exec(masked); m; m = rx.exec(masked)) {
    const name = m[1] as string;
    const start = m.index + m[0].length;
    let end = start;
    let depth = 0;
    for (; end < masked.length; end++) {
      const ch = masked[end];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if ((ch === '\n' || ch === ';' || ch === ',') && depth === 0) break;
    }
    if (!seen.has(name)) seen.set(name, []);
    seen.get(name)?.push({ start, end });
  }
  const names = new Map<string, string | null>();
  for (const [name, spans] of seen) names.set(name, null);
  for (let pass = 0; pass < 3; pass++) {
    for (const [name, spans] of seen) {
      if (spans.length !== 1) continue;
      const s = spans[0] as { start: number; end: number };
      names.set(name, pathValue(code, masked, literals, s.start, s.end, names));
    }
  }
  return names;
}

const PY_WRITE_FIRST = /\bos\.(remove|unlink|rmdir|removedirs|makedirs|mkdir|truncate|chmod|chown|lchown|mkfifo|mknod)\s*\(/g;
const PY_WRITE_BOTH = /\bos\.(rename|replace|renames)\s*\(/g;
const PY_WRITE_SECOND = /\bos\.(symlink|link)\s*\(/g;
const PY_SHUTIL = /\bshutil\.(\w+)\s*\(/g;
const PY_OPEN = /(?:(?<![\w.])|\b(?:io|codecs)\.)open\s*\(/g;
const PY_PATH_METHOD = /\.(write_text|write_bytes|touch|mkdir|unlink|rmdir|chmod|lchmod|symlink_to|hardlink_to|open|rename|replace)\s*\(/g;
const JS_FIRST = /(?:(?:\.\s*|(?<![\w$.]))(writeFileSync|appendFileSync|createWriteStream|mkdirSync|mkdtempSync|rmSync|rmdirSync|unlinkSync|truncateSync|chmodSync|utimesSync)|(?:\b(?:fs|fsp|promises|fsPromises|fse)\s*\.\s*|\)\s*\.\s*(?:promises\s*\.\s*)?)(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|truncate|chmod|utimes|outputFile|remove|emptyDir|ensureDir|ensureFile)|(?<![\w$.])(writeFile|appendFile|unlink|rmdir|truncate))\s*\(/g;
const JS_SECOND = /(?:(?:\.\s*|(?<![\w$.]))(copyFileSync|cpSync|linkSync|symlinkSync)|(?:\b(?:fs|fsp|promises|fsPromises|fse)\s*\.\s*|\)\s*\.\s*(?:promises\s*\.\s*)?)(copyFile|cp|link|symlink|copy)|(?<![\w$.])(copyFile|symlink))\s*\(/g;
const JS_BOTH = /(?:(?:\.\s*|(?<![\w$.]))(renameSync)|(?:\b(?:fs|fsp|promises|fsPromises|fse)\s*\.\s*|\)\s*\.\s*(?:promises\s*\.\s*)?)(rename|move)|(?<![\w$.])(renameSync))\s*\(/g;
const JS_OPEN = /(?:(?:\.\s*|(?<![\w$.]))(openSync)|(?:\b(?:fs|fsp|promises|fsPromises|fse)\s*\.\s*|\)\s*\.\s*(?:promises\s*\.\s*)?)(open)|(?<![\w$.])(openSync))\s*\(/g;
const PY_SPAWN = /\bsubprocess\.|\bos\.(?:system|popen|exec\w*|spawn\w*)\s*\(/;
const JS_SPAWN = /(?:execSync|execFileSync|spawnSync)\s*\(|\b(?:cp|child_process|childProcess)\.(?:exec|execFile|spawn|fork)\s*\(|(?<![\w$.])(?:exec|execFile|spawn|system)\s*\(/;
const OTHER_WRITE = /\bFile\.(?:write|open|delete|rename|unlink)\b|\bFileUtils\.|\bopen\s*\(?\s*(?:my\s+)?\$?\w*\s*,\s*['"]?\s*\+?(?:>|>>)|\b(?:unlink|rename|mkdir|rmdir)\s*\(/;

/** The writes and commands of `code` run by `lang` (python, js, or another language). */
export function codeWrites(code: string, language: string): CodeWrites {
  const lang: Lang = /^python/.test(language) ? 'python' : /^(node|nodejs|deno|bun)$/.test(language) ? 'js' : 'other';
  const { literals, masked } = scan(code, lang);
  const writes: CodeWrite[] = [];
  const valueAt = (a: { start: number; end: number } | undefined, names: Map<string, string | null>): string | null => (a === undefined ? null : pathValue(code, masked, literals, a.start, a.end, names));
  if (lang === 'other') {
    if (OTHER_WRITE.test(masked) || OTHER_WRITE.test(code)) {
      const named = literals.map((l) => l.value).filter((v): v is string => v !== null && pathLike(v));
      if (named.length === 0) writes.push({ path: null, call: 'code' });
      for (const v of named) writes.push({ path: v, call: 'code' });
    }
  } else {
    const names = assignments(code, masked, literals);
    const each = (rx: RegExp, take: (args: { start: number; end: number }[], name: string, at: number) => void) => {
      rx.lastIndex = 0;
      for (let m = rx.exec(masked); m; m = rx.exec(masked)) {
        const open = m.index + m[0].length - 1;
        take(argsOf(masked, open), (m[1] ?? m[2] ?? m[3] ?? m[0]).replace(/\s*\($/, ''), m.index);
      }
    };
    const add = (path: string | null, call: string) => writes.push({ path, call });
    if (lang === 'python') {
      each(PY_OPEN, (args) => {
        const modeArg = args.slice(1).find((a) => /^\s*mode\s*=/.test(masked.slice(a.start, a.end))) ?? args.find((a, k) => k === 1 && !/^\s*\w+\s*=/.test(masked.slice(a.start, a.end)));
        if (modeArg === undefined) return; // no mode: a read
        const modeText = masked.slice(modeArg.start, modeArg.end).replace(/^\s*mode\s*=\s*/, '');
        const offset = modeArg.start + masked.slice(modeArg.start, modeArg.end).indexOf(modeText);
        const mode = pathValue(code, masked, literals, offset, modeArg.end, new Map());
        if (mode !== null && !/[wax+]/.test(mode)) return;
        add(valueAt(args[0], names), 'open');
      });
      each(PY_WRITE_FIRST, (args, name) => add(valueAt(args[0], names), `os.${name}`));
      each(PY_WRITE_BOTH, (args, name) => {
        add(valueAt(args[0], names), `os.${name}`);
        add(valueAt(args[1], names), `os.${name}`);
      });
      each(PY_WRITE_SECOND, (args, name) => add(valueAt(args[1], names), `os.${name}`));
      each(PY_SHUTIL, (args, name) => {
        if (/^(copy|copy2|copyfile|copytree|copymode|copystat)$/.test(name)) add(valueAt(args[1], names), `shutil.${name}`);
        else if (name === 'move') {
          add(valueAt(args[0], names), 'shutil.move');
          add(valueAt(args[1], names), 'shutil.move');
        } else if (!/^(which|disk_usage|get_terminal_size|get_archive_formats|get_unpack_formats)$/.test(name)) add(valueAt(args[0], names), `shutil.${name}`);
      });
      // A Path's own writes: its receiver names the path.
      PY_PATH_METHOD.lastIndex = 0;
      for (let m = PY_PATH_METHOD.exec(masked); m; m = PY_PATH_METHOD.exec(masked)) {
        const method = m[1] as string;
        const receiver = receiverSpan(masked, m.index);
        // os.mkdir, os.unlink, shutil...: read above, by their own arguments.
        if (receiver !== null && /^\s*(?:os|shutil|os\.path)\s*$/.test(masked.slice(receiver.start, receiver.end))) continue;
        const isPath = receiver !== null && (/^\s*(?:Path|pathlib\.Path|PurePath|PurePosixPath)\s*\(/.test(masked.slice(receiver.start, receiver.end)) || pathish(masked.slice(receiver.start, receiver.end), names, masked));
        const path = receiver === null ? null : pathValue(code, masked, literals, receiver.start, receiver.end, names);
        const args = argsOf(masked, m.index + m[0].length - 1);
        if (method === 'rename' || method === 'replace') {
          if (!isPath) continue; // a string's replace
          add(path, `Path.${method}`);
          add(valueAt(args[0], names), `Path.${method}`);
        } else if (method === 'open') {
          if (!isPath) continue;
          const mode = args[0] === undefined ? null : pathValue(code, masked, literals, args[0].start, args[0].end, new Map());
          if (args[0] === undefined || (mode !== null && !/[wax+]/.test(mode))) continue;
          add(path, 'Path.open');
        } else add(path, `Path.${method}`);
      }
    } else {
      each(JS_FIRST, (args, name) => add(valueAt(args[0], names), name));
      each(JS_SECOND, (args, name) => add(valueAt(args[1], names), name));
      each(JS_BOTH, (args, name) => {
        add(valueAt(args[0], names), name);
        add(valueAt(args[1], names), name);
      });
      each(JS_OPEN, (args) => {
        const flags = args[1] === undefined ? 'r' : pathValue(code, masked, literals, args[1].start, args[1].end, new Map());
        if (flags !== null && !/[wa+]/.test(flags)) return;
        add(valueAt(args[0], names), 'open');
      });
    }
  }
  const spawns = lang === 'python' ? PY_SPAWN.test(masked) : lang === 'js' ? JS_SPAWN.test(masked) : PY_SPAWN.test(code) || JS_SPAWN.test(code);
  const values = literals.map((l) => l.value).filter((v): v is string => v !== null);
  const commands = spawns ? [...values.filter((v) => /\s/.test(v)), values.join(' ')] : [];
  return { writes, commands };
}

/** The receiver expression of a method call whose `.` is at `dot`: back over one balanced call or name chain. */
function receiverSpan(masked: string, dot: number): { start: number; end: number } | null {
  let k = dot - 1;
  while (k >= 0 && masked[k] === ' ') k--;
  const end = k + 1;
  for (;;) {
    if (k < 0) break;
    const ch = masked[k];
    if (ch === ')' || ch === ']') {
      let depth = 0;
      for (; k >= 0; k--) {
        const c = masked[k];
        if (c === ')' || c === ']') depth += 1;
        else if (c === '(' || c === '[') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      k -= 1;
      continue;
    }
    if (/[\w.$]/.test(ch as string) || ch === ' ') {
      if (ch === ' ' && !/[\w)]/.test(masked[k - 1] ?? '') && masked[k - 1] !== '/') break;
      k -= 1;
      continue;
    }
    if (ch === '/' && masked[k - 1] !== '/') {
      k -= 1;
      continue;
    }
    break;
  }
  const start = k + 1;
  return start < end ? { start, end } : null;
}

/** Is a bare name a Path (assigned from Path(...))? */
function pathish(text: string, names: Map<string, string | null>, masked: string): boolean {
  const name = /^\s*([A-Za-z_]\w*)\s*$/.exec(text)?.[1];
  if (name === undefined) return false;
  void names;
  return new RegExp(`(?:^|\\n|;)\\s*${name}\\s*=\\s*(?:pathlib\\.)?(?:Path|PurePath|PurePosixPath)\\s*\\(`).test(masked);
}

export const pathLike = (s: string): boolean => s.length > 0 && s.length < 4096 && !/[\n\0]/.test(s) && !/^[a-z]+:(?!\/)/i.test(s) && (s.includes('/') || /^\.{0,2}[\w@+-][\w.@+-]*\.[A-Za-z0-9]+$/.test(s) || /^[A-Za-z]:[\\/]/.test(s));
