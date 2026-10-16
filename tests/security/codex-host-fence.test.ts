import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { main, type CliIo } from '../../src/cli/cli.js';

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
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Blocked:.*Codex|Blocked:.*unclassified/i);
    expect(r.out).toBe('');
  });

  it('blocks unclassified MCP tools in a Mycelink workspace instead of assuming read-only', async () => {
    const root = makeTmpDir('codex-mcp-fence-');
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    const r = await preToolUse(root, 'mcp__filesystem__write_file', { path: join(root, 'features', 'F-1', 'STATE.json'), content: '{}' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Blocked:.*unclassified/i);
  });

  it('does not intercept unrelated projects', async () => {
    const root = makeTmpDir('unrelated-codex-');
    const r = await preToolUse(root, 'apply_patch', { command: '*** Begin Patch\n*** End Patch' });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});
