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

  it('directs a reviewed Codex rework with a passing reproduction to challenge without Git restore', () => {
    const base = minimalPack();
    const pack = minimalPack({ rework: {
      generation: 1, limit: 2, reason: 'review gap', reason_sha256: 'a'.repeat(64),
      acceptance_criteria: ['AC-1'], evidence: [],
      replaced: { integrated_sha: null, candidate_id: null },
      scope: { node_id: base.node_id, repository: base.repository },
      origin: { kind: 'acceptance-review', review_id: 'FEAT-101-R001', review: 1 },
      completed_criteria: [{ criterion: 'AC-1', test_id: 'b'.repeat(16), gate: 'red',
        output_sha256: 'c'.repeat(64), source_generation: 0, record_id: 'CC-1',
        test: { path: 'tests/core.test.ts', name: 'earlier proof' } }],
    } });
    const render = (provider: 'codex' | 'claude') => buildWorkerPrompt({ pack, gates: [], provider, mediated: true }).split('<mycelink-context-pack>')[0]!;
    const codex = render('codex');
    expect(codex).toMatch(/passing.*review-gap challenge/i);
    expect(codex).toMatch(/Do not restore the test with git/);
    expect(codex).toMatch(/leave its focused test uncommitted/);
    expect(codex).not.toMatch(/restore its file/);
    expect(codex).not.toMatch(/red gate: it must fail/);
    expect(render('claude')).toMatch(/restore its file/);
  });
});