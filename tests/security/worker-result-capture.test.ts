/**
 * Capturing the worker result portably and without check-then-use races.
 *
 * Node 22 on Windows reports `dev: 0n` from path-based `lstat`/`stat` (with
 * bigint) while `fstat` on an open descriptor reports the volume serial, so
 * comparing the two identities refused every ordinary result there
 * (`RESULT_PATH_ESCAPE: the result is not a regular file`, CI run
 * 37141412218, Windows / Node 22.12). The fake below reproduces exactly that
 * split on every platform.
 *
 * Capture instead moves the worker's slot into a fresh controller-owned
 * quarantine with one atomic rename, so after it the worker cannot swap the
 * pathname being validated. A rename that cannot be done atomically on one
 * volume fails closed; nothing is ever copied out of the worktree.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as realFs from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

const fake = vi.hoisted(() => ({
  /** Path-based stats report `dev: 0n`, as Node 22 does on Windows. */
  node22PathDev: false,
  /** Renames out of this directory fail as if it were on another volume. */
  crossVolumeFrom: null as null | string,
  /** Simulated volume roots: a rename between two of them fails with EXDEV. */
  volumes: [] as string[],
  copies: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const zeroDev =
    <F extends (...a: never[]) => unknown>(real: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      const out = real(...args) as ReturnType<F>;
      const opts = args[1] as { bigint?: boolean } | undefined;
      if (fake.node22PathDev && opts?.bigint === true && out !== undefined) {
        return Object.assign(Object.create(Object.getPrototypeOf(out) as object) as object, out, {
          dev: 0n,
        }) as ReturnType<F>;
      }
      return out;
    };
  const renameSync = (from: realFs.PathLike, to: realFs.PathLike): void => {
    const volumeOf = (p: string): string | undefined => fake.volumes.find((v) => resolve(p).startsWith(v + sep));
    if (fake.volumes.length > 0 && volumeOf(String(from)) !== volumeOf(String(to))) {
      throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${String(from)}'`), {
        code: 'EXDEV',
      });
    }
    if (fake.crossVolumeFrom !== null && resolve(String(from)).startsWith(fake.crossVolumeFrom + sep)) {
      throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${String(from)}'`), {
        code: 'EXDEV',
      });
    }
    fs.renameSync(from, to);
  };
  const counted =
    <F extends (...a: never[]) => unknown>(real: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      fake.copies += 1;
      return real(...args) as ReturnType<F>;
    };
  return {
    ...fs,
    default: fs,
    lstatSync: zeroDev(fs.lstatSync),
    statSync: zeroDev(fs.statSync),
    renameSync,
    copyFileSync: counted(fs.copyFileSync),
    cpSync: counted(fs.cpSync),
  };
});

const { collectWorkerResult, prepareResultSlot } = await import('../../src/sessions/worker-protocol.js');

afterEach(() => {
  fake.node22PathDev = false;
  fake.crossVolumeFrom = null;
  fake.volumes = [];
  fake.copies = 0;
});
afterAll(() => cleanupTmpRoots());

const IDENTITY = { featureId: 'FEAT-101', nodeId: 'FEAT-101.core.publish.impl', claimId: 'claim-1' };
const SECRET = 'TOP-SECRET-0123456789-outside-the-worktree';

function validResult(): string {
  return JSON.stringify({
    schema_version: 1,
    node_id: IDENTITY.nodeId,
    claim_id: IDENTITY.claimId,
    outcome: 'SUBMITTED',
    commands: [],
    commit_sha: null,
    changed_paths: [],
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
  });
}

function slot(): { root: string; cwd: string; file: string; controller: string } {
  const root = makeTmpDir('capture-');
  const cwd = join(root, 'wt');
  realFs.mkdirSync(cwd, { recursive: true });
  const file = prepareResultSlot(cwd);
  return { root, cwd, file, controller: join(root, 'controller', 'result.json') };
}

/** Nothing the capture staged is left beside the controller result. */
function leftovers(controller: string): string[] {
  if (!realFs.existsSync(dirname(controller))) return [];
  return realFs.readdirSync(dirname(controller)).filter((n) => n !== 'result.json');
}

describe('worker result capture under Node 22 Windows file identity', () => {
  it('accepts an ordinary result when path stats report dev 0 but fstat does not', () => {
    const { cwd, file, controller } = slot();
    realFs.writeFileSync(file, validResult(), 'utf8');
    fake.node22PathDev = true;

    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.failure).toBeNull();
    expect(collected.result?.claim_id).toBe('claim-1');
    expect(JSON.parse(realFs.readFileSync(controller, 'utf8'))).toMatchObject({ claim_id: 'claim-1' });
    expect(realFs.existsSync(file)).toBe(false);
    expect(leftovers(controller)).toEqual([]);
  });

  it('still refuses a hard link to a file outside the worktree', () => {
    const { root, cwd, file, controller } = slot();
    const outside = join(root, 'outside-secret.txt');
    realFs.writeFileSync(outside, SECRET, 'utf8');
    realFs.linkSync(outside, file);
    fake.node22PathDev = true;

    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.result).toBeNull();
    expect(collected.failure).toMatch(/^RESULT_PATH_ESCAPE/);
    expect(collected.failure).not.toContain('TOP-SECRET');
    expect(realFs.readFileSync(outside, 'utf8')).toBe(SECRET);
    expect(realFs.existsSync(controller)).toBe(false);
    expect(leftovers(controller)).toEqual([]);
  });
});

