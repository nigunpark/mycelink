/**
 * The criterion completion ledger: every criterion a node completed by an
 * accepted settlement, recorded once and never changed.
 *
 * CSET-203 r16 (fault arm): the cli's first generation settled AC-3 (a RED
 * that failed for the missing recovery, then the fix), AC-4 and AC-5 at the
 * integrated head. R001 found AC-3's tests too narrow, and AC-5; its
 * refinement withdrew a sibling's gap and rebased the cli's order, untouched,
 * to its revision 1. The cli's next worker found R001's AC-3 reproduction
 * already passing on that head — the first generation's fix holds it — and
 * committed AC-5's compatibility unit. Settle then asked the whole node for a
 * RED of this generation's own ("Entering REGRESSION_VERIFIED requires a RED
 * that failed for a missing behaviour; the recorded one exited 0"), twice: two
 * attempts and the node BLOCKED for an administrative carry, not a product
 * failure.
 *
 * Here each completion is a record bound by its SHA-256 to the order it
 * answered, the repository delta that completed it, the RED that drove it
 * (its record and output archived beside it), the proof settle accepted, the
 * settlement and its lineage (`source`: the record a carried or re-proved
 * completion stands on; `parent`: this criterion's previous record). A later
 * generation carries a completed criterion only after its record is
 * revalidated on the new authoritative head (revalidateCompletion, before any
 * worker runs, and the fresh verification at settle): intact, its completed
 * work in the base, its test as it was, its production change still there —
 * or changed by someone else only where its test still passes there. What no
 * longer holds is ordered again on its own, never charged.
 *
 * This module holds the pure parts and the archive; the orchestrator decides
 * when (engine/orchestrator.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AcceptedCriterionRecord, ChallengeRedSnapshot, CompletionBasis, CriterionCompletion, CriterionKind, EvidenceRecord, GraphNode, NodeRuntime, PortfolioGraph, ReworkHistoryEntry } from '../model/types.js';
import { checkEvidenceOutput, relativeInside } from '../evidence/paths.js';
import { isAncestor, runGit } from '../git/git.js';
import { stableStringify } from '../graph/validate.js';
import { createExclusive, writeTextAtomic } from '../state/atomic-json.js';
import { artifactAt } from '../evidence/store.js';
import { nodeEvidenceDir } from '../workspace/paths.js';
import { criterionKind } from './criteria.js';
import { priorTestChanges } from './test-declarations.js';
import { testTitle } from '../evidence/test-identity.js';
import { isTestPath, type TddPolicy } from './tdd-history.js';

export const COMPLETION_SCHEMA = 'mycelink-criterion-completion/1' as const;

/** Records a node keeps (oldest dropped first): enough for every criterion across many generations. */
export const MAX_LEDGER_RECORDS = 256;

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export type CompletionBody = Omit<CriterionCompletion, 'record_id' | 'sha256'>;

/** The SHA-256 a record is bound by: of its canonical body, without `sha256` and `record_id`. */
export function completionSha256(record: CompletionBody | CriterionCompletion): string {
  const { sha256: _s, record_id: _r, ...body } = record as CriterionCompletion;
  return sha256(stableStringify(body));
}

/** A record sealed: its hash, and its id from it. */
export function sealCompletion(body: CompletionBody): CriterionCompletion {
  const hash = completionSha256(body);
  return { ...body, record_id: `CC-${hash.slice(0, 16)}`, sha256: hash };
}

/** Where a record's archive goes, relative to the control root: by what it completes, known before it is sealed. */
export function completionArchive(featureId: string, nodeId: string, criterion: string, generation: number, claimId: string | null): string {
  const node = nodeId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `features/${featureId}/evidence/${node}/ledger/${criterion.replace(/[^A-Za-z0-9._-]/g, '_')}.g${generation}.${(claimId ?? 'none').slice(0, 8)}`;
}

