/**
 * Reproduction capsules on the version fixture (CSET-203 r17's fault arm).
 *
 * r17: R005's AC-1 reproduction, written exactly — two cases of one
 * template-literal title in a loop — and kept out of the branch, passed on the
 * unchanged base. Nothing could name its tests: the red gate kept no challenge
 * material, the challenge line answered GATE_UNKNOWN, the check line
 * CRITERION_TEST_UNKNOWN (NO_DECLARED_TESTS once committed). The worker
 * answered BLOCKED and the node was parked.
 *
 * Here the same reproduction is sealed as a capsule (`tdd capsule`): run by
 * the claim's own module command on a throwaway checkout of the claim's base,
 * its bytes archived under the control repository, each test its run
 * reported by id and status. A passing capsule is challenge material and
 * nothing else; a failing one is RED material and nothing else. Its use is
 * bound to the claim, generation, order revision, base, module and criterion
 * it was sealed for: stale is administrative, forged fails closed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { ARP, ARP_FIXED_IMPL, ARP_SRC, CLI, CLI_TESTS, CLI_TRUNCATED_RED, VER_FEATURE, commitVerControl, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { commit, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { carriedItems, check, dispatch, reviewed, settle } from '../helpers/cset203-rework.js';
import { GAP_AC1_HOLDS, checkLine, writeChallenge } from '../helpers/cset203-challenge.js';
import { r7Reviewed, settleReview, siblingGraph } from '../helpers/cset203-r7.js';
import { CLI_AC3_HOLDS_BODY, CLI_AC3_HOLDS_TEST, GAP_AC3_HOLDS, cliAc3Clauses, events } from '../helpers/cset203-r14.js';
import { refinementFor, reviewPacket, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import {
  AC1_R005_REFINED,
  ARP_CAPSULE_FILE,
  ARP_CAPSULE_NAMES,
  ARP_CAPSULE_TESTS,
  ARP_PARTIAL_FILE,
  ARP_PARTIAL_TEST,
  ARP_PARTIAL_TESTS,
  ARP_R005_FILE,
  ARP_R005_NAMES,
  ARP_R005_TESTS,
  CLI_CAPSULE_FILE,
  CLI_CAPSULE_NAMES,
  CLI_CAPSULE_TESTS,
  GAP_AC1_PARTIAL,
  GAP_AC1_R004,
  archivedSource,
  arpCapsuleClauses,
  arpR005Clauses,
  capsuleDirOf,
  capsuleTestIds,
  challengeLineWith,
  cliCapsuleClauses,
  productSnapshot,
  registerCapsule,
  writeCapsuleChallenge,
  writeR17Blocked,
  writeReproduction,
} from '../helpers/cset203-r17.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const R001 = `${VER_FEATURE}-R001`;

/** The orchestrator, its capsule registration interrupted at `point`. */
const crashing = (s: Ver, point: string): Orchestrator =>
  new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, capsuleFault: (p: string) => { if (p === point) throw new Error(`CRASH at ${p}`); } } as never);

/** Nothing charged on a node: no failure counted, attempts as before. */
function uncharged(s: Ver, node: string, attempts: number): void {
  const rt = verState(s).nodes[node];
  expect(rt.failure_counts, JSON.stringify(rt.failure_counts)).toEqual({});
  expect(rt.attempts).toBe(attempts);
}

/** Another generation's answer, written to `t`'s own slot with `t`'s identity (a late answer, or one written before a rebase). */
function answerAs(t: ShopTicket, result: Record<string, unknown>): void {
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify({ ...result, node_id: t.node_id, claim_id: t.claim_id, dispatch_id: t.dispatch_id }, null, 2));
}

