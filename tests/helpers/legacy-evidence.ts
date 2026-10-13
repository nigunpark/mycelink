/**
 * Evidence as an earlier release left it, for the repair of legacy state
 * (engine/evidence-integrity.ts; the CSET-202 rerun).
 *
 * An earlier release wrote every run of a gate to one canonical name
 * (`<node>.<gate>.log`, `<node>.<gate>.results.json`): a second run replaced
 * the bytes a kept record still named. These helpers put a settled record
 * into exactly that shape — its pointer on the canonical name, other bytes
 * there, its own content-addressed artifact gone (that release never wrote
 * one) — and keep its exact bytes where that release's archives kept them.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { featurePaths, nodeEvidenceDir } from '../../src/workspace/paths.js';
import type { EvidenceKind, EvidenceRecord } from '../../src/model/types.js';

export const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

/** The canonical name an earlier release wrote a gate's output (or results) to, relative to the control root. */
export function canonicalPath(featureId: string, nodeId: string, kind: string, results = false): string {
  const safe = nodeId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `features/${featureId}/evidence/${safe}/${safe}.${kind}${results ? '.results.json' : '.log'}`;
}

export interface LegacyRecord {
  record: EvidenceRecord;
  bytes: Buffer;
  results: Buffer | null;
}

/** A node's record of `kind` and the exact bytes it names, read before anything is changed. */
export function recordOf(control: string, featureId: string, nodeId: string, kind: EvidenceKind = 'red'): LegacyRecord {
  const rt = loadState(featurePaths(control, featureId).featureDir)!.data.nodes[nodeId]!;
  const record = structuredClone(rt.evidence[kind]) as EvidenceRecord;
  const bytes = readFileSync(resolve(control, record.output_path));
  const results = record.results ? readFileSync(resolve(control, record.results.path)) : null;
  return { record, bytes, results };
}

/**
 * Put a node's record into the shape an earlier release left after another run of the same gate: its pointer (and
 * its results', when `results` bytes are given) on the canonical name holding `overwrite`, its own artifact gone.
 */
export function legacyOverwrite(control: string, featureId: string, nodeId: string, kind: EvidenceKind, kept: LegacyRecord, overwrite: { output?: string | Buffer; results?: string | Buffer | null } = {}): EvidenceRecord {
  const out = canonicalPath(featureId, nodeId, kind);
  const res = canonicalPath(featureId, nodeId, kind, true);
  const old = kept.record.output_path;
  const oldResults = kept.record.results?.path ?? null;
  mkdirSync(dirname(resolve(control, out)), { recursive: true });
  writeFileSync(resolve(control, out), overwrite.output ?? `$ the same gate, run again\n(cwd: .)\n\nok 1 a later run\n`);
  if (old !== out) rmSync(resolve(control, old), { force: true });
  let results = kept.record.results ?? null;
  if (results !== null && kept.results !== null) {
    if (overwrite.results !== null) writeFileSync(resolve(control, res), overwrite.results ?? '{"schema":"mycelink-test-results/1","results":[]}\n');
    else writeFileSync(resolve(control, res), kept.results);
    if (oldResults !== null && oldResults !== res) rmSync(resolve(control, oldResults), { force: true });
    results = { ...results, path: res };
  }
  const legacy: EvidenceRecord = { ...structuredClone(kept.record), output_path: out, ...(results !== null ? { results } : {}) };
  mutateState(featurePaths(control, featureId).featureDir, (s) => {
    const rt = s.nodes[nodeId];
    if (rt) rt.evidence[kind] = legacy;
    return s;
  });
  return legacy;
}

/** Where an earlier release's red gate kept what it ran (`challenge-red/<sha16>/gate/`), with exactly these bytes. */
export function keepChallengeArchive(control: string, featureId: string, nodeId: string, kept: LegacyRecord, dirName?: string): { output: string; results: string | null } {
  const dir = join(nodeEvidenceDir(control, featureId, nodeId), 'challenge-red', dirName ?? kept.record.output_sha256.slice(0, 16), 'gate');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'red.log'), kept.bytes);
  if (kept.results !== null) writeFileSync(join(dir, 'red.results.json'), kept.results);
  return { output: join(dir, 'red.log'), results: kept.results !== null ? join(dir, 'red.results.json') : null };
}

/** Whether a file exists and holds exactly `sha`. */
export function holds(file: string, sha: string): boolean {
  return existsSync(file) && sha256(readFileSync(file)) === sha;
}

/**
 * Remove the copies a node's completion records archived of its RED (`ledger/<AC>.g<n>.<claim>/red.log` and its
 * results): what a state looks like where no completion record holds the RED a stale pointer names (the CSET-202
 * rerun's: the first run of a review rework's red gate, never a completion's proof). The records stay as sealed.
 */
export function dropLedgerArchive(control: string, featureId: string, nodeId: string): string[] {
  const dir = join(nodeEvidenceDir(control, featureId, nodeId), 'ledger');
  const removed: string[] = [];
  if (!existsSync(dir)) return removed;
  for (const d of readdirSync(dir)) {
    for (const name of ['red.log', 'red.results.json']) {
      const file = join(dir, d, name);
      if (existsSync(file)) {
        rmSync(file);
        removed.push(file);
      }
    }
  }
  return removed;
}
