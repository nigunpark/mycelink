/**
 * Who ran a call, and what it may have changed (CSET-202 final).
 *
 * CSET-202's latest with arm was stopped twice for a stash its own
 * module-workers pushed and popped in their worktrees: each time the host sat
 * in `sleep 100; echo waiting` while its background worker ran, and the
 * transaction took the open host call for the controller's hand in the
 * stash. Overlap is no cause. lib/causal.mjs reads the session's own stream
 * (Claude Code's stdout, as the harness captured it) into a causal tree —
 * every tool call with the Agent call it ran under (`parent_tool_use_id`) and
 * each Agent call's task (`task_started`) — and reads a Bash command the way
 * its shell runs it: which simple commands it executes, and whether any of
 * them may change anything (only waiting, printing and reading provably
 * change nothing); every `git stash` it runs, with the directory it runs in.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without type declarations
import { aliveAt, shellEffects, streamTree } from '../../evals-public-projects/lib/causal.mjs';

const at = { cwd: '/ws/platform', home: '/home/u' };
const changes = (command: string) => shellEffects(command, at).changes as boolean;

describe('what a host command may change', () => {
  it('waiting, printing, reading and looking at Git change nothing — CSET-202’s waits among them', () => {
    for (const command of [
      'sleep 100; echo waiting',
      'sleep 240; cd /ws/platform; ls .mycelink/worktrees/*/.mycelink-worker/ 2>/dev/null',
      'sleep 240; ls /ws/platform/.mycelink/worktrees/w/.mycelink-worker/ 2>&1',
      'sleep 30 && cat /ws/platform/features/F/STATE.json | head -40',
      'while ! test -f /ws/x/done; do sleep 5; done; echo ready',
      'for i in 1 2 3; do sleep 10; ls /ws; done',
      'sleep 5 >/dev/null 2>&1; pwd; date; wc -l /ws/a.txt; grep -n x /ws/a.txt',
      'git -C /ws/repos/r status --short',
      'git -C /ws/repos/r log -1 --format=%H',
      'git -C /ws/repos/r stash list',
      'git -C /ws/repos/r stash show -p stash@{0}',
      'git --no-pager -C /ws/repos/r diff --stat HEAD~1',
      'git -C /ws/repos/r branch --show-current; git -C /ws/repos/r worktree list --porcelain',
      'find /ws/platform/.mycelink -name "result-*.json" -newer /ws/x',
      'echo "$(date) waiting" ; sleep 60',
      'sleep 100 &',
    ]) {
      const e = shellEffects(command, at);
      expect(e, command).toMatchObject({ changes: false, why: null, stash: [] });
    }
  });

  it('text that only names git stash changes nothing: an echo, a printf, a quoted argument, a comment, a heredoc read as data', () => {
    for (const command of [
      'sleep 100; echo "waiting for git stash"',
      "echo 'git stash pop' && sleep 5",
      'printf "%s\\n" "git stash push -q"',
      'sleep 1 # then git stash',
      "cat <<'EOF'\ngit stash\nEOF",
      'grep -n "git stash" /ws/notes.md',
    ]) {
      expect(changes(command), command).toBe(false);
    }
  });

  it('a command that executes git stash, or may run anything, may change it — however it is wrapped', () => {
    for (const [command, why] of [
      ['sleep 100; git stash', /git stash/],
      ['sleep 100 && git -C /ws/repos/r stash push -q -m mine', /git stash/],
      ["sleep 1; bash -c 'git -C /ws/repos/r stash'", /git stash/],
      ['eval "git stash"', /git stash/],
      ['echo git stash | sh', /sh/],
      ['$(echo git) stash', /unknown command/],
      ['G=git; $G stash', /git stash/],
      ["sleep 1; node -e \"require('child_process').execSync('git stash')\"", /node/],
      ['python3 /ws/helper.py', /python3/],
      ['sleep 1 > /ws/out.txt', /writes/],
      ['echo x >> /ws/repos/r/.git/logs/refs/stash', /writes/],
      ['git -c core.fsmonitor=/tmp/x -C /ws/repos/r status', /git -c/],
      ['git -C /ws/repos/r log --output=/ws/repos/r/.git/logs/refs/stash', /--output/],
      ['git -C /ws/repos/r branch topic', /git branch/],
      ['git -C /ws/repos/r update-ref refs/stash HEAD', /git update-ref/],
      ['PATH=/tmp/evil:$PATH ls', /PATH/],
      ["trap 'git stash' EXIT; sleep 1", /trap/],
      // A function it defines (and its body, read as commands).
      ['f() { git stash; }; sleep 1', /runs f|git stash/],
      ['find /ws -name x -exec rm {} \\;', /find/],
      ['echo stash@{0} | xargs git stash drop', /git stash/],
      ['sort -mo /ws/repos/r/.git/packed-refs /ws/a /ws/b', /sort/],
    ] as const) {
      const e = shellEffects(command, at);
      expect(e.changes, command).toBe(true);
      expect(e.why, command).toMatch(why);
    }
  });
});

