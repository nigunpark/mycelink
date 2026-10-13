/**
 * Evaluator-only artifacts (hidden acceptance tests, the reference solution,
 * mutants) are imported from authoring branches into a directory outside
 * the repository, locked by a committed hash manifest, and trusted only
 * while every file matches it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TOY, TOY_PRD, buildToy, commitFiles, toyGit } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { exportEvaluator, importEvaluator, importEvaluatorArchive, loadEvaluator, unbundleReference, verifyEvaluator } from '../../evals-public-projects/lib/evaluator.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadProject } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { gitBlobSha } from '../../evals-public-projects/lib/hash.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { importSource } from '../../evals-public-projects/lib/source.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { inspectLeakage } from '../../evals-public-projects/lib/leakage.mjs';

afterAll(() => cleanupTmpRoots());

function imported() {
  const toy = buildToy();
  const project = loadProject(toy.suite, 'toyshop');
  const info = importEvaluator({ project, prdId: TOY_PRD, from: toy.authoring, cacheRoot: toy.cacheRoot });
  return { toy, project, info };
}

describe('importEvaluator', () => {
  it('stores hidden tests, the reference bundle and mutant patches outside the repository, and locks them', () => {
    const { toy, project, info } = imported();
    expect(info.dir).toBe(join(toy.cacheRoot, 'evaluator', 'toyshop', TOY_PRD));
    expect(info.hidden).toEqual(Object.keys(TOY.hidden).sort());
    expect(info.hidden_tests.map((t: any) => t.name)).toEqual(['AC-1 reserving reduces the stock', 'AC-1 compat: reserving nothing keeps the stock', 'AC-2 an order reports the remaining stock', 'AC-2 an order larger than the stock is rejected']);
    expect(info.reference).toMatchObject({ head: toy.referenceHead, commits: 2 });
    expect(info.mutants).toEqual(['no-reduce', 'no-reject']);
    expect(readdirSync(info.dir).sort()).toEqual(['MANIFEST.local.json', 'fingerprints.json', 'hidden', 'mutants', 'reference.bundle']);
    const lock = JSON.parse(readFileSync(join(project.dir, 'prds', TOY_PRD, 'evaluator.lock.json'), 'utf8'));
    expect(lock).toMatchObject({ schema: 'mycelink-bench/evaluator-lock@2', project: 'toyshop', prd: TOY_PRD, source_identity_sha256: toy.lock.identity_sha256, reference: { head: toy.referenceHead, commits: 2 }, hidden_tests: 4, mutants: 2 });
    // The committed lock binds every stored file by one digest and counts them; it names none.
    expect(lock.files).toEqual({ fingerprints: 1, hidden: 2, mutant: 2, reference: 1 });
    expect(JSON.stringify(lock)).not.toMatch(/acceptance|reserve|orders|no-reduce|no-reject|\.patch|\.mjs/);
    // The names live beside the store only, for diagnostics.
    const local = JSON.parse(readFileSync(join(info.dir, 'MANIFEST.local.json'), 'utf8'));
    expect(local.files.map((f: any) => f.path)).toEqual(['fingerprints.json', 'hidden/mod-a/test/reserve.acceptance.test.mjs', 'hidden/mod-b/test/orders.acceptance.test.mjs', 'mutants/no-reduce.patch', 'mutants/no-reject.patch', 'reference.bundle']);
    expect(verifyEvaluator({ dir: info.dir, lock })).toEqual({ ok: true, problems: [] });
  });

  it.each([
    ['a hidden branch that modifies an upstream file', (a: string, start: string) => {
      toyGit(a, ['checkout', '-q', '-B', `hidden/${TOY_PRD}`, start]);
      commitFiles(a, { 'mod-a/test/stock.test.mjs': '// changed\n' }, 'bad hidden');
    }, /hidden.*only add/],
    ['a hidden file outside the test paths', (a: string, start: string) => {
      toyGit(a, ['checkout', '-q', '-B', `hidden/${TOY_PRD}`, start]);
      commitFiles(a, { 'mod-a/src/helper.mjs': 'export {};\n' }, 'bad hidden');
    }, /not a test path/],
    ['a reference that does not descend from the frozen commit', (a: string) => {
      toyGit(a, ['checkout', '-q', '--orphan', 'orphan']);
      commitFiles(a, { 'x.txt': 'x\n' }, 'orphan');
      toyGit(a, ['branch', '-f', `reference/${TOY_PRD}`, 'orphan']);
    }, /reference.*descend/],
    ['a mutant that changes a test', (a: string) => {
      toyGit(a, ['checkout', '-q', '-B', `mutant/${TOY_PRD}/weaker`, `reference/${TOY_PRD}`]);
      commitFiles(a, { 'mod-a/test/reserve.test.mjs': '// gone\n' }, 'weakens a test');
    }, /mutant weaker.*production code only/],
  ])('rejects %s', (_label, spoil, message) => {
    const toy = buildToy();
    spoil(toy.authoring, toy.start);
    const project = loadProject(toy.suite, 'toyshop');
    expect(() => importEvaluator({ project, prdId: TOY_PRD, from: toy.authoring, cacheRoot: toy.cacheRoot })).toThrow(message);
  });
});

describe('exportEvaluator / importEvaluatorArchive', () => {
  it('exports the private store as a deterministic archive and re-imports it elsewhere only when it matches the committed lock', () => {
    const { toy, project, info } = imported();
    const out = join(makeTmpDir('bench-ev-export-'), 'toy.zip');
    const exported = exportEvaluator({ cacheRoot: toy.cacheRoot, project, prdId: TOY_PRD, out });
    expect(exported).toMatchObject({ archive: out, digest_sha256: info.lock.digest_sha256, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Deterministic: the same store gives the same bytes.
    const again = exportEvaluator({ cacheRoot: toy.cacheRoot, project, prdId: TOY_PRD, out: join(makeTmpDir('bench-ev-export-'), 'toy.zip') });
    expect(again.sha256).toBe(exported.sha256);
    // Another machine's cache: the archive is accepted against the committed lock and loads.
    const elsewhere = makeTmpDir('bench-ev-cache-');
    const imported2 = importEvaluatorArchive({ cacheRoot: elsewhere, project, prdId: TOY_PRD, archive: out });
    expect(imported2).toMatchObject({ dir: join(elsewhere, 'evaluator', 'toyshop', TOY_PRD), digest_sha256: info.lock.digest_sha256 });
    expect(loadEvaluator({ cacheRoot: elsewhere, project, prdId: TOY_PRD }).hidden.size).toBe(Object.keys(TOY.hidden).length);
    // An archive whose content is not what the lock commits to is refused, and nothing is written.
    const forged = join(makeTmpDir('bench-ev-forged-'), 'forged.zip');
    const bytes = readFileSync(out);
    const at = bytes.indexOf(Buffer.from("status: 'rejected'"));
    expect(at).toBeGreaterThan(0);
    bytes.write("status: 'placed'  ", at);
    writeFileSync(forged, bytes);
    const target = makeTmpDir('bench-ev-cache-');
    expect(() => importEvaluatorArchive({ cacheRoot: target, project, prdId: TOY_PRD, archive: forged })).toThrow(/CRC|lock/);
    expect(existsSync(join(target, 'evaluator'))).toBe(false);
  });
});

describe('verifyEvaluator / loadEvaluator', () => {
  it('fails closed when a stored artifact is tampered with, added or removed', () => {
    const { project, info } = imported();
    const lock = JSON.parse(readFileSync(join(project.dir, 'prds', TOY_PRD, 'evaluator.lock.json'), 'utf8'));
    const hiddenFile = join(info.dir, 'hidden', 'mod-a', 'test', 'reserve.acceptance.test.mjs');
    const original = readFileSync(hiddenFile);
    writeFileSync(hiddenFile, Buffer.concat([original, Buffer.from('\n// weakened\n')]));
    expect(verifyEvaluator({ dir: info.dir, lock }).problems).toEqual(['hidden/mod-a/test/reserve.acceptance.test.mjs: content does not match the lock']);
    writeFileSync(hiddenFile, original);
    writeFileSync(join(info.dir, 'mutants', 'extra.patch'), 'x');
    expect(verifyEvaluator({ dir: info.dir, lock }).problems).toEqual(['mutants/extra.patch: not in the lock']);
    rmSync(join(info.dir, 'mutants', 'extra.patch'));
    rmSync(join(info.dir, 'reference.bundle'));
    expect(verifyEvaluator({ dir: info.dir, lock }).problems).toEqual(['reference.bundle: missing']);
    expect(() => loadEvaluator({ cacheRoot: join(info.dir, '..', '..', '..'), project, prdId: TOY_PRD })).toThrow(/evaluator artifacts .* do not match/);
  });

  it('stays fail-closed when the local manifest is gone or forged: only the diagnostics degrade', () => {
    const { project, info } = imported();
    const lock = JSON.parse(readFileSync(join(project.dir, 'prds', TOY_PRD, 'evaluator.lock.json'), 'utf8'));
    const manifest = join(info.dir, 'MANIFEST.local.json');
    rmSync(manifest);
    expect(verifyEvaluator({ dir: info.dir, lock })).toEqual({ ok: true, problems: [] });
    writeFileSync(join(info.dir, 'mutants', 'extra.patch'), 'x');
    expect(verifyEvaluator({ dir: info.dir, lock }).problems).toEqual(['the stored files do not match the committed lock digest (fingerprints 1, hidden 2, mutant 3, reference 1; locked fingerprints 1, hidden 2, mutant 2, reference 1)']);
    // A manifest rewritten to describe the tampered store does not match the committed digest either.
    writeFileSync(manifest, JSON.stringify({ schema: 'mycelink-bench/evaluator-manifest@1', files: [] }));
    expect(verifyEvaluator({ dir: info.dir, lock }).ok).toBe(false);
  });

  it('fingerprints the reference’s substantial production code, not its one-line edits, and the leakage scan names it', () => {
    const toy = buildToy();
    // A reference that adds a whole production module besides its one-line edits.
    const ledger = 'export class Ledger {\n  #rows = [];\n  add(row) {\n    this.#rows.push(row);\n    return this.#rows.length;\n  }\n  get size() {\n    return this.#rows.length;\n  }\n}\n';
    toyGit(toy.authoring, ['checkout', '-q', `reference/${TOY_PRD}`]);
    const head = commitFiles(toy.authoring, { 'mod-a/src/ledger.mjs': ledger }, 'feat: a ledger');
    for (const id of Object.keys(TOY.mutants)) {
      toyGit(toy.authoring, ['checkout', '-q', '-B', `mutant/${TOY_PRD}/${id}`, head]);
      commitFiles(toy.authoring, TOY.mutants[id as keyof typeof TOY.mutants], `mutant ${id}`);
    }
    toyGit(toy.authoring, ['checkout', '-q', 'main']);
    const project = loadProject(toy.suite, 'toyshop');
    importEvaluator({ project, prdId: TOY_PRD, from: toy.authoring, cacheRoot: toy.cacheRoot });
    const ev = loadEvaluator({ cacheRoot: toy.cacheRoot, project, prdId: TOY_PRD });
    const ledgerBlob = gitBlobSha(Buffer.from(ledger));
    expect(ev.fingerprints.production).toEqual(new Set([ledgerBlob]));
    expect(ev.fingerprints.blobs.has(ledgerBlob)).toBe(true);
    // The one-line edits an independent delivery may well reproduce byte for byte are not fingerprinted.
    expect(ev.fingerprints.blobs.has(gitBlobSha(Buffer.from(TOY.referenceCode['mod-a/src/stock.mjs'])))).toBe(false);
    // A delivery that carries the reference's module verbatim is named — as convergence, which alone proves nothing.
    const repo = join(makeTmpDir('bench-ev-leak-'), 'repo');
    toyGit(toy.upstream, ['branch', '-f', 'leaky', 'HEAD']);
    toyGit(join(repo, '..'), ['clone', '-q', '-b', 'leaky', toy.upstream, repo]);
    commitFiles(repo, { 'mod-a/src/ledger.mjs': ledger }, 'feat: a ledger');
    const leak = inspectLeakage({ repo, start: toy.start, head: toyGit(repo, ['rev-parse', 'HEAD']), workspace: repo, fingerprints: ev.fingerprints });
    expect(leak.checks.find((c: any) => c.id === 'no-evaluator-blobs').ok).toBe(true);
    const check = leak.checks.find((c: any) => c.id === 'reference-convergence');
    expect(check).toMatchObject({ ok: false, severity: 'warning' });
    expect(check.detail).toMatch(/mod-a\/src\/ledger\.mjs \(reference production\)/);
  });

  it('loads the overlay, the mutants and the leakage fingerprints, and unbundles the reference onto the frozen commit', async () => {
    const { toy, project } = imported();
    const ev = loadEvaluator({ cacheRoot: toy.cacheRoot, project, prdId: TOY_PRD });
    expect([...ev.hidden.keys()].sort()).toEqual(Object.keys(TOY.hidden).sort());
    expect([...ev.mutants.keys()]).toEqual(['no-reduce', 'no-reject']);
    expect(ev.fingerprints.paths).toEqual(new Set(Object.keys(TOY.hidden)));
    for (const body of [...Object.values(TOY.hidden), ...Object.values(TOY.referenceTests)]) expect(ev.fingerprints.blobs.has(gitBlobSha(Buffer.from(body)))).toBe(true);
    expect(ev.fingerprints.blobs.has(gitBlobSha(Buffer.from(TOY.upstream['mod-a/test/stock.test.mjs'])))).toBe(false);
    const repo = join(makeTmpDir('bench-ev-'), 'repo');
    await importSource({ lock: toy.lock, bundlePath: toy.bundle, target: repo });
    expect(unbundleReference({ evaluator: ev, repo })).toBe(toy.referenceHead);
    expect(existsSync(join(repo, 'mod-a', 'test', 'reserve.test.mjs'))).toBe(false);
  });
});
