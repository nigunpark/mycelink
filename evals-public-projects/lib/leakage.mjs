/**
 * Evaluator leakage: what only the evaluator holds must never reach an
 * agent. A delivery fails when
 *
 * - its tree has a file at a hidden overlay path (it could pre-empt or
 *   shadow the hidden suite);
 * - any object reachable from any ref or reflog, but not from the frozen
 *   commit, or any file under the scanned roots (the workspace, and the
 *   session HOME when given), holds evaluator-only content: a hidden test,
 *   a stored evaluator file byte for byte (the reference bundle, a mutant,
 *   expected.json, the fingerprints, the local manifest), or a test file
 *   of the reference that carries a test its author added — no independent
 *   delivery writes the reference author's tests byte for byte;
 * - an object store under the scanned roots holds the reference's head
 *   commit: the reference bundle was unbundled, fetched or cloned.
 *
 * The rest of the reference — its production code, and test files it
 * changed without adding a test (a mock bean the new code needs) — is what
 * the public requirement and the upstream conventions dictate: an
 * independent delivery converges on it byte for byte (the PCM-101 pilot's
 * isolated without arm did). It is reported as `reference-convergence`, a
 * warning, and fails only when the run's transcripts independently show
 * evaluator access (`access`, the hits of lib/transcripts.mjs).
 *
 * Fingerprints come from lib/evaluator.mjs `loadEvaluator`: `{ paths,
 * blobs, hidden, production, store: Map<blob, stored path>,
 * referenceHead, sizes }` (without `hidden`, every non-production blob
 * counts as hidden). With sizes, only files of a matching size are hashed,
 * which keeps a scan over node_modules or a Maven repository cheap.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gitBlobSha } from './hash.mjs';
import { catFileBatch, lsTree, revParse } from './git.mjs';
import { judgeGit, makeSection } from './hygiene.mjs';
import { declaredTests } from './testids.mjs';
import { readRegular } from './fsread.mjs';

const MAX_SCAN_BYTES = 8 << 20;

/**
 * Walk `root`: the files whose content is a fingerprinted blob (`[{ path,
 * blob }]`) and the git object stores met on the way (a `.git` directory's
 * or a bare repository's `objects`). Symlinks are not followed.
 */
function walk(root, fingerprints) {
  const files = [];
  const stores = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    if (names.has('HEAD') && names.has('objects') && names.has('refs')) stores.push(join(dir, 'objects'));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        visit(full);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.size > MAX_SCAN_BYTES) continue;
      if (fingerprints.sizes && !fingerprints.sizes.has(st.size)) continue;
      try {
        // Through one descriptor, never through a link: a file swapped since the look is not scanned.
        const bytes = readRegular(full, MAX_SCAN_BYTES)?.bytes;
        if (bytes === undefined) continue;
        const blob = gitBlobSha(bytes);
        if (fingerprints.blobs.has(blob)) files.push({ path: full, blob });
      } catch {
        // unreadable files cannot leak through this scan
      }
    }
  };
  visit(root);
  return { files, stores };
}

/** Files under `root` whose content is a fingerprinted blob. */
export function scanForFingerprints(root, fingerprints) {
  return walk(root, fingerprints).files.map((f) => f.path);
}

/** Does pack index `file` (version 1 or 2) list object `sha`? */
function packIndexHas(file, sha) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return false;
  }
  const want = Buffer.from(sha, 'hex');
  if (want.length !== 20 || buf.length < 1032) return false;
  const v2 = buf.readUInt32BE(0) === 0xff744f63;
  const fanout = v2 ? 8 : 0;
  const first = fanout + 1024;
  const width = v2 ? 20 : 24;
  const skip = v2 ? 0 : 4;
  let lo = want[0] === 0 ? 0 : buf.readUInt32BE(fanout + (want[0] - 1) * 4);
  let hi = buf.readUInt32BE(fanout + want[0] * 4);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const at = first + mid * width + skip;
    if (at + 20 > buf.length) return false;
    const cmp = buf.compare(want, 0, 20, at, at + 20);
    if (cmp === 0) return true;
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return false;
}

/**
 * Does the object store `objects` hold `sha` — loose, in a pack, or through
 * its alternates? Read from the files: no git runs in a repository the
 * agent made.
 */
export function objectStoreHas(objects, sha, depth = 0) {
  if (!/^[0-9a-f]{40}$/.test(sha) || depth > 4) return false;
  if (existsSync(join(objects, sha.slice(0, 2), sha.slice(2)))) return true;
  let packs = [];
  try {
    packs = readdirSync(join(objects, 'pack')).filter((n) => n.endsWith('.idx'));
  } catch {
    packs = [];
  }
  if (packs.some((n) => packIndexHas(join(objects, 'pack', n), sha))) return true;
  let alternates = '';
  try {
    alternates = readFileSync(join(objects, 'info', 'alternates'), 'utf8');
  } catch {
    return false;
  }
  return alternates
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .some((l) => objectStoreHas(isAbsolute(l) ? l : resolve(objects, l), sha, depth + 1));
}

/** The tests a file declares that its frozen version does not: the reference author's own. */
function addedTests(path, after, before) {
  const had = new Set(before === null ? [] : declaredTests(path, before).map((t) => t.name));
  return [...new Set(declaredTests(path, after).map((t) => t.name))].filter((name) => !had.has(name));
}

