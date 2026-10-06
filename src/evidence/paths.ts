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
import { relative, resolve } from 'node:path';
import type { EvidenceRecord } from '../model/types.js';
import { classifyRelativePath, isInsideReal } from '../security/paths.js';
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
 * Null when the output exists as a regular, unlinked file whose content still
 * hashes to what the record says; otherwise a coded problem.
 */
export function checkEvidenceOutput(
  controlRoot: string,
  featureId: string,
  record: Pick<EvidenceRecord, 'output_path' | 'output_sha256'>,
): string | null {
  const resolved = resolveEvidenceOutput(controlRoot, featureId, record);
  if (!resolved.ok) return resolved.problem;
  let st;
  try {
    st = lstatSync(resolved.path);
  } catch {
    return `MISSING_OUTPUT: ${record.output_path}`;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return `UNSAFE_EVIDENCE_PATH: ${record.output_path} is not a regular file`;
  }
  let fd: number;
  try {
    fd = openSync(resolved.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return `UNSAFE_EVIDENCE_PATH: ${record.output_path} could not be opened without following a link`;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || lstatSync(resolved.path).isSymbolicLink()) {
      return `UNSAFE_EVIDENCE_PATH: ${record.output_path} is not a regular file`;
    }
    if (opened.size > MAX_EVIDENCE_BYTES) return `OUTPUT_TOO_LARGE: ${record.output_path}`;
    const sha = createHash('sha256').update(readFileSync(fd)).digest('hex');
    if (sha !== record.output_sha256) {
      return `OUTPUT_HASH_MISMATCH: ${record.output_path} hashes to ${sha.slice(0, 12)}, record says ${record.output_sha256.slice(0, 12)}`;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Absolute location of a record's output, for reading it back right after a run. */
export function evidenceOutputFile(pathBase: string | undefined, record: Pick<EvidenceRecord, 'output_path'>): string {
  return pathBase === undefined ? resolve(record.output_path) : resolve(pathBase, record.output_path);
}
