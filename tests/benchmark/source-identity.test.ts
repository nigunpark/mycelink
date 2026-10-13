/**
 * Frozen source identity. The commit, its tree, a SHA-256 digest of every
 * file's path, mode and content, the history (shape, commit count and a
 * digest of its commit ids) and the license blobs are authoritative; the
 * bundle that carries them is transport only. A bundle is trusted when its
 * header names exactly the locked refs, it unbundles, and everything it
 * holds matches the lock — whatever its bytes (git does not write
 * byte-identical bundles across versions, so its hash is recorded as
 * advisory and only warned about). Agent workspaces are imported only from
 * such a bundle, and `prepareSourceBundle` re-makes one from the remote,
 * reproducibly, checking the same identity before writing it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { describeCommit, importSource, parseBundleHeader, prepareSourceBundle, readFrozenFile, verifySourceBundle } from '../../evals-public-projects/lib/source.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { sourceIdentity } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { canonicalSha256 } from '../../evals-public-projects/lib/hash.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { main as sourceTool } from '../../evals-public-projects/tools/source.mjs';

afterAll(() => cleanupTmpRoots());

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '',
};
function g(cwd: string, args: string[], extra: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, ...extra } }).trim();
}
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

let root: string;
let upstream: string;
let complete: string;
let remade: string;
let shallow: string;
let multiRef: string;

/** The history digest, computed independently: SHA-256 of the sorted commit ids, one per line. */
const historyDigest = (repo: string, commit: string) => sha256(g(repo, ['rev-list', commit]).split('\n').sort().join('\n') + '\n');

function lockFor(bundle: string, { kind, commits, boundary = [] as string[] }: { kind: string; commits: number; boundary?: string[] }) {
  const commit = g(upstream, ['rev-parse', 'HEAD']);
  const described = describeCommit({ repo: upstream, commit });
  const lock: any = {
    schema: 'mycelink-bench/source-lock@2',
    project: 'fixture',
    remote: 'https://example.invalid/fixture/fixture.git',
    commit,
    tree: g(upstream, ['rev-parse', 'HEAD^{tree}']),
    object_format: 'sha1',
    content: described.content,
    history: { kind, commits, shallow_boundary: boundary, digest_sha256: kind === 'shallow' ? sha256(`${commit}\n`) : historyDigest(upstream, commit) },
    bundle: { file: 'x.bundle', version: 2, refs: [{ name: 'HEAD', sha: commit }], prerequisites: [], transport: { sha256: sha256(readFileSync(bundle)), size: statSync(bundle).size } },
    license: { spdx: 'MIT', files: [{ path: 'LICENSE', blob: g(upstream, ['rev-parse', 'HEAD:LICENSE']) }] },
  };
  lock.identity_sha256 = sourceIdentity(lock);
  return lock;
}
const relocked = (lock: any, edit: (l: any) => void) => {
  const l = structuredClone(lock);
  edit(l);
  l.identity_sha256 = sourceIdentity(l);
  return l;
};
const failed = (r: any) => r.checks.filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => c.id);
const warned = (r: any) => r.checks.filter((c: any) => !c.ok && c.severity === 'warning').map((c: any) => c.id);

beforeAll(() => {
  root = makeTmpDir('bench-source-');
  upstream = join(root, 'upstream');
  mkdirSync(upstream);
  g(upstream, ['init', '-q', '-b', 'main']);
  for (const [i, file] of ['LICENSE', 'src/a.txt', 'src/b.txt'].entries()) {
    mkdirSync(join(upstream, 'src'), { recursive: true });
    writeFileSync(join(upstream, file), `content ${i}\n`);
    g(upstream, ['add', '-A']);
    g(upstream, ['commit', '-q', '-m', `c${i}`], { GIT_AUTHOR_DATE: `2026-01-0${i + 1}T00:00:00Z`, GIT_COMMITTER_DATE: `2026-01-0${i + 1}T00:00:00Z` });
  }
  complete = join(root, 'complete.bundle');
  g(upstream, ['bundle', 'create', complete, 'HEAD']);
  // The same objects, packed differently: other bytes, the same content.
  remade = join(root, 'remade.bundle');
  g(upstream, ['-c', 'pack.compression=0', 'bundle', 'create', remade, 'HEAD']);
  const depth1 = join(root, 'depth1');
  g(root, ['clone', '-q', '--depth', '1', `file://${upstream.replace(/\\/g, '/')}`, depth1]);
  shallow = join(root, 'shallow.bundle');
  g(depth1, ['bundle', 'create', shallow, 'HEAD']);
  g(upstream, ['branch', 'solution']);
  multiRef = join(root, 'multi.bundle');
  g(upstream, ['bundle', 'create', multiRef, 'HEAD', 'solution']);
});

