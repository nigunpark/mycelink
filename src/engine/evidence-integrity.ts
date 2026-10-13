/**
 * Evidence integrity, and the trusted repair of stale evidence pointers.
 *
 * The CSET-202 rerun: the cli's review rework ran its red gate twice in one
 * claim. An earlier release wrote every run of a gate to one canonical name,
 * so the second run replaced the bytes of the first while the first run's
 * record — kept as the node's RED — still named that path and hash. R002
 * passed, C001 was cut, and delivery refused it (OUTPUT_HASH_MISMATCH). The
 * harness then ordered a product rework asking the worker to "rerun the red
 * gate": the worker rightly refused — AC-4 holds, every test passes, no
 * honest failing RED exists on fixed code — and asked a person. The exact
 * bytes had been in the node's archives all along (the red gate's snapshot
 * of what it ran, the replaced generation's copies, the completion ledger).
 *
 * Gate evidence is immutable from creation now (evidence/store.ts), so new
 * records never go stale. This module keeps what is already on disk honest:
 *
 *  - every reference to an evidence artifact a feature holds — each node's
 *    gate records and their results, its judged history, its completion
 *    records' archives and histories, the proofs it carries, the generations
 *    its reworks replaced (and their restorable copies), every repair — is
 *    enumerated with what it names (path, hash), whether the delivered state
 *    stands on it (`live`), whether the record holding it is sealed by its
 *    own hash, and the provenance of the run that wrote it;
 *  - each is checked on its own (a regular, single-link file inside the
 *    feature, hashing as recorded), and across records: one path named with
 *    two hashes, two files holding each other's bytes (a swap), a pointer
 *    into the repaired copies no receipt attests, a receipt no longer as
 *    written;
 *  - a pointer whose bytes were written over or removed is repaired only
 *    from an archive whose bytes hash exactly as recorded *and* whose
 *    provenance — the same node, gate, generation and claim, and where they
 *    are known the same commit, module, plan and exit — is attested by the
 *    node's own records: a red gate's binding of its generation for that
 *    gate's snapshot, the rework that archived a replaced generation, a
 *    completion record still sealed as written. The bytes are copied to a new
 *    immutable path, a receipt sealed by its own hash is written once, and in
 *    one STATE.json write only the broken pointer moves (a sealed record is
 *    never edited: the recorded repair stands for its path, evidence/paths.ts)
 *    and the repair is bound by the receipt's hash; then one event. Nothing
 *    is run again, nothing reopened or charged, the epoch is not moved: a
 *    review PASS and the candidate stand.
 *  - without such an archive — or for a link, a path leaving the feature, a
 *    swap — nothing is repaired: a record of the delivered state is
 *    EVIDENCE_REPAIR_REQUIRED, an administrative stop (never a product
 *    rework: no worker can reproduce a historical RED on fixed code) that
 *    delivery fails closed on until the controller repairs it.
 *
 * Every step is idempotent: the copy is content-addressed, the receipt's
 * name is derived from what it repairs and is created exclusively, the state
 * write skips a repair already bound, the event is keyed by the repair.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { EvidenceKind, EvidenceRecord, EvidenceRepairEntry, EvidenceRepairRequired, EvidenceRepairSourceKind, FeatureState_, NodeRuntime, RestorableGeneration, TddRedBinding } from '../model/types.js';
import { evidenceKey, observeEvidenceOutput, relativeInside, repairedCopyOf, resolveEvidenceOutput } from '../evidence/paths.js';
import { writeImmutable } from '../evidence/store.js';
import { stableStringify } from '../graph/validate.js';
import { createExclusive } from '../state/atomic-json.js';
import { appendEvent } from '../state/event-log.js';
import { loadState, mutateState } from '../state/feature-state.js';
import { featurePaths, nodeEvidenceDir } from '../workspace/paths.js';
import { completionSha256 } from './criterion-ledger.js';
import { stoodRework } from './rework-brief.js';

export const REPAIR_SCHEMA = 'mycelink-evidence-repair/1' as const;

/** The repaired copies of a node, under its evidence. */
const REPAIRED_DIR = 'repaired';
/** The receipts, under the feature's evidence. */
const RECEIPTS_DIR = 'repairs';

const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

// ---- references ------------------------------------------------------------------------------------

/** Where a reference's pointer lives in STATE.json. */
export type ReferenceLocation =
  | { at: 'evidence'; node: string; kind: EvidenceKind; field: 'output' | 'results' }
  | { at: 'tdd-history'; node: string }
  | { at: 'ledger'; node: string; record: string; field: 'red' | 'red-results' | 'reproof-file' | 'history'; index?: number }
  | { at: 'carried'; node: string; index: number }
  | { at: 'rework-evidence'; node: string; index: number; kind: EvidenceKind }
  | { at: 'rework-history'; node: string; index: number }
  | { at: 'restore-evidence'; node: string; index: number; dependent: string | null; kind: EvidenceKind; field: 'output' | 'results' }
  | { at: 'restore-history'; node: string; index: number; dependent: string | null }
  | { at: 'repair'; repair: string };

/** What a record says of the run that wrote the bytes: what an archive must match to stand for them. */
export interface ReferenceProvenance {
  /** red, green, regression, ... or tdd-history. */
  gate: string;
  role: 'output' | 'results';
  /** The node's generation the record belongs to, and the claim that settled it. */
  generation: number | null;
  claim_id: string | null;
  commit_sha: string | null;
  module_sha256: string | null;
  plan_sha256: string | null;
  exit_code: number | null;
  /** A results reference: its record's output hash (the snapshot it was kept beside). */
  output_sha256: string | null;
  /** The red gate bindings of the reference's own generation: what attests a snapshot of it. */
  bindings: TddRedBinding[];
}

export interface EvidenceReference {
  /** Stable identity: where in STATE.json it is. */
  key: string;
  node_id: string | null;
  location: ReferenceLocation;
  path: string;
  sha256: string;
  /** The delivered state stands on it: a DONE node's own evidence, history, completion records and carried proofs, every repair. */
  live: boolean;
  /** The record holding it is sealed by its own hash (a completion record): repaired by a recorded repair, never edited. */
  sealed: boolean;
  provenance: ReferenceProvenance;
}

const NONE: Omit<ReferenceProvenance, 'gate' | 'role'> = { generation: null, claim_id: null, commit_sha: null, module_sha256: null, plan_sha256: null, exit_code: null, output_sha256: null, bindings: [] };

/** The generation a node's live work is: its claim's, its brief's, else one past each rework that stood. */
function liveGeneration(rt: NodeRuntime): number {
  return rt.claim?.generation ?? rt.rework_brief?.generation ?? (rt.rework_history ?? []).filter(stoodRework).length;
}

