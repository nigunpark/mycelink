/**
 * Check-then-use races on evidence outputs and the control `.gitignore`.
 *
 * CodeQL (js/file-system-race) flagged that both files were type-checked by
 * one path lookup and then opened by another. Whatever sits at the path in
 * between is what gets hashed or appended to: a hard link to a file outside
 * the repository, or (where the open follows links, as on Windows) a link
 * that is put back as a regular file before the post-open check looks.
 *
 * The swap is made deterministic by replacing the path immediately before
 * and after the open, exactly where a racing process would.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as realFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

type Op = 'openSync' | 'writeFileSync' | 'fstatSync';
/** `path: null` matches any first argument (fstatSync takes a descriptor). */
type Hook = { fn: Op | Op[]; path: string | null; swap: () => void };

const race = vi.hoisted(() => ({
  /** Called once, right before the named operation on `path` runs. */
  before: null as null | Hook,
  /** Called once, right after the named operation on `path` returns. */
  after: null as null | Hook,
  /**
   * Node 22.12 on Windows: path lookups (stat/lstat) report `dev` 0 while
   * fstat on a descriptor reports the volume serial. Reproduced on any
   * runtime by zeroing the device of every bigint lstat.
   */
  pathLookupHasNoDevice: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const fire = (slot: 'before' | 'after', name: Op, path: unknown): void => {
    const hook = race[slot];
    if (hook !== null && [hook.fn].flat().includes(name) && (hook.path === null || String(path) === hook.path)) {
      race[slot] = null;
      hook.swap();
    }
  };
  const wrap =
    <F extends (...a: never[]) => unknown>(name: Op, real: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      fire('before', name, args[0]);
      const out = real(...args) as ReturnType<F>;
      fire('after', name, args[0]);
      return out;
    };
  const lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
    const st = fs.lstatSync(...args);
    if (!race.pathLookupHasNoDevice || st === undefined || typeof st.dev !== 'bigint') return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as object, st, { dev: 0n });
  }) as typeof fs.lstatSync;
  return {
    ...fs,
    default: fs,
    lstatSync,
    fstatSync: wrap('fstatSync', fs.fstatSync),
    openSync: wrap('openSync', fs.openSync),
    writeFileSync: wrap('writeFileSync', fs.writeFileSync),
  };
});

const { checkEvidenceOutput } = await import('../../src/evidence/paths.js');
const { ensureScratchIgnored } = await import('../../src/workspace/workspace.js');

afterEach(() => {
  race.before = null;
  race.after = null;
  race.pathLookupHasNoDevice = false;
});
afterAll(() => cleanupTmpRoots());

const FEATURE = 'FEAT-7';
const SECRET = 'TOP-SECRET outside the control repository\n';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Replace `path` with a fresh regular file, as an atomic rename would. */
function replaceFile(path: string, content: string): void {
  realFs.writeFileSync(path + '.swap', content, 'utf8');
  realFs.renameSync(path + '.swap', path);
}

function plantSymlink(target: string, path: string): void {
  realFs.rmSync(path, { force: true });
  realFs.symlinkSync(target, path, 'file');
}