/** A worktree on one simulated volume and the controller copy on another. */
function twoVolumes(): { root: string; cwd: string; file: string; controller: string } {
  const root = makeTmpDir('capture-xv-');
  const a = join(root, 'vol-a');
  const b = join(root, 'vol-b');
  const cwd = join(a, 'worktrees', 'wt');
  realFs.mkdirSync(cwd, { recursive: true });
  realFs.mkdirSync(b, { recursive: true });
  fake.volumes = [resolve(a), resolve(b)];
  const file = prepareResultSlot(cwd);
  return { root, cwd, file, controller: join(b, 'controller', 'result.json') };
}

describe('worker result capture across volumes', () => {
  it('captures through a quarantine on the worktree volume when the controller is on another, without copying', () => {
    const { cwd, file, controller } = twoVolumes();
    realFs.writeFileSync(file, validResult(), 'utf8');
    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.failure).toBeNull();
    expect(collected.result?.claim_id).toBe('claim-1');
    expect(JSON.parse(realFs.readFileSync(controller, 'utf8'))).toMatchObject({ claim_id: 'claim-1' });
    expect(fake.copies).toBe(0);
    expect(realFs.existsSync(file)).toBe(false);
    // Nothing staged is left beside the worktree or the controller copy.
    expect(realFs.readdirSync(dirname(cwd))).toEqual(['wt']);
    expect(leftovers(controller)).toEqual([]);
  });

  it('keeps refusing a hard link to an outside file on the fallback path', () => {
    const { root, cwd, file, controller } = twoVolumes();
    const outside = join(root, 'vol-a', 'outside-secret.txt');
    realFs.writeFileSync(outside, SECRET, 'utf8');
    realFs.linkSync(outside, file);
    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.result).toBeNull();
    expect(collected.failure).toMatch(/^RESULT_PATH_ESCAPE/);
    expect(realFs.readFileSync(outside, 'utf8')).toBe(SECRET);
    expect(realFs.existsSync(controller)).toBe(false);
    expect(realFs.readdirSync(dirname(cwd))).toEqual(['wt']);
  });

  it('keeps moving a slot directory link itself on the fallback path, never what it points at', (ctx) => {
    const { root, cwd, controller } = twoVolumes();
    const outsideDir = join(root, 'vol-a', 'outside');
    realFs.mkdirSync(outsideDir);
    const outsideResult = join(outsideDir, 'result.json');
    realFs.writeFileSync(outsideResult, SECRET, 'utf8');
    const dir = join(cwd, '.mycelink-worker');
    realFs.rmSync(dir, { recursive: true, force: true });
    try {
      realFs.symlinkSync(outsideDir, dir, 'junction');
    } catch {
      return ctx.skip();
    }
    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.result).toBeNull();
    expect(collected.failure).toMatch(/^RESULT_PATH_ESCAPE/);
    expect(realFs.readFileSync(outsideResult, 'utf8')).toBe(SECRET);
    expect(realFs.existsSync(controller)).toBe(false);
  });
});

describe('worker result capture requires one same-volume atomic rename', () => {
  it('fails closed, without copying, when the slot cannot be renamed into any quarantine', () => {
    const { cwd, file, controller } = slot();
    realFs.writeFileSync(file, validResult(), 'utf8');
    fake.crossVolumeFrom = resolve(cwd);

    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.result).toBeNull();
    expect(collected.failure).toMatch(/^RESULT_CAPTURE_FAILED: .*EXDEV/);
    expect(fake.copies).toBe(0);
    expect(realFs.existsSync(controller)).toBe(false);
    expect(leftovers(controller)).toEqual([]);
  });

  it('moves a slot directory link itself, never the outside file it points at', (ctx) => {
    const { root, cwd, controller } = slot();
    const outsideDir = join(root, 'outside');
    realFs.mkdirSync(outsideDir);
    const outsideResult = join(outsideDir, 'result.json');
    realFs.writeFileSync(outsideResult, SECRET, 'utf8');
    const dir = join(cwd, '.mycelink-worker');
    realFs.rmSync(dir, { recursive: true, force: true });
    try {
      realFs.symlinkSync(outsideDir, dir, 'junction');
    } catch {
      return ctx.skip();
    }

    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.result).toBeNull();
    expect(collected.failure).toMatch(/^RESULT_PATH_ESCAPE/);
    expect(collected.failure).not.toContain('TOP-SECRET');
    expect(realFs.readFileSync(outsideResult, 'utf8')).toBe(SECRET);
    expect(realFs.existsSync(controller)).toBe(false);
    expect(leftovers(controller)).toEqual([]);
  });

  it('refuses a final link to a file outside the worktree and leaves its target alone', (ctx) => {
    const { root, cwd, file, controller } = slot();
    const outside = join(root, 'outside-secret.json');
    realFs.writeFileSync(outside, SECRET, 'utf8');
    try {
      realFs.symlinkSync(outside, file, 'file');
    } catch {
      return ctx.skip(); // No symlink privilege on this Windows account.
    }

    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.result).toBeNull();
    expect(collected.failure).toMatch(/^RESULT_PATH_ESCAPE/);
    expect(collected.failure).not.toContain('TOP-SECRET');
    expect(realFs.readFileSync(outside, 'utf8')).toBe(SECRET);
    expect(leftovers(controller)).toEqual([]);
  });
});
