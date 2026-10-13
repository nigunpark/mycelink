/**
 * Leakage proof: what only the evaluator holds fails a delivery, a solution
 * that merely converged on the reference does not.
 *
 * The first real pilot (PCM-101) marked an honest, isolated without arm as
 * leaking because it wrote a record, two seed SQL files and a mock bean
 * byte for byte as the reference did: the public requirement and the
 * upstream conventions dictate them. Proof is now what an independent
 * delivery cannot produce: the hidden tests, any stored evaluator file
 * (the reference bundle, a mutant, expected.json, the fingerprints), the
 * reference's own commits in any object store, or a test file of the
 * reference carrying tests its author added. Everything else the reference
 * holds — its production code, test support it changed without adding a
 * test — is reported as convergence, a warning, and fails only when the
 * run's transcripts independently show evaluator access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { CONVERGENT_REFERENCE, LEDGER, SUPPORT, TOY, TOY_PRD, commitFiles, preparedToy, toyGit, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { loadEvaluator } from '../../evals-public-projects/lib/evaluator.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { inspectLeakage } from '../../evals-public-projects/lib/leakage.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { verifyDelivery } from '../../evals-public-projects/lib/verify.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { buildWorkspace } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { runArm } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));

let toy: Toy;
let project: any;
let prd: any;
let ev: any;

beforeAll(async () => {
  ({ toy, project, prd } = await preparedToy(CONVERGENT_REFERENCE));
  ev = loadEvaluator({ cacheRoot: toy.cacheRoot, project, prdId: TOY_PRD });
}, 300_000);

async function delivered(): Promise<{ ws: string; repo: string; home: string }> {
  const ws = join(makeTmpDir('bench-lk-ws-'), 'ws');
  const home = makeTmpDir('bench-lk-home-');
  await buildWorkspace({ project, prd, target: ws, home, cacheRoot: toy.cacheRoot });
  const repo = join(ws, 'repos', 'toyshop');
  commitFiles(repo, AGENT_TESTS, 'test: stock reservation and orders (failing)');
  commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
  return { ws, repo, home };
}

const leak = (d: { ws: string; repo: string }, extra: Record<string, unknown> = {}) =>
  inspectLeakage({ repo: d.repo, start: toy.start, head: toyGit(d.repo, ['rev-parse', 'HEAD']), workspace: d.ws, fingerprints: ev.fingerprints, ...extra });
const failedIds = (r: any) => r.checks.filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => c.id);
const warnedIds = (r: any) => r.checks.filter((c: any) => !c.ok && c.severity === 'warning').map((c: any) => c.id);
const detail = (r: any, id: string) => r.checks.find((c: any) => c.id === id)?.detail ?? '';

describe('honest convergence is named, never proof', () => {
  it('passes an independent delivery with nothing of the reference in it', async () => {
    const r = leak(await delivered());
    expect(failedIds(r)).toEqual([]);
    expect(warnedIds(r)).toEqual([]);
    expect(r.checks.map((c: any) => c.id)).toEqual(['no-overlay-collision', 'no-evaluator-blobs', 'no-evaluator-files', 'no-reference-history', 'reference-convergence']);
  });

  it('warns about a production file byte-identical to the reference’s, and fails nothing', async () => {
    const d = await delivered();
    commitFiles(d.repo, { 'mod-a/src/ledger.mjs': LEDGER }, 'feat: a ledger');
    const r = leak(d);
    expect(failedIds(r)).toEqual([]);
    expect(warnedIds(r)).toEqual(['reference-convergence']);
    expect(detail(r, 'reference-convergence')).toMatch(/mod-a\/src\/ledger\.mjs \(reference production\)/);
    expect(detail(r, 'reference-convergence')).toMatch(/not proof/);
  });

  it('warns about an upstream test changed exactly as the reference changed it when that adds no test', async () => {
    const d = await delivered();
    commitFiles(d.repo, SUPPORT, 'test: a note on the stock tests');
    const r = leak(d);
    expect(failedIds(r)).toEqual([]);
    expect(warnedIds(r)).toEqual(['reference-convergence']);
    expect(detail(r, 'reference-convergence')).toMatch(/mod-a\/test\/stock\.test\.mjs \(reference test support\)/);
  });

  it('verifies a test-first delivery that converged on the reference, with the convergence on record', async () => {
    const ws = join(makeTmpDir('bench-lk-ws-'), 'ws');
    const home = makeTmpDir('bench-lk-home-');
    await buildWorkspace({ project, prd, target: ws, home, cacheRoot: toy.cacheRoot });
    const repo = join(ws, 'repos', 'toyshop');
    commitFiles(repo, { ...AGENT_TESTS, ...SUPPORT }, 'test: stock reservation and orders (failing)');
    commitFiles(repo, { ...TOY.referenceCode, 'mod-a/src/ledger.mjs': LEDGER }, 'feat: orders reserve stock, with a ledger');
    const v = await verifyDelivery({ suiteRoot: toy.suite, caseKey: TOY_PRD, workspace: ws, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-lk-v-'), isolation: TEST_ISOLATION, requireTdd: true, scanRoots: [home] });
    expect(v.errors).toEqual([]);
    expect(v.sections.leakage.ok).toBe(true);
    expect(warnedIds(v.sections.leakage)).toEqual(['reference-convergence']);
    expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid']);
    expect(v.ok).toBe(true);
  }, 240_000);
});

describe('evaluator artifacts are proof, however they got in', () => {
  it('fails hidden tests smuggled into the history, even deleted again', async () => {
    const d = await delivered();
    commitFiles(d.repo, { 'mod-a/test/extra.test.mjs': TOY.hidden['mod-a/test/reserve.acceptance.test.mjs'] }, 'test: more');
    rmSync(join(d.repo, 'mod-a', 'test', 'extra.test.mjs'));
    toyGit(d.repo, ['commit', '-q', '-am', 'test: fewer']);
    const r = leak(d);
    expect(failedIds(r)).toEqual(['no-evaluator-blobs']);
    expect(detail(r, 'no-evaluator-blobs')).toMatch(/mod-a\/test\/extra\.test\.mjs \(hidden test\)/);
  });

  it('fails the reference’s own tests copied verbatim: they carry tests its author added', async () => {
    const d = await delivered();
    commitFiles(d.repo, { 'mod-b/test/place.test.mjs': TOY.referenceTests['mod-b/test/place.test.mjs'] }, 'test: placing');
    const r = leak(d);
    expect(failedIds(r)).toEqual(['no-evaluator-blobs', 'no-evaluator-files']);
    expect(detail(r, 'no-evaluator-blobs')).toMatch(/mod-b\/test\/place\.test\.mjs \(the reference's own tests: placing an order returns the remaining stock, placing too large an order is rejected\)/);
  });

  it('fails the reference’s tests kept outside git, in the workspace or HOME', async () => {
    const d = await delivered();
    mkdirSync(join(d.home, '.tmp'), { recursive: true });
    writeFileSync(join(d.home, '.tmp', 'peek.mjs'), TOY.referenceTests['mod-a/test/reserve.test.mjs']);
    expect(failedIds(leak(d))).toEqual([]);
    const r = leak(d, { roots: [d.ws, d.home] });
    expect(failedIds(r)).toEqual(['no-evaluator-files']);
    expect(detail(r, 'no-evaluator-files')).toContain(join(d.home, '.tmp', 'peek.mjs'));
  });

  it('fails the reference bundle unbundled into the delivered repository, no ref needed', async () => {
    const d = await delivered();
    toyGit(d.repo, ['bundle', 'unbundle', ev.referenceBundle]);
    const r = leak(d);
    expect(failedIds(r)).toEqual(['no-reference-history']);
    expect(detail(r, 'no-reference-history')).toMatch(new RegExp(`the reference commit ${ev.lock.reference.head.slice(0, 12)}`));
  });

  it('fails the reference fetched into a scratch repository in HOME', async () => {
    const d = await delivered();
    const scratch = join(d.home, '.tmp', 'scratch');
    toyGit(d.home, ['clone', '-q', '--bare', d.repo, scratch]);
    toyGit(scratch, ['bundle', 'unbundle', ev.referenceBundle]);
    expect(failedIds(leak(d, { roots: [d.ws, d.home] }))).toEqual(['no-reference-history']);
  });

  it('fails any stored evaluator file, copied anywhere or committed', async () => {
    const stored = ['reference.bundle', join('mutants', 'no-reduce.patch'), 'expected.json', 'fingerprints.json'];
    for (const file of stored) {
      const d = await delivered();
      copyFileSync(join(ev.dir, file), join(d.home, 'copy.bin'));
      const r = leak(d, { roots: [d.ws, d.home] });
      expect(failedIds(r), file).toEqual(['no-evaluator-files']);
      expect(detail(r, 'no-evaluator-files'), file).toMatch(/evaluator store/);
    }
    const d = await delivered();
    commitFiles(d.repo, { 'mod-a/fixtures/no-reduce.patch': readFileSync(join(ev.dir, 'mutants', 'no-reduce.patch'), 'utf8') }, 'chore: notes');
    expect(failedIds(leak(d))).toEqual(['no-evaluator-blobs', 'no-evaluator-files']);
    expect(detail(leak(d), 'no-evaluator-blobs')).toMatch(/mod-a\/fixtures\/no-reduce\.patch \(evaluator store: mutants\/no-reduce\.patch\)/);
  });
});

describe('convergence corroborated by evaluator access', () => {
  const access = [{ file: 'session.jsonl', line: 7, tool: 'Read', root: '/cache/evaluator', path: '/cache/evaluator/toyshop/TOY-001/reference.bundle' }];

  it('fails reference content when the transcripts show evaluator access', async () => {
    const d = await delivered();
    commitFiles(d.repo, { 'mod-a/src/ledger.mjs': LEDGER }, 'feat: a ledger');
    const r = leak(d, { access });
    expect(failedIds(r)).toEqual(['reference-convergence']);
    expect(detail(r, 'reference-convergence')).toMatch(/corroborated by evaluator access: session\.jsonl:7/);
  });

  it('does not turn an independent delivery into a leak', async () => {
    expect(failedIds(leak(await delivered(), { access }))).toEqual([]);
  });

  it('fails the verdict through verifyDelivery', async () => {
    const d = await delivered();
    commitFiles(d.repo, { 'mod-a/src/ledger.mjs': LEDGER }, 'feat: a ledger');
    const v = await verifyDelivery({ suiteRoot: toy.suite, caseKey: TOY_PRD, workspace: d.ws, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-lk-v-'), isolation: TEST_ISOLATION, tdd: false, access });
    expect(v.sections.leakage.ok).toBe(false);
    expect(v.ok).toBe(false);
  }, 240_000);
});

describe('an arm run', () => {
  const FAKE = join(REPO_ROOT, 'tests', 'benchmark', 'fake-claude.mjs');
  let echo: net.Server;
  let PROXY: { allowed: string; denied: string };
  beforeAll(async () => {
    echo = net.createServer((c) => c.end('echo'));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    PROXY = { allowed: `127.0.0.1:${(echo.address() as net.AddressInfo).port}`, denied: 'example.invalid:443' };
  });
  afterAll(() => echo?.close());
  const run = (plan: Record<string, unknown>) => {
    const dir = makeTmpDir('bench-lk-fake-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const file = join(dir, 'plan.json');
    writeFileSync(file, JSON.stringify({ log, tests: { ...AGENT_TESTS, ...SUPPORT }, code: { ...TOY.referenceCode, 'mod-a/src/ledger.mjs': LEDGER }, regression: {}, ...plan }));
    return runArm({
      suiteRoot: toy.suite,
      caseKey: TOY_PRD,
      arm: 'without',
      outDir: join(makeTmpDir('bench-lk-run-'), 'run'),
      cacheRoot: toy.cacheRoot,
      claude: [process.execPath, FAKE],
      pollMs: 100,
      env: { FAKE_CLAUDE_PLAN: file },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
      preflightProxy: PROXY,
      proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
      requireTdd: true,
    });
  };

  it('passes a delivery that converged on the reference, its HOME scanned too', async () => {
    const r = await run({});
    const v = JSON.parse(readFileSync(r.verification, 'utf8'));
    expect(v.sections.leakage.ok).toBe(true);
    expect(warnedIds(v.sections.leakage)).toEqual(['reference-convergence']);
    expect(v.sections.leakage.checks.find((c: any) => c.id === 'no-evaluator-files').detail).toBe('no evaluator-only content in the workspace');
    expect(r.evaluator_access.hits).toEqual([]);
    expect(r.ok).toBe(true);
  }, 240_000);

  it('fails it, corroborated, when a transcript shows evaluator access', async () => {
    const r = await run({ peek: [`cat ${join(toy.cacheRoot, 'evaluator', 'toyshop', TOY_PRD, 'reference.bundle').replace(/\\/g, '/')}`] });
    expect(r.evaluator_access.hits.length).toBeGreaterThan(0);
    const v = JSON.parse(readFileSync(r.verification, 'utf8'));
    expect(failedIds(v.sections.leakage)).toEqual(['reference-convergence']);
    expect(r.ok).toBe(false);
  }, 240_000);
});
