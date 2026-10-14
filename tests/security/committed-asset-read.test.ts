/**
 * The release tests read committed assets (docs/assets/quickstart-demo.gif and its still) through one descriptor.
 *
 * CodeQL (js/file-system-race, alert 84) flagged the GIF test: it took the file's size from one path lookup and its
 * bytes from another open of the same path, so whatever sat at the path in between — another file renamed over it,
 * the file grown past the size bound, a link — was what got verified. The swap is made deterministic by acting
 * right after the reader's first lookup or open of the path returns, exactly where a racing process would.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

type Op = 'statSync' | 'lstatSync' | 'openSync';

const race = vi.hoisted(() => ({
  /** Called once, right after the reader's first stat, lstat or open of `path` returns. */
  after: null as null | { path: string; swap: () => void },
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const wrap =
    <F extends (...a: never[]) => unknown>(_name: Op, real: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      const out = real(...args) as ReturnType<F>;
      const hook = race.after;
      if (hook !== null && String(args[0]) === hook.path) {
        race.after = null;
        hook.swap();
      }
      return out;
    };
  return {
    ...fs,
    default: fs,
    statSync: wrap('statSync', fs.statSync),
    lstatSync: wrap('lstatSync', fs.lstatSync),
    openSync: wrap('openSync', fs.openSync),
  };
});

const { readCommittedAsset } = await import('../helpers/committed-asset.js');

afterEach(() => {
  race.after = null;
});
afterAll(() => cleanupTmpRoots());

const ORIGINAL = 'GIF89a the committed render\n';
const SWAPPED = 'GIF89a another file renamed over it\n';

/** What the reader made of `path`: the text it returned, or 'refused'. */
function outcome(path: string, max: number): string {
  try {
    return readCommittedAsset(path, max).toString('latin1');
  } catch {
    return 'refused';
  }
}

function asset(): { dir: string; file: string } {
  const dir = makeTmpDir('committed-asset-');
  const file = join(dir, 'demo.gif');
  realFs.writeFileSync(file, ORIGINAL);
  return { dir, file };
}

function canSymlink(dir: string): boolean {
  try {
    realFs.writeFileSync(join(dir, 'probe-target'), '');
    realFs.symlinkSync(join(dir, 'probe-target'), join(dir, 'probe-link'), 'file');
    return true;
  } catch {
    return false;
  }
}

describe('committed assets: read and bounded through the descriptor that was checked', () => {
  it('reads a regular file within the bound', () => {
    const { file } = asset();
    expect(outcome(file, 1024)).toBe(ORIGINAL);
  });

  it('never verifies a file renamed over the asset after it was looked at', () => {
    const { file } = asset();
    race.after = {
      path: file,
      swap: () => {
        realFs.writeFileSync(`${file}.swap`, SWAPPED);
        realFs.renameSync(`${file}.swap`, file);
      },
    };
    expect([ORIGINAL, 'refused']).toContain(outcome(file, 1024));
    expect(race.after).toBeNull();
  });

  it('never returns more than the bound, however the file grows after its size was taken', () => {
    const { file } = asset();
    race.after = { path: file, swap: () => realFs.appendFileSync(file, Buffer.alloc(4096, 0x41)) };
    expect(outcome(file, 1024)).toBe('refused');
    expect(race.after).toBeNull();
  });

  it('refuses a file over the bound', () => {
    const { file } = asset();
    expect(outcome(file, ORIGINAL.length - 1)).toBe('refused');
  });

  it('refuses a link in place of the asset, even to a valid file', (ctx) => {
    const { dir, file } = asset();
    if (!canSymlink(dir)) ctx.skip('this account may not create symbolic links');
    const link = join(dir, 'linked.gif');
    realFs.symlinkSync(file, link, 'file');
    expect(outcome(link, 1024)).toBe('refused');
  });

  it('refuses a directory and an absent path', () => {
    const { dir } = asset();
    expect(outcome(dir, 1024)).toBe('refused');
    expect(outcome(join(dir, 'absent.gif'), 1024)).toBe('refused');
  });
});
