/**
 * No dangerous permission bypass by default.
 *
 * Worker sessions run with Claude Code's normal permission system. Flags that
 * disable it are refused unless the control repository explicitly opts in,
 * so a copied config snippet cannot silently turn every worker into an
 * unrestricted shell.
 */
import { describe, expect, it } from 'vitest';
import { ClaudeCliAdapter, PermissionPolicyError } from '../../src/sessions/claude-cli-adapter.js';
import { DEFAULT_CONFIG } from '../../src/workspace/workspace.js';

describe('worker permission policy', () => {
  it('defaults to no bypass', () => {
    expect(DEFAULT_CONFIG.allow_dangerous_permission_bypass).toBe(false);
    expect(DEFAULT_CONFIG.claude_extra_args).toEqual([]);
  });

  it.each([
    [['--dangerously-skip-permissions']],
    [['--allow-dangerously-skip-permissions']],
    [['--permission-mode', 'bypassPermissions']],
    [['--permission-mode=bypassPermissions']],
  ])('refuses %j without an explicit opt-in', (extraArgs) => {
    expect(() => new ClaudeCliAdapter({ executable: 'claude', extraArgs })).toThrow(PermissionPolicyError);
  });

  it('refuses a bypass permission mode passed directly', () => {
    expect(() => new ClaudeCliAdapter({ executable: 'claude', permissionMode: 'bypassPermissions' })).toThrow(
      PermissionPolicyError,
    );
  });

  it('allows a bypass only when the control repository opts in', () => {
    expect(
      () =>
        new ClaudeCliAdapter({
          executable: 'claude',
          extraArgs: ['--dangerously-skip-permissions'],
          allowPermissionBypass: true,
        }),
    ).not.toThrow();
  });

  it('allows ordinary scoped tool permissions', () => {
    const adapter = new ClaudeCliAdapter({
      executable: 'claude',
      extraArgs: ['--allowed-tools', 'Edit', 'Write', 'Bash(npm test:*)'],
      permissionMode: 'acceptEdits',
    });
    expect(adapter.name).toBe('claude-background');
  });
});
