/**
 * Secret-like values never reach durable artifacts.
 *
 * Context packs, evidence logs, event logs, run ledgers, session logs and E2E
 * screenshot/trace metadata are all written to disk and some are committed or
 * shown to models. Any value of a secret-looking environment variable, and any
 * well-known credential shape, is replaced before it is written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redactText, redactValue, secretEnvValues } from '../../src/security/redact.js';
import { runVerification } from '../../src/evidence/runner.js';
import { appendEvent } from '../../src/state/event-log.js';
import { appendRun } from '../../src/loops/runs.js';
import { buildContextPack } from '../../src/sessions/context-pack.js';
import { initialState, DEFAULT_BUDGET } from '../../src/state/feature-state.js';
import { ClaudeCliAdapter } from '../../src/sessions/claude-cli-adapter.js';
import { isolationEnv } from '../../src/e2e/runner.js';
import { hashGraph } from '../../src/graph/validate.js';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { makeGitRepo } from '../helpers/git-fixture.js';
import { minimalPack, writePack } from '../helpers/context-pack.js';
import type { PortfolioGraph } from '../../src/model/types.js';

const SECRET = 'S3cr3t-Value-For-Redaction-0123456789';
const GH = 'ghp_' + 'A'.repeat(36);
const ENV_NAME = 'MYCELINK_TEST_API_TOKEN';

beforeEach(() => {
  process.env[ENV_NAME] = SECRET;
});
afterEach(() => {
  delete process.env[ENV_NAME];
  cleanupTmpRoots();
});

describe('redactText', () => {
  it('replaces values of secret-looking environment variables', () => {
    const env = { GITHUB_TOKEN: GH, DB_PASSWORD: 'hunter2hunter2', AWS_SECRET_ACCESS_KEY: 'abc/def+ghi=jkl0123', HOME: '/home/u', PATH: '/usr/bin' };
    const out = redactText(`token=${GH} pw=hunter2hunter2 aws=abc/def+ghi=jkl0123 home=/home/u`, env);
    expect(out).not.toContain(GH);
    expect(out).not.toContain('hunter2hunter2');
    expect(out).not.toContain('abc/def+ghi=jkl0123');
    expect(out).toContain('[REDACTED:GITHUB_TOKEN]');
    expect(out).toContain('home=/home/u');
  });

  it('ignores very short values so ordinary words are not mangled', () => {
    expect(secretEnvValues({ X_TOKEN: 'abc', MY_SECRET: 'true' })).toEqual([]);
  });

  it.each([
    ['github classic', GH],
    ['github fine-grained', 'github_pat_' + 'B'.repeat(60)],
    ['anthropic/openai style', 'sk-ant-api03-' + 'c'.repeat(40)],
    ['aws access key id', 'AKIA' + 'Q'.repeat(16)],
    ['slack', 'xoxb-1234567890-abcdefghijkl'],
    ['bearer header', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_value'],
    ['url credentials', 'https://user:p4ssw0rd@example.invalid/repo.git'],
    ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'],
  ])('redacts a %s without any environment hint', (_label, value) => {
    const out = redactText(`before ${value} after`, {});
    expect(out).not.toContain(value);
    expect(out).toMatch(/\[REDACTED/);
    expect(out).toContain('before ');
  });

  it('redacts nested values in structured data without changing keys', () => {
    const out = redactValue({ a: [`x ${SECRET}`], b: { c: SECRET } }, { [ENV_NAME]: SECRET }) as {
      a: string[];
      b: { c: string };
    };
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(Object.keys(out)).toEqual(['a', 'b']);
  });
});

describe('durable artifacts', () => {
  it('evidence logs and records never contain the secret', () => {
    const dir = makeTmpDir('redact-');
    const record = runVerification({
      kind: 'green',
      nodeId: 'FEAT-1.core.x.impl',
      repository: null,
      command: [process.execPath, '-e', `console.log(process.env.${ENV_NAME}); console.error("${GH}")`, `--token=${SECRET}`],
      cwd: dir,
      evidenceDir: join(dir, 'evidence'),
    });
    const log = readFileSync(record.output_path, 'utf8');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(GH);
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });

  it('event logs and the run ledger never contain the secret', () => {
    const dir = makeTmpDir('redact-');
    const events = join(dir, 'events.jsonl');
    appendEvent(events, { idempotency_key: 'k1', type: 't', actor: 'test', data: { note: `leaked ${SECRET}` } });
    const runs = join(dir, 'RUNS.jsonl');
    appendRun(runs, {
      attempt_id: 'a1',
      idempotency_key: 'r1',
      loop_id: 'L',
      parent_loop_id: null,
      node_id: null,
      candidate_sha: null,
      input_hash: 'h',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      model_turns: 0,
      usage: {},
      wall_clock_ms: 0,
      commands: [`deploy --password ${SECRET}`],
      exit_codes: [0],
      failure_fingerprint: null,
      evidence_paths: [],
      transition: 'x',
    });
    expect(readFileSync(events, 'utf8')).not.toContain(SECRET);
    expect(readFileSync(runs, 'utf8')).not.toContain(SECRET);
  });

  it('context packs never contain the secret', () => {
    const g = clone(VALID_GRAPH) as unknown as PortfolioGraph;
    const node = g.nodes[0];
    if (!node) throw new Error('fixture');
    node.verification_commands = [{ id: 'targeted', command: ['node', '--test', `--api-key=${SECRET}`] }];
    const state = initialState(g, hashGraph(g), { ...DEFAULT_BUDGET });
    const pack = buildContextPack({ graph: g, state, nodeId: node.id, claimId: 'c', maxBytes: 65536 });
    expect(JSON.stringify(pack)).not.toContain(SECRET);
  });

  it('worker session logs never contain the secret', async () => {
    const dir = makeTmpDir('redact-');
    const worktree = join(dir, 'wt');
    makeGitRepo(worktree, { files: { 'a.txt': 'a\n' } });
    const scenario = join(dir, 'scenario.json');
    writeFileSync(scenario, JSON.stringify({ default: { outcome: 'SUBMITTED', turns: 1, print_env: [ENV_NAME] } }));
    const pack = join(dir, 'pack.json');
    writePack(pack, minimalPack({ feature_id: 'FEAT-1', node_id: 'FEAT-1.core.x.impl', claim_id: 'c' }));
    mkdirSync(join(dir, 's'), { recursive: true });
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      prefixArgs: [resolve(process.cwd(), 'tests', 'fake-claude', 'claude.mjs')],
      adapterName: 'fake-claude',
    });
    const logPath = join(dir, 's', 'session.log');
    const handle = adapter.spawn({
      featureId: 'FEAT-1',
      nodeId: 'FEAT-1.core.x.impl',
      claimId: 'c',
      attempt: 1,
      contextPackPath: pack,
      cwd: worktree,
      resultPath: join(dir, 's', 'result.json'),
      logPath,
      model: 'sonnet',
      maxTurns: 5,
      maxWallClockMs: 30_000,
      stallMs: 10_000,
      env: { FAKE_CLAUDE_SCENARIO: scenario },
    });
    await adapter.wait(handle);
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain(`${ENV_NAME}=`);
    expect(log).not.toContain(SECRET);
  });

  it('E2E screenshot/trace metadata carries paths and ids, never environment values', () => {
    const env = isolationEnv(
      'FEAT-1-C001',
      {
        id: `login-${SECRET}`,
        isolation: { browser_profile: 'unique', account: 'unique', data_namespace: 'unique' },
      } as never,
      '/e2e',
    );
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(env['E2E_SCREENSHOT_DIR']).toMatch(/screenshots/);
  });
});