/** The capsule-run checkouts a registration made: none may be left behind. */
function leftoverRuns(s: Ver): string[] {
  const dir = join(s.control, '.mycelink', 'capsule-runs');
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** R001 GAPS AC-1 on apply-release-plan (its code holds R004's reproduction); the rework's ticket, and the attempts before it. */
async function r004Rework(gaps = { 'AC-1': GAP_AC1_R004 } as Record<string, any>, graph?: Record<string, unknown>): Promise<{ s: Ver; t: ShopTicket; attempts: number }> {
  const s = await r7Reviewed({ gaps, ...(graph !== undefined ? { graph } : {}) });
  const attempts = verState(s).nodes[ARP].attempts as number;
  const d = await dispatch(s);
  expect(d.status, d.detail).toBe('DISPATCHED');
  const t = d.ticket!;
  expect(t.node_id).toBe(ARP);
  return { s, t, attempts };
}

describe("r17: an uncommitted reproduction named by a template literal is sealed as a capsule and challenges the review's gap", () => {
  it('the red gate and the challenge line name the capsule line; registration runs on a throwaway checkout of the base, leaves the product untouched and is idempotent; the challenge citing it settles REVIEW_CHALLENGED with nothing charged; the refinement reviewer reads its source; it is never integrated', async () => {
    const { s, t, attempts } = await r004Rework();
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    // r17: the red gate names no test of it (template-literal titles) and keeps nothing — but it points at the capsule now.
    const red = runGate(t, 'red', s.control);
    expect(red.code).not.toBe(0);
    expect(red.out).toMatch(/capsule/);
    const before = challengeLineWith(t, s.control, '');
    expect(before.out).toMatchObject({ ok: false, code: 'REVIEW_CHALLENGE_GATE_UNKNOWN' });
    expect(before.out['detail']).toMatch(/tdd capsule/);

    const product = productSnapshot(s.repo, t.worktree);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    expect(sealed.code, sealed.raw).toBe(0);
    expect(sealed.out).toMatchObject({ ok: true, criterion: 'AC-1', result: 'passed', idempotent: false, files: [{ path: ARP_CAPSULE_TESTS }] });
    expect(sealed.out['capsule_id']).toMatch(/^CAP-[0-9a-f]{16}$/);
    const ids = capsuleTestIds(sealed, ARP_CAPSULE_NAMES);
    expect((sealed.out['tests'] as { status: string }[]).map((x) => x.status)).toEqual(['passed', 'passed']);
    // Nothing of the product moved: refs, worktrees, the worktree's head, index and files; the run's checkout is gone.
    expect(productSnapshot(s.repo, t.worktree)).toEqual(product);
    expect(leftoverRuns(s)).toEqual([]);
    // The sealed archive: the exact bytes, the run's output, the reviewer's artifact.
    const dir = capsuleDirOf(s.control, sealed.out['receipt_path']);
    const receipt = JSON.parse(readFileSync(join(dir, 'capsule.json'), 'utf8')) as Record<string, any>;
    expect(archivedSource(s.control, receipt, ARP_CAPSULE_TESTS)).toBe(ARP_CAPSULE_FILE);
    expect(receipt).toMatchObject({ capsule_id: sealed.out['capsule_id'], node_id: ARP, criterion: 'AC-1', base_sha: verState(s).nodes[ARP].claim.base_sha, order: { review_id: R001, revision: 0 } });
    expect(readFileSync(join(s.control, ...String(sealed.out['artifact_path']).split('/')), 'utf8')).toContain('test(`removes ${label}');
    // Again, the same bytes: the same capsule, nothing run again.
    const again = registerCapsule(t, s.control, 'AC-1');
    expect(again.out).toMatchObject({ ok: true, capsule_id: sealed.out['capsule_id'], capsule_sha256: sealed.out['capsule_sha256'], idempotent: true });
    expect(events(s).filter((e) => e.type === 'capsule.registered')).toHaveLength(1);

    // A passing capsule is never a DONE proof: the check line says so, and names the challenge.
    writeFileSync(t.result_slot, JSON.stringify({ schema_version: 2, node_id: t.node_id, claim_id: t.claim_id, dispatch_id: t.dispatch_id, outcome: 'CRITERIA', commands: [], commit_sha: git(t.worktree, ['rev-parse', 'HEAD']), changed_paths: [], evidence_paths: [], failure_fingerprint: null, decision_request: null, criteria: [{ criterion: 'AC-1', outcome: 'DONE' }], criterion_evidence: [{ criterion: 'AC-1', test_id: ids[0], gate: 'red', output_sha256: red.sha256, capsule_id: sealed.out['capsule_id'] }, ...carriedItems(t)] }, null, 2));
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'CRITERION_CAPSULE_PASSING' });

    // The challenge citing it: the skeleton from the capsule, the clauses traced to its own file.
    const { skeleton } = writeCapsuleChallenge(t, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }]);
    expect(skeleton['challenge']).toMatchObject({ gate_output_sha256: null, gaps: [{ criterion: 'AC-1', capsule: { capsule_id: sealed.out['capsule_id'], capsule_sha256: sealed.out['capsule_sha256'] } }] });
    const checked = checkLine(t, s.control);
    expect(checked.code, checked.raw).toBe(0);
    const settled = await settle(s, t);
    expect(settled, settled.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'AC-1 challenged by its capsule');
    uncharged(s, ARP, attempts);
    const state = verState(s);
    const challenge = state.acceptance_review.challenges.at(-1);
    expect(challenge).toMatchObject({ review_id: R001, node_id: ARP, status: 'pending', gaps: [{ criterion: 'AC-1' }] });
    const archived = JSON.parse(readFileSync(join(s.control, ...challenge.receipt_path.split('/')), 'utf8')) as Record<string, any>;
    expect(archived['capsules']).toEqual([expect.objectContaining({ capsule_id: sealed.out['capsule_id'], capsule_sha256: sealed.out['capsule_sha256'], criterion: 'AC-1', result: 'passed' })]);
    expect(readFileSync(join(s.control, ...(archived['files'] as { path: string; archived: string }[]).find((f) => f.path === ARP_CAPSULE_TESTS)!.archived.split('/')), 'utf8')).toBe(ARP_CAPSULE_FILE);
    // Never integrated: not on the node's branch, not on the integration branch.
    for (const ref of [`wip/${VER_FEATURE}/${ARP.slice(VER_FEATURE.length + 1)}`, `feature/${VER_FEATURE}`]) {
      const r = git(s.repo, ['ls-tree', '-r', '--name-only', ref]).split('\n');
      expect(r, ref).not.toContain(ARP_CAPSULE_TESTS);
    }
    // The refinement reviewer reads the reproduction's source and its tests through the challenge.
    const rr = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(rr).toMatchObject({ review_id: R001, refinement: { round: 1 } });
    const packet = reviewPacket(rr) as unknown as Record<string, any>;
    const entry = packet['refinement']['challenges'][0];
    expect(entry['tests'].map((x: { test_id: string }) => x.test_id).sort()).toEqual([...ids].sort());
    expect(entry['capsules']).toEqual([expect.objectContaining({ capsule_id: sealed.out['capsule_id'], result: 'passed' })]);
    expect(readFileSync(entry['capsules'][0]['artifact'], 'utf8')).toContain('assert.equal(files.has(created), false');
    await writeVerdict(rr, refinementFor(packet as never, { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
    const refined = await settleReview(s, rr);
    expect(refined, JSON.stringify(refined)).toMatchObject({ refinement: { decisions: [{ criterion: 'AC-1', decision: 'WITHDRAW' }] } });
    commitVerControl(s, 'R001 refined');
    uncharged(s, ARP, attempts);
  });
});

describe('a capsule outlives a restart of its holder, never its claim', () => {
  it("dispatch --resume rotates the capability: the old one can neither seal nor settle; the reissued worker's challenge cites the same capsule; the old ticket's late answer is stale", async () => {
    const { s, t, attempts } = await r004Rework();
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    expect(sealed.code, sealed.raw).toBe(0);
    // The host is killed here; a fresh session resumes the dispatch.
    const resumed = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', ARP, '--json'])).out) as { ticket?: ShopTicket; detail: string };
    const t2 = resumed.ticket!;
    expect(t2, resumed.detail).toMatchObject({ node_id: ARP, claim_id: t.claim_id, worktree: t.worktree });
    expect(t2.capability).not.toBe(t.capability);
    // The old holder cannot seal another capsule.
    const old = registerCapsule(t, s.control, 'AC-1');
    expect(old.code).not.toBe(0);
    expect(old.raw).toMatch(/CAPABILITY|capability/);
    // The reissued worker sees its capsule in the pack, current, and challenges with it.
    expect((JSON.parse(readFileSync((t2 as unknown as { context_pack_path: string }).context_pack_path, 'utf8')) as Record<string, any>)['rework']['capsules']).toEqual([expect.objectContaining({ capsule_id: sealed.out['capsule_id'], criterion: 'AC-1', result: 'passed', current: true })]);
    const { result } = writeCapsuleChallenge(t2, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }]);
    const settled = await settle(s, t2);
    expect(settled, settled.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    uncharged(s, ARP, attempts);
    // The old ticket answers late, citing the same capsule: stale, nothing moves.
    answerAs(t, result);
    const late = await settle(s, t);
    expect(late.outcome, late.detail).toMatch(/STALE|REFUSED/);
    uncharged(s, ARP, attempts);
  });
});

