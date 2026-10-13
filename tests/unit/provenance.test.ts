/**
 * Mycelink's own account of what it changed (CSET-203 r9): with
 * MYCELINK_PROVENANCE naming a directory, every file the Mycelink process
 * changes through node:fs is recorded in its ledger before the change (an
 * intent: a process killed mid-write still says what it was writing) and
 * after it (the path's state, a file's bytes kept once per digest), and
 * every git command it runs that can change a repository is recorded with
 * the refs, indexes and metadata files it changed. The benchmark's with arm
 * rolls back every change of a controller session that this ledger does not
 * attest; nothing it read, and no argument but the command, is recorded.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { cleanupTmpRoots, linkedAlias, makeTmpDir, windowsShortPathAlias } from '../helpers/tmp.js';
import { installProvenance, readLedger, uninstallProvenance } from '../../src/state/provenance.js';
import { writeDocAtomic } from '../../src/state/atomic-json.js';
import { runGit } from '../../src/git/git.js';
import { canonicalPath } from '../../src/security/paths.js';

afterAll(() => cleanupTmpRoots());
afterEach(() => uninstallProvenance());

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const BIN = resolve(process.cwd(), 'bin', 'mycelink.mjs');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.invalid', GIT_CONFIG_NOSYSTEM: '1' };

function dirs() {
  const base = makeTmpDir('prov-');
  const ledger = join(base, 'ledger');
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  return { base, ledger, work };
}

/** The done states the ledger records for a path (by its canonical name: macOS's temp directory is reached through a link), in order. */
const statesOf = (records: any[], path: string) => records.filter((r) => r.kind === 'done').flatMap((r) => r.states.filter((s: any) => s.path === canonicalPath(path)).map((s: any) => s.state));

/** Every path a ledger names: its changes, their states, its reads, and its git commands' places and files. */
const ledgerPaths = (records: any[]): string[] =>
  records.flatMap((r) => [
    ...(r.paths ?? []).map((p: string | [string, string]) => (Array.isArray(p) ? p[0] : p)),
    ...(r.states ?? []).map((s: any) => s.path),
    ...(r.git ?? []).map((g: any) => g.cwd),
    r.cwd,
    r.common_dir,
    ...Object.keys(r.changed?.files ?? {}),
    ...Object.keys(r.changed?.indexes ?? {}),
  ]).filter((p): p is string => typeof p === 'string');

