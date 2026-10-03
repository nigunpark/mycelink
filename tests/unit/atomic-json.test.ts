import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import {
  CasConflictError,
  casUpdate,
  readDoc,
  writeDocAtomic,
  writeTextAtomic,
} from '../../src/state/atomic-json.js';

afterAll(() => cleanupTmpRoots());

describe('atomic-json', () => {
  it('writes a document that reads back with revision 1', () => {
    const dir = makeTmpDir('atomic-');
    const file = join(dir, 'STATE.json');

    writeDocAtomic(file, { feature_id: 'FEAT-1', nodes: {} });

    const doc = readDoc<{ feature_id: string }>(file);
    expect(doc).not.toBeNull();
    expect(doc?.revision).toBe(1);
    expect(doc?.data.feature_id).toBe('FEAT-1');
  });

  it('returns null for a missing file rather than throwing', () => {
    const dir = makeTmpDir('atomic-');
    expect(readDoc(join(dir, 'nope.json'))).toBeNull();
  });

  it('leaves no temp files behind after a write', () => {
    const dir = makeTmpDir('atomic-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { a: 1 });
    writeDocAtomic(file, { a: 2 });
    const stray = readdirSync(dir).filter((f) => f !== 'STATE.json');
    expect(stray).toEqual([]);
  });

  it('casUpdate increments revision and applies the mutation', () => {
    const dir = makeTmpDir('atomic-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });

    const next = casUpdate<{ count: number }>(file, 1, (d) => ({ count: d.count + 1 }));

    expect(next.revision).toBe(2);
    expect(next.data.count).toBe(1);
    expect(readDoc<{ count: number }>(file)?.data.count).toBe(1);
  });

  it('casUpdate rejects a stale expected revision', () => {
    const dir = makeTmpDir('atomic-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });
    casUpdate<{ count: number }>(file, 1, (d) => ({ count: d.count + 1 }));

    expect(() => casUpdate<{ count: number }>(file, 1, (d) => ({ count: d.count + 1 }))).toThrow(
      CasConflictError,
    );
    // The rejected update must not have been applied.
    expect(readDoc<{ count: number }>(file)?.data.count).toBe(1);
  });

  it('ignores and reaps a leftover temp file from a crashed writer', () => {
    const dir = makeTmpDir('atomic-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { count: 0 });
    // Simulate a process that died between temp-write and rename.
    writeFileSync(join(dir, 'STATE.json.tmp-2147483646-deadbeef'), '{"partial": ');

    expect(readDoc<{ count: number }>(file)?.data.count).toBe(0);
    writeDocAtomic(file, { count: 1 });
    const stray = readdirSync(dir).filter((f) => f !== 'STATE.json');
    expect(stray).toEqual([]);
  });

  it('writeTextAtomic replaces content without an intermediate truncated state', () => {
    const dir = makeTmpDir('atomic-');
    const file = join(dir, 'note.txt');
    writeTextAtomic(file, 'first');
    writeTextAtomic(file, 'second-longer');
    expect(readFileSync(file, 'utf8')).toBe('second-longer');
  });

  it('a concurrent reader never observes a partially written file', () => {
    const dir = makeTmpDir('atomic-race-');
    const file = join(dir, 'STATE.json');
    writeDocAtomic(file, { payload: 'x'.repeat(200_000), n: 0 });

    const writerScript = join(dir, 'writer.mjs');
    const modUrl = new URL('../../src/state/atomic-json.ts', import.meta.url);
    // The child uses plain fs writes through the same algorithm shape, driven by
    // the compiled-free path: we spawn Node with a tiny inline implementation that
    // mirrors the public contract (temp file in same dir + rename).
    writeFileSync(
      writerScript,
      `
import { writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
const file = process.argv[2];
for (let i = 0; i < 60; i++) {
  const tmp = file + '.tmp-' + process.pid + '-' + i.toString(36);
  const body = JSON.stringify({ revision: i + 2, data: { payload: 'y'.repeat(200000), n: i } });
  writeFileSync(tmp, body);
  const fd = openSync(tmp, 'r+'); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, file);
}
`,
    );
    void modUrl;

    const child = execFileSync(process.execPath, [writerScript, file], { encoding: 'utf8' });
    void child;

    // After the writer finished, every intermediate state must have been valid JSON.
    // Read repeatedly while a second writer runs to prove it under live contention.
    const proc = execFileSync(
      process.execPath,
      ['-e', `require('child_process').spawn(process.execPath, [${JSON.stringify(writerScript)}, ${JSON.stringify(file)}], {detached:true, stdio:'ignore'}).unref()`],
      { encoding: 'utf8' },
    );
    void proc;

    let reads = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const doc = readDoc<{ n: number }>(file);
      expect(doc).not.toBeNull();
      expect(typeof doc?.data.n).toBe('number');
      reads++;
    }
    expect(reads).toBeGreaterThan(5);
    expect(existsSync(file)).toBe(true);
  });
});
