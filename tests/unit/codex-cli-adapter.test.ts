import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnRequest } from '../../src/sessions/adapter.js';

const request = { cwd: join(tmpdir(), 'isolated worker'), model: 'gpt-test', gateCommands: [{ gate: 'red', argv: ['node', '--test'] }] } as SpawnRequest;

describe('Codex CLI adapter contract', () => {
  it('constructs explicit, safe non-interactive argv with stdin prompt, not shell arguments', async () => {
    const module = await import('../../src/sessions/codex-cli-adapter.js').catch(() => null);
    expect(module?.CodexCliAdapter).toBeTypeOf('function');
    if (!module) return;
    const adapter = new module.CodexCliAdapter({ executable: 'codex' });
    expect(adapter.buildArgs(request, 'session')).toEqual([
      'exec', '--json', '--cd', request.cwd, '--sandbox', 'workspace-write', '-c', 'approval_policy=never', '--model', request.model, '-',
    ]);
    expect(adapter.gateLines(request)).toEqual([{ gate: 'red', line: 'node --test' }]);
  });

  it('rejects extra CLI arguments that could override the sandbox or open writable roots', async () => {
    const module = await import('../../src/sessions/codex-cli-adapter.js').catch(() => null);
    expect(module?.CodexCliAdapter).toBeTypeOf('function');
    if (!module) return;
    for (const extraArgs of [['--sandbox', 'danger-full-access'], ['--add-dir', tmpdir()], ['--dangerously-bypass-approvals-and-sandbox'], ['-c', 'approval_policy=on-request']]) {
      expect(() => new module.CodexCliAdapter({ executable: 'codex', extraArgs })).toThrow();
    }
    expect(new module.CodexCliAdapter({ executable: 'codex', sandbox: 'read-only' }).buildArgs(request, 'id')).toContain('read-only');
  });

  it('counts completed turns and replacement usage totals, and records top-level provider failure', async () => {
    const module = await import('../../src/sessions/codex-cli-adapter.js').catch(() => null);
    expect(module?.CodexStreamParser).toBeTypeOf('function');
    if (!module) return;
    const parser = new module.CodexStreamParser();
    const progress = { turns: 0, usage: { model_turns: 0, wall_clock_ms: 0, input_tokens: 0, output_tokens: 0, sessions: 0 }, providerFailure: null as string | null };
    parser.consume('{"type":"turn.started"}', progress);
    parser.consume('{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":10}}', progress);
    parser.consume('{"type":"turn.completed","usage":{"input_tokens":90,"output_tokens":20}}', progress);
    expect(progress.turns).toBe(2);
    expect(progress.usage).toMatchObject({ input_tokens: 90, output_tokens: 20 });
    parser.consume('{"type":"turn.failed","error":{"message":"authentication failed"}}', progress);
    expect(progress.providerFailure).toMatch(/authentication failed/);
  });
});
