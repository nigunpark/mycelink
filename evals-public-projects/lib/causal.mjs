/**
 * Who ran a call, and what it may have changed (CSET-202 final).
 *
 * CSET-202's latest with arm was stopped twice for a stash its own
 * module-workers pushed and popped in their worktrees: each time the host sat
 * in `sleep 100; echo waiting` while its background worker ran, and the
 * controller-session transaction took any host call open meanwhile for a hand
 * in the stash. Being open at the same time is no cause. Two readings stand in
 * for it (lib/shared-git.mjs uses both):
 *
 *  - streamTree: the session's causal tree, read from its stream-json output
 *    (Claude Code's stdout as the harness captured it; no session writes it):
 *    every tool call with the Agent call it ran under (`parent_tool_use_id`)
 *    and where it ended, and the task each Agent call started
 *    (`task_started`: the subagent's id) and where that task ended. A call
 *    shown twice, differently, or an Agent call bound to two tasks is in
 *    conflict. A heartbeat, a local Bash task or a compaction binds nothing.
 *  - shellEffects: what a Bash command may change, read as its shell runs it
 *    (lib/shell.mjs): each simple command it executes — nested shells,
 *    `eval`, command substitutions and function bodies included — must
 *    provably change nothing (wait, print, test, move its own directory, read
 *    files, run a read-only git command, or run Mycelink's own CLI from the
 *    sealed plugin, whose every change its ledger records), else the command
 *    may change anything; and every `git stash` it runs, with the directory
 *    it runs in (followed through `cd`, `-C` and the command's own variables;
 *    null where that cannot be told).
 *
 * Text a command only carries — an echo's or printf's arguments, a quoted
 * argument, a comment, a heredoc read as data — runs nothing.
 */
import { posix } from 'node:path';
import { SHELLS, evaluate, readShell, wordText } from './shell.mjs';

export const AGENT_TOOLS = new Set(['Agent', 'Task']);
export const MODULE_WORKERS = new Set(['mycelink:module-worker', 'module-worker']);

// ---- the causal tree ------------------------------------------------------------------

/**
 * The session's causal tree from its stream-json text: `{ session, uses,
 * tasks, resumes, compactions, lines }`. `uses`: tool use id → `{ id, name,
 * input, parent (the Agent call it ran under, null for the host's), line,
 * ended (the line of its result, or null), error, conflict }`. `tasks`:
 * Agent call id → `{ task (the subagent's id), background, line, ended (its
 * first stop), ends (every stop), status, conflict }`. `resumes`: subagent id
 * → the lines where a SendMessage resumed it (its result names
 * `resumedAgentId`); a resumed subagent's calls still run under the Agent
 * call that launched it. A line cut short or not JSON is skipped.
 */
export function streamTree(text) {
  const uses = new Map();
  const tasks = new Map();
  const resumes = new Map();
  let session = null;
  let first = null;
  let compactions = 0;
  const lines = String(text ?? '').split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e === null || typeof e !== 'object') continue;
    if (first === null && typeof e.session_id === 'string') first = e.session_id;
    if (e.type === 'system') {
      if (e.subtype === 'init' && typeof e.session_id === 'string') session = e.session_id;
      else if (e.subtype === 'compact_boundary') compactions += 1;
      else if (e.subtype === 'task_started' && typeof e.tool_use_id === 'string' && typeof e.task_id === 'string' && e.task_type !== 'local_bash') {
        const was = tasks.get(e.tool_use_id);
        if (was) {
          if (was.task !== e.task_id) was.conflict = true;
        } else tasks.set(e.tool_use_id, { task: e.task_id, background: e.is_backgrounded === true, line: i, ended: null, ends: [], status: null, conflict: false });
      } else if (e.subtype === 'task_notification' && typeof e.tool_use_id === 'string') {
        const t = tasks.get(e.tool_use_id);
        if (t && (typeof e.task_id !== 'string' || e.task_id === t.task)) {
          t.ends.push(i);
          if (t.ended === null) t.ended = i;
          t.status = typeof e.status === 'string' ? e.status : t.status;
        }
      }
      continue;
    }
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === 'assistant') {
      const parent = typeof e.parent_tool_use_id === 'string' && e.parent_tool_use_id !== '' ? e.parent_tool_use_id : null;
      for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string') continue;
        const input = c.input !== null && typeof c.input === 'object' && !Array.isArray(c.input) ? c.input : {};
        const was = uses.get(c.id);
        if (was) {
          if (was.name !== String(c.name ?? '') || was.parent !== parent || JSON.stringify(was.input) !== JSON.stringify(input)) was.conflict = true;
          continue;
        }
        uses.set(c.id, { id: c.id, name: String(c.name ?? ''), input, parent, line: i, ended: null, error: false, conflict: false });
      }
    } else if (e.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
        const u = uses.get(c.tool_use_id);
        if (u && u.ended === null) {
          u.ended = i;
          u.error = c.is_error === true;
        }
        // A SendMessage that resumed a stopped subagent: its result names it.
        if (u?.name === 'SendMessage' && c.is_error !== true) {
          const m = /"resumedAgentId"\s*:\s*"([A-Za-z0-9_-]{1,128})"/.exec(typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '').replace(/\\"/g, '"'));
          if (m) resumes.set(m[1], [...(resumes.get(m[1]) ?? []), i]);
        }
      }
    }
  }
  return { session: session ?? first, uses, tasks, resumes, compactions, lines: lines.length };
}