describe('a capsule bound to an order revision is stale once its order is rebased, and carried only explicitly, its reproduction unchanged', () => {
  it("its claim's order rebased to a later revision (the reproduction unchanged): the capsule is stale — refused by the line, a challenge citing it held uncharged; carried with --carry it is current again and its challenge settles; the next claim's citing it is late: held, never carried", async () => {
    const { s, t, attempts } = await r004Rework();
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    expect(sealed.code, sealed.raw).toBe(0);
    // The worker writes its challenge while the order is at revision 0.
    const written = writeCapsuleChallenge(t, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }]).result;
    // The order is rebased to revision 1, its gap carried unchanged (as a refinement of another gap rebases it: engine/review-revision.ts).
    mutateState(s.featureDir, (st) => {
      const b = st.nodes[ARP]!.rework_brief!;
      b.origin = { ...b.origin!, revision: 1 };
      return st;
    });
    commitVerControl(s, 'order rebased to revision 1');
    expect(challengeLineWith(t, s.control, `--capsule ${sealed.out['capsule_id']}`).out).toMatchObject({ ok: false, code: 'CAPSULE_STALE' });
    // A fresh session resumes the claim: the challenge written before the rebase is taken from its slot and settled — stale:
    // held for the correction, never charged.
    const resumed = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', ARP, '--json'])).out) as { status: string; settled: { outcome: string; detail: string } };
    expect(resumed.settled.outcome, resumed.settled.detail).toBe('EVIDENCE_CORRECTION_REQUIRED');
    expect(resumed.settled.detail).toMatch(/CAPSULE_STALE/);
    uncharged(s, ARP, attempts + 1);
    void written;
    // Carried explicitly: its bytes, base and module verified unchanged, the reproduction the same at revision 1.
    const t3 = (await dispatch(s)).ticket!;
    expect(t3).toMatchObject({ node_id: ARP, claim_id: t.claim_id });
    // The reissued correction generation's pack: the capsule stale, and carryable.
    expect(packOf(t3)['rework']['capsules']).toEqual([expect.objectContaining({ capsule_id: sealed.out['capsule_id'], current: false, carry: true })]);
    const carried = registerCapsule(t3, s.control, 'AC-1', ['--carry', sealed.out['capsule_id']]);
    expect(carried.code, carried.raw).toBe(0);
    expect(carried.out).toMatchObject({ ok: true, result: 'passed', carried_from: { capsule_id: sealed.out['capsule_id'] } });
    expect(carried.out['capsule_id']).not.toBe(sealed.out['capsule_id']);
    expect(events(s).filter((e) => e.type === 'capsule.carried')).toHaveLength(1);
    writeCapsuleChallenge(t3, s.control, [{ id: carried.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }]);
    const settled = await settle(s, t3);
    expect(settled, settled.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'AC-1 challenged by its carried capsule');
    uncharged(s, ARP, attempts);
    // The refinement refines AC-1 to another reproduction: the next claim's challenge naming the carried capsule is late — held, uncharged.
    const r2 = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(r2).toMatchObject({ review_id: R001, refinement: { round: 1 } });
    await writeVerdict(r2, refinementFor(reviewPacket(r2), { 'AC-1': { decision: 'REFINE', gap: AC1_R005_REFINED, producer: { node_id: ARP } } }), { cwd: s.control });
    expect(await settleReview(s, r2)).toMatchObject({ outcome: 'GAPS' });
    commitVerControl(s, 'R001 refined');
    const attempts4 = verState(s).nodes[ARP].attempts as number;
    const t4 = (await dispatch(s)).ticket!;
    expect(t4.node_id).toBe(ARP);
    expect(t4.claim_id).not.toBe(t.claim_id);
    // An earlier claim's capsule is never carried into a new claim.
    expect(registerCapsule(t4, s.control, 'AC-1', ['--carry', carried.out['capsule_id']]).out).toMatchObject({ ok: false, code: 'CAPSULE_STALE' });
    writeReproduction(t4, ARP_R005_TESTS, ARP_R005_FILE);
    const own = registerCapsule(t4, s.control, 'AC-1');
    expect(own.code, own.raw).toBe(0);
    writeCapsuleChallenge(t4, s.control, [{ id: own.out['capsule_id'], file: ARP_R005_TESTS, source: ARP_R005_FILE, names: ARP_R005_NAMES, clauses: arpR005Clauses }], {
      mutate: (ch) => Object.assign(ch['gaps'][0]['capsule'], { capsule_id: carried.out['capsule_id'], capsule_sha256: carried.out['capsule_sha256'] }),
    });
    const late = await settle(s, t4);
    expect(late.outcome, late.detail).toBe('EVIDENCE_CORRECTION_REQUIRED');
    expect(late.detail).toMatch(/CAPSULE_STALE/);
    uncharged(s, ARP, attempts4 + 1);
  });
});

