/**
 * Which actor's call changed the shared Git state (CSET-203 r12).
 *
 * A module-worker's `git stash` in its own worktree moves `refs/stash` in
 * the repository's common Git directory, which every worktree shares; with
 * no record of whose call moved it, an operator (the benchmark's
 * controller-session transaction) cannot tell the worker's legitimate stash
 * from the controller's own. With MYCELINK_PROVENANCE naming the ledger
 * directory, the plugin's hooks therefore record, in `<dir>/calls.jsonl`:
 *
 *  - `call-start`, just before a Bash call runs (PreToolUse, once the fence
 *    allowed it), and `call-end` after it (PostToolUse, PostToolUseFailure):
 *    the session, the subagent (id and type) and its role, the tool use id,
 *    the command's SHA-256 (never the command), whether it runs in the
 *    background, the hook's process, its parent and (Linux) the session's
 *    Claude Code process by identity, wall-clock and monotonic times, and
 *    the shared Git state of every registered repository as it stood
 *    (GitObservation: its refs, per-worktree refs included, the stash's
 *    reflog with its bytes kept beside the ledger, each worktree's HEAD);
 *  - for a module-worker's call, the claim it was launched for — found from
 *    Claude Code's own record of the subagent (its meta names the Agent
 *    call that launched it) and the launch record the fence wrote at that
 *    Agent call (hooks/provider-binding.ts), checked against the feature's
 *    live claim: its worktree, branch, repository and common Git directory
 *    (WorkerBinding). A worker whose binding cannot be found is recorded as
 *    bound to nothing, and why;
 *  - `agent-start` at the host's Agent call for a module-worker, and
 *    `agent-end` when a subagent stops (SubagentStop) or a foreground Agent
 *    call ends: after it, nothing that worker started is its own.
 *
 * Nothing here decides anything, and nothing is recorded outside a Mycelink
 * workspace or without the ledger. The order of the file is the order the
 * hooks ran in.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { controlRoots, MODULE_WORKER, type FenceInput } from './fence.js';
import { workerBinding } from './worker-binding.js';
export { workerBinding, type WorkerBinding } from './worker-binding.js';
import { loadRepositories } from '../workspace/workspace.js';
import { commonDirOf } from '../git/stash.js';
import { PROVENANCE_ENV, MAX_KEPT_BYTES, unrecorded } from '../state/provenance.js';
import { sessionHolder } from '../util/process-identity.js';

export const CALLS_SCHEMA = 'mycelink-calls/1';
export const CALLS_FILE = 'calls.jsonl';

const DISPATCH_LINE = /^Dispatch: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** One repository's shared Git state at an instant. */
export interface GitObservation {
  /** Packed refs overlaid by loose ones; a worktree's own refs as `worktrees/<name>/refs/...`. */
  refs: Record<string, string>;
  /** The stash's reflog: one line per entry, its bytes kept beside the ledger; null when there is none. */
  stash_log: { sha256: string; size: number; kept: boolean } | null;
  /** Each linked worktree's HEAD (by its admin directory's name), and the main checkout's as `.`. */
  heads: Record<string, string>;
}

type Role = 'worker' | 'reviewer' | 'controller';

/** The ledger directory, when MYCELINK_PROVENANCE names one. */
function ledgerDir(env: NodeJS.ProcessEnv): string | null {
  const dir = env[PROVENANCE_ENV];
  return typeof dir === 'string' && dir !== '' && isAbsolute(dir) ? resolve(dir) : null;
}

/** Wall-clock nanoseconds, as the provenance ledger writes them. */
function now(): string {
  return (BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n).toString();
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Keep bytes beside the ledger, once per digest (the provenance ledger's object layout). */
function keep(dir: string, bytes: Buffer): { sha256: string; kept: boolean } {
  const sha = sha256(bytes);
  if (bytes.length > MAX_KEPT_BYTES) return { sha256: sha, kept: false };
  const target = join(dir, 'objects', sha.slice(0, 2), sha);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, bytes, { flag: 'wx' });
    renameSync(tmp, target);
  }
  return { sha256: sha, kept: true };
}

