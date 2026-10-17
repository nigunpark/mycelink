import { describe, expect, it } from 'vitest';
import { protectExperimentalWslCapability, unprotectExperimentalWslCapability } from '../../src/sessions/wsl-codex-escrow.js';

const windows = process.platform === 'win32';
describe.skipIf(!windows)('Windows user-bound experimental capability escrow', () => {
  it('round-trips only under the exact claim/generation scope without persisting plaintext', () => {
    const capability = 'host-secret-' + crypto.randomUUID();
    const scope = 'FEAT-901\0node\0claim\0generation';
    const sealed = protectExperimentalWslCapability(capability, scope);
    expect(sealed).not.toContain(capability);
    expect(unprotectExperimentalWslCapability(sealed, scope)).toBe(capability);
    expect(() => unprotectExperimentalWslCapability(sealed, scope + '-stale')).toThrow(/ESCROW/);
  });
});
