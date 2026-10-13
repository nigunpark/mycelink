/**
 * Criterion evidence names a test by the id its gate published, and a
 * criterion metadata error is corrected on the same claim, never charged.
 *
 * CSET-202 r2: the cli node's implementation, history and gates all passed,
 * yet settle refused its criterion evidence twice with CRITERION_TEST_UNKNOWN
 * — the worker and the controller guessed whether a nested Vitest test is
 * `describe > it` or the bare `it` — and the two refusals consumed both
 * product attempts: the node stayed READY with ATTEMPTS_EXHAUSTED and nothing
 * was delivered. Here:
 *
 *  - every gate prints, and its JSON and results file carry, the canonical id
 *    of each test it ran (adapter, path, full name); `mycelink tdd tests`
 *    finds any bound test by words;
 *  - a criterion names its test by `test_id`; a name beside it is display;
 *    a legacy path and name count only when they resolve to exactly one
 *    bound test, and an unknown or ambiguous one answers with candidate ids;
 *  - a criterion metadata error holds the same claim in
 *    EVIDENCE_CORRECTION_REQUIRED: no attempt, no failure fingerprint,
 *    nothing integrated, the gates closed; the worker holding the capability
 *    resubmits the same commit with corrected evidence, or dispatch hands the
 *    correction to a fresh worker generation; a correction that is not a
 *    resubmission of the same submitted commit, or too many of them, is the
 *    product's failure again.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { ERRORS, ERRORS_IMPL, SHOP_FEATURE, createShop, moduleVerifier, shopCli, shopGraph, shopState, type Shop } from '../helpers/shop-fixture.js';
import { fulfil, lookupTests, packOf, runGate, writeFiles, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

const TEST_FILE = 'packages/errors/test/errors.test.mjs';
const LEAF = 'sorts the issues and lists one per line';
const FULL = `ChangesetValidationError > ${LEAF}`;

/** The AC-1 RED as CSET-202's errors worker wrote it: the new test inside a describe, beside the module's existing test. */
const NESTED_RED = `import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { GitError } from '../src/index.mjs';

test('a git error carries its exit code', () => {
  assert.equal(new GitError(1, 'failed').code, 1);
});

describe('ChangesetValidationError', () => {
  it('${LEAF}', async () => {
    const errors = await import('../src/index.mjs');
    assert.equal(typeof errors.ChangesetValidationError, 'function');
    const error = new errors.ChangesetValidationError([
      { changesetId: 'b', code: 'UNKNOWN_PACKAGE', message: 'y' },
      { changesetId: 'a', code: 'INVALID_FILE', message: 'x' },
    ]);
    assert.deepEqual(error.issues.map((i) => i.changesetId), ['a', 'b']);
    assert.equal(error.message, 'Invalid changesets:\\n- a: x\\n- b: y');
  });
});
`;

/** The same leaf title in two describes: a bare name cannot say which. */
const TWIN_RED = `${NESTED_RED}
describe('ChangesetValidationError message', () => {
  it('${LEAF}', async () => {
    const errors = await import('../src/index.mjs');
    assert.equal(typeof errors.ChangesetValidationError, 'function');
  });
});
`;

type Work = { tests: Record<string, string>; impl: Record<string, string> };
const WORK: Work = { tests: { [TEST_FILE]: NESTED_RED }, impl: { 'packages/errors/src/index.mjs': ERRORS_IMPL } };
const RED_ID = canonicalTestId('junit-xml', TEST_FILE, FULL);
const TWIN_ID = canonicalTestId('junit-xml', TEST_FILE, `ChangesetValidationError message > ${LEAF}`);
const EXISTING_ID = canonicalTestId('junit-xml', TEST_FILE, 'a git error carries its exit code');

const shop = () => createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });

type Ticket = ShopTicket & { correction?: Record<string, any> };

async function dispatch(s: Shop): Promise<{ status: string; detail: string; ticket?: Ticket }> {
  const d = await shopCli(s, ['dispatch', SHOP_FEATURE, '--json']);
  expect(d.err).toBe('');
  return JSON.parse(d.out);
}

async function settle(s: Shop, capability: string): Promise<{ code: number; report: Record<string, any>; err: string }> {
  const r = await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', capability, '--json']);
  return { code: r.code, report: r.out.trim() === '' ? {} : JSON.parse(r.out), err: r.err };
}

