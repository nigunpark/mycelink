/**
 * The qualified upstream baseline and the regression rule: a baseline is
 * recorded only from identical, fully green runs with one command; a
 * delivery must report and pass every baseline test that passed, and no
 * test may fail.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { baselineRecord, compareToBaseline, runFullSuite } from '../../evals-public-projects/lib/baseline.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { createAdapter } from '../../evals-public-projects/lib/adapters/index.mjs';

afterAll(() => cleanupTmpRoots());

const project = { adapter: { id: 'toy' }, lock: { identity_sha256: 'a'.repeat(64) } };
const run = (tests: Array<[string, string]>, category = 'ok', argv = ['node', '--test']) => ({
  run: { category, exit_code: category === 'ok' ? 0 : 1 },
  command: { argv, env: {} },
  results: tests.map(([id, status]) => ({ id, status, category: status })),
});

describe('baselineRecord', () => {
  it('records sorted test ids and statuses from identical green runs', () => {
    const { problems, record } = baselineRecord({ project, runs: [run([['b', 'passed'], ['a', 'skipped']]), run([['a', 'skipped'], ['b', 'passed']])] });
    expect(problems).toEqual([]);
    expect(record).toMatchObject({ schema: 'mycelink-bench/baseline-tests@1', project: 'toy', runs: 2, counts: { passed: 1, failed: 0, skipped: 1 }, tests: [{ id: 'a', status: 'skipped' }, { id: 'b', status: 'passed' }] });
    expect(record.command_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports runs that disagree, fail, or use different commands', () => {
    expect(baselineRecord({ project, runs: [run([['a', 'passed']]), run([['a', 'passed'], ['b', 'passed']])] }).problems).toEqual(['run 2 reports different tests or statuses than run 1']);
    expect(baselineRecord({ project, runs: [run([['a', 'failed']], 'tests-failed')] }).problems).toEqual(['run 1 ended tests-failed (exit 1)', 'failing upstream tests: a']);
    expect(baselineRecord({ project, runs: [run([['a', 'passed']]), run([['a', 'passed']], 'ok', ['node', '--test', 'x'])] }).problems).toEqual(['the runs did not use one identical command']);
  });
});

describe('compareToBaseline', () => {
  const record = { tests: [{ id: 'a', status: 'passed' }, { id: 'b', status: 'passed' }, { id: 'todo', status: 'skipped' }] };
  it('passes when every baseline test still passes and nothing fails', () => {
    expect(compareToBaseline(record, run([['a', 'passed'], ['b', 'passed'], ['new', 'passed']]).results)).toEqual({ missing: [], regressed: [], failing_new: [], new_tests: 1 });
  });
  it('reports missing (removed or renamed) and regressed baseline tests, and failing new tests', () => {
    const results = [
      { id: 'a', status: 'failed', category: 'assertion' },
      { id: 'todo', status: 'failed', category: 'assertion' },
      { id: 'new', status: 'failed', category: 'exception' },
    ];
    expect(compareToBaseline(record, results)).toEqual({ missing: ['b'], regressed: ['a (failed, assertion)'], failing_new: ['new (exception)'], new_tests: 1 });
  });
});

describe('runFullSuite', () => {
  it('runs the adapter on a fresh export of a commit', async () => {
    const repo = join(makeTmpDir('bench-baseline-'), 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@x.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@x.invalid' } });
    git(['init', '-q', '-b', 'main']);
    const file = join(repo, 'mod-a', 'test', 'a.test.mjs');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "import { test } from 'node:test';\ntest('works', () => {});\ntest.todo('later');\n");
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'x']);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const adapter = createAdapter({ id: 'toy', implementation: 'node-test', modules: [{ id: 'mod-a', path: 'mod-a' }], test_paths: ['*/test/**'], env: {}, commands: { timeout_seconds: 60 } });
    const out = await runFullSuite({ adapter, repo, commit, workRoot: makeTmpDir('bench-baseline-work-'), ctx: {} });
    expect(out.run.category).toBe('ok');
    expect(out.results.map((r: any) => [r.id, r.status])).toEqual([
      ['mod-a/test/a.test.mjs::works', 'passed'],
      ['mod-a/test/a.test.mjs::later', 'skipped'],
    ]);
  });
});
