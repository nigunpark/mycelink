import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { makeGitRepo } from '../helpers/git-fixture.js';
import { ClaudeCliAdapter } from '../../src/sessions/claude-cli-adapter.js';
import { FakeInProcessAdapter } from '../../src/sessions/fake-adapter.js';
import type { SpawnRequest } from '../../src/sessions/adapter.js';
import { validateAgainstSchema } from '../../src/schema/registry.js';

afterAll(() => cleanupTmpRoots());

const FAKE_CLAUDE = resolve(process.cwd(), 'tests', 'fake-claude', 'claude.mjs');

interface Harness {
  dir: string;
  worktree: string;
  scenarioPath: string;
  resultPath: string;
  logPath: string;
  packPath: string;
}

function harness(scenario: unknown): Harness {
  const dir = makeTmpDir('sess-');
  const worktree = join(dir, 'wt');
  makeGitRepo(worktree, { files: { 'src/app.js': 'v1\n' } });
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario), 'utf8');
  const packPath = join(dir, 'pack.json');
  writeFileSync(packPath, JSON.stringify({ schema_version: 1, node_id: 'N1' }), 'utf8');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  return {
    dir,
    worktree,
    scenarioPath,
    resultPath: join(dir, 'sessions', 'result.json'),
    logPath: join(dir, 'sessions', 'session.log'),
    packPath,
  };
}

function request(h: Harness, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    featureId: 'FEAT-101',
    nodeId: 'FEAT-101.core.publish.impl',
    claimId: 'claim-1',
    attempt: 1,
    contextPackPath: h.packPath,
    cwd: h.worktree,
    resultPath: h.resultPath,
    logPath: h.logPath,
    model: 'sonnet',
    maxTurns: 10,
    maxWallClockMs: 30_000,
    stallMs: 10_000,
    env: { FAKE_CLAUDE_SCENARIO: h.scenarioPath },
    ...overrides,
  };
}

function cliAdapter(): ClaudeCliAdapter {
  return new ClaudeCliAdapter({
    executable: process.execPath,
    prefixArgs: [FAKE_CLAUDE],
    adapterName: 'fake-claude',
  });
}

async function runToCompletion(adapter: ClaudeCliAdapter, req: SpawnRequest) {
  const handle = adapter.spawn(req);
  const observation = await adapter.wait(handle);
  return { handle, observation };
}

