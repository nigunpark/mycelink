/**
 * The standalone CLI adapter: preflight, and spawn failures as
 * infrastructure (root causes A1, A2).
 *
 * In the eval every `orchestrate run` claimed a node, failed to start the
 * worker executable, charged the spawn error to the node as a task failure
 * and BLOCKED it after two tries. A missing executable is an environment
 * problem: it must be found before anything is claimed, and a spawn failure
 * must hand the claim back without touching the node's budgets.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { loadState } from '../../src/state/feature-state.js';
import { listLeases } from '../../src/resources/leases.js';
import { preflightAdapter } from '../../src/sessions/preflight.js';
import { DEFAULT_CONFIG } from '../../src/workspace/workspace.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { FakeInProcessAdapter } from '../../src/sessions/fake-adapter.js';
import { asController } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

const CORE = `${FEATURE_ID}.core.publish.impl`;

async function cli(p: Portfolio, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await main([...asController(argv, p.control), '--control-root', p.control], io);
  return { code, out, err };
}

function setConfig(p: Portfolio, patch: Record<string, unknown>): void {
  const file = join(p.control, 'mycelink.config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }, null, 2));
}

async function setup(): Promise<Portfolio> {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
  expect((await cli(p, ['feature', 'init', FEATURE_ID])).code).toBe(0);
  return p;
}

describe('adapter preflight', () => {
  it('requires explicit disposable registrations before probing Codex, regardless of Claude overrides', () => {
    const p = createPortfolio();
    const fake = join(process.cwd(), 'tests', 'fake-claude', 'claude.mjs');
    const configured = { ...DEFAULT_CONFIG, provider: { provider: 'codex' as const, executable: process.execPath }, experimental_codex: { enabled: true, disposable_repositories: ['core', 'web'] } };
    const env = { ...process.env, MYCELINK_FAKE_CLAUDE: fake };
    expect(preflightAdapter(configured, env).ok).toBe(false); // root must be supplied
    expect(preflightAdapter(configured, env, p.control).ok).toBe(false); // names must match manifest
    const names = (YAML.parse(readFileSync(join(p.control, 'repositories.yaml'), 'utf8')) as { repositories: { name: string }[] }).repositories.map((r) => r.name);
    const ready = { ...configured, experimental_codex: { enabled: true, disposable_repositories: names } };
    expect(preflightAdapter(ready, env, p.control)).toMatchObject({ ok: true, adapter: 'codex-cli' });
    expect(preflightAdapter({ ...ready, experimental_codex: { enabled: false, disposable_repositories: names } }, env, p.control).ok).toBe(false);
    expect(preflightAdapter({ ...ready, provider: { ...ready.provider, extra_args: ['--dangerously-bypass-approvals-and-sandbox'] } }, env, p.control).ok).toBe(false);
  });
  it('keeps reviewer and delivery paths denied even when experimental worker preflight passes', async () => {
    const p = createPortfolio();
    const names = (YAML.parse(readFileSync(join(p.control, 'repositories.yaml'), 'utf8')) as { repositories: { name: string }[] }).repositories.map((r) => r.name);
    setConfig(p, { provider: { provider: 'codex', executable: process.execPath }, experimental_codex: { enabled: true, disposable_repositories: names } });
    const status = await cli(p, ['codex', 'status', FEATURE_ID, '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ runtime_enabled: true, state_present: false });
    for (const command of [['codex', 'deliver'], ['codex', 'verify'], ['codex', 'resume'], ['review', 'settle'], ['deliver'], ['orchestrate', 'run']]) {
      const r = await cli(p, [...command, FEATURE_ID, '--json']);
      expect(r.code, command.join(' ')).not.toBe(0);
      expect(r.err).toContain('CODEX_RUNTIME_DENIED');
    }
    expect((await cli(p, ['codex', 'run', FEATURE_ID, '--json'])).err).toContain('CONTROLLER_AUTHORITY_REQUIRED');
    // Review is controller-owned; it must not fall through the generic Claude transport.
    const review = await cli(p, ['codex', 'review', FEATURE_ID, '--json']);
    expect(review.err).toContain('CONTROLLER_AUTHORITY_REQUIRED');
  });
  it('never certifies an unimplemented Codex adapter through Claude or fake overrides', () => {
    const fake = join(process.cwd(), 'tests', 'fake-claude', 'claude.mjs');
    const configured = { ...DEFAULT_CONFIG, provider: { provider: 'codex' as const, executable: process.execPath } };
    for (const input of [configured, { ...configured, session_adapter: 'fake-claude' as const, claude_executable: fake }]) {
      const result = preflightAdapter(input, { ...process.env, MYCELINK_FAKE_CLAUDE: fake });
      expect(result).toMatchObject({ ok: false, adapter: 'codex-cli' });
      expect(result.detail).toMatch(/experimental opt-in/i);
    }
  });

  it('reports an executable that cannot be found, without starting anything', () => {
    const r = preflightAdapter({ ...DEFAULT_CONFIG, claude_executable: 'definitely-not-claude-xyz' });
    expect(r.ok).toBe(false);
    expect(r.resolved).toBeNull();
    expect(r.detail).toMatch(/not found/i);
  });

  it('resolves and probes a real executable for its version', () => {
    // node stands in for an installed CLI that answers --version.
    const r = preflightAdapter({ ...DEFAULT_CONFIG, claude_executable: process.execPath });
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe(process.execPath);
    expect(r.version).toMatch(/\d+\.\d+\.\d+/);
  });

  it('probes the fake adapter the suite uses', () => {
    const fake = join(process.cwd(), 'tests', 'fake-claude', 'claude.mjs');
    const r = preflightAdapter({ ...DEFAULT_CONFIG, session_adapter: 'fake-claude', claude_executable: fake });
    expect(r).toMatchObject({ ok: true, adapter: 'fake-claude' });
    expect(r.version).toMatch(/\d+\.\d+\.\d+/);
  });

  it('fails a probe that exits non-zero', () => {
    const p = createPortfolio();
    const broken = join(p.root, 'broken-claude.mjs');
    writeFileSync(broken, 'process.exit(3);\n');
    const r = preflightAdapter({ ...DEFAULT_CONFIG, session_adapter: 'fake-claude', claude_executable: broken });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/exited 3/);
  });
});

describe('infrastructure failures do not consume node budgets', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await setup();
  });

  it('orchestrate run stops ADAPTER_UNAVAILABLE before claiming anything', async () => {
    setConfig(p, { session_adapter: 'claude-background', claude_executable: join(p.root, 'missing-claude') });
    const r = await cli(p, ['orchestrate', 'run', FEATURE_ID, '--json']);
    expect(r.code).not.toBe(0);
    const report = JSON.parse(r.out) as { stop_reason: string; adapter: { ok: boolean; detail: string } };
    expect(report.stop_reason).toBe('ADAPTER_UNAVAILABLE');
    expect(report.adapter.ok).toBe(false);
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.attempts).toBe(0);
    expect(rt.failure_counts).toEqual({});
    expect(rt.claim).toBeNull();
    expect(loadState(p.featureDir)!.data.usage.sessions).toBe(0);
  });

  it('refuses Codex even with read-only sandbox and an apparent executable', async () => {
    setConfig(p, {
      provider: { provider: 'codex', executable: process.execPath, sandbox: 'read-only', approval_policy: 'never' },
      session_adapter: 'fake-claude',
    });
    const r = await cli(p, ['orchestrate', 'run', FEATURE_ID, '--json']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/Codex worker dispatch requires explicit experimental opt-in/i);
    const state = loadState(p.featureDir)!.data;
    expect(state.nodes[CORE]!.claim).toBeNull();
    expect(state.nodes[CORE]!.attempts).toBe(0);
    expect(state.usage.sessions).toBe(0);
  });

  it('a spawn failure releases the claim, refunds the attempt and stops resumably', async () => {
    commitControl(p, 'scaffold');
    const spawnFails = new FakeInProcessAdapter({
      [CORE]: { status: 'failed', failure_reason: 'SPAWN_FAILED: spawn claude ENOENT', exit_code: 127 },
    });
    const o = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID, adapter: spawnFails, preflight: () => ({ ok: true }) });
    const report = await o.runToCompletion({ maxCycles: 5 });
    expect(report.stop_reason).toBe('ADAPTER_UNAVAILABLE');
    expect(report.reports.map((x) => x.outcome)).toEqual(['INFRASTRUCTURE_FAILURE']);
    expect(spawnFails.spawnCount).toBe(1);

    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).toBe('READY');
    expect(rt.attempts).toBe(0);
    expect(rt.failure_counts).toEqual({});
    expect(rt.interruptions).toBe(1);
    expect(rt.claim).toBeNull();
    expect(listLeases(p.featureDir)).toEqual([]);
    expect(rt.blocked_reason).toBeNull();
  });

  it('repeated spawn failures never BLOCK the node', async () => {
    commitControl(p, 'scaffold');
    const spawnFails = new FakeInProcessAdapter({
      [CORE]: { status: 'failed', failure_reason: 'SPAWN_FAILED: spawn claude ENOENT', exit_code: 127 },
    });
    const o = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID, adapter: spawnFails, preflight: () => ({ ok: true }) });
    for (let i = 0; i < 3; i++) expect((await o.runToCompletion()).stop_reason).toBe('ADAPTER_UNAVAILABLE');
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).toBe('READY');
    expect(rt.interruptions).toBe(3);
    expect(rt.attempts).toBe(0);
  });

  it('doctor reports the adapter probe without failing a host-dispatch setup', async () => {
    setConfig(p, { session_adapter: 'claude-background', claude_executable: join(p.root, 'missing-claude') });
    const r = await cli(p, ['doctor', '--json']);
    const report = JSON.parse(r.out) as { ok: boolean; checks: { name: string; ok: boolean; level?: string; detail: string }[] };
    const adapter = report.checks.find((c) => c.name === 'worker adapter (standalone)');
    expect(adapter).toMatchObject({ level: 'warn' });
    expect(adapter?.detail).toMatch(/not found/i);
    expect(adapter?.detail).toMatch(/host dispatch/i);
  });

  it('human orchestrate output names the reason for every node that did not finish', async () => {
    setConfig(p, { session_adapter: 'claude-background', claude_executable: join(p.root, 'missing-claude') });
    const r = await cli(p, ['orchestrate', 'run', FEATURE_ID]);
    expect(r.out).toMatch(/stop: ADAPTER_UNAVAILABLE/);
    expect(r.out).toMatch(/not found/i);
  });
});
