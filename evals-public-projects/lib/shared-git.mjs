/**
 * Who changed a repository's shared stash during a controller session
 * (CSET-203 r12; CSET-202 final).
 *
 * Every worktree of a repository shares `refs/stash` and its reflog (one
 * line per stash entry) in the common Git directory. r12's module-worker ran
 * `git stash` in its own worktree, and the session's transaction, seeing the
 * shared ref move with nothing to say whose call moved it, took it for the
 * controller's and rolled the whole session back. CSET-202's latest with arm
 * was stopped twice the same way though every call was on record: its host
 * sat in `sleep 100; echo waiting` while a background worker pushed and
 * popped, and any host call open meanwhile was taken for a hand in the stash.
 *
 * The plugin's hooks record every Bash call of every actor before and after
 * it runs, with the shared Git state as it stood (src/hooks/worker-calls.ts:
 * `calls.jsonl` beside the provenance ledger); Mycelink's core records its
 * own git commands and file writes (the provenance ledger); and the
 * session's own stream (lib/causal.mjs streamTree) shows every call under
 * the Agent call that ran it. This module follows the stash through the
 * session as a chain of custody — from the state before the session,
 * through every state an observation or the core recorded, to the state
 * after it — and attributes each transition, one by one (a transient entry
 * pushed and popped is two transitions, each judged; an unchanged end proves
 * nothing). A transition happened between two observations; the calls open
 * then are its possible causes, each placed in the causal tree by what the
 * stream, the hooks and Claude Code's own records agree on (actorOf):
 *
 *  - a host or other subagent call is a cause only when what it runs may
 *    change anything (shellEffects): waiting, printing, reading and looking
 *    at Git change nothing, whatever they overlap — and a call no stream
 *    shows, or shows otherwise, may have done anything;
 *  - a module-worker's call, shown under its own Agent call (whose task the
 *    hooks' subagent is, whose prompt names the claim its binding holds, and
 *    whose own transcript shows the call), makes an entry its worktree made —
 *    what Git wrote into the entry's commit: `WIP on <its branch>:` / `On
 *    <its branch>:`, its first parent on that branch as the observations saw
 *    it — only by a `git stash push` it runs in that worktree, and takes one
 *    its worktree made only by a `git stash pop`/`drop` it runs there, each
 *    command counted once;
 *  - the core's, when the core's ledger records exactly it.
 *
 * A transition is then the core's, or its worker's — when nothing else
 * running may have made it and no other worker's stash command could have —
 * or nobody's but the controller's. Its failure says how sure that is:
 * `controller` (a host call that may change it, no cause running at all, an
 * entry no running worker's worktree made, an entry taken that no running
 * worker owns, a forged or bare ref) stops a session while it runs;
 * `unestablished` (a worker's own stash its commands do not show, two
 * workers' commands either of which may have made it, a worker call no
 * stream or binding vouches for) and `pending` (a call the stream does not
 * show yet) wait for the settlement, which fails closed on anything not
 * attributed. A command line, a reflog message, a transcript or a time is
 * never taken alone as proof. What is not the workers' or the core's is
 * rolled back to the stash the authorised transitions alone would have left.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256Hex } from './hash.mjs';
import { safeGit } from './git.mjs';
import { AGENT_TOOLS, MODULE_WORKERS, aliveAt, insidePath, shellEffects } from './causal.mjs';
import { keyBytes, putObject, readObject, workspaceKey } from './snapshot.mjs';

export const CALLS_FILE = 'calls.jsonl';
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** A workspace key for an absolute path inside the workspace, however it is spelled; null outside it. */
const keyOf = workspaceKey;

// ---- the call ledger --------------------------------------------------------------

/** Where the call ledger stands: its size and the digest of what it holds. */
export function callsMark(ledgerDir) {
  let bytes = Buffer.alloc(0);
  try {
    bytes = readFileSync(join(ledgerDir, CALLS_FILE));
  } catch {
    // none yet
  }
  return { offset: bytes.length, prefix_sha256: sha256Hex(bytes) };
}

/** The call records the session appended, trusted only while what the ledger held before is still exactly there. */
export function sessionCalls({ ledgerDir, mark }) {
  if (!mark) return { intact: true, records: [], problems: ['no call ledger mark: the session predates it'] };
  let bytes = Buffer.alloc(0);
  try {
    bytes = readFileSync(join(ledgerDir, CALLS_FILE));
  } catch {
    bytes = Buffer.alloc(0);
  }
  const intact = bytes.length >= mark.offset && sha256Hex(bytes.subarray(0, mark.offset)) === mark.prefix_sha256;
  const records = [];
  const problems = [];
  if (!intact) problems.push('the call ledger no longer holds what it held before the session');
  else {
    const lines = bytes.subarray(mark.offset).toString('utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      if (line === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        problems.push(i === lines.length - 1 ? 'a last call record cut short' : `call record ${i + 1} is not a record`);
      }
    }
  }
  return { intact, records, problems };
}