describe('a capsule used outside what it was sealed for is refused', () => {
  it('another criterion, a forged id or hash, a planted receipt, prose claiming a capsule: refused, nothing recorded; forged is charged as a refused challenge', async () => {
    const GAP_AC2_HOLDS = { gap: { missing: 'no test shows the journal removed after a failed run', reproduction: 'make the formatter fail after the first change; assert no dot-named journal is left in .changeset afterwards', producer: { node_id: ARP } } };
    const { s, t, attempts } = await r004Rework({ 'AC-1': GAP_AC1_R004, 'AC-2': GAP_AC2_HOLDS });
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    expect(sealed.code, sealed.raw).toBe(0);
    // A capsule sealed for AC-1, cited for AC-2: refused by the line, and by the check in a written challenge.
    const cross = challengeLineWith(t, s.control, `--capsule ${sealed.out['capsule_id']} --criteria AC-2`);
    expect(cross.out).toMatchObject({ ok: false, code: 'CAPSULE_CRITERION' });
    const ac2 = ((JSON.parse(readFileSync((t as unknown as { context_pack_path: string }).context_pack_path, 'utf8')) as Record<string, any>)['rework']['review_gaps'] as { criterion: string; reproduction_sha256: string }[]).find((g) => g.criterion === 'AC-2')!;
    writeCapsuleChallenge(t, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }], {
      mutate: (ch) => Object.assign(ch['gaps'][0], { criterion: 'AC-2', reproduction_sha256: ac2.reproduction_sha256, clauses: [] }),
    });
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'REVIEW_CHALLENGE_CAPSULE_INVALID' });
    // A forged id, a forged hash: refused (fail closed).
    for (const forge of [(ch: Record<string, any>) => (ch['gaps'][0]['capsule']['capsule_id'] = 'CAP-0123456789abcdef'), (ch: Record<string, any>) => (ch['gaps'][0]['capsule']['capsule_sha256'] = '0'.repeat(64))]) {
      writeCapsuleChallenge(t, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }], { mutate: forge });
      expect(await check(s, t)).toMatchObject({ ok: false, code: 'REVIEW_CHALLENGE_CAPSULE_INVALID' });
    }
    // A receipt planted beside the real one, never registered: unknown.
    const dir = capsuleDirOf(s.control, sealed.out['receipt_path']);
    const planted = join(dir, '..', 'CAP-feedfacefeedface');
    writeFiles(planted, { 'capsule.json': readFileSync(join(dir, 'capsule.json'), 'utf8').replace(sealed.out['capsule_id'], 'CAP-feedfacefeedface') });
    writeCapsuleChallenge(t, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }], { mutate: (ch) => (ch['gaps'][0]['capsule']['capsule_id'] = 'CAP-feedfacefeedface') });
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'REVIEW_CHALLENGE_CAPSULE_INVALID' });
    // Prose that claims a capsule passed proves nothing: r17's BLOCKED answer naming one is a BLOCKED answer.
    // (Its capsule here is real and current, so the answer is converted into the challenge request instead: below.)
    // The forged answer settled: a refused challenge, charged as one, the review as it was.
    writeCapsuleChallenge(t, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }], { mutate: (ch) => (ch['gaps'][0]['capsule']['capsule_sha256'] = 'f'.repeat(64)) });
    const forged = await settle(s, t);
    expect(forged.outcome, forged.detail).toBe('RETRY');
    expect(forged.detail).toMatch(/REVIEW_CHALLENGE_INVALID:CAPSULE_INVALID/);
    expect(verState(s).nodes[ARP].attempts).toBe(attempts + 1);
    expect(verState(s).acceptance_review.challenges ?? []).toEqual([]);
  });

  it('prose that claims a capsule proves nothing: a BLOCKED answer naming one no registry holds is the BLOCKED answer it is (transcript spoof)', async () => {
    const { s, t } = await r004Rework();
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    const spoof = writeR17Blocked(t) as Record<string, unknown>;
    writeFileSync(t.result_slot, JSON.stringify({ ...spoof, failure_fingerprint: 'REVIEW_REPRODUCTION_PASSES: capsule CAP-0123456789abcdef passed on the base (sha256 ' + 'a'.repeat(64) + ')', notes: 'tdd capsule ... --criterion AC-1 -> capsule CAP-0123456789abcdef passed' }, null, 2));
    const settled = await settle(s, t);
    expect(settled.outcome, settled.detail).toBe('BLOCKED');
    expect(events(s).filter((e) => e.type === 'capsule.registered' || e.type === 'node.challenge_requested')).toEqual([]);
    expect(verState(s).nodes[ARP].claim ?? null).toBeNull();
  });

  it('a path outside the module, a traversal and a production file are refused by the command itself, nothing sealed', async () => {
    const { s, t } = await r004Rework();
    writeFiles(t.worktree, { 'packages/cli/test/elsewhere.test.mjs': "import { test } from 'node:test';\ntest('x', () => {});\n" });
    for (const files of ['packages/cli/test/elsewhere.test.mjs', '../outside.test.mjs', ARP_SRC]) {
      const r = registerCapsule(t, s.control, 'AC-1', ['--files', files]);
      expect(r.code, files).toBe(2);
      expect(r.out, files).toMatchObject({ ok: false, code: 'CAPSULE_PATH' });
    }
    expect(events(s).filter((e) => e.type === 'capsule.registered')).toEqual([]);
  });
});