/**
 * Why a record cannot be trusted as written, or null: its hash recomputes, and every file it archived (its RED's
 * output and results, its re-proof's tests) still hashes as recorded.
 */
export function completionProblem(controlRoot: string, featureId: string, record: CriterionCompletion): string | null {
  if (record.schema !== COMPLETION_SCHEMA) return `COMPLETION_TAMPERED: ${record.record_id} is not a ${COMPLETION_SCHEMA} record`;
  if (completionSha256(record) !== record.sha256 || record.record_id !== `CC-${record.sha256.slice(0, 16)}`) {
    return `COMPLETION_TAMPERED: ${record.record_id} (${record.criterion}) no longer hashes to the record settle wrote`;
  }
  const red = record.red?.record ?? null;
  if (red !== null) {
    const problem = checkEvidenceOutput(controlRoot, featureId, red);
    if (problem !== null) return `COMPLETION_TAMPERED: the RED ${record.record_id} (${record.criterion}) was completed by: ${problem}`;
    if (red.results && checkEvidenceOutput(controlRoot, featureId, { output_path: red.results.path, output_sha256: red.results.sha256 }) !== null) {
      return `COMPLETION_TAMPERED: the RED results of ${record.record_id} (${record.criterion}) are missing or changed`;
    }
  }
  for (const f of record.reproof?.files ?? []) {
    if (checkEvidenceOutput(controlRoot, featureId, { output_path: f.archived, output_sha256: f.sha256 }) !== null) return `COMPLETION_TAMPERED: the re-proof of ${record.record_id} (${record.criterion}) no longer holds ${f.path} as it ran`;
  }
  return null;
}

/**
 * The judged history a record names (its completing generation's), as written: null when it still is — at its path,
 * or at the immutable copy a recorded repair made of exactly it (engine/evidence-integrity.ts).
 */
export function completionHistoryProblem(controlRoot: string, featureId: string, record: CriterionCompletion): string | null {
  if (record.migrated === true || record.history === null) return null;
  const problem = checkEvidenceOutput(controlRoot, featureId, record.history);
  return problem === null ? null : `COMPLETION_HISTORY_INVALID: the judged history of ${record.record_id} (${record.criterion}): ${problem}`;
}

/** Hash-chain problems of a node's ledger: a tampered record, a record whose source or parent is unknown. */
export function ledgerProblems(controlRoot: string, featureId: string, ledger: readonly CriterionCompletion[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const r of ledger) {
    if (r.migrated !== true) {
      const p = completionProblem(controlRoot, featureId, r);
      if (p !== null) out.push(p);
    }
    for (const [what, id] of [['source', r.source], ['parent', r.parent]] as const) {
      if (id !== null && !ids.has(id)) out.push(`COMPLETION_LINEAGE_INVALID: ${r.record_id} (${r.criterion}) names ${what} ${id}, which no earlier record of the node is`);
    }
    ids.add(r.record_id);
  }
  return out;
}

/** The latest record of a criterion on a node, or null. */
export function latestCompletion(ledger: readonly CriterionCompletion[], criterion: string): CriterionCompletion | null {
  for (let i = ledger.length - 1; i >= 0; i--) if ((ledger[i] as CriterionCompletion).criterion === criterion) return ledger[i] as CriterionCompletion;
  return null;
}

/** The record a carried or re-proved completion stands on, followed to the completion that ran a RED (or a compatibility proof). */
export function rootCompletion(ledger: readonly CriterionCompletion[], record: CriterionCompletion): CriterionCompletion {
  let at = record;
  for (let hops = 0; hops < 64 && (at.basis === 'carried' || at.basis === 'reproved') && at.source !== null; hops++) {
    const next = ledger.find((r) => r.record_id === at.source);
    if (next === undefined) break;
    at = next;
  }
  return at;
}

/**
 * The attested RED a generation that runs none stands on (CSET-203 r16): of the first of `recordIds` whose root
 * completion kept its RED — a RED that failed for a missing behaviour, its output still hashing as recorded — marked
 * with where it came from. Null when none did.
 */
