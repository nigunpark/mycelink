/**
 * Frozen source identity: offline bundle verification, import, and the
 * reproducible preparation of a bundle from the project's remote.
 *
 * The identity is the content, never the transport. A source lock pins the
 * commit, its tree, a SHA-256 digest of every file's path, mode and content
 * (independent of SHA-1), the history (complete, or shallow at an exact
 * boundary; its commit count; a SHA-256 digest of its sorted commit ids)
 * and the license blobs; `identity_sha256` binds them with the remote. The
 * git bundle that carries them is transport: git does not write
 * byte-identical bundles across versions and settings, so the bundle's
 * SHA-256 and size are recorded as advisory — a different hash is reported
 * as a warning, never trusted or refused for itself.
 *
 * A bundle is trusted only when it is a regular file whose header names
 * exactly the locked refs and no prerequisites, it unbundles (hardened git,
 * into a scratch repository), and the commit, tree, content digest,
 * history and licenses it holds are the locked ones. Agent workspaces are
 * imported only from such a bundle; `prepareSourceBundle` fetches the
 * locked commit from the remote (or a local clone), checks the same
 * identity, and only then writes a bundle.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalSha256, sha256File, sha256Hex } from './hash.mjs';
import { catFileBatch, git, gitOk, lsTree, revParse, safeGit } from './git.mjs';
import { sourceIdentity } from './manifests.mjs';

const MAX_HEADER = 1 << 20;

/** Parse the header of a v2/v3 git bundle from its first bytes. */
export function parseBundleHeader(bytes) {
  const end = bytes.indexOf('\n\n');
  const first = bytes.subarray(0, Math.max(0, bytes.indexOf(0x0a))).toString('utf8');
  const version = first === '# v2 git bundle' ? 2 : first === '# v3 git bundle' ? 3 : null;
  if (version === null || end < 0) throw new Error('not a git bundle (missing v2/v3 signature or header terminator)');
  const lines = bytes.subarray(first.length + 1, end).toString('utf8').split('\n').filter((l) => l !== '');
  const capabilities = {};
  const prerequisites = [];
  const refs = [];
  for (const line of lines) {
    if (line.startsWith('@')) {
      if (version !== 3) throw new Error(`capability line in a v2 bundle: ${line}`);
      const [key, ...value] = line.slice(1).split('=');
      capabilities[key] = value.join('=');
    } else if (line.startsWith('-')) {
      const m = /^-([0-9a-f]{40})(?: (.*))?$/.exec(line);
      if (!m) throw new Error(`malformed prerequisite line: ${line}`);
      prerequisites.push(m[1]);
    } else {
      const m = /^([0-9a-f]{40}) (\S+)$/.exec(line);
      if (!m) throw new Error(`malformed ref line: ${line}`);
      refs.push({ name: m[2], sha: m[1] });
    }
  }
  return { version, capabilities, prerequisites, refs };
}

