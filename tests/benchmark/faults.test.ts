/**
 * Evaluator fault injection for the fault-injected arms, model-free.
 *
 * - concurrent-commit: a teammate's commit lands on the delivery branch
 *   while the agent works (the working tree keeps its own changes); the
 *   delivery must contain it (no lost update);
 * - late-hidden-defect: after the agent's delivery, a regression commit
 *   lands and QA reports the failing check; the repair must keep it in the
 *   history and pass;
 * - duplicate-result / stale-result: a Mycelink settle the host already ran
 *   is replayed with its spent capability; Mycelink must refuse it and keep
 *   its state;
 * - interrupt-restart: the session was killed and a fresh one resumed.
 *
 * Injected commits are the evaluator's: they count toward neither the
 * delivered scope nor the TDD replay.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { TOY, TOY_PRD, commitFiles, toyGit, preparedToy, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { RESUME_PROMPT, REWORK_INSTRUCTION, boundInjections, injectConcurrentCommit, injectLateDefect, injectedEffects, inspectFaults, lateDefectPatch, lateDefectPrompt, replaySettles, resumeInjectionSync, resumePrompt, settleCommandsFromTranscript } from '../../evals-public-projects/lib/faults.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { inspectScope } from '../../evals-public-projects/lib/scope.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { verifyDelivery } from '../../evals-public-projects/lib/verify.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadEvaluator } from '../../evals-public-projects/lib/evaluator.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { buildWorkspace } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { MYCELINK_BIN, nodeId, orchestrate, rework as reworkFeature } from '../../evals-public-projects/tools/mycelink-fixture.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { mycelinkSummary } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { artifactDigest, checkoutPluginArtifact } from '../../evals-public-projects/lib/plugin.mjs';

afterAll(() => cleanupTmpRoots());

let toy: Toy;
let project: any;
let prd: any;
const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));

beforeAll(async () => {
  ({ toy, project, prd } = await preparedToy());
}, 300_000);

async function workspace() {
  const ws = join(makeTmpDir('bench-f-ws-'), 'ws');
  await buildWorkspace({ project, prd, target: ws, home: makeTmpDir('bench-f-home-'), cacheRoot: toy.cacheRoot });
  return { ws, repo: join(ws, 'repos', 'toyshop') };
}
const verify = (ws: string, faults: any[], extra: Record<string, unknown> = {}) =>
  verifyDelivery({ suiteRoot: toy.suite, caseKey: TOY_PRD, workspace: ws, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-f-work-'), faults, isolation: TEST_ISOLATION, ...extra });
/** Failed checks of every section that counts toward the verdict (orchestration only when required). */
const failedIds = (r: any) =>
  Object.entries(r.sections ?? {})
    .filter(([name, s]: [string, any]) => name !== 'orchestration' || s?.required)
    .flatMap(([, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => c.id));

describe('concurrent-commit', () => {
  it('lands a teammate commit on the branch the agent works on, keeping the agent’s uncommitted work', async () => {
    const { repo } = await workspace();
    commitFiles(repo, AGENT_TESTS, 'test: first');
    writeFileSync(join(repo, 'mod-a', 'src', 'stock.mjs'), TOY.referenceCode['mod-a/src/stock.mjs']);
    const record = injectConcurrentCommit({ repo, branch: 'main', path: 'README.md', content: '# toyshop\n\nA teammate edited this.\n', message: 'docs: teammate change' });
    expect(record).toMatchObject({ kind: 'concurrent-commit', branch: 'main', path: 'README.md' });
    expect(toyGit(repo, ['rev-parse', 'HEAD'])).toBe(record.commit);
    expect(toyGit(repo, ['log', '-1', '--format=%s'])).toBe('docs: teammate change');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('teammate');
    // The agent's own uncommitted change is still there, and nothing else is reported dirty.
    expect(toyGit(repo, ['status', '--porcelain'])).toBe('M mod-a/src/stock.mjs');
  });

  it('journals the teammate commit as soon as it lands, and finishes a sync a locked index refused without a second commit', async () => {
    const { ws, repo } = await workspace();
    const start = toyGit(repo, ['rev-parse', 'HEAD']);
    commitFiles(repo, AGENT_TESTS, 'test: first');
    // The agent's git holds the index while the teammate commit lands.
    const lock = join(repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    const journal: any[] = [];
    let error: any = null;
    try {
      injectConcurrentCommit({ repo, branch: 'main', path: 'TEAM-NOTES.md', content: '# Team notes\n', message: 'docs: team notes', journal: (r: any) => journal.push({ ...r }) });
    } catch (e) {
      error = e;
    }
    expect(error?.message).toMatch(/index/);
    expect(journal).toHaveLength(1);
    const record = journal[0];
    expect(record).toMatchObject({ kind: 'concurrent-commit', applied: true, sync: 'pending', path: 'TEAM-NOTES.md' });
    expect(toyGit(repo, ['rev-parse', 'HEAD'])).toBe(record.commit);
    // Retrying while the lock is still held changes nothing; once it is gone the sync completes.
    expect(() => resumeInjectionSync({ repo, record })).toThrow(/index/);
    rmSync(lock);
    const synced = resumeInjectionSync({ repo, record });
    expect(synced).toMatchObject({ commit: record.commit, sync: 'done' });
    expect(toyGit(repo, ['log', '--format=%an', `${start}..HEAD`]).split('\n').filter((a: string) => a === 'Platform Teammate')).toHaveLength(1);
    expect(toyGit(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
    const r = await verify(ws, [synced]);
    expect(failedIds(r)).toEqual([]);
    expect(r.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid']);
  }, 180_000);

  it('excludes from scope and TDD only commits whose record matches them exactly', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, AGENT_TESTS, 'test: first');
    const record = injectConcurrentCommit({ repo, branch: 'main', path: 'TEAM-NOTES.md', content: '# Team notes\n', message: 'docs: team notes' });
    expect(record).toMatchObject({ sync: 'done', parent: expect.stringMatching(/^[0-9a-f]{40}$/), tree: expect.stringMatching(/^[0-9a-f]{40}$/), binding_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(record.changes).toEqual([{ path: 'TEAM-NOTES.md', blob: toyGit(repo, ['rev-parse', `${record.commit}:TEAM-NOTES.md`]) }]);
    // The agent's own out-of-scope commit (the PRD allows no change to LICENSE), passed off as an injection.
    commitFiles(repo, { LICENSE: 'Relicensed by the agent\n', ...TOY.referenceCode }, 'feat: orders reserve stock (and a new license)');
    const agentCommit = toyGit(repo, ['rev-parse', 'HEAD']);
    const forged = { ...record, commit: agentCommit, parent: toyGit(repo, ['rev-parse', 'HEAD~1']) };
    const r = await verify(ws, [record, forged]);
    expect(failedIds(r)).toEqual(expect.arrayContaining(['fault:concurrent-commit:bound', 'scope-allowed']));
    expect(r.sections.faults.checks.filter((c: any) => c.id === 'fault:concurrent-commit:bound').map((c: any) => c.ok)).toEqual([true, false]);
    // A genuine record whose content was edited afterwards no longer binds its commit either.
    const edited = { ...record, changes: [{ path: 'TEAM-NOTES.md', blob: 'f'.repeat(40) }] };
    expect(boundInjections({ repo, records: [edited] }).commits.size).toBe(0);
    expect(boundInjections({ repo, records: [record] }).commits).toEqual(new Set([record.commit]));
  }, 180_000);

  it('accepts a delivery that keeps the teammate commit and rejects one that drops it', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, AGENT_TESTS, 'test: first');
    const record = injectConcurrentCommit({ repo, branch: 'main', path: 'README.md', content: '# toyshop\n\nA teammate edited this.\n', message: 'docs: teammate change' });
    commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
    const good = await verify(ws, [record]);
    expect(failedIds(good)).toEqual([]);
    expect(good.ok).toBe(true);
    // The injected commit is neither the agent's scope nor its TDD: the agent's cycle still replays.
    expect(good.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid']);

    toyGit(repo, ['rebase', '-q', '--onto', `${record.commit}~1`, record.commit]);
    const lost = await verify(ws, [record]);
    expect(lost.ok).toBe(false);
    expect(failedIds(lost)).toContain('fault:concurrent-commit:kept');
  }, 180_000);
});

describe('fault-owned changes are not the delivery’s scope', () => {
  const NOTE = { path: 'TEAM-NOTES.md', content: '# Team notes\n\n- The nightly build now runs at 02:00 UTC.\n', message: 'docs: team notes' };
  const scopeOf = (repo: string, records: any[]) => {
    const head = toyGit(repo, ['rev-parse', 'HEAD']);
    return inspectScope({ repo, start: project.lock.commit, head, adapter: project.adapter, prd: prd.manifest, injected: injectedEffects({ repo, head, records }) });
  };
  const check = (r: any, id: string) => r.checks.find((c: any) => c.id === id);

  /** The third pilot's shape: the teammate commit lands on main while a node works on its branch; the node is then merged in. */
  async function integrated() {
    const { ws, repo } = await workspace();
    toyGit(repo, ['checkout', '-q', '-b', 'wip/node']);
    commitFiles(repo, AGENT_TESTS, 'test: first');
    commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
    toyGit(repo, ['checkout', '-q', 'main']);
    const record = injectConcurrentCommit({ repo, branch: 'main', ...NOTE });
    toyGit(repo, ['merge', '-q', '--no-ff', '-m', 'integrate wip/node', 'wip/node']);
    return { ws, repo, record };
  }

  it('leaves out a teammate commit a merge brought in, while the note is byte for byte as injected', async () => {
    const { repo, record } = await integrated();
    // The merge differs from its node-side parent in TEAM-NOTES.md: it touches the path, but it changed nothing itself.
    expect(toyGit(repo, ['log', '--full-history', '--format=%s', `${project.lock.commit}..HEAD`, '--', 'TEAM-NOTES.md']).split('\n')).toEqual(['integrate wip/node', 'docs: team notes']);
    const r = scopeOf(repo, [record]);
    expect(check(r, 'scope-allowed')).toMatchObject({ ok: true });
    expect(check(r, 'fault-owned:TEAM-NOTES.md')).toMatchObject({ ok: true, severity: 'warning', detail: expect.stringContaining(record.commit.slice(0, 12)) });
    expect(r.facts.fault_owned).toEqual([`TEAM-NOTES.md (concurrent-commit ${record.commit.slice(0, 12)})`]);
    expect(r.facts.changed).not.toContain('A TEAM-NOTES.md');
  }, 180_000);

  it('counts the note as the delivery’s once the agent edits it, even if a later commit restores it', async () => {
    const { repo, record } = await integrated();
    commitFiles(repo, { [NOTE.path]: '# Team notes\n\nEdited by the agent.\n' }, 'docs: notes');
    expect(check(scopeOf(repo, [record]), 'scope-allowed')).toMatchObject({ ok: false, detail: expect.stringContaining('TEAM-NOTES.md (outside every module)') });
    commitFiles(repo, { [NOTE.path]: NOTE.content }, 'docs: notes as they were');
    const restored = scopeOf(repo, [record]);
    expect(check(restored, 'scope-allowed')).toMatchObject({ ok: false, detail: expect.stringMatching(/TEAM-NOTES\.md \(outside every module, in commit [0-9a-f]{12}\)/) });
  }, 180_000);

  it('counts it when the injected commit was dropped and the note re-created, or the record no longer binds', async () => {
    const { repo } = await workspace();
    commitFiles(repo, AGENT_TESTS, 'test: first');
    const record = injectConcurrentCommit({ repo, branch: 'main', ...NOTE });
    commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
    const edited = { ...record, changes: [{ path: NOTE.path, blob: 'f'.repeat(40) }] };
    expect(check(scopeOf(repo, [record]), 'scope-allowed').ok).toBe(true);
    expect(check(scopeOf(repo, [edited]), 'scope-allowed').ok).toBe(false);
    expect(check(scopeOf(repo, [{ ...record, applied: false }]), 'scope-allowed').ok).toBe(false);
    // Rebased away, then written again by the agent with the very same bytes.
    toyGit(repo, ['rebase', '-q', '--onto', `${record.commit}~1`, record.commit]);
    commitFiles(repo, { [NOTE.path]: NOTE.content }, 'docs: team notes');
    const head = toyGit(repo, ['rev-parse', 'HEAD']);
    expect(injectedEffects({ repo, head, records: [record] })).toEqual({ commits: new Set(), changes: [] });
    expect(check(scopeOf(repo, [record]), 'scope-allowed')).toMatchObject({ ok: false, detail: expect.stringContaining('TEAM-NOTES.md') });
  }, 180_000);

  it('judges a repaired late defect by the delivered product: the repair is the delivery’s production change', async () => {
    const { repo } = await workspace();
    const start = project.lock.commit;
    commitFiles(repo, AGENT_TESTS, 'test: first');
    commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
    const defect = lateDefectPatch({ repo, start, head: toyGit(repo, ['rev-parse', 'HEAD']), adapter: project.adapter, prd: prd.manifest });
    const record = injectLateDefect({ repo, branch: 'main', patch: defect.patch, message: 'chore: sync platform changes' });
    // Unrepaired, the product has no production change in mod-a: that is the product, not the fault's scope.
    const unrepaired = scopeOf(repo, [record]);
    expect(check(unrepaired, 'scope-required:mod-a')).toMatchObject({ ok: false });
    commitFiles(repo, { 'mod-a/test/regression.test.mjs': `${AGENT_TESTS['mod-a/test/reserve.test.mjs']}\n` }, 'test: regression for the QA report');
    commitFiles(repo, { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] }, 'fix: reserve takes the quantity out again');
    const repaired = scopeOf(repo, [record]);
    expect(repaired.checks.filter((c: any) => !c.ok && c.severity !== 'warning')).toEqual([]);
    expect(repaired.facts.fault_owned).toEqual([]);
    expect(repaired.facts.by_module['mod-a']).toContain('M mod-a/src/stock.mjs');
  }, 180_000);

  it('the verifier leaves the merged teammate commit out of the delivered scope', async () => {
    const { ws, record } = await integrated();
    const r = await verify(ws, [record]);
    expect(failedIds(r)).toEqual([]);
    expect(r.sections.scope.checks.map((c: any) => c.id)).toContain('fault-owned:TEAM-NOTES.md');
  }, 240_000);
});

describe('late-hidden-defect', () => {
  it('lands a regression on the delivery and names the failing check for QA’s report', async () => {
    const { repo } = await workspace();
    commitFiles(repo, AGENT_TESTS, 'test: first');
    commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
    const ev = loadEvaluator({ cacheRoot: toy.cacheRoot, project, prdId: TOY_PRD });
    const record = injectLateDefect({ repo, branch: 'main', patch: ev.mutants.get('no-reject'), message: 'merge: late change' });
    expect(record).toMatchObject({ kind: 'late-hidden-defect' });
    expect(readFileSync(join(repo, 'mod-b', 'src', 'orders.mjs'), 'utf8')).not.toContain('rejected');
    const prompt = lateDefectPrompt({ commit: record.commit, failures: [{ name: 'an order larger than the stock is rejected', message: 'Expected values to be strictly deep-equal' }] });
    expect(prompt).toContain(record.commit.slice(0, 12));
    expect(prompt).toContain('an order larger than the stock is rejected');
    expect(prompt).not.toMatch(/hidden|mutant|evaluator/i);
    const full = lateDefectPrompt({ commit: record.commit, failures: [{ name: 'x', message: null, status: 'not-run' }], original: 'ORIGINAL PROMPT' });
    expect(full).toContain('- x: not-run');
    expect(full.endsWith('The original request follows.\n\nORIGINAL PROMPT')).toBe(true);
  });

  it('QA’s report is one text for both arms: the same disclosure and affected module, then the plugin’s rework command as the first action, a direct test-first repair only without it', () => {
    const commit = '2145afd34850836d698b3f90c927c9f76c2640e1';
    const failures = [
      { name: 'ac2_ac3_visitWithVetIsCreatedAndExposedEverywhere', message: 'Status expected:<201> but was:<400>\n\tat org.springframework...', status: 'failed' },
      { name: 'ac4_vetWithoutVisitsAnswersEmptyArray', message: null, status: 'did not run (crash)' },
    ];
    const affected = { module: 'visits-service', path: 'spring-petclinic-visits-service', repository: 'repos/petclinic' };
    const prompt = lateDefectPrompt({ commit, failures, affected, original: 'ORIGINAL PROMPT' });
    // The disclosure: the delivered commit, each broken check by name and the first line of its message,
    // and the public module (README's) and repository the defect is in — nothing about how it was made.
    const disclosure = [
      'QA ran its end-to-end checks on the delivered commit 2145afd34850 and found a defect:',
      '',
      '- ac2_ac3_visitWithVetIsCreatedAndExposedEverywhere: Status expected:<201> but was:<400>',
      '- ac4_vetWithoutVisitsAnswersEmptyArray: did not run (crash)',
      '',
      'QA traced the failing checks to the module `visits-service` (`spring-petclinic-visits-service/`) of the repository `repos/petclinic/`.',
      '',
    ].join('\n');
    expect(prompt.startsWith(disclosure)).toBe(true);
    expect(prompt).toBe(`${disclosure}\n${REWORK_INSTRUCTION}\n\nThe original request follows.\n\nORIGINAL PROMPT`);
    expect(prompt.split(REWORK_INSTRUCTION)).toHaveLength(2);
    expect(lateDefectPrompt({ commit, failures, affected })).toBe(`${disclosure}\n${REWORK_INSTRUCTION}`);
    // Without a bound module (no record to derive it from), the line is left out, never guessed.
    expect(lateDefectPrompt({ commit, failures })).not.toMatch(/QA traced/);
    // The first action, front-loaded: the plugin's rework command before anything in the product repository.
    const flat = REWORK_INSTRUCTION.replace(/\s+/g, ' ');
    expect(flat.startsWith('First action, before you read or change anything in the product repository: if the Mycelink plugin is available, invoke its `/mycelink:rework` command with this QA report (or `/mycelink:run` with it, if `/mycelink:rework` is missing).')).toBe(true);
    expect(flat).toMatch(/In that mode this session is the Mycelink controller: do not edit or commit product code in this session yourself\./);
    for (const step of [/`feature status`/, /attributes the failing checks to the producer node/, /`feature rework`/, /`feature owners`/, /`node rework`/, /at most 2000 bytes/, /module-worker subagents/, /settles each/, /cuts a new candidate/, /runs its acceptance and delivers it/, /done only when `feature verify <feature> --delivered` passes/]) {
      expect(flat, String(step)).toMatch(step);
    }
    expect(flat).toMatch(/Only if the Mycelink plugin and its commands are genuinely unavailable in this session, repair it directly on the delivery branch, test-first: commit a failing regression test before the fix/);
    expect(flat.indexOf('/mycelink:rework')).toBeLessThan(flat.indexOf('repair it directly'));
    expect(flat).toMatch(/without rewriting it/);
    expect(prompt).not.toMatch(/hidden|mutant|evaluator|reference|revert|inject/i);
  });

  it('reverts the delivered production change of the first required module, whatever the implementation', async () => {
    const { repo } = await workspace();
    const start = toyGit(repo, ['rev-parse', 'HEAD']);
    commitFiles(repo, AGENT_TESTS, 'test: first');
    // An implementation unlike the reference: the defect must not depend on its shape.
    const own = {
      ...TOY.referenceCode,
      'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  const left = stock - qty;\n  return { stock: left, reserved: qty };\n}\n',
      'mod-a/src/extra.mjs': 'export const unit = 1;\n',
    };
    commitFiles(repo, own, 'feat: orders reserve stock');
    const head = toyGit(repo, ['rev-parse', 'HEAD']);
    const defect = lateDefectPatch({ repo, start, head, adapter: project.adapter, prd: prd.manifest });
    expect(defect).toMatchObject({ module: 'mod-a', paths: ['mod-a/src/extra.mjs', 'mod-a/src/stock.mjs'] });
    const record = injectLateDefect({ repo, branch: 'main', patch: defect.patch, message: 'chore: sync platform changes' });
    expect(record.paths).toEqual(['mod-a/src/extra.mjs', 'mod-a/src/stock.mjs']);
    expect(readFileSync(join(repo, 'mod-a', 'src', 'stock.mjs'), 'utf8')).toBe(TOY.upstream['mod-a/src/stock.mjs']);
    expect(toyGit(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(toyGit(repo, ['ls-files', 'mod-a/src'])).toBe('mod-a/src/stock.mjs');
    // Tests are not touched; a delivery without a production change has nothing to break.
    expect(toyGit(repo, ['diff', '--name-only', head, record.commit])).not.toContain('test');
    expect(lateDefectPatch({ repo, start, head: start, adapter: project.adapter, prd: prd.manifest })).toBeNull();
    // Reverting declarations changes no behaviour: the defect goes to the first module with runtime tests.
    const declared = { ...project.adapter, modules: project.adapter.modules.map((m: any) => (m.id === 'mod-a' ? { ...m, runtime_tests: false } : m)) };
    expect(lateDefectPatch({ repo, start, head, adapter: declared, prd: prd.manifest })).toMatchObject({ module: 'mod-b', paths: ['mod-b/src/orders.mjs'] });
  });

  it('accepts a repair that keeps the defect commit in the history, and rejects one that rewrites it away or leaves the defect', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, AGENT_TESTS, 'test: first');
    commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
    const ev = loadEvaluator({ cacheRoot: toy.cacheRoot, project, prdId: TOY_PRD });
    const record = injectLateDefect({ repo, branch: 'main', patch: ev.mutants.get('no-reject'), message: 'merge: late change' });
    const unrepaired = await verify(ws, [record], { tdd: false });
    expect(failedIds(unrepaired)).toContain('hidden:AC-2 an order larger than the stock is rejected');

    commitFiles(repo, { 'mod-b/test/regression.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { placeOrder } from '../src/orders.mjs';\ntest('rejects an order larger than the stock', () => {\n  assert.equal(placeOrder(1, 2).status, 'rejected');\n});\n" }, 'test: regression for the late defect');
    commitFiles(repo, { 'mod-b/src/orders.mjs': TOY.referenceCode['mod-b/src/orders.mjs'] }, 'fix: reject orders larger than the stock again');
    const repaired = await verify(ws, [record]);
    expect(failedIds(repaired)).toEqual([]);
    expect(repaired.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid']);

    toyGit(repo, ['checkout', '-q', '-B', 'main', `${record.commit}~1`]);
    commitFiles(repo, { 'README.md': '# toyshop\n' }, 'unrelated');
    const rewritten = await verify(ws, [record], { tdd: false });
    expect(failedIds(rewritten)).toContain('fault:late-hidden-defect:kept');
  }, 240_000);
});

describe('the TDD replay sees through exactly the bound injections (the fourth pilot)', () => {
  const NOTE = { path: 'TEAM-NOTES.md', content: '# Team notes\n\n- The nightly build now runs at 02:00 UTC.\n', message: 'docs: team notes' };
  const TEAMMATE = { GIT_AUTHOR_NAME: 'Platform Teammate', GIT_AUTHOR_EMAIL: 'teammate@workspace.invalid', GIT_COMMITTER_NAME: 'Platform Teammate', GIT_COMMITTER_EMAIL: 'teammate@workspace.invalid' };
  const REGRESSION = { 'mod-a/test/reserve.test.mjs': `${AGENT_TESTS['mod-a/test/reserve.test.mjs']}test('reserving two takes two out of the stock', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });\n});\n` };
  const FIX = { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] };
  /** Each unit's verdict and its commits by subject. */
  const units = (repo: string, r: any) => r.sections.tdd.units.map((u: any) => [u.verdict, u.commits.map((c: string) => toyGit(repo, ['log', '-1', '--format=%s', c]))]);
  const DELIVERED_UNITS = [
    ['valid', ['test(mod-a): reserve', 'feat(mod-a): reserve']],
    ['valid', ['test(mod-b): place', 'feat(mod-b): place']],
  ];

  /**
   * The fourth pilot's history up to QA's report: the visits analogue (mod-a) on its node branch, merged after the
   * teammate's commit landed on main; the gateway analogue (mod-b) on main; C001 delivered; then the late defect,
   * which reverts mod-a's delivered production change.
   */
  async function delivered() {
    const { ws, repo } = await workspace();
    toyGit(repo, ['checkout', '-q', '-b', 'wip/mod-a']);
    commitFiles(repo, { 'mod-a/test/reserve.test.mjs': AGENT_TESTS['mod-a/test/reserve.test.mjs'] }, 'test(mod-a): reserve');
    commitFiles(repo, { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] }, 'feat(mod-a): reserve');
    toyGit(repo, ['checkout', '-q', 'main']);
    const teammate = injectConcurrentCommit({ repo, branch: 'main', ...NOTE });
    toyGit(repo, ['merge', '-q', '--no-ff', '-m', 'integrate wip/mod-a', 'wip/mod-a']);
    commitFiles(repo, { 'mod-b/test/place.test.mjs': AGENT_TESTS['mod-b/test/place.test.mjs'] }, 'test(mod-b): place');
    const head = commitFiles(repo, { 'mod-b/src/orders.mjs': TOY.referenceCode['mod-b/src/orders.mjs'] }, 'feat(mod-b): place');
    const patch = lateDefectPatch({ repo, start: project.lock.commit, head, adapter: project.adapter, prd: prd.manifest });
    const defect = injectLateDefect({ repo, branch: 'main', patch: patch.patch, message: 'chore: sync platform changes' });
    return { ws, repo, teammate, defect };
  }

  it('a rework test-first on top of the late defect replays as its own valid cycle; the delivered cycles stay valid', async () => {
    const { ws, repo, teammate, defect } = await delivered();
    commitFiles(repo, REGRESSION, 'test(mod-a): regression for the QA report');
    commitFiles(repo, FIX, 'fix(mod-a): reserve takes the quantity out again');
    const r = await verify(ws, [teammate, defect], { requireTdd: true });
    expect(units(repo, r)).toEqual([...DELIVERED_UNITS, ['valid', ['test(mod-a): regression for the QA report', 'fix(mod-a): reserve takes the quantity out again']]]);
    expect(r.sections.tdd.injections).toEqual([
      { kind: 'concurrent-commit', commit: teammate.commit, ok: true, detail: expect.stringMatching(/bound and in the delivered history/) },
      { kind: 'late-hidden-defect', commit: defect.commit, ok: true, detail: expect.stringMatching(/bound and in the delivered history/) },
    ]);
    expect(r.sections.tdd.ok).toBe(true);
    expect(failedIds(r)).toEqual([]);
    expect(r.ok).toBe(true);
  }, 300_000);

  it('the fourth pilot’s repair — the defect reverted, then the tests — fails on its own commits, never the gateway’s cycle', async () => {
    const { ws, repo, teammate, defect } = await delivered();
    toyGit(repo, ['revert', '--no-edit', defect.commit]);
    commitFiles(repo, REGRESSION, 'test(mod-a): end-to-end reserve checks');
    const r = await verify(ws, [teammate, defect], { requireTdd: true });
    expect(units(repo, r)).toEqual([...DELIVERED_UNITS, ['no-test-first', ['Revert "chore: sync platform changes"']], ['test-after', ['test(mod-a): end-to-end reserve checks']]]);
    expect(r.sections.tdd.ok).toBe(false);
    // The injected commit itself belongs to no unit; the agent's revert of it does.
    expect(r.sections.tdd.units.flatMap((u: any) => u.commits)).not.toContain(defect.commit);
  }, 300_000);

  it('fails when an injected commit was amended or replaced, or dropped from the history; the replacement is the agent’s', async () => {
    const { ws, repo, teammate, defect } = await delivered();
    // The agent rewrites the late defect in place, its bound content changed, author and message kept.
    commitFiles(repo, { 'mod-a/src/extra.mjs': 'export const unit = 1;\n' }, 'wip');
    toyGit(repo, ['reset', '-q', '--soft', 'HEAD~2']);
    toyGit(repo, ['commit', '-q', '-C', defect.commit]);
    const replacement = toyGit(repo, ['rev-parse', 'HEAD']);
    expect(toyGit(repo, ['log', '-1', '--format=%an|%s', replacement])).toBe('Platform Teammate|chore: sync platform changes');
    commitFiles(repo, REGRESSION, 'test(mod-a): regression for the QA report');
    commitFiles(repo, FIX, 'fix(mod-a): reserve takes the quantity out again');
    const r = await verify(ws, [teammate, defect], { requireTdd: true });
    expect(r.sections.tdd.ok).toBe(false);
    expect(r.sections.tdd.injections.find((i: any) => i.kind === 'late-hidden-defect')).toMatchObject({ commit: defect.commit, ok: false, detail: expect.stringMatching(/not in the delivered history/) });
    expect(r.sections.tdd.units.flatMap((u: any) => u.commits)).toContain(replacement);

    // A teammate commit the delivery dropped fails the replay too.
    const linear = await workspace();
    commitFiles(linear.repo, AGENT_TESTS, 'test: first');
    const note = injectConcurrentCommit({ repo: linear.repo, branch: 'main', ...NOTE });
    commitFiles(linear.repo, TOY.referenceCode, 'feat: orders reserve stock');
    toyGit(linear.repo, ['rebase', '-q', '--onto', `${note.commit}~1`, note.commit]);
    const dropped = await verify(linear.ws, [note], { requireTdd: true });
    expect(dropped.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid']);
    expect(dropped.sections.tdd.injections).toEqual([{ kind: 'concurrent-commit', commit: note.commit, ok: false, detail: expect.stringMatching(/not in the delivered history/) }]);
    expect(dropped.sections.tdd.ok).toBe(false);
  }, 300_000);

  it('never sees through a commit only because it looks like an injection: same author, message and paths, no binding record', async () => {
    const { ws, repo, teammate, defect } = await delivered();
    // The agent's own repair, passed off as a teammate's sync.
    writeFileSync(join(repo, 'mod-a', 'src', 'stock.mjs'), FIX['mod-a/src/stock.mjs']);
    toyGit(repo, ['add', '-A']);
    toyGit(repo, ['commit', '-q', '-m', 'chore: sync platform changes'], TEAMMATE);
    const lookalike = toyGit(repo, ['rev-parse', 'HEAD']);
    commitFiles(repo, REGRESSION, 'test(mod-a): regression for the QA report');
    const r = await verify(ws, [teammate, defect], { requireTdd: true });
    expect(units(repo, r)).toEqual([...DELIVERED_UNITS, ['no-test-first', ['chore: sync platform changes']], ['test-after', ['test(mod-a): regression for the QA report']]]);
    expect(r.sections.tdd.units.flatMap((u: any) => u.commits)).toContain(lookalike);
    // A record edited to bind it does not bind it.
    const forged = { ...defect, commit: lookalike, parent: defect.commit };
    const again = await verify(ws, [teammate, defect, forged], { requireTdd: true });
    expect(again.sections.tdd.injections.at(-1)).toMatchObject({ kind: 'late-hidden-defect', commit: lookalike, ok: false, detail: expect.stringMatching(/does not bind/) });
    expect(again.sections.tdd.units.flatMap((u: any) => u.commits)).toContain(lookalike);
    expect(again.sections.tdd.ok).toBe(false);
  }, 300_000);
});

describe('duplicate-result and stale-result on a genuine Mycelink delivery', () => {
  it('harvests settle commands from a host transcript and requires their replay to have no second effect', async () => {
    const { ws } = await workspace();
    const plan = {
      test_command: ['node', '--test'],
      nodes: [
        { module: 'mod-a', allowed: ['mod-a/**'], verification: ['node', '--test', 'mod-a/test/reserve.test.mjs'], tests: { 'mod-a/test/reserve.test.mjs': AGENT_TESTS['mod-a/test/reserve.test.mjs'] }, impl: { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] } },
        { module: 'mod-b', allowed: ['mod-b/**'], after: ['mod-a'], verification: ['node', '--test', 'mod-b/test/place.test.mjs'], tests: { 'mod-b/test/place.test.mjs': AGENT_TESTS['mod-b/test/place.test.mjs'] }, impl: { 'mod-b/src/orders.mjs': TOY.referenceCode['mod-b/src/orders.mjs'] } },
      ],
    };
    const built = orchestrate({ workspace: ws, project, prd, plan });
    // What a host's stream-json transcript shows for one settle the agent ran.
    const transcript = built.settles
      .map((s: any) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `node "${MYCELINK_BIN}" settle ${s.feature} ${s.node} --capability ${s.capability} --json` } }] } }))
      .join('\n');
    const commands = settleCommandsFromTranscript(transcript);
    expect(commands.map((c: any) => c.node)).toEqual(built.settles.map((s: any) => s.node));
    const stateFile = join(built.control, 'features', TOY_PRD, 'STATE.json');
    const before = JSON.parse(readFileSync(stateFile, 'utf8'));
    const records = replaySettles({ control: built.control, mycelink: checkoutPluginArtifact(), commands, kinds: ['duplicate-result', 'stale-result'], workspace: ws, isolation: TEST_ISOLATION });
    // A spent capability of a dispatch settled before the epoch moved on is answered stale (CSET-203 r7): nothing re-runs, nothing is written.
    expect(records.map((r: any) => [r.kind, r.node, r.effect, r.outcome, r.state_changed])).toEqual([
      ['duplicate-result', commands.at(-1).node, 'stale', 'STALE_ORCHESTRATION_EPOCH', false],
      ['stale-result', commands[0].node, 'stale', 'STALE_ORCHESTRATION_EPOCH', false],
    ]);
    const after = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(after.revision).toBe(before.revision);
    expect({ ...after.data, updated_at: null }).toEqual({ ...before.data, updated_at: null });
    const r = await verify(ws, records, { requireMycelink: true, tdd: false });
    expect(failedIds(r)).toEqual([]);
    expect(r.sections.faults.checks.map((c: any) => c.id)).toEqual(['fault:duplicate-result:no-second-effect', 'fault:stale-result:no-second-effect']);
    // A replay that settled again, or changed the feature's state, is reported.
    const reran = [{ ...records[0], effect: 'reran' }, { ...records[1], state_changed: true }];
    expect(failedIds(await verify(ws, reran, { requireMycelink: true, tdd: false }))).toEqual(['fault:duplicate-result:no-second-effect', 'fault:stale-result:no-second-effect']);
  }, 600_000);
});