function plantHardLink(target: string, path: string): void {
  realFs.rmSync(path, { force: true });
  realFs.linkSync(target, path);
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

function evidenceFixture(): { control: string; outside: string; rel: string; file: string } {
  const root = makeTmpDir('race-evidence-');
  const control = join(root, 'control');
  const dir = join(control, 'features', FEATURE, 'evidence', 'N');
  realFs.mkdirSync(dir, { recursive: true });
  const outside = join(root, 'outside.log');
  realFs.writeFileSync(outside, SECRET);
  const rel = `features/${FEATURE}/evidence/N/out.log`;
  const file = resolve(control, rel);
  realFs.writeFileSync(file, 'the real evidence\n');
  return { control, outside, rel, file };
}

describe('evidence output: hashed through the descriptor that was checked', () => {
  // The record claims the outside file's hash: accepting it means the
  // controller verified bytes from outside the feature directory.
  it('does not hash a file outside the feature swapped in as a hard link at the open', () => {
    const { control, outside, rel, file } = evidenceFixture();
    race.before = { fn: 'openSync', path: file, swap: () => plantHardLink(outside, file) };
    const problem = checkEvidenceOutput(control, FEATURE, { output_path: rel, output_sha256: sha(SECRET) });
    expect(problem).toMatch(/^UNSAFE_EVIDENCE_PATH/);
  });

  it('refuses an evidence output that is a hard link to a file outside the feature', () => {
    const { control, outside, rel, file } = evidenceFixture();
    plantHardLink(outside, file);
    expect(checkEvidenceOutput(control, FEATURE, { output_path: rel, output_sha256: sha(SECRET) })).toMatch(
      /^UNSAFE_EVIDENCE_PATH/,
    );
  });

  it('does not hash a link target when the link is put back as a file after the open', (ctx) => {
    const { control, outside, rel, file } = evidenceFixture();
    if (!canSymlink(join(control, '..'))) ctx.skip();
    race.before = { fn: 'openSync', path: file, swap: () => plantSymlink(outside, file) };
    race.after = { fn: 'openSync', path: file, swap: () => replaceFile(file, 'decoy\n') };
    const problem = checkEvidenceOutput(control, FEATURE, { output_path: rel, output_sha256: sha(SECRET) });
    expect(problem).toMatch(/^UNSAFE_EVIDENCE_PATH/);
  });

  it('reports a dangling link as unsafe, not as a missing output', (ctx) => {
    const { control, rel, file } = evidenceFixture();
    if (!canSymlink(join(control, '..'))) ctx.skip();
    plantSymlink(join(control, '..', 'nowhere.log'), file);
    expect(checkEvidenceOutput(control, FEATURE, { output_path: rel, output_sha256: sha(SECRET) })).toMatch(
      /^UNSAFE_EVIDENCE_PATH/,
    );
  });

  it('still reports a missing output and accepts an intact one', () => {
    const { control, rel, file } = evidenceFixture();
    expect(checkEvidenceOutput(control, FEATURE, { output_path: rel, output_sha256: sha('the real evidence\n') })).toBeNull();
    realFs.rmSync(file);
    expect(checkEvidenceOutput(control, FEATURE, { output_path: rel, output_sha256: sha('x') })).toMatch(
      /^MISSING_OUTPUT/,
    );
  });

  it('refuses a directory at the output path', () => {
    const { control, rel, file } = evidenceFixture();
    realFs.rmSync(file);
    realFs.mkdirSync(file);
    expect(checkEvidenceOutput(control, FEATURE, { output_path: rel, output_sha256: sha('x') })).toMatch(
      /^UNSAFE_EVIDENCE_PATH/,
    );
  });
});

function gitignoreFixture(content: string | null): { control: string; file: string; victim: string } {
  const root = makeTmpDir('race-gitignore-');
  const control = join(root, 'control');
  realFs.mkdirSync(control, { recursive: true });
  const victim = join(root, 'victim.txt');
  realFs.writeFileSync(victim, 'untouched\n');
  const file = join(control, '.gitignore');
  if (content !== null) realFs.writeFileSync(file, content);
  return { control, file, victim };
}

describe('.gitignore: appended through the descriptor that was checked', () => {
  it('does not append to a link target when the link is put back as a file after the open', (ctx) => {
    const { control, file, victim } = gitignoreFixture('node_modules/\n');
    if (!canSymlink(join(control, '..'))) ctx.skip();
    race.before = { fn: 'openSync', path: file, swap: () => plantSymlink(victim, file) };
    race.after = { fn: 'openSync', path: file, swap: () => replaceFile(file, 'node_modules/\n') };
    expect(() => ensureScratchIgnored(control)).toThrow(/Refusing to update/);
    expect(realFs.readFileSync(victim, 'utf8')).toBe('untouched\n');
  });

  it('does not append to a file outside the repository swapped in as a hard link at the open', () => {
    const { control, file, victim } = gitignoreFixture('node_modules/\n');
    race.before = { fn: 'openSync', path: file, swap: () => plantHardLink(victim, file) };
    expect(() => ensureScratchIgnored(control)).toThrow(/hard link/);
    expect(realFs.readFileSync(victim, 'utf8')).toBe('untouched\n');
  });

  it('does not write through a link planted where the missing file was about to be created', (ctx) => {
    const { control, file, victim } = gitignoreFixture(null);
    if (!canSymlink(join(control, '..'))) ctx.skip();
    // Whichever call creates the file by name, a link appears just before it.
    race.before = { fn: ['openSync', 'writeFileSync'], path: file, swap: () => plantSymlink(victim, file) };
    let threw = false;
    try {
      ensureScratchIgnored(control);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(realFs.readFileSync(victim, 'utf8')).toBe('untouched\n');
  });

  it('refuses a hard-linked .gitignore and a directory, and appends to a plain one exactly once', () => {
    const linked = gitignoreFixture('x\n');
    plantHardLink(linked.victim, linked.file);
    expect(() => ensureScratchIgnored(linked.control)).toThrow(/hard link/);
    expect(realFs.readFileSync(linked.victim, 'utf8')).toBe('untouched\n');

    const dir = gitignoreFixture(null);
    realFs.mkdirSync(dir.file);
    expect(() => ensureScratchIgnored(dir.control)).toThrow(/Refusing to update/);

    const plain = gitignoreFixture('a\n*.log');
    ensureScratchIgnored(plain.control);
    ensureScratchIgnored(plain.control);
    expect(realFs.readFileSync(plain.file, 'utf8')).toBe('a\n*.log\n/.mycelink/\n');

    const fresh = gitignoreFixture(null);
    ensureScratchIgnored(fresh.control);
    expect(realFs.readFileSync(fresh.file, 'utf8')).toBe('/.mycelink/\n');
  });
});

/** The Windows 8.3 short form of an existing path, or null where the volume hands none out. */
function shortAlias(path: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    // Verbatim, so the quotes around the path reach cmd as written.
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
    }).trim();
    return out !== '' && out.toLowerCase() !== path.toLowerCase() ? out : null;
  } catch {
    return null;
  }
}