/** The references of one full evidence record (its output and results). */
function recordRefs(key: string, nodeId: string, rec: EvidenceRecord, base: Omit<ReferenceProvenance, 'gate' | 'role' | 'commit_sha' | 'module_sha256' | 'plan_sha256' | 'exit_code' | 'output_sha256'>, live: boolean, output: ReferenceLocation, results: ReferenceLocation | null, sealed = false): EvidenceReference[] {
  const provenance = { ...base, gate: rec.kind, commit_sha: rec.commit_sha ?? null, module_sha256: rec.module_sha256 ?? null, plan_sha256: rec.plan_sha256 ?? null, exit_code: rec.exit_code ?? null };
  const out: EvidenceReference[] = [{ key, node_id: nodeId, location: output, path: rec.output_path, sha256: rec.output_sha256, live, sealed, provenance: { ...provenance, role: 'output', output_sha256: null } }];
  if (rec.results && results !== null) out.push({ key: `${key}:results`, node_id: nodeId, location: results, path: rec.results.path, sha256: rec.results.sha256, live, sealed, provenance: { ...provenance, role: 'results', output_sha256: rec.output_sha256 } });
  return out;
}

/** The references of a restorable generation (a replaced one, kept whole for a challenge to restore). */
function restorableRefs(prefix: string, nodeId: string, index: number, dependent: string | null, g: RestorableGeneration, base: Omit<ReferenceProvenance, 'gate' | 'role' | 'commit_sha' | 'module_sha256' | 'plan_sha256' | 'exit_code' | 'output_sha256' | 'bindings'>): EvidenceReference[] {
  const out: EvidenceReference[] = [];
  const own = { ...base, bindings: g.tdd_red_bindings ?? [] };
  for (const [kind, rec] of Object.entries(g.evidence ?? {}) as [EvidenceKind, EvidenceRecord][]) {
    if (!rec) continue;
    out.push(...recordRefs(`${prefix}:evidence:${kind}`, nodeId, rec, own, false, { at: 'restore-evidence', node: nodeId, index, dependent, kind, field: 'output' }, { at: 'restore-evidence', node: nodeId, index, dependent, kind, field: 'results' }));
  }
  if (g.tdd_history) out.push({ key: `${prefix}:tdd_history`, node_id: nodeId, location: { at: 'restore-history', node: nodeId, index, dependent }, path: g.tdd_history.output_path, sha256: g.tdd_history.output_sha256, live: false, sealed: false, provenance: { ...NONE, ...own, gate: 'tdd-history', role: 'output' } });
  return out;
}

/** Every reference to an evidence artifact the feature's state holds. */
export function evidenceReferences(state: FeatureState_): EvidenceReference[] {
  const out: EvidenceReference[] = [];
  for (const [nodeId, rt] of Object.entries(state.nodes)) {
    const done = rt.state === 'DONE';
    const live = { generation: liveGeneration(rt), claim_id: rt.last_settlement?.claim_id ?? rt.claim?.claim_id ?? null, bindings: rt.tdd_red_bindings ?? [] };
    for (const [kind, rec] of Object.entries(rt.evidence ?? {}) as [EvidenceKind, EvidenceRecord][]) {
      if (!rec) continue;
      out.push(...recordRefs(`node:${nodeId}:evidence:${kind}`, nodeId, rec, live, done, { at: 'evidence', node: nodeId, kind, field: 'output' }, { at: 'evidence', node: nodeId, kind, field: 'results' }));
    }
    if (rt.tdd_history) out.push({ key: `node:${nodeId}:tdd_history`, node_id: nodeId, location: { at: 'tdd-history', node: nodeId }, path: rt.tdd_history.output_path, sha256: rt.tdd_history.output_sha256, live: done, sealed: false, provenance: { ...NONE, ...live, gate: 'tdd-history', role: 'output' } });
    for (const r of rt.criterion_ledger ?? []) {
      if (r.migrated === true) continue;
      const own = { ...NONE, generation: r.generation, claim_id: r.claim_id };
      const key = `node:${nodeId}:ledger:${r.record_id}`;
      if (r.red?.record) out.push(...recordRefs(`${key}:red`, nodeId, r.red.record, own, done, { at: 'ledger', node: nodeId, record: r.record_id, field: 'red' }, { at: 'ledger', node: nodeId, record: r.record_id, field: 'red-results' }, true));
      for (const [i, f] of (r.reproof?.files ?? []).entries()) out.push({ key: `${key}:reproof:${i}`, node_id: nodeId, location: { at: 'ledger', node: nodeId, record: r.record_id, field: 'reproof-file', index: i }, path: f.archived, sha256: f.sha256, live: done, sealed: true, provenance: { ...own, gate: 'reproof-file', role: 'output' } });
      if (r.history) out.push({ key: `${key}:history`, node_id: nodeId, location: { at: 'ledger', node: nodeId, record: r.record_id, field: 'history' }, path: r.history.output_path, sha256: r.history.output_sha256, live: done, sealed: true, provenance: { ...own, gate: 'tdd-history', role: 'output' } });
    }
    for (const [i, p] of (rt.carried_criterion_proofs ?? []).entries()) {
      out.push({ key: `node:${nodeId}:carried:${i}`, node_id: nodeId, location: { at: 'carried', node: nodeId, index: i }, path: p.output_path, sha256: p.output_sha256, live: done, sealed: false, provenance: { ...NONE, gate: p.gate, role: 'output', generation: p.source_generation, claim_id: p.source_claim_id, commit_sha: null } });
    }
    for (const [i, e] of (rt.rework_history ?? []).entries()) {
      const gen = { generation: e.generation ?? i, claim_id: e.claim_id ?? e.settlement?.claim_id ?? null };
      const prefix = `node:${nodeId}:rework:${i}`;
      for (const [kind, s] of Object.entries(e.evidence ?? {}) as [EvidenceKind, { output_path: string; output_sha256: string; exit_code: number; commit_sha: string | null }][]) {
        if (!s) continue;
        out.push({ key: `${prefix}:evidence:${kind}`, node_id: nodeId, location: { at: 'rework-evidence', node: nodeId, index: i, kind }, path: s.output_path, sha256: s.output_sha256, live: false, sealed: false, provenance: { ...NONE, ...gen, gate: kind, role: 'output', commit_sha: s.commit_sha ?? null, exit_code: s.exit_code ?? null, bindings: e.red_bindings ?? [] } });
      }
      if (e.tdd_history) out.push({ key: `${prefix}:tdd_history`, node_id: nodeId, location: { at: 'rework-history', node: nodeId, index: i }, path: e.tdd_history.output_path, sha256: e.tdd_history.output_sha256, live: false, sealed: false, provenance: { ...NONE, ...gen, gate: 'tdd-history', role: 'output' } });
      if (e.restore) out.push(...restorableRefs(`${prefix}:restore`, nodeId, i, null, e.restore, gen));
      for (const [dep, g] of Object.entries(e.restore_dependents ?? {})) {
        const depRt = state.nodes[dep];
        const depGen = { generation: depRt === undefined ? null : (depRt.rework_history ?? []).filter(stoodRework).length, claim_id: g.last_settlement?.claim_id ?? null };
        out.push(...restorableRefs(`${prefix}:dependent:${dep}`, dep, i, dep, g, depGen));
      }
    }
  }
  for (const r of state.evidence_repairs ?? []) {
    out.push({ key: `repair:${r.repair_id}:copy`, node_id: r.node_id, location: { at: 'repair', repair: r.repair_id }, path: r.to_path, sha256: r.sha256, live: true, sealed: true, provenance: { ...NONE, gate: 'repair', role: 'output' } });
  }
  return out;
}

