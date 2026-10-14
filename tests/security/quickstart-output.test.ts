/**
 * The public quickstart's setup (examples/quickstart/setup.mjs) creates its workspace where no one else can have
 * prepared it, and never writes through a link.
 *
 * CodeQL (js/insecure-temporary-file, alert 83) traced setup's default output, the fixed name
 * `<os temp>/mycelink-quickstart`, to the marker write: on a shared temp directory anyone could make that directory
 * (or a link by that name) first, and setup would accept an empty one and fill it with the repositories a later
 * `node --test` and `git` run in. The default is now a fresh directory of its own, and any output directory must be
 * a real directory (no symbolic link or junction), created by setup itself where it did not exist; where POSIX
 * modes apply it must be the user's own, writable by no one else, under ancestors no one else can rename it in. The
 * swaps a racing process would make — the directory replaced by a link just before the marker, or re-made between
 * --force's delete and the re-create — are made deterministic by acting at exactly those operations.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as realFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

type Op = 'openSync' | 'writeFileSync' | 'rmSync' | 'mkdirSync';

const race = vi.hoisted(() => ({
  /** Called once, right before the named operation on a path ending in `suffix` runs. */
  before: null as null | { fn: Op[]; suffix: string; swap: () => void },
  /** Called once, right after the named operation on `path` returns. */
  after: null as null | { fn: Op[]; path: string; swap: () => void },
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const wrap =
    <F extends (...a: never[]) => unknown>(name: Op, real: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      const path = String(args[0]);
      const before = race.before;
      if (before !== null && before.fn.includes(name) && path.endsWith(before.suffix)) {
        race.before = null;
        before.swap();
      }
      const out = real(...args) as ReturnType<F>;
      const after = race.after;
      if (after !== null && after.fn.includes(name) && resolve(path) === resolve(after.path)) {
        race.after = null;
        after.swap();
      }
      return out;
    };
  return {
    ...fs,
    default: fs,
    openSync: wrap('openSync', fs.openSync),
    writeFileSync: wrap('writeFileSync', fs.writeFileSync),
    rmSync: wrap('rmSync', fs.rmSync),
    mkdirSync: wrap('mkdirSync', fs.mkdirSync),
  };
});

// @ts-expect-error -- plain ESM script without type declarations
const quickstart = (await import('../../examples/quickstart/lib/quickstart.mjs')) as {
  MARKER: string;
  QuickstartError: new (message: string) => Error;
  prepareOutput: (out: string, opts?: { force?: boolean }) => string;
  freshTempOutput?: () => string;
};
const { MARKER, QuickstartError, prepareOutput } = quickstart;

afterEach(() => {
  race.before = null;
  race.after = null;
});
afterAll(() => cleanupTmpRoots());

const POSIX = process.platform !== 'win32';
const PRECIOUS = 'a file the attacker wants overwritten\n';
const SETUP = resolve(process.cwd(), 'examples', 'quickstart', 'setup.mjs');

/** A directory link: a junction on Windows (no privilege needed), a symbolic link elsewhere. */
function dirLink(target: string, path: string): void {
  realFs.symlinkSync(target, path, 'junction');
}

function mode(path: string): number {
  return realFs.lstatSync(path).mode & 0o7777;
}

/** A directory holding an earlier quickstart: its marker and a repository directory. */
function earlierWorkspace(dir: string): void {
  realFs.mkdirSync(join(dir, 'orders-api'), { recursive: true });
  realFs.writeFileSync(join(dir, MARKER), '{}\n');
  realFs.writeFileSync(join(dir, 'orders-api', 'keep.txt'), 'kept\n');
}