describe('the git stash a command runs, and where', () => {
  it('follows cd, -C and the command’s own variables to the directory each stash runs in', () => {
    const wt = '/ws/platform/.mycelink/worktrees/r__F.read.impl';
    expect(shellEffects(`cd ${wt} && git stash push -q && node /p/bin/mycelink.mjs tdd cycle F F.read.impl --control-root /ws/platform --capability abc`, at).stash).toEqual([{ sub: 'push', dir: wt, entry: null }]);
    expect(shellEffects(`cd ${wt} && git add packages/read/src/index.test.ts && git commit -qm "test(read): x\n\nCo-Authored-By: C <n@a.invalid>" && git stash pop -q && git status --short && node /p/bin/mycelink.mjs tdd green F F.read.impl`, at).stash).toEqual([{ sub: 'pop', dir: wt, entry: null }]);
    expect(shellEffects(`cd ${wt} && git stash push -q -- packages/read/src/index.ts && node /p/bin/mycelink.mjs tdd red F F.read.impl`, at).stash).toEqual([{ sub: 'push', dir: wt, entry: null }]);
    expect(shellEffects(`W=${wt}; G="git -C $W"; $G stash -q`, at).stash).toEqual([{ sub: 'push', dir: wt, entry: null }]);
    expect(shellEffects(`git -C ${wt} stash pop stash@{1}`, at).stash).toEqual([{ sub: 'pop', dir: wt, entry: 'stash@{1}' }]);
    expect(shellEffects('git stash save draft', { cwd: wt, home: null }).stash).toEqual([{ sub: 'push', dir: wt, entry: null }]);
    expect(shellEffects(`git -C /ws -C platform/.mycelink/worktrees/r__F.read.impl stash drop 1`, at).stash).toEqual([{ sub: 'drop', dir: wt, entry: '1' }]);
    expect(shellEffects(`bash -c 'git -C ${wt} stash'`, at).stash).toEqual([{ sub: 'push', dir: wt, entry: null }]);
    // Where it cannot be told, it is not told.
    expect(shellEffects('git -C "$(pwd)" stash', at).stash).toEqual([{ sub: 'push', dir: null, entry: null }]);
    expect(shellEffects(`git --git-dir=/ws/repos/r/.git stash`, at).stash).toEqual([{ sub: 'push', dir: null, entry: null }]);
    expect(shellEffects(`cd $SOMEWHERE && git stash`, at).stash).toEqual([{ sub: 'push', dir: null, entry: null }]);
    // Reading the stash runs no stash command that changes it.
    expect(shellEffects(`git -C ${wt} stash list && git -C ${wt} stash show`, at).stash).toEqual([]);
  });

  it('a Windows drive path is a directory too', () => {
    expect(shellEffects("git -C 'C:/Users/u/ws/wt' stash -q", { cwd: 'C:\\Users\\u\\ws', home: null }).stash).toEqual([{ sub: 'push', dir: 'C:/Users/u/ws/wt', entry: null }]);
    expect(shellEffects("cd 'C:/Users/u/ws/wt' && git stash pop", { cwd: 'C:\\Users\\u\\ws', home: null }).stash).toEqual([{ sub: 'pop', dir: 'C:/Users/u/ws/wt', entry: null }]);
  });
});

