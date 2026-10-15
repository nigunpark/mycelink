/**
 * The atomic replace under Windows contention (state/atomic-json.ts).
 *
 * On NTFS a rename over a file fails with EPERM for as long as any handle on
 * that file is open, even a reader that shares delete (every node:fs reader
 * does), and with EBUSY while the temp is held. The harness's workspace walk,
 * a hook reading STATE.json, a scanner or the indexer each hold one for a
 * moment; on a loaded runner that moment outlasted the old ~210 ms of retries
 * (main CI 38680275774: `mycelink settle` exited 1 on STATE.json's rename).
 *
 * The replace is retried for a bounded time, only for those codes and only on
 * Windows, renaming the very temp it wrote, never one swapped in meanwhile,
 * and never over a newer revision another writer landed meanwhile. When the
 * bound runs out it fails closed: the old bytes stay, the temp is removed and
 * the error keeps its code and says how long it tried.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { CasConflictError, REPLACE_RETRY_MS, casUpdate, readDoc, writeDocAtomic, writeTextAtomic } from '../../src/state/atomic-json.js';

afterAll(() => cleanupTmpRoots());

type Fs = typeof import('node:fs');
const fs = createRequire(import.meta.url)('node:fs') as Fs;

/** Replace node:fs functions for the length of `body`, then put them back. */
function withFs<T>(patch: Partial<Record<keyof Fs, (original: (...a: any[]) => any) => (...a: any[]) => any>>, body: () => T): T {
  const saved = new Map<string, unknown>();
  for (const [name, wrap] of Object.entries(patch)) {
    const original = (fs as any)[name];
    saved.set(name, original);
    (fs as any)[name] = wrap!(original);
  }
  syncBuiltinESMExports();
  try {
    return body();
  } finally {
    for (const [name, original] of saved) (fs as any)[name] = original;
    syncBuiltinESMExports();
  }
}

/** Run `body` as if on `platform`. */
function on<T>(platform: NodeJS.Platform, body: () => T): T {
  const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...was, value: platform });
  try {
    return body();
  } finally {
    Object.defineProperty(process, 'platform', was);
  }
}

const refused = (code: string, from: string, to: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code, syscall: 'rename', path: from, dest: to });

/** The temp's life as the writer led it: opened, synced, closed, renamed. */
function tempTracker(file: string) {
  const fds = new Map<number, string>();
  const log: { tmp: string; synced: boolean; closed: boolean }[] = [];
  const entry = (p: string) => log.find((e) => e.tmp === p);
  return {
    log,
    entry,
    patch: {
      openSync: (o: (...a: any[]) => any) => (p: string, ...rest: unknown[]) => {
        const fd = o(p, ...rest) as number;
        if (typeof p === 'string' && p.startsWith(`${file}.tmp-`)) {
          fds.set(fd, p);
          log.push({ tmp: p, synced: false, closed: false });
        }
        return fd;
      },
      fsyncSync: (o: (...a: any[]) => any) => (fd: number) => {
        o(fd);
        const p = fds.get(fd);
        if (p) entry(p)!.synced = true;
      },
      closeSync: (o: (...a: any[]) => any) => (fd: number) => {
        o(fd);
        const p = fds.get(fd);
        if (p) {
          entry(p)!.closed = true;
          fds.delete(fd);
        }
      },
    },
  };
}

