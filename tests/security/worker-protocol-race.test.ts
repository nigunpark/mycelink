/**
 * Check-then-use races and links in the worker protocol.
 *
 * CodeQL (js/file-system-race) flagged that the context pack and the worker
 * result were size- and type-checked through one path lookup and then read
 * through another. Whatever sits at the path in between is what gets parsed:
 * an oversized file past the size ceiling, or (for the result, which lives in
 * a worktree a worker or its leftover processes control) a file outside the
 * worktree whose first bytes would then surface in the parse error.
 *
 * The swap is made deterministic by replacing the file the moment the check
 * returns, exactly where a racing process would.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { minimalPack, writePack } from '../helpers/context-pack.js';

const race = vi.hoisted(() => ({
  /** Called once, right after the named check on `path` returns. */
  after: null as null | { fn: 'statSync' | 'lstatSync'; path: string; swap: () => void },
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const wrap =
    <F extends (...a: never[]) => unknown>(name: 'statSync' | 'lstatSync', real: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      const out = real(...args) as ReturnType<F>;
      const hook = race.after;
      if (hook !== null && hook.fn === name && String(args[0]) === hook.path) {
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
  };
});

const { collectWorkerResult, loadPromptPack, prepareResultSlot, MAX_PROMPT_PACK_BYTES } = await import(
  '../../src/sessions/worker-protocol.js'
);

afterEach(() => {
  race.after = null;
});
afterAll(() => cleanupTmpRoots());

const IDENTITY = { featureId: 'FEAT-101', nodeId: 'FEAT-101.core.publish.impl', claimId: 'claim-1' };
const SECRET = 'TOP-SECRET-0123456789-outside-the-worktree';

/** Replace `path` with new content as a new file, as an atomic rename would. */
function replaceFile(path: string, content: string): void {
  realFs.writeFileSync(path + '.swap', content, 'utf8');
  realFs.renameSync(path + '.swap', path);
}

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

function slot(): { cwd: string; file: string; controller: string } {
  const root = makeTmpDir('race-');
  const cwd = join(root, 'wt');
  realFs.mkdirSync(cwd, { recursive: true });
  const file = prepareResultSlot(cwd);
  return { cwd, file, controller: join(root, 'controller', 'result.json') };
}

describe('context pack: the bytes parsed are the bytes size-checked', () => {
  it('is not fooled by a pack swapped for an oversized file after the size check', () => {
    const dir = makeTmpDir('race-pack-');
    const file = join(dir, 'pack.json');
    writePack(file, minimalPack());
    const oversized = JSON.stringify({ pad: 'a'.repeat(MAX_PROMPT_PACK_BYTES + 1024) });
    race.after = { fn: 'statSync', path: file, swap: () => replaceFile(file, oversized) };

    let outcome: string;
    try {
      const pack = loadPromptPack(file, IDENTITY, {});
      outcome = `loaded ${pack.claim_id}`;
    } catch (err) {
      outcome = (err as Error).message;
    }
    // Either the checked original loads, or the oversized file is refused by
    // size. Parsing the unchecked replacement is the bug.
    expect(outcome).toMatch(/^loaded claim-1$|CONTEXT_PACK_INVALID: context pack is \d+ bytes/);
  });

  it('refuses a pack path that is not a regular file', () => {
    const dir = makeTmpDir('race-pack-dir-');
    expect(() => loadPromptPack(dir, IDENTITY, {})).toThrow(/CONTEXT_PACK_INVALID/);
  });
});

describe('worker result: collected from the file that was checked, never through a link', () => {
  it('is not fooled by a result swapped for another file after the link check', () => {
    const { cwd, file, controller } = slot();
    realFs.writeFileSync(file, validResult(), 'utf8');
    race.after = { fn: 'lstatSync', path: file, swap: () => replaceFile(file, SECRET) };

    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.failure ?? '').not.toContain('TOP-SECRET');
    if (collected.result === null) expect(collected.failure).toMatch(/^RESULT_PATH_ESCAPE/);
    else expect(collected.result.claim_id).toBe('claim-1');
    let stored = '';
    try {
      stored = realFs.readFileSync(controller, 'utf8');
    } catch {
      // Nothing stored is fine; storing the outside file is not.
    }
    expect(stored).not.toContain('TOP-SECRET');
  });

  it('refuses a result hard-linked to a file outside the worktree', () => {
    const { cwd, file, controller } = slot();
    const outside = join(cwd, '..', 'outside-secret.txt');
    realFs.writeFileSync(outside, SECRET, 'utf8');
    realFs.linkSync(outside, file);

    const collected = collectWorkerResult(cwd, IDENTITY, controller, {});
    expect(collected.result).toBeNull();
    expect(collected.failure).toMatch(/^RESULT_PATH_ESCAPE/);
    expect(collected.failure).not.toContain('TOP-SECRET');
    // Only the link is removed; the file it shared is untouched.
    expect(realFs.readFileSync(outside, 'utf8')).toBe(SECRET);
  });

  it('never writes the slot .gitignore through a link left by an earlier attempt', (ctx) => {
    const root = makeTmpDir('race-gitignore-');
    const cwd = join(root, 'wt');
    const victim = join(root, 'victim.txt');
    realFs.writeFileSync(victim, 'keep me\n', 'utf8');
    realFs.mkdirSync(join(cwd, '.mycelink-worker'), { recursive: true });
    try {
      realFs.symlinkSync(victim, join(cwd, '.mycelink-worker', '.gitignore'), 'file');
    } catch {
      return ctx.skip(); // No symlink privilege on this Windows account.
    }
    prepareResultSlot(cwd);
    expect(realFs.readFileSync(victim, 'utf8')).toBe('keep me\n');
    const ignore = join(cwd, '.mycelink-worker', '.gitignore');
    expect(realFs.readFileSync(ignore, 'utf8')).toBe('*\n');
    expect(realFs.lstatSync(ignore).isSymbolicLink()).toBe(false);
  });
});
