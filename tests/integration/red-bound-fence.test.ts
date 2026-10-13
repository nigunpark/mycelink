/**
 * The plugin's PreToolUse fence keeps a module-worker's RED-bound test files
 * byte-identical once production has begun (CSET-203 r4: AC-5's regression
 * test appended after the code to the file AC-3's RED bound changes the RED's
 * blob, and settle refuses the history). The fence names the file, its bound
 * blob and the two honest routes — a new test file for a compatibility test,
 * or `tdd cycle` to declare a new complete RED cycle in that file. Settle
 * stays authoritative: the fence only refuses early what settle would.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { CLI, CLI_COMPAT_TESTS, CLI_SRC, CLI_TESTS, CLI_TRUNCATED_IMPL, CLI_TRUNCATED_RED, VER_FEATURE, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { commit, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { GAP_AC1, GAP_AC3, GAP_AC5, dispatch, repairArp, reviewed } from '../helpers/cset203-rework.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = join(process.cwd(), 'bin', 'mycelink.mjs');
const WORKER = 'mycelink:module-worker';

/** One tool call of the cli's module-worker through the shipped launcher's fence: null when allowed, else the reason. */
function fence(s: Ver, tool: string, input: Record<string, unknown>): string | null {
  const r = spawnSync(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], {
    input: JSON.stringify({ session_id: 'host-session', agent_id: 'a1b2c3d4e5f60718', agent_type: WORKER, cwd: s.control, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status === 0) return null;
  if (r.status === 2) return r.stderr.trim();
  throw new Error(`the fence failed: ${r.status} ${r.stderr}`);
}

async function cliTicket(): Promise<{ s: Ver; t: ShopTicket }> {
  const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
  await repairArp(s);
  const t = (await dispatch(s)).ticket!;
  expect(t.node_id).toBe(CLI);
  return { s, t };
}

const editOf = (t: ShopTicket, path: string): Record<string, unknown> => ({ file_path: join(t.worktree, path), old_string: '});\n', new_string: "});\n\ntest('more', () => {});\n" });

describe("a module-worker's RED-bound test file after production began", () => {
  it('may change before production (the red gate runs again), is refused once production began, and a new test file never is', async () => {
    const { s, t } = await cliTicket();
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    expect(runGate(t, 'red', s.control).code).toBe(0);
    // Before production: changing the RED's test means running red again; allowed.
    expect(fence(s, 'Edit', editOf(t, CLI_TESTS))).toBeNull();
    commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3');
    // Production begins: the bound file stays as the RED ran it.
    writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    const blob = git(t.worktree, ['rev-parse', `HEAD:${CLI_TESTS}`]);
    const refused = fence(s, 'Edit', editOf(t, CLI_TESTS));
    expect(refused).toMatch(/^Blocked/);
    expect(refused).toContain(CLI_TESTS);
    expect(refused).toContain(blob.slice(0, 12));
    expect(refused).toMatch(/new test file/);
    expect(refused).toMatch(/tdd cycle/);
    expect(fence(s, 'Write', { file_path: join(t.worktree, CLI_TESTS), content: 'x' })).toMatch(/^Blocked/);
    expect(fence(s, 'Bash', { command: `cat >> "${join(t.worktree, CLI_TESTS).replace(/\\/g, '/')}" <<'EOF'\ntest('more', () => {});\nEOF` })).toMatch(/^Blocked/);
    // A compatibility test in a file no RED bound, and production files, stay the worker's.
    expect(fence(s, 'Write', { file_path: join(t.worktree, CLI_COMPAT_TESTS), content: '// new' })).toBeNull();
    expect(fence(s, 'Edit', editOf(t, CLI_SRC))).toBeNull();
    // After the production commit and green, the same.
    expect(runGate(t, 'green', s.control).code).toBe(0);
    commit(t.worktree, [CLI_SRC], 'fix(cli): AC-3');
    expect(fence(s, 'Edit', editOf(t, CLI_TESTS))).toMatch(/^Blocked/);
  });

  it('`tdd cycle` declares a new complete RED cycle: the bound file may change for its RED, and the next accepted RED binds it anew', async () => {
    const { s, t } = await cliTicket();
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    expect(runGate(t, 'red', s.control).code).toBe(0);
    commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3');
    // Declaring before any production is refused: the RED's test may still change, red runs again.
    const line = t.gate_commands.find((g) => g.gate === 'red')!.command.replace(/ tdd red /, ' tdd cycle ');
    const early = spawnSync(line, { cwd: s.control, shell: true, encoding: 'utf8' });
    expect(early.status).not.toBe(0);
    expect(`${early.stdout}${early.stderr}`).toMatch(/CYCLE_NOT_NEEDED/);
    writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(t, 'green', s.control).code).toBe(0);
    commit(t.worktree, [CLI_SRC], 'fix(cli): AC-3');
    expect(fence(s, 'Edit', editOf(t, CLI_TESTS))).toMatch(/^Blocked/);
    const declared = spawnSync(line, { cwd: s.control, shell: true, encoding: 'utf8' });
    expect(declared.status, `${declared.stdout}${declared.stderr}`).toBe(0);
    expect(verState(s).nodes[CLI].claim.cycle_declared).toMatchObject({ head_sha: git(t.worktree, ['rev-parse', 'HEAD']) });
    expect(fence(s, 'Edit', editOf(t, CLI_TESTS))).toBeNull();
    // The new cycle's RED, accepted, binds the file anew and ends the declaration.
    writeFiles(t.worktree, { [CLI_TESTS]: `${CLI_TRUNCATED_RED}\ntest('a second journal kill is recovered from too', () => { throw new Error('not yet'); });\n` });
    expect(runGate(t, 'red', s.control).code).toBe(0);
    expect(verState(s).nodes[CLI].claim.cycle_declared ?? null).toBeNull();
  });

  it('the controller is fenced out of worktrees as before, and a worker of another feature path is not judged by this node', async () => {
    const { s, t } = await cliTicket();
    const r = spawnSync(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], {
      input: JSON.stringify({ session_id: 'host-session', cwd: s.control, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: editOf(t, CLI_TESTS) }),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/controller never writes/);
    // Status reads still work while a claim is live.
    expect((await verCli(s, ['feature', 'status', VER_FEATURE, '--json'])).code).toBe(0);
  });
});