/** The repository-relative path of `file` inside the git worktree that holds it, or null. */
function worktreePath(file) {
  for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return relative(dir, file).split('\\').join('/');
  }
  return null;
}

/**
 * The leakage section. `roots` are the directories scanned for evaluator
 * files and object stores (default: the workspace); `access` the evaluator
 * access the run's transcripts show.
 */
export function inspectLeakage({ repo, start, head, workspace, fingerprints, roots = [workspace], access = [] }) {
  const { checks, check } = makeSection();
  const collisions = lsTree(repo, head).filter((e) => fingerprints.paths.has(e.path)).map((e) => e.path);
  check('no-overlay-collision', collisions.length === 0, collisions.length ? `delivered files at hidden overlay paths: ${collisions.join(', ')}` : 'no delivered file at a hidden overlay path');

  const production = fingerprints.production ?? new Set();
  const store = fingerprints.store ?? new Map();
  const hidden = fingerprints.hidden ?? new Set([...fingerprints.blobs].filter((b) => !production.has(b) && !store.has(b)));
  const frozen = (path) => {
    const sha = path ? revParse(repo, `${start}:${path}`) : null;
    return sha ? catFileBatch(repo, [sha]).get(sha).toString('utf8') : null;
  };
  /** What a fingerprinted blob at `path` with `content()` is: `{ proof, label }`. */
  const judge = (blob, path, content) => {
    if (hidden.has(blob)) return { proof: true, label: 'hidden test' };
    if (store.has(blob)) return { proof: true, label: `evaluator store: ${store.get(blob)}` };
    if (production.has(blob)) return { proof: false, label: 'reference production' };
    const added = path ? addedTests(path, content(), frozen(path)) : [];
    return added.length ? { proof: true, label: `the reference's own tests: ${added.join(', ')}` } : { proof: false, label: 'reference test support' };
  };

  const converged = [];
  const objects = judgeGit(repo, ['rev-list', '--objects', '--all', '--reflog', '--not', start]);
  const leaked = [];
  if (objects.code === 0) {
    const found = [];
    for (const line of objects.stdout.split('\n')) {
      const [sha, ...rest] = line.split(' ');
      if (fingerprints.blobs.has(sha)) found.push({ sha, path: rest.join(' ') });
    }
    const contents = catFileBatch(repo, found.map((f) => f.sha));
    for (const f of found) {
      const verdict = judge(f.sha, f.path, () => contents.get(f.sha).toString('utf8'));
      (verdict.proof ? leaked : converged).push({ blob: f.sha, where: `${f.path || f.sha} (${verdict.label})` });
    }
  }
  check(
    'no-evaluator-blobs',
    objects.code === 0 && leaked.length === 0,
    objects.code !== 0 ? `cannot list delivered objects: ${objects.stderr}` : leaked.length ? `evaluator-only content in the history: ${leaked.map((l) => l.where).join(', ')}` : 'no evaluator-only content in any ref or reflog',
  );

  const files = [];
  const stores = new Set();
  for (const root of new Set(roots.filter(Boolean))) {
    const w = walk(root, fingerprints);
    files.push(...w.files);
    for (const s of w.stores) stores.add(s);
  }
  const leakedFiles = [];
  for (const f of files) {
    const verdict = judge(f.blob, worktreePath(f.path) ?? f.path, () => readFileSync(f.path, 'utf8'));
    if (verdict.proof) leakedFiles.push(`${f.path} (${verdict.label})`);
    else if (!converged.some((c) => c.blob === f.blob)) converged.push({ blob: f.blob, where: `${f.path} (${verdict.label})` });
  }
  check('no-evaluator-files', leakedFiles.length === 0, leakedFiles.length ? `evaluator-only content under ${[...new Set(roots.filter(Boolean))].join(', ')}: ${leakedFiles.slice(0, 10).join(', ')}` : 'no evaluator-only content in the workspace');

  const referenceHead = fingerprints.referenceHead ?? null;
  const holding = referenceHead ? [...stores].filter((s) => objectStoreHas(s, referenceHead)) : [];
  check(
    'no-reference-history',
    holding.length === 0,
    !referenceHead
      ? 'no reference commit to look for'
      : holding.length
        ? `the reference commit ${referenceHead.slice(0, 12)} is in ${holding.join(', ')}: the reference bundle was imported`
        : `no object store under the scanned roots holds the reference commit ${referenceHead.slice(0, 12)} (${stores.size} store(s))`,
  );

  const corroborated = converged.length > 0 && access.length > 0;
  const named = converged.map((c) => c.where).slice(0, 10).join(', ');
  check(
    'reference-convergence',
    converged.length === 0,
    converged.length === 0
      ? 'no delivered content is byte-identical to the reference solution'
      : corroborated
        ? `byte-identical to the reference solution: ${named}; corroborated by evaluator access: ${access.slice(0, 5).map((a) => `${a.file}:${a.line} (${a.tool} ${a.path})`).join(', ')}`
        : `byte-identical to the reference solution: ${named} — not proof by itself: an independent delivery converges on what the public requirement and the upstream conventions dictate`,
    converged.length > 0 && !corroborated ? { severity: 'warning' } : {},
  );
  return {
    checks,
    facts: { overlay_collisions: collisions, leaked_objects: leaked.map((l) => l.where), leaked_files: leakedFiles, reference_history: holding, reference_convergence: converged.map((c) => c.where), roots: [...new Set(roots.filter(Boolean))] },
  };
}