describe('bundle header', () => {
  it('parses the version, refs and prerequisites of a git bundle', () => {
    const header = parseBundleHeader(readFileSync(complete));
    expect(header).toEqual({ version: 2, capabilities: {}, prerequisites: [], refs: [{ name: 'HEAD', sha: g(upstream, ['rev-parse', 'HEAD']) }] });
    expect(() => parseBundleHeader(Buffer.from('not a bundle\n'))).toThrow(/not a git bundle/);
  });
});

describe('describeCommit', () => {
  it('digests every file by path, mode and content (SHA-256), and the history by its commit ids', () => {
    const commit = g(upstream, ['rev-parse', 'HEAD']);
    const files = g(upstream, ['ls-tree', '-r', '--full-tree', commit])
      .split('\n')
      .map((line) => {
        const [meta, path] = line.split('\t');
        const [mode, , oid] = meta.split(' ');
        return { path, mode, sha256: sha256(execFileSync('git', ['cat-file', 'blob', oid], { cwd: upstream, env: ENV })) };
      })
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(describeCommit({ repo: upstream, commit })).toEqual({
      tree: g(upstream, ['rev-parse', 'HEAD^{tree}']),
      content: { tree_sha256: canonicalSha256(files), files: 3 },
      history: { commits: 3, digest_sha256: historyDigest(upstream, commit) },
    });
  });
});