/** Loose refs under `dir` (a ref file holds an object id or `ref: <name>`), named from `prefix`. */
function looseRefs(dir: string, prefix: string, out: Record<string, string>): void {
  for (const name of list(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) looseRefs(p, `${prefix}/${name}`, out);
    else if (st.isFile() && !name.endsWith('.lock')) {
      try {
        const text = readFileSync(p, 'utf8').trim();
        if (OID.test(text) || /^ref: \S+$/.test(text)) out[`${prefix}/${name}`] = text;
      } catch {
        // gone meanwhile
      }
    }
  }
}

/** One common Git directory's shared state, read from its files (no git runs), the stash reflog's bytes kept in `objects`. */
export function observeGit(common: string, objects: string): GitObservation {
  return unrecorded(() => {
    const refs: Record<string, string> = {};
    try {
      for (const line of readFileSync(join(common, 'packed-refs'), 'utf8').split('\n')) {
        const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\S+)$/.exec(line);
        if (m) refs[m[2] as string] = m[1] as string;
      }
    } catch {
      // no packed refs
    }
    looseRefs(join(common, 'refs'), 'refs', refs);
    const heads: Record<string, string> = {};
    try {
      heads['.'] = readFileSync(join(common, 'HEAD'), 'utf8').trim();
    } catch {
      // a bare or broken repository
    }
    for (const name of list(join(common, 'worktrees'))) {
      looseRefs(join(common, 'worktrees', name, 'refs'), `worktrees/${name}/refs`, refs);
      try {
        heads[name] = readFileSync(join(common, 'worktrees', name, 'HEAD'), 'utf8').trim();
      } catch {
        // half made or half removed
      }
    }
    let stash_log: GitObservation['stash_log'] = null;
    try {
      const bytes = readFileSync(join(common, 'logs', 'refs', 'stash'));
      stash_log = { ...keep(objects, bytes), size: bytes.length };
    } catch {
      stash_log = null;
    }
    return { refs, stash_log, heads };
  });
}

/** Every registered repository's common Git directory, in every control repository near the call. */
function commonDirs(roots: readonly string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    try {
      for (const r of loadRepositories(root).repositories) {
        const common = commonDirOf(resolve(root, r.path));
        if (common !== null) out.add(resolve(common));
      }
    } catch {
      // an unreadable registry names nothing
    }
  }
  return [...out].sort();
}

function rootsOf(call: Pick<FenceInput, 'cwd'>, env: NodeJS.ProcessEnv): string[] {
  return controlRoots([typeof call.cwd === 'string' ? call.cwd : undefined, env['CLAUDE_PROJECT_DIR'], env['MYCELINK_CONTROL_ROOT']], []);
}

/** Who ran the hook: its process, its parent, and (on Linux, by identity) the session's Claude Code process. */
function processOf(env: NodeJS.ProcessEnv): Record<string, unknown> {
  let holder = null;
  if (process.platform === 'linux') {
    try {
      holder = sessionHolder(env);
    } catch {
      holder = null;
    }
  }
  return { pid: process.pid, ppid: process.ppid, holder };
}

function observeAll(roots: readonly string[], dir: string): { git: Record<string, GitObservation>; git_error?: string } {
  const git: Record<string, GitObservation> = {};
  try {
    for (const common of commonDirs(roots)) git[common] = observeGit(common, dir);
    return { git };
  } catch (err) {
    return { git, git_error: err instanceof Error ? err.message.slice(0, 300) : 'error' };
  }
}

function append(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, CALLS_FILE), `${JSON.stringify({ schema: CALLS_SCHEMA, ...record })}\n`);
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Just before a call the fence allowed runs: a Bash call's start (its role,
 * a worker's binding, the shared Git state), or the host's launch of a
 * module-worker. Throws only when the ledger cannot be written.
 */