describe('a late defect on a genuine Mycelink delivery', () => {
  it('makes C001 stale until Mycelink reworks the producer node and delivers a new candidate at the delivered head', async () => {
    const { ws, repo } = await workspace();
    const start = project.lock.commit;
    // The petclinic shape: the second node depends on the first, which the late defect breaks.
    const plan = {
      test_command: ['node', '--test'],
      nodes: [
        { module: 'mod-a', allowed: ['mod-a/**'], verification: ['node', '--test', 'mod-a/test/reserve.test.mjs'], tests: { 'mod-a/test/reserve.test.mjs': AGENT_TESTS['mod-a/test/reserve.test.mjs'] }, impl: { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] } },
        { module: 'mod-b', allowed: ['mod-b/**'], after: ['mod-a'], verification: ['node', '--test', 'mod-b/test/place.test.mjs'], tests: { 'mod-b/test/place.test.mjs': AGENT_TESTS['mod-b/test/place.test.mjs'] }, impl: { 'mod-b/src/orders.mjs': TOY.referenceCode['mod-b/src/orders.mjs'] } },
      ],
    };
    const built = orchestrate({ workspace: ws, project, prd, plan });
    const summary = () => mycelinkSummary({ control: built.control, featureId: TOY_PRD, repo, branch: 'main' });
    const delivered = toyGit(repo, ['rev-parse', 'main']);
    expect(summary()).toMatchObject({ complete: true, candidate: `${TOY_PRD}-C001`, candidate_sha: delivered, branch_head: delivered, incomplete: [] });

    // QA's late defect lands on main after the delivery: C001 and COMPLETED are stale now.
    const defect = lateDefectPatch({ repo, start, head: delivered, adapter: project.adapter, prd: prd.manifest });
    const record = injectLateDefect({ repo, branch: 'main', patch: defect.patch, message: 'chore: sync platform changes' });
    expect(summary()).toMatchObject({ complete: false, candidate: `${TOY_PRD}-C001`, candidate_sha: delivered, branch_head: record.commit });
    expect(summary().incomplete).toEqual([`candidate ${TOY_PRD}-C001 binds toyshop at ${delivered.slice(0, 12)}, main is at ${record.commit.slice(0, 12)}`]);
    const stale = await verify(ws, [record], { requireMycelink: true, tdd: false });
    expect(failedIds(stale)).toEqual(expect.arrayContaining([`candidate-equals-delivery:${TOY_PRD}`, `delivery-accepted:${TOY_PRD}`, 'a-feature-is-complete']));

    // Mycelink reworks the producer node on top of the defect: a regression test first, the fix, then C002 and its delivery.
    const regression = `${AGENT_TESTS['mod-a/test/reserve.test.mjs']}test('reserving two takes two out of the stock', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });\n});\n`;
    const repaired = reworkFeature({
      workspace: ws,
      prd,
      authority: built.authority,
      node: nodeId(TOY_PRD, 'mod-a'),
      reason: 'QA: AC-1 reserving reduces the stock fails on the delivered main: reserve(5, 2) returned stock 5',
      // The reworked node writes a regression test and the fix; its dependent, reopened with it, re-proves GREEN.
      work: { [nodeId(TOY_PRD, 'mod-a')]: { ...plan.nodes[0], tests: { 'mod-a/test/reserve.test.mjs': regression } }, [nodeId(TOY_PRD, 'mod-b')]: plan.nodes[1] },
    });
    expect(repaired.reworked).toMatchObject({ adopted_bases: [{ repository: 'toyshop', from: delivered, to: record.commit }] });
    expect(repaired.delivery).toMatchObject({ status: 'ACCEPTED', candidate_id: `${TOY_PRD}-C002` });
    const head = toyGit(repo, ['rev-parse', 'main']);
    expect(toyGit(repo, ['merge-base', record.commit, head])).toBe(record.commit);
    expect(summary()).toMatchObject({ complete: true, candidate: `${TOY_PRD}-C002`, candidate_sha: head, branch_head: head, incomplete: [] });
    const verified = await verify(ws, [record], { requireMycelink: true, requireTdd: true });
    expect(failedIds(verified)).toEqual([]);
    expect(verified.sections.orchestration.checks.find((c: any) => c.id === `candidate-equals-delivery:${TOY_PRD}`)).toMatchObject({ ok: true });
    expect(verified.sections.tdd.units.map((u: any) => [u.verdict, u.ok])).toEqual([
      ['valid', true],
      ['valid', true],
      ['valid', true],
    ]);
    expect(verified.ok).toBe(true);
  }, 900_000);
});

