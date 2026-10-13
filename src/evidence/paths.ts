/**
 * Where an evidence record's output lives.
 *
 * Records store `output_path` relative to the control root, so they keep
 * resolving after the control repository is moved, sealed or cloned. Records
 * written before that change carry an absolute path from wherever the run
 * happened; such a path is mapped back into this feature's directory only by
 * its `features/<feature-id>/...` suffix, and only when that suffix is a safe
 * relative path. Anything else fails closed: an output that cannot be located
 * safely is reported, never searched for.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { EvidenceRecord } from '../model/types.js';
import { classifyRelativePath, isInsideReal, namesOpenedFile } from '../security/paths.js';
import { featurePaths } from '../workspace/paths.js';

export type ResolvedEvidence = { ok: true; path: string } | { ok: false; problem: string };

const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

/** Forward-slash path of `target` relative to `base`, or null when it is not inside it. */
export function relativeInside(base: string, target: string): string | null {
  if (!isInsideReal(base, target)) return null;
  const rel = relative(resolve(base), resolve(target)).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

/** A path from an earlier release, recorded absolute on whatever machine ran it. */
function isLegacyAbsolute(p: string): boolean {
  const s = p.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(s) || (s.startsWith('/') && !s.startsWith('//'));
}

/**
 * Resolve a record's output inside this feature's directory.
 *
 * Containment is checked against the real path of the feature directory, so
 * a link inside it cannot lead a reader elsewhere.
 */
export function resolveEvidenceOutput(
  controlRoot: string,
  featureId: string,
  record: Pick<EvidenceRecord, 'output_path'>,
): ResolvedEvidence {
  const featureDir = featurePaths(controlRoot, featureId).featureDir;
  const unsafe = (why: string): ResolvedEvidence => ({
    ok: false,
    problem: `UNSAFE_EVIDENCE_PATH: ${JSON.stringify(record.output_path).slice(0, 200)} ${why}`,
  });

  let rel: string;
  if (isLegacyAbsolute(record.output_path)) {
    const s = record.output_path.replace(/\\/g, '/');
    const inside = relativeInside(controlRoot, s);
    if (inside !== null) {
      rel = inside;
    } else {
      const marker = `/features/${featureId}/`;
      const at = s.lastIndexOf(marker);
      if (at === -1) return unsafe(`is absolute and not under features/${featureId}/`);
      rel = `features/${featureId}/${s.slice(at + marker.length)}`;
    }
  } else {
    rel = record.output_path;
  }

  if (classifyRelativePath(rel) !== null) return unsafe('is not a safe relative path');
  const normalised = rel.replace(/\\/g, '/');
  if (normalised.split('/').includes('..')) return unsafe('contains a parent segment');
  const target = resolve(controlRoot, normalised);
  if (!isInsideReal(featureDir, target)) return unsafe(`resolves outside features/${featureId}/`);
  return { ok: true, path: target };
}

/**
 * What is at a recorded output path: a regular, unlinked file inside the
 * feature and the SHA-256 of its bytes, nothing, or something no record may
 * stand on (with the coded problem).
 *
 * The path is opened once and everything after that goes through the
 * descriptor, so nothing swapped in at the path after the open is hashed.
 * Where the open follows a final link (Windows has no O_NOFOLLOW) the path is
 * looked up again afterwards and must still name the very file opened.
 */
export type ObservedOutput =
  | { kind: 'file'; path: string; sha256: string }
  | { kind: 'missing'; problem: string }
  | { kind: 'unsafe'; problem: string };

export function observeEvidenceOutput(controlRoot: string, featureId: string, outputPath: string): ObservedOutput {
  const resolved = resolveEvidenceOutput(controlRoot, featureId, { output_path: outputPath });
  if (!resolved.ok) return { kind: 'unsafe', problem: resolved.problem };
  const notRegular = { kind: 'unsafe' as const, problem: `UNSAFE_EVIDENCE_PATH: ${outputPath} is not a regular file` };
  const missing = { kind: 'missing' as const, problem: `MISSING_OUTPUT: ${outputPath}` };
  let fd: number;
  try {
    fd = openSync(resolved.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { kind: 'unsafe', problem: `UNSAFE_EVIDENCE_PATH: ${outputPath} could not be opened without following a link` };
    }
    // A dangling link fails the open the same way a missing file does.
    try {
      return lstatSync(resolved.path).isSymbolicLink() ? notRegular : missing;
    } catch {
      return missing;
    }
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !namesOpenedFile(resolved.path, opened)) return notRegular;
    if (opened.size > BigInt(MAX_EVIDENCE_BYTES)) return { kind: 'unsafe', problem: `OUTPUT_TOO_LARGE: ${outputPath}` };
    return { kind: 'file', path: resolved.path, sha256: createHash('sha256').update(readFileSync(fd)).digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/**
 * Null when the output exists as a regular, unlinked file whose content still
 * hashes to what the record says; otherwise a coded problem.
 *
 * Where the bytes at the path were written over or removed, a repair the
 * controller recorded (engine/evidence-integrity.ts: STATE.json
 * `evidence_repairs`) of exactly this path and hash stands for it, while its
 * immutable copy still holds exactly those bytes — never anything else, so it
 * can only ever stand for what the record attested. `overlay: false` checks
 * the path alone.
 */
export function checkEvidenceOutput(
  controlRoot: string,
  featureId: string,
  record: Pick<EvidenceRecord, 'output_path' | 'output_sha256'>,
  options: { overlay?: boolean } = {},
): string | null {
  const seen = observeEvidenceOutput(controlRoot, featureId, record.output_path);
  if (seen.kind === 'file' && seen.sha256 === record.output_sha256) return null;
  const problem =
    seen.kind === 'file'
      ? `OUTPUT_HASH_MISMATCH: ${record.output_path} hashes to ${seen.sha256.slice(0, 12)}, record says ${record.output_sha256.slice(0, 12)}`
      : seen.problem;
  if (seen.kind === 'unsafe' || options.overlay === false) return problem;
  const copy = repairedCopyOf(controlRoot, featureId, record);
  if (copy === null) return problem;
  const there = observeEvidenceOutput(controlRoot, featureId, copy);
  return there.kind === 'file' && there.sha256 === record.output_sha256 ? null : problem;
}

/** The immutable copy a recorded repair of exactly this path and hash made, from STATE.json, or null. */
export function repairedCopyOf(controlRoot: string, featureId: string, record: Pick<EvidenceRecord, 'output_path' | 'output_sha256'>): string | null {
  let repairs: unknown;
  try {
    repairs = (JSON.parse(readFileSync(join(featurePaths(controlRoot, featureId).featureDir, 'STATE.json'), 'utf8')) as { data?: { evidence_repairs?: unknown } }).data?.evidence_repairs;
  } catch {
    return null;
  }
  if (!Array.isArray(repairs)) return null;
  const at = evidenceKey(controlRoot, featureId, record.output_path);
  if (at === null) return null;
  for (const r of repairs as { from_path?: unknown; sha256?: unknown; to_path?: unknown }[]) {
    if (r === null || typeof r !== 'object' || r.sha256 !== record.output_sha256 || typeof r.from_path !== 'string' || typeof r.to_path !== 'string') continue;
    if (evidenceKey(controlRoot, featureId, r.from_path) === at) return r.to_path;
  }
  return null;
}

/** One spelling of a recorded path, for comparing two records' paths: control-root-relative, forward slashes; null when unsafe. */
export function evidenceKey(controlRoot: string, featureId: string, outputPath: string): string | null {
  const resolved = resolveEvidenceOutput(controlRoot, featureId, { output_path: outputPath });
  if (!resolved.ok) return null;
  const rel = relative(resolve(controlRoot), resolved.path).replace(/\\/g, '/');
  return process.platform === 'win32' ? rel.toLowerCase() : rel;
}

/** Absolute location of a record's output, for reading it back right after a run. */
export function evidenceOutputFile(pathBase: string | undefined, record: Pick<EvidenceRecord, 'output_path'>): string {
  return pathBase === undefined ? resolve(record.output_path) : resolve(pathBase, record.output_path);
}