/**
 * The session's calls: each Bash call by its tool use id with where its
 * start and end are in the ledger, its role and binding; when each worker's
 * Agent call ended; and every observation of the shared Git state, in order.
 */
export function callIndex(records, workspace) {
  const calls = new Map();
  const agentEnds = [];
  const observations = [];
  for (const [pos, r] of records.entries()) {
    if (r.kind === 'call-start' && typeof r.tool_use_id === 'string') {
      // A call starts once: a second start for its id is a record no hook made for it.
      const was = calls.get(r.tool_use_id);
      if (was) was.forged = true;
      else calls.set(r.tool_use_id, { id: r.tool_use_id, startPos: pos, endPos: null, start: r, end: null, role: r.role ?? 'controller', worker: r.worker ?? null, agent: r.agent_id ?? null, background: r.background === true, forged: false });
    } else if (r.kind === 'call-end' && typeof r.tool_use_id === 'string') {
      const c = calls.get(r.tool_use_id);
      if (c && c.endPos === null) {
        c.endPos = pos;
        c.end = r;
      }
    } else if (r.kind === 'agent-end' && !(r.async === true)) {
      agentEnds.push({ pos, agent: r.agent_id ?? null, launch: r.tool_use_id ?? null });
    }
    if ((r.kind === 'call-start' || r.kind === 'call-end' || r.kind === 'agent-end') && r.git && typeof r.git === 'object') {
      const byKey = new Map();
      for (const [abs, o] of Object.entries(r.git)) {
        const k = keyOf(workspace, resolve(abs));
        if (k !== null) byKey.set(k, o);
      }
      observations.push({ pos, t: BigInt(r.t ?? '0'), call: r.tool_use_id, kind: r.kind, git: byKey });
    }
  }
  // Where each call stops counting as running: its end, or, for a worker's, its subagent's next stop if sooner (a subagent
  // resumed by SendMessage stops again); a background call goes on. A call started after its subagent stopped is judged by
  // the stream: it is the subagent's only if the stream shows it resumed (shared-git actorOf).
  for (const c of calls.values()) {
    const agentEnd = c.role === 'worker' ? agentEnds.find((e) => e.pos > c.startPos && ((c.agent !== null && e.agent === c.agent) || (c.worker?.launch_tool_use_id && e.launch === c.worker.launch_tool_use_id))) : undefined;
    const end = c.background ? Infinity : (c.endPos ?? Infinity);
    c.effEnd = Math.min(end, agentEnd?.pos ?? Infinity);
    c.agentEndPos = agentEnd?.pos ?? null;
  }
  return { calls: [...calls.values()], observations, agentEnds };
}

// ---- the stash --------------------------------------------------------------------

/** A reflog's lines (latin1 keeps their exact bytes), oldest first. */
export function linesOf(bytes) {
  const out = [];
  if (!bytes) return out;
  let at = 0;
  while (at < bytes.length) {
    const nl = bytes.indexOf(0x0a, at);
    const end = nl < 0 ? bytes.length : nl;
    if (end > at) out.push(bytes.subarray(at, end).toString('latin1'));
    at = end + 1;
  }
  return out;
}
const bytesOf = (lines) => Buffer.from(lines.map((l) => `${l}\n`).join(''), 'latin1');
const newOf = (line) => line.split(' ')[1] ?? null;
const topOf = (lines) => (lines.length ? newOf(lines[lines.length - 1]) : null);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Bytes the provenance ledger kept, checked against their digest. */
function readKept(ledgerDir, sha) {
  try {
    const bytes = readFileSync(join(ledgerDir, 'objects', sha.slice(0, 2), sha));
    return sha256Hex(bytes) === sha ? bytes : null;
  } catch {
    return null;
  }
}

/** A stash commit as Git wrote it: its first parent and subject (cached per repository). */
function stashCommit(gitAbs, sha, cache) {
  const k = `${gitAbs}\0${sha}`;
  if (cache.has(k)) return cache.get(k);
  let v = null;
  if (OID.test(sha)) {
    const r = safeGit(dirname(gitAbs), ['--git-dir', gitAbs, 'log', '-1', '--format=%P%x00%s', sha]);
    if (r.code === 0) {
      const [parents, subject] = String(r.stdout).split('\0');
      v = { parent: (parents ?? '').trim().split(' ')[0] || null, subject: (subject ?? '').trim() };
    }
  }
  cache.set(k, v);
  return v;
}

function isAncestor(gitAbs, a, b) {
  return OID.test(a) && OID.test(b) && safeGit(dirname(gitAbs), ['--git-dir', gitAbs, 'merge-base', '--is-ancestor', a, b]).code === 0;
}