function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(MAX_HEADER);
    const n = readSync(fd, buf, 0, MAX_HEADER, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const sortRefs = (refs) => [...refs].map((r) => `${r.name} ${r.sha}`).sort();

/**
 * The content identity of `commit` in `repo`: its tree; a SHA-256 digest of
 * every entry's path, mode and content (blobs by the SHA-256 of their
 * bytes, submodules by commit id); and its history as the repository holds
 * it (a shallow repository stops at its boundary): the commit count and a
 * SHA-256 digest of the sorted commit ids, one per line.
 */
export function describeCommit({ repo, commit }) {
  return { tree: revParse(repo, `${commit}^{tree}`), content: contentOf(repo, commit), history: historyOf(repo, commit) };
}

function contentOf(repo, commit) {
  const entries = lsTree(repo, commit);
  const blobs = catFileBatch(repo, entries.filter((e) => e.type === 'blob').map((e) => e.sha));
  const files = entries
    .map((e) => ({ path: e.path, mode: e.mode, sha256: e.type === 'blob' ? sha256Hex(blobs.get(e.sha)) : e.sha }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { tree_sha256: canonicalSha256(files), files: files.length };
}

function historyOf(repo, commit) {
  const ids = git(repo, ['rev-list', commit]).split('\n').filter(Boolean).sort();
  return { commits: ids.length, digest_sha256: sha256Hex(ids.join('\n') + '\n') };
}

function commitParents(repo, commit) {
  const body = git(repo, ['cat-file', '-p', commit]);
  return [...body.split('\n\n')[0].matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]);
}

/**
 * Check what `repo` holds of the locked commit against the lock: commit,
 * tree, content, history (shape, count, digest, connectivity) and
 * licenses. `repo` is bare and holds nothing else; for a shallow lock its
 * shallow file is written here.
 */
function checkContent({ repo, lock, check, facts }) {
  if (!check('commit', revParse(repo, `${lock.commit}^{commit}`) === lock.commit, `${lock.commit} is a commit in the source`)) return;
  let historyOk = true;
  const notes = [];
  if (lock.history.kind === 'shallow') {
    for (const b of lock.history.shallow_boundary) {
      if (revParse(repo, `${b}^{commit}`) !== b) {
        historyOk = false;
        notes.push(`boundary ${b} is not in the source`);
        continue;
      }
      const parents = commitParents(repo, b);
      const present = parents.filter((p) => gitOk(repo, ['cat-file', '-e', `${p}^{commit}`]));
      if (parents.length === 0 || present.length > 0) {
        historyOk = false;
        notes.push(`boundary ${b} has ${present.length}/${parents.length} parent(s) present; a shallow boundary has none`);
      }
    }
    writeFileSync(join(repo, 'shallow'), lock.history.shallow_boundary.join('\n') + '\n');
  }
  const tree = revParse(repo, `${lock.commit}^{tree}`);
  const content = contentOf(repo, lock.commit);
  facts.commit = lock.commit;
  facts.tree = tree;
  facts.content_sha256 = content.tree_sha256;
  facts.files = content.files;
  facts.history = lock.history.kind;
  check('tree', tree === lock.tree, `tree ${tree}, locked ${lock.tree}`);
  check(
    'content',
    content.tree_sha256 === lock.content.tree_sha256 && content.files === lock.content.files,
    `${content.files} file(s), content ${content.tree_sha256.slice(0, 12)}; locked ${lock.content.files}, ${lock.content.tree_sha256.slice(0, 12)}`,
  );
  const fsck = safeGit(repo, ['fsck', '--connectivity-only', '--no-dangling', lock.commit]);
  if (fsck.code !== 0) {
    historyOk = false;
    notes.push(`the history is not ${lock.history.kind}: ${fsck.stderr.split('\n')[0]}`);
  } else {
    const history = historyOf(repo, lock.commit);
    facts.commits = history.commits;
    if (history.commits !== lock.history.commits) {
      historyOk = false;
      notes.push(`${history.commits} commit(s), locked ${lock.history.commits}`);
    } else if (history.digest_sha256 !== lock.history.digest_sha256) {
      historyOk = false;
      notes.push(`history digest ${history.digest_sha256.slice(0, 12)}, locked ${lock.history.digest_sha256.slice(0, 12)}`);
    }
  }
  check('history', historyOk, notes.length ? notes.join('; ') : `${lock.history.kind}, ${facts.commits} commit(s)`);
  for (const { path, blob } of lock.license.files) {
    const actual = revParse(repo, `${lock.commit}:${path}`);
    check(`license:${path}`, actual === blob, `${path} blob ${actual ?? 'missing'}, locked ${blob}`);
  }
}

function section() {
  const checks = [];
  const facts = {};
  const check = (id, ok, detail, { severity = null } = {}) => {
    checks.push({ id, ok: Boolean(ok), detail, ...(severity ? { severity } : {}) });
    return Boolean(ok);
  };
  const result = (extra = {}) => ({ ok: checks.length > 0 && checks.every((c) => c.ok || c.severity === 'warning'), checks, facts, ...extra });
  return { checks, facts, check, result };
}

/**
 * Verify a bundle against its lock, offline. Returns
 * `{ ok, checks: [{ id, ok, detail, severity? }], facts }`; a check with
 * severity 'warning' (the advisory transport hash) never fails it. Never
 * throws for a bad bundle (only for programming errors).
 */
export async function verifySourceBundle({ lock, bundlePath }) {
  const { check, facts, result } = section();
  check('identity', sourceIdentity(lock) === lock.identity_sha256, 'identity_sha256 binds remote, commit, tree, content, history and licenses');
  let st = null;
  try {
    st = lstatSync(bundlePath);
  } catch {
    st = null;
  }
  if (!check('bundle-file', st !== null && st.isFile(), st === null ? `${bundlePath} does not exist` : st.isFile() ? 'regular file' : `${bundlePath} is not a regular file (symlink or special file)`)) {
    return result();
  }
  const sha = await sha256File(bundlePath);
  facts.bundle_sha256 = sha;
  facts.bundle_size = st.size;
  const recorded = lock.bundle.transport;
  check(
    'bundle-transport',
    sha === recorded.sha256 && st.size === recorded.size,
    sha === recorded.sha256 ? 'the bundle bytes are the recorded ones' : `the bundle bytes differ from the recorded ones (sha256 ${sha.slice(0, 12)}, recorded ${recorded.sha256.slice(0, 12)}); advisory only: the content is verified`,
    { severity: 'warning' },
  );

  let header;
  try {
    header = parseBundleHeader(readHead(bundlePath));
  } catch (error) {
    check('bundle-header', false, error.message);
    return result();
  }
  check(
    'bundle-header',
    header.prerequisites.length === 0 && (header.capabilities['object-format'] ?? 'sha1') === lock.object_format,
    `v${header.version}, ${header.prerequisites.length} prerequisite(s), object format ${header.capabilities['object-format'] ?? 'sha1'}`,
  );
  const refsMatch = JSON.stringify(sortRefs(header.refs)) === JSON.stringify(sortRefs(lock.bundle.refs));
  check('bundle-refs', refsMatch && header.refs.some((r) => r.sha === lock.commit), `bundle refs ${sortRefs(header.refs).join(', ')}; locked ${sortRefs(lock.bundle.refs).join(', ')}; commit ${lock.commit}`);
  facts.refs = header.refs;

  const scratch = mkdtempSync(join(tmpdir(), 'bench-bundle-'));
  try {
    const repo = join(scratch, 'repo');
    git(scratch, ['init', '-q', '--bare', repo]);
    // The scratch repository is bare: the shallow file lives at its top.
    const unbundled = safeGit(repo, ['bundle', 'unbundle', resolve(bundlePath)]);
    if (!check('unbundle', unbundled.code === 0, unbundled.code === 0 ? 'unbundled' : `git cannot unbundle it: ${unbundled.stderr.split('\n')[0]}`)) return result();
    checkContent({ repo, lock, check, facts });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  return result();
}

const failures = (v) => v.checks.filter((c) => !c.ok && c.severity !== 'warning');

/** One file at the locked commit, read from a verified bundle (no checkout). */
export async function readFrozenFile({ lock, bundlePath, path }) {
  const verification = await verifySourceBundle({ lock, bundlePath });
  if (!verification.ok) throw new Error(`source bundle ${bundlePath} failed verification: ${failures(verification).map((c) => c.id).join(', ')}`);
  const scratch = mkdtempSync(join(tmpdir(), 'bench-read-'));
  try {
    const repo = join(scratch, 'repo');
    git(scratch, ['init', '-q', '--bare', repo]);
    git(repo, ['bundle', 'unbundle', resolve(bundlePath)]);
    if (lock.history.kind === 'shallow') writeFileSync(join(repo, 'shallow'), lock.history.shallow_boundary.join('\n') + '\n');
    const blob = revParse(repo, `${lock.commit}:${path}`);
    if (!blob) throw new Error(`${path} is not in ${lock.commit}`);
    return git(repo, ['cat-file', 'blob', blob], { encoding: 'buffer' });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * Create a working repository at `target` from a verified bundle: branch
 * `branch` at the locked commit, checked out, no remote, nothing else.
 */
export async function importSource({ lock, bundlePath, target, branch = 'main' }) {
  const verification = await verifySourceBundle({ lock, bundlePath });
  if (!verification.ok) {
    throw new Error(`source bundle ${bundlePath} failed verification: ${failures(verification).map((c) => `${c.id} (${c.detail})`).join('; ')}`);
  }
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`import target ${target} is not empty`);
  mkdirSync(target, { recursive: true });
  git(target, ['init', '-q', '-b', branch]);
  // Frozen bytes stay frozen on any host: later checkouts (worktrees, an
  // agent's git) never convert line endings.
  git(target, ['config', 'core.autocrlf', 'false']);
  git(target, ['bundle', 'unbundle', resolve(bundlePath)]);
  if (lock.history.kind === 'shallow') writeFileSync(join(target, '.git', 'shallow'), lock.history.shallow_boundary.join('\n') + '\n');
  git(target, ['update-ref', `refs/heads/${branch}`, lock.commit]);
  git(target, ['reset', '-q', '--hard', lock.commit]);
  const head = revParse(target, 'HEAD');
  const status = git(target, ['status', '--porcelain', '--untracked-files=all']);
  if (head !== lock.commit || revParse(target, 'HEAD^{tree}') !== lock.tree || status !== '') throw new Error(`import into ${target} is not a clean checkout of ${lock.commit}`);
  return { head, tree: lock.tree, path: target, verification };
}

/** The transport a source is fetched over: an https URL, or a local repository (path or file:// URL). */
export function sourceTransport(from) {
  if (/^https:\/\//.test(from)) return 'https';
  if (/^file:\/\//.test(from) || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(from)) return 'file';
  throw new Error(`unsupported source ${from}: an https URL or a local repository`);
}

/**
 * Re-make the transport bundle of a lock from its remote (or a local
 * clone): fetch exactly the locked commit (complete history, or depth 1
 * for a lock that is shallow at the commit itself) into a scratch
 * repository with hardened git, check commit, tree, content, history and
 * licenses against the lock, create the bundle, verify it like any other,
 * and only then write it to `target` (which must not exist unless
 * `replace`). Returns `{ ok, checks, facts, bundle, transport }`; on a
 * failed check nothing is written.
 */
export async function prepareSourceBundle({ lock, from, target, replace = false }) {
  if (existsSync(target) && !replace) throw new Error(`${target} exists (pass replace to overwrite it)`);
  if (sourceIdentity(lock) !== lock.identity_sha256) throw new Error('the lock is inconsistent: identity_sha256 does not bind its content');
  const transport = sourceTransport(from);
  const shallow = lock.history.kind === 'shallow';
  if (shallow && !(lock.history.shallow_boundary.length === 1 && lock.history.shallow_boundary[0] === lock.commit)) {
    throw new Error('only a shallow history cut at the locked commit itself (depth 1) can be re-made');
  }
  if (lock.bundle.refs.length !== 1 || lock.bundle.refs[0].name !== 'HEAD' || lock.bundle.refs[0].sha !== lock.commit) throw new Error('only a bundle of HEAD at the locked commit can be re-made');
  const { check, facts, result } = section();
  const scratch = mkdtempSync(join(tmpdir(), 'bench-prepare-'));
  try {
    const repo = join(scratch, 'repo');
    git(scratch, ['init', '-q', '--bare', repo]);
    const fetched = safeGit(repo, ['-c', `protocol.${transport}.allow=always`, 'fetch', '-q', '--no-tags', ...(shallow ? ['--depth=1'] : []), from, `${lock.commit}:refs/heads/main`]);
    if (!check('fetch', fetched.code === 0, fetched.code === 0 ? `fetched ${lock.commit.slice(0, 12)} from ${from}` : `cannot fetch ${lock.commit} from ${from}: ${fetched.stderr.split('\n')[0]}`)) return result();
    // A shallow fetch writes its own boundary; the lock's is written (and checked) like a bundle's.
    rmSync(join(repo, 'shallow'), { force: true });
    checkContent({ repo, lock, check, facts });
    if (!result().ok) return result();
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const made = join(scratch, 'source.bundle');
    git(repo, ['bundle', 'create', made, 'HEAD']);
    const verified = await verifySourceBundle({ lock, bundlePath: made });
    for (const c of verified.checks) if (c.id === 'bundle-header' || c.id === 'bundle-refs' || c.id === 'unbundle') check(`bundle:${c.id}`, c.ok, c.detail);
    if (!result().ok || !verified.ok) return result();
    mkdirSync(dirname(target), { recursive: true });
    const staged = `${target}.tmp-${process.pid}`;
    writeFileSync(staged, readFileSync(made));
    renameSync(staged, target);
    const sha = sha256Hex(readFileSync(target));
    return result({ bundle: target, transport: { sha256: sha, size: lstatSync(target).size, recorded: sha === lock.bundle.transport.sha256 } });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
