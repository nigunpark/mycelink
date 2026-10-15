/**
 * A module-worker's shared Git changes in a controller session (CSET-203 r12;
 * CSET-202 final).
 *
 * r12's module-worker ran `git stash` in its own worktree while repairing a
 * RED: worktrees share their repository's stash, so `refs/stash` and its
 * reflog moved in the common Git directory. The session's transaction saw a
 * product repository's ref move with no record of whose call moved it, took
 * it for the controller's, stopped the session and rolled it back whole —
 * every step Mycelink and its worker had made, the feature's very start.
 *
 * CSET-202's latest with arm was stopped twice the same way, though every
 * call was on record: the host sat in `sleep 100; echo waiting` while its
 * background worker pushed, committed and popped, and an open host call was
 * taken for the controller's hand in the stash whatever it ran.
 *
 * The plugin's hooks record every Bash call (src/hooks/worker-calls.ts); the
 * session's own stream (Claude Code's stdout, as the harness keeps it) shows
 * every call under the Agent call that ran it; and the transaction follows
 * the stash through them (lib/shared-git.mjs, lib/causal.mjs). A transition
 * is a module-worker's when its entries were made on its claim's branch from
 * a commit of it (and what it dropped it had made), a call of that worker —
 * shown in the stream under its own Agent call, its own transcript showing
 * it — ran the git stash that makes it, in its own worktree, and nothing else
 * running then may have: a host call only waiting, printing or reading
 * changes nothing, whatever it overlaps. Everything else — a host command
 * that runs git stash however it is wrapped, a call no stream shows or shows
 * otherwise, a forged transcript or parent, a sibling's or a late process's
 * stash, a forged reflog, a ref written without its reflog — is the
 * controller's, and goes back, ref and reflog byte for byte, without touching
 * a worker's commits or worktree; an entry a rollback takes out of the stash
 * is archived, never lost. A full rollback is a reconstruction that keeps a
 * standing worker's worktree and entries.
 *
 * Every hook here is the shipped one (bin/mycelink.mjs hook ...), every gate
 * a ticket's own line, every Mycelink step the shipped CLI with its ledger on.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git, makeGitRepo } from '../helpers/git-fixture.js';
import { ASSEMBLE, ERRORS, ERRORS_IMPL, READ, SHOP_CRITERIA, SHOP_FEATURE, SHOP_WORK, createShop, moduleVerifier, shopCli, shopGraph, type Shop } from '../helpers/shop-fixture.js';
import { fulfil, gateTests, packOf, writeFiles, type GateRun, type ShopTicket } from '../helpers/shop-worker.js';
import { asController } from '../helpers/authority.js';
// @ts-expect-error -- plain ESM module without type declarations
import { attestRollbacks, beginTransaction, lightCheck, resumeTransaction, settleTransaction } from '../../evals-public-projects/lib/controller-txn.mjs';
import { escapeRegExp } from '../helpers/regex.js';
import { runWithInput } from '../../src/util/child-stdin.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = resolve(process.cwd(), 'bin', 'mycelink.mjs');
const WORKER = 'mycelink:module-worker';
const SRC = 'packages/errors/src/index.mjs';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const q = (p: string) => `'${p.replace(/\\/g, '/')}'`;
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
/** Past the window in which a check leaves what the hooks just observed to the settlement (snapshot.mjs RACY_MS). */
const RACY = 250;

interface Agent {
  id: string;
  agent: string;
  transcript: string;
  ticket: ShopTicket;
  async: boolean;
}

interface CallOptions {
  background?: boolean;
  /** The host's own call into its on-disk transcript (a worker's goes into its own unless false). */
  transcript?: boolean;
  /** What the stream shows as the command, when it is not the one run. */
  shown?: string;
  /** false: the stream shows no such call. */
  stream?: boolean;
  /** The Agent call the stream shows it under (default: the caller's, the host's for null). */
  parent?: string | null;
}

/**
 * The host session: Claude Code's records under its HOME, its stream-json
 * output as the harness keeps it (outside the workspace and the HOME), the
 * plugin's hooks with the ledger on. `from`: an earlier session whose HOME
 * and ledger a fresh session (a restart) goes on with.
 */