/**
 * Whether a worker call's own transcript shows it (Claude Code's records,
 * beside the session's): the Agent call its binding names launched a
 * module-worker whose transcript holds this Bash call, with this command, on
 * a line of that subagent (its `agentId`, and its `attributionAgent` when
 * Claude Code names one).
 */
function corroborated(call, cache) {
  const s = call.start;
  if (typeof s.transcript_path !== 'string' || typeof s.session_id !== 'string' || typeof s.agent_id !== 'string') return false;
  if (basename(s.transcript_path) !== `${s.session_id}.jsonl` || !/^[A-Za-z0-9_-]{1,128}$/.test(s.agent_id)) return false;
  const dir = join(dirname(s.transcript_path), s.session_id, 'subagents');
  const read = (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, readFileSync(file, 'utf8'));
      } catch {
        cache.set(file, null);
      }
    }
    return cache.get(file);
  };
  let meta;
  try {
    meta = JSON.parse(read(join(dir, `agent-${s.agent_id}.meta.json`)) ?? 'null');
  } catch {
    meta = null;
  }
  if (!meta || !MODULE_WORKERS.has(meta.agentType) || meta.toolUseId !== call.worker?.launch_tool_use_id) return false;
  const text = read(join(dir, `agent-${s.agent_id}.jsonl`));
  if (text === null) return false;
  for (const line of text.split('\n')) {
    if (!line.includes(call.id)) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e?.agentId === 'string' && e.agentId !== s.agent_id) continue;
    if (typeof e?.attributionAgent === 'string' && !MODULE_WORKERS.has(e.attributionAgent)) continue;
    for (const c of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (c?.type === 'tool_use' && c.id === call.id && c.name === 'Bash' && createHash('sha256').update(String(c.input?.command ?? '')).digest('hex') === s.command_sha256) return true;
    }
  }
  return false;
}

const DISPATCH_LINE = /^Dispatch: (\S+)\s*$/m;
const CLAIM_LINE = /^Claim: (\S+)\s*$/m;

/**
 * The session's causal context for its calls (CSET-202 final): the stream's
 * tree (lib/causal.mjs streamTree; null when there is no stream to read),
 * which subagents the hooks name under each Agent call and under which
 * Agent calls each subagent's calls ran, the session's HOME, and the sealed
 * plugin's CLI scripts (whose changes Mycelink's ledger records). One per
 * classification: what actorOf decides of a call is kept in it.
 */
export function causalContext({ tree = null, index, home = null, mycelink = [] }) {
  const agentsOf = new Map();
  const launchesOf = new Map();
  if (tree !== null) {
    for (const c of index.calls) {
      const agent = typeof c.start.agent_id === 'string' && c.start.agent_id !== '' ? c.start.agent_id : null;
      const use = tree.uses.get(c.id);
      if (agent === null || !use || use.parent === null) continue;
      if (!agentsOf.has(use.parent)) agentsOf.set(use.parent, new Set());
      agentsOf.get(use.parent).add(agent);
      if (!launchesOf.has(agent)) launchesOf.set(agent, new Set());
      launchesOf.get(agent).add(use.parent);
    }
  }
  return { tree, home, mycelink, agentsOf, launchesOf, actors: new Map(), transcripts: new Map() };
}

/**
 * Who ran a call, where the causal tree places it, and what it may change:
 * `{ kind: 'host' | 'subagent' | 'worker', effects, binding? }` when the
 * stream, the hooks and Claude Code's own records agree — the stream shows
 * the call, with the command the hook hashed, under the Agent call it ran
 * under (none for the host's); that Agent call's task is the subagent the
 * hook names, and no other's; a module-worker's binding names that very
 * Agent call, whose prompt names the claim and dispatch the binding holds,
 * and (at the settlement) its own transcript shows the call. Else `{ kind:
 * 'unknown', why }` — or, while the session runs, `{ kind: 'pending' }` for
 * a call the stream does not show yet. `who`: what its hook says it is.
 */
function actorOf(c, ctx, { live, corroborate }) {
  const memo = `${c.id}\0${live}\0${corroborate}`;
  if (ctx.actors.has(memo)) return ctx.actors.get(memo);
  const a = resolveActor(c, ctx, { live, corroborate });
  ctx.actors.set(memo, a);
  return a;
}