describe('verifySourceBundle', () => {
  it('accepts a complete bundle that matches its lock, with its facts', async () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    const r = await verifySourceBundle({ lock, bundlePath: complete });
    expect(failed(r)).toEqual([]);
    expect(warned(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.facts).toMatchObject({ commits: 3, history: 'complete', tree: lock.tree, content_sha256: lock.content.tree_sha256, bundle_sha256: lock.bundle.transport.sha256 });
  });

  it('accepts a re-made bundle whose bytes differ: the content is authoritative, the transport hash only advisory', async () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    expect(sha256(readFileSync(remade))).not.toBe(lock.bundle.transport.sha256);
    const r = await verifySourceBundle({ lock, bundlePath: remade });
    expect(failed(r)).toEqual([]);
    expect(warned(r)).toEqual(['bundle-transport']);
    expect(r.ok).toBe(true);
  });

  it('accepts a shallow bundle only when the lock declares its boundary', async () => {
    const head = g(upstream, ['rev-parse', 'HEAD']);
    const good = await verifySourceBundle({ lock: lockFor(shallow, { kind: 'shallow', commits: 1, boundary: [head] }), bundlePath: shallow });
    expect(failed(good)).toEqual([]);
    const declaredComplete = await verifySourceBundle({ lock: lockFor(shallow, { kind: 'complete', commits: 1 }), bundlePath: shallow });
    expect(declaredComplete.ok).toBe(false);
    expect(failed(declaredComplete)).toContain('history');
    const declaredShallow = await verifySourceBundle({ lock: lockFor(complete, { kind: 'shallow', commits: 1, boundary: [head] }), bundlePath: complete });
    expect(declaredShallow.ok).toBe(false);
    expect(failed(declaredShallow)).toContain('history');
  });

  it('rejects corrupted bytes: they do not unbundle', async () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    const bad = join(makeTmpDir('bench-source-bad-'), 'x.bundle');
    const bytes = readFileSync(complete);
    bytes[bytes.length - 30] ^= 0xff;
    writeFileSync(bad, bytes);
    const r = await verifySourceBundle({ lock, bundlePath: bad });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(['unbundle']);
  });

  it('rejects a missing bundle and a symlinked bundle', async () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    expect(failed(await verifySourceBundle({ lock, bundlePath: join(root, 'nope.bundle') }))).toEqual(['bundle-file']);
    const link = join(makeTmpDir('bench-source-link-'), 'x.bundle');
    let linked = true;
    try {
      symlinkSync(complete, link, 'file');
    } catch {
      linked = false;
    }
    if (linked) expect(failed(await verifySourceBundle({ lock, bundlePath: link }))).toEqual(['bundle-file']);
  });

  it('rejects a bundle that carries refs the lock does not name (a smuggled branch)', async () => {
    const lock = lockFor(multiRef, { kind: 'complete', commits: 3 });
    const r = await verifySourceBundle({ lock, bundlePath: multiRef });
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('bundle-refs');
  });

  it('rejects a lock whose commit, tree, content, history, license or identity does not match the bundle', async () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    const parent = g(upstream, ['rev-parse', 'HEAD~1']);
    expect(failed(await verifySourceBundle({ lock: relocked(lock, (l) => (l.commit = parent)), bundlePath: complete }))).toEqual(expect.arrayContaining(['bundle-refs']));
    expect(failed(await verifySourceBundle({ lock: relocked(lock, (l) => (l.tree = g(upstream, ['rev-parse', 'HEAD~1^{tree}']))), bundlePath: complete }))).toEqual(['tree']);
    expect(failed(await verifySourceBundle({ lock: relocked(lock, (l) => (l.content.tree_sha256 = 'f'.repeat(64))), bundlePath: complete }))).toEqual(['content']);
    expect(failed(await verifySourceBundle({ lock: relocked(lock, (l) => (l.content.files = 4)), bundlePath: complete }))).toEqual(['content']);
    expect(failed(await verifySourceBundle({ lock: relocked(lock, (l) => (l.history.digest_sha256 = 'f'.repeat(64))), bundlePath: complete }))).toEqual(['history']);
    expect(failed(await verifySourceBundle({ lock: relocked(lock, (l) => (l.history.commits = 2)), bundlePath: complete }))).toEqual(['history']);
    expect(failed(await verifySourceBundle({ lock: relocked(lock, (l) => (l.license.files[0].blob = 'f'.repeat(40))), bundlePath: complete }))).toEqual(['license:LICENSE']);
    expect(failed(await verifySourceBundle({ lock: { ...lock, identity_sha256: '0'.repeat(64) }, bundlePath: complete }))).toEqual(['identity']);
  });

  it('binds the identity to the content and history, never to the transport bytes', () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    expect(sourceIdentity(relocked(lock, (l) => (l.bundle.transport = { sha256: 'e'.repeat(64), size: 1 })))).toBe(lock.identity_sha256);
    expect(sourceIdentity(relocked(lock, (l) => (l.content.tree_sha256 = 'e'.repeat(64))))).not.toBe(lock.identity_sha256);
    expect(sourceIdentity(relocked(lock, (l) => (l.history.digest_sha256 = 'e'.repeat(64))))).not.toBe(lock.identity_sha256);
    expect(sourceIdentity(relocked(lock, (l) => (l.license.files[0].blob = 'e'.repeat(40))))).not.toBe(lock.identity_sha256);
  });
});

