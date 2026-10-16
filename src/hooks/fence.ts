/**
 * The controller/worker fence, decided before a tool runs (PreToolUse).
 *
 * CSET-202 r2: the top-level controller rewrote module-workers' result files
 * (`sed -i`, `cat >`) to change their criterion evidence, and the read node
 * settled DONE on evidence the controller had forged; nothing but QA's
 * rework phase was watched. A worker and its host share one OS user, so no
 * key separates them; but Claude Code tells a hook whether a tool call comes
 * from the main thread or a subagent (`agent_id`, `agent_type`, verified on
 * 2.1.290). The plugin registers this fence for every Write, Edit,
 * MultiEdit, NotebookEdit and Bash call (hooks/hooks.json):
 *
 *  - the controller — the main thread, or any subagent that is not
 *    `mycelink:module-worker` — may read anything and run Mycelink's CLI, but
 *    never writes, through a file tool or the shell (security/shell-writes.ts:
 *    cd, git -C, redirections, heredocs, sed -i, tee, cp, python, node, a
 *    script it wrote and runs), a registered repository, a worker worktree
 *    or its result slot, Mycelink's scratch area, or a feature's evidence,
 *    sessions, state or approved criteria; nor runs a worker's gate;
 *  - a module-worker (or a session the controller spawned for a node,
 *    MYCELINK_NODE_ID) writes worker worktrees and result slots, never a
 *    repository's own checkout, the scratch area or the evidence, never
 *    spawns a subagent, and never settles or reviews: its host does;
 *  - the acceptance reviewer (`mycelink:acceptance-reviewer`) is read-only
 *    everywhere: no Edit, no shell, no subagent; its one write is its
 *    verdict, whole, with Write, to the verdict file of a review generation
 *    the controller opened — and the hook attests that write beside it
 *    (subagent, session, the verdict's canonical hash), so a verdict
 *    anything else put there is refused at settle. Not over a verdict the
 *    controller already took from a reviewer's final answer, nor over one
 *    another reviewer wrote;
 *  - the host's Agent call for the reviewer carries what the hook records of
 *    it (the call, the session and its transcript, the prompt): the launch a
 *    final answer is later proved against (engine/review-transport.ts);
 *  - nobody writes Claude Code's session transcripts or a subagent's
 *    transcript or meta (`<config>/projects/<project>/<session>.jsonl`,
 *    `.../<session>/subagents/**`): they are what a final answer is proved
 *    from;
 *  - inside a Mycelink workspace (a control repository, and the project
 *    directory holding one) the controller writes only its own documents — a
 *    feature's directory, PRD, plan, graph and E2E scenarios, contracts,
 *    handoffs — and commits the control repository with git add and git
 *    commit; a helper or scratch file belongs under $TMPDIR, Mycelink's own
 *    files and the approved inputs are never its to change, and code whose
 *    writes the shell reader cannot place (a computed path, a script it
 *    cannot read) is refused (CSET-203 r9). What code only reads is no
 *    write (security/code-writes.ts). The benchmark's post-session check of
 *    the workspace stays the authority; this refuses what it can see;
 *  - anything outside a Mycelink workspace is not fenced.
 *
 * The control repositories are found from the session's directory, the
 * project directory and the target paths themselves; a workspace without one
 * is not fenced. A call the fence cannot judge is refused inside a Mycelink
 * workspace (fail closed) and let through outside one.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadRepositories } from '../workspace/workspace.js';
import { readShell } from '../security/shell.js';
import { mycelinkArgs, shellWrites, type ShellWrites } from '../security/shell-writes.js';
import { madeOnBranch, stashEntries, type StashEntry } from '../git/stash.js';
import { redBoundRefusal } from './red-bound.js';
import { workerBinding } from './worker-binding.js';
import { readRegular } from '../security/paths.js';

export interface FenceInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  session_id?: string;
  tool_use_id?: string;
  /** The session's transcript (Claude Code gives every hook its path). */
  transcript_path?: string;
}

/** The host session's Agent call for the acceptance reviewer, as the hook records it (hooks/review-launch.ts). */
export interface ReviewerLaunchCall {
  tool_use_id: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  subagent_type: string;
  description: string | null;
  prompt: string;
}