function session(s: Shop, from: { home: string } | null = null) {
  const home = from?.home ?? makeTmpDir('shared-git-home-');
  const ledger = join(home, '.mycelink-provenance');
  const session = randomUUID();
  const project = join(home, '.claude', 'projects', 'p');
  const transcript = join(project, `${session}.jsonl`);
  mkdirSync(join(project, session, 'subagents'), { recursive: true });
  writeFileSync(transcript, '');
  const stream = join(makeTmpDir('shared-git-stream-'), `${session}.jsonl`);
  writeFileSync(stream, '');
  const emit = (e: Record<string, unknown>) => appendFileSync(stream, `${JSON.stringify({ ...e, session_id: session })}\n`);
  emit({ type: 'system', subtype: 'init', cwd: s.root });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: s.root, MYCELINK_PROVENANCE: ledger };
  delete env['MYCELINK_CONTROL_ROOT'];
  delete env['MYCELINK_NODE_ID'];
  let n = 0;
  const parents = new Map<string, string | null>();
  const hook = (event: string, payload: Record<string, unknown>) => {
    const r = runWithInput(process.execPath, [LAUNCHER, 'hook', event], { input: JSON.stringify({ session_id: session, transcript_path: transcript, cwd: s.root, ...payload }), encoding: 'utf8', env, cwd: s.root, windowsHide: true });
    return { code: r.status ?? -1, stderr: r.stderr ?? '' };
  };
  const who = (a: Agent | null) => (a === null ? {} : { agent_id: a.agent, agent_type: WORKER });
  const use = (parent: string | null, id: string, name: string, input: Record<string, unknown>) => emit({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const result = (parent: string | null, id: string, content: unknown, error = false) => emit({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] } });
  return {
    home,
    ledger,
    env,
    stream,
    session,
    emit,
    /** The stream as far as it goes. */
    text: () => readFileSync(stream, 'utf8'),
    /** The host's Agent call for a ticket: Claude Code's meta for the subagent, the stream's call (and task, in the background), the fence's PreToolUse (it records the launch). */
    launch(ticket: ShopTicket, options: { async?: boolean } = {}): Agent {
      const id = `toolu_launch_${++n}_${randomUUID().slice(0, 8)}`;
      const agent = `a${sha(id).slice(0, 16)}`;
      const input = { subagent_type: WORKER, description: ticket.node_id, prompt: ticket.prompt, ...(options.async ? { run_in_background: true } : {}) };
      writeFileSync(join(project, session, 'subagents', `agent-${agent}.meta.json`), JSON.stringify({ agentType: WORKER, description: ticket.node_id, toolUseId: id }));
      use(null, id, 'Agent', input);
      const r = hook('controller-fence', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input, tool_use_id: id });
      if (r.code !== 0) throw new Error(`launch refused: ${r.stderr}`);
      if (options.async) {
        emit({ type: 'system', subtype: 'task_started', task_id: agent, tool_use_id: id, description: ticket.node_id, subagent_type: WORKER, is_backgrounded: true, task_type: 'local_agent' });
        result(null, id, [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agent}` }]);
        hook('tool-end', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: input, tool_use_id: id, tool_response: { status: 'async_launched', agentId: agent } });
      }
      return { id, agent, transcript: join(project, session, 'subagents', `agent-${agent}.jsonl`), ticket, async: Boolean(options.async) };
    },
    /** A call's start: the stream's line, its own transcript line (a worker's), then the PreToolUse hooks. */
    start(a: Agent | null, command: string, options: CallOptions = {}): string {
      const id = `toolu_${++n}_${randomUUID().slice(0, 8)}`;
      const parent = options.parent !== undefined ? options.parent : (a?.id ?? null);
      parents.set(id, parent);
      if (options.stream !== false) use(parent, id, 'Bash', { command: options.shown ?? command, ...(options.background ? { run_in_background: true } : {}) });
      // The host's own call goes into the session's transcript only when asked (a worker's always does, unless told not to).
      if (a === null && options.transcript === true) appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', sessionId: session, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: options.shown ?? command } }] } })}\n`);
      if (a !== null && options.transcript !== false) appendFileSync(a.transcript, `${JSON.stringify({ type: 'assistant', isSidechain: true, agentId: a.agent, attributionAgent: WORKER, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })}\n`);
      const r = hook('controller-fence', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...(options.background ? { run_in_background: true } : {}) }, tool_use_id: id, ...who(a) });
      if (r.code !== 0) throw new Error(`the fence refused ${command}: ${r.stderr}`);
      return id;
    },
    end(a: Agent | null, id: string, command: string, failed = false): void {
      hook('tool-end', { hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...who(a) });
      result(parents.get(id) ?? null, id, failed ? 'Exit code 143\nCommand timed out after 2m 0s' : 'ok', failed);
    },
    /** One Bash call, its effect what the command does (or, for an attack, what it does unseen). */
    call(a: Agent | null, command: string, effect: () => void, options: CallOptions = {}): string {
      const id = this.start(a, command, options);
      effect();
      this.end(a, id, command);
      return id;
    },
    /** The subagent stops: SubagentStop, its task's notification, and a foreground Agent call's end. */
    stop(a: Agent): void {
      hook('subagent-end', { hook_event_name: 'SubagentStop', agent_id: a.agent, agent_type: WORKER, stop_hook_active: false });
      emit({ type: 'system', subtype: 'task_notification', task_id: a.agent, tool_use_id: a.id, status: 'completed', summary: a.ticket.node_id });
      if (a.async) return;
      hook('tool-end', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: WORKER }, tool_use_id: a.id, tool_response: { status: 'completed' } });
      result(null, a.id, `${a.ticket.node_id}: result written`);
    },
    /** The host resumes a stopped subagent with SendMessage: its result names it, as Claude Code's does; its calls run under its Agent call again. */
    resume(a: Agent): void {
      const id = `toolu_${++n}_${randomUUID().slice(0, 8)}`;
      use(null, id, 'SendMessage', { to: a.agent, summary: 'go on', message: 'Go on with the node.' });
      result(null, id, [{ type: 'text', text: JSON.stringify({ success: true, message: `Resuming agent ${a.agent.slice(0, 7)}`, resumedAgentId: a.agent }) }]);
    },
    /** A gate line of a ticket, as its worker's Bash call runs it (the gate is Mycelink's core, its ledger on). */
    gate(a: Agent, gate: string): string {
      const line = a.ticket.gate_commands.find((g) => g.gate === gate)!.command;
      let out = '';
      this.call(a, line, () => {
        out = execSync(line, { cwd: s.control, encoding: 'utf8', stdio: 'pipe', env });
      });
      return out;
    },
    /** The host's own Mycelink step, through the shipped CLI with the ledger on. */
    mycelink(args: string[]): Record<string, any> {
      const command = `node ${q(LAUNCHER)} ${args.join(' ')}`;
      let out = '';
      this.call(null, command, () => {
        const r = spawnSync(process.execPath, [LAUNCHER, ...args, '--control-root', s.control, '--json'], { cwd: s.root, env, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`mycelink ${args.join(' ')}: ${r.stderr}`);
        out = r.stdout;
      });
      return JSON.parse(out) as Record<string, any>;
    },
  };
}
type Host = ReturnType<typeof session>;

const txnDirOf = (s: Shop) => join(s.root, '..', `${s.root.split(/[\\/]/).pop()}-txn`);
const store = (s: Shop) => join(txnDirOf(s), 'objects');
const begin = (s: Shop, h: Host, n = 1) => beginTransaction({ workspace: s.root, txnDir: join(txnDirOf(s), `session-${n}`), store: store(s), ledgerDir: h.ledger, index: n, stream: h.stream, plugin: dirname(dirname(LAUNCHER)) });
const stashRef = (repo: string) => {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/stash'], { cwd: repo, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const stashLog = (repo: string) => (existsSync(join(repo, '.git', 'logs', 'refs', 'stash')) ? readFileSync(join(repo, '.git', 'logs', 'refs', 'stash')).toString('base64') : null);
const stashState = (repo: string) => ({ ref: stashRef(repo), log: stashLog(repo) });
/** The archive refs holding stash entries a rollback took out of the stash. */
const archivedEntries = (repo: string) =>
  git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mycelink/archive/'])
    .split('\n')
    .filter((l) => /\/stash\//.test(l))
    .map((l) => l.split(' ')[1]);
const STASH = 'shop/.git:refs/stash';
const reasonsOf = (r: any) => r.unauthorized.find((d: any) => d.path === STASH)?.reasons ?? [];

/** Run `fn` with the provenance ledger on for the CLI processes it starts (a ticket's gate lines run through the shell). */
function withLedger<T>(ledger: string, fn: () => T): T {
  const was = process.env['MYCELINK_PROVENANCE'];
  process.env['MYCELINK_PROVENANCE'] = ledger;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env['MYCELINK_PROVENANCE'];
    else process.env['MYCELINK_PROVENANCE'] = was;
  }
}

async function dispatchErrors(s: Shop): Promise<ShopTicket> {
  return (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
}

/** A user's stash in the repository's checkout, from before the session. */
function userStash(s: Shop): void {
  writeFileSync(join(s.repo, 'README.md'), '# shop\nuser wip\n');
  git(s.repo, ['stash', 'push', '-q', '-m', 'user wip']);
}

describe('CSET-203 r12: a module-worker’s stash in its own worktree is the worker’s', () => {
  it('stash, RED repair, test commit, pop, stash again — authorised and on record; the session goes on, pops, settles DONE', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    userStash(s);
    const user = stashState(s.repo);
    const t = await dispatchErrors(s);
    const h = session(s);
    const txn = begin(s, h);
    const w = h.launch(t);
    const wt = t.worktree;
    // r12's sequence: a production edit set aside so the red gate runs the tests alone.
    writeFileSync(join(wt, SRC), `${ERRORS_IMPL}\n// draft\n`);
    h.call(w, `git -C ${q(wt)} stash -q`, () => git(wt, ['stash', 'push', '-q']));
    writeFiles(wt, SHOP_WORK[ERRORS]!.tests);
    h.gate(w, 'red');
    h.call(w, `git -C ${q(wt)} add -A && git -C ${q(wt)} commit -qm "test: RED"`, () => {
      git(wt, ['add', '-A']);
      git(wt, ['commit', '-q', '-m', 'test: RED']);
    });
    h.call(w, `git -C ${q(wt)} stash pop -q`, () => git(wt, ['stash', 'pop', '-q']));
    // ... and set aside again, as r12's worker was doing when its session was stopped.
    h.call(w, `git -C ${q(wt)} stash -q`, () => git(wt, ['stash', 'push', '-q']));
    await pause();
    // A Mycelink step after it: the core writes (a check while it ran found nothing to stop).
    const mid = settleTransaction({ txn });
    expect(mid).toMatchObject({ violation: false, mode: 'none', unauthorized: [], ambiguous: [] });
    expect(mid.authorized).toEqual(expect.arrayContaining([expect.objectContaining({ path: STASH, kind: 'stash', by: 'worker-git' })]));
    expect(mid.worker_git).toEqual([{ path: STASH, workers: [{ node_id: ERRORS, claim_id: t.claim_id, dispatch_id: t.dispatch_id }], transitions: [expect.objectContaining({ node_id: ERRORS, added: [expect.stringMatching(/^[0-9a-f]{40}$/)], removed: [] }), expect.objectContaining({ removed: [expect.any(String)], added: [] }), expect.objectContaining({ added: [expect.any(String)] })] }]);
    // The session goes on: the worker pops its entry, proves GREEN, commits, regression; the host settles DONE.
    const txn2 = begin(s, h, 2);
    h.call(w, `git -C ${q(wt)} stash pop -q`, () => git(wt, ['stash', 'pop', '-q']));
    h.call(w, `git -C ${q(wt)} checkout -- ${SRC}`, () => git(wt, ['checkout', '--', SRC]));
    writeFiles(wt, SHOP_WORK[ERRORS]!.impl);
    h.gate(w, 'green');
    h.call(w, `git -C ${q(wt)} add -A && git -C ${q(wt)} commit -qm "feat"`, () => {
      git(wt, ['add', '-A']);
      git(wt, ['commit', '-q', '-m', 'feat: errors']);
    });
    expect(h.gate(w, 'regression')).toMatch(/REGRESSION_VERIFIED/);
    h.stop(w);
    const settled = settleTransaction({ txn: txn2 });
    expect(settled).toMatchObject({ violation: false, mode: 'none' });
    expect(stashState(s.repo)).toEqual(user);
  });

  it('a worker that leaves its entry and stops: settle (the core) archives and drops it; the chain is the worker’s, then the core’s; the user’s stash is as it was', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    userStash(s);
    const user = stashState(s.repo);
    const t = await dispatchErrors(s);
    const h = session(s);
    const txn = begin(s, h);
    const w = h.launch(t);
    writeFileSync(join(t.worktree, SRC), `${ERRORS_IMPL}\n// draft\n`);
    h.call(w, `git -C ${q(t.worktree)} stash push -m draft`, () => git(t.worktree, ['stash', 'push', '-q', '-m', 'draft']));
    const left = stashRef(s.repo);
    // The rest of its work, as a worker's calls (the helper's git steps), then its result; it stops.
    h.call(w, 'node --version', () => withLedger(h.ledger, () => fulfil(t, { ...SHOP_WORK[ERRORS]!, criteria: SHOP_CRITERIA[ERRORS]!.map((c) => ({ criterion: c.criterion, gate: c.gate, full_name: c.name })) }, s.control)));
    h.stop(w);
    const report = h.mycelink(['settle', SHOP_FEATURE, ERRORS, '--capability', t.capability]);
    expect(report).toMatchObject({ outcome: 'DONE', stash: { quarantined: [{ sha: left }] } });
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: false, mode: 'none' });
    const delta = r.authorized.find((a: any) => a.path === STASH);
    expect(delta).toMatchObject({ by: 'worker-git' });
    expect(stashState(s.repo)).toEqual(user);
  });
});

