/**
 * The immutable evidence store (evidence/store.ts).
 *
 * Every artifact is named by its own bytes and created exclusively before any
 * record names it; nothing is ever written over. Writers running at once —
 * the same gate in two processes, two gates of one node — each end with an
 * intact artifact of their own bytes. What a writer killed mid-write leaves is
 * a temporary file only, never an artifact: the only thing ever collected.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { artifactAt, contentName, writeImmutable } from '../../src/evidence/store.js';
import { reapEvidenceTemps } from '../../src/engine/evidence-integrity.js';

afterAll(() => cleanupTmpRoots());

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

describe('immutable evidence store', () => {
  it('names an artifact by its bytes and writes the same bytes once', () => {
    const dir = makeTmpDir('store-');
    const a = writeImmutable(dir, 'N.red', '.log', 'one\n');
    expect(a.created).toBe(true);
    expect(a.file).toBe(join(dir, contentName('N.red', sha('one\n'), '.log')));
    const b = writeImmutable(dir, 'N.red', '.log', 'one\n');
    expect(b).toEqual({ file: a.file, sha256: a.sha256, created: false });
    expect(readdirSync(dir)).toEqual([contentName('N.red', sha('one\n'), '.log')]);
  });

  it('never writes over or through what holds its name: a foreign file, a link, a directory', (ctx) => {
    const dir = makeTmpDir('store-');
    const name = contentName('N.red', sha('two\n'), '.log');
    writeFileSync(join(dir, name), 'not these bytes\n');
    const a = writeImmutable(dir, 'N.red', '.log', 'two\n');
    expect(a.file).toBe(join(dir, contentName('N.red', sha('two\n'), '.log', 1)));
    expect(readFileSync(join(dir, name), 'utf8')).toBe('not these bytes\n');
    const victim = join(makeTmpDir('store-victim-'), 'victim');
    writeFileSync(victim, 'untouched');
    try {
      symlinkSync(victim, join(dir, contentName('N.red', sha('three\n'), '.log')), 'file');
    } catch {
      ctx.skip();
    }
    const b = writeImmutable(dir, 'N.red', '.log', 'three\n');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(artifactAt(b.file, sha('three\n'))).toBe('same');
    mkdirSync(join(dir, contentName('N.red', sha('four\n'), '.log')));
    expect(artifactAt(writeImmutable(dir, 'N.red', '.log', 'four\n').file, sha('four\n'))).toBe('same');
  });

  it('writers at once in separate processes each end with an intact artifact of their bytes, nothing overwritten', async () => {
    const dir = makeTmpDir('store-concurrent-');
    const bundle = join(makeTmpDir('store-bundle-'), 'store.mjs');
    buildSync({ entryPoints: [resolve('src/evidence/store.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
    const script = join(dirname0(bundle), 'writer.mjs');
    writeFileSync(script, `import { writeImmutable } from ${JSON.stringify('./store.mjs')};\nconst [dir, text] = process.argv.slice(2);\nconst r = writeImmutable(dir, 'N.red', '.log', text);\nprocess.stdout.write(JSON.stringify(r));\n`);
    // Eight writers of the same bytes (a gate's identical reruns) and eight of their own (different runs), all at once.
    const texts = [...Array.from({ length: 8 }, () => 'same run\n'), ...Array.from({ length: 8 }, (_, i) => `run ${i}\n`)];
    const outs = await Promise.all(texts.map((t) => run(process.execPath, [script, dir, t])));
    for (const [i, o] of outs.entries()) {
      expect(o.code, o.err).toBe(0);
      const r = JSON.parse(o.out) as { file: string; sha256: string };
      expect(r.sha256).toBe(sha(texts[i] as string));
      expect(artifactAt(r.file, r.sha256)).toBe('same');
    }
    // One artifact per distinct content, no temporary file left behind.
    expect(readdirSync(dir).sort()).toEqual([...new Set(texts)].map((t) => contentName('N.red', sha(t), '.log')).sort());
  });

  it('collects only what a killed writer left (stale temporary files), never an artifact', () => {
    const root = makeTmpDir('store-gc-');
    const dir = join(root, 'features', 'F-1', 'evidence', 'F-1.core.impl');
    mkdirSync(dir, { recursive: true });
    const kept = writeImmutable(dir, 'F-1.core.impl.red', '.log', 'kept, never referenced\n');
    const stale = join(dir, `.${contentName('F-1.core.impl.red', sha('x'), '.log')}.0123456789abcdef.tmp`);
    const fresh = join(dir, `.${contentName('F-1.core.impl.red', sha('y'), '.log')}.fedcba9876543210.tmp`);
    const lookalike = join(dir, 'notes.tmp');
    for (const f of [stale, fresh, lookalike]) writeFileSync(f, 'partial');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(lookalike, old, old);
    const reaped = reapEvidenceTemps(root, 'F-1');
    expect(reaped).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    // A writer that may still be running, a file that is not a writer's temporary, and every artifact: kept.
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(lookalike)).toBe(true);
    expect(artifactAt(kept.file, kept.sha256)).toBe('same');
  });
});

function dirname0(file: string): string {
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => done({ code: code ?? 1, out, err }));
  });
}