/**
 * Whether the stream shows a subagent alive at `line`: launched by its Agent
 * call (or resumed since) and not stopped since — its task's notification,
 * or, for one launched in the foreground with no task, its Agent call's
 * result.
 */
export function aliveAt(tree, launch, agent, line) {
  const task = tree.tasks.get(launch.id);
  const ends = task ? task.ends : launch.ended !== null ? [launch.ended] : [];
  const starts = [launch.line, ...(tree.resumes.get(agent) ?? [])];
  const lastStart = Math.max(-1, ...starts.filter((s) => s < line));
  const lastEnd = Math.max(-1, ...ends.filter((s) => s < line));
  return lastStart >= 0 && lastStart > lastEnd;
}

// ---- paths ------------------------------------------------------------------------------

const DRIVE = /^[A-Za-z]:\//;

/** An absolute path in '/' form (a Windows drive kept as written), resolved against `cwd`; null when it cannot be told. */
function absolute(path, cwd) {
  const t = String(path).replace(/\\/g, '/');
  let out;
  if (DRIVE.test(t) || t.startsWith('/')) out = posix.normalize(t);
  else if (cwd === null) return null;
  else out = posix.normalize(posix.join(String(cwd).replace(/\\/g, '/'), t));
  return out.length > 1 && !/^[A-Za-z]:\/$/.test(out) ? out.replace(/\/+$/, '') : out;
}

/** A path as paths are compared: '/'-separated, normalised, a drive letter folded (all of it on Windows). */
export function pathKey(path) {
  const a = absolute(path, null);
  if (a === null) return null;
  const folded = DRIVE.test(a) ? `${a[0].toLowerCase()}${a.slice(1)}` : a;
  return process.platform === 'win32' ? folded.toLowerCase() : folded;
}