/** A result written to the ticket's slot as its worker would: `base` with these fields replaced. */
function resubmit(t: ShopTicket, base: Record<string, unknown>, fields: Record<string, unknown> = {}): void {
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify({ ...base, ...fields, ...(t.dispatch_id ? { dispatch_id: t.dispatch_id } : {}) }, null, 2));
}

/** Dispatch the errors node and fulfil it with these criteria. */
async function submitted(s: Shop, criteria: CriterionItem[] | null, extra: { criterionEvidence?: unknown } = {}, work: Work = WORK) {
  const d = await dispatch(s);
  expect(d.status, d.detail).toBe('DISPATCHED');
  const t = d.ticket!;
  expect(t.node_id).toBe(ERRORS);
  const run = fulfil(t, { ...work, ...(criteria !== null ? { criteria } : {}), ...extra }, s.control);
  expect(run.gates.map((g) => g.code), JSON.stringify(run.gates.map((g) => g.out.slice(-500)))).toEqual([0, 0, 0]);
  return { t, run };
}

/** The node as a correction leaves it: same claim, no attempt or failure charged, nothing integrated. */
function expectHeld(s: Shop, claimId: string): void {
  const rt = shopState(s).nodes[ERRORS];
  expect(rt.state).toBe('REGRESSION_VERIFIED');
  expect(rt.attempts).toBe(1);
  expect(rt.failure_counts).toEqual({});
  expect(rt.claim?.claim_id).toBe(claimId);
  expect(rt.claim?.evidence_correction).toMatchObject({ code: expect.stringMatching(/^CRITERION_/) });
  expect(rt.integrated_sha).toBeNull();
  expect(shopState(s).integration_heads ?? {}).toEqual({});
}

const goodItem = (gateSha: string, id = RED_ID) => ({ criterion: 'AC-1', test_id: id, gate: 'red', output_sha256: gateSha });

describe('every gate publishes the canonical ids of the tests it ran', () => {
  it('the red gate prints each declared test with its id, its JSON lists them, and its results file carries them', async () => {
    const s = await shop();
    const t = (await dispatch(s)).ticket!;
    writeFiles(t.worktree, WORK.tests);
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    // The RED's declared tests: the new one failing, and the existing one whose block it changed, still passing.
    expect(red.tests).toEqual([
      { id: EXISTING_ID, status: 'passed', path: TEST_FILE, full_name: 'a git error carries its exit code' },
      { id: RED_ID, status: 'failed', path: TEST_FILE, full_name: FULL },
    ]);
    expect(red.out).toMatch(/every test with its test_id: features\/SHOP-202\/evidence\/.*\/red\.results\.[0-9a-f]{16}\.json/);
    const ev = shopState(s).nodes[ERRORS].evidence.red;
    const results = JSON.parse(readFileSync(join(s.control, ev.results.path), 'utf8')).results as { test_id: string; full_name: string; status: string }[];
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ test_id: RED_ID, full_name: FULL, status: 'failed' }),
        expect.objectContaining({ test_id: EXISTING_ID, full_name: 'a git error carries its exit code', status: 'passed' }),
      ]),
    );
    // The same gate, asked for JSON: the bounded list of { id, path, full_name, status }.
    execSync(`git -C "${t.worktree}" add -A && git -C "${t.worktree}" commit -qm "test: RED"`);
    writeFiles(t.worktree, WORK.impl);
    const green = JSON.parse((await shopCli(s, ['tdd', 'green', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--json'])).out) as { ok: boolean; tests: unknown[]; tests_total: number; tests_results_path: string };
    expect(green.ok).toBe(true);
    expect(green.tests).toEqual(expect.arrayContaining([{ id: RED_ID, path: TEST_FILE, full_name: FULL, status: 'passed' }]));
    expect(green.tests_total).toBe(2);
    expect(green.tests_results_path).toMatch(/\/green\.results\.[0-9a-f]{16}\.json$/);
  });

  it('`tdd tests` finds any test a bound gate ran by words, with its id: an existing test for a compatibility criterion', async () => {
    const s = await shop();
    const t = (await dispatch(s)).ticket!;
    writeFiles(t.worktree, WORK.tests);
    expect(runGate(t, 'red', s.control).code).toBe(0);
    execSync(`git -C "${t.worktree}" add -A && git -C "${t.worktree}" commit -qm "test: RED"`);
    writeFiles(t.worktree, WORK.impl);
    expect(runGate(t, 'green', s.control).code).toBe(0);
    const found = lookupTests(t, s.control, ['--gate', 'green', '--match', 'git error exit code']);
    expect(found.code, found.out).toBe(0);
    expect(found.tests).toEqual([{ id: EXISTING_ID, status: 'passed', path: TEST_FILE, full_name: 'a git error carries its exit code' }]);
    // Without the claim's capability nothing is listed.
    const denied = await shopCli(s, ['tdd', 'tests', SHOP_FEATURE, ERRORS, '--match', 'git']);
    expect(denied.code).not.toBe(0);
  });
});