describe('settle harvesting and the replay guard', () => {
  const cap = (c: string) => c.repeat(64);
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  it('finds settles in commands and in dispatch tickets shown as tool results, once each, in order', () => {
    const ticket = JSON.stringify(
      {
        status: 'DISPATCHED',
        ticket: {
          schema: 'mycelink-dispatch-ticket/1',
          feature_id: 'F-1',
          node_id: 'F-1.a.impl',
          claim_id: 'c1',
          dispatch_id: null,
          attempt: 1,
          capability: cap('a'),
          settle_command: `node /p/bin/mycelink.mjs settle F-1 F-1.a.impl --control-root '/w/platform' --capability ${cap('a')} --json`,
        },
      },
      null,
      2,
    );
    const events = [
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: ticket }] }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bash $TMPDIR/s' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `$M settle F-1 F-1.b.impl --control-root platform --capability=${cap('b')} --json` } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: ticket }] } },
    ];
    expect(settleCommandsFromTranscript(events.map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n')).toEqual([
      { feature: 'F-1', node: 'F-1.a.impl', capability: cap('a'), control: '/w/platform' },
      { feature: 'F-1', node: 'F-1.b.impl', capability: cap('b'), control: 'platform' },
    ]);
  });

  /** A control root whose node was settled with capability `a`, and a stand-in Mycelink CLI as a sealed artifact. */
  function spentCapability(script: string | ((stateFile: string) => string)) {
    const control = makeTmpDir('bench-f-spent-');
    mkdirSync(join(control, 'features', 'F-1'), { recursive: true });
    const stateFile = join(control, 'features', 'F-1', 'STATE.json');
    const node = { state: 'DONE', claim: null, last_settlement: { capability_sha256: sha(cap('a')), outcome: 'DONE', settled_at: '2026-10-01T00:00:00.000Z' } };
    writeFileSync(stateFile, JSON.stringify({ revision: 7, data: { feature_state: 'COMPLETED', nodes: { 'F-1.a.impl': node }, updated_at: '2026-10-01T00:00:00.000Z' } }));
    const dir = join(makeTmpDir('bench-f-cli-'), 'plugin');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    if (script !== '') writeFileSync(join(dir, 'bin', 'mycelink.mjs'), typeof script === 'function' ? script(stateFile) : script);
    const mycelink = { dir, tree_sha256: artifactDigest(dir).tree_sha256 };
    const replay = (kinds: string[], extra: Record<string, unknown> = {}) =>
      replaySettles({ control, mycelink, commands: [{ feature: 'F-1', node: 'F-1.a.impl', capability: cap('a') }], kinds, isolation: TEST_ISOLATION, ...extra });
    return { control, stateFile, mycelink, replay };
  }
  const verdict = (records: any[]) => inspectFaults({ repo: toy.upstream, head: toyGit(toy.upstream, ['rev-parse', 'HEAD']), records }).checks.map((c: any) => [c.id, c.ok]);

  it('counts only a parsed receipt (idempotent: true) or a known refusal code, with the state readable and unchanged, as no second effect', () => {
    const receipt = spentCapability(`process.stdout.write(JSON.stringify({ node_id: 'F-1.a.impl', outcome: 'DONE', state: 'DONE', idempotent: true, detail: 'stored' }));\n`);
    const [r1] = receipt.replay(['duplicate-result']);
    expect(r1).toMatchObject({ applied: true, effect: 'receipt', response: 'json', state_changed: false });
    expect(r1.state_before).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.state_after).toBe(r1.state_before);
    const refusal = spentCapability(`process.stderr.write('NOT_CLAIMED: F-1.a.impl has no active claim; claim it through the controller first.\\n');\nprocess.exitCode = 1;\n`);
    const [r2] = refusal.replay(['stale-result']);
    expect(r2).toMatchObject({ applied: true, effect: 'refused', response: 'refusal', refusal_code: 'NOT_CLAIMED', state_changed: false });
    expect(verdict([r1, r2])).toEqual([
      ['fault:duplicate-result:no-second-effect', true],
      ['fault:stale-result:no-second-effect', true],
    ]);
  });

  it.each([
    ['a crash with an unknown error', `process.stderr.write('TypeError: cannot read properties of undefined\\n    at settle (cli.ts:1)\\n');\nprocess.exitCode = 1;\n`, 'error', /no structured response/],
    ['an unknown refusal code', `process.stderr.write('SETTLE_IN_PROGRESS: F-1.a.impl is already being settled\\n');\nprocess.exitCode = 1;\n`, 'error', /no structured response/],
    ['a zero exit without JSON', `process.stdout.write('settled\\n');\n`, 'error', /not a JSON settle report/],
    ['an unexpected exit code', `process.exitCode = 3;\n`, 'error', /exit 3/],
    ['a second settle', `process.stdout.write(JSON.stringify({ node_id: 'F-1.a.impl', outcome: 'DONE', state: 'DONE', idempotent: false }));\n`, 'reran', /reran/],
  ])('fails closed on %s', (_label, script, effect, detail) => {
    const { replay } = spentCapability(script);
    const [r] = replay(['duplicate-result']);
    expect(r.effect).toBe(effect);
    expect(r.detail ?? r.effect).toMatch(detail);
    expect(verdict([r])).toEqual([['fault:duplicate-result:no-second-effect', false]]);
  });

  it('fails closed on a timeout, keeping what the CLI wrote to stderr', () => {
    const { replay } = spentCapability(`process.stderr.write('working...\\n');\nsetTimeout(() => {}, 30_000);\n`);
    const [r] = replay(['duplicate-result'], { timeoutMs: 1_500 });
    expect(r).toMatchObject({ effect: 'error', timed_out: true });
    expect(r.stderr).toContain('working...');
    expect(verdict([r])).toEqual([['fault:duplicate-result:no-second-effect', false]]);
  });

  it('fails closed when the CLI cannot be started, and when the state is unreadable before or after the replay', () => {
    // An artifact without the CLI.
    const [r1] = spentCapability('').replay(['duplicate-result']);
    expect(r1.effect).toBe('error');
    // A refusal that corrupts the state on its way out is not "no second effect".
    const corrupting = spentCapability((state) => `const fs = await import('node:fs');\nfs.writeFileSync(${JSON.stringify(state)}, '{');\nprocess.stderr.write('NOT_CLAIMED: gone\\n');\nprocess.exitCode = 1;\n`);
    const [r2] = corrupting.replay(['duplicate-result']);
    expect(r2).toMatchObject({ effect: 'error', state_after: null });
    // Nor is a refusal that changed the feature's state.
    const mutating = spentCapability(
      (state) =>
        `const fs = await import('node:fs');\nconst doc = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));\ndoc.data.nodes['F-1.a.impl'].state = 'INVALIDATED';\nfs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(doc));\nprocess.stderr.write('NOT_CLAIMED: gone\\n');\nprocess.exitCode = 1;\n`,
    );
    const [r3] = mutating.replay(['duplicate-result']);
    expect(r3).toMatchObject({ effect: 'refused', state_changed: true });
    expect(verdict([r1, r2, r3]).map(([, ok]) => ok)).toEqual([false, false, false]);
    // A CLI that is not the pinned artifact never runs.
    const tampered = spentCapability(`process.stdout.write(JSON.stringify({ outcome: 'DONE', idempotent: true }));\n`);
    writeFileSync(join(tampered.mycelink.dir, 'bin', 'mycelink.mjs'), `process.stdout.write(JSON.stringify({ outcome: 'DONE', idempotent: true }));\n// swapped\n`);
    const [r4] = tampered.replay(['duplicate-result']);
    expect(r4).toMatchObject({ effect: 'error', detail: expect.stringMatching(/does not verify/) });
    expect(verdict([r4])).toEqual([['fault:duplicate-result:no-second-effect', false]]);
    // Records without the evidence (an older or forged record) are not trusted either.
    expect(verdict([{ kind: 'duplicate-result', applied: true, effect: 'refused', state_changed: false }])).toEqual([['fault:duplicate-result:no-second-effect', false]]);
  });

  it('never replays a capability that still holds a live claim', () => {
    const control = makeTmpDir('bench-f-ctl-');
    mkdirSync(join(control, 'features', 'F-1'), { recursive: true });
    const state = { revision: 3, data: { nodes: { 'F-1.a.impl': { state: 'RUNNING', claim: { claim_id: 'c1', capability_sha256: sha(cap('a')) }, last_settlement: null } } } };
    writeFileSync(join(control, 'features', 'F-1', 'STATE.json'), JSON.stringify(state));
    const records = replaySettles({ control, mycelink: null, commands: [{ feature: 'F-1', node: 'F-1.a.impl', capability: cap('a') }], kinds: ['duplicate-result', 'stale-result'], isolation: TEST_ISOLATION });
    expect(records.map((r: any) => [r.kind, r.applied, r.detail])).toEqual([
      ['duplicate-result', false, 'no spent capability among the settles in the transcript'],
      ['stale-result', false, 'no spent capability among the settles in the transcript'],
    ]);
    expect(replaySettles({ control, mycelink: null, commands: [], kinds: ['stale-result'], isolation: TEST_ISOLATION })[0].detail).toBe('no settle in the transcript');
  });
});

