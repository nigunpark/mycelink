/**
 * The workspace transaction engine a with-arm controller session runs in
 * (CSET-203 r9): a durable, content-addressed snapshot of the workspace's
 * file system and Git state before the session, the deltas the session left,
 * and an idempotent, journaled rollback of exactly the deltas chosen — to
 * their bytes, absence, mode or symlink target before the session — verified
 * against the expected state. Nothing is followed through a symlink, no FIFO
 * is opened, any byte string Linux allows as a name round-trips, and a crash
 * in the middle of a rollback is finished by running it again.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, linkedAlias, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { captureSnapshot, diffSnapshots, indexSemantics, keyBytes, relKey, showKey, workspaceKey } from '../../evals-public-projects/lib/snapshot.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { RollbackConflict, applyRollback, loadPlan, planRollback, verifyRollback } from '../../evals-public-projects/lib/rollback.mjs';

afterAll(() => cleanupTmpRoots());

const POSIX = process.platform !== 'win32';
const LINUX = process.platform === 'linux';

function fixture() {
  const base = makeTmpDir('ws-snap-');
  const root = join(base, 'workspace');
  const store = join(base, 'store');
  const txn = join(base, 'txn');
  mkdirSync(join(root, 'dir', 'sub'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'alpha\n');
  writeFileSync(join(root, 'dir', 'b.txt'), 'beta\n');
  writeFileSync(join(root, 'dir', 'sub', 'c.txt'), 'gamma\n');
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\necho hi\n');
  if (POSIX) chmodSync(join(root, 'run.sh'), 0o755);
  return { base, root, store, txn, outside: join(base, 'outside') };
}

const changes = (d: any) => d.entries.map((e: any) => [e.key, e.change]).sort((x: any, y: any) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
/** Roll back the chosen entry deltas (all by default) to the state before, and verify. */
function rollBack(f: ReturnType<typeof fixture>, pre: any, post: any, pick: (e: any) => boolean = () => true, faults: any = {}) {
  const d = diffSnapshots(pre, post);
  const plan = planRollback({ root: f.root, pre, post, entries: d.entries.filter(pick).map((e: any) => e.key), refs: d.refs });
  applyRollback({ root: f.root, store: f.store, plan, txnDir: f.txn, faults });
  return { plan, verified: verifyRollback({ root: f.root, store: f.store, post, plan }) };
}

