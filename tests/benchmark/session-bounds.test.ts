/**
 * Every wait a with-arm run hangs on is bounded, and says so when it ends
 * one: the harness's supervision of a session (superviseSession), whatever
 * the platform reports of the session's process, and the stand-in host's
 * own waits and children (fake-mycelink-host.mjs). The PCM-103 shape timed
 * out on hosted macOS (CI 38533631962) with nothing to say where it stood.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
// @ts-expect-error -- plain ESM module without type declarations
import { superviseSession } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { psGroupMembers } from '../../evals-public-projects/lib/isolation.mjs';

/** A started session as the harness holds it: its pid, its piped stdio, and the events its process reports. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter() as any;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}
const sink = () => new Writable({ write: (_chunk, _encoding, callback) => callback() });

describe('the harness supervises a session to its end, whatever its process reports', () => {
  it('stops waiting for a stopped session whose exit is never reported: killed again meanwhile, ended within the stop grace, and said so', async () => {
    const child = fakeChild();
    const kills: number[] = [];
    const t0 = Date.now();
    // The session is interrupted at its first poll; no exit is ever reported for it (an exit the event loop never delivers).
    const s = await superviseSession({ child, out: sink(), err: sink(), prompt: 'p', deadline: Date.now() + 600_000, pollMs: 20, poll: () => 'interrupt', onText: () => {}, kill: () => kills.push(Date.now() - t0), stopRetryMs: 100, stopGraceMs: 700 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(s).toMatchObject({ ended_by: 'interrupt', exit_code: null, signal: null, exit_unreported: expect.stringMatching(/no exit was reported .* after it was stopped \(interrupt\)/) });
    // The stop, the retries while it was not reported gone, and the last kill once it was no longer waited for.
    expect(kills.length).toBeGreaterThanOrEqual(4);
  }, 20_000);

  it('takes a session whose output ended, and whose exit is never reported, as exited once its exit grace has passed', async () => {
    const child = fakeChild();
    const kills: number[] = [];
    let polls = 0;
    const t0 = Date.now();
    const ended = superviseSession({ child, out: sink(), err: sink(), prompt: 'p', deadline: Date.now() + 600_000, pollMs: 20, poll: () => (polls++, null), onText: () => {}, kill: () => kills.push(Date.now() - t0), exitGraceMs: 500 });
    child.stdout.end('{"type":"result","subtype":"success","is_error":false}\n');
    child.stderr.end();
    const s = await ended;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(s).toMatchObject({ ended_by: 'exit', exit_code: null, signal: null, result: { subtype: 'success', is_error: false }, exit_unreported: expect.stringMatching(/its output ended .* and no exit was reported/) });
    // Killed all the same (whatever is left of it), and never polled again once its output ended: no fault fires into it.
    expect(kills.length).toBeGreaterThanOrEqual(1);
    const pollsAfter = polls;
    await new Promise((r) => setTimeout(r, 100));
    expect(polls).toBe(pollsAfter);
  }, 20_000);

  it('cuts off output a straggler still holds once the session has exited, keeping its exit', async () => {
    const child = fakeChild();
    const t0 = Date.now();
    const ended = superviseSession({ child, out: sink(), err: sink(), prompt: 'p', deadline: Date.now() + 600_000, pollMs: 20, poll: () => null, onText: () => {}, kill: () => {}, drainMs: 300 });
    child.emit('exit', 3, null);
    const s = await ended;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(s).toMatchObject({ ended_by: 'exit', exit_code: 3, signal: null });
    expect(s.exit_unreported).toBeUndefined();
  }, 20_000);

  it('ends a session that exits and closes as it did, its stream read to the last line', async () => {
    const child = fakeChild();
    const lines: string[] = [];
    const ended = superviseSession({ child, out: sink(), err: sink(), prompt: 'p', deadline: Date.now() + 600_000, pollMs: 20, poll: () => null, onText: (t: string) => lines.push(t), kill: () => {} });
    child.stdout.end('{"type":"system"}\n{"type":"result","subtype":"success","is_error":false,"num_turns":2}');
    child.stderr.end();
    await new Promise((r) => setImmediate(r));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const s = await ended;
    expect(s).toMatchObject({ ended_by: 'exit', exit_code: 0, signal: null });
    expect(s.exit_unreported).toBeUndefined();
    expect(lines.join('')).toBe('{"type":"system"}\n{"type":"result","subtype":"success","is_error":false,"num_turns":2}');
  }, 20_000);

  it('still ends a session past its deadline as budget, and one that never answers its stop within the grace', async () => {
    const child = fakeChild();
    const kills: number[] = [];
    const t0 = Date.now();
    const s = await superviseSession({ child, out: sink(), err: sink(), prompt: 'p', deadline: Date.now() + 200, pollMs: 20, poll: () => null, onText: () => {}, kill: () => kills.push(Date.now() - t0), stopRetryMs: 100, stopGraceMs: 500 });
    expect(s).toMatchObject({ ended_by: 'budget', exit_code: null, exit_unreported: expect.stringMatching(/after it was stopped \(budget\)/) });
    expect(kills[0]).toBeGreaterThanOrEqual(150);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 20_000);
});

describe('what a session left in its process group is found off Linux too', () => {
  it('reads the members of a process group from macOS ps, zombies and exiting processes aside', () => {
    // `ps -A -o pid=,pgid=,stat=,command=` as macOS prints it: right-aligned numbers, BSD state letters.
    const ps = [
      '    1     1 Ss   /sbin/launchd',
      '  812   812 Ss   /usr/local/bin/node /tmp/fake-mycelink-host.mjs --plugin-dir /tmp/p',
      '  815   812 S    node /tmp/p/bin/mycelink.mjs hook tool-end',
      '  816   812 R+   git -C /tmp/ws commit -q -m test',
      '  817   812 Z    (git)',
      '  818   812 RE   /bin/sleep 61.25',
      '  900   900 S    /bin/sleep 5',
      '',
    ].join('\n');
    expect(psGroupMembers(ps, 812)).toEqual([
      { pid: 812, cmd: '/usr/local/bin/node /tmp/fake-mycelink-host.mjs --plugin-dir /tmp/p' },
      { pid: 815, cmd: 'node /tmp/p/bin/mycelink.mjs hook tool-end' },
      { pid: 816, cmd: 'git -C /tmp/ws commit -q -m test' },
    ]);
    expect(psGroupMembers(ps, 900)).toEqual([{ pid: 900, cmd: '/bin/sleep 5' }]);
    expect(psGroupMembers(ps, 4242)).toEqual([]);
    expect(psGroupMembers('', 812)).toEqual([]);
  });
});

const FAKE_HOST = join(REPO_ROOT, 'tests', 'benchmark', 'fake-mycelink-host.mjs');
afterAll(() => cleanupTmpRoots());

/**
 * The stand-in host run on its own, as a with-arm session runs it: a workspace for its cwd, a plugin directory
 * (`bin`, `hooks`), its plan, a task prompt on stdin. Resolves to its exit, stderr, wall-clock and trace.
 */