describe('atomic replace under Windows contention', () => {
  it('a replace refused with EPERM after the temp is written, synced and closed lands once the holder lets go, past the old 210 ms of retries', () => {
    const dir = makeTmpDir('replace-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });
    const old = readFileSync(file);
    const t = tempTracker(file);
    const renames: { from: string; at: number }[] = [];
    let since = 0;
    const doc = on('win32', () =>
      withFs(
        {
          ...t.patch,
          renameSync: (o) => (from: string, to: string) => {
            if (to !== file) return o(from, to);
            renames.push({ from, at: Date.now() });
            if (renames.length === 1) {
              since = Date.now();
              // The exact boundary: every byte is in the temp, synced, and its descriptor closed.
              const e = t.entry(from);
              expect(e).toEqual({ tmp: from, synced: true, closed: true });
              expect(JSON.parse(readFileSync(from, 'utf8'))).toEqual({ revision: 2, data: { count: 1 } });
              expect(readFileSync(file)).toEqual(old);
            }
            // A reader holds STATE.json for 600 ms.
            if (Date.now() - since < 600) throw refused('EPERM', from, to);
            return o(from, to);
          },
        },
        () => writeDocAtomic(file, { count: 1 }),
      ),
    );
    expect(doc).toEqual({ revision: 2, data: { count: 1 } });
    expect(readDoc(file)).toEqual({ revision: 2, data: { count: 1 } });
    expect(renames.length).toBeGreaterThan(6);
    // One temp, renamed every time: the very file the writer synced.
    expect(new Set(renames.map((r) => r.from)).size).toBe(1);
    expect(t.log).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(['STATE.json']);
  });

  it('an EBUSY or EACCES refusal is retried the same way', () => {
    for (const code of ['EBUSY', 'EACCES']) {
      const dir = makeTmpDir('replace-');
      const file = join(dir, 'note.txt');
      writeTextAtomic(file, 'old');
      let since = 0;
      on('win32', () =>
        withFs(
          {
            renameSync: (o) => (from: string, to: string) => {
              if (to !== file) return o(from, to);
              since ||= Date.now();
              if (Date.now() - since < 400) throw refused(code, from, to);
              return o(from, to);
            },
          },
          () => writeTextAtomic(file, 'new'),
        ),
      );
      expect(readFileSync(file, 'utf8')).toBe('new');
      expect(readdirSync(dir)).toEqual(['note.txt']);
    }
  });

  it('a replace refused past its bound fails closed: the code kept, how long said, the old bytes in place, the temp removed', () => {
    const dir = makeTmpDir('replace-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });
    const old = readFileSync(file);
    let attempts = 0;
    const started = Date.now();
    let caught: NodeJS.ErrnoException | null = null;
    on('win32', () =>
      withFs(
        {
          renameSync: (o) => (from: string, to: string) => {
            if (to !== file) return o(from, to);
            attempts++;
            throw refused('EPERM', from, to);
          },
        },
        () => {
          try {
            writeDocAtomic(file, { count: 1 });
          } catch (err) {
            caught = err as NodeJS.ErrnoException;
          }
        },
      ),
    );
    const took = Date.now() - started;
    expect(caught).not.toBeNull();
    const err = caught as unknown as NodeJS.ErrnoException;
    expect(err.code).toBe('EPERM');
    expect(err.syscall).toBe('rename');
    expect(err.message).toMatch(/STATE\.json/);
    expect(err.message).toMatch(new RegExp(`refused ${attempts} times over \\d+ ms`));
    // Bounded: it tried for the whole bound and not much past it, with a backoff, not a spin.
    expect(took).toBeGreaterThanOrEqual(REPLACE_RETRY_MS);
    expect(took).toBeLessThan(REPLACE_RETRY_MS + 1500);
    expect(attempts).toBeGreaterThan(6);
    expect(attempts).toBeLessThan(REPLACE_RETRY_MS / 100);
    expect(readFileSync(file)).toEqual(old);
    expect(readdirSync(dir)).toEqual(['STATE.json']);
  });

  it('a refusal that is not a transient one is not retried', () => {
    const dir = makeTmpDir('replace-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });
    let attempts = 0;
    expect(() =>
      on('win32', () =>
        withFs(
          {
            renameSync: (o) => (from: string, to: string) => {
              if (to !== file) return o(from, to);
              attempts++;
              throw refused('EXDEV', from, to);
            },
          },
          () => writeDocAtomic(file, { count: 1 }),
        ),
      ),
    ).toThrow(/EXDEV/);
    expect(attempts).toBe(1);
    expect(readDoc(file)).toEqual({ revision: 1, data: { count: 0 } });
    expect(readdirSync(dir)).toEqual(['STATE.json']);
  });

  it('a temp swapped for another file while the replace waits is never renamed into place', () => {
    const dir = makeTmpDir('replace-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });
    const old = readFileSync(file);
    const forged = JSON.stringify({ revision: 2, data: { count: 999 } });
    let swapped = '';
    let attempts = 0;
    expect(() =>
      on('win32', () =>
        withFs(
          {
            renameSync: (o) => (from: string, to: string) => {
              if (to !== file) return o(from, to);
              attempts++;
              if (attempts === 1) {
                // Another process replaces the temp's name with its own file meanwhile.
                fs.rmSync(from);
                writeFileSync(from, forged);
                swapped = from;
                throw refused('EPERM', from, to);
              }
              return o(from, to);
            },
          },
          () => writeDocAtomic(file, { count: 1 }),
        ),
      ),
    ).toThrow(/ATOMIC_TEMP_CHANGED/);
    expect(attempts).toBe(1);
    expect(readFileSync(file)).toEqual(old);
    // Not the writer's to remove: what is there now is left to the stale-temp reaper.
    expect(readFileSync(swapped, 'utf8')).toBe(forged);
  });

  it('a newer revision another writer lands while the replace waits is never written over with stale bytes', () => {
    const dir = makeTmpDir('replace-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });
    const theirs = `${JSON.stringify({ revision: 2, data: { count: 50 } }, null, 2)}\n`;
    let attempts = 0;
    let caught: unknown = null;
    on('win32', () =>
      withFs(
        {
          renameSync: (o) => (from: string, to: string) => {
            if (to !== file) return o(from, to);
            attempts++;
            if (attempts === 1) {
              // A writer outside the lock lands revision 2 while ours is refused.
              const other = `${file}.other`;
              writeFileSync(other, theirs);
              o(other, file);
              throw refused('EPERM', from, to);
            }
            return o(from, to);
          },
        },
        () => {
          try {
            casUpdate<{ count: number }>(file, 1, (d) => ({ count: d.count + 1 }));
          } catch (err) {
            caught = err;
          }
        },
      ),
    );
    expect(caught).toBeInstanceOf(CasConflictError);
    expect(caught).toMatchObject({ expected: 1, actual: 2 });
    expect(attempts).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(theirs);
    expect(readdirSync(dir)).toEqual(['STATE.json']);
  });

  it('off Windows a refused replace is retried as before: six tries, no bounded wait', () => {
    const dir = makeTmpDir('replace-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });
    let attempts = 0;
    const started = Date.now();
    expect(() =>
      on('linux', () =>
        withFs(
          {
            renameSync: (o) => (from: string, to: string) => {
              if (to !== file) return o(from, to);
              attempts++;
              throw refused('EPERM', from, to);
            },
          },
          () => writeDocAtomic(file, { count: 1 }),
        ),
      ),
    ).toThrow(/EPERM/);
    expect(attempts).toBe(6);
    expect(Date.now() - started).toBeLessThan(REPLACE_RETRY_MS);
    expect(readDoc(file)).toEqual({ revision: 1, data: { count: 0 } });
    expect(readdirSync(dir)).toEqual(['STATE.json']);
  });

  it('writers in separate processes, under the lock, all land while a reader holds STATE.json open for a second', async () => {
    const dir = makeTmpDir('replace-real-');
    const file = join(dir, 'STATE.json');
    const lock = join(makeTmpDir('replace-lock-'), 'STATE.lock');
    writeDocAtomic(file, { count: 0 });
    const bundleDir = makeTmpDir('replace-bundle-');
    const writer = join(bundleDir, 'writer.mjs');
    buildSync({
      stdin: {
        contents: [
          `import { casUpdate, readDoc } from './src/state/atomic-json.ts';`,
          `import { withLock } from './src/state/process-lock.ts';`,
          `const [file, lock, n] = process.argv.slice(2);`,
          `for (let i = 0; i < Number(n); i++) withLock(lock, () => { const d = readDoc(file); casUpdate(file, d.revision, (x) => ({ count: x.count + 1 })); }, { timeoutMs: 30000, pollMs: 10 });`,
        ].join('\n'),
        resolveDir: resolve('.'),
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: writer,
      logLevel: 'silent',
    });
    // A reader that holds STATE.json open, sharing delete as every node:fs reader does.
    const holder = spawn(process.execPath, ['-e', `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(file)},'r');process.stdout.write('held');setTimeout(()=>fs.closeSync(fd),1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const holderDone = done(holder);
    await new Promise((r) => holder.stdout!.once('data', r));
    const per = 5;
    const writers = [0, 1].map(() => done(spawn(process.execPath, [writer, file, lock, String(per)], { stdio: ['ignore', 'pipe', 'pipe'] })));
    const outs = await Promise.all([holderDone, ...writers]);
    for (const o of outs) expect(o.code, o.err).toBe(0);
    expect(readDoc(file)).toEqual({ revision: 1 + 2 * per, data: { count: 2 * per } });
    expect(readdirSync(dir)).toEqual(['STATE.json']);
  });
});

function done(child: ReturnType<typeof spawn>): Promise<{ code: number | null; err: string }> {
  let err = '';
  child.stderr?.on('data', (d) => (err += String(d)));
  return new Promise((r) => child.on('exit', (code) => r({ code, err })));
}
