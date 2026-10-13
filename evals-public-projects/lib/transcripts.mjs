/**
 * Evaluator access in agent transcripts — defense in depth only.
 *
 * What keeps an agent away from the evaluator store, the suite, the cache
 * and the authoring clones is the isolation boundary its sessions run in
 * (lib/sandbox.mjs): those paths do not exist there. This scan reads every
 * transcript a run left — the session's stream-json output and every
 * transcript under its Claude config (`projects/**.jsonl`, the workers'
 * `subagents/` included) — and reports each tool call that reaches a path
 * at or inside a forbidden root.
 *
 * It reads what a tool was asked to touch, not everything it carried:
 *
 * - Bash commands are read as a shell reads them (lib/shell.mjs): every
 *   word a command receives, every redirection target and every assigned
 *   value, with quotes removed, pieces joined, escapes and ANSI-C quoting
 *   decoded, `~`, `$HOME` and the script's own variables expanded, `cd`
 *   followed, nested shells (`bash -c`, `eval`, a script fed to a shell)
 *   and command substitutions read too. A heredoc a command writes or feeds
 *   to an interpreter, a comment, a quoted pattern are not paths: the
 *   `/**` that opens a Javadoc comment in a Java file written through a
 *   heredoc is data, while an unquoted `/**` the shell would expand is a
 *   glob from the root.
 * - The file tools: their path fields (Read/Write/Edit `file_path`, Glob
 *   `pattern` and `path`, Grep `path`, ...), never their payloads (Write
 *   `content`, Edit strings, a Grep regex).
 * - A forbidden root named literally anywhere in a tool call — a payload,
 *   a script, a prompt — in any spelling it takes on this host, is a hit:
 *   no honest session knows those paths.
 *
 * Paths are compared in every spelling a root can take: relative to the
 * directory the call ran in (and to where its own `cd`s led), `~`,
 * `file://`, Windows and WSL forms of the same path, symlinked or
 * case-variant roots, and globs that can match into a root. Recursive tools
 * pointed at an ancestor of a root (`find /`, `grep -r`, a Grep or `**`
 * Glob over a parent) are reported as probes. A flag's slash-free glob
 * value (`grep --include=*`) is a name pattern, not a path.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { commandIndex, directoryAfter, evaluate, expandBraces, patternLiteral, readShell, wordText } from './shell.mjs';
import { lineWrites } from './writes.mjs';

/** Every transcript file of a run: the given stream files, and `*.jsonl` anywhere under the given directories. */
export function transcriptFiles({ streams = [], dirs = [] }) {
  const files = streams.filter((f) => existsSync(f));
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = posix.join(dir.replace(/\\/g, '/'), e.name);
      if (e.isDirectory() && depth < 8) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d, 0);
  return [...new Set(files)];
}

const driveForm = /^([A-Za-z]):[\\/]/;
const wslForm = /^\/mnt\/([a-z])(\/|$)/;

/** One path in '/' form, `..` resolved, no trailing slash; Windows drive paths as `c:/...`. */
function normalize(p) {
  let s = p.replace(/\\/g, '/');
  const drive = driveForm.exec(p);
  if (drive) s = `${drive[1].toLowerCase()}:${posix.normalize(`/${s.slice(2)}`)}`;
  else s = posix.normalize(s);
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/** The spellings one root can take: as given, resolved through symlinks, and its Windows/WSL twins. */
export function rootForms(root) {
  const forms = new Set([normalize(root)]);
  try {
    forms.add(normalize(realpathSync.native(root)));
  } catch {
    // not on this host
  }
  for (const f of [...forms]) {
    const drive = /^([a-z]):(\/.*)?$/.exec(f);
    if (drive) forms.add(`/mnt/${drive[1]}${drive[2] ?? ''}`);
    const wsl = wslForm.exec(f);
    if (wsl) forms.add(`${wsl[1]}:${f.slice(6) || '/'}`);
  }
  return [...forms];
}

/** Case-insensitive comparison for paths on Windows drives (and their WSL mounts). */
const caseless = (p) => /^[a-z]:\//i.test(p) || wslForm.test(p);
const same = (a, b) => (caseless(a) || caseless(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (path, root) => same(path, root) || (path.length > root.length && same(path.slice(0, root.length), root) && path[root.length] === '/') || root === '/';

/** Does a glob segment match a path segment? (`*`, `?`, `[...]`, `{a,b}`, `\x` literal; case per `caseInsensitive`) */
function segmentMatches(glob, name, caseInsensitive) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\') re += (glob[++i] ?? '\\').replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
    else if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')).join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '').test(name);
  } catch {
    return true; // a pattern we cannot read could match anything
  }
}

/** Can a glob path (absolute, '/'-separated, escapes kept) match the root itself or anything inside it? */
function globReaches(glob, root) {
  const g = glob.split('/');
  const r = root.split('/');
  const ci = caseless(root);
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '**') return true;
    if (i >= r.length) return true; // the glob continues inside the root
    if (!segmentMatches(g[i], r[i], ci)) return false;
  }
  return g.length >= r.length;
}