describe('a criterion names its test by id', () => {
  it('a nested test cited by the id its red gate printed settles DONE; its id and full name are recorded', async () => {
    const s = await shop();
    const { t, run } = await submitted(s, [{ criterion: 'AC-1', gate: 'red', full_name: FULL }]);
    expect(run.result['criterion_evidence']).toEqual([{ criterion: 'AC-1', test_id: RED_ID, gate: 'red', output_sha256: run.gates[0]!.sha256 }]);
    const { report } = await settle(s, t.capability);
    expect(report).toMatchObject({ outcome: 'DONE' });
    expect(shopState(s).nodes[ERRORS].criteria).toEqual([{ criterion: 'AC-1', test_id: RED_ID, test: { path: TEST_FILE, name: FULL }, gate: 'red', output_sha256: run.gates[0]!.sha256, identity: { version: 'mycelink-test-identity/1', runner: 'js', path: TEST_FILE, key: FULL } }]);
  });

  it('a wrong display name beside a valid id is display only', async () => {
    const s = await shop();
    const { t } = await submitted(s, [{ criterion: 'AC-1', gate: 'red', full_name: FULL, path: TEST_FILE, name: 'invalid changesets > sorts the issues' }]);
    expect((await settle(s, t.capability)).report).toMatchObject({ outcome: 'DONE' });
    expect(shopState(s).nodes[ERRORS].criteria[0]).toMatchObject({ test_id: RED_ID, test: { path: TEST_FILE, name: FULL } });
  });

  it.each([
    ['its full name', FULL],
    ['its describes joined as Vitest prints them', `ChangesetValidationError ${LEAF}`],
    ['its unique leaf name', LEAF],
  ])('a legacy path and name resolve when they name exactly one bound test: %s', async (_label, name) => {
    const s = await shop();
    const { t } = await submitted(s, [{ criterion: 'AC-1', gate: 'red', path: TEST_FILE, name }]);
    expect((await settle(s, t.capability)).report).toMatchObject({ outcome: 'DONE' });
    expect(shopState(s).nodes[ERRORS].criteria[0]).toMatchObject({ test_id: RED_ID, test: { path: TEST_FILE, name: FULL } });
  });
});

