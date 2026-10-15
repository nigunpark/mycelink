/**
 * Immutable evidence artifacts (the CSET-202 rerun).
 *
 * Every output a gate, a fresh verification, a capsule run or a judged
 * history writes is an artifact named by its own content: `<stem>.<the first
 * 16 hex of its SHA-256><ext>`. It is created exclusively and atomically (a
 * synced temporary file linked into place, state/atomic-json.ts) before any
 * record names it, and nothing ever writes that name again. So a record's
 * path and hash keep naming the same bytes for as long as the control
 * repository exists, whatever runs after it — the CSET-202 rerun's red gate
 * ran twice in one claim, wrote both runs to one canonical name, and left the
 * kept record naming bytes that were no longer there.
 *
 * The same bytes twice are one artifact: the second write finds them in place
 * and writes nothing. A name already taken by anything else (a foreign file,
 * a link, a directory) is never written through or over: the artifact takes
 * the next free alternate (`<stem>.<sha16>-<n><ext>`).
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createExclusive } from '../state/atomic-json.js';
import { namesOpenedFile, readRegular } from '../security/paths.js';

/** Alternates tried after the content-addressed name before the store gives up. */
const MAX_ALTERNATES = 32;

/** Bytes an artifact may hold when it is checked in place. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface StoredArtifact {
  /** Absolute path of the artifact. */
  file: string;
  sha256: string;
  /** False when exactly these bytes were already there under the name. */
  created: boolean;
}

export class EvidenceStoreError extends Error {
  constructor(detail: string) {
    super(`EVIDENCE_STORE_CONFLICT: ${detail}`);
    this.name = 'EvidenceStoreError';
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The content-addressed file name of `sha` under `stem` (`n` > 0: an alternate). */
export function contentName(stem: string, sha: string, ext: string, n = 0): string {
  return `${stem}.${sha.slice(0, 16)}${n > 0 ? `-${n}` : ''}${ext}`;
}

/**
 * What is at `file`: nothing, exactly the bytes hashing to `sha` in a regular
 * file with one link, or anything else. Read through one descriptor opened
 * without following a final link, so nothing swapped in is ever hashed.
 */
export function artifactAt(file: string, sha: string): 'missing' | 'same' | 'other' {
  const at = artifactState(file, sha);
  return at === 'linked' ? 'other' : at;
}

/**
 * As artifactAt, telling apart a name still in flux ('linked'): an artifact still being linked into place has two names
 * for a moment, and one a racing writer links into place between this look and its check is there only for the second.
 */
function artifactState(file: string, sha: string): 'missing' | 'same' | 'other' | 'linked' {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'other';
    // Nothing there, or a dangling link (which fails the open the same way): told apart without following it. A regular
    // file there now was linked into place after the open looked (CI 38672044889: a writer of the same bytes took it
    // for something else and wrote a -1 alternate): looked at again, as one still being linked.
    try {
      return lstatSync(file).isFile() ? 'linked' : 'other';
    } catch {
      return 'missing';
    }
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (st.isFile() && st.nlink > 1n) return 'linked';
    if (!st.isFile() || st.nlink !== 1n || st.size > BigInt(MAX_ARTIFACT_BYTES) || !namesOpenedFile(file, st)) return 'other';
    return sha256(readFileSync(fd)) === sha ? 'same' : 'other';
  } finally {
    closeSync(fd);
  }
}

/**
 * Store `bytes` immutably in `dir` under a name derived from them, created
 * exclusively; never overwriting or writing through anything. The artifact is
 * whole and in place when this returns, before any record may name it.
 */
/** Looks, 20 ms apart, at a name a racing writer is still linking into place (about two seconds in all). */
const LINKED_WAITS = 100;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * What is at a name, once a racing writer is done with it: createExclusive links its file into place and then drops
 * its temporary name, so an artifact has two names for a moment. One that keeps a second name is something else.
 */
function settledAt(file: string, sha: string): 'missing' | 'same' | 'other' {
  let at = artifactState(file, sha);
  for (let wait = 0; at === 'linked' && wait < LINKED_WAITS; wait++) {
    Atomics.wait(PAUSE, 0, 0, 20);
    at = artifactState(file, sha);
  }
  return at === 'linked' ? 'other' : at;
}

export function writeImmutable(dir: string, stem: string, ext: string, content: string | Uint8Array): StoredArtifact {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const sha = sha256(bytes);
  mkdirSync(dir, { recursive: true });
  for (let n = 0; n <= MAX_ALTERNATES; n++) {
    const file = join(dir, contentName(stem, sha, ext, n));
    // A racing writer of the same bytes may create it between the look and the create: look again after `exists`.
    for (let look = 0; look < 2; look++) {
      const at = settledAt(file, sha);
      if (at === 'same') return { file, sha256: sha, created: false };
      if (at === 'other') break;
      if (createExclusive(file, bytes) === 'created') return { file, sha256: sha, created: true };
    }
  }
  throw new EvidenceStoreError(`every name for ${stem} ${sha.slice(0, 16)} in ${dir} is taken by something else; nothing was written`);
}

/**
 * Keep an exact copy of `source` in `dir` — only when it holds exactly `expected` — under its own base name, or, when
 * that name is taken by other bytes, under the content-addressed alternate: never overwriting. Null when the source is
 * not exactly what was recorded (nothing is copied: an archive never keeps bytes no record names).
 */
export function keepExactCopy(source: string, expected: string, dir: string): StoredArtifact | null {
  if (artifactAt(source, expected) !== 'same') return null;
  // The bytes kept are the bytes checked: read through one descriptor and hashed again.
  const bytes = readRegular(source, MAX_ARTIFACT_BYTES)?.bytes ?? null;
  if (bytes === null || sha256(bytes) !== expected) return null;
  mkdirSync(dir, { recursive: true });
  const name = basename(source);
  const target = join(dir, name);
  for (let look = 0; look < 2; look++) {
    const at = settledAt(target, expected);
    if (at === 'same') return { file: target, sha256: expected, created: false };
    if (at === 'other') break;
    if (createExclusive(target, bytes) === 'created') return { file: target, sha256: expected, created: true };
  }
  const dot = name.lastIndexOf('.');
  return writeImmutable(dir, dot > 0 ? name.slice(0, dot) : name, dot > 0 ? name.slice(dot) : '', bytes);
}
