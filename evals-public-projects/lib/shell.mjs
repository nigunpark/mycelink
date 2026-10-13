/**
 * A reader for the shell commands in agent transcripts — not an interpreter.
 *
 * The transcript scan (lib/transcripts.mjs) needs the words a shell would
 * hand to each command it runs: an argument, a redirection target, an
 * assigned value. It must not mistake what a command only carries — a
 * heredoc it writes to a file, a script it feeds to Python, a comment — for
 * a path, nor miss a path the shell would assemble from pieces. So this
 * reads POSIX shell (and the bash forms agents use) the way the shell does:
 *
 * - quoting: `'...'`, `"..."`, `$'...'` (ANSI-C escapes decoded), `\x`,
 *   line continuations; adjacent pieces form one word;
 * - comments (`#` at the start of a word), operators (`;` `&` `&&` `||`
 *   `|` `|&` `(` `)` newline) and redirections (`[n]<`, `>`, `>>`, `>|`,
 *   `<>`, `&>`, `&>>`, `<&`, `>&`, `<<<`);
 * - heredocs (`<<`, `<<-`, quoted or not): a body is data, but one fed to
 *   a shell (`bash <<EOF`) is read as commands, and an unquoted body's
 *   command substitutions run;
 * - expansions: `~`, `$HOME`, `$PWD`, `$TMPDIR` and variables the script
 *   assigned (`D=/x`, `export D=/x`) are resolved; command substitutions
 *   (`$(...)`, backticks, `<(...)`, `>(...)`) are read as commands and
 *   stand for an unknown value; any other expansion is unknown;
 * - nested shells: the script of `bash -c '...'`, `sh -c`, `eval`;
 * - `cd` and `pushd` move the directory relative words resolve against.
 *
 * `readShell(source)` returns the simple commands in order (nested ones
 * included), each `{ words, assigns, redirects, heredocs, strings, after }`
 * with unevaluated words (`after`: the control operator before it, null at
 * the start); `evaluate(word, scope)` turns a word into `{ literal,
 * pattern, glob }` under a scope of variables, HOME and cwd, and
 * `directoryAfter` follows `cd`.
 */
import { posix } from 'node:path';

/** Commands that read their stdin (or `-c` argument) as a shell script. */
export const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'busybox']);
const RESERVED_PREFIX = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'exec', 'command', 'builtin', 'nohup']);
const RESERVED_ONLY = new Set(['}', 'fi', 'done', 'esac', 'then', 'do', 'else']);
const MAX_DEPTH = 8;

const META = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The decoded text of an ANSI-C quoted string body (`$'...'` without the quotes). */
function ansiC(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    if (n in simple) out += simple[n];
    else if (n === 'x') {
      const m = /^[0-9A-Fa-f]{1,2}/.exec(body.slice(i + 1));
      if (m) {
        out += String.fromCharCode(parseInt(m[0], 16));
        i += m[0].length;
      } else out += '\\x';
    } else if (n === 'u' || n === 'U') {
      const m = new RegExp(`^[0-9A-Fa-f]{1,${n === 'u' ? 4 : 8}}`).exec(body.slice(i + 1));
      if (m) {
        out += String.fromCodePoint(parseInt(m[0], 16));
        i += m[0].length;
      } else out += `\\${n}`;
    } else if (/[0-7]/.test(n ?? '')) {
      const m = /^[0-7]{1,3}/.exec(body.slice(i));
      out += String.fromCharCode(parseInt(m[0], 8));
      i += m[0].length - 1;
    } else if (n === 'c') {
      i += 1; // a control character: nothing a path is made of
    } else out += `\\${n ?? ''}`;
  }
  return out;
}

/** End of a `$(...)` / `<(...)` body starting at `i` (just after the opening parenthesis): the index of its `)`. */
function closeParen(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1) + 1;
    else if (c === '"') i = closeDouble(src, i + 1) + 1;
    else if (c === '`') i = closeBacktick(src, i + 1) + 1;
    else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      if (--depth === 0) return i;
      i++;
    } else i++;
  }
  return src.length;
}

/** The index of the `"` closing a double-quoted string whose body starts at `i`. */
function closeDouble(src, i) {
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i;
    else if (c === '`') i = closeBacktick(src, i + 1) + 1;
    else if (c === '$' && src[i + 1] === '(') i = closeParen(src, i + 2) + 1;
    else i++;
  }
  return src.length;
}