describe('the provenance ledger, in process', () => {
  it('is off unless the variable names an absolute directory', () => {
    const d = dirs();
    expect(installProvenance(['feature', 'status'], {})).toBe(false);
    expect(installProvenance(['feature', 'status'], { MYCELINK_PROVENANCE: 'relative/dir' })).toBe(false);
    writeFileSync(join(d.work, 'a.txt'), 'x');
    expect(existsSync(d.ledger)).toBe(false);
  });

  it('records each change before and after it: writes, atomic renames, removals, directories, symlinks and modes, with the bytes kept', () => {
    const d = dirs();
    expect(installProvenance(['feature', 'init', 'F-1', '--authority', 'secret-key'], { MYCELINK_PROVENANCE: d.ledger })).toBe(true);
    const state = join(d.work, 'features', 'F-1', 'STATE.json');
    mkdirSync(join(d.work, 'features', 'F-1'), { recursive: true });
    writeDocAtomic(state, { nodes: {} });
    writeFileSync(join(d.work, 'gone.txt'), 'bye');
    unlinkSync(join(d.work, 'gone.txt'));
    mkdirSync(join(d.work, 'tree', 'deep'), { recursive: true });
    writeFileSync(join(d.work, 'tree', 'deep', 'x'), 'x');
    rmSync(join(d.work, 'tree'), { recursive: true, force: true });
    symlinkSync('STATE.json', join(d.work, 'features', 'F-1', 'link'));
    if (process.platform !== 'win32') chmodSync(state, 0o600);
    renameSync(join(d.work, 'features', 'F-1', 'link'), join(d.work, 'features', 'F-1', 'link2'));
    uninstallProvenance();
    const { records, problems } = readLedger(d.ledger);
    expect(problems).toEqual([]);
    // The process says what it is, never its arguments' values.
    expect(records[0]).toMatchObject({ kind: 'proc', pid: process.pid, group: 'feature', sub: 'init' });
    expect(JSON.stringify(records)).not.toContain('secret-key');
    // Every intent is followed by its done.
    const intents = records.filter((r: any) => r.kind === 'intent').map((r: any) => r.seq);
    const dones = records.filter((r: any) => r.kind === 'done').map((r: any) => r.seq);
    expect(dones).toEqual(intents);
    // The state file's last recorded state is what is on disk, its bytes kept.
    const final = statesOf(records, state).at(-1);
    const bytes = readFileSync(state);
    expect(final).toMatchObject({ t: 'f', sha256: sha(bytes), size: bytes.length, kept: true });
    expect(readFileSync(join(d.ledger, 'objects', final.sha256.slice(0, 2), final.sha256))).toEqual(bytes);
    // The temporary file of the atomic write: created, then renamed away.
    const tmp = records.filter((r: any) => r.kind === 'done' && r.op === 'renameSync').flatMap((r: any) => r.states).find((s: any) => s.path !== canonicalPath(state) && s.path.includes('STATE.json'));
    expect(tmp?.state).toEqual({ t: 'absent' });
    expect(statesOf(records, join(d.work, 'gone.txt')).map((s: any) => s.t)).toEqual(['f', 'absent']);
    expect(statesOf(records, join(d.work, 'tree')).at(-1)).toEqual({ t: 'absent', recursive: true });
    expect(statesOf(records, join(d.work, 'tree', 'deep'))[0]).toMatchObject({ t: 'd' });
    // A recursive mkdir records every directory it made, not only the last (Windows answers with a \\?\ path).
    expect(statesOf(records, join(d.work, 'tree'))[0]).toMatchObject({ t: 'd' });
    expect(statesOf(records, join(d.work, 'features', 'F-1', 'link2')).at(-1)).toEqual({ t: 'l', target: 'STATE.json' });
    if (process.platform !== 'win32') expect(statesOf(records, state).at(-1).mode).toBe(0o600);
  });

  it('one call is one change: a node:fs function that reaches another exported one (appendFileSync through writeFileSync; on Node 22, rmSync through its own unlinkSync and rmdirSync) records one intent and one done, and reads nothing for the process', () => {
    const d = dirs();
    installProvenance(['feature', 'init', 'F-1'], { MYCELINK_PROVENANCE: d.ledger });
    appendFileSync(join(d.work, 'log.txt'), 'a\n');
    mkdirSync(join(d.work, 'tree', 'deep'), { recursive: true });
    writeFileSync(join(d.work, 'tree', 'deep', 'x'), 'x');
    rmSync(join(d.work, 'tree'), { recursive: true, force: true });
    writeFileSync(join(d.work, 'after.txt'), 'after');
    uninstallProvenance();
    const { records, problems } = readLedger(d.ledger);
    expect(problems).toEqual([]);
    const intents = records.filter((r: any) => r.kind === 'intent');
    expect(intents.map((r: any) => r.op)).toEqual(['appendFileSync', 'mkdirSync', 'writeFileSync', 'rmSync', 'writeFileSync']);
    expect(records.filter((r: any) => r.kind === 'done').map((r: any) => r.seq)).toEqual(intents.map((r: any) => r.seq));
    // What a call read for itself (Node 22's rimraf: lstat, readdir) is no input the next change rests on.
    expect(records.filter((r: any) => r.kind === 'reads')).toEqual([]);
    expect(statesOf(records, join(d.work, 'log.txt')).at(-1)).toMatchObject({ t: 'f', sha256: sha('a\n') });
    expect(statesOf(records, join(d.work, 'tree')).at(-1)).toEqual({ t: 'absent', recursive: true });
  });

  it('names every path by its real place, however the process spelled it: the file system’s records and git’s agree (macOS reaches /private/var through /var; Windows through junctions)', () => {
    const d = dirs();
    const alias = linkedAlias(d.work, 'work-alias');
    const real = realpathSync.native(d.work);
    const repo = join(alias, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv });
    writeFileSync(join(repo, 'a'), 'a');
    execFileSync('git', ['add', 'a'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'a'], { cwd: repo, env: gitEnv });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    installProvenance(['dispatch', 'F-1'], { MYCELINK_PROVENANCE: d.ledger });
    readFileSync(join(alias, 'repo', 'a'));
    writeFileSync(join(alias, 'notes.txt'), 'n');
    runGit(repo, ['update-ref', 'refs/heads/claim', head]);
    uninstallProvenance();
    const { records } = readLedger(d.ledger);
    const paths = ledgerPaths(records);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p === real || p.startsWith(`${real}${sep}`), p).toBe(true);
    expect(records.find((r: any) => r.kind === 'reads').paths.map((p: [string, string]) => p[0])).toEqual([join(real, 'repo', 'a')]);
    expect(records.find((r: any) => r.kind === 'intent')).toMatchObject({ op: 'writeFileSync', paths: [join(real, 'notes.txt')] });
    expect(records.find((r: any) => r.kind === 'git-intent')).toMatchObject({ cwd: join(real, 'repo'), common_dir: join(real, 'repo', '.git') });
    expect(records.find((r: any) => r.kind === 'git-done')).toMatchObject({ common_dir: join(real, 'repo', '.git'), changed: { refs: { 'refs/heads/claim': [null, head] } } });
  });

  it('names a path reached through a Windows 8.3 short name by its long one, as git does (GitHub runners’ C:\\Users\\RUNNER~1)', (ctx) => {
    const d = dirs();
    const long = join(d.work, 'a long directory name');
    mkdirSync(long);
    const short = windowsShortPathAlias(long);
    if (short === null) return ctx.skip();
    const real = realpathSync.native(long);
    installProvenance(['feature', 'init', 'F-1'], { MYCELINK_PROVENANCE: d.ledger });
    writeFileSync(join(short, 'state.json'), '{}');
    mkdirSync(join(short, 'made'));
    uninstallProvenance();
    const { records } = readLedger(d.ledger);
    expect(records.filter((r: any) => r.kind === 'intent').map((r: any) => r.paths)).toEqual([[join(real, 'state.json')], [join(real, 'made')]]);
    for (const p of ledgerPaths(records)) expect(p.startsWith(`${real}${sep}`), p).toBe(true);
  });

  it('records nothing it only read, and nothing inside its own ledger', () => {
    const d = dirs();
    writeFileSync(join(d.work, 'r.txt'), 'read me');
    installProvenance(['feature', 'status'], { MYCELINK_PROVENANCE: d.ledger });
    readFileSync(join(d.work, 'r.txt'));
    readdirSync(d.work);
    runGit(d.work, ['--version']);
    uninstallProvenance();
    expect(existsSync(join(d.ledger, 'ledger.jsonl'))).toBe(false);
  });

  it('records what a change may rest on: the paths the process read since its last change (never their content), just before the change', () => {
    const d = dirs();
    writeFileSync(join(d.work, 'input.json'), '{"secret":"never-recorded"}');
    mkdirSync(join(d.work, 'features'));
    writeFileSync(join(d.work, 'features', 'F-1'), 'x');
    installProvenance(['feature', 'init', 'F-1'], { MYCELINK_PROVENANCE: d.ledger });
    readFileSync(join(d.work, 'input.json'), 'utf8');
    existsSync(join(d.work, 'missing.txt'));
    readdirSync(join(d.work, 'features'));
    statSync(join(d.work, 'input.json'));
    writeFileSync(join(d.work, 'out.json'), '{}');
    // Nothing read since: the next change rests on nothing new.
    writeFileSync(join(d.work, 'out2.json'), '{}');
    uninstallProvenance();
    const { records } = readLedger(d.ledger);
    const reads = records.filter((r: any) => r.kind === 'reads');
    expect(reads).toHaveLength(1);
    const first = records.findIndex((r: any) => r.kind === 'intent');
    // Recorded before the change that may rest on it, by the process that read.
    expect(records.indexOf(reads[0])).toBe(first - 1);
    expect(reads[0]).toMatchObject({ pid: process.pid });
    expect(reads[0].paths.map((p: [string, string]) => p[0]).sort()).toEqual([join(d.work, 'features'), join(d.work, 'input.json'), join(d.work, 'missing.txt')].map((p) => canonicalPath(p)).sort());
    // Each path with when it was last read, never after the change it precedes.
    for (const [, at] of reads[0].paths) expect(BigInt(at) <= BigInt(records[first].t)).toBe(true);
    expect(JSON.stringify(records)).not.toContain('never-recorded');
  });

  it('the git commands run before a change are recorded with it — where, and whether they could read every ref or the stash; never their arguments', () => {
    const d = dirs();
    const repo = join(d.work, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv });
    writeFileSync(join(repo, 'a'), 'a');
    execFileSync('git', ['add', 'a'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'a'], { cwd: repo, env: gitEnv });
    installProvenance(['dispatch', 'F-1'], { MYCELINK_PROVENANCE: d.ledger });
    runGit(repo, ['rev-parse', 'refs/heads/main']);
    runGit(repo, ['for-each-ref', '--format=%(refname)']);
    runGit(repo, ['log', '--all', '--format=%H', '--grep', 'secret-message']);
    runGit(repo, ['stash', 'list']);
    writeFileSync(join(d.work, 'out.json'), '{}');
    uninstallProvenance();
    const { records } = readLedger(d.ledger);
    const reads = records.filter((r: any) => r.kind === 'reads');
    expect(reads).toHaveLength(1);
    expect(reads[0].git.map((g: any) => [g.sub, g.cwd, g.all_refs, g.stash])).toEqual([
      ['rev-parse', canonicalPath(repo), false, false],
      ['for-each-ref', canonicalPath(repo), true, false],
      ['log', canonicalPath(repo), true, false],
      ['stash', canonicalPath(repo), false, true],
    ]);
    for (const g of reads[0].git) expect(g.t).toMatch(/^\d+$/);
    expect(JSON.stringify(records)).not.toContain('secret-message');
  });

  it('records the refs, indexes and metadata files a git command changed; a read-only one is not recorded', () => {
    const d = dirs();
    const repo = join(d.work, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv });
    writeFileSync(join(repo, 'a'), 'a');
    execFileSync('git', ['add', 'a'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'a'], { cwd: repo, env: gitEnv });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    installProvenance(['dispatch', 'F-1'], { MYCELINK_PROVENANCE: d.ledger });
    runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['update-ref', 'refs/heads/claim', head]);
    runGit(repo, ['config', 'core.autocrlf', 'false']);
    uninstallProvenance();
    const { records } = readLedger(d.ledger);
    const ops = records.filter((r: any) => r.kind === 'git-done');
    expect(ops.map((r: any) => r.sub)).toEqual(['update-ref', 'config']);
    expect(records.filter((r: any) => r.kind === 'git-intent').map((r: any) => r.sub)).toEqual(['update-ref', 'config']);
    expect(ops[0]).toMatchObject({ exit: 0, common_dir: canonicalPath(join(repo, '.git')), changed: { refs: { 'refs/heads/claim': [null, head] }, files: {}, indexes: {} } });
    const config = ops[1].changed.files[canonicalPath(join(repo, '.git', 'config'))];
    expect(config[1]).toMatchObject({ t: 'f', sha256: sha(readFileSync(join(repo, '.git', 'config'))), kept: true });
    expect(config[0].sha256).not.toBe(config[1].sha256);
  });
});

