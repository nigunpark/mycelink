import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { fenceDecision } from '../../src/hooks/fence.js';

afterAll(() => cleanupTmpRoots());

async function preToolUse(cwd: string, tool_name: string, tool_input: Record<string, unknown>) {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdin: JSON.stringify({ session_id: 'codex-thread', turn_id: 'turn-1', hook_event_name: 'PreToolUse', cwd, tool_name, tool_input }),
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  };
  const code = await main(['hook', 'controller-fence'], io);
  return { code, out, err };
}

describe('Codex hook calls cannot silently bypass the Claude fence', () => {
  it('blocks Codex apply_patch targeting a worker result slot even without an agent identity', async () => {
    const root = makeTmpDir('codex-fence-');
    mkdirSync(join(root, '.mycelink', 'worktrees', 'worker', '.mycelink-worker'), { recursive: true });
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    const target = join(root, '.mycelink', 'worktrees', 'worker', '.mycelink-worker', 'result.json');
    const r = await preToolUse(root, 'apply_patch', { command: `*** Begin Patch\n*** Add File: ${target}\n+{}\n*** End Patch` });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/Blocked:.*Codex|Blocked:.*unclassified/i) });
  });

  it('blocks unclassified MCP tools in a Mycelink workspace instead of assuming read-only', async () => {
    const root = makeTmpDir('codex-mcp-fence-');
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    const r = await preToolUse(root, 'mcp__filesystem__write_file', { path: join(root, 'features', 'F-1', 'STATE.json'), content: '{}' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/Blocked:.*unclassified/i) });
  });

  it('does not intercept unrelated projects', async () => {
    const root = makeTmpDir('unrelated-codex-');
    const r = await preToolUse(root, 'apply_patch', { command: '*** Begin Patch\n*** End Patch' });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });

  it('returns a Codex-native JSON denial for an unsafe shell command', async () => {
    const root = makeTmpDir('codex-shell-fence-');
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    const r = await preToolUse(root, 'Bash', { command: `echo forged > "${join(root, '.mycelink', 'worktrees', 'worker', '.mycelink-worker', 'result.json')}"` });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/^Blocked:/) } });
  });

  it('does not let an unverified Codex subagent role become a Claude worker', async () => {
    const root = makeTmpDir('codex-role-fence-');
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    const r = await preToolUse(root, 'spawn_agent', { prompt: 'do the work', subagent_type: 'module-worker' });
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it.each(['.codex/config.toml', '.codex-plugin/plugin.json'])('protects %s from Codex Bash writes', async (relativePath) => {
    const root = makeTmpDir('codex-control-fence-');
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    const r = await preToolUse(root, 'Bash', { command: `echo disable > "${join(root, relativePath)}"` });
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('protects plugin control paths even from a Claude worker in an otherwise writable worktree', () => {
    const root = makeTmpDir('worker-host-config-');
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    const worktree = join(root, '.mycelink', 'worktrees', 'worker');
    mkdirSync(worktree, { recursive: true });
    for (const target of ['.codex/config.toml', '.codex-plugin/plugin.json']) {
      const decision = fenceDecision({ tool_name: 'Write', tool_input: { file_path: join(worktree, target), content: 'unsafe' }, cwd: worktree }, { MYCELINK_NODE_ID: 'F-1.worker' });
      expect(decision).toMatchObject({ ok: false, reason: expect.stringMatching(/protected Codex host configuration/) });
    }
  });

  it('returns a structured denial for a malformed Codex Bash payload in a managed workspace', async () => {
    const root = makeTmpDir('codex-malformed-');
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    const r = await preToolUse(root, 'Bash', {});
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
