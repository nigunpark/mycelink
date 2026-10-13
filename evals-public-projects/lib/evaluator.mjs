/**
 * Evaluator-only artifacts: hidden acceptance tests, the reference solution
 * and mutants. They never enter the repository or an agent workspace.
 *
 * Authoring happens in a scratch clone of the frozen source, as branches:
 *
 *   hidden/<PRD>          one commit on the frozen commit that only ADDS test files
 *   reference/<PRD>       linear commits on the frozen commit: tests first, then code
 *   mutant/<PRD>/<id>     one commit on the reference head changing production code only
 *
 * `importEvaluator` checks those rules and writes, under
 * `<cache>/evaluator/<project>/<PRD>/`:
 *
 *   hidden/<paths>        the overlay (repository-relative)
 *   reference.bundle      the reference commits (prerequisite: the frozen commit)
 *   mutants/<id>.patch    binary-safe diffs from the reference head
 *   fingerprints.json     blob ids and sizes of hidden files, reference test files and the
 *                         reference's substantial production files (leakage scans)
 *
 * and commits nothing but `evaluator.lock.json` next to the PRD: one
 * digest over every stored file's path, hash and size, and how many files
 * of each kind there are — no name, so the repository (which the plugin arm
 * loads) gives away no hidden test or mutant. The names stay beside the
 * store, in MANIFEST.local.json, for diagnostics only. Every later use
 * verifies the directory against the lock's digest and fails closed on any
 * difference. Qualification adds `expected.json`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { buildZip } from '../../scripts/lib/zip.mjs';
import { assertSafeTreePath, canonicalSha256, gitBlobSha, sha256Hex } from './hash.mjs';
import { readZip } from './plugin.mjs';
import { catFileBatch, git, gitOk, revParse, safeGit } from './git.mjs';
import { createAdapter } from './adapters/index.mjs';
import { parseBundleHeader } from './source.mjs';
import { validate, loadSchema } from './schema.mjs';

export function evaluatorDir(cacheRoot, projectId, prdId) {
  return join(cacheRoot, 'evaluator', projectId, prdId);
}

function changes(repo, from, to) {
  const out = git(repo, ['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '--no-renames', from, to]);
  const parts = out.split('\0');
  const list = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === '') break;
    list.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return list;
}

/** Lines a production file must gain or lose before its reference version is fingerprinted. */
export const PRODUCTION_FINGERPRINT_LINES = 5;

/** Files `from..to` adds or modifies by at least PRODUCTION_FINGERPRINT_LINES lines (binary files always). */
function substantialChanges(repo, from, to) {
  const out = git(repo, ['diff', '--numstat', '-z', '--no-renames', from, to]);
  const list = [];
  for (const record of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (!m) continue;
    const changed = m[1] === '-' ? Infinity : Number(m[1]) + Number(m[2]);
    if (changed >= PRODUCTION_FINGERPRINT_LINES && revParse(repo, `${to}:${m[3]}`) !== null) list.push({ path: m[3], changed });
  }
  return list;
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split('\\').join('/'));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** The local, uncommitted list of stored files (diagnostics only; never trusted for the verdict). */
export const LOCAL_MANIFEST = 'MANIFEST.local.json';

function lockFiles(dir) {
  return listFiles(dir)
    .filter((p) => p !== 'evaluator.lock.json' && p !== LOCAL_MANIFEST)
    .map((path) => {
      const body = readFileSync(join(dir, ...path.split('/')));
      return { path, sha256: sha256Hex(body), size: body.length };
    });
}

/** What a stored file is; the lock's schema admits these kinds only. */
function kindOf(path) {
  if (path.startsWith('hidden/')) return 'hidden';
  if (path.startsWith('mutants/')) return 'mutant';
  if (path === 'reference.bundle') return 'reference';
  if (path === 'fingerprints.json') return 'fingerprints';
  if (path === 'expected.json') return 'expected';
  return 'other';
}

