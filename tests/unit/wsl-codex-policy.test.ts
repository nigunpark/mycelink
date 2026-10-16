import { describe, expect, it } from 'vitest';
import { expandAllowedProposalPaths } from '../../src/sessions/wsl-codex-policy.js';

describe('WSL Codex exact proposal allowlist', () => {
  it('expands new file proposals with the canonical graph matcher and applies forbidden precedence', () => {
    expect(expandAllowedProposalPaths(['src/new.ts', 'tests/new.test.ts'],
      { allowed: ['src/**', 'tests/**'], forbidden: ['src/secrets/**'] }))
      .toEqual(['src/new.ts', 'tests/new.test.ts']);
    expect(() => expandAllowedProposalPaths(['src/new.ts', 'src/secrets/key.ts'],
      { allowed: ['src/**'], forbidden: ['src/secrets/**'] })).toThrow('OWNERSHIP_VIOLATION');
    expect(() => expandAllowedProposalPaths(['state/result.json'],
      { allowed: ['**'], forbidden: [] })).toThrow('RESERVED_PROPOSAL');
  });
});