describe('prepareSourceBundle', () => {
  it('fetches the locked commit from its remote, checks the identity, and writes a bundle that verifies', async () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    const target = join(makeTmpDir('bench-prepare-'), 'sources', 'x.bundle');
    const r = await prepareSourceBundle({ lock, from: upstream, target });
    expect(r).toMatchObject({ ok: true, bundle: target, transport: { sha256: sha256(readFileSync(target)), size: statSync(target).size } });
    expect(failed(await verifySourceBundle({ lock, bundlePath: target }))).toEqual([]);
    // Reproducible: preparing again gives the same content, and refuses to overwrite a different file unasked.
    const again = await prepareSourceBundle({ lock, from: upstream, target: join(makeTmpDir('bench-prepare-'), 'x.bundle') });
    expect(again.ok).toBe(true);
    writeFileSync(target, 'something else');
    await expect(prepareSourceBundle({ lock, from: upstream, target })).rejects.toThrow(/exists/);
  });

  it('prepares a shallow lock at its boundary', async () => {
    const head = g(upstream, ['rev-parse', 'HEAD']);
    const lock = lockFor(shallow, { kind: 'shallow', commits: 1, boundary: [head] });
    const target = join(makeTmpDir('bench-prepare-'), 'x.bundle');
    expect((await prepareSourceBundle({ lock, from: `file://${upstream.replace(/\\/g, '/')}`, target })).ok).toBe(true);
    expect(failed(await verifySourceBundle({ lock, bundlePath: target }))).toEqual([]);
  });

  it('writes nothing when the remote’s commit is not the locked identity', async () => {
    const lock = relocked(lockFor(complete, { kind: 'complete', commits: 3 }), (l) => (l.content.tree_sha256 = 'f'.repeat(64)));
    const target = join(makeTmpDir('bench-prepare-'), 'x.bundle');
    const r = await prepareSourceBundle({ lock, from: upstream, target });
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(['content']);
    expect(existsSync(target)).toBe(false);
  });

  it('the source tool fetches from a network remote only with --online', async () => {
    const r = await sourceTool(['prepare', '--project', 'changesets', '--cache-root', makeTmpDir('bench-prepare-cache-')]);
    expect(r).toMatchObject({ ok: false, exit: 2 });
    expect(r.errors.join('\n')).toMatch(/--online/);
  });
});

describe('importSource', () => {
  it('imports a complete bundle as a clean checkout on main with no remote', async () => {
    const target = join(makeTmpDir('bench-import-'), 'repo');
    const r = await importSource({ lock: lockFor(complete, { kind: 'complete', commits: 3 }), bundlePath: complete, target });
    expect(r.head).toBe(g(upstream, ['rev-parse', 'HEAD']));
    expect(g(target, ['rev-parse', 'HEAD'])).toBe(r.head);
    expect(g(target, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(g(target, ['remote'])).toBe('');
    expect(g(target, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(g(target, ['rev-list', '--count', 'HEAD'])).toBe('3');
    expect(g(target, ['rev-parse', '--is-shallow-repository'])).toBe('false');
    // Frozen bytes stay frozen on any host: no line-ending conversion in later checkouts.
    expect(g(target, ['config', '--local', 'core.autocrlf'])).toBe('false');
  });

  it('imports a shallow bundle with its recorded boundary', async () => {
    const head = g(upstream, ['rev-parse', 'HEAD']);
    const target = join(makeTmpDir('bench-import-'), 'repo');
    await importSource({ lock: lockFor(shallow, { kind: 'shallow', commits: 1, boundary: [head] }), bundlePath: shallow, target });
    expect(g(target, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    expect(g(target, ['log', '--format=%H'])).toBe(head);
    expect(readFileSync(join(target, 'src', 'b.txt'), 'utf8')).toBe('content 2\n');
  });

  it('refuses to import from a bundle that fails verification, or into a non-empty directory', async () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    const bad = join(makeTmpDir('bench-import-bad-'), 'x.bundle');
    copyFileSync(complete, bad);
    const bytes = readFileSync(bad);
    bytes[bytes.length - 30] ^= 0xff;
    writeFileSync(bad, bytes);
    await expect(importSource({ lock, bundlePath: bad, target: join(makeTmpDir('bench-import-'), 'repo') })).rejects.toThrow(/unbundle/);
    const busy = makeTmpDir('bench-import-busy-');
    writeFileSync(join(busy, 'keep.txt'), 'x');
    await expect(importSource({ lock, bundlePath: complete, target: busy })).rejects.toThrow(/not empty/);
  });
});

describe('readFrozenFile', () => {
  it('reads a file at the locked commit straight from a verified bundle', async () => {
    expect((await readFrozenFile({ lock: lockFor(complete, { kind: 'complete', commits: 3 }), bundlePath: complete, path: 'src/b.txt' })).toString()).toBe('content 2\n');
  });
  it('refuses an unverified bundle', async () => {
    const lock = lockFor(complete, { kind: 'complete', commits: 3 });
    await expect(readFrozenFile({ lock: { ...lock, identity_sha256: '0'.repeat(64) }, bundlePath: complete, path: 'src/b.txt' })).rejects.toThrow(/failed verification/);
  });
});