describe('a criterion metadata error holds the same claim for correction', () => {
  it('an unknown id: held with the candidate ids, nothing charged or integrated; the capability holder resubmits the same commit and it settles DONE', async () => {
    const s = await shop();
    const { t, run } = await submitted(s, null, { criterionEvidence: [goodItem('', 'ffffffffffffffff')] });
    // The hash is the red gate's: only the id is wrong.
    const result = JSON.parse(readFileSync(t.result_slot, 'utf8')) as Record<string, any>;
    resubmit(t, result, { criterion_evidence: [goodItem(run.gates[0]!.sha256!, 'ffffffffffffffff')] });
    const held = await settle(s, t.capability);
    expect(held.report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED', state: 'REGRESSION_VERIFIED', next: 'correct' });
    expect(held.report['detail']).toMatch(/^CRITERION_EVIDENCE_INVALID:CRITERION_TEST_UNKNOWN: AC-1 \(test_id ffffffffffffffff, red\)/);
    expect(held.report['candidates']).toEqual(expect.arrayContaining([{ id: RED_ID, path: TEST_FILE, full_name: FULL, status: 'failed', gate: 'red' }]));
    expectHeld(s, t.claim_id);
    // The slot is ready for the corrected result of the same generation.
    expect(existsSync(dirname(t.result_slot))).toBe(true);
    // Settling the held result again changes nothing.
    expect((await settle(s, t.capability)).report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expectHeld(s, t.claim_id);
    resubmit(t, result, { criterion_evidence: [goodItem(run.gates[0]!.sha256!)] });
    const done = await settle(s, t.capability);
    expect(done.report, done.err).toMatchObject({ outcome: 'DONE' });
    const rt = shopState(s).nodes[ERRORS];
    expect(rt).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {}, claim: null });
    expect(rt.criteria[0]).toMatchObject({ test_id: RED_ID });
  });

  it('an ambiguous legacy name: held with every test it could mean', async () => {
    const s = await shop();
    const { t } = await submitted(s, [{ criterion: 'AC-1', gate: 'red', path: TEST_FILE, name: LEAF }], {}, { tests: { [TEST_FILE]: TWIN_RED }, impl: WORK.impl });
    const held = await settle(s, t.capability);
    expect(held.report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(held.report['detail']).toMatch(/^CRITERION_EVIDENCE_INVALID:CRITERION_TEST_AMBIGUOUS: /);
    expect(held.report['candidates'].map((c: { id: string }) => c.id).sort()).toEqual([RED_ID, TWIN_ID].sort());
    expectHeld(s, t.claim_id);
  });

  it('the gates stay closed while the evidence is held: the code, history and gate evidence are settled', async () => {
    const s = await shop();
    const { t, run } = await submitted(s, null, { criterionEvidence: [goodItem('', 'ffffffffffffffff')] });
    resubmit(t, JSON.parse(readFileSync(t.result_slot, 'utf8')), { criterion_evidence: [goodItem(run.gates[0]!.sha256!, 'ffffffffffffffff')] });
    expect((await settle(s, t.capability)).report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    const before = shopState(s).nodes[ERRORS].evidence;
    for (const gate of ['red', 'green', 'regression']) {
      const r = runGate(t, gate, s.control);
      expect(r.code, gate).not.toBe(0);
      expect(r.out, gate).toMatch(/EVIDENCE_CORRECTION_PENDING/);
    }
    expect(shopState(s).nodes[ERRORS].evidence).toEqual(before);
  });

  it('dispatch hands the correction to a fresh worker generation: a rotated capability, the held submission and the candidate ids in its pack', async () => {
    const s = await shop();
    const { t, run } = await submitted(s, null, { criterionEvidence: [goodItem('', 'ffffffffffffffff')] });
    const result = JSON.parse(readFileSync(t.result_slot, 'utf8')) as Record<string, any>;
    resubmit(t, result, { criterion_evidence: [goodItem(run.gates[0]!.sha256!, 'ffffffffffffffff')] });
    expect((await settle(s, t.capability)).report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    const d = await dispatch(s);
    expect(d.status, d.detail).toBe('DISPATCHED');
    const c = d.ticket!;
    expect(c).toMatchObject({ node_id: ERRORS, claim_id: t.claim_id, attempt: t.attempt });
    expect(c.dispatch_id).not.toBe(t.dispatch_id);
    expect(c.capability).not.toBe(t.capability);
    expect(c.correction).toMatchObject({ code: 'CRITERION_TEST_UNKNOWN', commit_sha: result['commit_sha'] });
    const pack = packOf(c);
    expect(pack['correction']).toMatchObject({ code: 'CRITERION_TEST_UNKNOWN', commit_sha: result['commit_sha'], gates: expect.arrayContaining([{ gate: 'red', output_sha256: run.gates[0]!.sha256 }]) });
    expect(pack['correction'].candidates).toEqual(expect.arrayContaining([{ id: RED_ID, path: TEST_FILE, full_name: FULL, status: 'failed', gate: 'red' }]));
    expect(c.prompt).toMatch(/Evidence correction/);
    expect(c.prompt).toMatch(/do not edit, commit or run a gate/i);
    // The old generation is spent.
    const stale = await settle(s, t.capability);
    expect(stale.report['outcome'] ?? stale.err).not.toBe('DONE');
    expect(shopState(s).nodes[ERRORS].state).toBe('REGRESSION_VERIFIED');
    // The fresh generation corrects only the metadata and settles.
    resubmit(c, result, { criterion_evidence: [goodItem(run.gates[0]!.sha256!)] });
    const done = await settle(s, c.capability);
    expect(done.report, done.err).toMatchObject({ outcome: 'DONE' });
    expect(shopState(s).nodes[ERRORS]).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {} });
  });
});

describe("a correction is metadata only: anything else is the product's failure", () => {
  it('a correction that gives up without changing anything (RETRYABLE) charges no attempt: the hold continues, one correction spent (CSET-203 r1)', async () => {
    const s = await shop();
    const { t, run } = await submitted(s, null, { criterionEvidence: [goodItem('', 'ffffffffffffffff')] });
    const result = JSON.parse(readFileSync(t.result_slot, 'utf8')) as Record<string, any>;
    resubmit(t, result, { criterion_evidence: [goodItem(run.gates[0]!.sha256!, 'ffffffffffffffff')] });
    expect((await settle(s, t.capability)).report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    resubmit(t, result, { outcome: 'RETRYABLE', failure_fingerprint: 'NO_TEST_PROVES_AC-1', criterion_evidence: [] });
    const r = await settle(s, t.capability);
    expect(r.report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED', state: 'REGRESSION_VERIFIED' });
    expect(r.report['detail']).toMatch(/^NO_TEST_PROVES_AC-1: /);
    expectHeld(s, t.claim_id);
    expect(shopState(s).nodes[ERRORS].claim.evidence_correction.corrections).toBe(1);
  });

  it('a commit made while the evidence is held moves the branch: the attempt is consumed and nothing is integrated', async () => {
    const s = await shop();
    const { t, run } = await submitted(s, null, { criterionEvidence: [goodItem('', 'ffffffffffffffff')] });
    const result = JSON.parse(readFileSync(t.result_slot, 'utf8')) as Record<string, any>;
    resubmit(t, result, { criterion_evidence: [goodItem(run.gates[0]!.sha256!, 'ffffffffffffffff')] });
    expect((await settle(s, t.capability)).report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    writeFiles(t.worktree, { 'packages/errors/src/extra.mjs': 'export const extra = 1;\n' });
    execSync(`git -C "${t.worktree}" add -A && git -C "${t.worktree}" commit -qm "feat: extra"`);
    resubmit(t, result, { criterion_evidence: [goodItem(run.gates[0]!.sha256!)] });
    const r = await settle(s, t.capability);
    expect(r.report['outcome']).not.toBe('DONE');
    expect(r.report['detail']).toMatch(/BRANCH_MOVED|TDD_CLAIM_MISMATCH/);
    const rt = shopState(s).nodes[ERRORS];
    expect(rt.integrated_sha).toBeNull();
    expect(Object.keys(rt.failure_counts).length).toBe(1);
  });

  it('corrections are bounded: the third refused correction is a failed attempt', async () => {
    const s = await shop();
    const { t, run } = await submitted(s, null, { criterionEvidence: [goodItem('', 'ffffffffffffffff')] });
    const result = JSON.parse(readFileSync(t.result_slot, 'utf8')) as Record<string, any>;
    const wrong = (n: number) => goodItem(run.gates[0]!.sha256!, `${'f'.repeat(15)}${n}`);
    resubmit(t, result, { criterion_evidence: [wrong(0)] });
    expect((await settle(s, t.capability)).report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    for (let n = 1; n <= 3; n++) {
      resubmit(t, result, { criterion_evidence: [wrong(n)] });
      const r = await settle(s, t.capability);
      if (n < 3) {
        expect(r.report, `correction ${n}`).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
        expect(shopState(s).nodes[ERRORS].claim.evidence_correction.corrections).toBe(n);
      } else {
        expect(r.report, `correction ${n}`).toMatchObject({ outcome: 'RETRY', state: 'READY' });
        expect(r.report['detail']).toMatch(/^CRITERION_EVIDENCE_INVALID:CRITERION_TEST_UNKNOWN: .*evidence correction limit/);
      }
    }
    const rt = shopState(s).nodes[ERRORS];
    expect(rt.claim).toBeNull();
    expect(rt.integrated_sha).toBeNull();
  });
});