describe('a workspace snapshot', () => {
  it('records every entry by type, mode, content digest and symlink target, keeps the bytes once per digest, and is stable', async () => {
    const f = fixture();
    symlinkSync('a.txt', join(f.root, 'link'));
    // Past the racy window: a file changed in the same clock tick as a read is never trusted from the cache.
    await new Promise((r) => setTimeout(r, 150));
    const one = captureSnapshot({ root: f.root, store: f.store });
    const two = captureSnapshot({ root: f.root, store: f.store });
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(two.digest).toBe(one.digest);
    expect(one.entries['a.txt']).toMatchObject({ t: 'f', size: 6, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(one.entries['dir']).toMatchObject({ t: 'd' });
    expect(one.entries['dir/sub/c.txt']).toMatchObject({ t: 'f' });
    expect(one.entries['link']).toMatchObject({ t: 'l', target: 'a.txt' });
    if (POSIX) expect(one.entries['run.sh'].mode).toBe(0o755);
    // The bytes are in the store under their digest.
    const sha = one.entries['a.txt'].sha256;
    expect(readFileSync(join(f.store, 'objects', sha.slice(0, 2), sha), 'utf8')).toBe('alpha\n');
    // A previous snapshot is a stat cache: nothing unchanged is read again.
    const three = captureSnapshot({ root: f.root, store: f.store, previous: two });
    expect(three.stats.hashed).toBe(0);
    writeFileSync(join(f.root, 'dir', 'b.txt'), 'beta two\n');
    const four = captureSnapshot({ root: f.root, store: f.store, previous: three });
    expect(four.stats.hashed).toBe(1);
    expect(four.digest).not.toBe(three.digest);
  });

  it('leaves out Git object stores and reflogs, and never follows a symlink into a directory', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'repo', '.git', 'objects', 'ab'), { recursive: true });
    writeFileSync(join(f.root, 'repo', '.git', 'objects', 'ab', 'cdef'), 'object');
    mkdirSync(join(f.root, 'repo', '.git', 'logs', 'refs'), { recursive: true });
    writeFileSync(join(f.root, 'repo', '.git', 'logs', 'HEAD'), 'log');
    writeFileSync(join(f.root, 'repo', '.git', 'config'), '[core]\n');
    mkdirSync(f.outside, { recursive: true });
    writeFileSync(join(f.outside, 'secret.txt'), 'outside');
    symlinkSync(f.outside, join(f.root, 'out'), 'dir');
    const s = captureSnapshot({ root: f.root, store: f.store });
    const keys = Object.keys(s.entries);
    expect(keys.some((k) => k.includes('.git/objects') || k.includes('.git/logs'))).toBe(false);
    expect(keys).toContain('repo/.git/config');
    expect(s.entries['out']).toMatchObject({ t: 'l' });
    expect(keys.some((k) => k.startsWith('out/'))).toBe(false);
  });

  it('names every change: created, deleted, modified, renamed, mode, symlink target, type', () => {
    const f = fixture();
    symlinkSync('a.txt', join(f.root, 'link'));
    const pre = captureSnapshot({ root: f.root, store: f.store });
    writeFileSync(join(f.root, 'a.txt'), 'ALPHA\n');
    unlinkSync(join(f.root, 'dir', 'b.txt'));
    writeFileSync(join(f.root, 'gen.py'), 'print(1)\n');
    renameSync(join(f.root, 'dir', 'sub'), join(f.root, 'dir', 'moved'));
    unlinkSync(join(f.root, 'link'));
    symlinkSync('run.sh', join(f.root, 'link'));
    if (POSIX) chmodSync(join(f.root, 'run.sh'), 0o600);
    rmSync(join(f.root, 'dir', 'moved', 'c.txt'));
    mkdirSync(join(f.root, 'dir', 'moved', 'c.txt'));
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const d = diffSnapshots(pre, post);
    expect(changes(d)).toEqual(
      [
        ['a.txt', 'modified'],
        ['dir/b.txt', 'deleted'],
        ['dir/moved', 'created'],
        ['dir/moved/c.txt', 'created'],
        ['dir/sub', 'deleted'],
        ['dir/sub/c.txt', 'deleted'],
        ['gen.py', 'created'],
        ['link', 'target'],
        ...(POSIX ? [['run.sh', 'mode']] : []),
      ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    );
    expect(d.entries.find((e: any) => e.key === 'dir/moved/c.txt').post.t).toBe('d');
  });
});

