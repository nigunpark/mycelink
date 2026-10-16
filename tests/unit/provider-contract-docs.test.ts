import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';

const providerContract = join(REPO_ROOT, 'docs', 'PROVIDER_CONTRACT.md');

const read = (): string => readFileSync(providerContract, 'utf8').replace(/\r\n/g, '\n');

describe('model-host provider contract', () => {
  it('documents the provider-neutral lifecycle and security boundaries', () => {
    expect(existsSync(providerContract)).toBe(true);
    const contract = read();
    for (const section of [
      'Session lifecycle',
      'Structured usage',
      'Result ownership',
      'Hook protocol',
      'Host identities',
      'Provider interruptions',
      'Transcript and final-output evidence',
    ]) {
      expect(contract, section).toContain(`## ${section}`);
    }
    for (const operation of ['spawn', 'poll', 'wait', 'stop']) {
      expect(contract, operation).toMatch(new RegExp(`\\b${operation}\\b`));
    }
    expect(contract).toMatch(/controller.*worker.*reviewer/is);
    expect(contract).toMatch(/Claude.*Codex|Codex.*Claude/is);
    expect(contract).toMatch(/PostCompact/);
    expect(contract).toMatch(/TaskCreated/);
    expect(contract).toMatch(/TaskCompleted/);
    expect(contract).toMatch(/core invariant|state transition/i);
  });
});
