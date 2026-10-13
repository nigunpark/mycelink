/**
 * What a review-gap challenge must hold, mechanically (engine/review-challenge.ts).
 *
 * CSET-203 r6: the reviewer's exact AC-1 reproduction, written as focused
 * tests, passed on the unchanged integrated head. A challenge says so with
 * evidence the controller can check without trusting the worker: each
 * challenged clause traced to assertion lines inside the passing focused
 * test, and those assertions concrete — `assert.ok(true)` proves nothing
 * about the code. A refinement may not answer it with the same reproduction
 * dressed up: a REFINE or UPHOLD must reproduce something materially
 * different.
 */
import { describe, expect, it } from 'vitest';
import { assertionProblem, materiallyDifferent, parseAssertionRef, reproductionSha256, MAX_CHALLENGE_ROUNDS } from '../../src/engine/review-challenge.js';
import { validateAgainstSchema } from '../../src/schema/registry.js';

const NODE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReleasePlan } from '../src/index.mjs';

test('removes a changelog it created when a later change fails', async () => {
  const files = new Map([['packages/b/package.json', '1.0.0']]);
  const failure = new Error('formatter crashed');
  const error = await applyReleasePlan(files, [], { format: async () => { throw failure; } }).then(() => null, (e) => e);
  assert.equal(error.cause, failure);
  assert.equal(files.has('packages/b/CHANGELOG.md'), false, 'gone');
  assert.ok(true);
  assert.equal(1, 1);
  assert.deepEqual([], []);
  const nothing = 1;
});

test('another test', () => {
  assert.equal(2 + 2, 4);
});
`;

const VITEST = `import { describe, expect, it } from 'vitest';