describe('a rollback', () => {
  it('restores every chosen delta to its bytes, absence, mode and symlink target before the session, and verifies it', () => {
    const f = fixture();
    symlinkSync('a.txt', join(f.root, 'link'));
    const pre = captureSnapshot({ root: f.root, store: f.store });
    writeFileSync(join(f.root, 'a.txt'), 'ALPHA\n');
    unlinkSync(join(f.root, 'dir', 'b.txt'));
    mkdirSync(join(f.root, 'tools', 'deep'), { recursive: true });
    writeFileSync(join(f.root, 'tools', 'deep', 'gen.py'), 'open("x","w")\n');
    renameSync(join(f.root, 'dir', 'sub'), join(f.root, 'dir', 'moved'));
    unlinkSync(join(f.root, 'link'));
    symlinkSync('run.sh', join(f.root, 'link'));
    if (POSIX) chmodSync(join(f.root, 'run.sh'), 0o600);
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const { plan, verified } = rollBack(f, pre, post);
    expect(verified.ok, JSON.stringify(verified.mismatches)).toBe(true);
    expect(captureSnapshot({ root: f.root, store: f.store }).digest).toBe(pre.digest);
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(readFileSync(join(f.root, 'dir', 'sub', 'c.txt'), 'utf8')).toBe('gamma\n');
    expect(existsSync(join(f.root, 'tools'))).toBe(false);
    expect(readlinkSync(join(f.root, 'link'))).toBe('a.txt');
    if (POSIX) expect(statSync(join(f.root, 'run.sh')).mode & 0o777).toBe(0o755);
    // The plan is durable and names itself by its digest.
    expect(plan.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loadPlan(f.txn).sha256).toBe(plan.sha256);
  });

  it('touches nothing it was not given: the deltas kept stay exactly as the session left them', () => {
    const f = fixture();
    const pre = captureSnapshot({ root: f.root, store: f.store });
    writeFileSync(join(f.root, 'a.txt'), 'kept by the core\n');
    writeFileSync(join(f.root, 'gen.py'), 'print(1)\n');
    unlinkSync(join(f.root, 'dir', 'b.txt'));
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const { verified } = rollBack(f, pre, post, (e) => e.key !== 'a.txt');
    expect(verified.ok, JSON.stringify(verified.mismatches)).toBe(true);
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('kept by the core\n');
    expect(existsSync(join(f.root, 'gen.py'))).toBe(false);
    expect(readFileSync(join(f.root, 'dir', 'b.txt'), 'utf8')).toBe('beta\n');
  });

  it('a crash in the middle is finished by running it again; a third run changes nothing', () => {
    const f = fixture();
    const pre = captureSnapshot({ root: f.root, store: f.store });
    for (const n of ['x', 'y', 'z']) writeFileSync(join(f.root, `${n}.txt`), n);
    writeFileSync(join(f.root, 'a.txt'), 'changed');
    unlinkSync(join(f.root, 'dir', 'sub', 'c.txt'));
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const d = diffSnapshots(pre, post);
    const plan = planRollback({ root: f.root, pre, post, entries: d.entries.map((e: any) => e.key), refs: d.refs });
    expect(() => applyRollback({ root: f.root, store: f.store, plan, txnDir: f.txn, faults: { crashAfterSteps: 2 } })).toThrow(/injected crash/);
    // Half done: some steps applied, not all.
    const half = captureSnapshot({ root: f.root, store: f.store });
    expect(half.digest).not.toBe(pre.digest);
    expect(half.digest).not.toBe(post.digest);
    // The retry reads the durable plan and finishes; already-applied steps are recognised, not redone.
    const again = applyRollback({ root: f.root, store: f.store, plan: loadPlan(f.txn), txnDir: f.txn });
    expect(again.skipped).toBeGreaterThanOrEqual(2);
    expect(verifyRollback({ root: f.root, store: f.store, post, plan }).ok).toBe(true);
    expect(captureSnapshot({ root: f.root, store: f.store }).digest).toBe(pre.digest);
    const third = applyRollback({ root: f.root, store: f.store, plan: loadPlan(f.txn), txnDir: f.txn });
    expect(third.applied).toBe(0);
    expect(captureSnapshot({ root: f.root, store: f.store }).digest).toBe(pre.digest);
  });

  it('refuses a path that changed again after the snapshot it planned from (TOCTOU), touching nothing', () => {
    const f = fixture();
    const pre = captureSnapshot({ root: f.root, store: f.store });
    writeFileSync(join(f.root, 'gen.py'), 'one\n');
    writeFileSync(join(f.root, 'a.txt'), 'changed\n');
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const d = diffSnapshots(pre, post);
    const plan = planRollback({ root: f.root, pre, post, entries: d.entries.map((e: any) => e.key), refs: [] });
    // Something changed it after the snapshot: the rollback must not remove or overwrite what it never saw.
    writeFileSync(join(f.root, 'gen.py'), 'two\n');
    expect(() => applyRollback({ root: f.root, store: f.store, plan, txnDir: f.txn })).toThrow(RollbackConflict);
    expect(readFileSync(join(f.root, 'gen.py'), 'utf8')).toBe('two\n');
    // A fresh snapshot and a new plan finish it.
    const later = captureSnapshot({ root: f.root, store: f.store, previous: post });
    const d2 = diffSnapshots(pre, later);
    const plan2 = planRollback({ root: f.root, pre, post: later, entries: d2.entries.map((e: any) => e.key), refs: [] });
    applyRollback({ root: f.root, store: f.store, plan: plan2, txnDir: join(f.txn, '2') });
    expect(verifyRollback({ root: f.root, store: f.store, post: later, plan: plan2 }).ok).toBe(true);
    expect(captureSnapshot({ root: f.root, store: f.store }).digest).toBe(pre.digest);
  });

  it('a directory swapped for a symlink to outside the workspace is replaced, and nothing outside is written', () => {
    const f = fixture();
    mkdirSync(f.outside, { recursive: true });
    writeFileSync(join(f.outside, 'b.txt'), 'outside\n');
    const pre = captureSnapshot({ root: f.root, store: f.store });
    rmSync(join(f.root, 'dir'), { recursive: true });
    symlinkSync(f.outside, join(f.root, 'dir'), 'dir');
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    expect(diffSnapshots(pre, post).entries.find((e: any) => e.key === 'dir').change).toBe('type');
    const { verified } = rollBack(f, pre, post);
    expect(verified.ok, JSON.stringify(verified.mismatches)).toBe(true);
    expect(lstatSync(join(f.root, 'dir')).isDirectory()).toBe(true);
    expect(readFileSync(join(f.root, 'dir', 'b.txt'), 'utf8')).toBe('beta\n');
    // The directory the symlink pointed at is as it was.
    expect(readFileSync(join(f.outside, 'b.txt'), 'utf8')).toBe('outside\n');
    expect(existsSync(join(f.outside, 'sub'))).toBe(false);
  });

  it.runIf(POSIX)('a directory made unreadable is restored with what it held; a FIFO is removed without ever being opened', () => {
    const f = fixture();
    const pre = captureSnapshot({ root: f.root, store: f.store });
    writeFileSync(join(f.root, 'dir', 'planted.txt'), 'planted\n');
    chmodSync(join(f.root, 'dir'), 0o000);
    const fifo = join(f.root, 'pipe');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    let post: any;
    try {
      post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
      expect(post.entries['dir']).toMatchObject({ unreadable: true, mode: 0 });
      expect(post.entries['pipe']).toMatchObject({ t: 'o' });
      // Restore the mode first; what the directory held shows in the next round.
      let snapshot = post;
      for (let round = 0; round < 3; round++) {
        const d = diffSnapshots(pre, snapshot);
        if (d.entries.length === 0) break;
        const plan = planRollback({ root: f.root, pre, post: snapshot, entries: d.entries.map((e: any) => e.key), refs: [] });
        applyRollback({ root: f.root, store: f.store, plan, txnDir: join(f.txn, String(round)) });
        snapshot = captureSnapshot({ root: f.root, store: f.store, previous: snapshot });
      }
      expect(snapshot.digest).toBe(pre.digest);
      expect(existsSync(join(f.root, 'dir', 'planted.txt'))).toBe(false);
      expect(existsSync(fifo)).toBe(false);
    } finally {
      try {
        chmodSync(join(f.root, 'dir'), 0o755);
      } catch {
        // restored already
      }
    }
  });
});