describe('the provenance ledger, through the shipped CLI', () => {
  const cli = (args: string[], env: Record<string, string>, cwd: string) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...gitEnv, ...env }, encoding: 'utf8' });

  it('attests every file `init` writes, exactly as it left it; a status read adds nothing', () => {
    const d = dirs();
    const control = join(d.work, 'platform');
    mkdirSync(control);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: control, env: gitEnv });
    const r = cli(['init', control], { MYCELINK_PROVENANCE: d.ledger }, d.work);
    expect(r.status, r.stderr).toBe(0);
    const { records, problems } = readLedger(d.ledger);
    expect(problems).toEqual([]);
    for (const rel of ['mycelink.config.json', 'repositories.yaml', '.gitignore']) {
      const file = join(control, rel);
      if (!existsSync(file)) continue;
      expect(statesOf(records, file).at(-1), rel).toMatchObject({ t: 'f', sha256: sha(readFileSync(file)) });
    }
    const before = readFileSync(join(d.ledger, 'ledger.jsonl'), 'utf8');
    const s = cli(['doctor', '--control-root', control], { MYCELINK_PROVENANCE: d.ledger }, d.work);
    expect(s.status).not.toBeNull();
    expect(readFileSync(join(d.ledger, 'ledger.jsonl'), 'utf8')).toBe(before);
  });

  it('a process killed between an intent and its change leaves the intent: the change it was making is the core’s', () => {
    const d = dirs();
    const control = join(d.work, 'platform');
    mkdirSync(control);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: control, env: gitEnv });
    const r = cli(['init', control], { MYCELINK_PROVENANCE: d.ledger, MYCELINK_PROVENANCE_CRASH_AFTER_INTENT: '3' }, d.work);
    expect(r.signal ?? r.status).not.toBe(0);
    const { records } = readLedger(d.ledger);
    const intents = records.filter((x: any) => x.kind === 'intent');
    const dones = new Set(records.filter((x: any) => x.kind === 'done').map((x: any) => x.seq));
    expect(intents).toHaveLength(3);
    expect(dones.has(intents[2].seq)).toBe(false);
  });
});