describe('Claude CLI session adapter (driven by the fake claude executable)', () => {
  it('spawns a worker, captures usage from stream-json, and reads its result', async () => {
    const h = harness({
      default: { outcome: 'SUBMITTED', turns: 3, write_files: { 'src/app.js': 'v2\n' }, git_commit: 'work' },
    });
    const { handle, observation } = await runToCompletion(cliAdapter(), request(h));

    expect(handle.adapter).toBe('fake-claude');
    expect(handle.session_id).toMatch(/.+/);
    expect(observation.status).toBe('done');
    expect(observation.exit_code).toBe(0);
    expect(observation.turns).toBe(3);
    expect(observation.usage.input_tokens).toBe(300);
    expect(observation.usage.output_tokens).toBe(150);
    expect(observation.usage.wall_clock_ms).toBeGreaterThanOrEqual(0);

    expect(observation.result?.outcome).toBe('SUBMITTED');
    expect(validateAgainstSchema('node-result', observation.result)).toEqual([]);
    expect(readFileSync(join(h.worktree, 'src', 'app.js'), 'utf8')).toBe('v2\n');
  });

  it('writes a session log the controller can point at without inlining it', async () => {
    const h = harness({ default: { outcome: 'SUBMITTED', turns: 1 } });
    await runToCompletion(cliAdapter(), request(h));
    expect(existsSync(h.logPath)).toBe(true);
    expect(readFileSync(h.logPath, 'utf8')).toContain('"type":"result"');
  });

  it('reports a crashed worker as failed with its exit code', async () => {
    const h = harness({ default: { crash: true, exit_code: 9 } });
    const { observation } = await runToCompletion(cliAdapter(), request(h));
    expect(observation.status).toBe('failed');
    expect(observation.exit_code).toBe(9);
    expect(observation.result).toBeNull();
  });

  it('treats exit 0 with no result file as failed, not done', async () => {
    const h = harness({ default: { outcome: 'SUBMITTED', omit_result: true } });
    const { observation } = await runToCompletion(cliAdapter(), request(h));
    expect(observation.status).toBe('failed');
    expect(observation.failure_reason).toBe('RESULT_MISSING');
  });

  it('surfaces a BLOCKED outcome without treating it as success', async () => {
    const h = harness({
      default: { outcome: 'BLOCKED', failure_fingerprint: 'contract-mismatch' },
    });
    const { observation } = await runToCompletion(cliAdapter(), request(h));
    expect(observation.status).toBe('blocked');
    expect(observation.result?.failure_fingerprint).toBe('contract-mismatch');
  });

  it('surfaces a structured NEEDS_DECISION question', async () => {
    const h = harness({
      default: {
        outcome: 'NEEDS_DECISION',
        decision_request: {
          question: 'Break the public order-status contract or add a v2 field?',
          options: ['break-v1', 'add-v2-field'],
          category: 'contract-compatibility',
        },
      },
    });
    const { observation } = await runToCompletion(cliAdapter(), request(h));
    expect(observation.status).toBe('needs-decision');
    expect(observation.result?.decision_request?.options).toEqual(['break-v1', 'add-v2-field']);
  });

  it('kills a worker that exceeds its wall-clock budget', async () => {
    const h = harness({ default: { stall_ms: 30_000 } });
    const { observation } = await runToCompletion(
      cliAdapter(),
      request(h, { maxWallClockMs: 700, stallMs: 60_000 }),
    );
    expect(observation.status).toBe('budget-exhausted');
    expect(observation.timed_out).toBe(true);
  });

  it('kills a worker that stops making progress', async () => {
    const h = harness({ default: { stall_ms: 30_000 } });
    const { observation } = await runToCompletion(
      cliAdapter(),
      request(h, { maxWallClockMs: 60_000, stallMs: 700 }),
    );
    expect(observation.status).toBe('stalled');
  });

  it('stop() terminates a running worker and reports it stopped', async () => {
    const h = harness({ default: { stall_ms: 30_000 } });
    const adapter = cliAdapter();
    const handle = adapter.spawn(request(h, { maxWallClockMs: 60_000, stallMs: 60_000 }));
    adapter.stop(handle);
    const observation = await adapter.wait(handle);
    expect(observation.status).toBe('stopped');
  });

  it('selects a per-attempt scenario so a retry can behave differently', async () => {
    const h = harness({
      nodes: {
        'FEAT-101.core.publish.impl': [
          { outcome: 'RETRYABLE', failure_fingerprint: 'fp-1' },
          { outcome: 'SUBMITTED' },
        ],
      },
    });
    const first = await runToCompletion(cliAdapter(), request(h, { attempt: 1 }));
    expect(first.observation.result?.outcome).toBe('RETRYABLE');
    const second = await runToCompletion(cliAdapter(), request(h, { attempt: 2 }));
    expect(second.observation.result?.outcome).toBe('SUBMITTED');
  });

  it('passes the worker protocol through the environment, never through a transcript', async () => {
    const h = harness({ default: { outcome: 'SUBMITTED' } });
    const adapter = cliAdapter();
    const handle = adapter.spawn(request(h));
    await adapter.wait(handle);
    // The fake executable only knows the node id through MYCELINK_NODE_ID.
    const result = JSON.parse(readFileSync(h.resultPath, 'utf8')) as { node_id: string };
    expect(result.node_id).toBe('FEAT-101.core.publish.impl');
  });
});

describe('in-process fake adapter', () => {
  it('returns a scripted outcome without spawning a process', async () => {
    const h = harness({});
    const adapter = new FakeInProcessAdapter({
      'FEAT-101.core.publish.impl': {
        status: 'done',
        result: {
          schema_version: 1,
          node_id: 'FEAT-101.core.publish.impl',
          claim_id: 'claim-1',
          outcome: 'SUBMITTED',
          commands: [{ command: ['node', '--test'], exit_code: 0 }],
          evidence_paths: [],
        },
        usage: { model_turns: 4, wall_clock_ms: 5, input_tokens: 10, output_tokens: 5 },
      },
    });
    const handle = adapter.spawn(request(h));
    const observation = await adapter.wait(handle);
    expect(handle.pid).toBeNull();
    expect(observation.status).toBe('done');
    expect(observation.usage.model_turns).toBe(4);
    expect(adapter.spawnCount).toBe(1);
  });

  it('defaults to failing loudly for an unscripted node', async () => {
    const h = harness({});
    const adapter = new FakeInProcessAdapter({});
    const handle = adapter.spawn(request(h));
    const observation = await adapter.wait(handle);
    expect(observation.status).toBe('failed');
    expect(observation.failure_reason).toBe('UNSCRIPTED_NODE');
  });
});
