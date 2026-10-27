import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnRequest } from '../../src/sessions/adapter.js';
import { minimalPack, packCriterion } from '../helpers/context-pack.js';

const request = { cwd: join(tmpdir(), 'isolated worker'), model: 'gpt-test', gateCommands: [{ gate: 'red', argv: ['node', '--test'] }] } as SpawnRequest;

describe('Codex CLI adapter contract', () => {
  it('documents the exact PRE-RED probe command, budget, and lack of acceptance authority', async () => {
    const { CodexCliAdapter } = await import('../../src/sessions/codex-cli-adapter.js');
    const adapter = new CodexCliAdapter({ executable: 'codex' });
    const pack = minimalPack();
    const claimChannel: NonNullable<SpawnRequest['claimChannel']> = {
      handle: () => ({ ok: false, sequence: null, code: 'CHANNEL_PROBE_UNAVAILABLE' }), probeEnabled: true,
    };
    const mediated = { ...request, claimId: 'claim-1', claimChannel } as SpawnRequest;
    const prompt = (adapter as unknown as { workerPrompt: (pack: typeof pack, request: SpawnRequest) => string }).workerPrompt(pack, mediated);
    expect(prompt).toContain('node .mycelink-worker/channel-claim-1/client.mjs probe');
    expect(prompt).toMatch(/(?:3|three) probe/i);
    expect(prompt).toMatch(/probe[^\n]*(?:before|pre-)[^\n]*RED/i);
    expect(prompt).toMatch(/probe[^\n]*diagnostic/i);
    expect(prompt).toMatch(/probe[^\n]*(?:not|never|no)[^\n]*criterion_evidence/i);
    expect(prompt).toMatch(/probe[^\n]*(?:not|never|no)[^\n]*(?:production|source)[^\n]*(?:edit|permission)/i);
    expect(prompt).toMatch(/probe[^\n]*(?:not|never|no)[^\n]*test[^\n]*commit/i);
    expect(prompt).toMatch(/(?:exactly one|once|one)[^\n]*(?:real|gate)[^\n]*RED/i);
  });

  it('gives a mediated worker the exact one-pass TDD order including compatibility evidence', async () => {
    const { CodexCliAdapter } = await import('../../src/sessions/codex-cli-adapter.js');
    const adapter = new CodexCliAdapter({ executable: 'codex' });
    const pack = minimalPack({ acceptance_criteria: [
      packCriterion('AC-4', 'Invalid inputs print one validation error.'),
      packCriterion('AC-5', 'Valid outputs stay identical.', 'compatibility'),
    ] });
    const mediated = { ...request, claimId: 'claim-1', claimChannel: {} as NonNullable<SpawnRequest['claimChannel']> } as SpawnRequest;
    const prompt = (adapter as unknown as { workerPrompt: (pack: typeof pack, request: SpawnRequest) => string }).workerPrompt(pack, mediated);
    expect(prompt).toMatch(/RED.*test-only commit.*GREEN once.*source-only commit.*regression once/i);
    expect(prompt).toMatch(/compatibility tests before RED/i);
    expect(prompt).toMatch(/never request a second GREEN/i);
  });

  it('constructs explicit, safe non-interactive argv with stdin prompt, not shell arguments', async () => {
    const module = await import('../../src/sessions/codex-cli-adapter.js').catch(() => null);
    expect(module?.CodexCliAdapter).toBeTypeOf('function');
    if (!module) return;
    const adapter = new module.CodexCliAdapter({ executable: 'codex' });
    expect(adapter.buildArgs(request, 'session')).toEqual([
      'exec', '--json', '--cd', request.cwd, '--sandbox', 'workspace-write', '--model', request.model, '-',
    ]);
    expect(adapter.gateLines(request)).toEqual([{ gate: 'red', line: 'node --test' }]);
    expect(adapter.buildArgs({ ...request, model: 'codex-default' }, 'session')).toEqual([
      'exec', '--json', '--cd', request.cwd, '--sandbox', 'workspace-write', '-',
    ]);
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

  it('selects native Windows MXC only for explicitly opted-in disposable workers', async () => {
    const { CodexCliAdapter } = await import('../../src/sessions/codex-cli-adapter.js');
    const defaults = new CodexCliAdapter({ executable: 'codex' }).buildArgs(request, 'id');
    const opted = new CodexCliAdapter({ executable: 'codex', disposableRepositories: true }).buildArgs(request, 'id');
    expect(defaults).not.toContain('windows.sandbox=mxc');
    expect(opted).toEqual(process.platform === 'win32'
      ? ['exec', '--json', '--cd', request.cwd, '--sandbox', 'workspace-write', '-c', 'windows.sandbox=mxc', '--model', request.model, '-']
      : defaults);
    expect(opted).not.toContain('danger-full-access');
    expect(opted).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(() => new CodexCliAdapter({ executable: 'codex', disposableRepositories: true, extraArgs: ['-c', 'windows.sandbox=disabled'] })).toThrow(/CODEX_ARGS_DENIED/);
  });

  it.skipIf(process.platform !== 'win32')('maps only absolute Windows drive paths and builds a bounded WSL argv without shell interpolation', async () => {
    const { CodexCliAdapter, windowsToWslPath } = await import('../../src/sessions/codex-cli-adapter.js');
    expect(windowsToWslPath('C:\\Users\\<user>\\two repos\\api')).toBe('/mnt/c/Users/<user>/two repos/api');
    for (const bad of ['relative\\repo', '\\\\server\\share', 'C:relative', 'C:\\a\\..\\b', 'C:\\a\nmalicious']) {
      expect(() => windowsToWslPath(bad)).toThrow(/WSL_PATH/);
    }
    const adapter = new CodexCliAdapter({ executable: 'wsl.exe', disposableRepositories: true, wsl: { distribution: 'Ubuntu', user: 'example-user' } });
    expect(adapter.buildArgs({ ...request, cwd: 'C:\\Users\\<user>\\two repos\\api', model: 'codex-default' }, 'id')).toEqual([
      '-d', 'Ubuntu', '-u', 'example-user', '--', '/usr/local/bin/npx', '--yes', '@openai/codex@0.163.0',
      'exec', '--json', '--cd', '/mnt/c/Users/<user>/two repos/api', '--sandbox', 'workspace-write', '-',
    ]);
    expect(() => new CodexCliAdapter({ executable: 'wsl.exe', wsl: { distribution: '--exec', user: 'example-user' } })).toThrow(/WSL_CONFIG/);
  });

  it.skipIf(process.platform !== 'win32')('maps only controller-owned gate path arguments for WSL, retaining literal capability', async () => {
    const { CodexCliAdapter } = await import('../../src/sessions/codex-cli-adapter.js');
    const adapter = new CodexCliAdapter({ executable: 'wsl.exe', disposableRepositories: true, wsl: { distribution: 'Ubuntu', user: 'example-user' } });
    const gates = [{ gate: 'red' as const, argv: ['node', 'C:/scratch/plugin/bin/mycelink.mjs', 'tdd', 'red', 'ORD-101', 'ORD-101.api', '--control-root', 'C:/scratch/control', '--capability', 'literal-value'] }];
    expect(adapter.gateLines({ ...request, gateCommands: gates })).toEqual([{ gate: 'red', line: 'node /mnt/c/scratch/plugin/bin/mycelink.mjs tdd red ORD-101 ORD-101.api --control-root /mnt/c/scratch/control --capability literal-value' }]);
    expect(new CodexCliAdapter({ executable: 'codex' }).gateLines({ ...request, gateCommands: gates })[0]?.line).toContain('C:/scratch/control');
  });

  it.skipIf(process.platform !== 'win32')('trusts only declared disposable Git locations in WSL, never a wildcard', async () => {
    const { CodexCliAdapter } = await import('../../src/sessions/codex-cli-adapter.js');
    const adapter = new CodexCliAdapter({ executable: 'wsl.exe', disposableRepositories: true,
      wsl: { distribution: 'Ubuntu', user: 'example-user' },
      gitTrustRoots: ['C:/scratch/control', 'C:/scratch/orders-api', 'C:/scratch/orders-web'] });
    const argv = adapter.buildArgs({ ...request, cwd: 'C:/scratch/control/worktrees/orders-api__ORD-101.api' }, 'id');
    expect(argv.slice(0, 8)).toEqual(['-d', 'Ubuntu', '-u', 'example-user', '--', '/usr/bin/env', 'GIT_CONFIG_COUNT=4', 'GIT_CONFIG_KEY_0=safe.directory']);
    expect(argv).toContain('GIT_CONFIG_VALUE_0=/mnt/c/scratch/control');
    expect(argv).toContain('GIT_CONFIG_VALUE_1=/mnt/c/scratch/orders-api');
    expect(argv).toContain('GIT_CONFIG_VALUE_2=/mnt/c/scratch/orders-web');
    expect(argv).toContain('GIT_CONFIG_VALUE_3=/mnt/c/scratch/control/worktrees/orders-api__ORD-101.api');
    expect(argv).not.toContain('GIT_CONFIG_VALUE_0=*');
    expect(() => new CodexCliAdapter({ executable: 'wsl.exe', disposableRepositories: true,
      wsl: { distribution: 'Ubuntu', user: 'example-user' }, gitTrustRoots: ['*'] })).toThrow(/WSL_PATH/);
  });

  it('counts completed turns and replacement usage totals, and records top-level provider failure', async () => {
    const module = await import('../../src/sessions/codex-cli-adapter.js').catch(() => null);
    expect(module?.CodexStreamParser).toBeTypeOf('function');
    if (!module) return;
    const parser = new module.CodexStreamParser();
    const progress = { turns: 0, usage: { model_turns: 0, wall_clock_ms: 0, input_tokens: 0, output_tokens: 0, sessions: 0 }, providerFailure: null as string | null };
    parser.consume('{"type":"thread.started","thread_id":"11111111-1111-4111-8111-111111111111"}', progress);
    parser.consume('{"type":"turn.started"}', progress);
    parser.consume('{"type":"item.completed","item":{"id":"one","type":"agent_message","text":"one"}}', progress);
    parser.consume('{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":10}}', progress);
    parser.consume('{"type":"turn.started"}', progress);
    parser.consume('{"type":"item.completed","item":{"id":"two","type":"agent_message","text":"two"}}', progress);
    parser.consume('{"type":"turn.completed","usage":{"input_tokens":90,"output_tokens":20}}', progress);
    parser.consume('{"type":"turn.started"}', progress);
    expect(progress.turns).toBe(2);
    expect(progress.usage).toMatchObject({ input_tokens: 90, output_tokens: 20 });
    parser.consume('{"type":"turn.failed","error":{"message":"authentication failed"}}', progress);
    expect(progress.providerFailure).toMatch(/turn.failed \(unclassified\)/);
  });
});