function resolveActor(c, ctx, { live, corroborate }) {
  const s = c.start;
  const hookAgent = typeof s.agent_id === 'string' && s.agent_id !== '' ? s.agent_id : null;
  const who = c.role === 'worker' ? 'worker' : hookAgent !== null ? 'subagent' : 'host';
  const unknown = (why) => ({ kind: 'unknown', who, why });
  if (c.forged) return unknown('the call ledger records its start twice');
  const tree = ctx.tree;
  if (tree === null) return unknown('no stream of the session shows its calls');
  const use = tree.uses.get(c.id);
  if (!use) return live ? { kind: 'pending', who, why: `the session’s stream does not show ${c.id} yet` } : unknown(`the session’s stream shows no call ${c.id}`);
  if (use.conflict) return unknown(`the session’s stream shows ${c.id} twice, differently`);
  if (use.name !== 'Bash') return unknown(`the session’s stream shows ${c.id} as a ${use.name} call`);
  const command = typeof use.input.command === 'string' ? use.input.command : '';
  if (createHash('sha256').update(command).digest('hex') !== s.command_sha256) return unknown('the stream shows another command');
  if (tree.session !== null && typeof s.session_id === 'string' && s.session_id !== tree.session) return unknown(`a call of another session (${s.session_id})`);
  const effects = shellEffects(command, { cwd: typeof s.cwd === 'string' ? s.cwd : null, home: ctx.home, mycelink: ctx.mycelink });
  if (use.parent === null) {
    if (hookAgent !== null || c.role === 'worker') return unknown(`the stream shows the host’s call; its hook names a subagent (${hookAgent ?? c.role})`);
    return { kind: 'host', who, effects };
  }
  const launch = tree.uses.get(use.parent);
  if (!launch || !AGENT_TOOLS.has(launch.name)) return unknown(`the stream runs it under ${use.parent}, which is no Agent call`);
  if (launch.conflict) return unknown(`the session’s stream shows the Agent call ${launch.id} twice, differently`);
  if (hookAgent === null) return unknown(`the stream runs it under the Agent call ${launch.id}; its hook names no subagent`);
  const task = tree.tasks.get(launch.id);
  if (task?.conflict) return unknown(`the Agent call ${launch.id} started two tasks`);
  if (task && task.task !== hookAgent) return unknown(`the Agent call ${launch.id} started ${task.task}, not ${hookAgent}`);
  if ((ctx.agentsOf.get(launch.id)?.size ?? 0) > 1) return unknown(`the hooks name more than one subagent under the Agent call ${launch.id}`);
  if ((ctx.launchesOf.get(hookAgent)?.size ?? 0) > 1) return unknown(`the hooks name ${hookAgent} under more than one Agent call`);
  if (!MODULE_WORKERS.has(String(launch.input.subagent_type ?? ''))) {
    if (c.role === 'worker') return unknown(`its hook names a module-worker; the stream runs it under a ${String(launch.input.subagent_type ?? 'subagent')}`);
    return { kind: 'subagent', who, effects };
  }
  if (c.role !== 'worker') return unknown('a module-worker’s call its hook did not record as one');
  const b = c.worker;
  if (b === null) return unknown(`bound to no claim (${s.worker_problem ?? 'unknown'})`);
  if (b.launch_tool_use_id !== launch.id) return unknown(`the stream runs it under the Agent call ${launch.id}, not the one its binding names (${b.launch_tool_use_id})`);
  if (launch.parent !== null) return unknown(`its Agent call ${launch.id} was made by a subagent, not the host`);
  // A late child: the stream shows it after its subagent stopped, with no SendMessage resuming it since.
  if (!aliveAt(tree, launch, hookAgent, use.line)) return unknown(`the stream shows it after ${hookAgent} stopped, and no resume since`);
  const prompt = typeof launch.input.prompt === 'string' ? launch.input.prompt : '';
  const claim = CLAIM_LINE.exec(prompt)?.[1] ?? null;
  if ((DISPATCH_LINE.exec(prompt)?.[1] ?? null) !== (b.dispatch_id ?? null) || (claim !== null && claim !== b.claim_id)) return unknown(`its Agent call ${launch.id} launched another claim than the one its binding holds`);
  if (corroborate && !corroborated(c, ctx.transcripts)) return unknown(`the worker’s own transcript does not show the call ${c.id}`);
  return { kind: 'worker', who, effects, binding: b };
}

/** How a failed transition's reason names a call that may have caused it, by what the call's hook said it was. */
const CAUSE = { host: 'a host call that may change it', subagent: 'a subagent call that may change it', worker: 'a worker call not borne out as its worker’s' };

/**
 * Follow one repository's stash (`git`, a workspace key of its common Git
 * directory) through the session; see the module comment. `ledger`: the
 * provenance ledger's directory and its session records; `index`: the
 * session's callIndex; `causal`: its causalContext. `asOf` (ns; a check
 * while the session runs): a state observed or recorded from then on is the
 * settlement's to judge — the stash is then `concurrent`; a call the stream
 * does not show yet leaves its transitions `pending`. `corroborate`: check
 * each worker call against its own transcript (the settlement does; a check
 * while it runs may not find the call written yet). `reached`: workspace
 * keys the controller's own calls wrote (lib/transcripts.mjs): one in this
 * repository's stash makes every transition of it the controller's.
 *
 * Returns null when the stash did not change, else `{ git, ref: 'refs/stash',
 * pre, post, pre_log, post_log, transitions, verdict ('authorized' |
 * 'unauthorized' | 'pending' (while the session runs: nothing a check may
 * stop it for, yet not attributed) | 'concurrent'), by ('worker' | 'core' |
 * 'controller'), at (ns string: when the first unauthorised transition may
 * have happened), reasons, workers, target: { ref, log } }` — `target` the
 * stash the authorised transitions alone leave, its bytes put into `store`.
 */
