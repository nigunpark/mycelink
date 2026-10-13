/**
 * Re-proof units (CSET-201 final): a re-proof's test files, as its red gate
 * ran them, applied to the worker's submitted head as a test-only commit of
 * the controller's — merged three ways with the worker's own later change,
 * never removing or editing a test that is there, never a conflict resolved
 * by guesswork.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import { REPROOF_IDENTITY, REPROOF_TRAILER, commitProofUnit, planProofUnit, reproofTrailer, type ProofFile } from '../../src/engine/proof-units.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const FILE = 'packages/cli/test/status.test.mjs';
const BASE = "import { test } from 'node:test';\n\ntest('status lists the packages', () => {});\n";
const REPROOF = `${BASE}\ntest('--explain prints a dependent reason line', () => {});\n`;

function repo(): { dir: string; base: string } {
  const dir = makeGitRepo(join(makeTmpDir('proof-units-'), 'repo'), { files: { [FILE]: BASE, 'src/index.mjs': 'export {};\n' } });
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) };
}
const blob = (dir: string, rev: string, path: string): string => git(dir, ['rev-parse', `${rev}:${path}`]);
const proof = (dir: string, base: string, bytes: string, path = FILE): ProofFile => ({ path, bytes: Buffer.from(bytes), sha256: sha256(bytes), base_blob: (() => { try { return blob(dir, base, path); } catch { return null; } })() });

describe('planProofUnit / commitProofUnit', () => {
  it("commits exactly the gate's bytes on the submitted head, as the controller, with the trailer; no ref moves", () => {
    const { dir, base } = repo();
    const plan = planProofUnit(dir, base, [proof(dir, base, REPROOF)]);
    expect(plan.kind).toBe('commit');
    const commit = commitProofUnit(dir, base, plan as Extract<typeof plan, { kind: 'commit' }>, { subject: 'test(cli): re-proof of AC-3 for CSET-201-R001', body: 'committed by settle', criteria: ['AC-3'] });
    expect(git(dir, ['show', `${commit}:${FILE}`]) + '\n').toBe(REPROOF);
    expect(git(dir, ['rev-parse', `${commit}~1`])).toBe(base);
    expect(git(dir, ['diff', '--name-only', base, commit])).toBe(FILE);
    expect(git(dir, ['show', '-s', '--format=%an <%ae>', commit])).toBe(`${REPROOF_IDENTITY.name} <${REPROOF_IDENTITY.email}>`);
    expect(reproofTrailer(git(dir, ['show', '-s', '--format=%B', commit]))).toEqual(['AC-3']);
    expect(git(dir, ['show', '-s', '--format=%B', commit])).toContain(`${REPROOF_TRAILER}: AC-3`);
    // An object only: the branch is where it was.
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(base);
  });

  it('a file already as the gate ran it is nothing to commit; a new test file is committed whole', () => {
    const { dir, base } = repo();
    expect(planProofUnit(dir, base, [proof(dir, base, BASE)])).toEqual({ kind: 'none' });
    const plan = planProofUnit(dir, base, [proof(dir, base, "import { test } from 'node:test';\ntest('new', () => {});\n", 'packages/cli/test/new.test.mjs')]);
    expect(plan).toMatchObject({ kind: 'commit', files: [{ path: 'packages/cli/test/new.test.mjs', mode: '100644' }] });
  });

  it("merges with the worker's own later change: both appends kept (the worker's first), non-overlapping edits three ways", () => {
    const { dir, base } = repo();
    // The worker's compatibility test, appended and committed after its red gate ran the reproduction (kept out of the branch).
    writeFiles(dir, { [FILE]: `${BASE}\ntest('status is unchanged without --explain', () => {});\n` });
    const head = commitAll(dir, 'test(cli): AC-4');
    const plan = planProofUnit(dir, head, [proof(dir, base, REPROOF)]);
    expect(plan.kind).toBe('commit');
    const commit = commitProofUnit(dir, head, plan as Extract<typeof plan, { kind: 'commit' }>, { subject: 's', body: 'b', criteria: ['AC-3'] });
    const merged = git(dir, ['show', `${commit}:${FILE}`]);
    expect(merged.indexOf('status is unchanged without --explain')).toBeGreaterThan(0);
    expect(merged.indexOf('--explain prints a dependent reason line')).toBeGreaterThan(merged.indexOf('status is unchanged without --explain'));
    expect(merged.startsWith(BASE.trimEnd())).toBe(true);
  });

  it('refuses a conflict, a merge that would remove or edit a test that is there, and bytes that no longer hash as recorded', () => {
    const { dir, base } = repo();
    // The worker rewrote the existing test's body after the gate ran on the base: the gate's copy edits the same lines.
    writeFiles(dir, { [FILE]: "import { test } from 'node:test';\n\ntest('status lists the packages', () => { console.log('changed'); });\n" });
    const head = commitAll(dir, 'worker edit');
    const edited = "import { test } from 'node:test';\n\ntest('status lists the packages', () => { console.log('other'); });\n\ntest('x', () => {});\n";
    expect(planProofUnit(dir, head, [proof(dir, base, edited)])).toMatchObject({ kind: 'refused', code: 'REPROOF_CONFLICT', paths: [FILE] });
    // The gate ran a copy without the existing test: committing it would remove that test.
    const { dir: d2, base: b2 } = repo();
    expect(planProofUnit(d2, b2, [proof(d2, b2, "import { test } from 'node:test';\n\ntest('--explain prints a dependent reason line', () => {});\n")])).toMatchObject({ kind: 'refused', code: 'REPROOF_WEAKENS', paths: [FILE] });
    const tampered = { ...proof(d2, b2, REPROOF), bytes: Buffer.from(`${REPROOF}// changed after the gate ran\n`) };
    expect(planProofUnit(d2, b2, [tampered])).toMatchObject({ kind: 'refused', code: 'REPROOF_TAMPERED' });
  });
});