/**
 * The fence's decision for one tool call. An allowed Write of an acceptance
 * reviewer's verdict carries what the hook attests beside it (the file and
 * the content the reviewer is writing); the host's Agent call for the
 * reviewer, what the hook records of the launch.
 */
export type FenceDecision = { ok: true; attest?: { file: string; content: string }; launch?: ReviewerLaunchCall } | { ok: false; reason: string };

/** The subagent Mycelink dispatches a node to. */
export const MODULE_WORKER = 'mycelink:module-worker';
/** The read-only subagent Mycelink hands an acceptance review to (engine/acceptance-review.ts). */
export const ACCEPTANCE_REVIEWER = 'mycelink:acceptance-reviewer';

const FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/** Controller commands a worker never runs: its host settles, dispatches, reviews and delivers. */
const HOST_ONLY = new Set(['settle', 'dispatch', 'deliver', 'controller', 'orchestrate', 'review']);

/** `<control>/.mycelink/reviews/<FEATURE-1>/<FEATURE-1-R001>/<dispatch uuid>/verdict.json`: the one file a reviewer writes. */
const VERDICT_FILE = /^(.*)\/\.mycelink\/reviews\/([A-Z][A-Z0-9]*-[0-9]+)\/(\2-R[0-9]{3,})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/verdict\.json$/;

const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
const norm = (p: string): string => fold(resolve(p)).replace(/\\/g, '/').replace(/\/+$/, '');
const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** A path with its nearest existing ancestor resolved through links, the rest appended. */
function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  let real = head;
  try {
    real = realpathSync.native(head);
  } catch {
    // as given
  }
  return join(real, ...tail);
}

const isControlRoot = (dir: string): boolean => {
  try {
    return statSync(join(dir, 'mycelink.config.json')).isFile();
  } catch {
    return false;
  }
};