describe('hostile file names', () => {
  const NAMES = ['-rf', 'a b', "quote'", '$(touch pwned)', 'ünïcode', '..x', ...(POSIX ? ['dq"', 'new\nline', 'back\\slash', 'tab\there', '\u001b[31mred'] : [])];

  it('every name round-trips through snapshot, diff and rollback, created or deleted', () => {
    const f = fixture();
    for (const [i, n] of NAMES.entries()) if (i % 2 === 0) writeFileSync(join(f.root, 'dir', n), `kept ${i}`);
    const pre = captureSnapshot({ root: f.root, store: f.store });
    for (const [i, n] of NAMES.entries()) {
      if (i % 2 === 0) unlinkSync(join(f.root, 'dir', n));
      else writeFileSync(join(f.root, 'dir', n), `planted ${i}`);
    }
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    expect(diffSnapshots(pre, post).entries).toHaveLength(NAMES.length);
    const { verified } = rollBack(f, pre, post);
    expect(verified.ok, JSON.stringify(verified.mismatches)).toBe(true);
    expect(captureSnapshot({ root: f.root, store: f.store }).digest).toBe(pre.digest);
    expect(existsSync(join(f.root, 'pwned'))).toBe(false);
  });

  it.runIf(LINUX)('a name that is not UTF-8 is kept by its bytes', () => {
    const f = fixture();
    const pre = captureSnapshot({ root: f.root, store: f.store });
    const name = Buffer.concat([Buffer.from(join(f.root, 'dir') + '/'), Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe])]);
    writeFileSync(name, 'planted');
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const [delta] = diffSnapshots(pre, post).entries;
    expect(keyBytes(delta.key)).toEqual(Buffer.from([0x64, 0x69, 0x72, 0x2f, 0x62, 0x61, 0x64, 0xff, 0xfe]));
    expect(relKey(keyBytes(delta.key))).toBe(delta.key);
    // Shown escaped, never raw.
    expect(showKey(delta.key)).toBe('dir/bad\\xff\\xfe');
    const { verified } = rollBack(f, pre, post);
    expect(verified.ok).toBe(true);
    expect(existsSync(name)).toBe(false);
  });

  it('a name is shown with its control characters escaped and its length capped', () => {
    expect(showKey('dir/new\nline\u001b[31m')).toBe('dir/new\\nline\\x1b[31m');
    expect(showKey('x'.repeat(500)).length).toBeLessThanOrEqual(161);
  });
});