export function attributeStash({ workspace, store, git, pre, post, ledger, index, asOf = null, corroborate = true, caches = {}, causal = null, reached = [] }) {
  const gitAbs = resolve(workspace, keyBytes(git).toString('utf8'));
  const commits = caches.commits ?? new Map();
  const ctx = causal ?? causalContext({ tree: null, index });
  const live = asOf !== null;
  const logOf = (snap) => {
    const s = snap.git?.[git]?.stash_log ?? null;
    if (s === null) return { sha: null, lines: [] };
    const bytes = readObject(store, s.sha256);
    return { sha: s.sha256, lines: bytes === null ? null : linesOf(bytes) };
  };
  const before = logOf(pre);
  const after = logOf(post);
  const preRef = pre.git?.[git]?.refs?.['refs/stash'] ?? null;
  const postRef = post.git?.[git]?.refs?.['refs/stash'] ?? null;
  const observed = index.observations.filter((o) => o.git.has(git));
  const changedInSession = observed.some((o) => (o.git.get(git).refs?.['refs/stash'] ?? null) !== preRef || (o.git.get(git).stash_log?.sha256 ?? null) !== before.sha);
  if (before.sha === after.sha && preRef === postRef && !changedInSession) return null;
  const base = { git, ref: 'refs/stash', pre: preRef, post: postRef, pre_log: before.sha, post_log: after.sha };
  const fail = (why) => ({ ...base, transitions: [], verdict: 'unauthorized', by: 'controller', at: '0', reasons: [why], workers: [], target: { ref: preRef, log: before.sha } });
  if (before.lines === null || after.lines === null) return fail('the stash’s reflog bytes are not in the store');
  // The hooks observe every registered repository at every call: one never observed is no repository a worker is bound to.
  if (observed.length === 0 && index.calls.length > 0) return fail('no worker is bound to this repository: no call of the session observed it');
  // The controller's own tool calls wrote this repository's stash, its reflog or its packed refs: nothing of it is anyone else's.
  const wrote = reached.find((k) => [`${git}/refs/stash`, `${git}/logs/refs/stash`, `${git}/packed-refs`].includes(k)) ?? null;

  // The timeline: observations by their place in the call ledger, and the core's own changes to the stash by time.
  const events = [];
  for (const o of observed) {
    const v = o.git.get(git);
    const sha = v.stash_log?.sha256 ?? null;
    const bytes = sha === null ? Buffer.alloc(0) : v.stash_log.kept ? readKept(ledger.dir, sha) : null;
    events.push({ type: 'obs', t: o.t, pos: o.pos, lines: bytes === null ? null : linesOf(bytes), ref: v.refs?.['refs/stash'] ?? null, branchAt: v.refs ?? {} });
  }
  // Compared by key: the ledger names the real place, the workspace may be spelled through a link.
  const logKey = keyOf(workspace, resolve(gitAbs, 'logs', 'refs', 'stash'));
  for (const r of ledger.records) {
    const t = BigInt(r.t ?? '0');
    if (r.kind === 'done') {
      for (const s of r.states ?? []) {
        if (logKey === null || keyOf(workspace, resolve(s.path)) !== logKey) continue;
        const bytes = s.state?.t === 'absent' ? Buffer.alloc(0) : s.state?.t === 'f' && s.state.kept ? readKept(ledger.dir, s.state.sha256) : null;
        events.push({ type: 'core', t, lines: bytes === null ? undefined : linesOf(bytes) });
      }
    } else if (r.kind === 'git-done' && r.common_dir && keyOf(workspace, resolve(r.common_dir)) === git && r.changed?.refs && 'refs/stash' in r.changed.refs) {
      // A ref git deletes takes its reflog with it.
      const to = r.changed.refs['refs/stash'][1] ?? null;
      events.push({ type: 'core', t, ref: to, ...(to === null ? { lines: [] } : {}) });
    }
  }
  events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : (a.pos ?? 0) - (b.pos ?? 0)));
  if (live && events.some((e) => e.t >= asOf)) return { ...base, transitions: [], verdict: 'concurrent', by: 'core-concurrent', at: '0', reasons: [], workers: [], target: { ref: postRef, log: after.sha } };

  const owners = new Map(before.lines.map((l) => [l, { kind: 'pre' }]));
  const transitions = [];
  let cur = { lines: before.lines, ref: preRef };
  let lastObs = { pos: -1, t: 0n, branchAt: {} };
  const callsIn = (a, b) => index.calls.filter((c) => c.startPos < b && c.effEnd > a);
  /** What each worker call's own stash commands may still account for: entries pushed, entries taken (each command once). */
  const budgets = new Map();
  const budgetOf = (c, w) => {
    if (!budgets.has(c.id)) {
      const own = (op) => op.dir !== null && insidePath(op.dir, w.binding.worktree);
      budgets.set(c.id, { push: w.effects.stash.filter((op) => op.sub === 'push' && own(op)).length, take: w.effects.stash.filter((op) => (op.sub === 'pop' || op.sub === 'drop') && own(op)).length });
    }
    return budgets.get(c.id);
  };
  const sameRepo = (b) => b.common_dir !== null && keyOf(workspace, resolve(b.common_dir)) === git;
  /** Whether an entry was made in a worker's worktree: on its claim's branch, from a commit of it as the observations saw the branch. */
  const madeBy = (l, b, refsFrom, refsTo) => {
    const c = stashCommit(gitAbs, newOf(l), commits);
    const m = c === null ? null : /^(?:WIP on|On) (.+?): /.exec(c.subject);
    if (m === null || m[1] !== b.branch) return false;
    const heads = [refsFrom?.[`refs/heads/${b.branch}`], refsTo?.[`refs/heads/${b.branch}`]].filter((x) => typeof x === 'string');
    return heads.some((h) => c.parent === h || isAncestor(gitAbs, c.parent, h));
  };
  /** A transition between two observations (`b` Infinity: after the last), attributed. */
  const gap = (from, to, a, b, tFrom, refsFrom, refsTo) => {
    // An entry is its commit: a line git rewrote in place (dropping the entry before it rewrites the next one's old id) is the same entry.
    const fromBy = new Map(from.lines.map((l) => [newOf(l), l]));
    const toBy = new Map(to.lines.map((l) => [newOf(l), l]));
    const added = to.lines.filter((l) => !fromBy.has(newOf(l)));
    const removed = from.lines.filter((l) => !toBy.has(newOf(l)));
    const rewrites = to.lines.filter((l) => fromBy.has(newOf(l)) && fromBy.get(newOf(l)) !== l).map((l) => ({ from: fromBy.get(newOf(l)), to: l }));
    const tr = { from_pos: a, to_pos: Number.isFinite(b) ? b : null, added: added.map(newOf), removed: removed.map(newOf), top: to.ref ?? null, by: null, worker: null, calls: [], reason: null, severity: null, at: tFrom.toString(), addedLines: added, removedLines: removed, rewrites };
    const failed = (reason, severity = 'controller') => {
      tr.reason = reason;
      tr.severity = severity;
      transitions.push(tr);
    };
    // Only git's own fixup, and only beside an entry dropped: the old id changes, nothing else of the line.
    const forged = rewrites.filter((r) => removed.length === 0 || r.from.slice(r.from.indexOf(' ')) !== r.to.slice(r.to.indexOf(' ')));
    if (forged.length > 0) return failed(`the reflog line of ${(newOf(forged[0].to) ?? '').slice(0, 12)} was rewritten`);
    for (const r of rewrites) if (owners.has(r.from)) owners.set(r.to, owners.get(r.from));
    const open = callsIn(a, b);
    tr.calls = open.map((c) => c.id);
    if ((to.ref ?? null) !== (topOf(to.lines) ?? null)) return failed(`refs/stash names ${to.ref ? to.ref.slice(0, 12) : 'nothing'}, not its reflog’s newest entry: moved without its reflog`);
    if (wrote !== null) return failed(`the controller’s own calls wrote ${wrote}`);
    // Each call open then, placed in the causal tree; one that may change anything and is no worker's is a cause the worker's account cannot exclude.
    const actors = open.map((c) => ({ c, w: actorOf(c, ctx, { live, corroborate }) }));
    const cause = actors.find(({ w }) => w.kind === 'unknown' || ((w.kind === 'host' || w.kind === 'subagent') && w.effects.changes));
    if (cause !== undefined) return failed(`${CAUSE[cause.w.who]} ran meanwhile (${cause.c.id}: ${cause.w.kind === 'unknown' ? cause.w.why : cause.w.effects.why})`, cause.w.kind === 'unknown' && cause.w.who === 'worker' ? 'unestablished' : 'controller');
    const pending = actors.find(({ w }) => w.kind === 'pending');
    if (pending !== undefined) {
      tr.pending = pending.w.why;
      transitions.push(tr);
      return;
    }
    const workers = actors.filter(({ w }) => w.kind === 'worker');
    if (workers.length === 0) return failed(open.length === 0 ? 'no call was running: a background or late process' : 'no call was running that could have made it: a background or late process');
    // Each line on its own (two workers of one repository may each push in the same span).
    const ops = (pred) => workers.flatMap(({ c, w }) => w.effects.stash.filter(pred).map((op) => ({ c, w, op })));
    const pushes = ops((op) => op.sub === 'push');
    const takes = ops((op) => op.sub === 'pop' || op.sub === 'drop');
    const nevers = ops((op) => !['push', 'pop', 'drop', 'apply', 'create'].includes(op.sub));
    const problems = [];
    const problem = (text, severity = 'unestablished') => problems.push({ text, severity });
    for (const n of nevers) problem(`the worker call ${n.c.id} runs git stash ${n.op.sub}, which no worker’s may`);
    const byLine = [];
    const nodeOf = (b) => b.node_id ?? b.claim_id;
    for (const l of added) {
      const sha = (newOf(l) ?? '').slice(0, 12);
      const makers = workers.filter(({ w }) => sameRepo(w.binding) && madeBy(l, w.binding, refsFrom, refsTo));
      const claims = new Set(makers.map(({ w }) => w.binding.claim_id));
      if (claims.size !== 1) {
        if (claims.size > 1) problem(`${sha} could be more than one worker’s`);
        else {
          const m = /^(?:WIP on|On) (.+?): /.exec(stashCommit(gitAbs, newOf(l), commits)?.subject ?? '');
          problem(`${sha} was made on ${m?.[1] ?? 'no branch'}, from a commit no running worker’s branch holds`, 'controller');
        }
        continue;
      }
      const maker = makers[0].w.binding;
      const into = (op) => op.dir === null || insidePath(op.dir, maker.worktree);
      const rival = pushes.find((p) => p.w.binding.claim_id !== maker.claim_id && into(p.op));
      if (rival !== undefined) {
        problem(`the worker call ${rival.c.id} (${nodeOf(rival.w.binding)}) may have pushed in ${nodeOf(maker)}’s worktree`);
        continue;
      }
      const own = pushes.filter((p) => p.w.binding.claim_id === maker.claim_id && p.op.dir !== null && insidePath(p.op.dir, maker.worktree));
      if (own.length === 0) {
        problem(`${sha} was made in ${nodeOf(maker)}’s worktree, but no call of ${nodeOf(maker)}’s ran git stash push in its worktree`);
        continue;
      }
      const by = own.find((p) => budgetOf(p.c, p.w).push > 0);
      if (by === undefined) {
        problem(`${nodeOf(maker)}’s calls made more entries than the git stash pushes they ran`);
        continue;
      }
      budgetOf(by.c, by.w).push -= 1;
      byLine.push({ line: l, c: by.c, b: by.w.binding });
    }
    // An entry a worker drops is its own: one it made in this session, or one its claim's worktree made before (the fence's rule too).
    for (const l of removed) {
      const sha = (newOf(l) ?? '').slice(0, 12);
      const o = owners.get(l);
      let owner = null;
      if (o?.kind === 'worker') owner = o.claim;
      else if (o?.kind === 'pre') {
        const claims = new Set(workers.filter(({ w }) => sameRepo(w.binding) && madeBy(l, w.binding, refsFrom, refsTo)).map(({ w }) => w.binding.claim_id));
        owner = claims.size === 1 ? [...claims][0] : null;
      }
      const rival = takes.find((t) => t.w.binding.claim_id !== owner);
      if (owner === null || (rival === undefined && !takes.some((t) => t.w.binding.claim_id === owner) && !workers.some(({ w }) => w.binding.claim_id === owner))) {
        problem(`it drops ${sha}, an entry ${o?.kind === 'pre' ? 'that was there before the session, not made in a running worker’s worktree' : o?.kind === 'worker' ? 'whose worker is not running' : `the ${o?.kind ?? 'unknown'} made`}`, 'controller');
        continue;
      }
      if (rival !== undefined) {
        problem(`the worker call ${rival.c.id} (${nodeOf(rival.w.binding)}) may have taken ${sha}, an entry it did not make`);
        continue;
      }
      const own = takes.filter((t) => t.w.binding.claim_id === owner && t.op.dir !== null && insidePath(t.op.dir, t.w.binding.worktree));
      const by = own.find((t) => budgetOf(t.c, t.w).take > 0);
      if (by === undefined) {
        problem(own.length === 0 ? `${sha} was taken, but no call of its worker’s ran git stash pop or drop in its worktree` : `its worker’s calls took more entries than the git stash pops and drops they ran`);
        continue;
      }
      budgetOf(by.c, by.w).take -= 1;
      byLine.push({ line: l, c: by.c, b: by.w.binding });
    }
    if (problems.length > 0) return failed(problems.map((p) => p.text).join('; '), problems.some((p) => p.severity === 'controller') ? 'controller' : 'unestablished');
    if (byLine.length === 0) return failed('unexplained');
    const ws = [...new Map(byLine.map((x) => [x.b.claim_id, x.b])).values()];
    tr.by = 'worker';
    tr.worker = { ...ws[0] };
    tr.workers = ws.map((w) => ({ ...w }));
    tr.calls = [...new Set(byLine.map((x) => x.c.id))];
    tr.lines = byLine.map((x) => ({ entry: newOf(x.line), claim_id: x.b.claim_id, node_id: x.b.node_id, call: x.c.id, removed: removed.includes(x.line) }));
    for (const x of byLine) if (added.includes(x.line)) owners.set(x.line, { kind: 'worker', claim: x.b.claim_id });
    transitions.push(tr);
  };
  for (const e of events) {
    if (e.type === 'core') {
      const next = { lines: e.lines !== undefined ? e.lines : cur.lines, ref: 'ref' in e ? e.ref : cur.ref };
      if (same(next.lines, cur.lines) && next.ref === cur.ref) continue;
      const added = next.lines.filter((l) => !cur.lines.includes(l));
      for (const l of added) owners.set(l, { kind: 'core' });
      transitions.push({ from_pos: lastObs.pos, to_pos: null, added: added.map(newOf), removed: cur.lines.filter((l) => !next.lines.includes(l)).map(newOf), top: next.ref ?? null, by: 'core', worker: null, calls: [], reason: null, severity: null, at: e.t.toString(), addedLines: added, removedLines: cur.lines.filter((l) => !next.lines.includes(l)), core: true, consistent: true });
      cur = next;
      continue;
    }
    if (e.lines === null) {
      // An observation whose reflog bytes were not kept: a boundary, never a state.
      lastObs = { pos: e.pos, t: e.t, branchAt: e.branchAt };
      continue;
    }
    const next = { lines: e.lines, ref: e.ref };
    if (!same(next.lines, cur.lines) || next.ref !== cur.ref) gap(cur, next, lastObs.pos, e.pos, lastObs.t, lastObs.branchAt, e.branchAt);
    cur = next;
    lastObs = { pos: e.pos, t: e.t, branchAt: e.branchAt };
  }
  const end = { lines: after.lines, ref: postRef };
  if (!same(end.lines, cur.lines) || end.ref !== cur.ref) gap(cur, end, lastObs.pos, Infinity, lastObs.t, lastObs.branchAt, post.git?.[git]?.refs ?? {});
  // Not attributed: at the settlement, all of it; while the session runs, only what points at the controller's own hand.
  const unattributed = transitions.filter((t) => t.by === null);
  const bad = live ? unattributed.filter((t) => !t.pending && t.severity === 'controller') : unattributed;
  const workers = [...new Map(transitions.filter((t) => t.by === 'worker').map((t) => [t.worker.claim_id, t.worker])).values()];
  return {
    ...base,
    transitions: transitions.map(({ addedLines, removedLines, rewrites, ...t }) => ({ ...t, rewritten: rewrites?.length ?? 0 })),
    verdict: bad.length > 0 ? 'unauthorized' : unattributed.length > 0 ? 'pending' : 'authorized',
    by: bad.length > 0 ? 'controller' : unattributed.length > 0 ? 'pending' : workers.length > 0 ? 'worker' : 'core',
    at: bad.length === 0 ? '0' : bad[0].at,
    reasons: bad.map((t) => t.reason),
    ...(unattributed.length > bad.length ? { unsettled: unattributed.filter((t) => !bad.includes(t)).map((t) => t.pending ?? t.reason) } : {}),
    workers,
    target: stashTarget({ store, before, transitions, keep: (t) => t.by !== null }),
    // The whole chain, for a reconstruction to replay a part of it.
    chain: { before: before.lines, transitions },
  };
}

/**
 * The stash the kept transitions alone leave: `{ ref, log }` (its bytes put
 * into the store; null for none). `keep(transition, line)` decides each
 * line a transition added or removed (`line`: its worker's part, when the
 * transition names one per line).
 */
export function stashTarget({ store, before, transitions, keep }) {
  let lines = [...(before.lines ?? [])];
  for (const t of transitions) {
    const keepLine = (l) => keep(t, t.lines ? (t.lines.find((x) => x.entry === newOf(l)) ?? null) : null);
    for (const l of t.removedLines) if (keepLine(l)) lines = lines.filter((x) => x !== l);
    for (const l of t.addedLines) if (keepLine(l) && !lines.includes(l)) lines.push(l);
    // git's fixup of a neighbour's line, in place, with the drop that caused it.
    if (t.rewrites?.length && t.removedLines.some((l) => keepLine(l))) for (const r of t.rewrites) lines = lines.map((x) => (x === r.from ? r.to : x));
  }
  if (lines.length === 0) return { ref: null, log: null };
  return { ref: topOf(lines), log: putObject(store, bytesOf(lines)) };
}
