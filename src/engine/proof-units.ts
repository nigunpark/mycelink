/**
 * Re-proof units: a settled producer's proof committed into the product.
 *
 * CSET-201 final (normal arm, trusted): R001 found AC-2 and AC-3 gaps whose
 * reproductions the first generations' code already passed. Each rework
 * settled as a re-proof (CSET-203 r16): the passing tests archived in the
 * criterion ledger and kept out of the branch — never in the product. R002
 * passed AC-3 on those archived tests; the planner's next rework started from
 * an integration head that had never held them, and R003 found AC-3's tests
 * absent from the integrated head. A settled producer's proof was lost because
 * the authoritative head never contained it.
 *
 * Here settle commits a re-proof exactly as the red gate ran it: the test
 * files of the snapshot the gate kept (their bytes, hashed as recorded),
 * applied to the worker's submitted head as a test-only commit of their own —
 * carrying the `Mycelink-Reproof: <AC>` trailer — before fresh verification
 * runs there and the node is integrated. A file the worker's own commits
 * changed since the gate ran is merged three ways (both sides appending to it:
 * both kept, the worker's first); a conflict, or a merge that would remove or
 * edit a test that was there, is refused (the worker runs the red gate again
 * on its final head). The worker's history is judged as it submitted it; the
 * unit is the controller's, bound to the claim that settled it. The
 * independent benchmark replay credits such a unit as tests alone of
 * behaviour an earlier RED drove (evals-public-projects lib/tdd.mjs).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../git/git.js';
import { priorTestChanges } from './test-declarations.js';

/** The commit trailer naming the criteria a re-proof unit re-proves, as settle writes it and the benchmark replay reads it. */
export const REPROOF_TRAILER = 'Mycelink-Reproof';

/** Who a re-proof unit is committed as: the controller, never the worker. */
export const REPROOF_IDENTITY = { name: 'Mycelink Settle', email: 'settle@mycelink.invalid' } as const;

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** The criteria a commit's `Mycelink-Reproof:` trailer names, or null when it carries none. */
export function reproofTrailer(message: string): string[] | null {
  const lines = message.split(/\r?\n/).filter((l) => l.startsWith(`${REPROOF_TRAILER}:`));
  if (lines.length === 0) return null;
  return [...new Set(lines.flatMap((l) => l.slice(REPROOF_TRAILER.length + 1).split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean))];
}

/** One test file of a re-proof, as its red gate ran it. */
export interface ProofFile {
  path: string;
  bytes: Buffer;
  /** The SHA-256 its snapshot recorded (the bytes must hash to it). */
  sha256: string;
  /** The file's blob at the commit the red gate ran on (null: absent there). */
  base_blob: string | null;
}

export type UnitPlan =
  | { kind: 'none' }
  | { kind: 'commit'; files: { path: string; blob: string; mode: string }[] }
  | { kind: 'refused'; code: 'REPROOF_CONFLICT' | 'REPROOF_WEAKENS' | 'REPROOF_TAMPERED'; paths: string[]; detail: string };

function blobAt(repoPath: string, rev: string, path: string): { blob: string; mode: string } | null {
  const out = runGit(repoPath, ['ls-tree', '-z', rev, '--', path], { allowFail: true }).stdout;
  const entry = out.split('\0').find((e) => e.endsWith(`\t${path}`));
  if (entry === undefined) return null;
  const [mode, type, blob] = entry.slice(0, entry.indexOf('\t')).split(' ');
  return type === 'blob' && blob !== undefined && mode !== undefined ? { blob, mode } : null;
}

function readBlob(repoPath: string, blob: string): string {
  return runGit(repoPath, ['cat-file', 'blob', blob]).stdout;
}

/** Write `bytes` as a blob, filtered as `git add` would for `path`: its id. */
function writeBlob(repoPath: string, path: string, bytes: Buffer | string, scratch: string): string {
  const file = join(scratch, `blob-${sha256(path).slice(0, 12)}`);
  writeFileSync(file, bytes);
  return runGit(repoPath, ['hash-object', '-w', `--path=${path}`, file]).stdout.trim();
}

/**
 * The merged content of one file: the worker's version at `head` (ours), the version the gate ran on (base) and the gate's
 * bytes (theirs). Null when they conflict.
 */