/** Whether `path` is `root` or inside it. */
export function insidePath(path, root) {
  const p = pathKey(path);
  const r = pathKey(root);
  return p !== null && r !== null && (p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`));
}

// ---- what a command may change ----------------------------------------------------------

/** Commands that change nothing: they wait, print, test, look a command up, or move the shell's own directory. */
const INERT = new Set(['sleep', 'true', 'false', ':', 'echo', 'printf', 'wait', 'pwd', 'cd', 'pushd', 'popd', 'test', '[', '[[', ']]', 'exit', 'return', 'shift', 'set', 'shopt', 'for', 'select', 'type', 'which', 'date', 'export', 'local', 'declare', 'typeset', 'readonly', 'unset']);
/** Commands that only read and print (an option that makes one write or run something is refused below). */
const READERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink', 'id', 'whoami', 'uname', 'ps', 'pgrep', 'cut', 'tr', 'comm', 'cmp', 'diff', 'nl', 'sha256sum', 'sha1sum', 'md5sum', 'find', 'jq', 'env', 'printenv', 'tac', 'rev', 'seq', 'column', 'sort', 'uniq']);
/** Git commands that only read (their writing options refused below). */
const GIT_READS = new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'for-each-ref', 'describe', 'blame', 'shortlog', 'grep', 'merge-base', 'name-rev', 'show-ref', 'count-objects', 'version', 'help', 'whatchanged', 'cherry', 'var', 'check-ignore', 'check-attr', 'diff-tree', 'diff-index', 'diff-files', 'show-branch']);
/** Git's own options a read may carry (`-C` followed), and those that take a value. */
const GIT_OPTIONS = new Set(['-C', '--no-pager', '-P', '--paginate', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects', '--git-dir', '--work-tree', '--namespace']);
const GIT_VALUED = new Set(['-C', '--git-dir', '--work-tree', '--namespace']);
/** A stash subcommand and what it does to the stash. */
const STASH_SUBS = new Set(['push', 'save', 'pop', 'apply', 'drop', 'clear', 'store', 'branch', 'create', 'list', 'show']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const DEV_NULLS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
/** Variables that change which program a command runs, or how git, a shell or an interpreter starts. */
const DANGEROUS = /^(PATH|HOME|XDG_CONFIG_HOME|LD_[A-Z_]*|DYLD_[A-Z_]*|BASH_ENV|ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|IFS|CDPATH|GIT_[A-Z_]*|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT)$/;
const WRAPPERS = new Set(['timeout', 'nice', 'nohup', 'stdbuf', 'setsid', 'time', 'builtin', 'exec', 'command']);

const base = (p) => posix.basename(String(p).replace(/\\/g, '/')).replace(/\.exe$/i, '');

/** A word's value, split as the shell splits an unquoted expansion; null for a part that cannot be told. */
function argvOf(words, scope) {
  const out = [];
  for (const w of words) {
    const v = evaluate(w, scope);
    if (v.literal === null) {
      out.push(null);
      continue;
    }
    if (w.some((s) => ('variable' in s || 'unknown' in s) && !s.quoted)) out.push(...v.literal.split(/[ \t\n]+/).filter(Boolean));
    else out.push(v.literal);
  }
  return out;
}

/**
 * What one Bash command may change: `{ changes, why, stash }` — `changes`
 * false only when every simple command it runs provably changes nothing
 * (`why`: the first that may, in a few words); `stash`: every `git stash`
 * it runs that is not a read (`{ sub: 'push' | 'pop' | 'apply' | 'drop' |
 * 'clear' | 'store' | 'branch' | 'create' | <unknown word>, dir, entry }`,
 * `save` and a bare `git stash` read as `push`). `cwd`: where it starts;
 * `home`; `mycelink`: the sealed plugin's CLI scripts, whose changes are
 * Mycelink's ledger's to record.
 */
export function shellEffects(command, { cwd = null, home = null, mycelink = [] } = {}) {
  const out = { changes: false, why: null, stash: [] };
  const mark = (why) => {
    if (!out.changes) {
      out.changes = true;
      out.why = why;
    }
  };
  let commands;
  try {
    commands = readShell(command);
  } catch {
    mark('a command its shell reader cannot read');
    return out;
  }
  const trusted = new Set(mycelink.map((p) => pathKey(p)).filter((p) => p !== null));
  const vars = {};
  let dir = cwd === null ? null : absolute(cwd, null);
  for (const cmd of commands) {
    const scope = { vars, home, cwd: dir };
    for (const a of cmd.assigns) if (DANGEROUS.test(a.name)) mark(`assigns ${a.name}`);
    for (const r of cmd.redirects) {
      if (!WRITE_REDIRECTS.has(r.op)) continue;
      const target = evaluate(r.target, scope).literal;
      if (target === null || !DEV_NULLS.has(target)) mark(`writes ${target ?? 'a path it computes'}`);
    }
    const argv = argvOf(cmd.words, scope);
    // GIT_DIR and the like set for this command alone: where its git runs cannot be told.
    const gitEnv = cmd.words.length > 0 && cmd.assigns.some((a) => /^GIT_(DIR|WORK_TREE|COMMON_DIR)$/.test(a.name));
    if (argv.length > 0) simple({ argv, cmd, scope, mark, out, trusted, gitEnv });
    if (cmd.words.length === 0) {
      for (const a of cmd.assigns) {
        const v = evaluate(a.value, scope);
        if (v.literal !== null) vars[a.name] = v.literal;
        else delete vars[a.name];
      }
    } else if (['export', 'local', 'declare', 'typeset', 'readonly'].includes(argv[0] ?? '')) {
      for (const w of cmd.words.slice(1)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(wordText(w));
        if (!m) continue;
        if (DANGEROUS.test(m[1])) mark(`assigns ${m[1]}`);
        const v = evaluate(w, scope).literal;
        if (v !== null) vars[m[1]] = v.slice(m[1].length + 1);
        else delete vars[m[1]];
      }
    }
    // A cd moves the shell (not one in a nested shell or substitution, nor the alternative after `||`).
    if (!cmd.nested && cmd.after !== '||' && (argv[0] === 'cd' || argv[0] === 'pushd')) {
      const args = argv.slice(1).filter((x) => x === null || !/^-[LPe@]$/.test(x));
      dir = args.length === 0 ? (home === null ? null : absolute(home, null)) : args[0] === null || args[0] === '-' ? null : absolute(args[0], dir);
    } else if (!cmd.nested && argv[0] === 'popd') dir = null;
  }
  return out;
}

/** One simple command: what it runs, after the wrappers that only run another. */
function simple({ argv, cmd, scope, mark, out, trusted, gitEnv }) {
  let a = argv;
  for (let guard = 0; guard < 8 && a.length > 0; guard++) {
    const name = a[0] === null ? null : base(a[0]);
    if (name === 'env') {
      a = a.slice(1);
      while (a.length > 0 && (a[0] === null || a[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]))) {
        if (a[0] === null) return mark('runs env with what it computes');
        if (/^-(S|-split-string)/.test(a[0])) return mark('runs env -S');
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(a[0]);
        if (m && DANGEROUS.test(m[1])) return mark(`assigns ${m[1]}`);
        a = a.slice(/^-(u|C)$/.test(a[0]) || /^--(unset|chdir)$/.test(a[0]) ? 2 : 1);
      }
      // `env` alone prints the environment.
      if (a.length === 0) return;
      continue;
    }
    if (name === 'sudo' || name === 'doas' || name === 'su') return mark(`runs ${name}`);
    if (name === 'command' && (a[1] === '-v' || a[1] === '-V')) return;
    if (name !== null && WRAPPERS.has(name)) {
      a = a.slice(1);
      while (a.length > 0 && a[0] !== null && a[0].startsWith('-')) a = a.slice(/^-(n|s|k|i|o|e)$/.test(a[0]) ? 2 : 1);
      if (name === 'timeout' && a[0] !== null && /^[0-9.]+[smhd]?$/.test(a[0] ?? '')) a = a.slice(1);
      if (a.length === 0) return;
      continue;
    }
    if (name === 'xargs') {
      a = a.slice(1);
      while (a.length > 0 && a[0] !== null && a[0].startsWith('-')) a = a.slice(/^-(I|L|n|P|d|E|s|a)$/.test(a[0]) ? 2 : 1);
      // xargs with no command echoes what it reads.
      if (a.length === 0) return;
      continue;
    }
    break;
  }
  if (a.length === 0) return;
  if (a[0] === null) return mark('runs an unknown command (one it computes)');
  const name = base(a[0]);
  const args = a.slice(1);
  if (name === 'git') return git({ args, scope, mark, out, gitEnv });
  if (/^node(js)?$/.test(name) && args[0] !== null && args[0] !== undefined && !args[0].startsWith('-') && trusted.has(pathKey(absolute(args[0], scope.cwd) ?? '') ?? '') && args[1] !== 'hook') return;
  if (INERT.has(name)) {
    if (name === 'date' && args.some((x) => x === null || /^(-s|--set)/.test(x))) mark('runs date --set');
    return;
  }
  if (READERS.has(name)) {
    const bad =
      (name === 'find' && args.some((x) => x === null || /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(x))) ||
      (name === 'rg' && args.some((x) => x === null || /^--pre/.test(x))) ||
      (name === 'sort' && args.some((x) => x === null || /^(--output|-[A-Za-z]*o)/.test(x))) ||
      (name === 'uniq' && args.filter((x) => x === null || !x.startsWith('-')).length > 1);
    if (bad) mark(`runs ${name} with what may write or run`);
    return;
  }
  // A literal word the shell reader saw as it is (lib/shell.mjs nests a shell's `-c` script and eval's words only then).
  const literal = (w) => w.every((s) => 'text' in s);
  if (SHELLS.has(name)) {
    // `sh -c '<script>'`: its script was read as commands, when the shell and the script are written out.
    const k = cmd.words.findIndex((w) => literal(w) && SHELLS.has(base(wordText(w))));
    const c = k < 0 ? -1 : cmd.words.findIndex((w, j) => j > k && /^-[A-Za-z]*c[A-Za-z]*$/.test(wordText(w)));
    const script = c > 0 ? cmd.words[c + 1] : undefined;
    if (script !== undefined && literal(script)) return;
    return mark(`runs ${name}`);
  }
  // eval of literal words: what it runs was read as commands.
  if (name === 'eval') {
    const k = cmd.words.findIndex((w) => literal(w) && wordText(w) === 'eval');
    if (k >= 0 && cmd.words.slice(k + 1).every(literal)) return;
  }
  return mark(`runs ${name}`);
}

/** A git command: a read changes nothing; a stash command is noted with where it runs; anything else may change anything. */
function git({ args, scope, mark, out, gitEnv }) {
  let i = 0;
  let dir = gitEnv ? null : scope.cwd;
  let elsewhere = gitEnv;
  while (i < args.length && args[i] !== null && args[i].startsWith('-')) {
    const opt = args[i];
    const eq = opt.indexOf('=');
    const key = opt.startsWith('--') && eq > 0 ? opt.slice(0, eq) : opt;
    if (!GIT_OPTIONS.has(key)) return mark(`runs git ${key}`);
    if (key === '--git-dir' || key === '--work-tree') elsewhere = true;
    const valued = GIT_VALUED.has(key) && eq < 0;
    if (key === '-C') {
      // `-C` options add up, each relative to the one before it (an absolute one starts over).
      const v = args[i + 1];
      dir = v === null || v === undefined ? null : absolute(v, dir);
    }
    i += valued ? 2 : 1;
  }
  const sub = args[i];
  if (sub === null) return mark('runs git with a command it computes');
  if (sub === undefined) return;
  const rest = args.slice(i + 1);
  const has = (re) => rest.find((x) => x !== null && re.test(x)) ?? null;
  if (sub === 'stash') {
    const first = rest[0];
    const word = first === undefined || (first !== null && first.startsWith('-')) ? 'push' : first;
    if (word === null) {
      out.stash.push({ sub: 'unknown', dir: elsewhere ? null : dir, entry: null });
      return mark('runs git stash with a subcommand it computes');
    }
    const op = word === 'save' ? 'push' : word;
    if (op === 'list' || op === 'show') {
      if (rest.some((x) => x === null)) return mark(`runs git stash ${op} with arguments it computes`);
      const writes = has(/^--output/);
      if (writes !== null) mark(`runs git stash ${op} ${writes}`);
      return;
    }
    const operands = (word === first ? rest.slice(1) : rest).filter((x) => x === null || !x.startsWith('-'));
    const entry = ['pop', 'apply', 'drop', 'branch'].includes(op) ? (operands[op === 'branch' ? 1 : 0] ?? null) : null;
    out.stash.push({ sub: STASH_SUBS.has(op) ? op : op, dir: elsewhere ? null : dir, entry });
    return mark(`runs git stash ${op}`);
  }
  if (GIT_READS.has(sub)) {
    // A read with an argument it computes could be given an option that writes.
    if (rest.some((x) => x === null)) return mark(`runs git ${sub} with arguments it computes`);
    const writes = has(/^--output/) ?? has(/^--ext-diff$/) ?? has(/^--exec/) ?? (sub === 'grep' ? has(/^(-O|--open-files-in-pager)/) : null);
    if (writes !== null) mark(`runs git ${sub} ${writes}`);
    return;
  }
  if (rest.some((x) => x === null)) return mark(`runs git ${sub}`);
  const operands = rest.filter((x) => x === null || !x.startsWith('-'));
  const flags = rest.filter((x) => x !== null && x.startsWith('-'));
  const listing =
    (sub === 'branch' && !flags.some((f) => /^(-[dDmMcCfut]|--(delete|move|copy|force|set-upstream|set-upstream-to|unset-upstream|edit-description|track|create-reflog))/.test(f)) && (operands.length === 0 || flags.some((f) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)/.test(f)))) ||
    (sub === 'tag' && (operands.length === 0 || flags.some((f) => /^(-l|--list|--contains|--no-contains|--points-at|-n)/.test(f))) && !flags.some((f) => /^(-[dafsmFu]|--(delete|annotate|force|sign|message|file))/.test(f))) ||
    (sub === 'worktree' && operands[0] === 'list') ||
    (sub === 'remote' && (operands.length === 0 || ['show', 'get-url'].includes(operands[0] ?? ''))) ||
    (sub === 'config' && (flags.some((f) => /^(--get|--get-all|--get-regexp|-l|--list)$/.test(f)) || ['get', 'list'].includes(operands[0] ?? ''))) ||
    (sub === 'reflog' && (operands.length === 0 || ['show', 'exists'].includes(operands[0] ?? ''))) ||
    (sub === 'notes' && ['list', 'show'].includes(operands[0] ?? ''));
  if (listing) return;
  return mark(`runs git ${sub}`);
}