export function carriedRed(controlRoot: string, featureId: string, ledger: readonly CriterionCompletion[], recordIds: readonly string[]): EvidenceRecord | null {
  for (const id of recordIds) {
    const rec = ledger.find((r) => r.record_id === id);
    if (rec === undefined) continue;
    const root = rootCompletion(ledger, rec);
    const red = root.red?.record ?? null;
    if (red === null || red.exit_code === 0 || red.red_reason !== 'behaviour-missing') continue;
    if (checkEvidenceOutput(controlRoot, featureId, red) !== null) continue;
    return { ...structuredClone(red), carried_from: { record_id: root.record_id, criterion: root.criterion, generation: root.generation, claim_id: root.claim_id } };
  }
  return null;
}

// ---- the production delta of a generation ----------------------------------------------------------

function changedPaths(repoPath: string, from: string, to: string): { status: string; path: string }[] {
  if (from === to) return [];
  const out = runGit(repoPath, ['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '--no-renames', from, to], { allowFail: true }).stdout;
  const parts = out.split('\0');
  const changes: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === '') break;
    changes.push({ status: (parts[i] as string)[0] as string, path: (parts[i + 1] as string).replace(/\\/g, '/') });
  }
  return changes;
}

/** The blob of `path` at `rev`, or null when it has none. */
export function blobAt(repoPath: string, rev: string, path: string): string | null {
  const r = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${rev}:${path}`], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() || null : null;
}

/** The production paths `base..head` changed, each blob before and after (null: absent), and the delta's SHA-256. */
export function productionDelta(repoPath: string, policy: TddPolicy, base: string | null, head: string | null): CriterionCompletion['production'] {
  if (base === null || head === null) return { paths: [], sha256: sha256('[]') };
  const paths = changedPaths(repoPath, base, head)
    .filter((c) => !isTestPath(policy, c.path))
    .map((c) => ({ path: c.path, before: c.status === 'A' ? null : blobAt(repoPath, base, c.path), after: c.status === 'D' ? null : blobAt(repoPath, head, c.path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { paths, sha256: sha256(stableStringify(paths)) };
}

// ---- revalidation on a new authoritative head ------------------------------------------------------------

export type CompletionCode =
  | 'COMPLETION_TAMPERED'
  | 'COMPLETION_BASE_STALE'
  | 'COMPLETION_TEST_CHANGED'
  | 'COMPLETION_FIX_DELETED'
  | 'COMPLETION_FIX_CHANGED'
  | 'COMPLETION_TEST_FAILED';

/**
 * A record judged on a new head: valid (its test still to pass there when `retest`), or not — `hard` when nothing on
 * that head can stand for the completion any more (tampered, its work not in the head, its test changed, its fix
 * reverted), soft when someone else changed its production code (it holds only if its test passes there).
 */
export type CompletionVerdict = { ok: true; retest: boolean } | { ok: false; code: CompletionCode; detail: string; hard: boolean };

export interface RevalidateArgs {
  controlRoot: string;
  featureId: string;
  record: CriterionCompletion;
  /** Every record of the node: a later generation's own change to a path is the node's, never a conflict. */
  ledger: readonly CriterionCompletion[];
  repoPath: string;
  /** The new authoritative head (a claim's base). */
  head: string;
  policy: TddPolicy;
}

/** Static revalidation of one completed criterion's record on a new head (no test is run here). */
export function revalidateCompletion(args: RevalidateArgs): CompletionVerdict {
  const { record: rec, repoPath, head } = args;
  const fail = (code: CompletionCode, detail: string, hard = true): CompletionVerdict => ({ ok: false, code, detail: `${code}: ${rec.criterion} (${rec.record_id}): ${detail}`, hard });
  if (rec.migrated !== true) {
    const problem = completionProblem(args.controlRoot, args.featureId, rec);
    if (problem !== null) return { ok: false, code: 'COMPLETION_TAMPERED', detail: problem, hard: true };
  }
  const root = rootCompletion(args.ledger, rec);
  const completed = rec.repo.integrated_sha ?? rec.repo.head_sha;
  if (completed !== null && completed !== head && !isAncestor(repoPath, completed, head)) {
    return fail('COMPLETION_BASE_STALE', `the work that completed it (${completed.slice(0, 12)}) is not in ${head.slice(0, 12)}`);
  }
  // Its test, as it was when it was proved: the test's own block, never weakened, moved away or removed since.
  const proof = root.proof.test ?? rec.proof.test;
  const provedAt = root.repo.head_sha ?? root.repo.integrated_sha;
  if (proof !== null && provedAt !== null) {
    const was = runGit(repoPath, ['show', `${provedAt}:${proof.path}`], { allowFail: true });
    const now = runGit(repoPath, ['show', `${head}:${proof.path}`], { allowFail: true });
    if (was.exitCode === 0) {
      if (now.exitCode !== 0) return fail('COMPLETION_TEST_CHANGED', `its test file ${proof.path} is gone from ${head.slice(0, 12)}`);
      if (was.stdout !== now.stdout) {
        // Its declared name by its canonical identity: a JUnit test's method, never its class-qualified report (PCM-101 final).
        const name = testTitle(proof.path, proof.name);
        const prior = priorTestChanges([{ path: proof.path, before: was.stdout, after: now.stdout }]);
        const touched = [...prior.removed, ...prior.edited].find((t) => t.name === name || t.name === proof.name);
        if (touched !== undefined || prior.deleted.includes(proof.path)) {
          return fail('COMPLETION_TEST_CHANGED', `its test ${proof.path} › ${proof.name} is ${prior.removed.some((t) => t === touched) ? 'removed' : 'changed'} at ${head.slice(0, 12)}: what proved it is not what is there now`);
        }
      }
    }
  }
  // Its production change: still there as completed, or changed by the node's own later generation, or by someone else.
  const own = new Map<string, string | null>();
  for (const r of args.ledger) {
    if (r.node_id !== rec.node_id || r.generation <= root.generation) continue;
    for (const p of r.production.paths) own.set(p.path, p.after);
  }
  let changed: string[] = [];
  for (const p of root.production.paths) {
    if (p.after === null) continue;
    const now = blobAt(repoPath, head, p.path);
    if (now === p.after || (own.has(p.path) && own.get(p.path) === now)) continue;
    if (now === null || (p.before !== null && now === p.before)) {
      return fail('COMPLETION_FIX_DELETED', `${p.path}, which its completion changed, is ${now === null ? 'gone' : 'back to what it was before it'} at ${head.slice(0, 12)}`);
    }
    changed = [...changed, p.path];
  }
  if (changed.length > 0) return fail('COMPLETION_FIX_CHANGED', `${changed.slice(0, 6).join(', ')} changed since it was completed, by work that is not ${rec.node_id}'s: it holds only while its test passes at ${head.slice(0, 12)}`, false);
  // Unchanged where it matters; a head other than the one it was proved at still runs its test.
  return { ok: true, retest: completed !== head };
}