/** A dispatched errors node whose worker has made progress — a test commit, a draft in its worktree — and whose stash push is next. */
async function working() {
  const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
  userStash(s);
  const user = stashState(s.repo);
  const t = await dispatchErrors(s);
  const h = session(s);
  const txn = begin(s, h);
  const w = h.launch(t);
  // The worker's own progress, which every rollback below must leave alone: a test commit, a draft in its worktree.
  writeFiles(t.worktree, SHOP_WORK[ERRORS]!.tests);
  h.gate(w, 'red');
  h.call(w, `git -C ${q(t.worktree)} add -A && git -C ${q(t.worktree)} commit -qm RED`, () => {
    git(t.worktree, ['add', '-A']);
    git(t.worktree, ['commit', '-q', '-m', 'test: RED']);
  });
  writeFileSync(join(t.worktree, SRC), `${ERRORS_IMPL}\n// draft\n`);
  const head = git(t.worktree, ['rev-parse', 'HEAD']);
  await pause();
  return { s, t, h, txn, w, user, head };
}
type Working = Awaited<ReturnType<typeof working>>;
/** The worker's progress is exactly as it left it. */
function untouched(x: Working) {
  expect(git(x.t.worktree, ['rev-parse', 'HEAD'])).toBe(x.head);
  expect(readFileSync(join(x.t.worktree, SRC), 'utf8')).toBe(`${ERRORS_IMPL}\n// draft\n`);
}
/** The worker's own `git stash push` of its draft, as its own call. */
const push = (x: Working, command = `git -C ${q(x.t.worktree)} stash -q`) => x.h.call(x.w, command, () => git(x.t.worktree, ['stash', 'push', '-q']));

