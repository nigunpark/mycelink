/**
 * Automatic, trusted repair of legacy evidence pointers (the CSET-202 rerun).
 *
 * The rerun's cli had a settled RED whose record named a canonical log a later
 * run of the same red gate had overwritten. R002 passed, C001 was cut, and
 * delivery refused it (OUTPUT_HASH_MISMATCH). The harness then ordered a
 * product rework asking the worker to "rerun the red gate": the worker
 * rightly refused (AC-4 holds, every test passes, no honest failing RED
 * exists) and asked a person. The exact bytes were in the node's archives the
 * whole time.
 *
 * Here delivery repairs such a pointer itself, only from an archive whose
 * bytes and provenance exactly match the stale record (never by running a
 * RED again, never from unrelated bytes), under the same candidate, nothing
 * charged, reopened or asked. Without such an archive the feature is marked
 * EVIDENCE_REPAIR_REQUIRED — administrative: no product rework, no worker —
 * and fails closed until the controller repairs it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { API, CORE, cli, hostLoop, hostPortfolio } from '../helpers/host-loop.js';
import { canonicalPath, dropLedgerArchive, holds, keepChallengeArchive, legacyOverwrite, recordOf, sha256 } from '../helpers/legacy-evidence.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { appendEvent, readEvents } from '../../src/state/event-log.js';
import { checkEvidenceOutput } from '../../src/evidence/paths.js';
import { featurePaths, nodeEvidenceDir } from '../../src/workspace/paths.js';

afterAll(() => cleanupTmpRoots());

interface Delivered {
  code: number;
  out: { ok?: boolean; status?: string; candidate_id?: string; evidence_repairs?: { repair_id: string }[] } | null;
  err: string;
}

async function deliver(p: Portfolio): Promise<Delivered> {
  const r = await cli(p, ['deliver', FEATURE_ID, '--json']);
  return { code: r.code, out: r.out.trim() ? (JSON.parse(r.out) as Delivered['out']) : null, err: r.err };
}

const state = (p: Portfolio) => loadState(p.featureDir)!.data;
const events = (p: Portfolio, type: string) => readEvents(featurePaths(p.control, FEATURE_ID).events, { includeRotated: true }).filter((e) => e.type === type);
/** Everything a repair may never change: each node's state, attempts, failures and claim, the reworks, the decisions, the epoch. */
const product = (p: Portfolio) => {
  const s = state(p);
  return JSON.stringify({
    nodes: Object.fromEntries(Object.entries(s.nodes).map(([id, rt]) => [id, { state: rt.state, attempts: rt.attempts, failure_counts: rt.failure_counts, claim: rt.claim, integrated: rt.integrated_sha, ledger: rt.criterion_ledger }])),
    reworks: s.reworks ?? [],
    decisions: s.pending_decisions,
    epoch: s.orchestration?.epoch ?? null,
    candidate: s.current_candidate,
  });
};

