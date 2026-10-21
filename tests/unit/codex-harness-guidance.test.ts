import { describe, expect, it } from 'vitest';
import { minimalPack } from '../helpers/context-pack.js';
import { buildWorkerPrompt } from '../../src/sessions/worker-protocol.js';

describe('Codex mediated test-harness guidance', () => {
  const prompt = (provider: 'codex' | 'claude') => buildWorkerPrompt({
    pack: minimalPack(), gates: [], provider, mediated: true,
  }).split('<mycelink-context-pack>')[0]!;

  it('warns Codex against reset-module class identity and directs it to controller GREEN diagnostics', () => {
    const text = prompt('codex');
    expect(text).toMatch(/vi\.resetModules\(\)/);
    expect(text).toMatch(/instanceof|class identity/);
    expect(text).toMatch(/mock.*same module instance/i);
    expect(text).toMatch(/GREEN.*fail.*controller.*evidence/i);
    expect(text).toMatch(/do not change committed tests/i);
  });

  it('does not change the Claude prompt', () => {
    expect(prompt('claude')).not.toMatch(/vi\.resetModules\(\)/);
  });
});