/** A control root whose own directory name is long enough to need an 8.3 alias. */
function longNamedControl(content: string | null): { control: string; file: string; victim: string } {
  const root = makeTmpDir('race-alias-');
  const control = join(root, 'control-repository-with-a-long-name');
  realFs.mkdirSync(control, { recursive: true });
  const victim = join(root, 'victim.txt');
  realFs.writeFileSync(victim, 'untouched\n');
  const file = join(control, '.gitignore');
  if (content !== null) realFs.writeFileSync(file, content);
  return { control, file, victim };
}

describe('Node 22 path lookups without a device: identity settled through a descriptor', () => {
  it('appends to an ordinary new and existing .gitignore, and accepts intact evidence', () => {
    race.pathLookupHasNoDevice = true;
    const fresh = gitignoreFixture(null);
    ensureScratchIgnored(fresh.control);
    expect(realFs.readFileSync(fresh.file, 'utf8')).toBe('/.mycelink/\n');

    const existing = gitignoreFixture('node_modules/\n');
    ensureScratchIgnored(existing.control);
    ensureScratchIgnored(existing.control);
    expect(realFs.readFileSync(existing.file, 'utf8')).toBe('node_modules/\n/.mycelink/\n');

    const { control, rel } = evidenceFixture();
    expect(checkEvidenceOutput(control, FEATURE, { output_path: rel, output_sha256: sha('the real evidence\n') })).toBeNull();
  });

  it('accepts an ordinary .gitignore and evidence output reached through an 8.3 short alias', (ctx) => {
    race.pathLookupHasNoDevice = true;
    const fresh = longNamedControl(null);
    const alias = shortAlias(fresh.control);
    if (alias === null) ctx.skip();
    ensureScratchIgnored(alias!);
    expect(realFs.readFileSync(fresh.file, 'utf8')).toBe('/.mycelink/\n');

    const existing = longNamedControl('node_modules/\n');
    ensureScratchIgnored(shortAlias(existing.control) ?? existing.control);
    expect(realFs.readFileSync(existing.file, 'utf8')).toBe('node_modules/\n/.mycelink/\n');

    const { control, rel } = evidenceFixture();
    const evidenceRoot = shortAlias(control) ?? control;
    expect(
      checkEvidenceOutput(evidenceRoot, FEATURE, { output_path: rel, output_sha256: sha('the real evidence\n') }),
    ).toBeNull();
  });

  it('still refuses a link put back as a file after the open, through an 8.3 alias', (ctx) => {
    race.pathLookupHasNoDevice = true;
    const { control, file, victim } = longNamedControl('node_modules/\n');
    if (!canSymlink(join(control, '..'))) ctx.skip();
    const aliasRoot = shortAlias(control) ?? control;
    const aliasFile = join(aliasRoot, '.gitignore');
    race.before = { fn: 'openSync', path: aliasFile, swap: () => plantSymlink(victim, file) };
    race.after = { fn: 'openSync', path: aliasFile, swap: () => replaceFile(file, 'node_modules/\n') };
    expect(() => ensureScratchIgnored(aliasRoot)).toThrow(/Refusing to update/);
    expect(realFs.readFileSync(victim, 'utf8')).toBe('untouched\n');
  });

  it('still refuses a hard link, whether present before the open or added after the fstat', (ctx) => {
    race.pathLookupHasNoDevice = true;
    const planted = longNamedControl('x\n');
    plantHardLink(planted.victim, planted.file);
    expect(() => ensureScratchIgnored(shortAlias(planted.control) ?? planted.control)).toThrow(/hard link/);
    expect(realFs.readFileSync(planted.victim, 'utf8')).toBe('untouched\n');

    // The open follows a link to the victim; once the descriptor has been
    // checked, the link is replaced by a hard link to the same victim, so the
    // path now names the opened file as a regular file, with a second name.
    const late = longNamedControl('node_modules/\n');
    if (!canSymlink(join(late.control, '..'))) ctx.skip();
    race.before = { fn: 'openSync', path: late.file, swap: () => plantSymlink(late.victim, late.file) };
    race.after = { fn: 'fstatSync', path: null, swap: () => plantHardLink(late.victim, late.file) };
    expect(() => ensureScratchIgnored(late.control)).toThrow(/Refusing to update/);
    expect(realFs.readFileSync(late.victim, 'utf8')).toBe('untouched\n');

    const ev = evidenceFixture();
    plantHardLink(ev.outside, ev.file);
    expect(checkEvidenceOutput(ev.control, FEATURE, { output_path: ev.rel, output_sha256: sha(SECRET) })).toMatch(
      /^UNSAFE_EVIDENCE_PATH/,
    );
  });
});