describe('a failing capsule is RED material, and only that', () => {
  it('cited by a challenge it is refused; cited as a proof without its RED it is refused; committed test-first, red, the fix, green and regression, its RED cited with it settles DONE with the capsule as the criterion\'s provenance', async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1_PARTIAL });
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(ARP);
    writeReproduction(t, ARP_PARTIAL_TESTS, ARP_PARTIAL_FILE);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    expect(sealed.code, sealed.raw).toBe(0);
    expect(sealed.out).toMatchObject({ result: 'failed', tests: [expect.objectContaining({ full_name: ARP_PARTIAL_TEST, status: 'failed' })] });
    expect(sealed.out['detail'] ?? sealed.raw).toMatch(/RED/);
    // As a challenge: refused.
    const asChallenge = challengeLineWith(t, s.control, `--capsule ${sealed.out['capsule_id']}`);
    expect(asChallenge.out).toMatchObject({ ok: false, code: 'CAPSULE_FAILED' });
    // As a DONE proof, with the capsule's own run: refused — a failing capsule is a RED only once its red gate ran it.
    const capsuleTest = (sealed.out['tests'] as { id: string }[])[0]!.id;
    const answer = (evidence: Record<string, unknown>[]): void =>
      writeFileSync(t.result_slot, JSON.stringify({ schema_version: 1, node_id: t.node_id, claim_id: t.claim_id, dispatch_id: t.dispatch_id, outcome: 'SUBMITTED', commands: [], commit_sha: git(t.worktree, ['rev-parse', 'HEAD']), changed_paths: [], evidence_paths: [], failure_fingerprint: null, decision_request: null, criterion_evidence: evidence }, null, 2));
    answer([{ criterion: 'AC-1', test_id: capsuleTest, gate: 'red', output_sha256: sealed.out['run_output_sha256'], capsule_id: sealed.out['capsule_id'] }, ...carriedItems(t)]);
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'CRITERION_CAPSULE_NOT_RED' });
    // Promoted: its exact bytes committed test-first, the red gate, the fix, green, regression.
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    expect(red.tests.find((x) => x.id === capsuleTest)).toMatchObject({ status: 'failed' });
    commit(t.worktree, [ARP_PARTIAL_TESTS], 'test(apply-release-plan): a changelog write that fails part-way is rolled back');
    writeFiles(t.worktree, { [ARP_SRC]: ARP_FIXED_IMPL });
    expect(runGate(t, 'green', s.control).code).toBe(0);
    commit(t.worktree, [ARP_SRC], 'fix(apply-release-plan): restore every file the plan was about to change');
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    answer([{ criterion: 'AC-1', test_id: capsuleTest, gate: 'red', output_sha256: red.sha256, capsule_id: sealed.out['capsule_id'] }, ...carriedItems(t)]);
    const checked = await check(s, t);
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    const ac1 = (verState(s).nodes[ARP].criteria as Record<string, any>[]).find((c) => c['criterion'] === 'AC-1');
    expect(ac1).toMatchObject({ gate: 'red', test_id: capsuleTest, capsule: { capsule_id: sealed.out['capsule_id'], capsule_sha256: sealed.out['capsule_sha256'], result: 'failed' } });
    // Its bytes are what the history committed, byte for byte.
    expect(git(s.repo, ['show', `feature/${VER_FEATURE}:${ARP_PARTIAL_TESTS}`])).toBe(ARP_PARTIAL_FILE.trimEnd());
  });
});

