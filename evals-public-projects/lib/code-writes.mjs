/**
 * What code an interpreter runs writes, read from its text — the
 * benchmark's own reading (lib/writes.mjs), independent of Mycelink's
 * (src/security/code-writes.ts) and kept in parity with it
 * (tests/benchmark/shell-writes-parity.test.ts).
 *
 * CSET-203 r4, r5, r6 and r9: a controller generated its graph with a script
 * that read the approved criteria and wrote the graph; reading every
 * path-like literal of code that writes anything as a write target took
 * those reads for writes of the criteria. A write is a call that writes, at
 * the path its arguments name: Python's `open` with a mode that writes, the
 * `os`, `shutil` and `Path` writes; JavaScript's `fs` writes; and code that
 * runs commands is read for the command lines its literals hold. A path
 * argument is a literal, a join of literals (`path.join`, `os.path.join`,
 * `resolve`, `Path(...) / '...'`), or a name assigned once to one; anything
 * else writes to a path the reader cannot tell (`path: null`). Other
 * languages' code is read as before: when it writes at all, every path-like
 * literal it holds.
 */

/** A literal's place in the masked code: not a space, nothing the structure reads. */
const HOLE = '\u0001';

function scan(code, lang) {
  const literals = [];
  const out = code.split('');
  const fill = (a, b, ch) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ch;
  };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if ((lang === 'python' && c === '#') || (lang === 'js' && c === '/' && code[i + 1] === '/')) {
      const end = code.indexOf('\n', i);
      fill(i, end < 0 ? code.length : end, ' ');
      i = end < 0 ? code.length : end;
      continue;
    }
    if (lang === 'js' && c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      fill(i, end < 0 ? code.length : end + 2, ' ');
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || (lang === 'js' && c === '`')) {
      let prefix = '';
      if (lang === 'python') {
        let p = i - 1;
        while (p >= 0 && /[rRbBfFuU]/.test(code[p]) && i - p <= 2) p--;
        if (p < 0 || !/[A-Za-z0-9_]/.test(code[p])) prefix = code.slice(p + 1, i).toLowerCase();
      }
      const triple = lang === 'python' && code.slice(i, i + 3) === c.repeat(3);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      let value = '';
      let interpolated = prefix.includes('f');
      while (j < code.length) {
        if (code.startsWith(quote, j)) break;
        const ch = code[j];
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

function argsOf(masked, open) {
  const spans = [];
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

function matching(masked, open) {
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

function splitTopLevel(text, sep) {
  const out = [];
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

const JOINERS = /^(?:os\.path\.join|path\.join|posix\.join|win32\.join|join|path\.resolve|resolve|Path|pathlib\.Path|PurePath|PurePosixPath)$/;

function pathValue(code, masked, literals, start, end, names, depth = 0) {
  if (depth > 4) return null;
  const text = masked.slice(start, end);
  const trimmedStart = start + (text.length - text.trimStart().length);
  const trimmedEnd = end - (text.length - text.trimEnd().length);
  if (trimmedStart >= trimmedEnd) return null;
  const inner = literals.filter((l) => l.start >= trimmedStart && l.end <= trimmedEnd);
  const skeleton = masked.slice(trimmedStart, trimmedEnd);
  if (inner.length === 1 && inner[0].start === trimmedStart && inner[0].end === trimmedEnd) return inner[0].value;
  const parts = splitTopLevel(skeleton, '/');
  if (parts.length > 1 && /^\s*(?:Path|pathlib\.Path|PurePath|PurePosixPath)\s*\(/.test(skeleton)) {
    const values = [];
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
  if (call && JOINERS.test(call[1])) {
    const open = trimmedStart + skeleton.indexOf('(');
    const close = matching(masked, open);
    if (close !== trimmedEnd - 1) return null;
    const values = [];
    for (const a of argsOf(masked, open)) {
      const v = pathValue(code, masked, literals, a.start, a.end, names, depth + 1);
      if (v === null) return null;
      values.push(v);
    }
    if (values.length === 0) return null;
    let joined = '';
    for (const v of values) joined = v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) ? v : joined === '' ? v : `${joined.replace(/\/+$/, '')}/${v}`;
    return joined;
  }
  const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(skeleton)?.[1];
  if (name !== undefined && names.has(name)) return names.get(name) ?? null;
  return null;
}

function assignments(code, masked, literals) {
  const seen = new Map();
  const rx = /(?:^|[\n;{(]\s*|\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*=(?!=)\s*/g;
  for (let m = rx.exec(masked); m; m = rx.exec(masked)) {
    const name = m[1];
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
    seen.get(name).push({ start, end });
  }
  const names = new Map();
  for (const name of seen.keys()) names.set(name, null);
  for (let pass = 0; pass < 3; pass++) {
    for (const [name, spans] of seen) {
      if (spans.length !== 1) continue;
      names.set(name, pathValue(code, masked, literals, spans[0].start, spans[0].end, names));
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

export const pathLike = (s) => s.length > 0 && s.length < 4096 && !/[\n\0]/.test(s) && !/^[a-z]+:(?!\/)/i.test(s) && (s.includes('/') || /^\.{0,2}[\w@+-][\w.@+-]*\.[A-Za-z0-9]+$/.test(s) || /^[A-Za-z]:[\\/]/.test(s));

/** The writes (`[{ path | null, call }]`) and command lines of `code` run by `language`. */
export function codeWrites(code, language) {
  const lang = /^python/.test(language) ? 'python' : /^(node|nodejs|deno|bun)$/.test(language) ? 'js' : 'other';
  const { literals, masked } = scan(code, lang);
  const writes = [];
  const add = (path, call) => writes.push({ path, call });
  if (lang === 'other') {
    if (OTHER_WRITE.test(masked) || OTHER_WRITE.test(code)) {
      const named = literals.map((l) => l.value).filter((v) => v !== null && pathLike(v));
      if (named.length === 0) add(null, 'code');
      for (const v of named) add(v, 'code');
    }
  } else {
    const names = assignments(code, masked, literals);
    const valueAt = (a) => (a === undefined ? null : pathValue(code, masked, literals, a.start, a.end, names));
    const each = (rx, take) => {
      rx.lastIndex = 0;
      for (let m = rx.exec(masked); m; m = rx.exec(masked)) {
        const open = m.index + m[0].length - 1;
        take(argsOf(masked, open), (m[1] ?? m[2] ?? m[3] ?? m[0]).replace(/\s*\($/, ''), m.index);
      }
    };
    if (lang === 'python') {
      each(PY_OPEN, (args) => {
        const modeArg = args.slice(1).find((a) => /^\s*mode\s*=/.test(masked.slice(a.start, a.end))) ?? args.find((a, k) => k === 1 && !/^\s*\w+\s*=/.test(masked.slice(a.start, a.end)));
        if (modeArg === undefined) return;
        const modeText = masked.slice(modeArg.start, modeArg.end).replace(/^\s*mode\s*=\s*/, '');
        const offset = modeArg.start + masked.slice(modeArg.start, modeArg.end).indexOf(modeText);
        const mode = pathValue(code, masked, literals, offset, modeArg.end, new Map());
        if (mode !== null && !/[wax+]/.test(mode)) return;
        add(valueAt(args[0]), 'open');
      });
      each(PY_WRITE_FIRST, (args, name) => add(valueAt(args[0]), `os.${name}`));
      each(PY_WRITE_BOTH, (args, name) => {
        add(valueAt(args[0]), `os.${name}`);
        add(valueAt(args[1]), `os.${name}`);
      });
      each(PY_WRITE_SECOND, (args, name) => add(valueAt(args[1]), `os.${name}`));
      each(PY_SHUTIL, (args, name) => {
        if (/^(copy|copy2|copyfile|copytree|copymode|copystat)$/.test(name)) add(valueAt(args[1]), `shutil.${name}`);
        else if (name === 'move') {
          add(valueAt(args[0]), 'shutil.move');
          add(valueAt(args[1]), 'shutil.move');
        } else if (!/^(which|disk_usage|get_terminal_size|get_archive_formats|get_unpack_formats)$/.test(name)) add(valueAt(args[0]), `shutil.${name}`);
      });
      PY_PATH_METHOD.lastIndex = 0;
      for (let m = PY_PATH_METHOD.exec(masked); m; m = PY_PATH_METHOD.exec(masked)) {
        const method = m[1];
        const receiver = receiverSpan(masked, m.index);
        if (receiver !== null && /^\s*(?:os|shutil|os\.path)\s*$/.test(masked.slice(receiver.start, receiver.end))) continue;
        const text = receiver === null ? '' : masked.slice(receiver.start, receiver.end);
        const isPath = receiver !== null && (/^\s*(?:Path|pathlib\.Path|PurePath|PurePosixPath)\s*\(/.test(text) || pathish(text, masked));
        const path = receiver === null ? null : pathValue(code, masked, literals, receiver.start, receiver.end, names);
        const args = argsOf(masked, m.index + m[0].length - 1);
        if (method === 'rename' || method === 'replace') {
          if (!isPath) continue;
          add(path, `Path.${method}`);
          add(valueAt(args[0]), `Path.${method}`);
        } else if (method === 'open') {
          if (!isPath) continue;
          const mode = args[0] === undefined ? null : pathValue(code, masked, literals, args[0].start, args[0].end, new Map());
          if (args[0] === undefined || (mode !== null && !/[wax+]/.test(mode))) continue;
          add(path, 'Path.open');
        } else add(path, `Path.${method}`);
      }
    } else {
      each(JS_FIRST, (args, name) => add(valueAt(args[0]), name));
      each(JS_SECOND, (args, name) => add(valueAt(args[1]), name));
      each(JS_BOTH, (args, name) => {
        add(valueAt(args[0]), name);
        add(valueAt(args[1]), name);
      });
      each(JS_OPEN, (args) => {
        const flags = args[1] === undefined ? 'r' : pathValue(code, masked, literals, args[1].start, args[1].end, new Map());
        if (flags !== null && !/[wa+]/.test(flags)) return;
        add(valueAt(args[0]), 'open');
      });
    }
  }
  const spawns = lang === 'python' ? PY_SPAWN.test(masked) : lang === 'js' ? JS_SPAWN.test(masked) : PY_SPAWN.test(code) || JS_SPAWN.test(code);
  const values = literals.map((l) => l.value).filter((v) => v !== null);
  return { writes, commands: spawns ? [...values.filter((v) => /\s/.test(v)), values.join(' ')] : [] };
}

function receiverSpan(masked, dot) {
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
    if (/[\w.$]/.test(ch) || ch === ' ') {
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

function pathish(text, masked) {
  const name = /^\s*([A-Za-z_]\w*)\s*$/.exec(text)?.[1];
  if (name === undefined) return false;
  return new RegExp(`(?:^|\\n|;)\\s*${name}\\s*=\\s*(?:pathlib\\.)?(?:Path|PurePath|PurePosixPath)\\s*\\(`).test(masked);
}