// ---- building the records of a settled generation ------------------------------------------------------------

export interface SettledGeneration {
  controlRoot: string;
  featureId: string;
  graph: PortfolioGraph;
  node: GraphNode;
  /** The node at the moment it becomes DONE: its accepted criteria, evidence and judged history. */
  runtime: NodeRuntime;
  ledger: readonly CriterionCompletion[];
  repoPath: string;
  policy: TddPolicy;
  generation: number;
  claimId: string | null;
  dispatchId: string | null;
  base: string | null;
  head: string | null;
  integrated: string | null;
  /** The review order the generation answered, as its brief bound it. */
  order: { review_id: string; revision: number | null; receipt_sha256: string | null; gaps: { criterion: string; reproduction_sha256: string }[] } | null;
  /** The claim's red gates that passed a declared test on the unchanged base (what a re-proof cites). */
  snapshots: readonly ChallengeRedSnapshot[];
  /** The re-proof unit settle committed the generation's re-proof in (engine/proof-units.ts), or null. */
  reproofCommit?: string | null;
  settledAt: string;
}

/** The kind of proof an accepted item is, alone. */
function basisOf(graph: PortfolioGraph, node: GraphNode, a: AcceptedCriterionRecord): CompletionBasis {
  if (a.reproof != null) return 'reproved';
  if (a.carried === true) return 'carried';
  if (a.gate === 'red') return 'red';
  const kind: CriterionKind = criterionKind(graph, a.criterion);
  return kind === 'compatibility' ? 'compatibility' : 'declaration';
}