// ---- checking ----------------------------------------------------------------------------------------

export type ReferenceCode =
  | 'OUTPUT_HASH_MISMATCH'
  | 'MISSING_OUTPUT'
  | 'UNSAFE_EVIDENCE_PATH'
  | 'OUTPUT_TOO_LARGE'
  | 'EVIDENCE_SWAPPED'
  | 'EVIDENCE_REFERENCE_CONFLICT'
  | 'EVIDENCE_REPAIR_UNATTESTED'
  | 'EVIDENCE_REPAIR_TAMPERED';

export interface ReferenceProblem {
  code: ReferenceCode;
  key: string;
  node_id: string | null;
  path: string;
  sha256: string;
  live: boolean;
  /** Bytes written over or removed: what a repair from an exact archive restores (never a link, a swap or a path leaving the feature). */
  repairable: boolean;
  detail: string;
  /** What the path holds now, when it is a file. */
  found: string | null;
}

interface Observed {
  ref: EvidenceReference;
  /** The record's own path, alone. */
  seen: ReturnType<typeof observeEvidenceOutput>;
  /** A recorded repair stands for it (its copy holding exactly the bytes). */
  covered: boolean;
}

function observeAll(controlRoot: string, featureId: string, refs: readonly EvidenceReference[]): Observed[] {
  const cache = new Map<string, ReturnType<typeof observeEvidenceOutput>>();
  const observe = (p: string): ReturnType<typeof observeEvidenceOutput> => {
    const hit = cache.get(p);
    if (hit !== undefined) return hit;
    const seen = observeEvidenceOutput(controlRoot, featureId, p);
    cache.set(p, seen);
    return seen;
  };
  return refs.map((ref) => {
    const seen = observe(ref.path);
    let covered = false;
    if (!(seen.kind === 'file' && seen.sha256 === ref.sha256) && seen.kind !== 'unsafe') {
      const copy = repairedCopyOf(controlRoot, featureId, { output_path: ref.path, output_sha256: ref.sha256 });
      if (copy !== null) {
        const there = observe(copy);
        covered = there.kind === 'file' && there.sha256 === ref.sha256;
      }
    }
    return { ref, seen, covered };
  });
}

/** What a recorded repair's receipt and copy are now: null when both are exactly as bound. */
function repairEntryProblem(controlRoot: string, featureId: string, r: EvidenceRepairEntry): string | null {
  const receipt = observeEvidenceOutput(controlRoot, featureId, r.receipt_path);
  if (receipt.kind !== 'file' || receipt.sha256 !== r.receipt_sha256) return `the receipt ${r.receipt_path} of ${r.repair_id} is ${receipt.kind === 'file' ? 'not the one STATE.json binds' : receipt.problem}`;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(readFileSync(receipt.path, 'utf8')) as Record<string, unknown>;
  } catch {
    return `the receipt of ${r.repair_id} is not JSON`;
  }
  const { sha256: seal, ...rest } = body;
  if (body['schema'] !== REPAIR_SCHEMA || seal !== sha256(stableStringify(rest))) return `the receipt of ${r.repair_id} no longer hashes to its seal`;
  const from = body['from'] as { path?: unknown; sha256?: unknown } | undefined;
  const to = body['to'] as { path?: unknown; sha256?: unknown } | undefined;
  if (body['repair_id'] !== r.repair_id || from?.path !== r.from_path || from?.sha256 !== r.sha256 || to?.path !== r.to_path || to?.sha256 !== r.sha256) return `the receipt of ${r.repair_id} does not say what STATE.json binds`;
  return null;
}

/**
 * Every problem of every reference, each on its own and across records: the bytes written over or gone (repairable
 * from an exact archive), anything no record may stand on (a link, a path leaving the feature), a path named with two
 * hashes, a swap, a repaired pointer or a repair no receipt attests.
 */
export function referenceProblems(controlRoot: string, featureId: string, state: FeatureState_): ReferenceProblem[] {
  const refs = evidenceReferences(state);
  const seen = observeAll(controlRoot, featureId, refs);
  const problems: ReferenceProblem[] = [];
  const add = (o: Observed, code: ReferenceCode, detail: string, repairable: boolean): void => {
    problems.push({ code, key: o.ref.key, node_id: o.ref.node_id, path: o.ref.path, sha256: o.ref.sha256, live: o.ref.live, repairable, detail, found: o.seen.kind === 'file' ? o.seen.sha256 : null });
  };
  // Swaps: two records, each file holding exactly the bytes the other names.
  const broken = seen.filter((o) => o.seen.kind === 'file' && o.seen.sha256 !== o.ref.sha256 && !o.covered);
  const swapped = new Set<string>();
  for (const a of broken) {
    for (const b of broken) {
      if (a === b || a.ref.path === b.ref.path || a.seen.kind !== 'file' || b.seen.kind !== 'file') continue;
      if (a.seen.sha256 === b.ref.sha256 && b.seen.sha256 === a.ref.sha256 && a.ref.sha256 !== b.ref.sha256) {
        swapped.add(a.ref.key);
        swapped.add(b.ref.key);
      }
    }
  }
  const repairs = state.evidence_repairs ?? [];
  for (const o of seen) {
    const { ref } = o;
    if (ref.location.at === 'repair') {
      const entry = repairs.find((r) => r.repair_id === (ref.location as { repair: string }).repair) as EvidenceRepairEntry;
      const bad = o.seen.kind !== 'file' || o.seen.sha256 !== ref.sha256 ? `its copy ${ref.path}: ${o.seen.kind === 'file' ? 'holds other bytes' : o.seen.problem}` : repairEntryProblem(controlRoot, featureId, entry);
      if (bad !== null) add(o, 'EVIDENCE_REPAIR_TAMPERED', `EVIDENCE_REPAIR_TAMPERED: ${entry.repair_id}: ${bad}`, false);
      continue;
    }
    if (swapped.has(ref.key)) {
      add(o, 'EVIDENCE_SWAPPED', `EVIDENCE_SWAPPED: ${ref.path} holds the bytes another record names (${(o.seen as { sha256: string }).sha256.slice(0, 12)}), and that record's file holds these (${ref.sha256.slice(0, 12)}): tampering, never repaired`, false);
      continue;
    }
    if (o.seen.kind === 'unsafe') {
      add(o, o.seen.problem.startsWith('OUTPUT_TOO_LARGE') ? 'OUTPUT_TOO_LARGE' : 'UNSAFE_EVIDENCE_PATH', o.seen.problem, false);
      continue;
    }
    if (o.seen.kind === 'file' && o.seen.sha256 === ref.sha256) {
      // A pointer into the repaired copies stands only on a repair STATE.json binds.
      if (/\/repaired\//.test(ref.path.replace(/\\/g, '/')) && !repairs.some((r) => r.to_path === ref.path && r.sha256 === ref.sha256)) {
        add(o, 'EVIDENCE_REPAIR_UNATTESTED', `EVIDENCE_REPAIR_UNATTESTED: ${ref.path} is a repaired copy no repair in STATE.json attests`, false);
      }
      continue;
    }
    if (o.covered) continue;
    if (o.seen.kind === 'missing') add(o, 'MISSING_OUTPUT', o.seen.problem, true);
    else add(o, 'OUTPUT_HASH_MISMATCH', `OUTPUT_HASH_MISMATCH: ${ref.path} hashes to ${(o.seen as { sha256: string }).sha256.slice(0, 12)}, record says ${ref.sha256.slice(0, 12)}`, true);
  }
  // One path, two hashes: two records naming the same file, at most one of them right (an earlier release's shared name).
  const byPath = new Map<string, Observed[]>();
  for (const o of seen) {
    if (o.ref.location.at === 'repair') continue;
    const k = evidenceKey(controlRoot, featureId, o.ref.path);
    if (k === null) continue;
    byPath.set(k, [...(byPath.get(k) ?? []), o]);
  }
  for (const group of byPath.values()) {
    const hashes = [...new Set(group.map((o) => o.ref.sha256))];
    if (hashes.length < 2) continue;
    const lead = group.find((o) => o.ref.live) ?? (group[0] as Observed);
    problems.push({
      code: 'EVIDENCE_REFERENCE_CONFLICT',
      key: lead.ref.key,
      node_id: lead.ref.node_id,
      path: lead.ref.path,
      sha256: lead.ref.sha256,
      live: group.some((o) => o.ref.live && !o.covered && !(o.seen.kind === 'file' && o.seen.sha256 === o.ref.sha256)),
      repairable: false,
      detail: `EVIDENCE_REFERENCE_CONFLICT: ${lead.ref.path} is named with ${hashes.length} different hashes (${group.map((o) => `${o.ref.key} ${o.ref.sha256.slice(0, 12)}`).slice(0, 6).join(', ')}): at most one of them is what the file holds`,
      found: lead.seen.kind === 'file' ? lead.seen.sha256 : null,
    });
  }
  return problems;
}