describe("an answer the capsule's own path refused is administrative: held, never charged", () => {
  it("r17's own BLOCKED answer with a valid passing capsule on the claim is converted into the challenge request, uncharged; the reissued worker's challenge cites the capsule", async () => {
    const { s, t, attempts } = await r004Rework();
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    expect(sealed.code, sealed.raw).toBe(0);
    writeR17Blocked(t);
    const held = await settle(s, t);
    expect(held.outcome, held.detail).toBe('CHALLENGE_REQUIRED');
    expect(held.detail).toMatch(new RegExp(sealed.out['capsule_id']));
    uncharged(s, ARP, attempts + 1);
    const t2 = (await dispatch(s)).ticket!;
    expect(t2).toMatchObject({ node_id: ARP, claim_id: t.claim_id });
    expect(t2.prompt).toMatch(new RegExp(sealed.out['capsule_id']));
    writeCapsuleChallenge(t2, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }]);
    expect(await settle(s, t2)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    uncharged(s, ARP, attempts);
  });

  it('the capsule committed as a RED (its titles unreadable: NO_DECLARED_TESTS), or its uncommitted test cited (CRITERION_TEST_UNKNOWN): held uncharged, the capsule named', async () => {
    const { s, t, attempts } = await r004Rework();
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    expect(sealed.code, sealed.raw).toBe(0);
    const ids = capsuleTestIds(sealed, ARP_CAPSULE_NAMES);
    const red = runGate(t, 'red', s.control);
    // Uncommitted, cited through the refused red gate: CRITERION_TEST_UNKNOWN's cause is the capsule's path.
    const answer = (): void =>
      writeFileSync(t.result_slot, JSON.stringify({ schema_version: 1, node_id: t.node_id, claim_id: t.claim_id, dispatch_id: t.dispatch_id, outcome: 'SUBMITTED', commands: [], commit_sha: git(t.worktree, ['rev-parse', 'HEAD']), changed_paths: [], evidence_paths: [], failure_fingerprint: null, decision_request: null, criterion_evidence: [{ criterion: 'AC-1', test_id: ids[0], gate: 'red', output_sha256: red.sha256 }, ...carriedItems(t)] }, null, 2));
    answer();
    const unknown = await check(s, t);
    expect(unknown, JSON.stringify(unknown)).toMatchObject({ ok: false, code: 'CRITERION_CAPSULE_PATH' });
    expect(unknown['detail']).toMatch(new RegExp(sealed.out['capsule_id']));
    // Committed alone: the history declares no test it can name — the capsule's path again, held uncharged at settle.
    commit(t.worktree, [ARP_CAPSULE_TESTS], 'test: the reproduction');
    answer();
    const declared = await check(s, t);
    expect(declared, JSON.stringify(declared)).toMatchObject({ ok: false, code: 'CRITERION_CAPSULE_PATH' });
    const held = await settle(s, t);
    expect(held.outcome, held.detail).toBe('EVIDENCE_CORRECTION_REQUIRED');
    expect(held.detail).toMatch(/CAPSULE/);
    uncharged(s, ARP, attempts + 1);
    expect(verState(s).nodes[ARP].tdd_rejection ?? null).toBeNull();
  });
});