describe('interrupt-restart and the prompts', () => {
  it('requires the interrupted session and the fresh session of its phase that resumed it, and resumes with the same prompt in both orchestration arms', () => {
    const repo = toy.upstream;
    const head = toyGit(repo, ['rev-parse', 'HEAD']);
    const resumed = (record: Record<string, unknown>) => inspectFaults({ repo, head, records: [{ kind: 'interrupt-restart', applied: true, at_seconds: 628, ...record }] }).checks.map((c: any) => [c.id, c.ok]);
    const interrupted = { index: 2, purpose: 'rework', phase: 'rework', ended_by: 'interrupt' };
    const successor = { index: 3, purpose: 'rework-resume', phase: 'rework', ended_by: 'exit' };
    expect(resumed({ interrupted_session: interrupted, successor_session: successor, resumed: true, sessions: 3 })).toEqual([['fault:interrupt-restart:resumed', true]]);
    // The third pilot: the rework was interrupted 2 s in and nothing resumed it.
    expect(resumed({ interrupted_session: interrupted, successor_session: null, resumed: false, sessions: 2 })).toEqual([['fault:interrupt-restart:resumed', false]]);
    expect(resumed({ sessions: 1 })).toEqual([['fault:interrupt-restart:resumed', false]]);
    // A session count alone names no restart; nor does a later session, or one of another phase.
    expect(resumed({ sessions: 2 })).toEqual([['fault:interrupt-restart:resumed', false]]);
    expect(resumed({ interrupted_session: interrupted, successor_session: { ...successor, index: 4 }, resumed: true, sessions: 4 })).toEqual([['fault:interrupt-restart:resumed', false]]);
    expect(resumed({ interrupted_session: interrupted, successor_session: { ...successor, phase: 'task' }, resumed: true, sessions: 3 })).toEqual([['fault:interrupt-restart:resumed', false]]);
    expect(inspectFaults({ repo, head, records: [{ kind: 'interrupt-restart', applied: true, at_seconds: 628, interrupted_session: interrupted, successor_session: successor, resumed: true }] }).checks[0].detail).toBe(
      'session 2 (rework) was interrupted at 628 s; session 3 (rework-resume) resumed it and ended by exit',
    );
    expect(RESUME_PROMPT).not.toMatch(/mycelink/i);
    expect(RESUME_PROMPT).toMatch(/interrupted/);
    expect(resumePrompt('ORIGINAL')).toBe(`${RESUME_PROMPT}\n\nThe original request follows.\n\nORIGINAL`);
  });

  it('reports a fault that never fired, or does not apply, as a warning only', () => {
    const repo = toy.upstream;
    const head = toyGit(repo, ['rev-parse', 'HEAD']);
    const checks = inspectFaults({
      repo,
      head,
      records: [
        { kind: 'interrupt-restart', applied: false, sessions: 1, detail: 'the session ended first' },
        { kind: 'concurrent-commit', applied: false, detail: 'the trigger never fired' },
        { kind: 'duplicate-result', applied: false, detail: 'Mycelink-only' },
        { kind: 'no-such-fault' },
      ],
    }).checks;
    expect(checks.map((c: any) => [c.id, c.ok, c.severity ?? null])).toEqual([
      ['fault:interrupt-restart:resumed', true, 'warning'],
      ['fault:concurrent-commit:kept', true, 'warning'],
      ['fault:duplicate-result:no-second-effect', true, 'warning'],
      ['fault:no-such-fault', false, null],
    ]);
  });
});