/**
 * The problems feature verify reports beyond each DONE node's own required evidence outputs and judged history
 * (engine/feature-verify.ts checks those): their results, the histories completion records name, the proofs a DONE
 * node carries, cross-record conflicts and swaps, and every recorded repair — each where the delivered state stands on it.
 */
export function evidenceIntegrityProblems(controlRoot: string, featureId: string, state: FeatureState_): string[] {
  const out: string[] = [];
  for (const p of referenceProblems(controlRoot, featureId, state)) {
    if (!p.live) continue;
    const loc = evidenceReferences(state).find((r) => r.key === p.key)?.location;
    // The outputs and histories feature verify already names (as `<code>: <node> <kind> ...`).
    if (loc !== undefined && ((loc.at === 'evidence' && loc.field === 'output') || loc.at === 'tdd-history') && ['OUTPUT_HASH_MISMATCH', 'MISSING_OUTPUT', 'UNSAFE_EVIDENCE_PATH', 'OUTPUT_TOO_LARGE'].includes(p.code)) continue;
    if (loc !== undefined && loc.at === 'evidence' && loc.field === 'results') {
      const code = p.code === 'OUTPUT_HASH_MISMATCH' ? 'RESULTS_HASH_MISMATCH' : p.code === 'MISSING_OUTPUT' ? 'MISSING_RESULTS' : p.code;
      out.push(`${code}: ${p.node_id} ${loc.kind} results ${p.detail.slice(p.detail.indexOf(': ') + 2)}`);
      continue;
    }
    if (loc !== undefined && loc.at === 'ledger' && (loc.field === 'red' || loc.field === 'red-results' || loc.field === 'reproof-file') && ['OUTPUT_HASH_MISMATCH', 'MISSING_OUTPUT', 'UNSAFE_EVIDENCE_PATH', 'OUTPUT_TOO_LARGE'].includes(p.code)) continue; // COMPLETION_LEDGER_INVALID names these
    if (loc !== undefined && loc.at === 'ledger' && loc.field === 'history') {
      out.push(`COMPLETION_LEDGER_INVALID: ${p.node_id} COMPLETION_HISTORY_INVALID: the judged history of ${loc.record}: ${p.detail}`);
      continue;
    }
    if (loc !== undefined && loc.at === 'carried') {
      out.push(`CARRIED_PROOF_INVALID: ${p.node_id} carried proof ${loc.index}: ${p.detail}`);
      continue;
    }
    out.push(p.node_id === null ? p.detail : `${p.detail} (${p.node_id})`);
  }
  return [...new Set(out)];
}

// ---- sources ----------------------------------------------------------------------------------------------

interface Source {
  kind: EvidenceRepairSourceKind;
  /** Control-root-relative path of the archived bytes. */
  path: string;
  provenance: { generation: number | null; claim_id: string | null; commit_sha: string | null; module_sha256: string | null; plan_sha256: string | null; exit_code: number | null; gate: string; attested_by: string };
}

/** An archive file that holds exactly `sha` as a regular single-link file inside the node's own evidence; null otherwise. */
function exactArchive(controlRoot: string, featureId: string, nodeId: string, path: string, sha: string): string | null {
  const resolved = resolveEvidenceOutput(controlRoot, featureId, { output_path: path });
  if (!resolved.ok || relativeInside(nodeEvidenceDir(controlRoot, featureId, nodeId), resolved.path) === null) return null;
  const seen = observeEvidenceOutput(controlRoot, featureId, path);
  if (seen.kind !== 'file' || seen.sha256 !== sha) return null;
  return relativeInside(controlRoot, seen.path);
}