describe('quickstart setup: the workspace directory', () => {
  it('keeps its refusals: a file, a foreign non-empty directory, an earlier workspace without --force', () => {
    const scratch = makeTmpDir('qs-out-');
    realFs.writeFileSync(join(scratch, 'file'), 'x');
    expect(() => prepareOutput(join(scratch, 'file'))).toThrow(/not a directory/);
    realFs.mkdirSync(join(scratch, 'foreign'));
    realFs.writeFileSync(join(scratch, 'foreign', 'notes.txt'), 'mine');
    expect(() => prepareOutput(join(scratch, 'foreign'), { force: true })).toThrow(/was not created by the quickstart/);
    expect(realFs.readdirSync(join(scratch, 'foreign'))).toEqual(['notes.txt']);
    earlierWorkspace(join(scratch, 'earlier'));
    expect(() => prepareOutput(join(scratch, 'earlier'))).toThrow(/--force/);
    expect(realFs.readFileSync(join(scratch, 'earlier', 'orders-api', 'keep.txt'), 'utf8')).toBe('kept\n');
  });

  it('accepts an empty directory of your own, and recreates an earlier workspace with --force', () => {
    const scratch = makeTmpDir('qs-out-');
    realFs.mkdirSync(join(scratch, 'empty'), { mode: 0o700 });
    const empty = prepareOutput(join(scratch, 'empty'));
    expect(realFs.readdirSync(empty)).toEqual([MARKER]);
    earlierWorkspace(join(scratch, 'earlier'));
    const again = prepareOutput(join(scratch, 'earlier'), { force: true });
    expect(realFs.readdirSync(again)).toEqual([MARKER]);
  });

  it('creates a missing directory itself: private on POSIX, its marker a regular file written once', () => {
    const scratch = makeTmpDir('qs-out-');
    const root = prepareOutput(join(scratch, 'parent', 'new'));
    const marker = join(root, MARKER);
    expect(realFs.lstatSync(marker).isFile()).toBe(true);
    expect(JSON.parse(realFs.readFileSync(marker, 'utf8'))).toMatchObject({ schema: 'mycelink-quickstart/1', feature_id: 'ORD-101' });
    if (POSIX) {
      expect(mode(root)).toBe(0o700);
      expect(mode(marker)).toBe(0o600);
      expect(mode(join(scratch, 'parent')) & 0o022).toBe(0);
    }
  });

  it('refuses a link (a junction on Windows) in place of the directory, writing nothing through it', () => {
    const scratch = makeTmpDir('qs-out-');
    const target = join(scratch, 'target');
    realFs.mkdirSync(target);
    dirLink(target, join(scratch, 'out'));
    expect(() => prepareOutput(join(scratch, 'out'))).toThrow(/symbolic link or junction/);
    expect(realFs.readdirSync(target)).toEqual([]);
  });

  it('refuses --force on a link to an earlier workspace, leaving the link and what it reaches as they were', () => {
    const scratch = makeTmpDir('qs-out-');
    const target = join(scratch, 'target');
    earlierWorkspace(target);
    dirLink(target, join(scratch, 'out'));
    expect(() => prepareOutput(join(scratch, 'out'), { force: true })).toThrow(/symbolic link or junction/);
    expect(realFs.lstatSync(join(scratch, 'out')).isSymbolicLink()).toBe(true);
    expect(realFs.readFileSync(join(target, 'orders-api', 'keep.txt'), 'utf8')).toBe('kept\n');
  });

  it('never overwrites through a link swapped in for the directory just before the marker is written', () => {
    const scratch = makeTmpDir('qs-out-');
    const out = join(scratch, 'out');
    const victim = join(scratch, 'victim');
    realFs.mkdirSync(victim);
    realFs.writeFileSync(join(victim, MARKER), PRECIOUS);
    race.before = {
      fn: ['openSync', 'writeFileSync'],
      suffix: MARKER,
      swap: () => {
        realFs.renameSync(out, `${out}.moved`);
        dirLink(victim, out);
      },
    };
    expect(() => prepareOutput(out)).toThrow(QuickstartError);
    expect(race.before).toBeNull();
    expect(realFs.readFileSync(join(victim, MARKER), 'utf8')).toBe(PRECIOUS);
  });

  it('refuses a directory swapped for a link to an empty one just before the marker is written', () => {
    const scratch = makeTmpDir('qs-out-');
    const out = join(scratch, 'out');
    const victim = join(scratch, 'victim');
    realFs.mkdirSync(victim);
    race.before = {
      fn: ['openSync', 'writeFileSync'],
      suffix: MARKER,
      swap: () => {
        realFs.renameSync(out, `${out}.moved`);
        dirLink(victim, out);
      },
    };
    expect(() => prepareOutput(out)).toThrow(QuickstartError);
    expect(race.before).toBeNull();
  });

  it("refuses with --force when a link is made in the deleted workspace's place before setup re-creates it", () => {
    const scratch = makeTmpDir('qs-out-');
    const out = join(scratch, 'out');
    const victim = join(scratch, 'victim');
    realFs.mkdirSync(victim);
    realFs.writeFileSync(join(victim, MARKER), PRECIOUS);
    earlierWorkspace(out);
    race.after = { fn: ['rmSync'], path: out, swap: () => dirLink(victim, out) };
    expect(() => prepareOutput(out, { force: true })).toThrow(QuickstartError);
    expect(race.after).toBeNull();
    expect(realFs.readdirSync(victim)).toEqual([MARKER]);
    expect(realFs.readFileSync(join(victim, MARKER), 'utf8')).toBe(PRECIOUS);
  });

  it.skipIf(!POSIX)('refuses an existing directory other users can write to', () => {
    const scratch = makeTmpDir('qs-out-');
    const out = join(scratch, 'shared');
    realFs.mkdirSync(out);
    realFs.chmodSync(out, 0o777);
    expect(() => prepareOutput(out)).toThrow(/writable by other users/);
    expect(realFs.readdirSync(out)).toEqual([]);
  });

  it.skipIf(!POSIX)("accepts group write by the user's own primary group (user private groups, umask 002)", () => {
    const scratch = makeTmpDir('qs-out-');
    const mine = join(scratch, 'mine');
    realFs.mkdirSync(mine);
    realFs.chownSync(scratch, process.getuid?.() as number, process.getgid?.() as number);
    realFs.chownSync(mine, process.getuid?.() as number, process.getgid?.() as number);
    realFs.chmodSync(scratch, 0o775);
    realFs.chmodSync(mine, 0o775);
    expect(realFs.readdirSync(prepareOutput(mine))).toEqual([MARKER]);
    expect(realFs.readdirSync(prepareOutput(join(scratch, 'made')))).toEqual([MARKER]);
  });

  it.skipIf(!POSIX)('refuses a place under a directory others can write to, unless that directory is sticky like /tmp', () => {
    const scratch = makeTmpDir('qs-out-');
    const open = join(scratch, 'open');
    realFs.mkdirSync(open);
    realFs.chmodSync(open, 0o777);
    expect(() => prepareOutput(join(open, 'qs'))).toThrow(/writable by other users/);
    expect(realFs.readdirSync(open)).toEqual([]);
    realFs.chmodSync(open, 0o1777);
    expect(realFs.readdirSync(prepareOutput(join(open, 'qs')))).toEqual([MARKER]);
  });

  it('makes its default directory fresh and private under the temp directory, never at a fixed name', () => {
    expect(typeof quickstart.freshTempOutput).toBe('function');
    const fresh = quickstart.freshTempOutput as () => string;
    const a = fresh();
    const b = fresh();
    try {
      expect(a).not.toBe(b);
      for (const dir of [a, b]) {
        expect(realFs.lstatSync(dir).isDirectory()).toBe(true);
        expect(realFs.readdirSync(dir)).toEqual([]);
        if (POSIX) expect(mode(dir)).toBe(0o700);
      }
      expect(realFs.readdirSync(prepareOutput(a))).toEqual([MARKER]);
    } finally {
      for (const dir of [a, b]) realFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setup without --out ignores a directory someone made at the old fixed name and builds its own', () => {
    const temp = makeTmpDir('qs-default-');
    const planted = join(temp, 'mycelink-quickstart');
    realFs.mkdirSync(planted);
    const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
    const r = spawnSync(process.execPath, [SETUP], { cwd: temp, env, encoding: 'utf8', windowsHide: true, timeout: 240_000 });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(realFs.readdirSync(planted)).toEqual([]);
    const made = realFs.readdirSync(temp).filter((n) => n.startsWith('mycelink-quickstart-'));
    expect(made).toHaveLength(1);
    const root = join(temp, made[0] as string);
    expect(realFs.readdirSync(root).sort()).toEqual([MARKER, 'control', 'orders-api', 'orders-web'].sort());
    if (POSIX) expect(mode(root)).toBe(0o700);
  }, 300_000);
});
