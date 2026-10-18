import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { makeGitRepo } from '../helpers/git-fixture.js';
import { minimalPack, writePack } from '../helpers/context-pack.js';
import type { SpawnRequest } from '../../src/sessions/adapter.js';

const fixture = resolve(process.cwd(), 'tests/fake-codex/codex.mjs');
afterAll(() => cleanupTmpRoots());

function setup(scenario: Record<string, unknown>, overrides: Partial<SpawnRequest> = {}) {
  const root = makeTmpDir('codex-adapter-');
  const cwd = join(root, 'worktree');
  makeGitRepo(cwd, { files: { 'src/app.js': 'old\n' } });
  const contextPackPath = join(root, 'pack.json');
  writePack(contextPackPath, minimalPack());
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const request: SpawnRequest = {
    featureId: 'FEAT-101', nodeId: 'FEAT-101.core.publish.impl', claimId: 'claim-1', attempt: 1,
    cwd, contextPackPath, resultPath: join(root, 'result.json'), logPath: join(root, 'stream.jsonl'),
    model: 'gpt-test', maxTurns: 10, maxWallClockMs: 30_000, stallMs: 10_000,
    env: { FAKE_CODEX_SCENARIO: scenarioPath }, ...overrides,
  };
  return request;
}

async function run(scenario: Record<string, unknown>, overrides: Partial<SpawnRequest> = {}) {
  const module = await import('../../src/sessions/codex-cli-adapter.js').catch(() => null);
  expect(module?.CodexCliAdapter).toBeTypeOf('function');
  if (!module) throw new Error('Codex adapter absent');
  const adapter = new module.CodexCliAdapter({ executable: process.execPath, prefixArgs: [fixture] });
  const request = setup(scenario, overrides);
  request.env = { ...request.env, FAKE_CODEX_SCENARIO: join(dirname(request.resultPath), 'scenario.json') };
  const handle = adapter.spawn(request);
  return { adapter, request, handle, observation: await adapter.wait(handle) };
}

describe('isolated Codex session using fake executable', () => {
  it('reads prompt on stdin, captures a schema-bound result and usage without inlining stream as authority', async () => {
    const { request, handle, observation } = await run({ result: { outcome: 'SUBMITTED' }, usage: { input_tokens: 42, output_tokens: 9 } });
    expect(handle.adapter).toBe('codex-cli');
    expect(observation.status).toBe('done');
    expect(observation.turns).toBe(1);
    expect(observation.usage).toMatchObject({ input_tokens: 42, output_tokens: 9 });
    expect(observation.result).toMatchObject({ node_id: request.nodeId, claim_id: request.claimId, outcome: 'SUBMITTED' });
    expect(readFileSync(request.logPath, 'utf8')).toContain('"type":"turn.completed"');
    const prompt = readFileSync(join(request.cwd, 'prompt-captured.txt'), 'utf8');
    expect(prompt).toContain('Result file: .mycelink-worker/result.json');
    expect(prompt).toContain('Codex worker');
    expect(prompt).not.toContain('pre-approved');
    expect(prompt).not.toContain('Bash tool');
  });

  it('fails closed when result is missing or malformed even after exit zero', async () => {
    for (const scenario of [{ omit_result: true }, { malformed_result: true }]) {
      const { observation } = await run(scenario);
      expect(observation.status).toBe('failed');
      expect(observation.result).toBeNull();
      expect(observation.failure_reason).toMatch(/^RESULT_(MISSING|SCHEMA_INVALID|UNREADABLE)/);
    }
  });

  it('fails on provider turn failure despite a forged valid result and exit zero', async () => {
    const { observation } = await run({ result: { outcome: 'SUBMITTED' }, failure: 'model provider unavailable', exit_code: 0 });
    expect(observation.status).toBe('failed');
    expect(observation.failure_reason).toMatch(/model provider unavailable/);
  });

  it('does not accept a result without a completed Codex turn', async () => {
    const { observation } = await run({ result: { outcome: 'SUBMITTED' }, omit_completion: true, exit_code: 0 });
    expect(observation.status).toBe('failed');
    expect(observation.failure_reason).toMatch(/PROVIDER_STREAM_INCOMPLETE/);
  });

  it('redacts environment secrets from a provider failure surfaced to the controller', async () => {
    const secret = 'sensitive-injected-test-token-4839';
    const { observation } = await run({ failure: `provider rejected ${secret}`, exit_code: 1 }, { env: { SECRET_TOKEN: secret } });
    expect(observation.status).toBe('failed');
    expect(observation.failure_reason).not.toContain(secret);
  });

  it('stops, times out and rejects stale results across a retry', async () => {
    const stalled = setup({ stall_ms: 30_000 }, { maxWallClockMs: 350, stallMs: 60_000 });
    const module = await import('../../src/sessions/codex-cli-adapter.js');
    const adapter = new module.CodexCliAdapter({ executable: process.execPath, prefixArgs: [fixture] });
    const first = await adapter.wait(adapter.spawn(stalled));
    expect(first.status).toBe('budget-exhausted');
    expect(first.timed_out).toBe(true);
    const cancelled = setup({ stall_ms: 30_000 });
    const handle = adapter.spawn(cancelled);
    adapter.stop(handle);
    expect((await adapter.wait(handle)).status).toBe('stopped');
    const retry = await run({ result: { outcome: 'SUBMITTED' } });
    expect(retry.observation.status).toBe('done');
  });

  it('does not accept a stale controller result when the executable is missing', async () => {
    const module = await import('../../src/sessions/codex-cli-adapter.js');
    const request = setup({});
    writeFileSync(request.resultPath, '{"outcome":"SUBMITTED"}');
    const adapter = new module.CodexCliAdapter({ executable: join(request.cwd, 'missing') });
    const observation = await adapter.wait(adapter.spawn(request));
    expect(observation.status).toBe('failed');
    expect(observation.result).toBeNull();
    expect(existsSync(request.resultPath)).toBe(false);
  });
});