const RANK: Record<CompletionBasis, number> = { red: 0, reproved: 1, carried: 2, compatibility: 3, declaration: 4 };

/**
 * The records one settled generation adds, one per criterion it accepted that the ledger does not already hold for
 * this generation and claim (a settle finished after an interruption adds nothing twice). Each carried or re-proved
 * completion names the record it stands on; a RED this generation ran is copied into the record's archive.
 */
export function completionsOf(g: SettledGeneration): { records: CriterionCompletion[]; copies: ArchiveCopy[] } {
  const rt = g.runtime;
  const accepted = rt.criteria ?? [];
  const byCriterion = new Map<string, AcceptedCriterionRecord[]>();
  for (const a of accepted) byCriterion.set(a.criterion, [...(byCriterion.get(a.criterion) ?? []), a]);
  const production = productionDelta(g.repoPath, g.policy, g.base, g.head);
  const history = rt.tdd_history ? { output_path: rt.tdd_history.output_path, output_sha256: rt.tdd_history.output_sha256 } : null;
  const records: CriterionCompletion[] = [];
  const copies: ArchiveCopy[] = [];
  const ledger = [...g.ledger];
  for (const [criterion, items] of byCriterion) {
    if (ledger.some((r) => r.criterion === criterion && r.generation === g.generation && r.claim_id === g.claimId)) continue;
    const ranked = [...items].sort((a, b) => RANK[basisOf(g.graph, g.node, a)] - RANK[basisOf(g.graph, g.node, b)]);
    const reproofItem = items.find((a) => a.reproof != null) ?? null;
    let primary = ranked[0] as AcceptedCriterionRecord;
    let basis = basisOf(g.graph, g.node, primary);
    // A re-proof stands on its criterion's completed proof, carried beside it.
    if (reproofItem !== null) {
      basis = 'reproved';
      primary = items.find((a) => a.carried === true && a.reproof == null) ?? primary;
    }
    const parent = latestCompletion(ledger, criterion);
    let source: CriterionCompletion | null = null;
    if (basis === 'carried' || basis === 'reproved') {
      const from = primary.carried_from ?? null;
      source =
        (from?.record_id ? ledger.find((r) => r.record_id === from.record_id) : undefined) ??
        [...ledger].reverse().find((r) => r.criterion === criterion && (from === null || r.proof.output_sha256 === from.output_sha256 || r.red?.output_sha256 === from.output_sha256)) ??
        parent;
    }
    // A RED re-cited as an earlier settlement recorded it (a dependent proved again on a new base): carried, never run again.
    if (basis === 'red') {
      const earlier = [...ledger].reverse().find((r) => r.criterion === criterion && r.red !== null && r.red.output_sha256 === primary.output_sha256);
      if (earlier !== undefined) {
        basis = 'carried';
        source = earlier;
      }
    }
    const archive = completionArchive(g.featureId, g.node.id, criterion, g.generation, g.claimId);
    let red: CriterionCompletion['red'] = null;
    if (basis === 'red') {
      const rec = rt.evidence.red;
      if (rec !== undefined && rec.output_sha256 === primary.output_sha256) {
        const output = `${archive}/red.log`;
        copies.push({ from: rec.output_path, to: output, sha256: rec.output_sha256 });
        let results = rec.results ?? null;
        if (results) {
          const to = `${archive}/red.results.json`;
          copies.push({ from: results.path, to, sha256: results.sha256 });
          results = { ...results, path: to };
        }
        red = { output_sha256: rec.output_sha256, record: { ...structuredClone(rec), output_path: output, ...(results ? { results } : {}) } };
      } else red = { output_sha256: primary.output_sha256, record: null };
    } else if (source !== null) {
      red = source.red === null ? null : structuredClone(source.red);
    }
    let reproof: CriterionCompletion['reproof'] = null;
    if (reproofItem?.reproof != null) {
      const snap = g.snapshots.find((s) => s.evidence_sha256 === reproofItem.reproof?.gate_output_sha256) ?? null;
      const files: { path: string; sha256: string; archived: string }[] = [];
      for (const f of snap?.files ?? []) {
        const to = `${archive}/reproof/${f.path}`;
        copies.push({ from: f.copy, to, sha256: f.sha256 });
        files.push({ path: f.path, sha256: f.sha256, archived: to });
      }
      if (snap?.gate) {
        copies.push({ from: snap.gate.output_path, to: `${archive}/reproof/gate/red.log`, sha256: snap.gate.output_sha256 });
        if (snap.gate.results_path !== null && snap.gate.results_sha256 !== null) copies.push({ from: snap.gate.results_path, to: `${archive}/reproof/gate/red.results.json`, sha256: snap.gate.results_sha256 });
      }
      reproof = { gate_output_sha256: reproofItem.reproof.gate_output_sha256, tests: reproofItem.reproof.tests.map((t) => ({ ...t })), files, ...(g.reproofCommit ? { commit: g.reproofCommit } : {}) };
    }
    const test = primary.test;
    const gap = g.order?.gaps.find((x) => x.criterion === criterion) ?? null;
    const body: CompletionBody = {
      schema: COMPLETION_SCHEMA,
      node_id: g.node.id,
      criterion,
      kind: criterionKind(g.graph, criterion),
      generation: g.generation,
      basis,
      source: source?.record_id ?? null,
      parent: parent?.record_id ?? null,
      claim_id: g.claimId,
      dispatch_id: g.dispatchId,
      settled_at: g.settledAt,
      order: g.order === null ? null : { review_id: g.order.review_id, revision: g.order.revision, receipt_sha256: g.order.receipt_sha256, reproduction_sha256: gap?.reproduction_sha256 ?? null },
      repo: { repository: g.node.repository as string, base_sha: g.base, head_sha: g.head, integrated_sha: g.integrated },
      production,
      proof: {
        test_id: primary.test_id,
        test: test === null ? null : { ...test },
        test_blob: test === null || g.head === null ? null : blobAt(g.repoPath, g.head, test.path),
        gate: primary.gate,
        output_sha256: primary.output_sha256,
        ...(primary.identity != null ? { identity: primary.identity } : {}),
        ...(primary.identity_alias?.receipt != null ? { identity_alias: primary.identity_alias.receipt } : {}),
      },
      red,
      history,
      reproof,
      archive: red?.record != null || reproof !== null ? archive : null,
    };
    const sealed = sealCompletion(body);
    records.push(sealed);
    ledger.push(sealed);
  }
  return { records, copies };
}