/** Control repositories near the session: at or above each start, its children, and the prefix of a target under `.mycelink/`. */
export function controlRoots(starts: readonly (string | undefined)[], targets: readonly string[]): string[] {
  const found = new Set<string>();
  const consider = (dir: string): void => {
    if (isControlRoot(dir)) found.add(resolve(dir));
  };
  for (const start of starts) {
    if (!start || !isAbsolute(start)) continue;
    let dir = resolve(start);
    for (let i = 0; i < 12; i++) {
      consider(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    try {
      for (const e of readdirSync(start, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) consider(join(start, e.name));
    } catch {
      // not a directory
    }
  }
  for (const t of targets) {
    const at = t.replace(/\\/g, '/').indexOf('/.mycelink/');
    if (at > 0) consider(t.slice(0, at));
  }
  return [...found];
}

type Zone = 'repository' | 'worktree' | 'result slot' | 'scratch area' | 'evidence';

interface Fenced {
  root: string;
  repos: string[];
  worktrees: string;
  scratch: string;
  features: string;
}

function fencedOf(root: string): Fenced {
  let repos: string[] = [];
  try {
    repos = loadRepositories(root).repositories.map((r) => norm(realish(resolve(root, r.path))));
  } catch {
    repos = [];
  }
  const real = realish(root);
  return { root: norm(real), repos, worktrees: norm(join(real, '.mycelink', 'worktrees')), scratch: norm(join(real, '.mycelink')), features: norm(join(real, 'features')) };
}

/** Feature files only Mycelink writes: evidence, sessions, review receipts, state, events, runs, candidates, deliveries, leases, the approved criteria. */
const MANAGED_FEATURE = /^[^/]+\/(?:evidence|sessions|candidates|deliveries|resources|reviews)(?:\/|$)|^[^/]+\/(?:STATE\.json|events\.jsonl|RUNS\.jsonl|leases\.json|ACCEPTANCE\.json|LOOPS\.json)$/i;

function zoneOf(path: string, f: Fenced): Zone | null {
  if (inside(path, f.worktrees)) return /\/\.mycelink-worker(\/|$)/.test(path.slice(f.worktrees.length)) ? 'result slot' : 'worktree';
  if (inside(path, f.scratch)) return 'scratch area';
  if (f.repos.some((r) => inside(path, r))) return 'repository';
  if (inside(path, f.features) && MANAGED_FEATURE.test(path.slice(f.features.length + 1))) return 'evidence';
  return null;
}

/** The call's role: a module-worker (or a node's own session), the acceptance reviewer, else the controller. */
export function roleOf(input: FenceInput, env: NodeJS.ProcessEnv): 'worker' | 'reviewer' | 'controller' {
  if (typeof env['MYCELINK_NODE_ID'] === 'string' && env['MYCELINK_NODE_ID'] !== '') return 'worker';
  if (typeof input.agent_id === 'string' && input.agent_id !== '') {
    const type = String(input.agent_type ?? '');
    if (type === MODULE_WORKER || type === 'module-worker') return 'worker';
    if (type === ACCEPTANCE_REVIEWER || type === 'acceptance-reviewer') return 'reviewer';
    return 'controller';
  }
  return 'controller';
}

/**
 * The acceptance reviewer is read-only everywhere: it reads, and its one
 * write is its verdict, whole, with Write, to the verdict file of a review
 * generation the controller opened (its directory exists) under a control
 * repository's scratch area. No Edit, no shell, no subagent, no other file:
 * not product code, not a checkout it reads, not the control repository.
 * The Write it is allowed is attested beside the verdict by the hook.
 */
function reviewerDecision(input: FenceInput): FenceDecision {
  const tool = input.tool_name ?? '';
  const deny = (what: string): FenceDecision => ({
    ok: false,
    reason: `Blocked: the acceptance reviewer is read-only: ${what}. Read with Read, Glob and Grep; your one write is your verdict, whole, with Write, to the verdict file your prompt names.`,
  });
  if (tool === 'Bash') return deny('it runs no shell command');
  if (tool === 'Agent' || tool === 'Task') return deny('it spawns no subagent');
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return deny(`${tool} changes a file in place`);
  if (tool !== 'Write') return { ok: true };
  const value = (input.tool_input ?? {})['file_path'];
  if (typeof value !== 'string' || value === '') return deny('a Write names no file');
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const target = resolve(cwd, value);
  const real = realish(target).replace(/\\/g, '/');
  const m = VERDICT_FILE.exec(real);
  if (m === null) return deny(`${value.replace(/\\/g, '/')} is not the verdict file of a review`);
  try {
    if (!statSync(dirname(real)).isDirectory()) return deny('that review generation was never opened');
  } catch {
    return deny('that review generation was never opened');
  }
  if (!isControlRoot(m[1] as string)) return deny(`${m[1]} is not a control repository`);
  // One verdict per generation: never over one taken from a reviewer's final answer, nor over another reviewer's.
  const held = heldVerdict(dirname(real));
  if (held !== null && (held.transport === 'agent-result' || held.agent_id !== String(input.agent_id ?? ''))) {
    return deny(
      held.transport === 'agent-result'
        ? "that generation's verdict file already holds a verdict, taken from a reviewer's final answer; your verdict is already in"
        : "that generation's verdict file already holds a verdict another reviewer wrote",
    );
  }
  const content = (input.tool_input ?? {})['content'];
  return { ok: true, attest: { file: target, content: typeof content === 'string' ? content : '' } };
}

/** The verdict a generation's directory already holds, by its attestation: who wrote it and how; null when there is none. */
function heldVerdict(dir: string): { transport: string; agent_id: string } | null {
  try {
    if (!lstatSync(join(dir, 'verdict.json')).isFile()) return { transport: 'unknown', agent_id: '' };
  } catch {
    return null;
  }
  try {
    const a = JSON.parse(readFileSync(join(dir, 'verdict.attest.json'), 'utf8')) as { transport?: unknown; agent_id?: unknown };
    return { transport: typeof a.transport === 'string' ? a.transport : 'file', agent_id: typeof a.agent_id === 'string' ? a.agent_id : '' };
  } catch {
    return { transport: 'unknown', agent_id: '' };
  }
}

/** Where Claude Code keeps its session transcripts: `<config>/projects` of each config directory this session may use. */
function transcriptRoots(env: NodeJS.ProcessEnv): string[] {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? null;
  const configs = [env['CLAUDE_CONFIG_DIR'], home ? join(home, '.claude') : undefined].filter((d): d is string => typeof d === 'string' && d !== '' && isAbsolute(d));
  return [...new Set(configs.map((d) => norm(realish(join(d, 'projects')))))];
}

/** A session's transcript, or a subagent's transcript or meta, under a projects directory: only Claude Code writes them. */
function isTranscript(path: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (!inside(path, root) || path === root) continue;
    const rest = path.slice(root.length + 1).split('/');
    // <project>/<session>.jsonl, or <project>/<session>/subagents/...
    if (rest.length === 2 && (rest[1] as string).endsWith('.jsonl')) return true;
    if (rest.length >= 3 && rest[2] === 'subagents') return true;
  }
  return false;
}

/**
 * What the hook records of the host session's own Agent call for the
 * acceptance reviewer: the call, the session and its transcript, the prompt.
 * A subagent's call (it carries an agent id) is no launch the host made.
 */
function reviewerLaunch(input: FenceInput, cwd: string): { launch?: ReviewerLaunchCall } {
  const ti = input.tool_input ?? {};
  const type = String(ti['subagent_type'] ?? '');
  if (type !== ACCEPTANCE_REVIEWER && type !== 'acceptance-reviewer') return {};
  if (typeof input.agent_id === 'string' && input.agent_id !== '') return {};
  const prompt = ti['prompt'];
  if (typeof prompt !== 'string' || typeof input.tool_use_id !== 'string' || typeof input.session_id !== 'string' || typeof input.transcript_path !== 'string') return {};
  return {
    launch: {
      tool_use_id: input.tool_use_id,
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      cwd,
      subagent_type: type,
      description: typeof ti['description'] === 'string' ? (ti['description'] as string) : null,
      prompt,
    },
  };
}

/** The fence's decision for one tool call. */
export function fenceDecision(input: FenceInput, env: NodeJS.ProcessEnv = process.env): FenceDecision {
  try {
    return decide(input, env);
  } catch (err) {
    return unjudged(input, env, err);
  }
}

/** A call the fence cannot judge: refused inside a Mycelink workspace (fail closed), let through outside one. */
export function unjudged(input: FenceInput, env: NodeJS.ProcessEnv, err: unknown): FenceDecision {
  let roots: string[] = [];
  try {
    roots = controlRoots([typeof input.cwd === 'string' ? input.cwd : undefined, env['CLAUDE_PROJECT_DIR'], env['MYCELINK_CONTROL_ROOT']], []);
  } catch {
    roots = [String(input.cwd ?? '')];
  }
  if (roots.length === 0) return { ok: true };
  const tool = typeof input.tool_name === 'string' && input.tool_name !== '' ? input.tool_name : 'tool';
  return { ok: false, reason: `Blocked: the Mycelink fence could not judge this ${tool} call (${err instanceof Error ? err.message.slice(0, 200) : 'error'}); write it as a plain command, or let a module-worker make the change.` };
}

function decide(input: FenceInput, env: NodeJS.ProcessEnv): FenceDecision {
  const tool = input.tool_name ?? '';
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  // Codex sends patch text (not Claude file_path) and arbitrary MCP arguments.
  // Neither can be proven safe by this Claude-shaped path reader. Until a
  // complete host fence exists, refuse these calls in a Mycelink workspace.
  if ((tool === 'apply_patch' || tool.startsWith('mcp__')) &&
      controlRoots([cwd, env['CLAUDE_PROJECT_DIR'], env['MYCELINK_CONTROL_ROOT']], []).length > 0) {
    return { ok: false, reason: `Blocked: unclassified Codex ${tool} call cannot be judged by the Mycelink fence.` };
  }
  const role = roleOf(input, env);
  if (role === 'reviewer') return reviewerDecision(input);
  // A module-worker implements one node itself: no nested delegation.
  if (role === 'worker' && (tool === 'Agent' || tool === 'Task')) {
    return { ok: false, reason: 'Blocked: a module-worker spawns no subagent: implement the node yourself, or return NEEDS_DECISION.' };
  }
  if (tool === 'Agent' || tool === 'Task') return { ok: true, ...reviewerLaunch(input, cwd) };
  const writes: { action: string; path: string; unknown?: true }[] = [];
  const gates: { action: string; node: string | null }[] = [];
  const stashes: ShellWrites['stashes'] = [];
  let hostOnly: string | null = null;
  if (tool in FILE_TOOLS) {
    const value = (input.tool_input ?? {})[FILE_TOOLS[tool] as string];
    if (typeof value !== 'string' || value === '') return { ok: true };
    writes.push({ action: tool, path: resolve(cwd, value) });
  } else if (tool === 'Bash') {
    const command = String((input.tool_input ?? {})['command'] ?? '');
    const found = shellWrites(command, {
      cwd,
      home: env['HOME'] ?? env['USERPROFILE'] ?? null,
      exists: (d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      },
      readFile: (p) => {
        // Through one descriptor, never through a link: what is checked is what is read.
        return readRegular(p, 256 * 1024)?.bytes.toString('utf8') ?? null;
      },
    });
    writes.push(...found.writes);
    gates.push(...found.gates);
    stashes.push(...found.stashes);
    for (const cmd of readShell(command)) {
      const m = mycelinkArgs(cmd.words);
      // Hooks are Claude Code's to run: a session running one itself could forge a launch record or an attestation.
      if (m !== null && m[0] === 'hook') return { ok: false, reason: 'Blocked: mycelink hook is run by Claude Code as the plugin\'s hook, never by a session: what it records (a reviewer launch, a verdict attestation) proves what Claude Code saw.' };
      if (role === 'worker' && m !== null && HOST_ONLY.has(m[0] ?? '')) hostOnly = `mycelink ${m[0]}`;
    }
  } else {
    return { ok: true };
  }
  const roots = controlRoots([cwd, env['CLAUDE_PROJECT_DIR'], env['MYCELINK_CONTROL_ROOT']], writes.map((w) => w.path));
  if (roots.length === 0) return { ok: true };
  const fenced = roots.map(fencedOf);
  // Claude Code's transcripts: what a reviewer's final answer is proved from (engine/review-transport.ts).
  const transcripts = transcriptRoots(env);
  for (const w of writes) {
    if (isTranscript(norm(realish(w.path)), transcripts)) {
      return { ok: false, reason: `Blocked: ${w.path.replace(/\\/g, '/')} is a Claude Code session transcript, or a subagent's transcript or meta: only Claude Code writes it (${w.action}). Mycelink takes a reviewer's final answer from it.` };
    }
  }
  // The provenance ledger (MYCELINK_PROVENANCE): what the hooks and Mycelink's core record of every call and change. No session writes it.
  const provenance = env['MYCELINK_PROVENANCE'];
  if (typeof provenance === 'string' && isAbsolute(provenance)) {
    const ledgerRoot = norm(realish(provenance));
    for (const w of writes) {
      if (inside(norm(realish(w.path)), ledgerRoot)) {
        return { ok: false, reason: `Blocked: ${w.path.replace(/\\/g, '/')} is Mycelink's provenance ledger (${w.action}): only Mycelink's hooks and core write it — what it records is who changed what.` };
      }
    }
  }
  if (role === 'controller' && gates.length > 0) {
    const g = gates[0] as { action: string; node: string | null };
    return {
      ok: false,
      reason: `Blocked: the Mycelink controller does not run a worker's gate (${g.action}${g.node ? ` for ${g.node}` : ''}): gates record the worker's evidence. Dispatch the node to a mycelink:module-worker and let it run its gates.`,
    };
  }
  if (role === 'worker' && hostOnly !== null) {
    return { ok: false, reason: `Blocked: a module-worker never runs ${hostOnly}: the host settles, dispatches and delivers. Write your result to its file and stop.` };
  }
  if (role === 'worker' && stashes.length > 0) {
    const refused = workerStashRefusal(stashes, input, roots);
    if (refused !== null) return { ok: false, reason: refused };
  }
  for (const w of writes) {
    const path = norm(realish(w.path));
    for (const f of fenced) {
      const zone = zoneOf(path, f);
      if (zone === null) continue;
      if (role === 'worker' && zone === 'worktree') {
        // A RED-bound test file stays byte-identical once production began (hooks/red-bound.ts).
        const refused = redBoundRefusal(f.root, path, (p) => norm(realish(p)));
        if (refused !== null) return { ok: false, reason: refused };
        continue;
      }
      if (role === 'worker' && zone === 'result slot') continue;
      const shown = w.path.replace(/\\/g, '/');
      if (role === 'worker') {
        return { ok: false, reason: `Blocked: a module-worker writes only its worktree and its result file; ${shown} is ${zone === 'repository' ? "a repository's own checkout" : `Mycelink's ${zone}`} (${w.action}).` };
      }
      const what =
        zone === 'result slot'
          ? "a worker's result slot: only the worker that holds the claim writes its result (and corrects its criterion evidence); you settle it"
          : zone === 'worktree'
            ? "a worker's worktree: product code is the module-worker's"
            : zone === 'repository'
              ? 'a registered repository: product code is changed by module-workers and delivered by Mycelink'
              : zone === 'evidence'
                ? "a feature's evidence, state or approved criteria: only Mycelink writes them"
                : "Mycelink's scratch area";
      return {
        ok: false,
        reason: `Blocked: the Mycelink controller never writes ${what}. ${shown} (${w.action}). Inspect with reads; dispatch or rework the node so a mycelink:module-worker changes it.`,
      };
    }
  }
  if (role === 'controller') {
    const refused = controllerWorkspaceRefusal(writes, fenced, env);
    if (refused !== null) return { ok: false, reason: refused };
  }
  return { ok: true };
}

/** Stash subcommands that take an entry: a worker's only on its own. */
const STASH_TAKES: ReadonlySet<string> = new Set(['pop', 'apply', 'drop']);
/** Stash subcommands never a worker's, and why. */
const STASH_NEVER: Readonly<Record<string, string>> = {
  clear: "it drops every worktree's entries, the user's included",
  store: 'it puts an arbitrary commit into the shared stash',
  branch: 'it makes a branch outside the claim',
};

/** The entry a stash command names (`stash@{N}`, `N`, an object id; none: the newest), or null when it names none the fence can read. */
function stashEntryNamed(repoPath: string, name: string | null): StashEntry | null {
  const entries = stashEntries(repoPath);
  if (name === null) return entries[0] ?? null;
  const n = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(name);
  if (n !== null) return entries[Number(n[1] ?? n[2])] ?? null;
  if (/^[0-9a-f]{7,64}$/.test(name)) return entries.find((e) => e.sha.startsWith(name)) ?? null;
  return null;
}

/**
 * CSET-203 r12: every worktree of a repository shares one stash. A worker
 * may set its edits aside and read the stash; it pops, applies or drops only
 * an entry its own worktree made (git/stash.ts madeOnBranch: on its claim's
 * branch, from a commit of it), in its own worktree, so two workers never
 * take each other's work, nor the user's; it never clears the stash, stores
 * a commit in it or branches from it. Null when every stash command passes.
 */
function workerStashRefusal(stashes: ShellWrites['stashes'], input: FenceInput, roots: readonly string[]): string | null {
  for (const st of stashes) {
    const never = STASH_NEVER[st.sub];
    if (never !== undefined) return `Blocked: a module-worker never runs git stash ${st.sub}: ${never}. The stash is shared by every worktree of the repository; commit your work, or pop your own entry by name.`;
    if (!STASH_TAKES.has(st.sub)) continue;
    const { binding, problem } = workerBinding(input, roots);
    if (binding === null) {
      return `Blocked: the Mycelink fence cannot tell which worktree is this worker's (${problem}), so it cannot tell whose stash entry git stash ${st.sub} would take: the stash is shared by every worktree. Keep your edits in the working tree or commit them; if you cannot go on, write your result with outcome RETRYABLE.`;
    }
    const shown = binding.worktree.replace(/\\/g, '/');
    if (st.path === null || !inside(norm(realish(st.path)), norm(realish(binding.worktree)))) return `Blocked: a module-worker takes stash entries only in its own worktree (${shown}); this git stash ${st.sub} runs elsewhere.`;
    const label = st.entry ?? 'stash@{0}';
    const entry = stashEntryNamed(binding.repo_path, st.entry);
    if (entry === null) return `Blocked: ${label} names no stash entry the Mycelink fence can read; name your own entry as stash@{N} (git -C "${shown}" stash list).`;
    if (!madeOnBranch(binding.repo_path, entry, binding.branch)) {
      return `Blocked: ${label} (${entry.subject.slice(0, 80)}) is not an entry your worktree made: the stash is shared by every worktree of this repository, and by the user. Pop, apply or drop only your own, by name: stash@{N} from git -C "${shown}" stash list — yours read "On ${binding.branch}:" or "WIP on ${binding.branch}:".`;
    }
  }
  return null;
}

/** A feature's documents the controller writes itself (beside its directory); names as paths are compared (folded on Windows). */
const AUTHORED = new Set(['PRD.md', 'PLAN.md', 'PORTFOLIO-GRAPH.yaml', 'e2e'].map(fold));
/** A control repository's approved inputs and configuration. */
const INPUTS = new Set(['requirements', 'repositories.yaml', 'mycelink.config.json', '.claude', 'CLAUDE.md', '.gitignore', 'README.md'].map(fold));
/** Git commands the controller runs in its control repository. */
const CONTROL_GIT = new Set(['git add', 'git commit']);

/**
 * CSET-203 r9: inside a Mycelink workspace — a control repository, and the
 * project directory that holds one — the controller writes its own
 * documents (a feature's directory, PRD, plan, graph and E2E scenarios;
 * contracts; handoffs) and commits the control repository, nothing else: a
 * helper or scratch file goes under $TMPDIR. Code whose writes the reader
 * cannot place may write anywhere: refused. (The fenced zones — product code,
 * worktrees, result slots, evidence, Mycelink's scratch area — were judged
 * before this.) Null when every write passes.
 */
function controllerWorkspaceRefusal(writes: readonly { action: string; path: string; unknown?: true }[], fenced: readonly Fenced[], env: NodeJS.ProcessEnv): string | null {
  const projectDir = env['CLAUDE_PROJECT_DIR'];
  const project = typeof projectDir === 'string' && isAbsolute(projectDir) ? norm(realish(projectDir)) : null;
  // The project directory is the workspace when a control repository is at, in or around it.
  const boundary = project !== null && fenced.some((f) => inside(f.root, project) || inside(project, f.root)) ? project : null;
  const scratch = (shown: string, action: string): string =>
    `Blocked: in a Mycelink workspace the controller writes only its own documents (a feature's PRD, plan, graph and E2E scenarios, contracts, handoffs) and commits the control repository; ${shown} (${action}) is neither. Put a helper or scratch file under $TMPDIR, outside the workspace, and let Mycelink write its own files.`;
  for (const w of writes) {
    if (w.unknown) {
      return `Blocked: the Mycelink fence cannot tell where this code writes (${w.action}): in a Mycelink workspace the controller's code writes only paths it names literally — its own documents, or a scratch file under $TMPDIR. Name the files it writes, or use the Write tool for a PRD or graph.`;
    }
    const path = norm(realish(w.path));
    const shown = w.path.replace(/\\/g, '/');
    const f = fenced.find((x) => inside(path, x.root));
    if (f !== undefined) {
      const rel = path === f.root ? '' : path.slice(f.root.length + 1);
      const p = rel === '' ? [] : rel.split('/');
      if (rel === '' || p[0] === '.git') {
        if (rel === '' && CONTROL_GIT.has(w.action)) continue;
        return `Blocked: the control repository's Git state is the controller's through git add and git commit only; ${shown} (${w.action}) would rewrite what Mycelink keeps there. Commit with git add and git commit, nothing else.`;
      }
      if ((p[0] === 'features' && (p.length <= 2 || AUTHORED.has(p[2] as string))) || p[0] === 'contracts' || p[0] === 'handoffs') continue;
      if (p[0] === 'features') return `Blocked: the Mycelink controller never writes ${shown} (${w.action}): a feature's state, records and decisions are Mycelink's — only Mycelink writes them. Inspect with reads; run Mycelink's command for it.`;
      if (INPUTS.has(p[0] as string)) return `Blocked: ${shown} (${w.action}) is one of the control repository's approved inputs or its configuration, never the controller's to change. Inspect with reads; ask the operator for a change.`;
      return scratch(shown, w.action);
    }
    if (boundary !== null && inside(path, boundary)) return scratch(shown, w.action);
  }
  return null;
}

