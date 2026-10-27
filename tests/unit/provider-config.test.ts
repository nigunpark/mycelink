import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { initControlRepo, loadConfig, normalizeConfig } from '../../src/workspace/workspace.js';
import { preflightAdapter } from '../../src/sessions/preflight.js';
import { validateAgainstSchema } from '../../src/schema/registry.js';

afterEach(() => cleanupTmpRoots());

describe('provider-neutral configuration', () => {
  it('records the host-native Codex fence blocker instead of claiming hook parity', () => {
    const compatibility = readFileSync(join(process.cwd(), 'docs', 'CODEX_COMPATIBILITY.md'), 'utf8');
    expect(compatibility).toMatch(/PreToolUse.*(?:agent_id|subagent identity)/s);
    expect(compatibility).toMatch(/(?:opt out|opt-out).*hook/s);
    expect(compatibility).toMatch(/fail.open|continues the tool call/s);
    expect(compatibility).toMatch(/host.native.*unsupported/s);
  });

  it('writes new control repositories with a provider block instead of Claude-specific keys', () => {
    const root = makeTmpDir('provider-config-');

    initControlRepo(root);

    const written = JSON.parse(readFileSync(join(root, 'mycelink.config.json'), 'utf8')) as Record<string, unknown>;
    expect(written['provider']).toEqual({ provider: 'claude', executable: 'claude', extra_args: [] });
    expect(written).not.toHaveProperty('session_adapter');
    expect(written).not.toHaveProperty('claude_executable');
    expect(written).not.toHaveProperty('claude_extra_args');
  });

  it('maps legacy Claude keys to the provider block without rewriting the file', () => {
    const root = makeTmpDir('provider-config-');
    const file = join(root, 'mycelink.config.json');
    const legacy = JSON.stringify({
      schema_version: 1,
      session_adapter: 'claude-background',
      claude_executable: 'custom-claude',
      claude_extra_args: ['--allowed-tools', 'Read'],
    }, null, 2) + '\n';
    writeFileSync(file, legacy);

    const loaded = loadConfig(root);

    expect(loaded.provider).toEqual({
      provider: 'claude',
      executable: 'custom-claude',
      extra_args: ['--allowed-tools', 'Read'],
    });
    expect(loaded.adapter).toBe('claude-cli');
    expect(readFileSync(file, 'utf8')).toBe(legacy);
  });

  it('normalizes a provider block for the existing Claude runtime without changing the file', () => {
    const root = makeTmpDir('provider-config-');
    const file = join(root, 'mycelink.config.json');
    const current = JSON.stringify({
      schema_version: 1,
      provider: {
        provider: 'claude',
        executable: 'custom-claude',
        extra_args: ['--allowed-tools', 'Read'],
        model: 'claude-sonnet',
      },
    }, null, 2) + '\n';
    writeFileSync(file, current);

    const loaded = loadConfig(root);

    expect(loaded.provider).toEqual({
      provider: 'claude',
      executable: 'custom-claude',
      extra_args: ['--allowed-tools', 'Read'],
      model: 'claude-sonnet',
    });
    expect(loaded.adapter).toBe('claude-cli');
    expect(readFileSync(file, 'utf8')).toBe(current);
  });

  it('keeps a loaded legacy fake adapter through preflight normalization', () => {
    const root = makeTmpDir('provider-config-');
    writeFileSync(join(root, 'mycelink.config.json'), JSON.stringify({
      session_adapter: 'fake-claude', claude_executable: 'missing-fake-worker-script',
    }));
    const loaded = loadConfig(root);
    expect(loaded.adapter).toBe('fake-provider');
    expect(normalizeConfig(loaded).adapter).toBe('fake-provider');
    expect(preflightAdapter(loaded)).toMatchObject({ ok: false, adapter: 'fake-claude' });
  });

  it('validates canonical adapter ids while retaining legacy persisted ids', () => {
    const session = (adapter: string) => ({
      schema_version: 1,
      sessions: {
        s1: {
          session_id: 's1', feature_id: 'FEAT-1', node_id: 'FEAT-1.core.work.impl', claim_id: 'claim-1',
          repository: null, worktree: null, branch: null, status: 'working',
          started_at: '2026-10-16T00:00:00.000Z', last_progress_at: '2026-10-16T00:00:00.000Z',
          finished_at: null, turns: 0, usage: {}, adapter, pid: null, log_path: null,
          result_path: null, exit_code: null, replaces_session_id: null, attempt: 1,
        },
      },
    });

    for (const adapter of ['claude-cli', 'codex-cli', 'fake-provider', 'claude-background', 'fake-claude']) {
      expect(validateAgainstSchema('session-registry', session(adapter)), adapter).toEqual([]);
    }
  });
});