/** A file a record archives: from where, to where, and exactly the bytes it must be. */
export interface ArchiveCopy {
  from: string;
  to: string;
  sha256: string;
}

/**
 * Copy each archived file in place, once, exactly as its record names it (an interrupted settle finds it there), then
 * each record beside them. A source that no longer holds the recorded bytes is never copied, and nothing in an archive
 * is ever written over (evidence/store.ts): what a sealed record names stays what it named.
 */
export function writeCompletionArchive(controlRoot: string, records: readonly CriterionCompletion[], copies: readonly ArchiveCopy[]): void {
  for (const c of copies) {
    const src = join(controlRoot, ...c.from.split('/'));
    const dst = join(controlRoot, ...c.to.split('/'));
    if (artifactAt(src, c.sha256) !== 'same' || artifactAt(dst, c.sha256) !== 'missing') continue;
    mkdirSync(join(dst, '..'), { recursive: true });
    createExclusive(dst, readFileSync(src));
  }
  for (const r of records) {
    if (r.archive === null) continue;
    const file = join(controlRoot, ...r.archive.split('/'), 'record.json');
    mkdirSync(join(file, '..'), { recursive: true });
    writeTextAtomic(file, JSON.stringify(r, null, 2) + '\n');
  }
}

// ---- a state from before the ledger --------------------------------------------------------------------------