/** `.` and `..` segments of a glob pattern resolved textually (escapes kept; only '/' separates). */
function normalizePattern(p) {
  const absolute = p.startsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `${absolute ? '/' : ''}${out.join('/')}`;
}

/** A path made absolute: `~` against `home`, relative against `cwd`; null when there is no cwd. */
function absolute(path, { cwd, home }) {
  let t = path;
  if (home && (t === '~' || t.startsWith('~/'))) t = home + t.slice(1);
  if (driveForm.test(t) || t.startsWith('/') || t.startsWith('\\')) return normalize(t);
  if (!cwd) return null;
  return normalize(driveForm.test(cwd) ? win32.join(cwd, t) : posix.join(cwd.replace(/\\/g, '/'), t));
}

const NAME_CHAR = /[A-Za-z0-9_.-]/;

/** The roots `text` names literally, in any of their spellings: `[{ root, form }]`. */
function mentions(text, forms) {
  const found = [];
  const slashed = text.includes('\\') ? text.replace(/\\\\?/g, '/') : null;
  for (const { root, form } of forms) {
    for (const hay of slashed ? [text, slashed] : [text]) {
      const h = caseless(form) ? hay.toLowerCase() : hay;
      const needle = caseless(form) ? form.toLowerCase() : form;
      let hit = false;
      for (let i = h.indexOf(needle); i >= 0 && !hit; i = h.indexOf(needle, i + 1)) {
        hit = !NAME_CHAR.test(h[i - 1] ?? '') && !NAME_CHAR.test(h[i + needle.length] ?? '');
      }
      if (hit) {
        found.push({ root, form });
        break;
      }
    }
  }
  return found;
}

function* toolUses(event) {
  for (const message of [event?.message, event?.data?.message]) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) if (part?.type === 'tool_use') yield { id: typeof part.id === 'string' ? part.id : null, name: String(part.name ?? ''), input: part.input ?? {} };
  }
}

function stringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

const RECURSIVE = new Set(['find', 'tree', 'du', 'rg', 'fd', 'fdfind', 'ag', 'ack', 'rsync', 'tar', 'zip', 'locate']);
const RECURSIVE_WITH_FLAG = new Set(['grep', 'egrep', 'fgrep', 'cp', 'ls', 'chmod', 'chown', 'chgrp', 'rm', 'scp', 'diff']);

/** Does this command read directories recursively? */
function recursiveCommand(words) {
  const k = commandIndex(words);
  const name = words[k] ? posix.basename(wordText(words[k])) : '';
  if (RECURSIVE.has(name)) return true;
  if (!RECURSIVE_WITH_FLAG.has(name)) return false;
  return words.slice(k + 1).some((w) => {
    const t = wordText(w);
    return t === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(t) || ((name === 'cp' || name === 'scp') && /^-[A-Za-z]*a[A-Za-z]*$/.test(t));
  });
}

const URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * The path a word's value carries, as a glob pattern (escapes kept), or
 * null when it carries none: the word itself (a bare name too: after a
 * `cd` it names what is there), the value of `--flag=value` or `-Ivalue`
 * style flags, the path of a `file://` URL; never another URL. A flag's
 * value that is a glob without a slash (`--include=*`, `--exclude=*.class`)
 * is a name pattern the program matches names against, not a path: the
 * shell expands it only as the whole word (`--include=...` names nothing).
 */
function carriedPath(pattern) {
  let p = pattern;
  if (p.startsWith('-')) {
    const eq = p.indexOf('=');
    if (eq > 0) p = p.slice(eq + 1);
    else if (/^-[A-Za-z](?:[/~]|\.\.?(?:\/|$))/.test(p)) p = p.slice(2);
    else return null;
    if (!p.includes('/') && patternLiteral(p) === null) return null;
  }
  if (URL.test(p)) {
    if (!/^file:\/\//i.test(p)) return null;
    p = p.replace(/^file:\/\/(localhost)?/i, '');
  }
  return p === '' ? null : p;
}

/**
 * What one tool call reached, per root (the first path that reached it),
 * without the roots that hold another root it reached: a call that reads
 * the evaluator store is reported once, as the store, not again as the
 * cache around it.
 */
function mostSpecific(reached) {
  const roots = [...reached.keys()];
  return [...reached.entries()].filter(([root]) => !roots.some((other) => other !== root && inside(normalize(other), normalize(root)))).map(([, where]) => where);
}

/** The plugin's acceptance reviewer, as Claude Code names its type (meta, attribution, the Agent call). */
export const REVIEWER_TYPES = new Set(['mycelink:acceptance-reviewer', 'acceptance-reviewer']);

/** A subagent transcript's meta beside it (`agent-<id>.meta.json`, Claude Code 2.1.290), or null. */
export function subagentMeta(file) {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * An agent's final answer from its messages: the text of its last message
 * (the entries of one message id, as Claude Code splits them) when that
 * message calls no tool, else null.
 */
export function finalAnswer(entries) {
  const messages = entries.filter((e) => e?.type === 'assistant' || e?.type === 'user');
  const last = messages[messages.length - 1];
  if (last?.type !== 'assistant') return null;
  const id = last.message?.id;
  const final = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const e = messages[i];
    if (e.type !== 'assistant' || (id !== undefined && e.message?.id !== id)) break;
    final.unshift(e);
    if (id === undefined) break;
  }
  const blocks = final.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
  if (blocks.some((b) => b?.type === 'tool_use')) return null;
  const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

/** What a final answer is as a verdict: one JSON object (`json`), one ```json fence holding only one (`fenced-json`), else `prose`; null for none. */
export function answerForm(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const object = (s) => {
    try {
      const v = JSON.parse(s);
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    } catch {
      return false;
    }
  };
  if (t.startsWith('{')) return object(t) ? 'json' : 'prose';
  const fence = /^```json[ \t]*\r?\n([\s\S]*)\r?\n[ \t]*```$/i.exec(t);
  if (fence && !fence[1].includes('```') && fence[1].trim().startsWith('{') && object(fence[1].trim())) return 'fenced-json';
  return 'prose';
}


/**
 * Tool calls in `files` that reach a path at or inside one of `roots`.
 * Relative paths start where the call ran, as its transcript records it:
 * the event's own `cwd` (Claude Code's transcripts under
 * `~/.claude/projects` record one per event), else, in a session's
 * stream-json, where the session's shell was — its latest init cwd, moved
 * by its own earlier `cd` only while that stayed inside the directory the
 * session started in (Claude Code resets a shell that leaves it); a
 * subagent's call (`parent_tool_use_id`) starts there too, whatever its own
 * earlier calls did (Claude Code resets an agent thread's cwd between
 * calls). Within one Bash call, a `cd` moves the words after it, and the
 * directory the call started in stays a base too (the `cd` may fail).
 * `cwd` resolves what nothing records; `home` resolves `~` and `$HOME`.
 * Returns `{ hits, probes }`, each `[{ file, line, tool, root, path }]`:
 * per tool call, one entry for each of the most specific roots it reached.
 */
/**
 * The final answers of acceptance reviewers in one transcript, each with the
 * line of its last message: a reviewer subagent's own transcript (its brief,
 * its meta's agent type, or its messages' attribution say so), or, in the
 * host stream, the messages carrying the id of an Agent call for the reviewer.
 */
function reviewerAnswers(file, entries) {
  const events = entries.map((e) => e.event);
  const lineOf = (event) => entries.find((e) => e.event === event)?.line ?? 0;
  const lastAssistant = (list) => [...list].reverse().find((e) => e?.type === 'assistant');
  if (/[\\/]subagents[\\/]/.test(file)) {
    const first = events.find((e) => e?.type === 'user');
    const brief = /^Acceptance review: \S+$/m.test(typeof first?.message?.content === 'string' ? first.message.content : '');
    const reviewer = brief || REVIEWER_TYPES.has(subagentMeta(file)?.agentType) || events.some((e) => e?.type === 'assistant' && REVIEWER_TYPES.has(e.attributionAgent));
    const text = reviewer ? finalAnswer(events) : null;
    return text === null ? [] : [{ line: lineOf(lastAssistant(events)), text }];
  }
  const calls = new Set();
  for (const e of events) for (const part of Array.isArray(e?.message?.content) ? e.message.content : []) if (part?.type === 'tool_use' && (part.name === 'Agent' || part.name === 'Task') && REVIEWER_TYPES.has(String(part.input?.subagent_type ?? ''))) calls.add(part.id);
  const out = [];
  for (const id of calls) {
    const mine = events.filter((e) => e?.parent_tool_use_id === id);
    const text = finalAnswer(mine);
    if (text !== null) out.push({ line: lineOf(lastAssistant(mine)), text });
  }
  return out;
}

export function forbiddenAccess({ files, roots, cwd = null, home = null }) {
  const forms = roots.filter(Boolean).flatMap((root) => rootForms(root).map((form) => ({ root, form })));
  const hits = [];
  const probes = [];
  for (const file of files) {
    let text;
    try {
      if (!statSync(file).isFile()) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // The session's stream: where it started, and where its own shell is now.
    const entries = [];
    let project = null;
    let shell = null;
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      entries.push({ line: i + 1, event });
      if (event?.type === 'system' && event.subtype === 'init' && typeof event.cwd === 'string') {
        project ??= event.cwd;
        shell = event.cwd;
      }
      const recorded = typeof event?.cwd === 'string' ? event.cwd : null;
      const subagent = typeof event?.parent_tool_use_id === 'string' || event?.isSidechain === true;
      const start = recorded ?? shell ?? cwd;
      for (const use of toolUses(event)) {
        const at = (root, path) => ({ file, line: i + 1, tool: use.name, root, path });
        const reached = { hits: new Map(), probes: new Map() };
        const record = (kind, where) => {
          if (!reached[kind].has(where.root)) reached[kind].set(where.root, where);
        };
        // A path reached from `bases`: a tool's literal path field, or a pattern (a shell word with its quoted
        // characters escaped, a Glob pattern) that is a glob when `glob`; `recursive` tools probe ancestors.
        const reach = (target, { pattern = false, glob = false, bases, recursive = false }) => {
          for (const alternative of glob ? expandBraces(target) : [target]) {
            const literal = pattern ? patternLiteral(alternative) : alternative;
            for (const base of bases.length ? bases : [null]) {
              if (literal !== null) {
                const path = absolute(literal, { cwd: base, home });
                if (path === null) continue;
                for (const { root, form } of forms) {
                  if (inside(path, form)) record('hits', at(root, literal));
                  else if (recursive && inside(form, path)) record('probes', at(root, literal));
                }
                continue;
              }
              // A directory to anchor a glob at: '/'-separated, a drive lower-cased, its own glob characters escaped.
              const anchor = (d) => d.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (x, c) => `${c.toLowerCase()}:`).replace(/[*?[\]{}]/g, '\\$&');
              let p = alternative;
              if (home && (p === '~' || p.startsWith('~/'))) p = anchor(home) + p.slice(1);
              if (!p.startsWith('/') && !driveForm.test(p)) {
                if (!base) continue;
                p = `${anchor(base)}/${p}`;
              }
              const g = normalizePattern(p.replace(/^([A-Za-z]):/, (x, c) => `${c.toLowerCase()}:`));
              for (const { root, form } of forms) if (globReaches(g, form)) record('hits', at(root, alternative));
            }
          }
        };
        if (use.name === 'Bash' && typeof use.input.command === 'string') {
          const vars = {};
          let dir = start;
          for (const cmd of readShell(use.input.command)) {
            const bases = [...new Set([start, dir].filter(Boolean))];
            const scope = { vars, home, cwd: dir };
            const recursive = recursiveCommand(cmd.words);
            const words = [...cmd.words, ...cmd.redirects.map((r) => r.target)];
            for (const a of cmd.assigns) {
              const v = evaluate(a.value, scope);
              const carried = carriedPath(v.pattern);
              if (carried !== null) reach(carried, { pattern: true, glob: v.glob, bases });
              if (v.literal !== null) vars[a.name] = v.literal;
              else delete vars[a.name];
            }
            const k = commandIndex(cmd.words);
            const declares = cmd.words[k] && ['export', 'declare', 'typeset', 'local', 'readonly'].includes(wordText(cmd.words[k]));
            for (const w of words) {
              const v = evaluate(w, scope);
              const assigned = declares ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(v.literal ?? '') : null;
              if (assigned) {
                vars[assigned[1]] = v.literal.slice(assigned[0].length);
                const carried = carriedPath(v.pattern.slice(assigned[0].length));
                if (carried !== null) reach(carried, { pattern: true, glob: v.glob, bases });
                continue;
              }
              const carried = carriedPath(v.pattern);
              if (carried !== null) reach(carried, { pattern: true, glob: v.glob, bases, recursive });
            }
            const next = directoryAfter(cmd, scope);
            if (next) dir = next;
          }
          // The session's own shell keeps a cd inside the directory it started in; one that leaves it is reset.
          if (recorded === null && !subagent && dir && project) shell = inside(normalize(dir), normalize(project)) ? dir : project;
        } else {
          const bases = [start].filter(Boolean);
          const input = use.input;
          const field = (k) => (typeof input[k] === 'string' && input[k] !== '' ? input[k] : null);
          if (use.name === 'Glob') {
            const base = field('path');
            if (base) reach(base, { bases, recursive: /\*\*/.test(field('pattern') ?? '') });
            // A Glob pattern is not a shell word: a backslash in it separates, it does not escape.
            const pattern = field('pattern')?.replace(/\\/g, '/');
            if (pattern) reach(pattern, { pattern: true, glob: true, bases: base ? [absolute(base, { cwd: start, home })].filter(Boolean) : bases });
          } else if (use.name === 'Grep') {
            const base = field('path');
            if (base) reach(base, { bases, recursive: true });
          } else {
            const known = { Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'], NotebookEdit: ['notebook_path'], NotebookRead: ['notebook_path'], LS: ['path'] }[use.name];
            const keys = known ?? Object.keys(input).filter((k) => /(^|_)(path|file|dir|directory|cwd)$|Path$/.test(k));
            for (const key of keys) {
              const value = field(key);
              if (value) reach(value, { bases });
            }
          }
        }
        // Any forbidden root named literally, anywhere in the call.
        for (const s of stringLeaves(use.input)) for (const m of mentions(s, forms)) record('hits', at(m.root, m.form));
        hits.push(...mostSpecific(reached.hits));
        probes.push(...mostSpecific(reached.probes).filter((p) => !reached.hits.has(p.root)));
      }
    }
    // An acceptance reviewer's final answer is a verdict the controller takes (CSET-203 r8): any forbidden root it names is a hit.
    for (const answer of reviewerAnswers(file, entries)) {
      const reached = new Map();
      for (const m of mentions(answer.text, forms)) if (!reached.has(m.root)) reached.set(m.root, { file, line: answer.line, tool: 'AgentResult', root: m.root, path: m.form });
      hits.push(...mostSpecific(reached));
    }
  }
  return { hits, probes };
}

const FILE_TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/**
 * Product state a controller session changed itself. A with-arm session is
 * the controller: the module-worker subagent changes product code, inside
 * its worktree, through Mycelink, and writes its own result. Fed a
 * session's stream-json as it grows, the scanner reads its top-level tool
 * calls (never a subagent's: those carry `parent_tool_use_id`) and names
 * each that writes at or inside one of `roots` (the registered
 * repositories, their worktrees — a ticket's result slot, `.mycelink-worker/`,
 * included: CSET-202 r2's controller forged criterion evidence there — and
 * the features' evidence): a Write, Edit, MultiEdit or NotebookEdit of a
 * file there; a Bash call that writes there as lib/writes.mjs reads it (a
 * redirection, tee, cp, mv, rm, sed or perl in place, python or node code,
 * a script it wrote and ran, a git command that changes commits, branches,
 * the index or files); and, wherever it runs, a worker's gate (`mycelink tdd
 * red|green|regression`, `evidence record`): gates record a worker's
 * evidence. Mycelink's other commands are the controller's tool; reads,
 * builds and tests are not edits, nor is anything else in the control
 * repository. What stops a session must not guess, so each call has one
 * directory, as its shell does: where the session's shell was (as the access
 * scan tracks it), moved by each `cd` but one in a subshell, one after
 * `||`, and, given `exists` (a running session's directories are on disk),
 * one to a directory that does not exist; a path nothing resolves is not
 * judged. `feed(text, roots)` and `end(roots)` return the new edits, each
 * `{ line, tool, action, path, command }`: the file it wrote, for git the
 * root it changed, for a gate the node; `command` the call.
 */
export function editScanner({ cwd = null, home = null, exists = null, readFile = null } = {}) {
  let pending = '';
  let lineNo = 0;
  let project = null;
  let shell = null;
  /** Edits of a call whose result has not come yet, by its tool_use id. */
  const awaiting = new Map();
  /** Edits of calls the plugin's fence refused: nothing ran. */
  const blocked = [];
  const scanLine = (line, rootList) => {
    lineNo += 1;
    if (!line.trim()) return [];
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (event?.type === 'system' && event.subtype === 'init' && typeof event.cwd === 'string') {
      project ??= event.cwd;
      shell = event.cwd;
    }
    // A subagent's calls are its own: the module-worker is the one that changes product code.
    if (typeof event?.parent_tool_use_id === 'string' || event?.isSidechain === true) return [];
    // A call's result releases its edits — unless the plugin's fence refused it (CSET-203 r9: nothing ran).
    const released = [];
    for (const r of toolResults(event)) {
      const edits = awaiting.get(r.id);
      if (!edits) continue;
      awaiting.delete(r.id);
      if (r.blocked) blocked.push(...edits.map((e) => ({ ...e, blocked: true })));
      else released.push(...edits);
    }
    const forms = rootList.filter(Boolean).flatMap((root) => rootForms(root).map((form) => ({ root, form })));
    const rootOf = (path) => forms.find((f) => inside(path, f.form))?.root ?? null;
    const recorded = typeof event?.cwd === 'string' ? event.cwd : null;
    const start = recorded ?? shell ?? cwd;
    const found = [];
    for (const use of toolUses(event)) {
      const mine = [];
      // One finding per call, action and path (a script that writes twice where it cannot be told is one unknown write).
      const at = (action, path, command, extra = {}) => {
        if (mine.some((m) => m.action === action && m.path === path && Boolean(m.unknown) === Boolean(extra.unknown))) return;
        mine.push({ line: lineNo, tool: use.name, action, path, command: String(command).slice(0, 300), ...extra });
      };
      if (use.name in FILE_TOOLS) {
        const value = use.input[FILE_TOOLS[use.name]];
        const path = typeof value === 'string' && value !== '' ? absolute(value, { cwd: start, home }) : null;
        if (path !== null && rootOf(path) !== null) at(use.name, path, value);
      } else if (use.name === 'Bash' && typeof use.input.command === 'string') {
        const call = lineWrites(use.input.command, { cwd: start, home, exists, readFile });
        for (const w of call.writes) {
          if (w.gate) at(w.action, w.node ?? '(node)', use.input.command, { gate: true });
          // A write the reader cannot place may be anywhere: the harness looks at the workspace itself.
          else if (w.unknown) at(w.action, normalize(w.path), use.input.command, { unknown: true });
          else {
            const path = normalize(w.path);
            const root = rootOf(path);
            if (root !== null) at(w.action, w.git ? root : path, use.input.command, w.git ? { git: true } : {});
          }
        }
        const dir = call.dir;
        // The session's own shell keeps a cd inside the directory it started in; one that leaves it is reset.
        if (recorded === null && dir && project) shell = inside(normalize(dir), normalize(project)) ? dir : project;
      }
      if (mine.length === 0) continue;
      if (typeof use.id === 'string' && use.id !== '') awaiting.set(use.id, mine);
      else found.push(...mine);
    }
    return [...released, ...found];
  };
  return {
    feed(text, roots) {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      return lines.flatMap((l) => scanLine(l, roots));
    },
    /** What is left: the last line, and the edits of calls whose result never came (the session ended in them). */
    end(roots) {
      const rest = pending;
      pending = '';
      const last = rest ? scanLine(rest, roots) : [];
      const unanswered = [...awaiting.values()].flat().map((e) => ({ ...e, unconfirmed: true }));
      awaiting.clear();
      return [...last, ...unanswered].sort((a, b) => a.line - b.line);
    },
    /** The edits of calls the plugin's fence refused. */
    get blocked() {
      return [...blocked];
    },
  };
}

/** The tool results an event carries: `{ id, blocked }` — blocked when the plugin's PreToolUse fence refused the call. */
function* toolResults(event) {
  for (const message of [event?.message, event?.data?.message]) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
      const text = typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? part.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '';
      yield { id: part.tool_use_id, blocked: part.is_error === true && /(^|\]: |\n)Blocked: /.test(text) };
    }
  }
}