describe('rollback', () => {
  it('restores the pre dir', async () => {
    const error = await run().then(() => undefined, (e) => e);
    expect(error.cause).toBe(boom);
    expect(existsSync(dir)).toBe(false);
    expect(true).toBe(true);
    expect(1).toEqual(1);
    await expect(run()).rejects.toThrow('boom');
  });
  it.skip('is skipped', () => {
    expect(result).toBe(3);
  });
});
`;

const line = (src: string, needle: string): number => src.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('a challenged clause is traced to concrete assertions inside the passing focused test', () => {
  const name = 'removes a changelog it created when a later change fails';
  it('an assertion on what the code did is concrete', () => {
    expect(assertionProblem(NODE_TEST, 'test/a.test.mjs', name, line(NODE_TEST, 'error.cause, failure'), line(NODE_TEST, 'error.cause, failure'))).toBeNull();
    expect(assertionProblem(NODE_TEST, 'test/a.test.mjs', name, line(NODE_TEST, 'error.cause, failure'), line(NODE_TEST, "'gone'"))).toBeNull();
    expect(assertionProblem(VITEST, 'src/a.test.ts', 'rollback > restores the pre dir', line(VITEST, 'error.cause).toBe(boom)'), line(VITEST, 'existsSync(dir)'))).toBeNull();
    expect(assertionProblem(VITEST, 'src/a.test.ts', 'restores the pre dir', line(VITEST, 'rejects.toThrow'), line(VITEST, 'rejects.toThrow'))).toBeNull();
  });

  it('a constant assertion, or lines with no assertion, are weak', () => {
    for (const needle of ['assert.ok(true)', 'assert.equal(1, 1)', 'assert.deepEqual([], [])', 'const nothing = 1']) {
      expect(assertionProblem(NODE_TEST, 'test/a.test.mjs', name, line(NODE_TEST, needle), line(NODE_TEST, needle)), needle).toBe('ASSERTION_WEAK');
    }
    for (const needle of ['expect(true).toBe(true)', 'expect(1).toEqual(1)']) {
      expect(assertionProblem(VITEST, 'src/a.test.ts', 'restores the pre dir', line(VITEST, needle), line(VITEST, needle)), needle).toBe('ASSERTION_WEAK');
    }
    // A skipped test asserts nothing that ran.
    expect(assertionProblem(VITEST, 'src/a.test.ts', 'is skipped', line(VITEST, 'expect(result).toBe(3)'), line(VITEST, 'expect(result).toBe(3)'))).toBe('ASSERTION_WEAK');
  });

  it('lines outside the cited test, outside the file, or a test the file does not declare are outside', () => {
    expect(assertionProblem(NODE_TEST, 'test/a.test.mjs', name, line(NODE_TEST, 'assert.equal(2 + 2, 4)'), line(NODE_TEST, 'assert.equal(2 + 2, 4)'))).toBe('ASSERTION_OUTSIDE');
    expect(assertionProblem(NODE_TEST, 'test/a.test.mjs', name, 900, 901)).toBe('ASSERTION_OUTSIDE');
    expect(assertionProblem(NODE_TEST, 'test/a.test.mjs', 'no such test', 9, 9)).toBe('ASSERTION_OUTSIDE');
    expect(assertionProblem(NODE_TEST, 'test/a.test.mjs', name, 12, 9)).toBe('ASSERTION_OUTSIDE');
  });

  it('other languages: JUnit and pytest assertions', () => {
    const java = 'class T {\n  @Test\n  void restores() {\n    var r = run();\n    assertEquals("1.0.0", r.version());\n    assertTrue(true);\n  }\n}\n';
    expect(assertionProblem(java, 'src/test/java/T.java', 'restores', 5, 5)).toBeNull();
    expect(assertionProblem(java, 'src/test/java/T.java', 'restores', 6, 6)).toBe('ASSERTION_WEAK');
    const py = 'def test_restores():\n    r = run()\n    assert r.version == "1.0.0"\n    assert True\n';
    expect(assertionProblem(py, 'tests/test_a.py', 'test_restores', 3, 3)).toBeNull();
    expect(assertionProblem(py, 'tests/test_a.py', 'test_restores', 4, 4)).toBe('ASSERTION_WEAK');
  });

  it('an assertion location is <path>#L<a>[-L<b>] in the node repository, as file:<repository>:<path> or bare', () => {
    expect(parseAssertionRef('file:changesets:packages/a/test/a.test.mjs#L10-L12', 'changesets')).toEqual({ path: 'packages/a/test/a.test.mjs', from: 10, to: 12 });
    expect(parseAssertionRef('packages/a/test/a.test.mjs#L7', 'changesets')).toEqual({ path: 'packages/a/test/a.test.mjs', from: 7, to: 7 });
    expect(parseAssertionRef('file:other:packages/a/test/a.test.mjs#L7', 'changesets')).toBeNull();
    expect(parseAssertionRef('packages/a/test/a.test.mjs', 'changesets')).toBeNull();
    expect(parseAssertionRef('../outside.test.mjs#L1', 'changesets')).toBeNull();
    expect(parseAssertionRef('/abs/a.test.mjs#L1', 'changesets')).toBeNull();
  });
});

describe('a refined or upheld reproduction is materially different from every earlier one', () => {
  const original = 'In applyReleasePlan tests: changelog enabled with no CHANGELOG.md, fail the package.json write of a later package; assert CHANGELOG.md is absent.';
  it('the same text, re-cased, re-spaced or re-punctuated, is no refinement', () => {
    expect(materiallyDifferent(original, [original])).toBe(false);
    expect(materiallyDifferent(`  ${original.toUpperCase()}  `, [original])).toBe(false);
    expect(materiallyDifferent(original.replace(/[;:,.]/g, ' - '), [original])).toBe(false);
  });

  it('a word or two added is no refinement either', () => {
    expect(materiallyDifferent(`${original} Also check it.`, [original])).toBe(false);
  });

  it('another failure boundary is', () => {
    expect(materiallyDifferent('make packages/pkg-b/CHANGELOG.md a directory so the changelog write fails after both package versions were written; assert every file and the directory are exactly as before and the cause kept', [original])).toBe(true);
    // ... against every earlier reproduction of the gap, not only the last.
    expect(materiallyDifferent(original, ['something else entirely about pre mode directories', original])).toBe(false);
  });

  it('a reproduction is bound by the SHA-256 of its exact text', () => {
    expect(reproductionSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('two challenge-refinement rounds per gap', () => {
    expect(MAX_CHALLENGE_ROUNDS).toBe(2);
  });
});

describe('the worker result schema', () => {
  const base = { schema_version: 1, node_id: 'N', claim_id: 'c', dispatch_id: '0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10', commands: [], evidence_paths: [], commit_sha: 'a'.repeat(40), failure_fingerprint: null, decision_request: null };
  const challenge = {
    review_id: 'CSET-203-R001',
    reason_sha256: '1'.repeat(64),
    base_sha: 'a'.repeat(40),
    gate_output_sha256: '2'.repeat(64),
    gaps: [{ criterion: 'AC-1', reproduction_sha256: '3'.repeat(64), tests: ['0123456789abcdef'], clauses: [{ clause: 'AC-1.1', test_id: '0123456789abcdef', assertions: ['file:changesets:packages/a/test/a.test.mjs#L10-L12'], trace: 'the created changelog is gone' }], explanation: 'the reproduction passes on the unchanged head' }],
  };
  it('accepts outcome REVIEW_GAP_CHALLENGE with its challenge', () => {
    expect(validateAgainstSchema('node-result', { ...base, outcome: 'REVIEW_GAP_CHALLENGE', challenge })).toEqual([]);
  });
  it('a challenge is structured: no free-form fields, ids and hashes in their form', () => {
    expect(validateAgainstSchema('node-result', { ...base, outcome: 'REVIEW_GAP_CHALLENGE', challenge: { ...challenge, verdict: 'trust me' } }).length).toBeGreaterThan(0);
    expect(validateAgainstSchema('node-result', { ...base, outcome: 'REVIEW_GAP_CHALLENGE', challenge: { ...challenge, gate_output_sha256: 'nope' } }).length).toBeGreaterThan(0);
    expect(validateAgainstSchema('node-result', { ...base, outcome: 'REVIEW_GAP_CHALLENGE', challenge: { ...challenge, gaps: [{ ...challenge.gaps[0], tests: ['not-an-id'] }] } }).length).toBeGreaterThan(0);
  });
});