function kindCounts(files) {
  const counts = {};
  for (const f of files) counts[kindOf(f.path)] = (counts[kindOf(f.path)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const describeCounts = (counts) =>
  Object.entries(counts)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');

function linearCommits(repo, from, to) {
  const list = git(repo, ['rev-list', '--reverse', '--parents', `${from}..${to}`]).split('\n').filter(Boolean);
  return list.map((line) => {
    const [sha, ...parents] = line.split(' ');
    return { sha, parents };
  });
}

/** Import and lock the evaluator artifacts of one PRD from its authoring repository. */
export function importEvaluator({ project, prdId, from, cacheRoot }) {
  const prd = project.prds.find((p) => p.manifest.id === prdId);
  if (!prd) throw new Error(`${project.id} has no PRD ${prdId}`);
  const adapter = createAdapter(project.adapter);
  const start = project.lock.commit;
  if (revParse(from, `${start}^{commit}`) !== start) throw new Error(`${from} does not contain the frozen commit ${start}`);

  // hidden/<PRD>: one commit that only adds test files.
  const hiddenHead = revParse(from, `refs/heads/hidden/${prdId}`);
  if (!hiddenHead) throw new Error(`branch hidden/${prdId} is missing`);
  const hiddenCommits = gitOk(from, ['merge-base', '--is-ancestor', start, hiddenHead]) ? linearCommits(from, start, hiddenHead) : [];
  if (hiddenCommits.length !== 1 || hiddenCommits[0].parents.join() !== start) throw new Error(`hidden/${prdId} must be exactly one commit on the frozen commit`);
  const hiddenChanges = changes(from, start, hiddenHead);
  const notAdded = hiddenChanges.filter((c) => c.status !== 'A');
  if (notAdded.length) throw new Error(`hidden/${prdId} may only add files; it changes ${notAdded.map((c) => c.path).join(', ')}`);
  for (const c of hiddenChanges) if (!adapter.isTestPath(c.path)) throw new Error(`hidden file ${c.path} is not a test path`);

  // reference/<PRD>: linear commits descending from the frozen commit.
  const referenceHead = revParse(from, `refs/heads/reference/${prdId}`);
  if (!referenceHead) throw new Error(`branch reference/${prdId} is missing`);
  if (!gitOk(from, ['merge-base', '--is-ancestor', start, referenceHead])) throw new Error(`reference/${prdId} does not descend from the frozen commit`);
  const referenceCommits = linearCommits(from, start, referenceHead);
  if (referenceCommits.length < 2 || referenceCommits.some((c) => c.parents.length !== 1)) throw new Error(`reference/${prdId} must be at least two linear commits (tests first, then code)`);

  // mutant/<PRD>/<id>: one commit on the reference head, production code only.
  const mutantRefs = git(from, ['for-each-ref', '--format=%(refname)', `refs/heads/mutant/${prdId}/`]).split('\n').filter(Boolean).sort();
  const mutants = [];
  for (const ref of mutantRefs) {
    const id = ref.slice(`refs/heads/mutant/${prdId}/`.length);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`invalid mutant id ${id}`);
    const head = revParse(from, ref);
    const commits = gitOk(from, ['merge-base', '--is-ancestor', referenceHead, head]) ? linearCommits(from, referenceHead, head) : [];
    if (commits.length !== 1) throw new Error(`mutant ${id} must be exactly one commit on reference/${prdId}`);
    const touched = changes(from, referenceHead, head);
    if (touched.length === 0 || touched.some((c) => adapter.isTestPath(c.path))) throw new Error(`mutant ${id} must change production code only`);
    mutants.push({ id, head });
  }
  if (mutants.length === 0) throw new Error(`no mutant/${prdId}/<id> branches`);

  const dir = evaluatorDir(cacheRoot, project.id, prdId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'hidden'), { recursive: true });
  mkdirSync(join(dir, 'mutants'), { recursive: true });
  const hiddenBlobs = hiddenChanges.map((c) => ({ path: c.path, blob: revParse(from, `${hiddenHead}:${c.path}`) }));
  const contents = catFileBatch(from, hiddenBlobs.map((h) => h.blob));
  for (const h of hiddenBlobs) {
    const file = join(dir, 'hidden', ...h.path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents.get(h.blob));
  }
  git(from, ['bundle', 'create', join(dir, 'reference.bundle'), `refs/heads/reference/${prdId}`, `^${start}`]);
  for (const m of mutants) {
    const patch = safeGit(from, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', referenceHead, m.head], { encoding: 'buffer' });
    if (patch.code !== 0) throw new Error(`cannot diff mutant ${m.id}: ${patch.stderr}`);
    writeFileSync(join(dir, 'mutants', `${m.id}.patch`), patch.stdout);
  }
  const referenceTests = changes(from, start, referenceHead).filter((c) => c.status !== 'D' && adapter.isTestPath(c.path));
  // The reference's substantial production code too: every production file it adds or changes by
  // PRODUCTION_FINGERPRINT_LINES lines or more (one-line edits an independent delivery may reproduce exactly are left out).
  const referenceProduction = substantialChanges(from, start, referenceHead).filter((c) => !adapter.isTestPath(c.path));
  const productionBlobs = referenceProduction.map((c) => revParse(from, `${referenceHead}:${c.path}`));
  const fingerprintBlobs = [...hiddenBlobs.map((h) => h.blob), ...referenceTests.map((c) => revParse(from, `${referenceHead}:${c.path}`)), ...productionBlobs];
  const sized = catFileBatch(from, fingerprintBlobs);
  const fingerprints = {
    paths: hiddenBlobs.map((h) => h.path).sort(),
    blobs: [...new Set(fingerprintBlobs)].sort(),
    production: [...new Set(productionBlobs)].sort(),
    sizes: [...new Set([...sized.values()].map((b) => b.length))].sort((a, b) => a - b),
  };
  writeFileSync(join(dir, 'fingerprints.json'), JSON.stringify(fingerprints, null, 2) + '\n');

  const hiddenTests = adapter.testsInDelta(hiddenBlobs.map((h) => ({ path: h.path, before: null, after: contents.get(h.blob).toString('utf8') })));
  const lock = writeEvaluatorLock({ project, prdId, dir, reference: { head: referenceHead, commits: referenceCommits.length }, hiddenTests: hiddenTests.length, mutants: mutants.length });
  return {
    dir,
    hidden: hiddenBlobs.map((h) => h.path).sort(),
    hidden_tests: hiddenTests,
    reference: { head: referenceHead, commits: referenceCommits.length, ref: `refs/heads/reference/${prdId}` },
    mutants: mutants.map((m) => m.id),
    lock,
  };
}

/** Write (or rewrite, after qualification) the committed lock for an evaluator directory. */
export function writeEvaluatorLock({ project, prdId, dir, reference, hiddenTests, mutants }) {
  const prd = project.prds.find((p) => p.manifest.id === prdId);
  const files = lockFiles(dir);
  const lock = {
    schema: 'mycelink-bench/evaluator-lock@2',
    project: project.id,
    prd: prdId,
    source_identity_sha256: project.lock.identity_sha256,
    files: kindCounts(files),
    digest_sha256: canonicalSha256(files),
    reference,
    hidden_tests: hiddenTests,
    mutants,
  };
  const problems = validate(loadSchema('evaluator-lock'), lock);
  if (problems.length) throw new Error(`evaluator lock is invalid: ${problems.join('; ')}`);
  writeFileSync(join(dir, LOCAL_MANIFEST), JSON.stringify({ schema: 'mycelink-bench/evaluator-manifest@1', digest_sha256: lock.digest_sha256, files }, null, 2) + '\n');
  writeFileSync(join(prd.dir, 'evaluator.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

/**
 * Every file in `dir` must be exactly the locked one, nothing missing,
 * nothing extra: the stored list must hash to the committed digest. On a
 * mismatch the local manifest names the differences, but only when it is
 * itself the list the digest was made from.
 */
export function verifyEvaluator({ dir, lock }) {
  const actual = lockFiles(dir);
  if (canonicalSha256(actual) === lock.digest_sha256) return { ok: true, problems: [] };
  const problems = [];
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(dir, LOCAL_MANIFEST), 'utf8'));
  } catch {
    manifest = null;
  }
  if (Array.isArray(manifest?.files) && canonicalSha256(manifest.files) === lock.digest_sha256) {
    const byPath = new Map(actual.map((f) => [f.path, f]));
    for (const f of manifest.files) {
      const a = byPath.get(f.path);
      if (!a) problems.push(`${f.path}: missing`);
      else if (a.sha256 !== f.sha256 || a.size !== f.size) problems.push(`${f.path}: content does not match the lock`);
    }
    const locked = new Set(manifest.files.map((f) => f.path));
    for (const f of actual) if (!locked.has(f.path)) problems.push(`${f.path}: not in the lock`);
  }
  if (problems.length === 0) problems.push(`the stored files do not match the committed lock digest (${describeCounts(kindCounts(actual))}; locked ${describeCounts(lock.files)})`);
  return { ok: false, problems };
}

/** Load a PRD's evaluator artifacts after verifying them against the committed lock. */
export function loadEvaluator({ cacheRoot, project, prdId }) {
  const prd = project.prds.find((p) => p.manifest.id === prdId);
  if (!prd) throw new Error(`${project.id} has no PRD ${prdId}`);
  const lockPath = join(prd.dir, 'evaluator.lock.json');
  if (!existsSync(lockPath)) throw new Error(`${lockPath} is missing: the PRD has no imported evaluator artifacts`);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const schemaProblems = validate(loadSchema('evaluator-lock'), lock);
  if (schemaProblems.length) throw new Error(`${lockPath}: ${schemaProblems.join('; ')}`);
  if (lock.source_identity_sha256 !== project.lock.identity_sha256) throw new Error(`${lockPath} was made for another source identity`);
  const dir = evaluatorDir(cacheRoot, project.id, prdId);
  const v = verifyEvaluator({ dir, lock });
  if (!v.ok) throw new Error(`evaluator artifacts in ${dir} do not match the committed lock: ${v.problems.join('; ')}`);
  const hidden = new Map(listFiles(join(dir, 'hidden')).map((p) => [p, readFileSync(join(dir, 'hidden', ...p.split('/')))]));
  const mutants = new Map(listFiles(join(dir, 'mutants')).map((p) => [p.replace(/\.patch$/, ''), readFileSync(join(dir, 'mutants', p))]));
  const fp = JSON.parse(readFileSync(join(dir, 'fingerprints.json'), 'utf8'));
  for (const [path, body] of hidden) if (!fp.blobs.includes(gitBlobSha(body)) || !fp.paths.includes(path)) throw new Error(`fingerprints.json does not cover hidden file ${path}`);
  const expectedPath = join(dir, 'expected.json');
  // Every stored file byte for byte (the reference bundle, the mutants, expected.json, the fingerprints, the
  // local manifest): no delivery holds one unless the store reached it (lib/leakage.mjs).
  const stored = new Map();
  for (const path of listFiles(dir).filter((p) => p !== 'evaluator.lock.json' && !p.startsWith('hidden/'))) {
    const body = readFileSync(join(dir, ...path.split('/')));
    stored.set(gitBlobSha(body), { path, size: body.length });
  }
  return {
    dir,
    lock,
    hidden,
    mutants,
    fingerprints: {
      paths: new Set(fp.paths),
      blobs: new Set([...fp.blobs, ...stored.keys()]),
      hidden: new Set([...hidden.values()].map((body) => gitBlobSha(body))),
      production: new Set(fp.production ?? []),
      store: new Map([...stored].map(([blob, f]) => [blob, f.path])),
      referenceHead: lock.reference?.head ?? null,
      sizes: new Set([...fp.sizes, ...[...stored.values()].map((f) => f.size)]),
    },
    expected: existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : null,
    referenceBundle: join(dir, 'reference.bundle'),
  };
}

/** Add the reference commits to `repo` (which holds the frozen commit); returns the reference head. */
export function unbundleReference({ evaluator, repo }) {
  const header = parseBundleHeader(readFileSync(evaluator.referenceBundle).subarray(0, 1 << 20));
  if (header.refs.length !== 1 || header.refs[0].sha !== evaluator.lock.reference.head) throw new Error('reference.bundle does not hold exactly the locked reference head');
  git(repo, ['bundle', 'unbundle', evaluator.referenceBundle]);
  return header.refs[0].sha;
}

/**
 * Export a PRD's private evaluator store, after verifying it against the
 * committed lock, as a deterministic archive (STORE zip, fixed timestamps,
 * sorted entries: the same store gives the same bytes). The archive stays
 * private; the committed lock digest is the public commitment it is
 * checked against on import. Returns `{ archive, sha256, digest_sha256, files }`.
 */
export function exportEvaluator({ cacheRoot, project, prdId, out }) {
  const evaluator = loadEvaluator({ cacheRoot, project, prdId });
  const files = lockFiles(evaluator.dir);
  const entries = files.map((f) => ({ name: f.path, data: readFileSync(join(evaluator.dir, ...f.path.split('/'))), mode: 0o644 }));
  const bytes = buildZip(entries);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  return { archive: out, sha256: sha256Hex(bytes), digest_sha256: evaluator.lock.digest_sha256, files: files.length };
}

/**
 * Install an exported archive as the PRD's evaluator store under
 * `cacheRoot` — only when its entries hash to exactly the committed lock's
 * digest (checked before anything is written), replacing any store there.
 * Returns `{ dir, digest_sha256 }`.
 */
export function importEvaluatorArchive({ cacheRoot, project, prdId, archive }) {
  const prd = project.prds.find((p) => p.manifest.id === prdId);
  if (!prd) throw new Error(`${project.id} has no PRD ${prdId}`);
  const lock = JSON.parse(readFileSync(join(prd.dir, 'evaluator.lock.json'), 'utf8'));
  if (lock.source_identity_sha256 !== project.lock.identity_sha256) throw new Error('the committed evaluator lock was made for another source identity');
  const entries = readZip(readFileSync(archive));
  for (const e of entries) assertSafeTreePath(e.name);
  const files = entries.map((e) => ({ path: e.name, sha256: sha256Hex(e.data), size: e.data.length })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.some((f) => f.path === 'evaluator.lock.json' || f.path === LOCAL_MANIFEST)) throw new Error('the archive carries a lock or manifest of its own');
  if (canonicalSha256(files) !== lock.digest_sha256) throw new Error(`the archive does not match the committed evaluator lock of ${prdId} (digest ${canonicalSha256(files).slice(0, 12)}, locked ${lock.digest_sha256.slice(0, 12)})`);
  const dir = evaluatorDir(cacheRoot, project.id, prdId);
  const staging = `${dir}.import-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  for (const e of entries) {
    const file = join(staging, ...e.name.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, e.data, { flag: 'wx' });
  }
  writeFileSync(join(staging, LOCAL_MANIFEST), JSON.stringify({ schema: 'mycelink-bench/evaluator-manifest@1', digest_sha256: lock.digest_sha256, files }, null, 2) + '\n');
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  loadEvaluator({ cacheRoot, project, prdId });
  return { dir, digest_sha256: lock.digest_sha256 };
}