/**
 * The ledger of a node whose state predates it, derived from what its rework history kept: each settled
 * generation's accepted criteria, settlement, evidence (the full records a review rework kept for a challenge to
 * restore, their outputs at the archived copies) and judged history, then the node's own generation when it is DONE.
 * Marked `migrated`: hashed like any record, archived nowhere new.
 */
export function migratedLedger(args: { controlRoot: string; featureId: string; graph: PortfolioGraph; node: GraphNode; runtime: NodeRuntime; repoPath: string | null; policy: TddPolicy | null }): CriterionCompletion[] {
  const { runtime: rt, node, graph } = args;
  const out: CriterionCompletion[] = [];
  const generationOf = (e: ReworkHistoryEntry, i: number): number => e.generation ?? i;
  const add = (g: { generation: number; criteria: AcceptedCriterionRecord[]; claim: string | null; dispatch: string | null; settledAt: string; base: string | null; head: string | null; integrated: string | null; red: EvidenceRecord | null; redOutput: string | null; history: CriterionCompletion['history'] }): void => {
    const production = args.repoPath !== null && args.policy !== null ? productionDelta(args.repoPath, args.policy, g.base, g.head) : { paths: [], sha256: sha256('[]') };
    const byCriterion = new Map<string, AcceptedCriterionRecord[]>();
    for (const a of g.criteria) byCriterion.set(a.criterion, [...(byCriterion.get(a.criterion) ?? []), a]);
    for (const [criterion, items] of byCriterion) {
      if (out.some((r) => r.criterion === criterion && r.generation === g.generation && r.claim_id === g.claim)) continue;
      const primary = [...items].sort((a, b) => RANK[basisOf(graph, node, a)] - RANK[basisOf(graph, node, b)])[0] as AcceptedCriterionRecord;
      const basis = basisOf(graph, node, primary);
      const parent = latestCompletion(out, criterion);
      const source = basis === 'carried' ? ([...out].reverse().find((r) => r.criterion === criterion && r.generation === (primary.carried_from?.generation ?? -1)) ?? parent) : null;
      let red: CriterionCompletion['red'] = null;
      if (basis === 'red') {
        const full = g.red !== null && g.red.output_sha256 === primary.output_sha256 ? g.red : null;
        const output = full !== null && g.redOutput !== null && checkEvidenceOutput(args.controlRoot, args.featureId, { output_path: g.redOutput, output_sha256: full.output_sha256 }) === null ? g.redOutput : full?.output_path ?? null;
        let record: EvidenceRecord | null = full === null || output === null ? null : { ...structuredClone(full), output_path: output };
        if (record?.results) {
          const copy = `${output?.slice(0, output.lastIndexOf('/'))}/${basename(record.results.path)}`;
          const where = [copy, record.results.path].find((p) => existsSync(join(args.controlRoot, ...p.split('/'))) && sha256(readFileSync(join(args.controlRoot, ...p.split('/')))) === record?.results?.sha256);
          record = where === undefined ? null : { ...record, results: { ...record.results, path: where } };
        }
        red = { output_sha256: primary.output_sha256, record };
      } else if (source !== null) red = source.red === null ? null : structuredClone(source.red);
      out.push(
        sealCompletion({
          schema: COMPLETION_SCHEMA,
          node_id: node.id,
          criterion,
          kind: criterionKind(graph, criterion),
          generation: g.generation,
          basis,
          source: source?.record_id ?? null,
          parent: parent?.record_id ?? null,
          claim_id: g.claim,
          dispatch_id: g.dispatch,
          settled_at: g.settledAt,
          order: null,
          repo: { repository: node.repository as string, base_sha: g.base, head_sha: g.head, integrated_sha: g.integrated },
          production,
          proof: { test_id: primary.test_id, test: primary.test === null ? null : { ...primary.test }, test_blob: primary.test === null || g.head === null || args.repoPath === null ? null : blobAt(args.repoPath, g.head, primary.test.path), gate: primary.gate, output_sha256: primary.output_sha256 },
          red,
          history: g.history,
          reproof: null,
          archive: null,
          migrated: true,
        }),
      );
    }
  };
  for (const [i, e] of (rt.rework_history ?? []).entries()) {
    if ((e.criteria ?? []).length === 0 || (e.settlement ?? null) === null) continue;
    const restore = e.restore ?? null;
    add({
      generation: generationOf(e, i),
      criteria: e.criteria ?? [],
      claim: e.claim_id ?? e.settlement?.claim_id ?? null,
      dispatch: e.dispatch_id ?? null,
      settledAt: e.settlement?.settled_at ?? e.at,
      base: restore?.branch_base_sha ?? (e.red_bindings ?? [])[0]?.head_sha ?? null,
      head: e.branch_head,
      integrated: e.integrated_sha,
      red: restore?.evidence.red ?? null,
      redOutput: e.evidence.red?.output_path ?? null,
      history: e.tdd_history ? { output_path: e.tdd_history.output_path, output_sha256: e.tdd_history.output_sha256 } : null,
    });
  }
  if (rt.state === 'DONE' && (rt.criteria ?? []).length > 0 && (rt.last_settlement ?? null) !== null) {
    const generation = rt.rework_brief?.generation ?? (rt.rework_history ?? []).filter((e) => (e.challenged ?? null) === null && (e.superseded ?? null) === null).length;
    add({
      generation,
      criteria: rt.criteria ?? [],
      claim: rt.last_settlement?.claim_id ?? null,
      dispatch: rt.last_settlement?.dispatch_id ?? null,
      settledAt: rt.last_settlement?.settled_at ?? rt.updated_at,
      base: rt.branch_base_sha ?? null,
      head: rt.tdd_history?.head_sha ?? null,
      integrated: rt.integrated_sha,
      red: rt.evidence.red ?? null,
      redOutput: rt.evidence.red?.output_path ?? null,
      history: rt.tdd_history ? { output_path: rt.tdd_history.output_path, output_sha256: rt.tdd_history.output_sha256 } : null,
    });
  }
  return out;
}

/** A node's ledger: its own records, else the one its rework history implies (a state from before the ledger). */
export function ledgerOf(args: { controlRoot: string; featureId: string; graph: PortfolioGraph; node: GraphNode; runtime: NodeRuntime; repoPath: string | null; policy: TddPolicy | null }): CriterionCompletion[] {
  const own = args.runtime.criterion_ledger;
  if (own !== undefined) return own;
  return migratedLedger(args);
}

/** A record's archive directory on disk, relative to the control root, normalised; null when it keeps none. */
export function archiveOf(controlRoot: string, record: CriterionCompletion): string | null {
  if (record.archive === null) return null;
  return relativeInside(controlRoot, join(controlRoot, ...record.archive.split('/')));
}

/** The node's evidence directory for its ledger (for cleanup and listings). */
export function ledgerDir(controlRoot: string, featureId: string, nodeId: string): string {
  return join(nodeEvidenceDir(controlRoot, featureId, nodeId), 'ledger');
}