describe('evidence repair at delivery', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
  });

  it('repairs a stale legacy pointer from its exact archive and delivers the same candidate, nothing charged', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    const before = product(p);
    const candidate = state(p).current_candidate;
    expect(candidate).not.toBeNull();

    const r = await deliver(p);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, status: 'ACCEPTED', candidate_id: candidate });

    const s = state(p);
    const red = s.nodes[CORE]!.evidence.red!;
    // Only the broken pointer moved: to a new immutable copy of exactly the recorded bytes.
    expect(red.output_sha256).toBe(kept.record.output_sha256);
    expect(red.output_path).toMatch(/\/repaired\//);
    expect(red.output_path).not.toBe(canonicalPath(FEATURE_ID, CORE, 'red'));
    expect(checkEvidenceOutput(p.control, FEATURE_ID, red)).toBeNull();
    expect({ ...red, output_path: kept.record.output_path }).toEqual({ ...kept.record, output_path: kept.record.output_path });
    // The overwritten canonical file is left exactly as it is.
    expect(readFileSync(resolve(p.control, canonicalPath(FEATURE_ID, CORE, 'red')), 'utf8')).toMatch(/a later run/);
    // A receipt, bound in STATE.json, and one event.
    const repairs = s.evidence_repairs ?? [];
    expect(repairs).toHaveLength(1);
    // Its completion record archived exactly this RED, sealed: the strongest attestation there is.
    expect(repairs[0]).toMatchObject({ node_id: CORE, from_path: canonicalPath(FEATURE_ID, CORE, 'red'), sha256: kept.record.output_sha256, to_path: red.output_path, source: { kind: 'ledger-archive' } });
    expect(holds(resolve(p.control, repairs[0]!.receipt_path), repairs[0]!.receipt_sha256)).toBe(true);
    expect(events(p, 'evidence.repaired')).toHaveLength(1);
    // Nothing about the product changed: no node reopened, no attempt, no failure, no rework, no decision, same epoch.
    const after = JSON.parse(product(p)) as Record<string, unknown>;
    const was = JSON.parse(before) as Record<string, unknown>;
    expect(after['reworks']).toEqual(was['reworks']);
    expect(after['decisions']).toEqual([]);
    expect(after['epoch']).toEqual(was['epoch']);
    expect(after['candidate']).toEqual(candidate);
    for (const [id, n] of Object.entries(after['nodes'] as Record<string, Record<string, unknown>>)) {
      const old = (was['nodes'] as Record<string, Record<string, unknown>>)[id]!;
      expect({ attempts: n['attempts'], failure_counts: n['failure_counts'], integrated: n['integrated'], ledger: n['ledger'] }, id).toEqual({ attempts: old['attempts'], failure_counts: old['failure_counts'], integrated: old['integrated'], ledger: old['ledger'] });
    }
    expect(s.feature_state).toBe('COMPLETED');
    expect((await cli(p, ['feature', 'verify', FEATURE_ID, '--delivered'])).code).toBe(0);
  });

  it("a RED no completion record holds is restored from its red gate snapshot, attested by its generation's binding (the CSET-202 shape)", async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    dropLedgerArchive(p.control, FEATURE_ID, CORE);
    const candidate = state(p).current_candidate;
    const r = await deliver(p);
    expect(r.err).toBe('');
    expect(r.out).toMatchObject({ ok: true, status: 'ACCEPTED', candidate_id: candidate });
    const s = state(p);
    const repairs = s.evidence_repairs ?? [];
    // The live pointer moved; the sealed completion record is never edited: its recorded repair stands for its path.
    expect(repairs.map((x) => x.source.kind)).toEqual(['challenge-snapshot', 'challenge-snapshot']);
    expect(s.nodes[CORE]!.evidence.red!.output_path).toMatch(/\/repaired\//);
    const ledger = s.nodes[CORE]!.criterion_ledger!.find((c) => c.red?.record != null)!;
    expect(repairs.some((x) => x.from_path === ledger.red!.record!.output_path)).toBe(true);
    expect((await cli(p, ['feature', 'verify', FEATURE_ID, '--delivered'])).code).toBe(0);
  });

  it('a stale results pointer is found by verify and repaired with its output', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    // The host fixture's runner writes no report: give the RED the results an earlier release kept beside it.
    const body = Buffer.from(JSON.stringify({ schema: 'mycelink-test-results/1', format: 'vitest-json', results: [{ id: 'tests/publish.test.mjs::publishes', status: 'failed' }] }, null, 2) + '\n');
    const withResults = { ...kept, results: body, record: { ...kept.record, results: { format: 'vitest-json' as const, path: canonicalPath(FEATURE_ID, CORE, 'red', true), sha256: sha256(body), total: 1, passed: 0, failed: 1, skipped: 0 } } };
    keepChallengeArchive(p.control, FEATURE_ID, CORE, withResults);
    // The output still holds its bytes; only the results were written over by a later run.
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', withResults, { output: kept.bytes });
    const verify = await cli(p, ['feature', 'verify', FEATURE_ID]);
    expect(verify.code).toBe(1);
    expect(verify.out + verify.err).toMatch(/RESULTS_HASH_MISMATCH: .*red/);

    const r = await deliver(p);
    expect(r.err).toBe('');
    expect(r.out).toMatchObject({ ok: true, status: 'ACCEPTED' });
    const red = state(p).nodes[CORE]!.evidence.red!;
    expect(red.results!.path).toMatch(/\/repaired\//);
    expect(holds(resolve(p.control, red.results!.path), sha256(body))).toBe(true);
  });

  it('without an exact archive: EVIDENCE_REPAIR_REQUIRED, administrative, nothing reopened; the controller repairs and the same candidate delivers', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    dropLedgerArchive(p.control, FEATURE_ID, CORE);
    const before = product(p);
    const candidate = state(p).current_candidate;

    const refused = await deliver(p);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/EVIDENCE_REPAIR_REQUIRED/);
    expect(refused.err).toMatch(/administrative/i);
    expect(refused.err).toMatch(/OUTPUT_HASH_MISMATCH/);
    expect(product(p)).toBe(before);
    const marker = state(p).evidence_repair;
    expect(marker).toMatchObject({ status: 'REQUIRED', candidate_id: candidate, nodes: [CORE] });
    expect(events(p, 'evidence.repair_required')).toHaveLength(1);

    // What comes next is the controller's, never a worker's: not resumable by dispatch, no decision asked.
    const status = JSON.parse((await cli(p, ['feature', 'status', FEATURE_ID, '--json'])).out) as { next_action: { kind: string; resumable: boolean; command: string | null; detail: string } };
    expect(status.next_action).toMatchObject({ kind: 'evidence-repair', resumable: false, command: `evidence repair ${FEATURE_ID}` });
    expect(status.next_action.detail).toMatch(/no worker/i);
    // A product rework cannot repair evidence: refused, nothing changed.
    const rework = await cli(p, ['node', 'rework', FEATURE_ID, CORE, '--reason', 'rerun the red gate so its record matches its log']);
    expect(rework.code).not.toBe(0);
    expect(rework.err).toMatch(/REWORK_EVIDENCE_REPAIR/);
    expect(product(p)).toBe(before);
    expect(state(p).pending_decisions).toEqual([]);
    // The controller's repair, with no archive yet: still required, still nothing changed.
    const none = await cli(p, ['evidence', 'repair', FEATURE_ID, '--json']);
    expect(none.code).toBe(1);
    expect(state(p).evidence_repair).toMatchObject({ status: 'REQUIRED' });

    // The exact bytes are brought back where the red gate keeps what it ran (an operator restoring the node's archive).
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    const repaired = await cli(p, ['evidence', 'repair', FEATURE_ID, '--json']);
    expect(repaired.err).toBe('');
    expect(repaired.code).toBe(0);
    expect(state(p).evidence_repair ?? null).toBeNull();
    const retry = await deliver(p);
    expect(retry.err).toBe('');
    expect(retry.out).toMatchObject({ ok: true, status: 'ACCEPTED', candidate_id: candidate });
  });

  it('a link at the evidence path is never followed and never repaired automatically', async (ctx) => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    const at = resolve(p.control, kept.record.output_path);
    const elsewhere = join(p.root, 'elsewhere.log');
    writeFileSync(elsewhere, kept.bytes);
    rmSync(at);
    try {
      symlinkSync(elsewhere, at, 'file');
    } catch {
      ctx.skip();
    }
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/UNSAFE_EVIDENCE_PATH/);
    expect(r.err).toMatch(/EVIDENCE_REPAIR_REQUIRED/);
    expect(state(p).nodes[CORE]!.evidence.red!.output_path).toBe(kept.record.output_path);
    expect(state(p).evidence_repairs ?? []).toEqual([]);
  });

  it('a record whose path leaves the feature is never repaired, even with an exact archive', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    mutateState(p.featureDir, (s) => {
      s.nodes[CORE]!.evidence.red!.output_path = `features/${FEATURE_ID}/evidence/../../../outside.log`;
      return s;
    });
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/UNSAFE_EVIDENCE_PATH/);
    expect(r.err).toMatch(/EVIDENCE_REPAIR_REQUIRED/);
    expect(state(p).evidence_repairs ?? []).toEqual([]);
  });

  it('swapped files are tampering: never repaired, even where each record has an exact archive', async () => {
    const core = recordOf(p.control, FEATURE_ID, CORE);
    const api = recordOf(p.control, FEATURE_ID, API);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, core);
    keepChallengeArchive(p.control, FEATURE_ID, API, api);
    writeFileSync(resolve(p.control, core.record.output_path), api.bytes);
    writeFileSync(resolve(p.control, api.record.output_path), core.bytes);
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/EVIDENCE_SWAPPED/);
    expect(r.err).toMatch(/EVIDENCE_REPAIR_REQUIRED/);
    expect(state(p).evidence_repairs ?? []).toEqual([]);
  });

  it('same path, different hash: the record whose bytes are elsewhere is repaired, the one the file holds is untouched', async () => {
    const core = recordOf(p.control, FEATURE_ID, CORE);
    const api = recordOf(p.control, FEATURE_ID, API);
    keepChallengeArchive(p.control, FEATURE_ID, API, api);
    // API's record names CORE's file (a path two records share, two hashes): an earlier release's shared name.
    rmSync(resolve(p.control, api.record.output_path));
    mutateState(p.featureDir, (s) => {
      s.nodes[API]!.evidence.red!.output_path = core.record.output_path;
      return s;
    });
    const verify = await cli(p, ['feature', 'verify', FEATURE_ID]);
    expect(verify.out + verify.err).toMatch(/EVIDENCE_REFERENCE_CONFLICT/);
    const r = await deliver(p);
    expect(r.err).toBe('');
    expect(r.out).toMatchObject({ ok: true, status: 'ACCEPTED' });
    expect(state(p).nodes[CORE]!.evidence.red!.output_path).toBe(core.record.output_path);
    expect(state(p).nodes[API]!.evidence.red!.output_path).toMatch(/\/repaired\//);
    expect(holds(resolve(p.control, core.record.output_path), core.record.output_sha256)).toBe(true);
  });

  it('bytes that match, attested for another node, are never used (same bytes, different record)', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    // The exact bytes, kept under API's evidence and attested by an API red gate binding: provenance names another node.
    keepChallengeArchive(p.control, FEATURE_ID, API, kept);
    mutateState(p.featureDir, (s) => {
      const b = structuredClone(s.nodes[API]!.tdd_red_bindings![0]!);
      s.nodes[API]!.tdd_red_bindings = [...(s.nodes[API]!.tdd_red_bindings ?? []), { ...b, evidence_sha256: kept.record.output_sha256 }];
      return s;
    });
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    dropLedgerArchive(p.control, FEATURE_ID, CORE);
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/EVIDENCE_REPAIR_REQUIRED/);
    expect(state(p).evidence_repairs ?? []).toEqual([]);
  });

  it('an archive attested by a red gate of another base (wrong commit) is refused', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    mutateState(p.featureDir, (s) => {
      for (const b of s.nodes[CORE]!.tdd_red_bindings ?? []) if (b.evidence_sha256 === kept.record.output_sha256) b.head_sha = '0'.repeat(40);
      return s;
    });
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    dropLedgerArchive(p.control, FEATURE_ID, CORE);
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/EVIDENCE_REPAIR_REQUIRED/);
    expect(r.err).toMatch(/EVIDENCE_REPAIR_PROVENANCE/);
  });

  it('a malicious archive is refused: a link, or a file with a second hard link', async (ctx) => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    const dir = join(nodeEvidenceDir(p.control, FEATURE_ID, CORE), 'challenge-red', kept.record.output_sha256.slice(0, 16), 'gate');
    mkdirSync(dir, { recursive: true });
    const outside = join(p.root, 'outside-red.log');
    writeFileSync(outside, kept.bytes);
    try {
      symlinkSync(outside, join(dir, 'red.log'), 'file');
    } catch {
      ctx.skip();
    }
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    dropLedgerArchive(p.control, FEATURE_ID, CORE);
    const linked = await deliver(p);
    expect(linked.code).not.toBe(0);
    expect(linked.err).toMatch(/EVIDENCE_REPAIR_REQUIRED/);
    // A hard link to bytes kept elsewhere (two names for one file): not an archive the node owns alone.
    rmSync(join(dir, 'red.log'));
    linkSync(outside, join(dir, 'red.log'));
    const hard = await deliver(p);
    expect(hard.code).not.toBe(0);
    expect(hard.err).toMatch(/EVIDENCE_REPAIR_REQUIRED/);
    expect(state(p).evidence_repairs ?? []).toEqual([]);
  });

  it('is idempotent across repeated runs, a restart and a compacted event log', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    expect((await cli(p, ['evidence', 'repair', FEATURE_ID, '--json'])).code).toBe(0);
    const first = state(p).evidence_repairs;
    // The event log rotated (compacted) under the repair.
    appendEvent(featurePaths(p.control, FEATURE_ID).events, { idempotency_key: 'compaction-probe', type: 'probe', actor: 'test', feature_id: FEATURE_ID }, { maxBytes: 1 });
    expect((await cli(p, ['evidence', 'repair', FEATURE_ID, '--json'])).code).toBe(0);
    const again = JSON.parse((await cli(p, ['evidence', 'repair', FEATURE_ID, '--json'])).out) as { repaired: unknown[] };
    expect(again.repaired).toEqual([]);
    expect(state(p).evidence_repairs).toEqual(first);
    expect(events(p, 'evidence.repaired')).toHaveLength(1);
    const receipts = readdirSync(join(featurePaths(p.control, FEATURE_ID).evidenceDir, 'repairs'));
    expect(receipts.filter((n) => n.endsWith('.json'))).toHaveLength(1);
    expect((await deliver(p)).out).toMatchObject({ ok: true, status: 'ACCEPTED' });
  });

  it('migrates a state from before repairs (legacy absolute paths, no repair fields) and repairs it', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    const legacy = legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    // An even older record: its path absolute, on the machine that ran it.
    mutateState(p.featureDir, (s) => {
      s.nodes[CORE]!.evidence.red!.output_path = `C:/old/sealed/run-1/control/${legacy.output_path}`;
      delete (s as { evidence_repairs?: unknown }).evidence_repairs;
      delete (s as { evidence_repair?: unknown }).evidence_repair;
      return s;
    });
    expect((await cli(p, ['evidence', 'migrate', FEATURE_ID, '--json'])).code).toBe(0);
    expect(state(p).nodes[CORE]!.evidence.red!.output_path).toBe(canonicalPath(FEATURE_ID, CORE, 'red'));
    const r = await deliver(p);
    expect(r.err).toBe('');
    expect(r.out).toMatchObject({ ok: true, status: 'ACCEPTED' });
    expect(existsSync(resolve(p.control, state(p).nodes[CORE]!.evidence.red!.output_path))).toBe(true);
  });
});