describe('what is not a worker’s is the controller’s: rolled back, ref and reflog byte for byte, the worker’s work untouched', () => {
  it('the controller’s own git stash in the product checkout, run where the fence never saw it', async () => {
    const x = await working();
    // An innocuous call the fence allows; its effect, unseen, a stash in the checkout.
    x.h.call(null, `git -C ${q(x.s.control)} status`, () => {
      writeFileSync(join(x.s.repo, 'README.md'), '# shop\nmine\n');
      git(x.s.repo, ['stash', 'push', '-q', '-m', 'controller']);
    });
    const r = settleTransaction({ txn: x.txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective', rollback: { verified: true } });
    expect(r.unauthorized.map((d: any) => [d.path, d.kind])).toEqual([[STASH, 'stash']]);
    expect(r.summary[0]).toMatch(/^shop\/\.git:refs\/stash \(moved from [0-9a-f]{12} to [0-9a-f]{12}; a product repository's ref\)$/);
    expect(stashState(x.s.repo)).toEqual(x.user);
    expect(r.rollback.reflogs).toEqual([expect.objectContaining({ git: 'shop/.git', ref: 'refs/stash' })]);
    untouched(x);
  });

  it('a transcript forged to show a worker’s git stash, with no call of the worker’s around it', async () => {
    const x = await working();
    appendFileSync(x.w.transcript, `${JSON.stringify({ type: 'assistant', isSidechain: true, agentId: x.w.agent, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_forged', name: 'Bash', input: { command: `git -C ${q(x.t.worktree)} stash` } }] } })}\n`);
    git(x.t.worktree, ['stash', 'push', '-q']);
    const r = settleTransaction({ txn: x.txn });
    expect(r.unauthorized.map((d: any) => d.path)).toEqual([STASH]);
    expect(r.unauthorized[0].reasons).toEqual([expect.stringMatching(/no call was running/)]);
    expect(stashState(x.s.repo)).toEqual(x.user);
  });

  it('a worker call whose own transcript does not show it is not the worker’s', async () => {
    const x = await working();
    x.h.call(x.w, `git -C ${q(x.t.worktree)} stash -q`, () => git(x.t.worktree, ['stash', 'push', '-q']), { transcript: false });
    const r = settleTransaction({ txn: x.txn });
    expect(r.unauthorized[0]?.reasons).toEqual([expect.stringMatching(/transcript does not show the call/)]);
  });

  it('a stash made on another branch (the checkout’s) during the worker’s call is not the worker’s', async () => {
    const x = await working();
    x.h.call(x.w, `git -C ${q(x.t.worktree)} status`, () => {
      writeFileSync(join(x.s.repo, 'README.md'), '# shop\nmine\n');
      git(x.s.repo, ['stash', 'push', '-q']);
    });
    const r = settleTransaction({ txn: x.txn });
    expect(r.unauthorized[0]?.reasons).toEqual([expect.stringMatching(/was made on main/)]);
    expect(stashState(x.s.repo)).toEqual(x.user);
    untouched(x);
  });

  it('a stash in a repository the worker is not bound to is not the worker’s', async () => {
    const x = await working();
    const other = makeGitRepo(join(x.s.root, 'other'), { files: { 'a.txt': 'a\n' } });
    const txn = begin(x.s, x.h, 2);
    x.h.call(x.w, `git -C ${q(x.t.worktree)} status`, () => {
      writeFileSync(join(other, 'a.txt'), 'b\n');
      git(other, ['stash', 'push', '-q']);
    });
    const r = settleTransaction({ txn });
    expect(r.unauthorized.map((d: any) => d.path)).toEqual(['other/.git:refs/stash']);
    expect(r.unauthorized[0].reasons).toEqual([expect.stringMatching(/no worker is bound to this repository/)]);
    expect(stashRef(other)).toBeNull();
  });

  it('a host call beside the worker’s that only reads leaves the stash the worker’s; one that may change anything makes it the controller’s', async () => {
    const x = await working();
    const c = x.h.start(null, `git -C ${q(x.s.control)} log -1`);
    push(x);
    x.h.end(null, c, `git -C ${q(x.s.control)} log -1`);
    const r = settleTransaction({ txn: x.txn });
    expect(r).toMatchObject({ violation: false, mode: 'none', unauthorized: [] });
    expect(r.authorized).toEqual(expect.arrayContaining([expect.objectContaining({ path: STASH, kind: 'stash', by: 'worker-git' })]));

    // A build the fence lets the host run (it writes nothing the fence can name), which may run anything.
    const y = await working();
    const helper = `make -s -C ${q(makeTmpDir('shared-git-outside-'))} wait`;
    const c2 = y.h.start(null, helper);
    push(y);
    y.h.end(null, c2, helper);
    const r2 = settleTransaction({ txn: y.txn });
    expect(reasonsOf(r2)).toEqual([expect.stringMatching(/a host call that may change it ran meanwhile \(toolu_\S+: runs make\)/)]);
    expect(stashState(y.s.repo)).toEqual(y.user);
  });

  it('the host only sleeping beside the worker’s call — its own transcript shows exactly `sleep 240` — leaves the stash change the worker’s', async () => {
    const x = await working();
    const c = x.h.start(null, 'sleep 240', { transcript: true });
    push(x);
    x.h.end(null, c, 'sleep 240');
    const r = settleTransaction({ txn: x.txn });
    expect(r).toMatchObject({ violation: false, mode: 'none', unauthorized: [] });
    expect(r.authorized).toEqual(expect.arrayContaining([expect.objectContaining({ path: STASH, kind: 'stash', by: 'worker-git' })]));
    // Its entry stands: nothing was rolled back.
    expect(stashState(x.s.repo)).not.toEqual(x.user);
  });

  it('a host call changes nothing only as the session’s stream shows it: one that runs git stash, one the stream words otherwise, or one it does not show is the controller’s', async () => {
    const quiet = async (command: string) => {
      const x = await working();
      const c = x.h.start(null, command);
      push(x);
      x.h.end(null, c, command);
      return settleTransaction({ txn: x.txn });
    };
    // Waiting and reading, chained: nothing it runs can change the stash.
    expect(await quiet('sleep 240; git -C . status; git stash list')).toMatchObject({ violation: false, mode: 'none' });
    // A wait that runs git stash (in a scratch repository outside the workspace, which the fence allows) may change any stash.
    const outside = makeTmpDir('shared-git-outside-');
    for (const [command, options, why] of [
      [`sleep 240; git -C ${q(outside)} stash`, {}, /runs git stash/],
      ['sleep 240', { shown: 'sleep 1' }, /the stream shows another command/],
      ['sleep 240', { stream: false }, /the session’s stream shows no call/],
    ] as const) {
      const x = await working();
      const c = x.h.start(null, command, options);
      push(x);
      x.h.end(null, c, command);
      const r = settleTransaction({ txn: x.txn });
      expect(reasonsOf(r), command).toEqual([expect.stringMatching(why)]);
      expect(stashState(x.s.repo)).toEqual(x.user);
    }
  });

  it('a late process: a stash after the worker’s call — or its Agent call — ended is not the worker’s; nor is a background call’s after it', async () => {
    const x = await working();
    x.h.call(x.w, `git -C ${q(x.t.worktree)} status`, () => undefined);
    x.h.stop(x.w);
    git(x.t.worktree, ['stash', 'push', '-q']);
    const r = settleTransaction({ txn: x.txn });
    expect(r.unauthorized[0]?.reasons).toEqual([expect.stringMatching(/no call was running/)]);

    const y = await working();
    const bg = `git -C ${q(y.t.worktree)} stash -q`;
    const id = y.h.start(y.w, bg, { background: true });
    y.h.end(y.w, id, bg);
    y.h.stop(y.w);
    // The background process outlives the worker's Agent call.
    git(y.t.worktree, ['stash', 'push', '-q']);
    const r2 = settleTransaction({ txn: y.txn });
    expect(r2.unauthorized[0]?.reasons).toEqual([expect.stringMatching(/no call was running/)]);
  });

  it('a reflog forged to word the controller’s entry as the worker’s, and a user’s entry dropped from the reflog', async () => {
    const x = await working();
    const branch = `wip/${SHOP_FEATURE}/shop.errors.impl`;
    x.h.call(null, `git -C ${q(x.s.control)} status`, () => {
      const tree = git(x.t.worktree, ['write-tree']);
      const forged = git(x.s.repo, ['commit-tree', tree, '-p', x.head, '-m', `On ${branch}: forged`]);
      git(x.s.repo, ['update-ref', '-m', `On ${branch}: forged`, 'refs/stash', forged]);
    });
    const r = settleTransaction({ txn: x.txn });
    // The host's call only read; nothing else that could have made it was running.
    expect(r.unauthorized[0]?.reasons).toEqual([expect.stringMatching(/no call was running that could have made it/)]);
    expect(stashState(x.s.repo)).toEqual(x.user);

    const y = await working();
    // During the worker's own call, the user's entry vanishes from the reflog and the ref: the worker never made it.
    y.h.call(y.w, `git -C ${q(y.t.worktree)} status`, () => {
      git(y.s.repo, ['update-ref', '-d', 'refs/stash']);
    });
    const r2 = settleTransaction({ txn: y.txn });
    expect(r2.unauthorized[0]?.reasons).toEqual([expect.stringMatching(/drops [0-9a-f]{12}, an entry that was there before the session, not made in a running worker/)]);
    expect(stashState(y.s.repo)).toEqual(y.user);
  });

  it('refs/stash written straight into packed-refs, its reflog untouched, during the worker’s call', async () => {
    const x = await working();
    x.h.call(x.w, `git -C ${q(x.t.worktree)} status`, () => {
      // A stash commit made from the worker's own worktree, put into packed-refs over the loose ref: the reflog never hears of it.
      const made = git(x.t.worktree, ['stash', 'create']);
      unlinkSync(join(x.s.repo, '.git', 'refs', 'stash'));
      appendFileSync(join(x.s.repo, '.git', 'packed-refs'), `${made} refs/stash\n`);
    });
    const r = settleTransaction({ txn: x.txn });
    expect(r.violation).toBe(true);
    expect(r.unauthorized.map((d: any) => d.path)).toContain(STASH);
    expect(stashState(x.s.repo)).toEqual(x.user);
  });

  it('a lock left in the worker’s admin directory is git’s housekeeping, never the worker’s: removed, no violation', async () => {
    const x = await working();
    const admin = join(x.s.repo, '.git', 'worktrees', `shop__${ERRORS}`);
    x.h.call(x.w, `git -C ${q(x.t.worktree)} status`, () => writeFileSync(join(admin, 'index.lock'), ''));
    const r = settleTransaction({ txn: x.txn });
    expect(r).toMatchObject({ violation: false, mode: 'selective', rollback: { verified: true } });
    expect(r.housekeeping).toEqual([expect.objectContaining({ path: `shop/.git/worktrees/shop__${ERRORS}/index.lock` })]);
    expect(existsSync(join(admin, 'index.lock'))).toBe(false);
    untouched(x);
  });

  it('a rollback of the stash a crash cut short is finished by resuming; resuming again changes nothing', async () => {
    const x = await working();
    x.h.call(null, `git -C ${q(x.s.control)} status`, () => {
      writeFileSync(join(x.s.repo, 'README.md'), '# shop\nmine\n');
      git(x.s.repo, ['stash', 'push', '-q', '-m', 'controller']);
      writeFileSync(join(x.s.root, 'notes.txt'), 'x');
      writeFileSync(join(x.s.root, 'notes2.txt'), 'x');
    });
    expect(() => settleTransaction({ txn: x.txn, faults: { crashAfterSteps: 1 } })).toThrow(/injected crash/);
    const r = resumeTransaction({ txnDir: x.txn.txnDir, store: store(x.s) });
    expect(r.rollback.verified).toBe(true);
    expect(stashState(x.s.repo)).toEqual(x.user);
    const again = resumeTransaction({ txnDir: x.txn.txnDir, store: store(x.s) });
    expect(again.rollback.manifest_sha256).toBe(r.rollback.manifest_sha256);
    untouched(x);
  });

  it('a controller commit on main while the worker commits beside it: main goes back; the worker’s commits, worktree and entry stay', async () => {
    const x = await working();
    const main = git(x.s.repo, ['rev-parse', 'main']);
    x.h.call(null, `git -C ${q(x.s.control)} status`, () => {
      writeFileSync(join(x.s.repo, 'README.md'), '# shop\nfixed it myself\n');
      git(x.s.repo, ['commit', '-q', '-am', 'fix it myself']);
    });
    push(x);
    const entry = stashRef(x.s.repo);
    x.h.call(x.w, `git -C ${q(x.t.worktree)} stash pop -q`, () => git(x.t.worktree, ['stash', 'pop', '-q']));
    const r = settleTransaction({ txn: x.txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective', rollback: { verified: true } });
    expect(r.unauthorized.map((d: any) => d.path).sort()).toEqual(['shop/.git/index', 'shop/.git:refs/heads/main', 'shop/README.md']);
    expect(git(x.s.repo, ['rev-parse', 'main'])).toBe(main);
    expect(entry).not.toBeNull();
    expect(r.authorized.find((a: any) => a.path === STASH)).toMatchObject({ by: 'worker-git' });
    expect(stashState(x.s.repo)).toEqual(x.user);
    untouched(x);
  });
});

/** Read and assemble dispatched beside each other once errors settled DONE (both depend on it). */
async function twoWorkers() {
  const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
  const t0 = await dispatchErrors(s);
  fulfil(t0, { ...SHOP_WORK[ERRORS]!, criteria: SHOP_CRITERIA[ERRORS]!.map((c) => ({ criterion: c.criterion, gate: c.gate, full_name: c.name })) }, s.control);
  expect(JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t0.capability, '--json'])).out).outcome).toBe('DONE');
  const ta = (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
  const tb = (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
  expect([ta.node_id, tb.node_id].sort()).toEqual([ASSEMBLE, READ].sort());
  const h = session(s);
  const txn = begin(s, h);
  const a = h.launch(ta);
  const b = h.launch(tb);
  const srcOf = (t: ShopTicket) => Object.keys(SHOP_WORK[t.node_id]!.impl)[0]!;
  writeFileSync(join(ta.worktree, srcOf(ta)), '// a draft\n');
  writeFileSync(join(tb.worktree, srcOf(tb)), '// b draft\n');
  return { s, h, txn, a, b, ta, tb, srcOf };
}

describe('two workers of one repository', () => {
  it('each entry is its own worker’s, even pushed while both workers’ calls ran; each pop its own', async () => {
    const { s, h, txn, a, b, ta, tb, srcOf } = await twoWorkers();
    // Both workers' calls run at once; each pushes its own entry.
    const ca = h.start(a, `git -C ${q(ta.worktree)} stash -q`);
    const cb = h.start(b, `git -C ${q(tb.worktree)} stash -q`);
    git(ta.worktree, ['stash', 'push', '-q']);
    git(tb.worktree, ['stash', 'push', '-q']);
    h.end(a, ca, `git -C ${q(ta.worktree)} stash -q`);
    h.end(b, cb, `git -C ${q(tb.worktree)} stash -q`);
    // Each pops its own, by name when the newest is the other's.
    h.call(a, `git -C ${q(ta.worktree)} stash pop stash@{1}`, () => git(ta.worktree, ['stash', 'pop', '-q', 'stash@{1}']));
    h.call(b, `git -C ${q(tb.worktree)} stash pop`, () => git(tb.worktree, ['stash', 'pop', '-q']));
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: false, mode: 'none' });
    const wg = r.worker_git[0];
    expect(wg.workers.map((w: any) => w.node_id).sort()).toEqual([ASSEMBLE, READ].sort());
    expect(readFileSync(join(ta.worktree, srcOf(ta)), 'utf8')).toBe('// a draft\n');
    expect(readFileSync(join(tb.worktree, srcOf(tb)), 'utf8')).toBe('// b draft\n');
    expect(stashRef(s.repo)).toBeNull();
  });

  it('no cross-worker laundering: a sibling’s stash in another worker’s worktree is no one’s but the controller’s, whether that worker is idle or pushing too', async () => {
    // B pushes in A's worktree while A is idle: an entry made on A's branch with no call of A's running.
    const x = await twoWorkers();
    x.h.call(x.b, `git -C ${q(x.ta.worktree)} stash -q`, () => git(x.ta.worktree, ['stash', 'push', '-q']));
    const r = settleTransaction({ txn: x.txn });
    expect(r.violation).toBe(true);
    expect(reasonsOf(r)).toEqual([expect.stringMatching(/from a commit no running worker’s branch holds|may have pushed in/)]);
    expect(stashRef(x.s.repo)).toBeNull();
    // ... archived, never lost: A's draft is in it.
    expect(archivedEntries(x.s.repo)).toHaveLength(1);

    // A only reads while B pushes in A's worktree: A ran no git stash push there.
    const y = await twoWorkers();
    const ca = y.h.start(y.a, `git -C ${q(y.ta.worktree)} status`);
    y.h.call(y.b, `git -C ${q(y.ta.worktree)} stash -q`, () => git(y.ta.worktree, ['stash', 'push', '-q']));
    y.h.end(y.a, ca, `git -C ${q(y.ta.worktree)} status`);
    const r2 = settleTransaction({ txn: y.txn });
    expect(r2.violation).toBe(true);
    expect(reasonsOf(r2).join('; ')).toMatch(new RegExp(`may have pushed in ${escapeRegExp(y.ta.node_id)}’s worktree`));

    // A pushes its own entry while B pushes in A's worktree too: two entries on A's branch, either could be B's.
    const z = await twoWorkers();
    const pa = z.h.start(z.a, `git -C ${q(z.ta.worktree)} stash -q`);
    const pb = z.h.start(z.b, `git -C ${q(z.ta.worktree)} stash -q`);
    git(z.ta.worktree, ['stash', 'push', '-q']);
    writeFileSync(join(z.ta.worktree, z.srcOf(z.ta)), '// a second draft\n');
    git(z.ta.worktree, ['stash', 'push', '-q']);
    z.h.end(z.a, pa, `git -C ${q(z.ta.worktree)} stash -q`);
    z.h.end(z.b, pb, `git -C ${q(z.ta.worktree)} stash -q`);
    const r3 = settleTransaction({ txn: z.txn });
    expect(r3.violation).toBe(true);
    expect(reasonsOf(r3).join('; ')).toMatch(/may have pushed in/);
    expect(archivedEntries(z.s.repo)).toHaveLength(2);
  });

  it('forged parent ids: a call the stream shows under one worker’s Agent call, hooked as another’s, is no worker’s', async () => {
    const x = await twoWorkers();
    // The stream runs it under B's Agent call; the hook and A's own transcript name A.
    x.h.call(x.a, `git -C ${q(x.ta.worktree)} stash -q`, () => git(x.ta.worktree, ['stash', 'push', '-q']), { parent: x.b.id });
    const r = settleTransaction({ txn: x.txn });
    expect(r.violation).toBe(true);
    expect(reasonsOf(r).join('; ')).toMatch(/under the Agent call .* not the one its binding names/);
    expect(stashRef(x.s.repo)).toBeNull();
  });
});

describe('a call is a worker’s only as the stream, the hooks and Claude Code’s own records agree', () => {
  it('a fake nested transcript: a subagent meta and transcript forged to claim a call the stream shows as the host’s', async () => {
    const x = await working();
    // The controller writes Claude Code's records of a subagent: a meta naming the worker's own Agent call, a transcript showing the call.
    const fake = 'a0123456789abcdef';
    const dir = dirname(x.w.transcript);
    writeFileSync(join(dir, `agent-${fake}.meta.json`), JSON.stringify({ agentType: WORKER, description: 'x', toolUseId: x.w.id }));
    const forged: Agent = { ...x.w, agent: fake, transcript: join(dir, `agent-${fake}.jsonl`) };
    // The stream shows the host running it.
    x.h.call(forged, `git -C ${q(x.t.worktree)} stash -q`, () => git(x.t.worktree, ['stash', 'push', '-q']), { parent: null });
    const r = settleTransaction({ txn: x.txn });
    expect(r.violation).toBe(true);
    expect(reasonsOf(r).join('; ')).toMatch(/the stream shows the host’s call; its hook names a subagent/);
    expect(stashState(x.s.repo)).toEqual(x.user);
  });

  it('a worker launched for no live claim (its prompt names a dispatch no claim holds) is bound to nothing: its stash is not a worker’s', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    const t = await dispatchErrors(s);
    const h = session(s);
    const txn = begin(s, h);
    const stale = { ...t, prompt: t.prompt.replace(`Dispatch: ${t.dispatch_id}`, `Dispatch: ${randomUUID()}`) };
    const w = h.launch(stale);
    writeFileSync(join(t.worktree, SRC), `${ERRORS_IMPL}\n// draft\n`);
    h.call(w, `git -C ${q(t.worktree)} stash -q`, () => git(t.worktree, ['stash', 'push', '-q']));
    const r = settleTransaction({ txn });
    expect(r.violation).toBe(true);
    expect(reasonsOf(r).join('; ')).toMatch(/bound to no claim/);
    expect(stashRef(s.repo)).toBeNull();
  });

  it('a late child: a worker call that starts after its subagent stopped, with no resume since, is no worker’s; one resumed by SendMessage is its own again', async () => {
    const x = await working();
    x.h.stop(x.w);
    push(x);
    const r = settleTransaction({ txn: x.txn });
    expect(r.violation).toBe(true);
    expect(reasonsOf(r)).toEqual([expect.stringMatching(/stopped, and no resume since/)]);
    expect(stashState(x.s.repo)).toEqual(x.user);

    // The host resumes it (as CSET-203 r17's did): its calls run under its own Agent call again, and its push and pop are its own.
    const y = await working();
    y.h.stop(y.w);
    y.h.resume(y.w);
    push(y);
    y.h.call(y.w, `git -C ${q(y.t.worktree)} stash pop -q`, () => git(y.t.worktree, ['stash', 'pop', '-q']));
    y.h.stop(y.w);
    const r2 = settleTransaction({ txn: y.txn });
    expect(r2).toMatchObject({ violation: false, mode: 'none' });
    expect(r2.worker_git[0].transitions.map((t: any) => [t.node_id, t.added.length, t.removed.length])).toEqual([
      [ERRORS, 1, 0],
      [ERRORS, 0, 1],
    ]);
    untouched(y);
  });

  it('a host command that stashes where no fence sees it (a git alias), while the worker pushes its own: the controller’s, and both entries archived; a host wait that only names git stash is no one’s hand', async () => {
    const x = await working();
    // `git wip`, an alias for `stash push` in the user's configuration: the plugin's fence reads an unknown git command.
    const hidden = `sleep 1; git -C ${q(x.s.repo)} wip -m mine`;
    const c = x.h.start(null, hidden);
    writeFileSync(join(x.s.repo, 'README.md'), '# shop\nmine\n');
    git(x.s.repo, ['stash', 'push', '-q', '-m', 'mine']);
    push(x);
    x.h.end(null, c, hidden);
    const r = settleTransaction({ txn: x.txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective', rollback: { verified: true } });
    // Its own entry, then the worker's beside it: each transition the host's call may have made.
    expect(reasonsOf(r)).toEqual([expect.stringMatching(/a host call that may change it ran meanwhile \(toolu_\S+: runs git wip\)/), expect.stringMatching(/a host call that may change it ran meanwhile \(toolu_\S+: runs git wip\)/)]);
    // The user's stash byte for byte; the worker's history untouched and its draft archived, never lost.
    expect(stashState(x.s.repo)).toEqual(x.user);
    expect(git(x.t.worktree, ['rev-parse', 'HEAD'])).toBe(x.head);
    const archived = archivedEntries(x.s.repo);
    expect(archived).toHaveLength(2);
    expect(archived.map((e) => git(x.s.repo, ['show', `${e}:${SRC}`])).some((b) => b.endsWith('// draft'))).toBe(true);

    // The same push beside a wait that only prints the words.
    const y = await working();
    const wait = 'sleep 100; echo "waiting for git stash"';
    const c2 = y.h.start(null, wait);
    push(y);
    y.h.end(null, c2, wait);
    expect(settleTransaction({ txn: y.txn })).toMatchObject({ violation: false, mode: 'none' });
  });
});

/** A ticket's gate line. */
const lineOf = (t: ShopTicket, gate: string) => t.gate_commands.find((g) => g.gate === gate)!.command;

/** A gate line run as the worker's Bash would run it, from the control root with the session's ledger on: what it printed. */
function gateRun(t: ShopTicket, gate: string, s: Shop, h: Host): GateRun {
  let code = 0;
  let out = '';
  try {
    out = execSync(lineOf(t, gate), { cwd: s.control, encoding: 'utf8', stdio: 'pipe', env: h.env });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return { gate, code, out, sha256: /sha256 ([0-9a-f]{64})/.exec(out)?.[1] ?? null, tests: gateTests(out) };
}

/** The worker's result from the gates it ran: each criterion proved by its test and the output hash of the gate that ran it. */
function resultOf(t: ShopTicket, runs: Record<string, GateRun>): void {
  const evidence = SHOP_CRITERIA[t.node_id]!.map((c) => ({ criterion: c.criterion, test: { path: c.path, name: c.name }, gate: c.gate, output_sha256: runs[c.gate]!.sha256 }));
  const work = SHOP_WORK[t.node_id]!;
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(
    t.result_slot,
    JSON.stringify({
      schema_version: 1,
      node_id: t.node_id,
      claim_id: t.claim_id,
      dispatch_id: t.dispatch_id,
      outcome: 'SUBMITTED',
      commands: Object.values(runs).map((g) => ({ command: [`gate:${g.gate}`], exit_code: g.code })),
      commit_sha: git(t.worktree, ['rev-parse', 'HEAD']),
      changed_paths: [...Object.keys(work.tests), ...Object.keys(work.impl)],
      evidence_paths: [],
      failure_fingerprint: null,
      decision_request: null,
      criterion_evidence: evidence,
    }),
  );
}

/**
 * CSET-202's module-worker, call by call, while its host waits on it: the
 * tests and the production change written; one call sets the production
 * aside and runs the red gate (`cd <wt> && git stash push -q -- <src> && ...
 * tdd red ...`); one commits the test, pops the production back and runs
 * the green gate (`cd <wt> && git add ... && git commit ... && git stash pop
 * -q && git status --short && ... tdd green ...`); then the production
 * commit, regression and its result. The harness's live checks run
 * meanwhile — twice while the entry is live (a stop needs two), once after
 * it is popped — and what each found unauthorised is returned.
 */
async function cset202Worker(s: Shop, h: Host, w: Agent, txn: any): Promise<string[][]> {
  const t = w.ticket;
  const wt = t.worktree;
  const work = SHOP_WORK[t.node_id]!;
  const src = Object.keys(work.impl);
  const tests = Object.keys(work.tests);
  const seen: string[][] = [];
  const check = async () => {
    await pause(RACY);
    const c = lightCheck({ txn, previous: null, reached: [], stream: h.text() });
    seen.push(c.unauthorized.map((u: any) => `${u.path} (${u.change}; ${u.category})`));
  };
  writeFiles(wt, work.tests);
  writeFiles(wt, work.impl);
  const runs: Record<string, GateRun> = {};
  h.call(w, `cd ${q(wt)} && git stash push -q -- ${src.join(' ')} && ${lineOf(t, 'red')}`, () => {
    git(wt, ['stash', 'push', '-q', '--', ...src]);
    runs['red'] = gateRun(t, 'red', s, h);
  });
  expect(runs['red']!.code, runs['red']!.out.slice(0, 4000)).toBe(0);
  await check();
  await check();
  h.call(w, `cd ${q(wt)} && git add ${tests.join(' ')} && git commit -qm "test: ${t.node_id}" && git stash pop -q && git status --short && ${lineOf(t, 'green')}`, () => {
    git(wt, ['add', ...tests]);
    git(wt, ['commit', '-q', '-m', `test: ${t.node_id}`]);
    git(wt, ['stash', 'pop', '-q']);
    runs['green'] = gateRun(t, 'green', s, h);
  });
  expect(runs['green']!.code, runs['green']!.out.slice(0, 4000)).toBe(0);
  await check();
  h.call(w, `git -C ${q(wt)} add -A && git -C ${q(wt)} commit -qm "feat: ${t.node_id}"`, () => {
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', `feat: ${t.node_id}`]);
  });
  h.call(w, lineOf(t, 'regression'), () => {
    runs['regression'] = gateRun(t, 'regression', s, h);
  });
  expect(runs['regression']!.code, runs['regression']!.out).toBe(0);
  resultOf(t, runs);
  return seen;
}

describe('CSET-202 final: the host waits while its background workers stash, commit and pop', () => {
  const WAIT = 'sleep 100; echo waiting';

  it('the exact shape, two workers: an open `sleep 100; echo waiting` beside each worker’s push, red gate, test commit and pop — no check finds anything to stop, each settles DONE, the session settles clean', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    userStash(s);
    const user = stashState(s.repo);
    const t0 = await dispatchErrors(s);
    fulfil(t0, { ...SHOP_WORK[ERRORS]!, criteria: SHOP_CRITERIA[ERRORS]!.map((c) => ({ criterion: c.criterion, gate: c.gate, full_name: c.name })) }, s.control);
    expect(JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t0.capability, '--json'])).out).outcome).toBe('DONE');
    const h = session(s);
    const txn = begin(s, h);
    const settledNodes: string[] = [];
    for (let i = 0; i < 2; i++) {
      // The host's own Mycelink step, its writes on the ledger.
      const t = h.mycelink(asController(['dispatch', SHOP_FEATURE], s.control))['ticket'] as ShopTicket;
      // The host launches the worker in the background and waits on it in the foreground.
      const w = h.launch(t, { async: true });
      const wait = h.start(null, WAIT);
      const seen = await cset202Worker(s, h, w, txn);
      expect(seen, `${t.node_id}: ${JSON.stringify(seen)}`).toEqual([[], [], []]);
      h.stop(w);
      // The wait outlasts its worker: it ends after the worker's notification, timed out.
      h.end(null, wait, WAIT, true);
      const report = h.mycelink(['settle', SHOP_FEATURE, t.node_id, '--capability', t.capability]);
      expect(report.outcome, JSON.stringify(report)).toBe('DONE');
      settledNodes.push(t.node_id);
    }
    expect([...settledNodes].sort()).toEqual([ASSEMBLE, READ].sort());
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: false, mode: 'none', unauthorized: [], ambiguous: [] });
    const wg = r.worker_git.find((g: any) => g.path === STASH);
    expect(wg.workers.map((w: any) => w.node_id).sort()).toEqual([ASSEMBLE, READ].sort());
    // Each worker's push and pop, attributed one by one, by the call that made it.
    expect(wg.transitions.map((x: any) => [x.node_id, x.added.length, x.removed.length])).toEqual([
      [settledNodes[0], 1, 0],
      [settledNodes[0], 0, 1],
      [settledNodes[1], 1, 0],
      [settledNodes[1], 0, 1],
    ]);
    expect(stashState(s.repo)).toEqual(user);
  }, 300_000);

  it('a wait that outlasts its worker changes nothing; a stash while only that wait runs, after the worker ended, is a late process’s — the controller’s', async () => {
    const x = await working();
    const wait = x.h.start(null, WAIT);
    push(x);
    x.h.call(x.w, `git -C ${q(x.t.worktree)} stash pop -q`, () => git(x.t.worktree, ['stash', 'pop', '-q']));
    x.h.stop(x.w);
    await pause(RACY);
    expect(lightCheck({ txn: x.txn, stream: x.h.text() }).unauthorized).toEqual([]);
    git(x.t.worktree, ['stash', 'push', '-q']);
    await pause(RACY);
    // Seen while the wait still runs: nothing that could have made it was running.
    expect(lightCheck({ txn: x.txn, stream: x.h.text() }).unauthorized.map((u: any) => u.path)).toEqual([STASH]);
    x.h.end(null, wait, WAIT, true);
    const r = settleTransaction({ txn: x.txn });
    expect(r.violation).toBe(true);
    // The worker's push and pop stay its own; the late entry alone goes, archived.
    expect(r.unauthorized.find((d: any) => d.path === STASH).reasons).toEqual([expect.stringMatching(/no call was running that could have made it/)]);
    expect(stashState(x.s.repo)).toEqual(x.user);
    expect(archivedEntries(x.s.repo)).toHaveLength(1);
  });

  it('a compaction mid-session changes nothing: the stream goes on, and so does the attribution', async () => {
    const x = await working();
    const wait = x.h.start(null, WAIT);
    push(x);
    x.h.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 167_000 } });
    // Claude Code rewrites the host's own transcript around a compaction; the stream is what the harness kept.
    writeFileSync(join(x.h.home, '.claude', 'projects', 'p', `${x.h.session}.jsonl`), `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`);
    await pause(RACY);
    expect(lightCheck({ txn: x.txn, stream: x.h.text() }).unauthorized).toEqual([]);
    x.h.call(x.w, `git -C ${q(x.t.worktree)} stash pop -q`, () => git(x.t.worktree, ['stash', 'pop', '-q']));
    x.h.end(null, wait, WAIT, true);
    expect(settleTransaction({ txn: x.txn })).toMatchObject({ violation: false, mode: 'none' });
  });

  it('a restart: a session stopped with its worker’s entry live leaves it the worker’s; the fresh session’s worker pops it back as its own', async () => {
    const x = await working();
    const wait = x.h.start(null, WAIT);
    // The worker's push call starts, and the session is killed during it: no call ends, no subagent stops.
    const cmd = `cd ${q(x.t.worktree)} && git stash push -q && ${lineOf(x.t, 'red')}`;
    x.h.start(x.w, cmd);
    git(x.t.worktree, ['stash', 'push', '-q']);
    void wait;
    await pause(RACY);
    const r1 = settleTransaction({ txn: x.txn });
    expect(r1).toMatchObject({ violation: false, mode: 'none' });
    expect(r1.worker_git[0].transitions).toEqual([expect.objectContaining({ node_id: ERRORS, added: [expect.any(String)] })]);
    const entry = stashRef(x.s.repo);
    // A fresh session, the same HOME and ledger: a fresh worker for the claim finds its entry and pops it.
    const h2 = session(x.s, { home: x.h.home });
    const txn2 = begin(x.s, h2, 2);
    const w2 = h2.launch(x.t, { async: true });
    h2.call(w2, `git -C ${q(x.t.worktree)} stash list && git -C ${q(x.t.worktree)} stash pop -q`, () => git(x.t.worktree, ['stash', 'pop', '-q']));
    h2.stop(w2);
    const r2 = settleTransaction({ txn: txn2 });
    expect(r2).toMatchObject({ violation: false, mode: 'none' });
    expect(r2.worker_git[0].transitions).toEqual([expect.objectContaining({ node_id: ERRORS, removed: [entry] })]);
    expect(stashState(x.s.repo)).toEqual(x.user);
    untouched(x);
  });

  it('snapshot sampling: a check while the push call still runs sees an entry no hook has observed yet — the worker’s, by the push its call runs; the settlement attributes push and pop one by one', async () => {
    const x = await working();
    const wait = x.h.start(null, WAIT);
    const cmd = `cd ${q(x.t.worktree)} && git stash push -q && ${lineOf(x.t, 'red')}`;
    const id = x.h.start(x.w, cmd);
    git(x.t.worktree, ['stash', 'push', '-q']);
    await pause(RACY);
    // The hooks last saw no entry (the call's start); the check's snapshot sees one.
    expect(lightCheck({ txn: x.txn, stream: x.h.text() }).unauthorized).toEqual([]);
    x.h.end(x.w, id, cmd);
    x.h.call(x.w, `cd ${q(x.t.worktree)} && git stash pop -q && git status --short`, () => git(x.t.worktree, ['stash', 'pop', '-q']));
    x.h.end(null, wait, WAIT, true);
    const r = settleTransaction({ txn: x.txn });
    expect(r).toMatchObject({ violation: false, mode: 'none' });
    expect(r.worker_git[0].transitions.map((t: any) => [t.added.length, t.removed.length])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    untouched(x);
  });

  it('effects not established — a worker script that stashes where no command shows it: no check stops the session for it; the settlement fails closed and archives the entry, the worker’s history untouched', async () => {
    const x = await working();
    const wait = x.h.start(null, WAIT);
    const script = `node ${q(join(x.t.worktree, 'tools', 'set-aside.mjs'))}`;
    x.h.call(x.w, script, () => git(x.t.worktree, ['stash', 'push', '-q']));
    await pause(RACY);
    expect(lightCheck({ txn: x.txn, stream: x.h.text() }).unauthorized).toEqual([]);
    expect(lightCheck({ txn: x.txn, stream: x.h.text() }).unauthorized).toEqual([]);
    x.h.end(null, wait, WAIT, true);
    const r = settleTransaction({ txn: x.txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective', rollback: { verified: true } });
    expect(reasonsOf(r).join('; ')).toMatch(/no call of .* ran git stash push in its worktree/);
    expect(stashState(x.s.repo)).toEqual(x.user);
    expect(git(x.t.worktree, ['rev-parse', 'HEAD'])).toBe(x.head);
    const archived = archivedEntries(x.s.repo);
    expect(archived).toHaveLength(1);
    expect(git(x.s.repo, ['show', `${archived[0]}:${SRC}`]).endsWith('// draft')).toBe(true);
  });
});

describe('a full rollback is a reconstruction: a standing worker’s worktree and entries stay', () => {
  it('a forgery a core step read after the worker began: back to just before that step; the worker’s commits, edits and entry kept', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    const t = await dispatchErrors(s);
    const h = session(s);
    const txn = begin(s, h);
    const w = h.launch(t);
    writeFiles(t.worktree, SHOP_WORK[ERRORS]!.tests);
    h.gate(w, 'red');
    h.call(w, `git -C ${q(t.worktree)} add -A && git -C ${q(t.worktree)} commit -qm RED`, () => {
      git(t.worktree, ['add', '-A']);
      git(t.worktree, ['commit', '-q', '-m', 'test: RED']);
    });
    writeFileSync(join(t.worktree, SRC), `${ERRORS_IMPL}\n// draft\n`);
    h.call(w, `git -C ${q(t.worktree)} stash -q`, () => git(t.worktree, ['stash', 'push', '-q']));
    const entry = stashRef(s.repo);
    const head = git(t.worktree, ['rev-parse', 'HEAD']);
    await pause();
    // The controller edits the registry where the fence never saw it; the worker's next gate (Mycelink's core) reads it, then records.
    const registry = readFileSync(join(s.control, 'repositories.yaml'), 'utf8');
    h.call(null, `git -C ${q(s.control)} status`, () => writeFileSync(join(s.control, 'repositories.yaml'), `${registry}# mine\n`));
    await pause();
    h.gate(w, 'red');
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: true, mode: 'full', dependencies: [expect.objectContaining({ path: 'control/repositories.yaml' })] });
    expect(r.rollback).toMatchObject({ verified: true, reconstruction: { kept_zones: [expect.stringContaining(`shop__${ERRORS}`)], removed_zones: [] } });
    expect(readFileSync(join(s.control, 'repositories.yaml'), 'utf8')).toBe(registry);
    expect(git(t.worktree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(stashRef(s.repo)).toBe(entry);
    expect(packOf(t)).toBeTruthy();
    const a = attestRollbacks({ sessions: [{ index: 1, controller_txn: { dir: txn.txnDir, violation: true, rollback: { manifest_sha256: r.rollback.manifest_sha256, verified: true } }, violation: { manifest_sha256: r.rollback.manifest_sha256, verified: true } }], workspace: s.root, store: store(s) });
    expect(a.problems).toEqual([]);
  });
});