function merge(repoPath: string, path: string, ours: string | null, base: string | null, theirs: string, scratch: string): string | null {
  if (ours === null) return base === null ? theirs : null;
  if (base !== null && ours === base) return theirs;
  if (ours === theirs) return ours;
  // Both sides only appended to what the gate ran on: both appends kept, the worker's first.
  const from = base ?? '';
  if (ours.startsWith(from) && theirs.startsWith(from)) {
    const mine = ours.slice(from.length);
    const added = theirs.slice(from.length);
    return mine.endsWith('\n') || mine === '' ? `${ours}${added}` : `${ours}\n${added}`;
  }
  if (base === null) return null;
  const o = join(scratch, `ours-${sha256(path).slice(0, 12)}`);
  const b = join(scratch, `base-${sha256(path).slice(0, 12)}`);
  const t = join(scratch, `theirs-${sha256(path).slice(0, 12)}`);
  writeFileSync(o, ours);
  writeFileSync(b, base);
  writeFileSync(t, theirs);
  const r = runGit(repoPath, ['merge-file', '-p', '--quiet', o, b, t], { allowFail: true });
  return r.exitCode === 0 ? r.stdout : null;
}

/**
 * What committing a re-proof's files onto `head` would do, the blobs written (no ref moves): nothing (each file already
 * there as the gate ran it), the files to commit, or a refusal — a file that no longer hashes as recorded, a conflict
 * with the worker's own later change, or a merge that removes or edits a test that was there.
 */
export function planProofUnit(repoPath: string, head: string, files: readonly ProofFile[]): UnitPlan {
  const scratch = mkdtempSync(join(tmpdir(), 'mycelink-reproof-'));
  try {
    const out: { path: string; blob: string; mode: string }[] = [];
    const conflicts: string[] = [];
    const weakened: string[] = [];
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      if (sha256(f.bytes) !== f.sha256) return { kind: 'refused', code: 'REPROOF_TAMPERED', paths: [f.path], detail: `${f.path}: the red gate's copy no longer hashes to ${f.sha256.slice(0, 12)}` };
      const at = blobAt(repoPath, head, f.path);
      const theirs = f.bytes.toString('utf8');
      const ours = at === null ? null : readBlob(repoPath, at.blob);
      const base = f.base_blob === null ? null : readBlob(repoPath, f.base_blob);
      const merged = merge(repoPath, f.path, ours, base, theirs, scratch);
      if (merged === null) {
        conflicts.push(f.path);
        continue;
      }
      if (ours !== null && merged === ours) continue;
      const prior = priorTestChanges([{ path: f.path, before: ours, after: merged }]);
      if (prior.removed.length > 0 || prior.edited.length > 0 || prior.deleted.length > 0 || prior.opaque.length > 0) {
        weakened.push(f.path);
        continue;
      }
      out.push({ path: f.path, blob: writeBlob(repoPath, f.path, merged, scratch), mode: at?.mode ?? '100644' });
    }
    if (conflicts.length > 0) {
      return { kind: 'refused', code: 'REPROOF_CONFLICT', paths: conflicts, detail: `${conflicts.join(', ')}: the re-proof's tests, as the red gate ran them, conflict with this branch's own later change to ${conflicts.length === 1 ? 'that file' : 'those files'}` };
    }
    if (weakened.length > 0) {
      return { kind: 'refused', code: 'REPROOF_WEAKENS', paths: weakened, detail: `${weakened.join(', ')}: committing the re-proof there would remove or edit a test the submitted head holds; a re-proof only adds tests` };
    }
    return out.length === 0 ? { kind: 'none' } : { kind: 'commit', files: out };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Write the unit's commit on top of `head` (an object only: no ref moves), its message ending in the re-proof trailer. */
export function commitProofUnit(repoPath: string, head: string, plan: Extract<UnitPlan, { kind: 'commit' }>, message: { subject: string; body: string; criteria: readonly string[] }): string {
  const scratch = mkdtempSync(join(tmpdir(), 'mycelink-reproof-index-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    runGit(repoPath, ['read-tree', head], { env });
    for (const f of plan.files) runGit(repoPath, ['update-index', '--add', '--cacheinfo', `${f.mode},${f.blob},${f.path}`], { env });
    const tree = runGit(repoPath, ['write-tree'], { env }).stdout.trim();
    const who = { GIT_AUTHOR_NAME: REPROOF_IDENTITY.name, GIT_AUTHOR_EMAIL: REPROOF_IDENTITY.email, GIT_COMMITTER_NAME: REPROOF_IDENTITY.name, GIT_COMMITTER_EMAIL: REPROOF_IDENTITY.email };
    return runGit(repoPath, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', head, '-m', message.subject, '-m', message.body, '-m', `${REPROOF_TRAILER}: ${[...message.criteria].join(', ')}`], { env: who }).stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
