import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { minimalPack } from '../helpers/context-pack.js';
import { buildHostWorkerPrompt, buildWorkerPrompt } from '../../src/sessions/worker-protocol.js';

describe('Codex mediated test-harness guidance', () => {
  const prompt = (provider: 'codex' | 'claude') => buildWorkerPrompt({
    pack: minimalPack(), gates: [], provider, mediated: true,
  }).split('<mycelink-context-pack>')[0]!;

  it('names the exact allowed top-level result keys and refuses explanatory extras', () => {
    const pack = minimalPack();
    const host = buildHostWorkerPrompt({ pack, worktree: '/w', resultSlot: '/w/.mycelink-worker/result.json', gates: [] });
    for (const text of [prompt('codex'), host]) {
      expect(text).toContain('Allowed top-level result keys (no others):');
      expect(text).toMatch(/notes.*criterion_evidence.*challenge.*criteria.*tdd/s);
      expect(text).toContain('Do not add a top-level "reason"');
      expect(text).toContain('decision_request.question');
      const names = text.match(/Allowed top-level result keys \(no others\): ([\s\S]*?)\. Do not add a top-level/)?.[1]
        ?.replace(/\s+/g, ' ').split(', ').join(',').split(',');
      const schema = JSON.parse(readFileSync('schemas/node-result.schema.json', 'utf8')) as { properties: Record<string, unknown> };
      expect(names?.sort()).toEqual(Object.keys(schema.properties).sort());
    }
  });

  it('makes review regression tests exercise the working tree before binding an immutable RED', () => {
    const base = minimalPack();
    const pack = minimalPack({ rework: {
      generation: 1, limit: 2, reason: 'review gap', reason_sha256: 'a'.repeat(64),
      acceptance_criteria: ['AC-1'], evidence: [],
      replaced: { integrated_sha: null, candidate_id: null },
      scope: { node_id: base.node_id, repository: base.repository },
      origin: { kind: 'acceptance-review', review_id: 'FEAT-101-R001', review: 1 },
    } });
    const text = buildWorkerPrompt({ pack, gates: [], provider: 'codex', mediated: true }).split('<mycelink-context-pack>')[0]!;
    expect(text).toMatch(/before.*RED.*working.tree.*production/i);
    expect(text).toMatch(/baseline pinned[\s\S]*reviewed side[\s\S]*working.tree/i);
    expect(text).toMatch(/RED is accepted[\s\S]*immutable/i);
    expect(text).toMatch(/TypeScript[\s\S]*normalized paths[\s\S]*source file/i);
    expect(text).toMatch(/RED[\s\S]*actual diagnostic[\s\S]*controller/i);
  });

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