export function recordCallStart(call: FenceInput, role: Role, env: NodeJS.ProcessEnv = process.env): void {
  const dir = ledgerDir(env);
  if (dir === null) return;
  const tool = call.tool_name ?? '';
  const input = call.tool_input ?? {};
  if (tool !== 'Bash' && tool !== 'Agent' && tool !== 'Task') return;
  const roots = rootsOf(call, env);
  if (roots.length === 0) return;
  const base = { session_id: strOrNull(call.session_id), tool, tool_use_id: strOrNull(call.tool_use_id), t: now(), t_mono: process.hrtime.bigint().toString(), ...processOf(env) };
  if (tool !== 'Bash') {
    const type = String(input['subagent_type'] ?? '');
    if (strOrNull(call.agent_id) !== null || (type !== MODULE_WORKER && type !== 'module-worker')) return;
    const prompt = typeof input['prompt'] === 'string' ? (input['prompt'] as string) : '';
    append(dir, { kind: 'agent-start', ...base, subagent_type: type, prompt_sha256: sha256(prompt), dispatch_id: DISPATCH_LINE.exec(prompt)?.[1] ?? null, background: input['run_in_background'] === true });
    return;
  }
  const bound = role === 'worker' ? workerBinding(call, roots) : { binding: null, problem: null };
  append(dir, {
    kind: 'call-start',
    ...base,
    agent_id: strOrNull(call.agent_id),
    agent_type: strOrNull(call.agent_type),
    role,
    command_sha256: sha256(String(input['command'] ?? '')),
    background: input['run_in_background'] === true,
    cwd: typeof call.cwd === 'string' ? call.cwd : null,
    // Where Claude Code keeps the session's records: the subagent's own transcript, which shows this call, is beside it.
    transcript_path: strOrNull(call.transcript_path),
    worker: bound.binding,
    ...(bound.problem !== null ? { worker_problem: bound.problem } : {}),
    ...observeAll(roots, dir),
  });
}

/** After a call (PostToolUse, PostToolUseFailure): a Bash call's end with the shared Git state, or a foreground Agent call's end. Never throws. */
export function recordCallEnd(call: FenceInput & { hook_event_name?: string; tool_response?: unknown; is_interrupt?: boolean }, role: Role, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = ledgerDir(env);
    if (dir === null) return;
    const tool = call.tool_name ?? '';
    if (tool !== 'Bash' && tool !== 'Agent' && tool !== 'Task') return;
    const roots = rootsOf(call, env);
    if (roots.length === 0) return;
    const base = { event: strOrNull(call.hook_event_name), session_id: strOrNull(call.session_id), tool, tool_use_id: strOrNull(call.tool_use_id), agent_id: strOrNull(call.agent_id), agent_type: strOrNull(call.agent_type), t: now(), t_mono: process.hrtime.bigint().toString(), ...processOf(env) };
    if (tool !== 'Bash') {
      if (base.agent_id !== null) return;
      // An asynchronous launch ends at once: its worker's end is its SubagentStop.
      const response = JSON.stringify(call.tool_response ?? null);
      const async = /async_launched|Async agent launched/.test(response);
      append(dir, { kind: 'agent-end', ...base, subagent_type: strOrNull((call.tool_input ?? {})['subagent_type']), async, ...(async ? {} : observeAll(roots, dir)) });
      return;
    }
    append(dir, { kind: 'call-end', ...base, role, ...(call.is_interrupt === true ? { interrupted: true } : {}), ...observeAll(roots, dir) });
  } catch {
    // a call's end nothing could record: it stays open, which attributes nothing more to it
  }
}

/** A subagent stopped (SubagentStop): nothing it started from now on is its own. Never throws. */
export function recordAgentEnd(call: FenceInput & { hook_event_name?: string }, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = ledgerDir(env);
    const roots = dir === null ? [] : rootsOf(call, env);
    if (dir === null || roots.length === 0) return;
    // The shared Git state as the subagent stopped: what changes after it is no longer its own.
    append(dir, { kind: 'agent-end', event: strOrNull(call.hook_event_name) ?? 'SubagentStop', session_id: strOrNull(call.session_id), agent_id: strOrNull(call.agent_id), agent_type: strOrNull(call.agent_type), t: now(), t_mono: process.hrtime.bigint().toString(), ...processOf(env), ...observeAll(roots, dir) });
  } catch {
    // nothing could be recorded
  }
}
