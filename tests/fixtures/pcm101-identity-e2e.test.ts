/**
 * PCM-101 final, normal arm, model-free, to the delivery it should have
 * reached (every platform), on a Maven-shaped clinic whose gates publish
 * Surefire's class-qualified names (helpers/vet-fixture.ts).
 *
 * The real run (WSL ~/mycelink-pilot-results/PCM-101-final/with-normal,
 * trusted): both Java producers ran a valid RED, GREEN and full regression
 * and committed product work. The stale-RED guard compared each JUnit
 * result's `org....VisitVetTest#createWithVet...` with the bare methods the
 * Java reader declares and refused every criterion with
 * CRITERION_TEST_UNKNOWN: the visits worker, refused by `tdd check`, answered
 * BLOCKED (`CRITERION_TEST_UNKNOWN:java-full_name-class-prefix-never-matches-
 * declaredAt`) and was parked, its attempt spent; the gateway was held for an
 * evidence correction no worker could make. A person was asked to decide.
 *
 * Here:
 *  1. the repaired controller: both producers settle on their first answers,
 *     each criterion named by path and method; integrated without a sibling's
 *     loss; both compatibility verifications, the review, C001, delivered;
 *  2. a worker that answers BLOCKED on an identity refusal the repaired
 *     identity accepts (as visits did) has submitted: settled as such,
 *     nothing charged, never parked;
 *  3. the run's exact end state — visits parked BLOCKED by its own answer,
 *     the gateway held — produced by the old comparison, then the repaired
 *     controller: one dispatch re-evaluates both administratively (no product
 *     attempt, no worker dispatched, no correction), and the feature goes on
 *     to C001 and its delivery; every receipt written once, the captured
 *     results untouched;
 *  4. that re-evaluation killed at each of its boundaries: the next dispatch
 *     finishes it exactly once.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { controllerKey } from '../helpers/authority.js';
import { fulfil, type ShopTicket } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { mutateState } from '../../src/state/feature-state.js';
import {
  GATEWAY_CONTROLLER_CLASS,
  GATEWAY_CONTROLLER_TEST,
  GATEWAY_NODE,
  GATEWAY_VERIFY,
  IDENTITY_BLOCKED_FINGERPRINT,
  VET_CANDIDATE,
  VET_FEATURE,
  VET_WORK,
  VISIT_RESOURCE_CLASS,
  VISIT_RESOURCE_TEST,
  VISITS_NODE,
  VISITS_VERIFY,
  commitVetControl,
  createVet,
  vetCli,
  vetEvents,
  vetState,
  type Vet,
} from '../helpers/vet-fixture.js';

// The old comparison, as core judged a test before canonical identities (f4b020c's declaredAt): the reported full name,
// or its last ` > ` segment, compared as a string with the names the file declares. On only while `legacy.on`.
const legacy = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/evidence/test-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/evidence/test-identity.js')>();
  const decl = await import('../../src/engine/test-declarations.js');
  const old = (test: { path: string; full_name: string }, source: string | null) => {
    if (source === null) return { status: 'missing' as const, detail: `${test.path} is not in the head` };
    const lang = decl.testLanguage(test.path);
    if (lang === 'opaque' || lang === 'data') return { status: 'unreadable' as const, detail: 'unreadable' };
    const title = test.full_name.includes(' > ') ? (test.full_name.split(' > ').pop() as string) : test.full_name;
    if (decl.declaredTests(test.path, source).some((t) => t.name === title || t.name === test.full_name)) {
      return { status: 'declared' as const, identity: actual.reportedIdentity(test) as NonNullable<ReturnType<typeof actual.reportedIdentity>>, translated: false, line: null };
    }
    return { status: 'missing' as const, detail: `${test.path} declares no test ${JSON.stringify(title)}` };
  };
  return { ...actual, resolveDeclaration: (test: Parameters<typeof actual.resolveDeclaration>[0], source: string | null) => (legacy.on ? old(test, source) : actual.resolveDeclaration(test, source)) };
});

afterAll(() => cleanupTmpRoots());

type Dispatched = { status: string; detail: string; ticket?: ShopTicket & { kind?: string }; controller_reports?: { node_id: string; outcome: string; detail?: string }[] };

async function dispatch(v: Vet): Promise<Dispatched> {
  const r = await vetCli(v, ['dispatch', VET_FEATURE, '--json']);
  return JSON.parse(r.out) as Dispatched;
}

async function settle(v: Vet, t: ShopTicket): Promise<{ outcome: string; detail: string; state?: string }> {
  const r = await vetCli(v, ['settle', VET_FEATURE, t.node_id, '--capability', t.capability, '--json']);
  return JSON.parse(r.out) as { outcome: string; detail: string; state?: string };
}

async function ticketFor(v: Vet, node: string): Promise<ShopTicket> {
  const d = await dispatch(v);
  expect(d.ticket?.node_id, `${d.status}: ${d.detail}`).toBe(node);
  return d.ticket as ShopTicket;
}

/** The producer's work as its worker did it: RED, the test commit, the production change, GREEN, its commit, regression, the result. */
function work(v: Vet, t: ShopTicket): Record<string, unknown> {
  const w = VET_WORK[t.node_id as keyof typeof VET_WORK];
  const compat = t.node_id === VISITS_NODE ? canonicalTestId('junit-xml', VISIT_RESOURCE_TEST, `${VISIT_RESOURCE_CLASS}#shouldFetchVisits`) : canonicalTestId('junit-xml', GATEWAY_CONTROLLER_TEST, `${GATEWAY_CONTROLLER_CLASS}#getOwnerDetails_withAvailableVisitsService`);
  const run = fulfil(t, { tests: w.tests, impl: w.impl, criteria: w.criteria.map((c) => (c.gate === 'green' ? { criterion: c.criterion, gate: c.gate, test_id: compat } : c)) }, v.control);
  expect(run.gates.map((g) => g.code), run.gates.map((g) => g.out.slice(-800)).join('\n----\n')).toEqual([0, 0, 0]);
  // Every test the RED declared and failed is named by its class-qualified full name, as Surefire reports it.
  expect(run.gates[0]!.tests.filter((x) => x.status === 'failed').map((x) => x.full_name).every((n) => /^org\.example\.clinic\.[a-z]+\.[A-Za-z]+Test(\$[A-Za-z]+)?#/.test(n))).toBe(true);
  return run.result;
}

/** The visits worker's answer in the real run: its work finished and committed, BLOCKED on the identity refusal. */
function answerBlocked(t: ShopTicket, result: Record<string, unknown>): void {
  writeFileSync(t.result_slot, JSON.stringify({ ...result, outcome: 'BLOCKED', failure_fingerprint: IDENTITY_BLOCKED_FINGERPRINT }, null, 2));
}

async function reviewAndDeliver(v: Vet, review: Dispatched): Promise<Record<string, unknown>> {
  const t = review.ticket as unknown as ReviewTicket;
  expect(t, `${review.status}: ${review.detail}`).toMatchObject({ kind: 'acceptance-review', review_id: `${VET_FEATURE}-R001` });
  await writeVerdict(t, verdictFor(reviewPacket(t)), { cwd: v.control });
  const settled = JSON.parse((await vetCli(v, ['review', 'settle', VET_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json'])).out);
  expect(settled, JSON.stringify(settled).slice(0, 1500)).toMatchObject({ outcome: 'PASS' });
  commitVetControl(v, 'R001 settled');
  const built = await dispatch(v);
  expect(built.status, built.detail).toBe('ALL_SETTLED');
  expect(vetState(v).nodes[VET_CANDIDATE].state).toBe('DONE');
  commitVetControl(v, 'C001');
  const delivered = JSON.parse((await vetCli(v, ['deliver', VET_FEATURE, '--json'])).out) as Record<string, unknown>;
  expect(delivered, JSON.stringify(delivered).slice(0, 3000)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VET_FEATURE}-C001` });
  commitVetControl(v, 'delivered C001');
  return delivered;
}

/** Nothing was charged: one attempt each, no failure counted, no correction, no product dispatch beyond each producer's first. */
function nothingCharged(v: Vet): void {
  const s = vetState(v);
  for (const id of [VISITS_NODE, GATEWAY_NODE]) {
    expect(s.nodes[id], id).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {} });
  }
  const events = vetEvents(v);
  expect(events.filter((e) => e.type === 'dispatch.correction')).toEqual([]);
  expect(events.filter((e) => e.type === 'dispatch.ticket').map((e) => e.node_id).sort()).toEqual([GATEWAY_NODE, VISITS_NODE].sort());
  expect(events.filter((e) => e.type === 'node.sibling_progress_lost')).toEqual([]);
}

/** The delivered head holds both producers' work and tests, and the full suite passes on it. */
function deliveredHolds(v: Vet): void {
  const head = git(v.repo, ['rev-parse', 'feature/VET-101']);
  for (const [path, text] of Object.entries({ 'clinic-visits-service/src/main/java/org/example/clinic/visits/Visit.java': 'Integer vetId;', 'clinic-api-gateway/src/main/java/org/example/clinic/gateway/ApiGatewayController.java': 'onErrorReturn' })) {
    expect(git(v.repo, ['show', `${head}:${path}`])).toContain(text);
  }
  expect(git(v.repo, ['ls-tree', '-r', '--name-only', head])).toContain('VisitVetTest.java');
  expect(git(v.repo, ['ls-tree', '-r', '--name-only', head])).toContain('OwnerDetailsVetNameTest.java');
}

/** The run's end state, produced by the old comparison: visits parked BLOCKED by its own answer, the gateway held. */
async function asTheRunLeftIt(): Promise<{ v: Vet; captured: Record<string, string> }> {
  const v = await createVet();
  legacy.on = true;
  try {
    const visits = await ticketFor(v, VISITS_NODE);
    answerBlocked(visits, work(v, visits));
    const parked = await settle(v, visits);
    expect(parked, parked.detail).toMatchObject({ outcome: 'BLOCKED', state: 'BLOCKED' });
    commitVetControl(v, 'visits parked');
    const gateway = await ticketFor(v, GATEWAY_NODE);
    work(v, gateway);
    const held = await settle(v, gateway);
    expect(held, held.detail).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED', state: 'REGRESSION_VERIFIED' });
    // The run's refusal, word for word: the class-qualified report against the bare method the file declares.
    expect(held.detail).toMatch(/CRITERION_TEST_UNKNOWN: AC-3 \(test_id [0-9a-f]{16}, red\): clinic-api-gateway\/src\/test\/java\/org\/example\/clinic\/gateway\/OwnerDetailsVetNameTest\.java declares no test "visitsCarryVetIdAndVetName" at the submitted head/);
  } finally {
    legacy.on = false;
  }
  // STATE.json as a core before this repair wrote it: no identity version on the hold, no result hash on the receipt.
  mutateState(v.featureDir, (s) => {
    const hold = s.nodes[GATEWAY_NODE]?.claim?.evidence_correction as Record<string, unknown> | undefined;
    if (hold) delete hold['identity_version'];
    const receipt = s.nodes[VISITS_NODE]?.last_settlement as Record<string, unknown> | undefined;
    if (receipt) {
      delete receipt['result_sha256'];
      delete receipt['result_file'];
    }
    return s;
  });
  commitVetControl(v, 'the run as it was left');
  const s = vetState(v);
  expect(s.nodes[VISITS_NODE]).toMatchObject({ state: 'BLOCKED', attempts: 1, claim: null, blocked_reason: IDENTITY_BLOCKED_FINGERPRINT });
  expect(s.nodes[GATEWAY_NODE].claim.evidence_correction).toMatchObject({ code: 'CRITERION_TEST_UNKNOWN', criterion: 'AC-3', corrections: 0 });
  // The controller copies of both answers, by hash: never rewritten.
  const captured: Record<string, string> = {};
  for (const id of [VISITS_NODE, GATEWAY_NODE]) {
    const dir = join(v.featureDir, 'sessions', id);
    for (const f of readdirSync(dir).filter((n) => n.startsWith('result.'))) captured[join(dir, f)] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  }
  expect(Object.keys(captured)).toHaveLength(2);
  return { v, captured };
}

/** The administrative re-evaluation of both, as one dispatch makes it: no worker, no attempt, the review handed out next. */
function expectReconciled(v: Vet, captured: Record<string, string>): void {
  const s = vetState(v);
  for (const id of [VISITS_NODE, GATEWAY_NODE]) {
    expect(s.nodes[id], id).toMatchObject({ state: 'DONE', attempts: 1 });
    // Each criterion stored by its canonical identity beside its raw JUnit name.
    for (const c of s.nodes[id].criteria) expect(c.identity, `${id} ${c.criterion}`).toMatchObject({ version: 'mycelink-test-identity/1', runner: 'junit', path: c.test.path });
  }
  expect(s.nodes[VISITS_NODE].criteria.map((c: { criterion: string; identity: { key: string } }) => [c.criterion, c.identity.key])).toEqual([
    ['AC-1', 'createWithVetStoresAndReturnsIt'],
    ['AC-2', 'createWithNonPositiveVetIsRejected'],
    ['AC-5', 'shouldFetchVisits'],
  ]);
  const events = vetEvents(v);
  const reconciled = events.filter((e) => e.type === 'node.identity_reconciled');
  expect(reconciled.map((e) => [e.node_id, e.data['cause']]).sort()).toEqual([
    [GATEWAY_NODE, 'evidence-correction'],
    [VISITS_NODE, 'worker-blocked'],
  ]);
  // One receipt each, sealed: what was refused, under which identity version, and what the canonical identity accepts.
  for (const e of reconciled) {
    const receipt = JSON.parse(readFileSync(join(v.control, e.data['receipt_path']), 'utf8'));
    expect(createHash('sha256').update(readFileSync(join(v.control, e.data['receipt_path']))).digest('hex')).toBe(e.data['receipt_sha256']);
    expect(receipt).toMatchObject({ schema: 'mycelink-identity-reconciliation/1', node_id: e.node_id, identity_version: 'mycelink-test-identity/1', refused: { code: 'CRITERION_TEST_UNKNOWN' } });
    expect(receipt.result.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  for (const [file, sha] of Object.entries(captured)) expect(createHash('sha256').update(readFileSync(file)).digest('hex'), file).toBe(sha);
  nothingCharged(v);
}

describe('PCM-101 final normal arm, replayed model-free on the Maven-shaped clinic', () => {
  it('the repaired controller: both Java producers settle on their first answers, integrate without a sibling\'s loss; compatibility, review, C001 and delivery pass', async () => {
    const v = await createVet();
    const visits = await ticketFor(v, VISITS_NODE);
    work(v, visits);
    // The worker's own check now agrees with settle.
    const checked = await vetCli(v, ['tdd', 'check', VET_FEATURE, VISITS_NODE, '--capability', visits.capability, '--json']);
    expect(JSON.parse(checked.out), checked.out + checked.err).toMatchObject({ ok: true });
    expect(await settle(v, visits)).toMatchObject({ outcome: 'DONE' });
    commitVetControl(v, 'visits');
    const gateway = await ticketFor(v, GATEWAY_NODE);
    work(v, gateway);
    expect(await settle(v, gateway)).toMatchObject({ outcome: 'DONE' });
    commitVetControl(v, 'gateway');
    const review = await dispatch(v);
    expect((review.controller_reports ?? []).map((r) => [r.node_id, r.outcome]).sort()).toEqual([
      [GATEWAY_VERIFY, 'DONE'],
      [VISITS_VERIFY, 'DONE'],
    ]);
    await reviewAndDeliver(v, review);
    nothingCharged(v);
    deliveredHolds(v);
  });

  it('a worker that answers BLOCKED on an identity refusal the canonical identity accepts has submitted: settled as such, nothing charged, never parked', async () => {
    const v = await createVet();
    const visits = await ticketFor(v, VISITS_NODE);
    answerBlocked(visits, work(v, visits));
    const settled = await settle(v, visits);
    expect(settled, settled.detail).toMatchObject({ outcome: 'DONE' });
    const reconciled = vetEvents(v).filter((e) => e.type === 'node.identity_reconciled');
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ node_id: VISITS_NODE, data: { cause: 'worker-blocked', fingerprint: IDENTITY_BLOCKED_FINGERPRINT } });
    commitVetControl(v, 'visits');
    const gateway = await ticketFor(v, GATEWAY_NODE);
    work(v, gateway);
    expect(await settle(v, gateway)).toMatchObject({ outcome: 'DONE' });
    commitVetControl(v, 'gateway');
    await reviewAndDeliver(v, await dispatch(v));
    nothingCharged(v);
    deliveredHolds(v);
  });

  it("the run's exact end state, reconciled: one dispatch settles the parked visits and the held gateway administratively; C001 is delivered", async () => {
    const { v, captured } = await asTheRunLeftIt();
    // What the controller says before it acts: its own work, never a person's decision.
    const next = JSON.parse((await vetCli(v, ['feature', 'status', VET_FEATURE, '--json'])).out).next_action;
    expect(next, JSON.stringify(next).slice(0, 1200)).toMatchObject({ kind: 'reconcile', resumable: true });
    const review = await dispatch(v);
    expect(review.status, review.detail).toBe('DISPATCHED');
    expect((review.controller_reports ?? []).map((r) => [r.node_id, r.outcome])).toEqual(expect.arrayContaining([
      [VISITS_NODE, 'DONE'],
      [GATEWAY_NODE, 'DONE'],
      [VISITS_VERIFY, 'DONE'],
      [GATEWAY_VERIFY, 'DONE'],
    ]));
    commitVetControl(v, 'reconciled');
    expectReconciled(v, captured);
    await reviewAndDeliver(v, review);
    deliveredHolds(v);
    // Reconciled once: a later dispatch finds nothing to re-evaluate.
    expect(vetEvents(v).filter((e) => e.type === 'node.identity_reconciled')).toHaveLength(2);
  });

  for (const point of ['identity-receipt-written', 'identity-reopened', 'fresh-verified', 'integrated']) {
    it(`killed at ${point} during the re-evaluation, the next dispatch finishes it exactly once`, async () => {
      const { v, captured } = await asTheRunLeftIt();
      const key = controllerKey(v.control);
      const killed = spawnSync(process.execPath, [join(process.cwd(), 'bin', 'mycelink.mjs'), 'dispatch', VET_FEATURE, '--control-root', v.control, '--authority', key, '--json'], { encoding: 'utf8', env: { ...process.env, MYCELINK_CRASH_AT: point } });
      expect(`${point}: ${killed.stdout.trim() === '' ? 'no report' : killed.stdout.slice(0, 400)}`).toBe(`${point}: no report`);
      const review = await dispatch(v);
      expect(review.status, review.detail).toBe('DISPATCHED');
      expect(review.ticket?.kind, review.detail).toBe('acceptance-review');
      commitVetControl(v, 'reconciled after a crash');
      expectReconciled(v, captured);
      // Integrated once each, and each criterion recorded once in each ledger.
      const events = vetEvents(v);
      const s = vetState(v);
      for (const id of [VISITS_NODE, GATEWAY_NODE]) {
        expect(events.filter((e) => e.type === 'node.transition' && e.node_id === id && e.data['to'] === 'INTEGRATED'), id).toHaveLength(1);
        const ledger = (s.nodes[id].criterion_ledger ?? []) as { criterion: string }[];
        expect(new Set(ledger.map((r) => r.criterion)).size, id).toBe(ledger.length);
      }
      expect(git(v.repo, ['log', '--format=%s', 'feature/VET-101']).split('\n').filter((m) => m.startsWith('integrate '))).toHaveLength(1);
      expect(existsSync(join(v.featureDir, 'STATE.json'))).toBe(true);
    });
  }
});