/** The index of the backtick closing a command substitution whose body starts at `i`. */
function closeBacktick(src, i) {
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === '`') return i;
    else i++;
  }
  return src.length;
}

/** The index of the `}` closing a `${...}` whose body starts at `i`. */
function closeBrace(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1) + 1;
    else if (c === '"') i = closeDouble(src, i + 1) + 1;
    else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      if (--depth === 0) return i;
      i++;
    } else i++;
  }
  return src.length;
}

/**
 * A `$` expansion at `src[i] === '$'`: `{ seg, next, sub? }` where `seg`
 * is a variable reference or an unknown value, and `sub` the source of a
 * command substitution to read as commands.
 */
function dollar(src, i, quoted) {
  const n = src[i + 1];
  if (n === '(' && src[i + 2] === '(') {
    // Arithmetic $((...)): a number, nothing a path is made of.
    const end = closeParen(src, i + 3);
    return { seg: { unknown: true, quoted }, next: Math.min(src.length, end + 2) };
  }
  if (n === '(') {
    const end = closeParen(src, i + 2);
    return { seg: { unknown: true, quoted }, next: end + 1, sub: src.slice(i + 2, end) };
  }
  if (n === '{') {
    const end = closeBrace(src, i + 2);
    const body = src.slice(i + 2, end);
    return { seg: NAME.test(body) ? { variable: body, quoted } : { unknown: true, quoted }, next: end + 1 };
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
  if (m) return { seg: { variable: m[0], quoted }, next: i + 1 + m[0].length };
  if (n !== undefined && /[0-9@*#?$!-]/.test(n)) return { seg: { unknown: true, quoted }, next: i + 2 };
  return { seg: { text: '$', quoted }, next: i + 1 };
}

/**
 * One word starting at `i`: `{ word, next }`, the word a list of segments
 * `{ text, quoted }`, `{ variable, quoted }`, `{ tilde: true }` or
 * `{ unknown: true }`. Command substitutions met on the way go to `subs`.
 */
function readWord(src, i, subs) {
  const segs = [];
  const text = (t, quoted) => {
    const last = segs.at(-1);
    if (last && 'text' in last && last.quoted === quoted) last.text += t;
    else segs.push({ text: t, quoted });
  };
  if (src[i] === '~' && (i + 1 >= src.length || src[i + 1] === '/' || META.has(src[i + 1]))) {
    segs.push({ tilde: true });
    i++;
  }
  while (i < src.length && !META.has(src[i])) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') i += 2;
      else {
        if (i + 1 < src.length) text(src[i + 1], true);
        i += 2;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      text(src.slice(i + 1, stop), true);
      i = stop + 1;
    } else if (c === '$' && src[i + 1] === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      text(ansiC(src.slice(i + 2, j)), true);
      i = j + 1;
    } else if (c === '"' || (c === '$' && src[i + 1] === '"')) {
      const start = c === '"' ? i + 1 : i + 2;
      const end = closeDouble(src, start);
      let j = start;
      while (j < end) {
        const d = src[j];
        if (d === '\\' && /[$`"\\\n]/.test(src[j + 1] ?? '')) {
          if (src[j + 1] !== '\n') text(src[j + 1], true);
          j += 2;
        } else if (d === '$') {
          const x = dollar(src, j, true);
          if (x.sub !== undefined) subs.push(x.sub);
          if ('text' in x.seg) text(x.seg.text, true);
          else segs.push(x.seg);
          j = Math.min(x.next, end);
        } else if (d === '`') {
          const close = closeBacktick(src, j + 1);
          subs.push(src.slice(j + 1, close).replace(/\\([`$\\])/g, '$1'));
          segs.push({ unknown: true, quoted: true });
          j = close + 1;
        } else {
          text(d, true);
          j++;
        }
      }
      i = end + 1;
    } else if (c === '$') {
      const x = dollar(src, i, false);
      if (x.sub !== undefined) subs.push(x.sub);
      if ('text' in x.seg) text(x.seg.text, false);
      else segs.push(x.seg);
      i = x.next;
    } else if (c === '`') {
      const close = closeBacktick(src, i + 1);
      subs.push(src.slice(i + 1, close).replace(/\\([`$\\])/g, '$1'));
      segs.push({ unknown: true, quoted: false });
      i = close + 1;
    } else {
      text(c, false);
      i++;
    }
  }
  return { word: segs, next: i };
}

/** The literal text of a word whose every segment is text (a heredoc delimiter, an operator's operand). */
const plain = (word) => word.map((s) => s.text ?? '').join('');
const isQuoted = (word) => word.some((s) => s.quoted);

const REDIRECT = /^(?:&>>|&>|<<<|<<-|<<|>>|>\||<>|<&|>&|<|>)/;

/** Read a heredoc body from `i` (the start of the line after its command): `{ body, next }`. */
function heredocBody(src, i, { delimiter, strip }) {
  let body = '';
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const line = src.slice(i, nl < 0 ? src.length : nl);
    i = nl < 0 ? src.length : nl + 1;
    if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) return { body, next: i };
    body += `${strip ? line.replace(/^\t+/, '') : line}\n`;
  }
  return { body, next: i };
}

/**
 * The simple commands of `source`, in order, nested ones (command
 * substitutions, `bash -c`, `eval`, scripts fed to a shell) included.
 * Each is `{ words, assigns: [{ name, value }], redirects: [{ op, target }],
 * heredocs: [{ body, expands, data }] }`; `data` heredocs (and here-strings)
 * are what the command only reads.
 */
export function readShell(source, depth = 0) {
  const src = String(source).replace(/\r\n/g, '\n');
  const commands = [];
  if (depth > MAX_DEPTH) return commands;
  let current = null;
  const pending = [];
  const nested = [];
  // The control operator before the next command (`&&`, `||`, `|`, `&`, `;`, `(`, `)`; null at the start).
  let operator = null;
  const fresh = () => {
    const cmd = { words: [], assigns: [], redirects: [], heredocs: [], strings: [], subs: [], after: operator };
    operator = null;
    return cmd;
  };
  const finish = () => {
    if (!current) return;
    const cmd = current;
    current = null;
    // Reserved words that only introduce the command that follows them.
    while (cmd.words.length && cmd.words[0].length && !isQuoted(cmd.words[0]) && RESERVED_PREFIX.has(plain(cmd.words[0]))) cmd.words.shift();
    if (cmd.words.length === 1 && !isQuoted(cmd.words[0]) && RESERVED_ONLY.has(plain(cmd.words[0]))) cmd.words.shift();
    commands.push(cmd);
    for (const s of cmd.subs) nested.push({ at: commands.length - 1, source: s });
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      finish();
      operator = ';';
      i++;
      for (const h of pending.splice(0)) {
        const { body, next } = heredocBody(src, i, h);
        h.target.body = body;
        i = next;
      }
      continue;
    }
    // A comment: '#' where a word would start (inside a word it is an ordinary character).
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // Process substitution: a command list that stands for a path.
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const end = closeParen(src, i + 2);
      current ??= fresh();
      current.subs.push(src.slice(i + 2, end));
      current.words.push([{ unknown: true }]);
      i = end + 1;
      continue;
    }
    // An IO number directly before a redirection belongs to it.
    const io = /^[0-9]+(?=[<>])/.exec(src.slice(i, i + 12));
    const at = io ? i + io[0].length : i;
    const redirect = REDIRECT.exec(src.slice(at, at + 3));
    if (redirect) {
      current ??= fresh();
      const op = redirect[0];
      let j = at + op.length;
      while (src[j] === ' ' || src[j] === '\t') j++;
      if ((op === '>&' || op === '<&') && /^(?:[0-9]+-?|-)(?=$|[\s;&|()<>])/.test(src.slice(j))) {
        i = j + /^(?:[0-9]+-?|-)/.exec(src.slice(j))[0].length;
        continue;
      }
      const { word, next } = readWord(src, j, current.subs);
      i = next;
      if (op === '<<' || op === '<<-') {
        const doc = { delimiter: plain(word), expands: !isQuoted(word), body: '' };
        current.heredocs.push(doc);
        pending.push({ delimiter: doc.delimiter, strip: op === '<<-', target: doc });
      } else if (op === '<<<') {
        current.strings.push(word);
      } else {
        current.redirects.push({ op, target: word });
      }
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      // A command whose output a pipe carries into the next one.
      if (c === '|' && src[i + 1] !== '|' && current) current.pipe = true;
      finish();
      const two = src.startsWith(';;', i) || src.startsWith('&&', i) || src.startsWith('||', i) || src.startsWith('|&', i);
      operator = two ? { ';;': ';', '|&': '|' }[src.slice(i, i + 2)] ?? src.slice(i, i + 2) : c;
      i += two ? 2 : 1;
      continue;
    }
    current ??= fresh();
    const { word, next } = readWord(src, i, current.subs);
    i = next;
    const name = word.length && 'text' in word[0] && !word[0].quoted ? /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(word[0].text) : null;
    if (name && current.words.length === 0) {
      // NAME=value before the command: the value is a word of its own (a leading `~` is expanded there too).
      const head = word[0].text.slice(name[0].length);
      const lead = head === '~' || head.startsWith('~/') ? [{ tilde: true }, { text: head.slice(1), quoted: false }] : [{ text: head, quoted: false }];
      const rest = [...lead, ...word.slice(1)].filter((s) => !('text' in s) || s.text !== '' || s.quoted);
      current.assigns.push({ name: name[1], value: rest });
    } else current.words.push(word);
  }
  finish();
  for (const h of pending) h.target.body = '';
  // Nested scripts: substitutions, `sh -c`, `eval`, and heredocs, here-strings or a pipe feeding a shell.
  const out = [];
  let feed = [];
  for (const [index, cmd] of commands.entries()) {
    for (const n of nested.filter((x) => x.at === index)) out.push(...readShell(n.source, depth + 1).map((x) => ({ ...x, nested: true })));
    const k = commandIndex(cmd.words);
    const argv0 = cmd.words[k] ? posix.basename(plain(cmd.words[k])) : null;
    const shell = argv0 !== null && SHELLS.has(argv0);
    const scripts = [];
    if (shell) {
      const c = cmd.words.findIndex((w, j) => j > k && /^-[A-Za-z]*c[A-Za-z]*$/.test(plain(w)) && !isQuoted(w));
      if (c > 0 && cmd.words[c + 1]) scripts.push(plain(cmd.words[c + 1]));
      else scripts.push(...feed);
      for (const s of cmd.strings) scripts.push(plain(s));
    }
    if (argv0 === 'eval') scripts.push(cmd.words.slice(k + 1).map(plain).join(' '));
    // What this command writes into a pipe: its heredocs and here-strings, what echo or printf prints.
    feed = cmd.pipe ? [...cmd.heredocs.map((d) => d.body), ...cmd.strings.map(plain), ...(argv0 === 'echo' || argv0 === 'printf' ? [cmd.words.slice(k + 1).map(plain).join(' ')] : [])] : [];
    for (const doc of cmd.heredocs) {
      doc.data = !shell;
      if (shell) scripts.push(doc.body);
      else if (doc.expands) {
        // An unquoted body's command substitutions run when the heredoc is read.
        const subs = [];
        for (let k = 0; k < doc.body.length; k++) {
          if (doc.body[k] === '\\') k++;
          else if (doc.body[k] === '$' && doc.body[k + 1] === '(' && doc.body[k + 2] !== '(') {
            const end = closeParen(doc.body, k + 2);
            subs.push(doc.body.slice(k + 2, end));
            k = end;
          } else if (doc.body[k] === '`') {
            const end = closeBacktick(doc.body, k + 1);
            subs.push(doc.body.slice(k + 1, end));
            k = end;
          }
        }
        for (const s of subs) out.push(...readShell(s, depth + 1).map((x) => ({ ...x, nested: true })));
      }
    }
    const { subs, pipe, ...rest } = cmd;
    out.push(rest);
    for (const s of scripts) out.push(...readShell(s, depth + 1).map((x) => ({ ...x, nested: true })));
  }
  return out;
}

/** Commands that run another (`env X=1 cmd`, `timeout 5 cmd`, `sudo cmd`): the index of the command they run. */
export function commandIndex(words) {
  let i = 0;
  const text = (k) => (words[k] ? plain(words[k]) : '');
  for (let guard = 0; guard < 8 && i < words.length; guard++) {
    const name = posix.basename(text(i));
    if (name === 'env') {
      i++;
      while (i < words.length && (/^-/.test(text(i)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(text(i)))) i += /^-(u|C|S)$/.test(text(i)) ? 2 : 1;
    } else if (['timeout', 'nice', 'stdbuf', 'sudo', 'xargs', 'setsid', 'unbuffer', 'nohup', 'command', 'exec', 'time', 'builtin'].includes(name)) {
      i++;
      while (i < words.length && /^-/.test(text(i))) i += /^-(n|s|k|u|g|I|L|P|d|E)$/.test(text(i)) ? 2 : 1;
      if (name === 'timeout' && /^[0-9.]+[smhd]?$/.test(text(i))) i++;
    } else return i;
  }
  return i;
}

const GLOB_CHARS = /[*?[]/;
const escapeGlob = (s) => s.replace(/[\\*?[\]{}]/g, '\\$&');

/**
 * A word's value under `scope` (`{ vars, home, cwd }`): `{ literal,
 * pattern, glob }`. `literal` is null when part of it is unknown;
 * `pattern` is a glob in which quoted characters are escaped and every
 * unknown part is `*`; `glob` says whether the shell would expand it.
 */
export function evaluate(word, scope) {
  let literal = '';
  let pattern = '';
  let glob = false;
  for (const s of word) {
    let value = null;
    let quoted = true;
    if ('text' in s) {
      value = s.text;
      quoted = s.quoted;
    } else if (s.tilde) value = scope.home ?? null;
    else if (s.variable) value = lookup(s.variable, scope);
    if (value === null) {
      literal = null;
      pattern += '*';
      glob = true;
      continue;
    }
    if (literal !== null) literal += value;
    if (quoted) pattern += escapeGlob(value);
    else {
      pattern += value.replace(/\\/g, '\\\\');
      if (GLOB_CHARS.test(value) || /\{[^}]*,[^}]*\}/.test(value)) glob = true;
    }
  }
  return { literal, pattern, glob };
}

function lookup(name, scope) {
  if (Object.hasOwn(scope.vars ?? {}, name)) return scope.vars[name];
  if (name === 'HOME') return scope.home ?? null;
  if (name === 'PWD') return scope.cwd ?? null;
  if (name === 'TMPDIR' && scope.home) return posix.join(scope.home.replace(/\\/g, '/'), '.tmp');
  return null;
}

/** Expand unescaped `{a,b}` alternatives of a glob pattern (bash brace expansion), at most `limit` results. */
export function expandBraces(pattern, limit = 64) {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++;
      continue;
    }
    if (pattern[i] !== '{') continue;
    let depth = 0;
    const commas = [];
    let end = -1;
    for (let j = i; j < pattern.length; j++) {
      if (pattern[j] === '\\') {
        j++;
        continue;
      }
      if (pattern[j] === '{') depth++;
      else if (pattern[j] === '}' && --depth === 0) {
        end = j;
        break;
      } else if (pattern[j] === ',' && depth === 1) commas.push(j);
    }
    if (end < 0 || commas.length === 0) continue;
    const parts = [];
    let from = i + 1;
    for (const k of [...commas, end]) {
      parts.push(pattern.slice(from, k));
      from = k + 1;
    }
    const out = [];
    for (const p of parts) {
      for (const x of expandBraces(pattern.slice(0, i) + p + pattern.slice(end + 1), limit)) {
        if (out.length >= limit) return out;
        out.push(x);
      }
    }
    return out;
  }
  return [pattern];
}

/** The literal text of a pattern without glob characters (its escapes removed), or null when it has some. */
export function patternLiteral(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') out += pattern[++i] ?? '';
    else if ('*?['.includes(pattern[i])) return null;
    else out += pattern[i];
  }
  return out;
}

/** Track `cd`/`pushd` through a command: the directory after it, or null when it does not change it. */
export function directoryAfter(command, scope) {
  const name = command.words[0] ? plain(command.words[0]) : null;
  if (name !== 'cd' && name !== 'pushd') return null;
  const args = command.words.slice(1).filter((w) => !/^-[LPe@]$/.test(plain(w)));
  if (args.length === 0) return scope.home ?? null;
  const v = evaluate(args[0], scope);
  if (v.literal === null || v.literal === '-') return null;
  const target = v.literal.replace(/\\/g, '/');
  return target.startsWith('/') ? posix.normalize(target) : scope.cwd ? posix.normalize(posix.join(scope.cwd.replace(/\\/g, '/'), target)) : null;
}

export { plain as wordText };