describe('a capsule registration is crash-safe and leaves nothing behind', () => {
  it('dying after its archive is sealed (before the registry), or while its checkout runs: the next registration finishes it, the checkout removed, the run made once', async () => {
    const { s, t } = await r004Rework();
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    expect(() => crashing(s, 'capsule-ran').registerCapsule(ARP, t.capability, { criterion: 'AC-1' })).toThrow(/CRASH/);
    expect(leftoverRuns(s)).toEqual([]);
    expect(() => crashing(s, 'capsule-sealed').registerCapsule(ARP, t.capability, { criterion: 'AC-1' })).toThrow(/CRASH/);
    expect(verState(s).nodes[ARP].claim.capsules ?? []).toEqual([]);
    const finished = registerCapsule(t, s.control, 'AC-1');
    expect(finished.code, finished.raw).toBe(0);
    expect(finished.out).toMatchObject({ ok: true, result: 'passed' });
    expect(verState(s).nodes[ARP].claim.capsules).toHaveLength(1);
    expect(leftoverRuns(s)).toEqual([]);
  });
});

describe('a capsule is replayed independently, and a tampered one is never trusted', () => {
  it('capsule verify --replay runs it again on a fresh checkout of its base with the same result; a changed archived byte fails it, and feature verify names a challenge built on it', async () => {
    const { s, t } = await r004Rework();
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    writeCapsuleChallenge(t, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }]);
    expect(await settle(s, t)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'challenged');
    const replay = JSON.parse((await verCli(s, ['capsule', 'verify', VER_FEATURE, '--replay', '--json'])).out) as Record<string, any>;
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, capsules: [expect.objectContaining({ capsule_id: sealed.out['capsule_id'], ok: true, replay: expect.objectContaining({ base: expect.objectContaining({ ok: true }) }) })] });
    expect(leftoverRuns(s)).toEqual([]);
    const receipt = JSON.parse(readFileSync(join(capsuleDirOf(s.control, sealed.out['receipt_path']), 'capsule.json'), 'utf8')) as Record<string, any>;
    const file = join(s.control, ...(receipt['files'] as { archived: string }[])[0]!.archived.split('/'));
    writeFileSync(file, readFileSync(file, 'utf8').replace("'formatter crashed'", "'formatter exploded'"));
    const tampered = JSON.parse((await verCli(s, ['capsule', 'verify', VER_FEATURE, '--json'])).out) as Record<string, any>;
    expect(tampered).toMatchObject({ ok: false, capsules: [expect.objectContaining({ capsule_id: sealed.out['capsule_id'], ok: false, problems: [expect.stringMatching(/CAPSULE_TAMPERED/)] })] });
    const verify = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { problems: string[] };
    expect(verify.problems.some((p) => /CAPSULE_INVALID/.test(p))).toBe(true);
  });
});

// Referenced so a fixture rename is caught by the type checker.
void [AC1_R005_REFINED, ARP_R005_FILE, ARP_R005_NAMES, ARP_R005_TESTS, arpR005Clauses, CLI_AC3_HOLDS_BODY, CLI_AC3_HOLDS_TEST, cliAc3Clauses, CLI_TESTS, CLI_TRUNCATED_RED];