/** Every edit `editScanner` finds in a whole stream. */
export function controllerEdits({ text, roots, cwd = null, home = null, exists = null }) {
  const scanner = editScanner({ cwd, home, exists });
  return [...scanner.feed(text, roots), ...scanner.end(roots)];
}

/** Utilities that only print or search text: `--plugin-dir` among their arguments loads nothing. */
const TEXT_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'echo', 'printf', 'sed', 'awk', 'gawk', 'cat', 'head', 'tail', 'less', 'more', 'man', 'wc', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'git']);

/**
 * Commands in `files` (any session's or worker's Bash calls, nested shells
 * and substitutions included) that pass `--plugin-dir` to something that
 * could load it: `[{ file, line, tool, command }]`. Help text, prose and
 * payloads that merely mention the option are not invocations.
 */
export function pluginInvocations({ files }) {
  const found = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [i, line] of text.split('\n').entries()) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      for (const use of toolUses(event)) {
        if (use.name !== 'Bash' || typeof use.input?.command !== 'string') continue;
        for (const cmd of readShell(use.input.command)) {
          const k = commandIndex(cmd.words);
          const words = cmd.words.slice(k).map(wordText);
          if (words.length === 0 || TEXT_TOOLS.has(posix.basename(words[0]))) continue;
          if (words.some((w) => w === '--plugin-dir' || w.startsWith('--plugin-dir='))) {
            found.push({ file, line: i + 1, tool: use.name, command: words.join(' ').slice(0, 200) });
            break;
          }
        }
      }
    }
  }
  return found;
}

/** Plugins a session's init event reports loaded from a directory (not built in): `[{ file, line, name, path }]`. */
export function loadedPlugins({ files }) {
  const found = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [i, line] of text.split('\n').entries()) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== 'system' || event.subtype !== 'init' || !Array.isArray(event.plugins)) continue;
      for (const p of event.plugins) if (typeof p?.path === 'string' && p.path !== 'builtin') found.push({ file, line: i + 1, name: String(p.name ?? ''), path: p.path });
    }
  }
  return found;
}