/** Every archive of the node holding exactly what `ref` names, with what attests it. */
function archivesFor(controlRoot: string, featureId: string, state: FeatureState_, ref: EvidenceReference): Source[] {
  const nodeId = ref.node_id;
  if (nodeId === null) return [];
  const rt = state.nodes[nodeId];
  if (rt === undefined) return [];
  const out: Source[] = [];
  const want = ref.sha256;
  const role = ref.provenance.role;
  const gate = ref.provenance.gate;
  const take = (kind: EvidenceRepairSourceKind, path: string | null, provenance: Source['provenance']): void => {
    if (path === null) return;
    const exact = exactArchive(controlRoot, featureId, nodeId, path, want);
    if (exact !== null && !out.some((s) => s.path === exact && s.kind === kind)) out.push({ kind, path: exact, provenance });
  };
  // A replaced generation's copies, attested by the rework that archived them.
  for (const [i, e] of (rt.rework_history ?? []).entries()) {
    const gen = { generation: e.generation ?? i, claim_id: e.claim_id ?? e.settlement?.claim_id ?? null };
    const dirs = new Set<string>();
    for (const s of Object.values(e.evidence ?? {})) if (s && /\/replaced\/g\d+\//.test(s.output_path.replace(/\\/g, '/'))) dirs.add(dirname(s.output_path.replace(/\\/g, '/')));
    if (e.tdd_history && /\/replaced\/g\d+\//.test(e.tdd_history.output_path.replace(/\\/g, '/'))) dirs.add(dirname(e.tdd_history.output_path.replace(/\\/g, '/')));
    if (gate === 'tdd-history') {
      if (e.tdd_history?.output_sha256 === want) take('replaced-generation', e.tdd_history.output_path, { ...gen, commit_sha: null, module_sha256: null, plan_sha256: null, exit_code: null, gate: 'tdd-history', attested_by: `rework ${i}'s judged history` });
      continue;
    }
    for (const [kind, s] of Object.entries(e.evidence ?? {}) as [EvidenceKind, { output_path: string; output_sha256: string; exit_code: number; commit_sha: string | null }][]) {
      if (!s || kind !== gate) continue;
      const full = e.restore?.evidence?.[kind];
      const attested = { ...gen, commit_sha: s.commit_sha ?? null, module_sha256: full?.module_sha256 ?? null, plan_sha256: full?.plan_sha256 ?? null, exit_code: s.exit_code ?? null, gate: kind, attested_by: `rework ${i}'s archived ${kind}` };
      if (role === 'output' && s.output_sha256 === want) take('replaced-generation', s.output_path, attested);
      if (role === 'results' && full?.results?.sha256 === want && full.output_sha256 === ref.provenance.output_sha256) {
        for (const d of dirs) for (const name of listing(controlRoot, d)) take('replaced-generation', `${d}/${name}`, attested);
      }
    }
  }
  // A completion record still sealed as written: the RED it archived (and its results), the re-proof gate it kept.
  for (const r of rt.criterion_ledger ?? []) {
    if (r.migrated === true || completionSha256(r) !== r.sha256) continue;
    const red = r.red?.record ?? null;
    const own = { generation: r.generation, claim_id: r.claim_id, commit_sha: red?.commit_sha ?? null, module_sha256: red?.module_sha256 ?? null, plan_sha256: red?.plan_sha256 ?? null, exit_code: red?.exit_code ?? null, gate: 'red', attested_by: `completion ${r.record_id}` };
    if (gate !== 'red' || red === null) continue;
    if (role === 'output' && red.output_sha256 === want) take('ledger-archive', red.output_path, own);
    if (role === 'results' && red.results?.sha256 === want && red.output_sha256 === ref.provenance.output_sha256) take('ledger-archive', red.results.path, own);
    if (role === 'output' && r.reproof?.gate_output_sha256 === want && r.archive !== null) take('ledger-archive', `${r.archive}/reproof/gate/red.log`, { ...own, commit_sha: null, module_sha256: null, plan_sha256: null, exit_code: null, attested_by: `completion ${r.record_id}'s re-proof` });
  }
  // What a red gate kept of what it ran (challenge-red/<sha16>/gate/), attested by a binding of that gate in a generation.
  if (gate === 'red') {
    const lists: { generation: number | null; claim_id: string | null; bindings: TddRedBinding[]; what: string }[] = [
      { generation: liveGeneration(rt), claim_id: rt.last_settlement?.claim_id ?? rt.claim?.claim_id ?? null, bindings: rt.tdd_red_bindings ?? [], what: 'the live generation' },
      ...(rt.rework_history ?? []).map((e, i) => ({ generation: e.generation ?? i, claim_id: e.claim_id ?? e.settlement?.claim_id ?? null, bindings: e.red_bindings ?? [], what: `rework ${i}` })),
    ];
    const output = role === 'output' ? want : ref.provenance.output_sha256;
    if (output !== null) {
      const root = `${relativeInside(controlRoot, nodeEvidenceDir(controlRoot, featureId, nodeId))}/challenge-red`.replace(/\\/g, '/');
      const dirs = listing(controlRoot, root).filter((d) => d === output.slice(0, 16) || d.startsWith(`${output.slice(0, 16)}-`));
      for (const l of lists) {
        for (const b of l.bindings) {
          if (b.evidence_sha256 !== output) continue;
          for (const d of dirs) take('challenge-snapshot', `${root}/${d}/gate/${role === 'output' ? 'red.log' : 'red.results.json'}`, { generation: l.generation, claim_id: l.claim_id, commit_sha: b.head_sha, module_sha256: null, plan_sha256: null, exit_code: null, gate: 'red', attested_by: `a red gate binding of ${l.what}` });
        }
      }
      // An open claim's own snapshot registry, with the gate's commit, module and plan.
      for (const snap of [...(rt.claim?.challenge_reds ?? []), ...(rt.claim?.challenge_red ? [rt.claim.challenge_red] : [])]) {
        if (snap.gate === undefined || snap.evidence_sha256 !== output) continue;
        const path = role === 'output' ? snap.gate.output_path : snap.gate.results_path;
        take('challenge-snapshot', path, { generation: liveGeneration(rt), claim_id: rt.claim?.claim_id ?? null, commit_sha: snap.gate.commit_sha, module_sha256: snap.gate.module_sha256, plan_sha256: snap.gate.plan_sha256, exit_code: snap.gate.exit_code, gate: 'red', attested_by: "the claim's snapshot registry" });
      }
    }
  }
  return out;
}

function listing(controlRoot: string, rel: string): string[] {
  try {
    return readdirSync(join(controlRoot, ...rel.split('/'))).sort();
  } catch {
    return [];
  }
}

/** Why an archive's provenance does not stand for the reference, or null when it does. */
function provenanceMismatch(ref: EvidenceReference, src: Source): string | null {
  const p = ref.provenance;
  const s = src.provenance;
  if (p.gate !== s.gate) return `it is a ${s.gate} archive, the record a ${p.gate}`;
  const established = (p.claim_id !== null && s.claim_id !== null) || (p.generation !== null && s.generation !== null);
  if (!established) return 'neither its claim nor its generation can be matched to the record';
  if (p.claim_id !== null && s.claim_id !== null && p.claim_id !== s.claim_id) return `it is claim ${s.claim_id.slice(0, 8)}'s, the record claim ${p.claim_id.slice(0, 8)}'s`;
  if (p.generation !== null && s.generation !== null && p.generation !== s.generation) return `it is generation ${s.generation}'s, the record generation ${p.generation}'s`;
  for (const [what, a, b] of [['commit', p.commit_sha, s.commit_sha], ['module', p.module_sha256, s.module_sha256], ['plan', p.plan_sha256, s.plan_sha256]] as const) {
    if (a !== null && b !== null && a !== b) return `its ${what} is ${b.slice(0, 12)}, the record's ${a.slice(0, 12)}`;
  }
  if (p.exit_code !== null && s.exit_code !== null && p.exit_code !== s.exit_code) return `it exited ${s.exit_code}, the record ${p.exit_code}`;
  return null;
}

export type SourceVerdict = { ok: true; source: Source } | { ok: false; code: 'EVIDENCE_REPAIR_NO_SOURCE' | 'EVIDENCE_REPAIR_PROVENANCE' | 'EVIDENCE_REPAIR_AMBIGUOUS'; detail: string };

const PRIORITY: Record<EvidenceRepairSourceKind, number> = { 'replaced-generation': 0, 'ledger-archive': 1, 'challenge-snapshot': 2 };

/** The one archive that may restore `ref`: exact bytes, provenance matching the record, no two disagreeing. */
export function repairSourceFor(controlRoot: string, featureId: string, state: FeatureState_, ref: EvidenceReference): SourceVerdict {
  const all = archivesFor(controlRoot, featureId, state, ref);
  if (all.length === 0) return { ok: false, code: 'EVIDENCE_REPAIR_NO_SOURCE', detail: `EVIDENCE_REPAIR_NO_SOURCE: no archive of ${ref.node_id ?? 'the feature'} holds the ${ref.sha256.slice(0, 12)} bytes ${ref.key} names` };
  const matching = all.filter((s) => provenanceMismatch(ref, s) === null);
  if (matching.length === 0) {
    const why = all.map((s) => `${s.path} (${s.provenance.attested_by}): ${provenanceMismatch(ref, s)}`).slice(0, 3).join('; ');
    return { ok: false, code: 'EVIDENCE_REPAIR_PROVENANCE', detail: `EVIDENCE_REPAIR_PROVENANCE: the archives holding the ${ref.sha256.slice(0, 12)} bytes ${ref.key} names are not its run's: ${why}` };
  }
  for (const a of matching) {
    for (const b of matching) {
      for (const k of ['claim_id', 'generation', 'commit_sha', 'module_sha256', 'plan_sha256', 'exit_code'] as const) {
        if (a.provenance[k] !== null && b.provenance[k] !== null && a.provenance[k] !== b.provenance[k]) {
          return { ok: false, code: 'EVIDENCE_REPAIR_AMBIGUOUS', detail: `EVIDENCE_REPAIR_AMBIGUOUS: archives of ${ref.key} disagree on its ${k} (${a.path}, ${b.path})` };
        }
      }
    }
  }
  return { ok: true, source: [...matching].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || (a.path < b.path ? -1 : 1))[0] as Source };
}

// ---- repairing ---------------------------------------------------------------------------------------------

export type EvidenceRepairFault = 'copy-written' | 'receipt-written' | 'state-written';

export interface UnrepairableReference {
  key: string;
  node_id: string | null;
  path: string;
  sha256: string;
  live: boolean;
  code: string;
  detail: string;
}

export interface PlannedRepair {
  repair_id: string;
  node_id: string | null;
  refs: string[];
  from_path: string;
  sha256: string;
  source: { kind: EvidenceRepairSourceKind; path: string };
}

export interface EvidenceRepairReport {
  feature_id: string;
  dry_run: boolean;
  /** Repairs this run bound in STATE.json. */
  repaired: EvidenceRepairEntry[];
  /** Repairs found to make (a dry run makes none). */
  planned: PlannedRepair[];
  unrepairable: UnrepairableReference[];
  /** A reference the delivered state stands on is still broken: EVIDENCE_REPAIR_REQUIRED. */
  required: boolean;
  /** The marker as left: set (delivery fails closed on it), cleared, or unchanged. */
  marker: 'set' | 'cleared' | 'unchanged';
}

export interface RepairOptions {
  candidateId?: string | null;
  dryRun?: boolean;
  /** Set (or clear) STATE.json's EVIDENCE_REPAIR_REQUIRED marker from the result: what delivery and the controller's repair do. */
  mark?: boolean;
  actor?: string;
  fault?: (at: EvidenceRepairFault) => void;
}

/** A repair's identity: the feature, node, path and hash it restores — the same repair again is the same id. */
export function repairId(featureId: string, nodeId: string | null, fromPath: string, sha: string): string {
  return `ER-${sha256(`${featureId}\u0000${nodeId ?? ''}\u0000${fromPath.replace(/\\/g, '/')}\u0000${sha}`).slice(0, 16)}`;
}

/** Where a repaired copy of `fromPath`'s bytes goes: the node's (or the feature's) repaired copies, by name and content. */
function repairedDir(controlRoot: string, featureId: string, nodeId: string | null): string {
  return nodeId === null ? join(featurePaths(controlRoot, featureId).evidenceDir, REPAIRED_DIR) : join(nodeEvidenceDir(controlRoot, featureId, nodeId), REPAIRED_DIR);
}

/** A repaired copy's name: the stale file's, without the node id an earlier release prefixed (the directory is the node's). */
function stemOf(fromPath: string, nodeId: string | null): { stem: string; ext: string } {
  let name = basename(fromPath.replace(/\\/g, '/'));
  const prefix = nodeId === null ? null : `${nodeId.replace(/[^A-Za-z0-9._-]/g, '_')}.`;
  if (prefix !== null && name.startsWith(prefix) && name.length > prefix.length) name = name.slice(prefix.length);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/** Move a mutable record's pointer, only while it still names exactly `from` (`sha`). */
function setPointer(s: FeatureState_, loc: ReferenceLocation, from: string, sha: string, to: string): boolean {
  const move = (holder: { output_path?: string; output_sha256?: string } | undefined | null): boolean => {
    if (!holder || holder.output_path !== from || holder.output_sha256 !== sha) return false;
    holder.output_path = to;
    return true;
  };
  const moveResults = (rec: EvidenceRecord | undefined | null): boolean => {
    if (!rec?.results || rec.results.path !== from || rec.results.sha256 !== sha) return false;
    rec.results = { ...rec.results, path: to };
    return true;
  };
  switch (loc.at) {
    case 'evidence': {
      const rec = s.nodes[loc.node]?.evidence[loc.kind];
      return loc.field === 'output' ? move(rec) : moveResults(rec);
    }
    case 'tdd-history':
      return move(s.nodes[loc.node]?.tdd_history);
    case 'carried':
      return move(s.nodes[loc.node]?.carried_criterion_proofs?.[loc.index]);
    case 'rework-evidence':
      return move(s.nodes[loc.node]?.rework_history?.[loc.index]?.evidence[loc.kind]);
    case 'rework-history':
      return move(s.nodes[loc.node]?.rework_history?.[loc.index]?.tdd_history);
    case 'restore-evidence':
    case 'restore-history': {
      const entry = s.nodes[loc.dependent === null ? loc.node : (Object.keys(s.nodes).find((id) => (s.nodes[id]?.rework_history?.[loc.index]?.restore_dependents ?? {})[loc.dependent as string] !== undefined) ?? loc.node)]?.rework_history?.[loc.index];
      const g = loc.dependent === null ? entry?.restore : entry?.restore_dependents?.[loc.dependent];
      if (!g) return false;
      if (loc.at === 'restore-history') return move(g.tdd_history);
      const rec = g.evidence[loc.kind];
      return loc.field === 'output' ? move(rec) : moveResults(rec);
    }
    default:
      return false; // sealed: the recorded repair stands for it
  }
}

/** Write a repair's receipt once (or find exactly it): its path and the hash of its bytes, or why not. */
function sealReceipt(controlRoot: string, featureId: string, plan: PlannedRepair, toPath: string, found: string | null, reason: string, provenance: Source['provenance'], options: RepairOptions): { path: string; sha256: string } | { problem: string } {
  const dir = join(featurePaths(controlRoot, featureId).evidenceDir, RECEIPTS_DIR);
  const file = join(dir, `${plan.repair_id}.json`);
  const rel = (relativeInside(controlRoot, file) ?? file).replace(/\\/g, '/');
  const existing = observeEvidenceOutput(controlRoot, featureId, rel);
  if (existing.kind === 'file') {
    // Written by an earlier run (one that died before its state write): exactly this repair, as sealed, or nothing.
    try {
      const body = JSON.parse(readFileSync(existing.path, 'utf8')) as Record<string, unknown>;
      const { sha256: seal, ...rest } = body;
      const from = body['from'] as { path?: unknown; sha256?: unknown };
      const to = body['to'] as { path?: unknown };
      if (body['schema'] === REPAIR_SCHEMA && seal === sha256(stableStringify(rest)) && body['repair_id'] === plan.repair_id && from?.path === plan.from_path && from?.sha256 === plan.sha256 && to?.path === toPath) return { path: rel, sha256: existing.sha256 };
    } catch {
      // fall through
    }
    return { problem: `EVIDENCE_REPAIR_TAMPERED: ${rel} is there and is not this repair's receipt` };
  }
  if (existing.kind === 'unsafe') return { problem: existing.problem };
  const body = {
    schema: REPAIR_SCHEMA,
    repair_id: plan.repair_id,
    feature_id: featureId,
    node_id: plan.node_id,
    refs: plan.refs,
    from: { path: plan.from_path, sha256: plan.sha256, found },
    to: { path: toPath, sha256: plan.sha256 },
    source: { kind: plan.source.kind, path: plan.source.path, provenance },
    reason: reason.slice(0, 1000),
    candidate_id: options.candidateId ?? null,
    actor: options.actor ?? 'mycelink',
    at: new Date().toISOString(),
  };
  const text = JSON.stringify({ ...body, sha256: sha256(stableStringify(body)) }, null, 2) + '\n';
  mkdirSync(dir, { recursive: true });
  if (createExclusive(file, text) === 'exists') return sealReceipt(controlRoot, featureId, plan, toPath, found, reason, provenance, options);
  return { path: rel, sha256: sha256(text) };
}

/**
 * Repair every stale pointer an exact archive can restore (engine docs above), report every other problem, and — with
 * `mark` — set or clear the feature's EVIDENCE_REPAIR_REQUIRED marker from what the delivered state still stands on.
 */
export function repairEvidence(controlRoot: string, featureId: string, options: RepairOptions = {}): EvidenceRepairReport {
  const paths = featurePaths(controlRoot, featureId);
  const state = loadState(paths.featureDir)?.data;
  if (state === undefined) throw new Error(`NO_STATE: ${featureId} has no STATE.json`);
  const refs = evidenceReferences(state);
  const problems = referenceProblems(controlRoot, featureId, state);
  const unrepairable: UnrepairableReference[] = [];
  const plans = new Map<string, { plan: PlannedRepair; source: Source; refs: EvidenceReference[]; found: string | null; reason: string }>();
  const repairs = state.evidence_repairs ?? [];
  for (const p of problems) {
    const ref = refs.find((r) => r.key === p.key);
    const keep = (code: string, detail: string): void => {
      unrepairable.push({ key: p.key, node_id: p.node_id, path: p.path, sha256: p.sha256, live: p.live, code, detail });
    };
    if (p.code === 'EVIDENCE_REFERENCE_CONFLICT') continue; // a symptom: the references it names are repaired (or not) on their own
    if (!p.repairable || ref === undefined) {
      keep(p.code, p.detail);
      continue;
    }
    // Already restored for another record of the same path and hash: only this pointer moves (a sealed one needs nothing).
    const bound = repairs.find((r) => r.from_path === ref.path && r.sha256 === ref.sha256);
    if (bound !== undefined) {
      if (!ref.sealed) {
        const id = bound.repair_id;
        const at = plans.get(id);
        if (at === undefined) plans.set(id, { plan: { repair_id: id, node_id: bound.node_id, refs: [ref.key], from_path: ref.path, sha256: ref.sha256, source: bound.source }, source: { kind: bound.source.kind, path: bound.source.path, provenance: { ...NONE, gate: ref.provenance.gate, attested_by: `repair ${id}` } }, refs: [ref], found: p.found, reason: p.detail });
        else at.refs.push(ref);
      }
      continue;
    }
    const verdict = repairSourceFor(controlRoot, featureId, state, ref);
    if (!verdict.ok) {
      keep(p.code, `${p.detail}; ${verdict.detail}`);
      continue;
    }
    const id = repairId(featureId, ref.node_id, ref.path, ref.sha256);
    const at = plans.get(id);
    if (at !== undefined) {
      at.refs.push(ref);
      at.plan.refs.push(ref.key);
      continue;
    }
    plans.set(id, { plan: { repair_id: id, node_id: ref.node_id, refs: [ref.key], from_path: ref.path, sha256: ref.sha256, source: { kind: verdict.source.kind, path: verdict.source.path } }, source: verdict.source, refs: [ref], found: p.found, reason: p.detail });
  }
  const planned = [...plans.values()].map((x) => x.plan);
  if (options.dryRun !== true) reapEvidenceTemps(controlRoot, featureId);
  if (options.dryRun === true) {
    return { feature_id: featureId, dry_run: true, repaired: [], planned, unrepairable, required: unrepairable.some((u) => u.live), marker: 'unchanged' };
  }

  // The copies and receipts first (immutable, idempotent), then one STATE.json write, then the events.
  const made: { entry: EvidenceRepairEntry; refs: EvidenceReference[]; fresh: boolean }[] = [];
  for (const { plan, source, refs: group, found, reason } of plans.values()) {
    const existing = repairs.find((r) => r.repair_id === plan.repair_id);
    if (existing !== undefined) {
      made.push({ entry: existing, refs: group, fresh: false });
      continue;
    }
    const src = resolveEvidenceOutput(controlRoot, featureId, { output_path: source.path });
    if (!src.ok) {
      for (const r of group) unrepairable.push({ key: r.key, node_id: r.node_id, path: r.path, sha256: r.sha256, live: r.live, code: 'EVIDENCE_REPAIR_NO_SOURCE', detail: src.problem });
      continue;
    }
    const bytes = readFileSync(src.path);
    if (sha256(bytes) !== plan.sha256) {
      for (const r of group) unrepairable.push({ key: r.key, node_id: r.node_id, path: r.path, sha256: r.sha256, live: r.live, code: 'EVIDENCE_REPAIR_NO_SOURCE', detail: `EVIDENCE_REPAIR_NO_SOURCE: ${source.path} changed while it was read` });
      continue;
    }
    const { stem, ext } = stemOf(plan.from_path, plan.node_id);
    const copy = writeImmutable(repairedDir(controlRoot, featureId, plan.node_id), stem, ext, bytes);
    const toPath = (relativeInside(controlRoot, copy.file) ?? copy.file).replace(/\\/g, '/');
    options.fault?.('copy-written');
    const receipt = sealReceipt(controlRoot, featureId, plan, toPath, found, reason, source.provenance, options);
    if ('problem' in receipt) {
      for (const r of group) unrepairable.push({ key: r.key, node_id: r.node_id, path: r.path, sha256: r.sha256, live: r.live, code: 'EVIDENCE_REPAIR_TAMPERED', detail: receipt.problem });
      continue;
    }
    made.push({ entry: { repair_id: plan.repair_id, node_id: plan.node_id, refs: [...plan.refs], from_path: plan.from_path, sha256: plan.sha256, to_path: toPath, source: { ...plan.source }, receipt_path: receipt.path, receipt_sha256: receipt.sha256, at: new Date().toISOString() }, refs: group, fresh: true });
  }
  options.fault?.('receipt-written');

  const repaired: EvidenceRepairEntry[] = [];
  if (made.length > 0) {
    mutateState(paths.featureDir, (s) => {
      for (const m of made) {
        const bound = (s.evidence_repairs ?? []).some((r) => r.repair_id === m.entry.repair_id);
        for (const r of m.refs) if (!r.sealed) setPointer(s, r.location, r.path, r.sha256, m.entry.to_path);
        if (!bound) {
          s.evidence_repairs = [...(s.evidence_repairs ?? []), m.entry];
          repaired.push(m.entry);
        }
      }
      return s;
    });
  }
  options.fault?.('state-written');
  // One event per bound repair, an interrupted run's too (keyed by the repair: never twice, a rotated log included).
  const after = loadState(paths.featureDir)?.data ?? state;
  for (const e of after.evidence_repairs ?? []) {
    appendEvent(paths.events, {
      idempotency_key: `evidence.repaired:${e.repair_id}`,
      type: 'evidence.repaired',
      actor: options.actor ?? 'mycelink',
      feature_id: featureId,
      ...(e.node_id !== null ? { node_id: e.node_id } : {}),
      data: { repair_id: e.repair_id, refs: e.refs.slice(0, 8), from_path: e.from_path, to_path: e.to_path, sha256: e.sha256, source: e.source.kind, receipt_sha256: e.receipt_sha256, candidate_id: options.candidateId ?? null },
    });
  }
  // What the delivered state still stands on, as it is now: an unrepaired reference's reason is the one its repair gave.
  const live = referenceProblems(controlRoot, featureId, after).filter((p) => p.live);
  const reasons = live.map((p) => unrepairable.find((u) => u.key === p.key && u.code === p.code)?.detail ?? p.detail);
  const required = live.length > 0;
  let marker = 'unchanged' as EvidenceRepairReport['marker'];
  if (options.mark === true && (required || (after.evidence_repair ?? null) !== null)) {
    const nodes = [...new Set(live.map((p) => p.node_id).filter((n): n is string => n !== null))].sort();
    const problems = reasons.map((r) => r.slice(0, 2000)).slice(0, 64);
    mutateState(paths.featureDir, (s) => {
      if (required) {
        const now: EvidenceRepairRequired = { status: 'REQUIRED', candidate_id: options.candidateId ?? s.current_candidate ?? null, nodes, problems, at: new Date().toISOString() };
        const was = s.evidence_repair ?? null;
        if (was === null || was.candidate_id !== now.candidate_id || stableStringify(was.problems) !== stableStringify(now.problems)) {
          s.evidence_repair = now;
          marker = 'set';
        }
      } else if ((s.evidence_repair ?? null) !== null) {
        s.evidence_repair = null;
        marker = 'cleared';
      }
      return s;
    });
    if (marker === 'set') {
      appendEvent(paths.events, {
        idempotency_key: `evidence.repair_required:${options.candidateId ?? 'none'}:${sha256(stableStringify(problems)).slice(0, 16)}`,
        type: 'evidence.repair_required',
        actor: options.actor ?? 'mycelink',
        feature_id: featureId,
        data: { candidate_id: options.candidateId ?? null, nodes, problems: problems.map((p) => p.slice(0, 300)).slice(0, 6) },
      });
    }
    if (marker === 'cleared') {
      appendEvent(paths.events, { idempotency_key: `evidence.repair_cleared:${options.candidateId ?? 'none'}:${Date.now()}`, type: 'evidence.repair_cleared', actor: options.actor ?? 'mycelink', feature_id: featureId, data: { candidate_id: options.candidateId ?? null } });
    }
  }
  return { feature_id: featureId, dry_run: false, repaired, planned, unrepairable, required, marker };
}

/** A writer's temporary file (state/atomic-json.ts createExclusive): `.<name>.<16 hex>.tmp`. */
const WRITER_TEMP = /^..+.[0-9a-f]{16}.tmp$/;
/** Younger than this, a temporary file may be a writer still running. */
const TEMP_GRACE_MS = 60_000;

/**
 * Remove what writers killed mid-write left under the feature's evidence: their temporary files, past a grace period.
 * Nothing else is ever collected — no artifact, referenced or not, no link (never followed), nothing named otherwise.
 */
export function reapEvidenceTemps(controlRoot: string, featureId: string, now = Date.now()): string[] {
  const removed: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(dir, name);
      let st;
      try {
        st = lstatSync(file);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(file, depth + 1);
      else if (st.isFile() && WRITER_TEMP.test(name) && now - st.mtimeMs > TEMP_GRACE_MS) {
        rmSync(file, { force: true });
        removed.push(file);
      }
    }
  };
  walk(featurePaths(controlRoot, featureId).evidenceDir, 0);
  return removed;
}

/** The marker's text for a refused delivery or a status line: administrative, never a product rework. */
export function repairRequiredDetail(featureId: string, marker: EvidenceRepairRequired): string {
  return `EVIDENCE_REPAIR_REQUIRED: administrative, not a product defect — evidence of ${marker.nodes.join(', ') || featureId} the delivered state stands on no exact archive restores (${marker.problems.slice(0, 3).join('; ').slice(0, 1200)}). No worker can reproduce a historical RED on fixed code and no product rework is ordered for it: the controller restores the exact bytes from the node's archives (mycelink evidence repair ${featureId}) or a person decides; delivery fails closed until then`;
}

/** Whether the marker binds the feature now: set, and for its current candidate. */
export function repairRequired(state: FeatureState_): EvidenceRepairRequired | null {
  const m = state.evidence_repair ?? null;
  return m !== null && m.status === 'REQUIRED' && m.candidate_id === state.current_candidate ? m : null;
}
