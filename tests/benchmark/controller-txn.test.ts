/**
 * A with-arm controller session as a transaction over the workspace
 * (CSET-203 r9). Before the session the workspace is snapshotted; after it,
 * every change is attributed: the controller's own documents (PRD, graph,
 * plan, contracts) and its control-repository commits are its to make;
 * what Mycelink's core made is attested by the core's provenance ledger;
 * a module-worker's worktree is the worker's unless the controller reached
 * into it. Everything else — a Mycelink-managed file the core did not write
 * as it is, a helper script, a product file, a ref or an index no core
 * command moved — is the controller's direct change: a violation, rolled
 * back to the state before the session (or the state the core last attested
 * for it) without touching what the core or a worker did. When the core
 * wrote after such a change and may have consumed it, the whole session is
 * rolled back instead. The rollback is verified, journaled and resumable,
 * and what it restored is named without the content the controller wrote.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { attestRollbacks, beginTransaction, classifyTransaction, lightCheck, noteHarnessChange, resumeTransaction, rollbackManifestDigest, settleTransaction } from '../../evals-public-projects/lib/controller-txn.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { injectConcurrentCommit } from '../../evals-public-projects/lib/faults.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { captureSnapshot } from '../../evals-public-projects/lib/snapshot.mjs';

afterAll(() => cleanupTmpRoots());

const POSIX = process.platform !== 'win32';
const BIN = resolve(process.cwd(), 'bin', 'mycelink.mjs');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.invalid', GIT_CONFIG_NOSYSTEM: '1' };
const g = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();

/** A workspace: a control repository (`platform/`, its approved requirement committed) and a product repository (`repos/x`). */
function workspace() {
  const base = makeTmpDir('ctl-txn-');
  const ws = join(base, 'workspace');
  const platform = join(ws, 'platform');
  const repo = join(ws, 'repos', 'x');
  mkdirSync(join(platform, 'requirements'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  g(platform, ['init', '-q', '-b', 'main']);
  writeFileSync(join(platform, 'requirements', 'F-1.md'), '# F-1\n\n## Acceptance criteria\n\n**AC-1 — it works.** It works.\n');
  writeFileSync(join(platform, 'repositories.yaml'), 'schema_version: 1\nrepositories:\n  - name: x\n    path: ../repos/x\n    base_branch: main\n    commands:\n      test: [node, --test]\n');
  g(platform, ['add', '-A']);
  g(platform, ['commit', '-q', '-m', 'approved requirement']);
  g(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'start']);
  const ledger = join(base, 'home', '.mycelink-provenance');
  return { base, ws, platform, repo, ledger, store: join(base, 'txn', 'objects'), txn: (n: number) => join(base, 'txn', `session-${n}`) };
}

/** Mycelink's core, through the shipped CLI, its ledger on. */
function core(w: ReturnType<typeof workspace>, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: w.ws, env: { ...gitEnv, MYCELINK_PROVENANCE: w.ledger }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`mycelink ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const key = (w: ReturnType<typeof workspace>) => JSON.parse(core(w, ['controller', 'open', '--control-root', w.platform, '--json'])).authority;
const begin = (w: ReturnType<typeof workspace>, n = 1, previous: any = null) => beginTransaction({ workspace: w.ws, txnDir: w.txn(n), store: w.store, ledgerDir: w.ledger, index: n, previous });
const kinds = (r: any) => r.unauthorized.map((d: any) => [d.path, d.change, d.category]).sort();
const later = () => new Promise((r) => setTimeout(r, 30));

describe('who changed what in a controller session', () => {
  it('r9: the core initialises the control plane; the controller generates ACCEPTANCE.json with a helper script of its own — both are its violation, rolled back; what the core made stays', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    const authority = key(w);
    await later();
    // The controller's own helper, run outside Mycelink: the PreToolUse fence never saw what it wrote.
    writeFileSync(join(w.platform, 'gen.py'), "import json\nopen('features/F-1/ACCEPTANCE.json','w').write(json.dumps({}))\n");
    mkdirSync(join(w.platform, 'features', 'F-1'), { recursive: true });
    writeFileSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'), '{"forged":true}\n');
    const r = settleTransaction({ txn });
    expect(r.violation).toBe(true);
    expect(r.mode).toBe('selective');
    expect(kinds(r)).toEqual([
      ['platform/features/F-1/ACCEPTANCE.json', 'created', 'mycelink-state'],
      ['platform/gen.py', 'created', 'scratch'],
    ]);
    // The feature directory itself is the controller's to make (its PRD goes there).
    expect(r.authorized.find((d: any) => d.path === 'platform/features/F-1')).toMatchObject({ by: 'authoring' });
    expect(r.rollback).toMatchObject({ verified: true, mode: 'selective', removed: ['platform/features/F-1/ACCEPTANCE.json', 'platform/gen.py'], restored: [] });
    expect(r.rollback.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.rollback.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(w.platform, 'gen.py'))).toBe(false);
    expect(existsSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'))).toBe(false);
    // The core's init and key are as the core left them.
    expect(existsSync(join(w.platform, 'mycelink.config.json'))).toBe(true);
    expect(r.authorized.filter((d: any) => d.by === 'core').map((d: any) => d.path)).toEqual(expect.arrayContaining(['platform/mycelink.config.json', 'platform/.mycelink/controller-authority.json']));
    // No content of what the controller wrote is kept on the record: only names, kinds and digests.
    expect(JSON.stringify(r)).not.toContain('forged');
    expect(r.summary.join('\n')).toMatch(/platform\/features\/F-1\/ACCEPTANCE\.json \(created; a Mycelink-managed file\)/);
    // The corrective session starts clean: the core writes the manifest legitimately.
    const next = begin(w, 2, r.snapshot);
    core(w, ['feature', 'acceptance', 'F-1', '--source', 'requirements/F-1.md', '--control-root', w.platform, '--authority', authority, '--json']);
    const clean = settleTransaction({ txn: next });
    expect(clean).toMatchObject({ violation: false, mode: 'none', unauthorized: [] });
    expect(JSON.parse(readFileSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'), 'utf8')).criteria[0].id).toBe('AC-1');
  });

  it('CSET-203 r12: a core write after a forgery is no reason to go back whole — no core step read it: only the forgery goes back', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    await later();
    mkdirSync(join(w.platform, 'features', 'F-1'), { recursive: true });
    writeFileSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'), '{"forged":true}\n');
    await later();
    // The core writes after it (its key), and its ledger says what it read first: never the forged file.
    key(w);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective', ambiguous: [], dependencies: [] });
    expect(kinds(r)).toEqual([['platform/features/F-1/ACCEPTANCE.json', 'created', 'mycelink-state']]);
    expect(r.rollback.verified).toBe(true);
    expect(existsSync(join(w.platform, '.mycelink', 'controller-authority.json'))).toBe(true);
  });

  it('a forgery a core step then read: the session is rebuilt as it stood just before that step — what Mycelink did before it is kept', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    const config = readFileSync(join(w.platform, 'mycelink.config.json'));
    await later();
    // The controller rewrites Mycelink's configuration; the core's next step reads it before it writes.
    writeFileSync(join(w.platform, 'mycelink.config.json'), config.toString('utf8').replace('"schema_version": 1', '"schema_version": 1, "forged": true'));
    await later();
    key(w);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: true, mode: 'full' });
    expect(r.dependencies).toEqual([expect.objectContaining({ path: 'platform/mycelink.config.json', process: 'controller open' })]);
    expect(r.ambiguous).toEqual([expect.stringMatching(/^the core read platform\/mycelink\.config\.json after it changed \(mycelink controller open, pid \d+\)/)]);
    expect(r.rollback).toMatchObject({ verified: true, mode: 'full', reconstruction: { cut: expect.stringMatching(/^\d+$/), removed_zones: [] } });
    // Mycelink's init, before the cut, is kept; the key the read step wrote, after it, is gone; the forgery is undone.
    expect(readFileSync(join(w.platform, 'mycelink.config.json'))).toEqual(config);
    expect(existsSync(join(w.platform, '.mycelink', 'controller-authority.json'))).toBe(false);
    expect(captureSnapshot({ root: w.ws, store: w.store }).digest).not.toBe(txn.pre.digest);
    expect(r.rollback.digest).not.toBe(txn.pre.digest);
  });

  it('a core-managed file the controller deletes, renames, re-modes or replaces with a symlink is restored as the core left it', async () => {
    const w = workspace();
    // A first session: the core makes its files.
    const first = begin(w);
    core(w, ['init', w.platform]);
    const authority = key(w);
    core(w, ['feature', 'acceptance', 'F-1', '--source', 'requirements/F-1.md', '--control-root', w.platform, '--authority', authority, '--json']);
    expect(settleTransaction({ txn: first }).violation).toBe(false);
    const accepted = readFileSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'));
    const config = readFileSync(join(w.platform, 'mycelink.config.json'));
    // The next: the controller's direct changes, as r9's corrective session tried (rm), and more.
    const txn = begin(w, 2, first.snapshot);
    await later();
    unlinkSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'));
    renameSync(join(w.platform, 'mycelink.config.json'), join(w.platform, 'mycelink.config.json.bak'));
    if (POSIX) chmodSync(join(w.platform, 'repositories.yaml'), 0o600);
    symlinkSync('requirements/F-1.md', join(w.platform, 'CLAUDE.md.tmp'));
    rmSync(join(w.platform, 'CLAUDE.md'));
    renameSync(join(w.platform, 'CLAUDE.md.tmp'), join(w.platform, 'CLAUDE.md'));
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective' });
    expect(kinds(r)).toEqual(
      [
        ['platform/CLAUDE.md', 'type', 'control-input'],
        ['platform/features/F-1/ACCEPTANCE.json', 'deleted', 'mycelink-state'],
        ['platform/mycelink.config.json', 'deleted', 'control-input'],
        ['platform/mycelink.config.json.bak', 'created', 'scratch'],
        ...(POSIX ? [['platform/repositories.yaml', 'mode', 'control-input']] : []),
      ].sort(),
    );
    expect(readFileSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'))).toEqual(accepted);
    expect(readFileSync(join(w.platform, 'mycelink.config.json'))).toEqual(config);
    expect(existsSync(join(w.platform, 'mycelink.config.json.bak'))).toBe(false);
    if (POSIX) expect(statSync(join(w.platform, 'repositories.yaml')).mode & 0o777).toBe(0o644);
    expect(r.rollback.restored).toEqual(expect.arrayContaining(['platform/features/F-1/ACCEPTANCE.json', 'platform/mycelink.config.json']));
  });

  it("a controller's git add and commit in a product repository: the branch, index and files go back; a new branch is removed", async () => {
    const w = workspace();
    const before = g(w.repo, ['rev-parse', 'main']);
    const txn = begin(w);
    await later();
    writeFileSync(join(w.repo, 'src', 'a.js'), 'export const a = 2;\n');
    g(w.repo, ['add', '-A']);
    g(w.repo, ['commit', '-q', '-m', 'fix it myself']);
    g(w.repo, ['branch', 'mine']);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective' });
    expect(kinds(r)).toEqual([
      ['repos/x/.git/index', 'modified', 'git'],
      ['repos/x/.git:refs/heads/main', 'ref', 'git-ref'],
      ['repos/x/.git:refs/heads/mine', 'ref', 'git-ref'],
      ['repos/x/src/a.js', 'modified', 'product'],
    ]);
    expect(g(w.repo, ['rev-parse', 'main'])).toBe(before);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/mine'], { cwd: w.repo }).status).not.toBe(0);
    expect(g(w.repo, ['status', '--porcelain'])).toBe('');
    // The commit's id is on the record (not its content), and nothing in the workspace keeps it reachable.
    const forged = r.rollback.refs.find((x: any) => x.ref === 'refs/heads/main').from;
    expect(r.rollback.refs).toEqual([
      { git: 'repos/x/.git', ref: 'refs/heads/main', from: forged, to: before },
      { git: 'repos/x/.git', ref: 'refs/heads/mine', from: forged, to: null },
    ]);
    expect(g(w.repo, ['branch', '--contains', forged])).toBe('');
  });

  it('a controller stopped between its git add and its git commit: no commit to find — the file and the index go back exactly, the branch never moved', async () => {
    // What a check landing mid-command leaves (CI 38510332461): the session stopped after the add, before the commit.
    const w = workspace();
    const before = g(w.repo, ['rev-parse', 'main']);
    const index = readFileSync(join(w.repo, '.git', 'index'));
    const txn = begin(w);
    await later();
    writeFileSync(join(w.repo, 'src', 'a.js'), 'export const a = 2;\n');
    g(w.repo, ['add', '-A']);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective' });
    expect(kinds(r)).toEqual([
      ['repos/x/.git/index', 'modified', 'git'],
      ['repos/x/src/a.js', 'modified', 'product'],
    ]);
    expect(r.rollback).toMatchObject({ verified: true, refs: [] });
    expect(r.rollback.restored).toEqual(expect.arrayContaining(['repos/x/.git/index', 'repos/x/src/a.js']));
    expect(readFileSync(join(w.repo, '.git', 'index')).equals(index)).toBe(true);
    expect(readFileSync(join(w.repo, 'src', 'a.js'), 'utf8')).toBe('export const a = 1;\n');
    expect(g(w.repo, ['rev-parse', 'main'])).toBe(before);
    expect(g(w.repo, ['status', '--porcelain'])).toBe('');
  });

  it('a commit whose branch git keeps in packed-refs alone is the same commit: named by its ref, it goes back with the index and the file', async () => {
    const w = workspace();
    // Before the session and after it, the branch is in packed-refs only: no loose ref file names either commit.
    g(w.repo, ['pack-refs', '--all']);
    const before = g(w.repo, ['rev-parse', 'main']);
    const txn = begin(w);
    await later();
    writeFileSync(join(w.repo, 'src', 'a.js'), 'export const a = 2;\n');
    g(w.repo, ['add', '-A']);
    g(w.repo, ['commit', '-q', '-m', 'fix it myself']);
    const forged = g(w.repo, ['rev-parse', 'main']);
    g(w.repo, ['pack-refs', '--all']);
    expect(existsSync(join(w.repo, '.git', 'refs', 'heads', 'main'))).toBe(false);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: true, mode: 'selective' });
    expect(kinds(r)).toEqual([
      ['repos/x/.git/index', 'modified', 'git'],
      ['repos/x/.git:refs/heads/main', 'ref', 'git-ref'],
      ['repos/x/src/a.js', 'modified', 'product'],
    ]);
    expect(r.summary).toContain(`repos/x/.git:refs/heads/main (moved from ${before.slice(0, 12)} to ${forged.slice(0, 12)}; a product repository's ref)`);
    expect(r.rollback).toMatchObject({ verified: true, refs: [{ git: 'repos/x/.git', ref: 'refs/heads/main', from: forged, to: before }] });
    expect(g(w.repo, ['rev-parse', 'main'])).toBe(before);
    expect(g(w.repo, ['branch', '--contains', forged])).toBe('');
    expect(g(w.repo, ['status', '--porcelain'])).toBe('');
  });

  it('a check while a core git command is still running judges nothing of what that command is writing: a worktree it is checking out is the core’s until it is done', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    await later();
    // The core's `git worktree add` is under way: its intent recorded, no done yet; git has made the worktree's admin
    // directory and is checking its files out while a light check walks the workspace.
    const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
    const wt = join(w.platform, '.mycelink', 'worktrees', 'x__F-1.a.impl');
    const commonDir = join(w.repo, '.git');
    writeFileSync(join(w.ledger, 'ledger.jsonl'), `${JSON.stringify({ kind: 'git-intent', pid: process.pid, seq: 9001, t: now(), sub: 'worktree', cwd: w.repo, common_dir: commonDir, all_refs: false, stash: false })}\n`, { flag: 'a' });
    mkdirSync(join(commonDir, 'worktrees', 'x__F-1.a.impl'), { recursive: true });
    writeFileSync(join(commonDir, 'worktrees', 'x__F-1.a.impl', 'gitdir'), `${join(wt, '.git')}\n`);
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(commonDir, 'worktrees', 'x__F-1.a.impl')}\n`);
    writeFileSync(join(wt, 'src', 'a.js'), 'export const a = 1;\n');
    await later();
    const check = lightCheck({ txn, stream: '' });
    expect(check.unauthorized.map((u: any) => u.path)).toEqual([]);
    // A change of the controller's own beside it is still found.
    writeFileSync(join(w.platform, 'notes.txt'), 'mine\n');
    await later();
    expect(lightCheck({ txn, previous: check.snapshot, stream: '' }).unauthorized.map((u: any) => u.path)).toEqual(['platform/notes.txt']);
  });

  // CI 38690258070 (hosted Windows, Node 22): a settle's capture moves the worker's result slot into a quarantine with one
  // rename. Its intent names the slot and its new place; what the slot held is named by the done, after the call. Checks
  // that walked between the two took what the slot held for the controller's, and stopped the session.
  describe('a result slot a core call is moving into its quarantine', () => {
    const PID = 4_000_001;
    const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
    const dirState = (p: string) => ({ t: 'd', mode: statSync(p).mode & 0o7777 });
    const fileState = (p: string) => ({ t: 'f', sha256: createHash('sha256').update(readFileSync(p)).digest('hex'), size: statSync(p).size, mode: statSync(p).mode & 0o7777, kept: false });
    /** As Mycelink's recorder writes them (src/state/provenance.ts), one record a line. */
    const record = (w: ReturnType<typeof workspace>, r: Record<string, unknown>) => writeFileSync(join(w.ledger, 'ledger.jsonl'), `${JSON.stringify({ pid: PID, t: now(), ...r })}\n`, { flag: 'a' });

    /** A settle under way: its quarantine made, the slot (with its result) renamed into it, the rename's done not yet written. */
    async function moving(opts: { announced?: boolean } = {}) {
      const w = workspace();
      const txn = begin(w);
      core(w, ['init', w.platform]);
      await later();
      const sessions = join(w.platform, 'features', 'F-1', 'sessions');
      const node = join(sessions, 'F-1.a.impl');
      const q = join(node, '.result-quarantine-Ab12Cd');
      const from = join(w.base, 'worktree', '.mycelink-worker');
      mkdirSync(from, { recursive: true });
      writeFileSync(join(from, '.gitignore'), '*\n');
      writeFileSync(join(from, 'result-1.json'), '{"node_id":"F-1.a.impl"}\n');
      if (opts.announced !== false) record(w, { kind: 'proc', schema: 'mycelink-provenance/1', ppid: 1, group: 'settle', sub: 'F-1' });
      mkdirSync(q, { recursive: true });
      record(w, { kind: 'done', seq: 1, op: 'mkdirSync', states: [join(w.platform, 'features', 'F-1'), sessions, node].map((p) => ({ path: p, state: dirState(p) })) });
      record(w, { kind: 'done', seq: 2, op: 'mkdtempSync', states: [{ path: q, state: dirState(q) }] });
      record(w, { kind: 'intent', seq: 3, op: 'renameSync', paths: [from, join(q, 'slot')] });
      renameSync(from, join(q, 'slot'));
      await later();
      return { w, txn, q, slot: join(q, 'slot') };
    }
    const shown = (w: ReturnType<typeof workspace>, p: string) => p.slice(w.ws.length + 1).split('\\').join('/');

    it('is the core’s in every check while that call runs; a lookalike quarantine no core call is moving is the controller’s, never excused by its name', async () => {
      const { w, txn, q, slot } = await moving();
      const first = lightCheck({ txn, stream: '' });
      expect(first.unauthorized.map((u: any) => u.path)).toEqual([]);
      expect(lightCheck({ txn, previous: first.snapshot, stream: '' }).unauthorized.map((u: any) => u.path)).toEqual([]);
      // The controller forges one beside it, under the same name the core uses.
      const forged = join(q, '..', '.result-quarantine-Zz99Yy', 'slot');
      mkdirSync(forged, { recursive: true });
      writeFileSync(join(forged, 'result-1.json'), '{"forged":true}\n');
      await later();
      const third = lightCheck({ txn, previous: first.snapshot, stream: '' });
      expect(third.unauthorized.map((u: any) => u.path).sort()).toEqual(['', '/slot', '/slot/result-1.json'].map((s) => `platform/features/F-1/sessions/F-1.a.impl/.result-quarantine-Zz99Yy${s}`));
      expect(third.unauthorized.some((u: any) => u.path.startsWith(shown(w, slot)))).toBe(false);
    });

    it('once the call is done, what it moved stands as its done attests it: a file of it changed afterwards (swapped) is the controller’s; the core’s cleanup is the core’s', async () => {
      const { w, txn, q, slot } = await moving();
      const moved = [slot, join(slot, '.gitignore'), join(slot, 'result-1.json')];
      record(w, { kind: 'done', seq: 3, op: 'renameSync', states: [{ path: join(w.base, 'worktree', '.mycelink-worker'), state: { t: 'absent' } }, ...moved.map((p) => ({ path: p, state: p === slot ? dirState(p) : fileState(p) }))] });
      await later();
      const done = lightCheck({ txn, stream: '' });
      expect(done.unauthorized.map((u: any) => u.path)).toEqual([]);
      // A path swap after the call, past the racy window a check leaves to the core after its done (RACY_MS): the same
      // name, other bytes.
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(join(slot, 'result-1.json'), '{"swapped":true}\n');
      await later();
      expect(lightCheck({ txn, previous: done.snapshot, stream: '' }).unauthorized.map((u: any) => [u.path, u.category])).toEqual([[shown(w, join(slot, 'result-1.json')), 'mycelink-state']]);
      // The core removes its quarantine, each removal recorded: nothing left to judge.
      [...moved.slice(1), slot, q].forEach((p, i) => {
        const op = p === slot || p === q ? 'rmdirSync' : 'unlinkSync';
        record(w, { kind: 'intent', seq: 10 + i, op, paths: [p] });
        if (op === 'rmdirSync') rmdirSync(p);
        else unlinkSync(p);
        record(w, { kind: 'done', seq: 10 + i, op, states: [{ path: p, state: { t: 'absent' } }] });
      });
      await later();
      expect(settleTransaction({ txn })).toMatchObject({ violation: false, mode: 'none', unauthorized: [] });
    });

    it.each([
      ['its process went on (recorded something else after it)', 'went-on'],
      ['its process never announced itself in this session', 'unannounced'],
    ])('a call whose process is not still inside it is no longer in flight — %s: what it left under its slot is the controller’s', async (_label, how) => {
      const { w, txn, slot } = await moving({ announced: how !== 'unannounced' });
      if (how === 'went-on') record(w, { kind: 'reads', paths: [], git: [] });
      const check = lightCheck({ txn, stream: '' });
      expect(check.unauthorized.map((u: any) => u.path).sort()).toEqual([shown(w, join(slot, '.gitignore')), shown(w, join(slot, 'result-1.json'))]);
    });

    it('residue of a call its process died inside is judged at the settlement, when every process is gone: the slot the intent named is the interrupted core’s, what it held goes back', async () => {
      const { w, txn, q, slot } = await moving();
      const settled = settleTransaction({ txn });
      expect(settled.violation).toBe(true);
      expect(kinds(settled)).toEqual([
        [shown(w, join(slot, '.gitignore')), 'created', 'mycelink-state'],
        [shown(w, join(slot, 'result-1.json')), 'created', 'mycelink-state'],
      ]);
      expect(settled.authorized.find((d: any) => d.path === shown(w, slot))).toMatchObject({ by: 'core-interrupted' });
      expect(settled.authorized.find((d: any) => d.path === shown(w, q))).toMatchObject({ by: 'core' });
      expect(settled.rollback).toMatchObject({ verified: true, mode: 'selective' });
      expect(existsSync(join(slot, 'result-1.json'))).toBe(false);
    });
  });

  // CI 38489750013 (hosted Windows): task sessions stopped for an empty `.git/worktrees`, and for `info/refs`.
  it('what git leaves for itself is no one’s change: `worktrees` left empty after the core’s last worktree went, and `info/refs` an automatic gc wrote — housekeeping, removed, no violation', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    await later();
    // The core's `git worktree add` and `remove` in the product repository, done; git's rmdir of `worktrees` failed.
    const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
    const commonDir = join(w.repo, '.git');
    for (const [kind, extra] of [['git-intent', { cwd: w.repo, all_refs: false, stash: false }], ['git-done', { exit: 0, changed: { refs: {}, files: {}, indexes: {} } }]] as const) {
      writeFileSync(join(w.ledger, 'ledger.jsonl'), `${JSON.stringify({ kind, pid: process.pid, seq: 9002, t: now(), sub: 'worktree', common_dir: commonDir, ...extra })}\n`, { flag: 'a' });
    }
    mkdirSync(join(commonDir, 'worktrees'));
    // An automatic gc in some git command: update-server-info's list of the refs.
    writeFileSync(join(commonDir, 'info', 'refs'), `${g(w.repo, ['rev-parse', 'main'])}\trefs/heads/main\n`);
    // The control repository's is its own Git state, as before (CI 38498972537: housekeeping there made a clean session's
    // settlement selective).
    writeFileSync(join(w.platform, '.git', 'info', 'refs'), `${g(w.platform, ['rev-parse', 'main'])}\trefs/heads/main\n`);
    await later();
    expect(lightCheck({ txn, stream: '' }).unauthorized).toEqual([]);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: false, unauthorized: [] });
    expect(r.authorized.find((d: any) => d.path === 'platform/.git/info/refs')).toMatchObject({ by: 'control-git' });
    expect(r.housekeeping.map((h: any) => h.path).sort()).toEqual(['repos/x/.git/info/refs', 'repos/x/.git/worktrees']);
    expect(existsSync(join(commonDir, 'worktrees'))).toBe(false);
    expect(existsSync(join(commonDir, 'info', 'refs'))).toBe(false);
  });

  it('a lock git left beside what the core made decides nothing: the container is the core’s, the lock housekeeping', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    await later();
    // The core's `git worktree add`, done: the admin directory and its gitdir file, as its record has them; on Windows,
    // a HEAD.lock git could not delete while another handle held it, left beside them.
    const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
    const commonDir = join(w.repo, '.git');
    const admin = join(commonDir, 'worktrees', 'x');
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), 'somewhere/.git\n');
    writeFileSync(join(admin, 'HEAD.lock'), 'ref: refs/heads/main\n');
    const mode = (p: string) => statSync(p).mode & 0o7777;
    const files = {
      [admin]: [{ t: 'absent' }, { t: 'd', mode: mode(admin) }],
      [join(admin, 'gitdir')]: [{ t: 'absent' }, { t: 'f', mode: mode(join(admin, 'gitdir')), sha256: createHash('sha256').update('somewhere/.git\n').digest('hex') }],
    };
    for (const [kind, extra] of [['git-intent', { cwd: w.repo, all_refs: false, stash: false }], ['git-done', { exit: 0, changed: { refs: {}, files, indexes: {} } }]] as const) {
      writeFileSync(join(w.ledger, 'ledger.jsonl'), `${JSON.stringify({ kind, pid: process.pid, seq: 9004, t: now(), sub: 'worktree', common_dir: commonDir, ...extra })}\n`, { flag: 'a' });
    }
    await later();
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: false, unauthorized: [] });
    expect(r.authorized.filter((d: any) => d.path.startsWith('repos/x/.git/worktrees')).map((d: any) => [d.path, d.by]).sort()).toEqual([
      ['repos/x/.git/worktrees', 'core'],
      ['repos/x/.git/worktrees/x', 'core'],
      ['repos/x/.git/worktrees/x/gitdir', 'core'],
    ]);
    expect(r.housekeeping.map((h: any) => h.path)).toEqual(['repos/x/.git/worktrees/x/HEAD.lock']);
    expect(existsSync(join(admin, 'HEAD.lock'))).toBe(false);
    expect(existsSync(join(admin, 'gitdir'))).toBe(true);
  });

  it('an empty directory in a `.git` no core git command ran on, or one with something in it, is still the controller’s', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    await later();
    mkdirSync(join(w.repo, '.git', 'worktrees'));
    await later();
    const r = settleTransaction({ txn });
    expect(r.violation).toBe(true);
    expect(kinds(r)).toEqual([['repos/x/.git/worktrees', 'created', 'git']]);
    expect(existsSync(join(w.repo, '.git', 'worktrees'))).toBe(false);
    // The core ran git there, but the directory holds a file of the controller's.
    const v = workspace();
    const second = begin(v);
    core(v, ['init', v.platform]);
    await later();
    const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
    for (const [kind, extra] of [['git-intent', { cwd: v.repo, all_refs: false, stash: false }], ['git-done', { exit: 0, changed: { refs: {}, files: {}, indexes: {} } }]] as const) {
      writeFileSync(join(v.ledger, 'ledger.jsonl'), `${JSON.stringify({ kind, pid: process.pid, seq: 9003, t: now(), sub: 'worktree', common_dir: join(v.repo, '.git'), ...extra })}\n`, { flag: 'a' });
    }
    mkdirSync(join(v.repo, '.git', 'worktrees'));
    writeFileSync(join(v.repo, '.git', 'worktrees', 'mine'), 'mine\n');
    await later();
    const s = settleTransaction({ txn: second });
    expect(s.violation).toBe(true);
    expect(kinds(s)).toEqual([
      ['repos/x/.git/worktrees', 'created', 'git'],
      ['repos/x/.git/worktrees/mine', 'created', 'git'],
    ]);
    expect(existsSync(join(v.repo, '.git', 'worktrees'))).toBe(false);
  });

  it('a helper process the controller left writing is caught by what it wrote, not by what the transcript says', async () => {
    const w = workspace();
    const txn = begin(w);
    // The path is the helper's argument, never part of its code.
    const helper = spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], '{}'), 150)", join(w.platform, 'features-STATE.json')], { stdio: 'ignore' });
    await new Promise((r) => helper.on('exit', r));
    const r = settleTransaction({ txn });
    expect(kinds(r)).toEqual([['platform/features-STATE.json', 'created', 'scratch']]);
    expect(existsSync(join(w.platform, 'features-STATE.json'))).toBe(false);
  });

  it('what the core attests stays when the controller writes after it; the worker’s worktree is the worker’s; a scratch file goes', async () => {
    const w = workspace();
    const first = begin(w);
    core(w, ['init', w.platform]);
    settleTransaction({ txn: first });
    const txn = begin(w, 2, txnAfter(first));
    // A worker's worktree (a module-worker writes and commits there; Mycelink made it).
    const wt = join(w.platform, '.mycelink', 'worktrees', 'x__F-1.a.impl');
    g(w.repo, ['worktree', 'add', '-q', '-b', 'mycelink/F-1/a', wt]);
    writeFileSync(join(wt, 'src', 'a.js'), 'export const a = 3;\n');
    g(wt, ['commit', '-q', '-am', 'worker commit']);
    mkdirSync(join(wt, '.mycelink-worker'), { recursive: true });
    writeFileSync(join(wt, '.mycelink-worker', 'result-1.json'), '{}');
    // The core settles meanwhile (its ledger attests its writes).
    const authority = key(w);
    core(w, ['feature', 'acceptance', 'F-1', '--source', 'requirements/F-1.md', '--control-root', w.platform, '--authority', authority, '--json']);
    await later();
    writeFileSync(join(w.ws, 'notes.txt'), 'scratch');
    const r = settleTransaction({ txn, worktrees: [wt] });
    expect(r).toMatchObject({ violation: true, mode: 'selective' });
    expect(kinds(r)).toEqual([['notes.txt', 'created', 'scratch']]);
    expect(existsSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'))).toBe(true);
    expect(readFileSync(join(wt, 'src', 'a.js'), 'utf8')).toBe('export const a = 3;\n');
    expect(existsSync(join(wt, '.mycelink-worker', 'result-1.json'))).toBe(true);
    expect(g(w.repo, ['rev-parse', 'mycelink/F-1/a'])).toBe(g(wt, ['rev-parse', 'HEAD']));
  });

  it('a worktree the controller reached into is contaminated: named, and left to the caller to discard through Mycelink', async () => {
    const w = workspace();
    const wt = join(w.platform, '.mycelink', 'worktrees', 'x__F-1.a.impl');
    g(w.repo, ['worktree', 'add', '-q', '-b', 'mycelink/F-1/a', wt]);
    const txn = begin(w);
    writeFileSync(join(wt, '.mycelink-worker-result.json'), '{"outcome":"SUBMITTED"}');
    const r = classifyTransaction({ txn, post: captureSnapshot({ root: w.ws, store: w.store, previous: txn.pre }), reached: [join(wt, '.mycelink-worker-result.json')], worktrees: [wt] });
    expect(r.contaminated).toEqual(['platform/.mycelink/worktrees/x__F-1.a.impl']);
    expect(r.unauthorized.map((d: any) => [d.path, d.category])).toEqual([['platform/.mycelink/worktrees/x__F-1.a.impl/.mycelink-worker-result.json', 'worktree']]);
  });

  it('a ledger the controller cut or rewrote attests nothing: the session is rolled back whole', async () => {
    const w = workspace();
    const first = begin(w);
    core(w, ['init', w.platform]);
    settleTransaction({ txn: first });
    const txn = begin(w, 2, txnAfter(first));
    key(w);
    truncateSync(join(w.ledger, 'ledger.jsonl'), 10);
    const r = settleTransaction({ txn });
    expect(r.ledger.intact).toBe(false);
    expect(r).toMatchObject({ violation: true, mode: 'full' });
    expect(r.ambiguous).toEqual(expect.arrayContaining([expect.stringMatching(/ledger/)]));
  });

  it('a crash in the middle of a rollback is finished by resuming the transaction; resuming again changes nothing', async () => {
    const w = workspace();
    const txn = begin(w);
    await later();
    for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(w.ws, `${n}.py`), n);
    expect(() => settleTransaction({ txn, faults: { crashAfterSteps: 2 } })).toThrow(/injected crash/);
    // Half done: two removed, two still there.
    expect(['a', 'b', 'c', 'd'].filter((n) => existsSync(join(w.ws, `${n}.py`)))).toHaveLength(2);
    const r = resumeTransaction({ txnDir: w.txn(1), store: w.store });
    expect(r).toMatchObject({ violation: true, rollback: { verified: true } });
    for (const n of ['a', 'b', 'c', 'd']) expect(existsSync(join(w.ws, `${n}.py`))).toBe(false);
    const again = resumeTransaction({ txnDir: w.txn(1), store: w.store });
    expect(again.rollback.verified).toBe(true);
    expect(again.rollback.manifest_sha256).toBe(r.rollback.manifest_sha256);
  });

  it('a path changed again while the rollback is planned is snapshotted anew and still rolled back (TOCTOU)', async () => {
    const w = workspace();
    const txn = begin(w);
    await later();
    writeFileSync(join(w.ws, 'gen.py'), 'one');
    const r = settleTransaction({ txn, faults: { beforeApply: () => writeFileSync(join(w.ws, 'gen.py'), 'two') } });
    expect(r.rollback).toMatchObject({ verified: true, rounds: 2 });
    expect(existsSync(join(w.ws, 'gen.py'))).toBe(false);
  });

  it('a whole-session rollback removes a worktree the session made, its admin directory’s reflog with it, and a ref lock a killed git left', async () => {
    const w = workspace();
    const before = g(w.repo, ['rev-parse', 'main']);
    // A first session: the core's ledger holds what it did.
    const first = begin(w);
    core(w, ['init', w.platform]);
    settleTransaction({ txn: first });
    const txn = begin(w, 2, txnAfter(first));
    // A worker's worktree made in the session: git keeps a reflog in its admin directory, which no snapshot holds.
    const wt = join(w.platform, '.mycelink', 'worktrees', 'x__F-1.a.impl');
    g(w.repo, ['worktree', 'add', '-q', '-b', 'wip/F-1/a', wt]);
    expect(existsSync(join(w.repo, '.git', 'worktrees', 'x__F-1.a.impl', 'logs', 'HEAD'))).toBe(true);
    // A git killed with its session, mid-update: the lock beside the ref stays.
    writeFileSync(join(w.repo, '.git', 'refs', 'heads', 'wip', 'F-1', 'b.lock'), `${before}\n`);
    await later();
    mkdirSync(join(w.platform, 'features', 'F-1'), { recursive: true });
    writeFileSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'), '{"forged":true}\n');
    await later();
    key(w);
    // The ledger cut short: nothing the core did is attested, so nothing can be rebuilt either.
    truncateSync(join(w.ledger, 'ledger.jsonl'), 10);
    const r = settleTransaction({ txn, worktrees: [wt] });
    expect(r.rollback).toMatchObject({ reconstruction: null, whole: expect.stringMatching(/ledger/) });
    expect(r).toMatchObject({ violation: true, mode: 'full' });
    expect(r.rollback).toMatchObject({ verified: true, rounds: 1 });
    expect(r.housekeeping).toEqual([expect.objectContaining({ path: 'repos/x/.git/refs/heads/wip/F-1/b.lock', change: 'created' })]);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(w.repo, '.git', 'worktrees', 'x__F-1.a.impl'))).toBe(false);
    expect(existsSync(join(w.repo, '.git', 'refs', 'heads', 'wip', 'F-1', 'b.lock'))).toBe(false);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/wip/F-1/a'], { cwd: w.repo }).status).not.toBe(0);
    expect(g(w.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
    expect(captureSnapshot({ root: w.ws, store: w.store }).digest).toBe(txn.pre.digest);
  });

  it('a check while the session runs reads the ledger after its walk: what the core touched since is no violation, a controller’s change still is', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    await later();
    writeFileSync(join(w.platform, 'gen.py'), 'x');
    const post = captureSnapshot({ root: w.ws, store: w.store, previous: txn.pre });
    // The core goes on after the walk: its key, written since, looks undone to a reading that ignores when.
    key(w);
    const strict = classifyTransaction({ txn, post });
    expect(strict.unauthorized.map((d: any) => [d.path, d.change])).toEqual(expect.arrayContaining([['platform/.mycelink/controller-authority.json', 'deleted']]));
    const light = classifyTransaction({ txn, post, asOf: BigInt(post.started_ms - 100) * 1_000_000n });
    expect(light.unauthorized.map((d: any) => [d.path, d.change])).toEqual([['platform/gen.py', 'created']]);
  });

  it.each([
    ['only the controller’s change goes back', false],
    ['a whole-session rollback keeps it too', true],
  ])('a teammate commit the harness lands while the session runs is the harness’s: %s', async (_label, full) => {
    const w = workspace();
    let txn = begin(w);
    if (full) {
      // A first session: the core's ledger holds what it did.
      core(w, ['init', w.platform]);
      txn = begin(w, 2, settleTransaction({ txn }).snapshot);
    }
    await later();
    // The fault plan's teammate commit: on main, synced into the checkout (its file and the index).
    const r = injectConcurrentCommit({ repo: w.repo, branch: 'main', path: 'TEAM-NOTES.md', content: 'notes\n', message: 'docs: team notes' });
    expect(r.sync).toBe('done');
    noteHarnessChange({ txn, paths: [join(w.repo, '.git', 'index'), join(w.repo, 'TEAM-NOTES.md')], refs: [{ gitDir: join(w.repo, '.git'), ref: 'refs/heads/main', value: r.commit }] });
    await later();
    writeFileSync(join(w.repo, 'src', 'a.js'), 'export const a = 2;\n');
    if (full) {
      await later();
      key(w);
      // A ledger cut short attests nothing: the whole session goes back.
      truncateSync(join(w.ledger, 'ledger.jsonl'), 10);
    }
    const settled = settleTransaction({ txn });
    expect(settled).toMatchObject({ violation: true, mode: full ? 'full' : 'selective', rollback: { verified: true } });
    expect(kinds(settled).filter((k: any) => !k[0].startsWith('platform/'))).toEqual([['repos/x/src/a.js', 'modified', 'product']]);
    expect(settled.authorized.filter((d: any) => d.by === 'harness').map((d: any) => d.path).sort()).toEqual(['repos/x/.git/index', 'repos/x/.git:refs/heads/main', 'repos/x/TEAM-NOTES.md']);
    expect(readFileSync(join(w.repo, 'src', 'a.js'), 'utf8')).toBe('export const a = 1;\n');
    expect(g(w.repo, ['rev-parse', 'main'])).toBe(r.commit);
    expect(readFileSync(join(w.repo, 'TEAM-NOTES.md'), 'utf8')).toBe('notes\n');
    expect(g(w.repo, ['status', '--porcelain'])).toBe('');
    if (full) expect(existsSync(join(w.platform, '.mycelink', 'controller-authority.json'))).toBe(false);
  });

  it('every name is reported escaped, never raw, and the summary is capped', async () => {
    const w = workspace();
    const txn = begin(w);
    await later();
    for (let i = 0; i < 30; i++) writeFileSync(join(w.ws, `f${i}${POSIX ? '\n\u001b[2J' : ''}.txt`), 'x');
    const r = settleTransaction({ txn });
    expect(r.unauthorized).toHaveLength(30);
    expect(r.summary.length).toBeLessThanOrEqual(13);
    expect(r.summary.at(-1)).toMatch(/^and \d+ more$/);
    expect(r.summary.join('\n')).not.toMatch(/\u001b/);
  });
});

/** The snapshot a settled transaction left (its post, or what the rollback verified). */
function txnAfter(settled: any) {
  return settled.snapshot;
}

/** A settled transaction as the run record keeps it on its session (lib/arms.mjs): the transaction's directory, the violation, the manifest's digest. */
function asSession(w: ReturnType<typeof workspace>, settled: any, n: number) {
  const rollback = settled.rollback ? { mode: settled.rollback.mode, verified: settled.rollback.verified, manifest_sha256: settled.rollback.manifest_sha256 ?? null, digest: settled.rollback.digest } : null;
  return {
    index: n,
    controller_txn: { dir: w.txn(n), violation: settled.violation, mode: settled.mode, pre_digest: settled.pre?.digest ?? null, post_digest: settled.post?.digest ?? null, rollback },
    ...(settled.violation ? { violation: { fingerprint: settled.fingerprint, summary: settled.summary, mode: settled.mode, verified: settled.rollback?.verified === true, manifest_sha256: settled.rollback?.manifest_sha256 ?? null, discarded: settled.discarded ?? [] } } : {}),
  };
}

/**
 * Before a run with a controller violation is trusted, its rollback is
 * attested again from the transaction's own files and the workspace as the
 * run left it (CSET-203 r10): the manifest must be the one the record names
 * and verified, its snapshots what it says, and nothing the controller wrote
 * may be left in the final workspace — no byte it wrote, no commit it made
 * reachable — unless a later session's authorised change made the same.
 * A rollback recorded as verified is never taken at its word.
 */
describe('a verified rollback is attested before the run is trusted', () => {
  /** r9's shape: the core initialises; the controller's helper forges ACCEPTANCE.json, flips an index mode bit, leaves a symlink; a corrective session goes through the core. */
  async function r9(w: ReturnType<typeof workspace>) {
    const txn = begin(w);
    core(w, ['init', w.platform]);
    const authority = key(w);
    await later();
    writeFileSync(join(w.platform, 'gen.py'), 'forge\n');
    mkdirSync(join(w.platform, 'features', 'F-1'), { recursive: true });
    writeFileSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'), '{"criteria":[]}');
    g(w.repo, ['update-index', '--chmod=+x', 'src/a.js']);
    if (POSIX) symlinkSync('platform', join(w.ws, 'plat'));
    const first = settleTransaction({ txn });
    expect(first).toMatchObject({ violation: true, mode: 'selective', rollback: { verified: true } });
    const next = begin(w, 2, first.snapshot);
    core(w, ['feature', 'acceptance', 'F-1', '--source', 'requirements/F-1.md', '--control-root', w.platform, '--authority', authority, '--json']);
    const second = settleTransaction({ txn: next });
    expect(second.violation).toBe(false);
    return { first, second, sessions: [asSession(w, first, 1), asSession(w, second, 2)] };
  }
  const attest = (w: ReturnType<typeof workspace>, sessions: any[]) => attestRollbacks({ sessions, workspace: w.ws, store: w.store });

  it('r9: a verified selective rollback, then the core writing the same path legitimately, is attested: nothing the controller wrote is left', async () => {
    const w = workspace();
    const { first, sessions } = await r9(w);
    const a = attest(w, sessions);
    expect(a.problems).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.sessions).toEqual([expect.objectContaining({ session: 1, ok: true, mode: 'selective', manifest_sha256: first.rollback.manifest_sha256 })]);
    expect(a.sessions[0].checked).toBeGreaterThanOrEqual(POSIX ? 4 : 3);
  });

  it('a verified whole-session rollback is attested too', async () => {
    const w = workspace();
    const first = begin(w);
    core(w, ['init', w.platform]);
    const txn = begin(w, 2, settleTransaction({ txn: first }).snapshot);
    await later();
    mkdirSync(join(w.platform, 'features', 'F-1'), { recursive: true });
    writeFileSync(join(w.platform, 'features', 'F-1', 'ACCEPTANCE.json'), '{"forged":true}\n');
    await later();
    key(w);
    truncateSync(join(w.ledger, 'ledger.jsonl'), 10);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ mode: 'full', rollback: { verified: true, reconstruction: null } });
    const a = attest(w, [asSession(w, r, 2)]);
    expect(a.problems).toEqual([]);
    expect(a.sessions).toEqual([expect.objectContaining({ session: 2, ok: true, mode: 'full' })]);
  });

  it('a verified reconstruction is attested too: the forgery is gone, what Mycelink did before the cut stays', async () => {
    const w = workspace();
    const txn = begin(w);
    core(w, ['init', w.platform]);
    const config = readFileSync(join(w.platform, 'mycelink.config.json'), 'utf8');
    await later();
    writeFileSync(join(w.platform, 'mycelink.config.json'), config.replace('"schema_version": 1', '"schema_version": 1, "forged": true'));
    await later();
    key(w);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ mode: 'full', rollback: { verified: true, reconstruction: { cut: expect.any(String) } } });
    const a = attest(w, [asSession(w, r, 1)]);
    expect(a.problems).toEqual([]);
    expect(a.sessions).toEqual([expect.objectContaining({ session: 1, ok: true, mode: 'full' })]);
    // The forgery back where it was: untrusted.
    writeFileSync(join(w.platform, 'mycelink.config.json'), config.replace('"schema_version": 1', '"schema_version": 1, "forged": true'));
    expect(attest(w, [asSession(w, r, 1)]).problems).toEqual([expect.stringMatching(/^session 1: platform\/mycelink\.config\.json is still as the controller left it/)]);
  });

  it('a rollback resumed after a crash is attested by the same manifest', async () => {
    const w = workspace();
    const txn = begin(w);
    await later();
    for (const n of ['a', 'b', 'c']) writeFileSync(join(w.ws, `${n}.py`), n);
    expect(() => settleTransaction({ txn, faults: { crashAfterSteps: 1 } })).toThrow(/injected crash/);
    const r = resumeTransaction({ txnDir: w.txn(1), store: w.store });
    expect(attest(w, [asSession(w, r, 1)]).problems).toEqual([]);
  });

  it('a manifest that is not the one recorded, or whose files were edited, is untrusted', async () => {
    const w = workspace();
    const { sessions } = await r9(w);
    const result = join(w.txn(1), 'result.json');
    const original = readFileSync(result, 'utf8');
    // The record names another manifest.
    const other = structuredClone(sessions);
    other[0].violation!.manifest_sha256 = 'a'.repeat(64);
    expect(attest(w, other).problems.join(' | ')).toMatch(/session 1: its rollback manifest .*is not the one the run recorded/);
    // The manifest's own content edited: a path dropped from what it removed.
    const edited = JSON.parse(original);
    edited.rollback.removed = edited.rollback.removed.filter((p: string) => p !== 'platform/gen.py');
    writeFileSync(result, JSON.stringify(edited));
    expect(attest(w, sessions).problems.join(' | ')).toMatch(/session 1: its rollback manifest does not hash to its digest/);
    // Rewritten consistently but marked unverified: a manifest that says so is untrusted.
    const unverified = JSON.parse(original);
    unverified.rollback.verified = false;
    unverified.rollback.manifest_sha256 = rollbackManifestDigest(unverified);
    writeFileSync(result, JSON.stringify(unverified));
    const u = structuredClone(sessions);
    u[0].violation!.manifest_sha256 = unverified.rollback.manifest_sha256;
    u[0].controller_txn.rollback!.manifest_sha256 = unverified.rollback.manifest_sha256;
    expect(attest(w, u).problems.join(' | ')).toMatch(/session 1: its rollback was not verified/);
    writeFileSync(result, original);
    expect(attest(w, sessions).problems).toEqual([]);
    // The snapshot the manifest rests on edited.
    const postFile = join(w.txn(1), 'post.json');
    const post = JSON.parse(readFileSync(postFile, 'utf8'));
    post.entries['platform/gen.py'].sha256 = 'b'.repeat(64);
    writeFileSync(postFile, JSON.stringify(post));
    expect(attest(w, sessions).problems.join(' | ')).toMatch(/session 1: its post snapshot is not the one its manifest names/);
  });

  it('a missing manifest or transaction is untrusted', async () => {
    const w = workspace();
    const { sessions } = await r9(w);
    const noTxn: any[] = structuredClone(sessions);
    delete noTxn[0].controller_txn;
    expect(attest(w, noTxn)).toMatchObject({ ok: false, problems: [expect.stringMatching(/session 1: its violation has no transaction record/)] });
    rmSync(join(w.txn(1), 'result.json'));
    expect(attest(w, sessions)).toMatchObject({ ok: false, problems: [expect.stringMatching(/session 1: its rollback manifest is missing/)] });
  });

  it('what the controller wrote, still in the workspace after the rollback, is untrusted', async () => {
    const w = workspace();
    const { sessions } = await r9(w);
    // Its helper's bytes back where the rollback removed them, by no session of the run.
    writeFileSync(join(w.platform, 'gen.py'), 'forge\n');
    const a = attest(w, sessions);
    expect(a.ok).toBe(false);
    expect(a.problems).toEqual([expect.stringMatching(/^session 1: platform\/gen\.py is still as the controller left it/)]);
  });

  it('a commit the controller made, reachable again after the rollback, is untrusted; one left unreachable is not', async () => {
    const w = workspace();
    const txn = begin(w);
    await later();
    writeFileSync(join(w.repo, 'src', 'a.js'), 'export const a = 2;\n');
    g(w.repo, ['add', '-A']);
    g(w.repo, ['commit', '-q', '-m', 'fix it myself']);
    const forged = g(w.repo, ['rev-parse', 'HEAD']);
    const r = settleTransaction({ txn });
    expect(r.rollback.verified).toBe(true);
    const sessions = [asSession(w, r, 1)];
    expect(attest(w, sessions).problems).toEqual([]);
    // Mycelink's archive of a discarded dispatch keeps it as evidence, never delivered: quarantined, named, not left.
    const archive = `refs/mycelink/archive/F-1/a/${forged}`;
    g(w.repo, ['update-ref', archive, forged]);
    expect(attest(w, sessions)).toMatchObject({ ok: true, problems: [], sessions: [{ session: 1, ok: true, quarantined: [`${forged.slice(0, 12)} in ${archive}`] }] });
    g(w.repo, ['branch', 'keep', forged]);
    const a = attest(w, sessions);
    expect(a.ok).toBe(false);
    expect(a.problems).toEqual([expect.stringMatching(new RegExp(`^session 1: commit ${forged.slice(0, 12)} the controller made is reachable from refs/heads/keep`))]);
  });

  it('a branch the controller moved onto a commit the workspace already had leaves no commit of its own to find', async () => {
    const w = workspace();
    const start = g(w.repo, ['rev-parse', 'main']);
    writeFileSync(join(w.repo, 'src', 'b.js'), 'export const b = 1;\n');
    g(w.repo, ['add', '-A']);
    g(w.repo, ['commit', '-q', '-m', 'second']);
    g(w.repo, ['branch', 'old', start]);
    const txn = begin(w);
    await later();
    g(w.repo, ['branch', '-f', 'old', 'main']);
    const r = settleTransaction({ txn });
    expect(r).toMatchObject({ violation: true, rollback: { verified: true } });
    expect(attest(w, [asSession(w, r, 1)]).problems).toEqual([]);
  });
});