describe("Git state, read without running git", () => {
  const g = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.invalid', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  function repo() {
    const f = fixture();
    const r = join(f.root, 'repos', 'x');
    mkdirSync(r, { recursive: true });
    g(r, ['init', '-q', '-b', 'main']);
    writeFileSync(join(r, 'src.txt'), 'one\n');
    g(r, ['add', 'src.txt']);
    g(r, ['commit', '-q', '-m', 'one']);
    return { ...f, r };
  }

  it('reads refs (loose and packed) and what each index stages; a status that only refreshes stat data changes nothing', () => {
    const f = repo();
    g(f.r, ['branch', 'side']);
    g(f.r, ['pack-refs', '--all']);
    g(f.r, ['branch', 'loose']);
    const pre = captureSnapshot({ root: f.root, store: f.store });
    const head = g(f.r, ['rev-parse', 'main']);
    expect(pre.git['repos/x/.git'].refs).toMatchObject({ 'refs/heads/main': head, 'refs/heads/side': head, 'refs/heads/loose': head });
    expect(pre.indexes['repos/x/.git/index']).toMatch(/^[0-9a-f]{64}$/);
    expect(indexSemantics(readFileSync(join(f.r, '.git', 'index')))).toBe(pre.indexes['repos/x/.git/index']);
    // Touch the file and refresh the index: its bytes change, what it stages does not.
    writeFileSync(join(f.r, 'src.txt'), 'one\n');
    g(f.r, ['status', '--porcelain']);
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    expect(diffSnapshots(pre, post)).toMatchObject({ entries: [], refs: [] });
  });

  it("a controller's git add, commit and new branch are rolled back: refs, index and files, the objects left alone", () => {
    const f = repo();
    const before = g(f.r, ['rev-parse', 'main']);
    const pre = captureSnapshot({ root: f.root, store: f.store });
    writeFileSync(join(f.r, 'src.txt'), 'two\n');
    writeFileSync(join(f.r, 'new.txt'), 'new\n');
    g(f.r, ['add', '-A']);
    g(f.r, ['commit', '-q', '-m', 'controller commit']);
    g(f.r, ['branch', 'evil']);
    const forged = g(f.r, ['rev-parse', 'main']);
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const d = diffSnapshots(pre, post);
    expect(d.refs.map((r: any) => [r.ref, r.pre, r.post]).sort()).toEqual([
      ['refs/heads/evil', null, forged],
      ['refs/heads/main', before, forged],
    ]);
    expect(changes(d)).toEqual([
      ['repos/x/.git/index', 'modified'],
      ['repos/x/new.txt', 'created'],
      ['repos/x/src.txt', 'modified'],
    ]);
    const { verified } = rollBack(f, pre, post);
    expect(verified.ok, JSON.stringify(verified.mismatches)).toBe(true);
    expect(g(f.r, ['rev-parse', 'main'])).toBe(before);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/evil'], { cwd: f.r }).status).not.toBe(0);
    expect(g(f.r, ['status', '--porcelain'])).toBe('');
    // The forged commit is still an object (append-only), just unreachable.
    expect(g(f.r, ['cat-file', '-t', forged])).toBe('commit');
  });

  // CSET-203 r12: the stash's reflog is the stash (one line per entry); a reflog is otherwise append-only and left out.
  it('reads the stash’s reflog as the stash (its bytes kept), and a worktree’s own refs as `worktrees/<name>/refs/...`', () => {
    const f = repo();
    const pre = captureSnapshot({ root: f.root, store: f.store });
    expect(pre.git['repos/x/.git'].stash_log).toBeUndefined();
    writeFileSync(join(f.r, 'src.txt'), 'draft\n');
    g(f.r, ['stash', 'push', '-q', '-m', 'draft']);
    g(f.r, ['worktree', 'add', '-q', '-b', 'wt-branch', join(f.root, 'wt')]);
    g(join(f.root, 'wt'), ['update-ref', 'refs/bisect/bad', 'HEAD']);
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const log = readFileSync(join(f.r, '.git', 'logs', 'refs', 'stash'));
    expect(post.git['repos/x/.git'].stash_log).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), size: log.length });
    expect(readFileSync(join(f.store, 'objects', post.git['repos/x/.git'].stash_log.sha256.slice(0, 2), post.git['repos/x/.git'].stash_log.sha256))).toEqual(log);
    expect(post.git['repos/x/.git'].refs['worktrees/wt/refs/bisect/bad']).toBe(g(f.r, ['rev-parse', 'main']));
    const d = diffSnapshots(pre, post);
    expect(d.reflogs).toEqual([{ git: 'repos/x/.git', ref: 'refs/stash', pre: null, post: post.git['repos/x/.git'].stash_log }]);
    // The reflog alone differing is another state of the workspace.
    writeFileSync(join(f.r, '.git', 'logs', 'refs', 'stash'), Buffer.concat([log, log]));
    const again = captureSnapshot({ root: f.root, store: f.store, previous: post });
    expect(again.digest).not.toBe(post.digest);
    expect(diffSnapshots(post, again)).toMatchObject({ entries: [], refs: [], reflogs: [{ git: 'repos/x/.git', ref: 'refs/stash' }] });
  });

  it('a stash the controller made on top of the user’s goes back: the ref and the reflog byte for byte', () => {
    const f = repo();
    writeFileSync(join(f.r, 'src.txt'), 'user\n');
    g(f.r, ['stash', 'push', '-q', '-m', 'user wip']);
    const userRef = g(f.r, ['rev-parse', 'refs/stash']);
    const userLog = readFileSync(join(f.r, '.git', 'logs', 'refs', 'stash'));
    const pre = captureSnapshot({ root: f.root, store: f.store });
    writeFileSync(join(f.r, 'src.txt'), 'mine\n');
    g(f.r, ['stash', 'push', '-q', '-m', 'controller']);
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const d = diffSnapshots(pre, post);
    expect(d.refs.map((r: any) => r.ref)).toEqual(['refs/stash']);
    const plan = planRollback({ root: f.root, pre, post, entries: [], refs: d.refs, reflogs: d.reflogs.map((r: any) => ({ git: r.git, ref: r.ref, from: r.post?.sha256 ?? null, to: r.pre?.sha256 ?? null })) });
    applyRollback({ root: f.root, store: f.store, plan, txnDir: f.txn });
    const v = verifyRollback({ root: f.root, store: f.store, post, plan });
    expect(v.ok, JSON.stringify(v.mismatches)).toBe(true);
    expect(g(f.r, ['rev-parse', 'refs/stash'])).toBe(userRef);
    expect(readFileSync(join(f.r, '.git', 'logs', 'refs', 'stash'))).toEqual(userLog);
    expect(g(f.r, ['stash', 'list', '--format=%s'])).toBe('On main: user wip');
  });

  it('a stash made where there was none goes back to none: ref and reflog gone', () => {
    const f = repo();
    const pre = captureSnapshot({ root: f.root, store: f.store });
    writeFileSync(join(f.r, 'src.txt'), 'mine\n');
    g(f.r, ['stash', 'push', '-q']);
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const d = diffSnapshots(pre, post);
    const plan = planRollback({ root: f.root, pre, post, entries: [], refs: d.refs, reflogs: d.reflogs.map((r: any) => ({ git: r.git, ref: r.ref, from: r.post?.sha256 ?? null, to: null })) });
    applyRollback({ root: f.root, store: f.store, plan, txnDir: f.txn });
    expect(verifyRollback({ root: f.root, store: f.store, post, plan }).ok).toBe(true);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/stash'], { cwd: f.r }).status).not.toBe(0);
    expect(existsSync(join(f.r, '.git', 'logs', 'refs', 'stash'))).toBe(false);
  });

  it('a reflog changed again after the snapshot it was planned from is a conflict, touching nothing', () => {
    const f = repo();
    writeFileSync(join(f.r, 'src.txt'), 'user\n');
    g(f.r, ['stash', 'push', '-q', '-m', 'user wip']);
    const pre = captureSnapshot({ root: f.root, store: f.store });
    const userLog = readFileSync(join(f.r, '.git', 'logs', 'refs', 'stash'));
    // Only the reflog is rewritten (an entry's line edited), the ref stays.
    writeFileSync(join(f.r, '.git', 'logs', 'refs', 'stash'), Buffer.concat([userLog, Buffer.from(userLog.toString('latin1').split('\n')[0] + '\n', 'latin1')]));
    const post = captureSnapshot({ root: f.root, store: f.store, previous: pre });
    const d = diffSnapshots(pre, post);
    expect(d.refs).toEqual([]);
    expect(d.reflogs).toHaveLength(1);
    const plan = planRollback({ root: f.root, pre, post, entries: [], refs: [], reflogs: [{ git: 'repos/x/.git', ref: 'refs/stash', from: d.reflogs[0].post.sha256, to: d.reflogs[0].pre.sha256 }] });
    writeFileSync(join(f.r, '.git', 'logs', 'refs', 'stash'), 'changed again\n');
    expect(() => applyRollback({ root: f.root, store: f.store, plan, txnDir: f.txn })).toThrow(RollbackConflict);
    expect(readFileSync(join(f.r, '.git', 'logs', 'refs', 'stash'), 'utf8')).toBe('changed again\n');
  });
});

describe('workspace keys, however a path is spelled', () => {
  it('keys a path under the real place of a workspace handed over through a link (macOS /var, a junction) as the same path; outside both, nothing', () => {
    const base = makeTmpDir('ws-key-');
    const real = join(base, 'workspace');
    mkdirSync(join(real, 'repos', 'x', '.git'), { recursive: true });
    const handed = linkedAlias(real, 'workspace');
    const canonical = realpathSync.native(real);
    expect(workspaceKey(handed, join(handed, 'repos', 'x', '.git'))).toBe('repos/x/.git');
    expect(workspaceKey(handed, join(canonical, 'repos', 'x', '.git'))).toBe('repos/x/.git');
    expect(workspaceKey(handed, canonical)).toBe('');
    expect(workspaceKey(handed, join(base, 'elsewhere'))).toBeNull();
    expect(workspaceKey(handed, join(canonical, '..', 'elsewhere'))).toBeNull();
  });
});