/** A stream as Claude Code 2.1.290 writes it for a host that launches a background worker and waits (CSET-202's shape). */
function cset202Stream() {
  const S = 'sess-1';
  const lines = [
    { type: 'system', subtype: 'init', session_id: S, cwd: '/ws' },
    { type: 'assistant', parent_tool_use_id: null, session_id: S, message: { content: [{ type: 'tool_use', id: 'L1', name: 'Agent', input: { subagent_type: 'mycelink:module-worker', description: 'Node read', prompt: 'Node: F.read\nClaim: c1\nDispatch: d1\n' } }] } },
    { type: 'system', subtype: 'task_started', task_id: 'agent1', tool_use_id: 'L1', is_backgrounded: true, task_type: 'local_agent', session_id: S },
    { type: 'user', parent_tool_use_id: null, session_id: S, message: { content: [{ type: 'tool_result', tool_use_id: 'L1', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] } },
    { type: 'assistant', parent_tool_use_id: null, session_id: S, message: { content: [{ type: 'tool_use', id: 'H1', name: 'Bash', input: { command: 'sleep 100; echo waiting' } }] } },
    { type: 'assistant', parent_tool_use_id: 'L1', session_id: S, message: { content: [{ type: 'tool_use', id: 'W1', name: 'Bash', input: { command: 'cd /wt && git stash push -q' } }] } },
    { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'H1', is_backgrounded: false, task_type: 'local_bash', session_id: S },
    { type: 'tool_progress', tool_use_id: 'H1-heartbeat-0', tool_name: 'Bash', parent_tool_use_id: 'H1', elapsed_time_seconds: 30, session_id: S },
    { type: 'user', parent_tool_use_id: 'L1', session_id: S, message: { content: [{ type: 'tool_result', tool_use_id: 'W1', content: 'ok' }] } },
    { type: 'system', subtype: 'compact_boundary', session_id: S, compact_metadata: { trigger: 'auto' } },
    { type: 'assistant', parent_tool_use_id: 'L1', session_id: S, message: { content: [{ type: 'tool_use', id: 'W2', name: 'Bash', input: { command: 'cd /wt && git stash pop -q' } }] } },
    { type: 'system', subtype: 'task_notification', task_id: 'agent1', tool_use_id: 'L1', status: 'completed', session_id: S },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('the causal tree of a session, from its stream', () => {
  it('each call under the Agent call that ran it; each Agent call’s task; a heartbeat or a compaction changes nothing', () => {
    const t = streamTree(cset202Stream());
    expect(t.session).toBe('sess-1');
    expect(t.uses.get('H1')).toMatchObject({ name: 'Bash', parent: null, input: { command: 'sleep 100; echo waiting' } });
    expect(t.uses.get('W1')).toMatchObject({ name: 'Bash', parent: 'L1' });
    expect(t.uses.get('W2')).toMatchObject({ name: 'Bash', parent: 'L1', ended: null });
    expect(t.uses.get('W1').ended).toEqual(expect.any(Number));
    expect(t.uses.get('L1')).toMatchObject({ name: 'Agent', parent: null });
    // A local Bash task is no agent: only the Agent call's task binds an agent.
    expect([...t.tasks.keys()]).toEqual(['L1']);
    expect(t.tasks.get('L1')).toMatchObject({ task: 'agent1', background: true, status: 'completed', conflict: false });
    expect(t.uses.has('H1-heartbeat-0')).toBe(false);
    expect(t.compactions).toBe(1);
  });

  it('a subagent stopped and resumed by SendMessage is alive again under the Agent call that launched it; one stopped with no resume is not', () => {
    const extra = [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'S1', name: 'SendMessage', input: { to: 'agent1', message: 'go on' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'S1', content: [{ type: 'text', text: '{"success":true,"message":"Resuming agent agent1","resumedAgentId":"agent1"}' }] }] } },
      { type: 'assistant', parent_tool_use_id: 'L1', message: { content: [{ type: 'tool_use', id: 'W3', name: 'Bash', input: { command: 'cd /wt && git stash push -q' } }] } },
    ];
    const base = cset202Stream();
    const stopped = streamTree(base);
    const launch = stopped.uses.get('L1');
    expect(aliveAt(stopped, launch, 'agent1', stopped.uses.get('W2').line)).toBe(true);
    // After its task's notification, nothing runs as it.
    expect(aliveAt(stopped, launch, 'agent1', stopped.lines + 5)).toBe(false);
    const resumed = streamTree(base + extra.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(resumed.resumes.get('agent1')).toEqual([expect.any(Number)]);
    expect(resumed.uses.get('W3')).toMatchObject({ parent: 'L1' });
    expect(aliveAt(resumed, resumed.uses.get('L1'), 'agent1', resumed.uses.get('W3').line)).toBe(true);
    // A resume names one subagent: another stays stopped.
    expect(aliveAt(resumed, resumed.uses.get('L1'), 'agent9', resumed.uses.get('W3').line)).toBe(false);
  });

  it('a call shown twice with another command, or an Agent call bound to two tasks, is in conflict', () => {
    const extra = [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'W1', name: 'Bash', input: { command: 'git stash' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'agent2', tool_use_id: 'L1', task_type: 'local_agent' },
    ];
    const t = streamTree(cset202Stream() + extra.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(t.uses.get('W1').conflict).toBe(true);
    expect(t.tasks.get('L1').conflict).toBe(true);
  });

  it('a line cut short or not JSON is skipped', () => {
    const t = streamTree(`${cset202Stream()}{"type":"assistant","message":{"content":[{"type":"tool_use","id":"X`);
    expect(t.uses.has('X')).toBe(false);
    expect(t.uses.size).toBe(4);
  });
});