async function standIn({ plan = {}, bin = 'process.exit(0);\n', hooks = null as any, files = {} as Record<string, string>, timeoutMs = 60_000 }) {
  const root = makeTmpDir('bench-standin-');
  const ws = join(root, 'workspace');
  const plugin = join(root, 'plugin');
  const home = join(root, 'home');
  for (const d of [ws, join(plugin, 'bin'), join(plugin, 'hooks'), home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(plugin, 'bin', 'mycelink.mjs'), bin);
  writeFileSync(join(plugin, 'hang.mjs'), 'setInterval(() => {}, 1000);\n');
  if (hooks) writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify(hooks));
  // More of its world, by path from the root: a control plane already set up, a plugin script.
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const log = join(root, 'log.jsonl');
  writeFileSync(log, '');
  const file = join(root, 'plan.json');
  writeFileSync(file, JSON.stringify({ log, work: { 'mod-a': { tests: {}, impl: {} } }, regression: {}, ...plan }));
  const t0 = Date.now();
  const child = spawn(process.execPath, [FAKE_HOST, '--plugin-dir', plugin], { cwd: ws, env: { ...process.env, FAKE_CLAUDE_PLAN: file, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (c) => (stderr += c));
  child.stdin.end('Implement TOY-001.\n');
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.on('exit', (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  const traceFile = join(root, 'host-trace.jsonl');
  const trace = existsSync(traceFile) ? readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code, stderr, ms: Date.now() - t0, trace, root };
}

describe('the stand-in host waits on nothing without a bound, and says what did not answer', () => {
  it('a stall nobody stops fails within its bound: never carried on as if it had been interrupted', async () => {
    const r = await standIn({ plan: { taskStalls: ['start'], stopWaitMs: 1500 } });
    expect(r.code, r.stderr).toBe(86);
    expect(r.ms).toBeLessThan(30_000);
    expect(r.stderr).toMatch(/waited 1500 ms at start to be stopped; nothing stopped this session/);
    expect(r.trace.map((e: any) => e.ev)).toEqual(['start', 'await-stop', 'stop-unanswered', 'exit']);
  }, 60_000);

  it('a hook past its declared timeout is killed, and the session fails on it instead of hanging', async () => {
    const hooks = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hang.mjs"', timeout: 1 }] }] } };
    const r = await standIn({ hooks });
    expect(r.code, r.stderr).toBe(87);
    expect(r.ms).toBeLessThan(30_000);
    expect(r.stderr).toMatch(/the PreToolUse hook .*hang\.mjs.* ran past its 1 s timeout/);
    expect(r.trace.find((e: any) => e.ev === 'hook-timeout')).toMatchObject({ event: 'PreToolUse', timeout_ms: 1000 });
  }, 60_000);

  it('a call past Claude Code’s Bash timeout is killed, shown timed out, and the session fails on it instead of hanging', async () => {
    const r = await standIn({ plan: { bashTimeoutMs: 1500 }, bin: 'setInterval(() => {}, 1000);\n' });
    expect(r.code, r.stderr).toBe(88);
    expect(r.ms).toBeLessThan(30_000);
    expect(r.stderr).toMatch(/ran past the 1500 ms Bash timeout/);
    expect(r.trace.find((e: any) => e.ev === 'call-timeout')).toMatchObject({ timeout_ms: 1500 });
  }, 60_000);
});

/**
 * A hook's payload, as the stand-in host hands it over: CI 38618387236's PCM-103 shape (macOS, Node 22.12.0) failed on
 * a PostToolUse Agent hook killed at its 15 s timeout, on a runner running nothing else. The hook's own work takes a
 * quarter of a second there. Its payload (the worker's prompt, 15 KiB) went to its stdin through spawnSync's `input`:
 * a socketpair of 8 KiB on macOS under Node 22's libuv (64 KiB under Node 24's, so one write there), which macOS can
 * leave with every byte delivered and never its end — the hook waits for EOF until it is killed. Only the Agent
 * payloads exceed 8 KiB; the run hung forever before the hooks were bounded (CI 38533631962). Handed over as a finished
 * file, a payload has no end the host must deliver while the hook runs: the hook's bound is its own run, whatever the
 * payload's size, and a hook that still does not end is killed at it.
 */
describe('the stand-in host hands each hook its payload whole, so the hook’s bound is its own run', () => {
  const PROMPT = 256 * 1024;
  /** Reads its stdin in `chunk`-byte reads, `pause` ms apart; says what it read, and how; then ends, or hangs. */
  const PROBE = String.raw`import { appendFileSync, fstatSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [chunk, pause, then] = process.argv.slice(2);
const out = join(dirname(fileURLToPath(import.meta.url)), 'probe.jsonl');
const say = (o) => appendFileSync(out, JSON.stringify(o) + '\n');
const st = fstatSync(0);
const parts = [];
const buf = Buffer.alloc(Number(chunk));
const t0 = Date.now();
try {
  for (;;) {
    let n = 0;
    try { n = readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code !== 'EOF') throw e; }
    if (n === 0) break;
    parts.push(Buffer.from(buf.subarray(0, n)));
    if (Number(pause) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(pause));
  }
} catch (e) {
  say({ file: st.isFile(), read: Buffer.concat(parts).length, error: String(e.code ?? e.message) });
  process.exit(1);
}
const bytes = Buffer.concat(parts);
const p = JSON.parse(bytes.toString('utf8'));
say({ file: st.isFile(), size: st.isFile() ? st.size : null, read: bytes.length, tool: p.tool_name ?? null, prompt: p.tool_input?.prompt?.length ?? null, ms: Date.now() - t0 });
if (then === 'hang') setInterval(() => {}, 1000);
`;
  /** A Mycelink that has set up its control plane and dispatches one worker ticket with a 256 KiB prompt. */
  const BIN = String.raw`const a = process.argv.slice(2);
if (a[0] === 'controller') process.stdout.write(JSON.stringify({ authority: 'stand-in-key' }));
else if (a[0] === 'dispatch') process.stdout.write(JSON.stringify({ status: 'DISPATCHED', ticket: { kind: 'module-worker', agent: 'mycelink:module-worker', node_id: 'TOY-001.mod-a.impl', capability: 'stand-in', worktree: process.cwd(), gate_commands: [], prompt: 'p'.repeat(${PROMPT}) } }));
`;
  const SET_UP = { 'workspace/platform/mycelink.config.json': '{}\n', 'workspace/platform/repositories.yaml': 'toyshop\n', 'workspace/platform/features/TOY-001/STATE.json': '{}\n', 'plugin/probe.mjs': PROBE };
  const agentHook = (args: string, timeout: number) => ({ hooks: { PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/probe.mjs" ${args}`, timeout }] }] } });
  const probed = (root: string) => readFileSync(join(root, 'plugin', 'probe.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const hookEnd = (trace: any[]) => trace.find((e: any) => e.ev === 'child-end' && e.label === 'hook PreToolUse Agent');

  it('a hook reads its payload from a finished file holding all of it: no stream the host must still end while the hook runs', async () => {
    const r = await standIn({ bin: BIN, hooks: agentHook('65536 0 exit', 15), files: SET_UP });
    expect(probed(r.root), r.stderr).toEqual([{ file: true, size: expect.any(Number), read: expect.any(Number), tool: 'Agent', prompt: PROMPT, ms: expect.any(Number) }]);
    const [p] = probed(r.root);
    expect(p.read).toBe(p.size);
    expect(p.read).toBeGreaterThan(PROMPT);
    expect(hookEnd(r.trace)).toMatchObject({ status: 0 });
    expect(hookEnd(r.trace).timed_out).toBeUndefined();
    expect(r.trace.some((e: any) => e.ev === 'hook-timeout')).toBe(false);
  }, 60_000);

  it('a slow hook that keeps reading is let finish within its declared timeout, and its session goes on past it', async () => {
    const r = await standIn({ bin: BIN, hooks: agentHook('16384 120 exit', 10), files: SET_UP });
    const [p] = probed(r.root);
    expect(p, r.stderr).toMatchObject({ file: true, tool: 'Agent', prompt: PROMPT });
    expect(p.read).toBe(p.size);
    expect(p.ms).toBeGreaterThanOrEqual(1500);
    expect(hookEnd(r.trace)).toMatchObject({ status: 0 });
    expect(hookEnd(r.trace).ms).toBeGreaterThanOrEqual(1500);
    expect(r.trace.some((e: any) => e.ev === 'hook-timeout')).toBe(false);
    expect(r.code).not.toBe(87);
    // Past the hook: the session ran the worker the ticket names (which this stand-in Mycelink gives no gates).
    expect(r.trace.slice(r.trace.indexOf(hookEnd(r.trace)) + 1).map((e: any) => e.ev)).toContain('error');
  }, 60_000);

  it('a hook that has all of its payload and still does not end is killed at its timeout, and the session fails saying so', async () => {
    const r = await standIn({ bin: BIN, hooks: agentHook('65536 0 hang', 2), files: SET_UP });
    expect(r.code, r.stderr).toBe(87);
    expect(r.ms).toBeLessThan(30_000);
    expect(r.stderr).toMatch(/the PreToolUse hook .*probe\.mjs.* ran past its 2 s timeout/);
    const [p] = probed(r.root);
    expect(p).toMatchObject({ file: true, tool: 'Agent', prompt: PROMPT });
    expect(p.read).toBe(p.size);
    expect(hookEnd(r.trace)).toMatchObject({ timed_out: true });
    // What did not answer, and that it had everything it was given: its payload's size.
    expect(r.trace.find((e: any) => e.ev === 'hook-timeout')).toMatchObject({ event: 'PreToolUse', tool: 'Agent', timeout_ms: 2000, input_bytes: p.size });
  }, 60_000);
});
