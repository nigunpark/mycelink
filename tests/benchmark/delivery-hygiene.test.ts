/**
 * What the verifier demands of a delivered repository before it runs any of
 * the delivered code: inert git configuration, the frozen commit genuinely
 * in the history (no rewrite, no replace refs or grafts), a clean working
 * tree, no committed symlinks or submodules, no hardlinked or symlinked
 * tracked files, changes inside the PRD's modules (every required module's
 * production code touched, no upstream test deleted), and no evaluator-only
 * content anywhere in the history or the workspace.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { inspectRepository } from '../../evals-public-projects/lib/hygiene.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { globToRegExp, inspectScope, isTestPath, moduleOf } from '../../evals-public-projects/lib/scope.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { inspectLeakage } from '../../evals-public-projects/lib/leakage.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { gitBlobSha } from '../../evals-public-projects/lib/hash.mjs';

afterAll(() => cleanupTmpRoots());

let tick = 0;
function g(cwd: string, args: string[]): string {
  tick += 1;
  const date = new Date(Date.UTC(2026, 0, 1, 0, tick)).toISOString();
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '',
    },
  }).trim();
}
function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}
function commit(repo: string, message: string): string {
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', message]);
  return g(repo, ['rev-parse', 'HEAD']);
}

const BUILD_BASE = '{ "inlined": "1.4.2" }\n';
const BUILD_BUILT = '{ "inlined": "1.5.0" }\n';
const HIDDEN = 'test("hidden acceptance for mod-a", () => {});\n';
const adapter = {
  id: 'toy',
  workspace: { repo_dir: 'repos/toy', branch: 'main' },
  modules: [
    { id: 'mod-a', path: 'mod-a', description: 'a' },
    { id: 'mod-b', path: 'mod-b', description: 'b' },
    { id: 'mod-c', path: 'mod-c', description: 'c' },
  ],
  test_paths: ['*/test/**'],
  tolerated_build_mutations: [{ path: 'build.json', baseline_blob: gitBlobSha(Buffer.from(BUILD_BASE)), built_blob: gitBlobSha(Buffer.from(BUILD_BUILT)), evidence: 'toy build rewrites it' }],
};
const prd = { modules: { required: ['mod-a', 'mod-b'], allowed: ['mod-a', 'mod-b'] }, allowed_shared_paths: ['docs/**'] };
const fingerprints = { paths: new Set(['mod-a/test/hidden.acceptance.test.js']), blobs: new Set([gitBlobSha(Buffer.from(HIDDEN))]) };

/** A workspace with repos/toy at a frozen start commit and one good delivery on main. */
function delivered(): { ws: string; repo: string; start: string; head: string } {
  const ws = makeTmpDir('bench-hygiene-');
  const repo = join(ws, 'repos', 'toy');
  mkdirSync(repo, { recursive: true });
  g(repo, ['init', '-q', '-b', 'main']);
  write(repo, {
    'mod-a/src/a.js': 'export const a = 1;\n',
    'mod-a/test/a.test.js': 'test a\n',
    'mod-b/src/b.js': 'export const b = 1;\n',
    'mod-b/test/b.test.js': 'test b\n',
    'mod-c/src/c.js': 'export const c = 1;\n',
    'docs/guide.md': '# guide\n',
    'build.json': BUILD_BASE,
  });
  const start = commit(repo, 'upstream');
  write(repo, { 'mod-a/test/a2.test.js': 'test a2\n' });
  commit(repo, 'test: a2 first');
  write(repo, { 'mod-a/src/a.js': 'export const a = 2;\n', 'mod-b/src/b.js': 'export const b = 2;\n', 'docs/guide.md': '# guide v2\n' });
  const head = commit(repo, 'feat: a and b');
  return { ws, repo, start, head };
}
const lock = (start: string) => ({ commit: start, history: { kind: 'complete', commits: 1, shallow_boundary: [] } });
const failedIds = (r: any) => r.checks.filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => c.id);
const repoCheck = (d: ReturnType<typeof delivered>) => inspectRepository({ repo: d.repo, lock: lock(d.start), adapter });

describe('inspectRepository', () => {
  it('passes a clean delivery on main that descends from the frozen commit', () => {
    const d = delivered();
    const r = repoCheck(d);
    expect(failedIds(r)).toEqual([]);
    expect(r.facts).toMatchObject({ head: d.head, branch: 'main', commits_since_start: 2 });
  });

  it('rejects uncommitted, staged and untracked work', () => {
    const d = delivered();
    write(d.repo, { 'mod-a/src/a.js': 'export const a = 3;\n' });
    expect(failedIds(repoCheck(d))).toContain('clean-worktree');
    g(d.repo, ['add', '-A']);
    expect(failedIds(repoCheck(d))).toContain('clean-worktree');
    g(d.repo, ['reset', '-q', '--hard']);
    write(d.repo, { 'mod-b/src/new.js': 'x\n' });
    expect(failedIds(repoCheck(d))).toContain('clean-worktree');
  });

  it('tolerates exactly the recorded upstream build mutation, as a warning', () => {
    const d = delivered();
    write(d.repo, { 'build.json': BUILD_BUILT });
    const r = repoCheck(d);
    expect(failedIds(r)).toEqual([]);
    expect(r.checks.find((c: any) => c.id === 'tolerated-build-mutation:build.json')).toMatchObject({ ok: true, severity: 'warning' });
    write(d.repo, { 'build.json': '{ "inlined": "9.9.9" }\n' });
    expect(failedIds(repoCheck(d))).toContain('clean-worktree');
  });

  it('rejects a detached HEAD, a missing frozen commit and a delivery with no commits', () => {
    const d = delivered();
    g(d.repo, ['checkout', '-q', '--detach']);
    expect(failedIds(repoCheck(d))).toContain('on-branch');
    g(d.repo, ['checkout', '-q', 'main']);
    expect(failedIds(inspectRepository({ repo: d.repo, lock: lock('f'.repeat(40)), adapter }))).toContain('start-present');
    g(d.repo, ['reset', '-q', '--hard', d.start]);
    expect(failedIds(repoCheck(d))).toContain('delivered');
  });

  it('rejects rewritten history even when the content is identical', () => {
    const d = delivered();
    g(d.repo, ['checkout', '-q', '--orphan', 'rewritten']);
    g(d.repo, ['commit', '-q', '-m', 'squashed']);
    g(d.repo, ['branch', '-f', 'main', 'rewritten']);
    g(d.repo, ['checkout', '-q', 'main']);
    expect(failedIds(repoCheck(d))).toContain('history-preserved');
  });

  it('is not fooled by replace refs or grafts that forge ancestry', () => {
    const d = delivered();
    g(d.repo, ['checkout', '-q', '--orphan', 'forged']);
    const orphan = commit(d.repo, 'orphan delivery');
    // A replacement for the orphan that claims the frozen commit as parent.
    const tree = g(d.repo, ['rev-parse', `${orphan}^{tree}`]);
    const fake = g(d.repo, ['commit-tree', tree, '-p', d.start, '-m', 'forged parent']);
    g(d.repo, ['replace', orphan, fake]);
    g(d.repo, ['branch', '-f', 'main', orphan]);
    g(d.repo, ['checkout', '-q', 'main']);
    // Plain git is fooled: the forged parent makes the frozen commit an ancestor.
    expect(() => execFileSync('git', ['merge-base', '--is-ancestor', d.start, 'HEAD'], { cwd: d.repo, stdio: 'ignore' })).not.toThrow();
    const r = repoCheck(d);
    expect(failedIds(r)).toEqual(expect.arrayContaining(['history-preserved', 'no-replace-refs']));
    g(d.repo, ['replace', '-d', orphan]);
    mkdirSync(join(d.repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(d.repo, '.git', 'info', 'grafts'), `${orphan} ${d.start}\n`);
    expect(failedIds(repoCheck(d))).toEqual(expect.arrayContaining(['history-preserved', 'no-grafts']));
  });

  it('refuses a repository whose own git config could execute programs, without running git in it', () => {
    const d = delivered();
    const marker = join(d.ws, 'fsmonitor-ran');
    appendFileSync(join(d.repo, '.git', 'config'), `[core]\n\tfsmonitor = node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'x')"\n`);
    const r = repoCheck(d);
    expect(failedIds(r)).toEqual(['git-config-safe']);
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects committed symlinks and submodules, and hardlinked tracked files', () => {
    const d = delivered();
    const blob = g(d.repo, ['rev-parse', 'HEAD:mod-a/src/a.js']);
    g(d.repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},mod-a/src/link.js`]);
    g(d.repo, ['commit', '-q', '-m', 'symlink']);
    g(d.repo, ['reset', '-q', '--hard']);
    expect(failedIds(repoCheck(d))).toContain('tree-entries');

    const e = delivered();
    const outside = join(e.ws, 'outside.js');
    writeFileSync(outside, readFileSync(join(e.repo, 'mod-b', 'src', 'b.js')));
    rmSync(join(e.repo, 'mod-b', 'src', 'b.js'));
    linkSync(outside, join(e.repo, 'mod-b', 'src', 'b.js'));
    expect(failedIds(repoCheck(e))).toContain('tracked-files-regular');
  });

  it('rejects a shallow boundary that differs from the frozen one', () => {
    const d = delivered();
    writeFileSync(join(d.repo, '.git', 'shallow'), `${d.start}\n`);
    expect(failedIds(repoCheck(d))).toContain('shallow-boundary');
  });
});

describe('scope', () => {
  it('maps paths to modules and tests with the adapter topology', () => {
    expect(moduleOf(adapter, 'mod-a/src/a.js')).toBe('mod-a');
    expect(moduleOf(adapter, 'mod-ab/x.js')).toBe(null);
    expect(isTestPath(adapter, 'mod-a/test/a.test.js')).toBe(true);
    expect(isTestPath(adapter, 'mod-a/src/a.js')).toBe(false);
    expect(globToRegExp('docs/**').test('docs/a/b.md')).toBe(true);
    expect(globToRegExp('*.md').test('docs/a.md')).toBe(false);
    expect(globToRegExp('.changeset/*.md').test('.changeset/brave-dogs.md')).toBe(true);
    expect(globToRegExp('**/__tests__/**').test('packages/cli/src/__tests__/x.ts')).toBe(true);
  });

  it('passes a delivery that changes production code in every required module', () => {
    const d = delivered();
    const r = inspectScope({ repo: d.repo, start: d.start, head: d.head, adapter, prd });
    expect(failedIds(r)).toEqual([]);
    expect(r.facts.by_module).toMatchObject({ 'mod-a': expect.any(Array), 'mod-b': expect.any(Array) });
  });

  it('rejects changes outside the allowed modules and shared paths', () => {
    const d = delivered();
    write(d.repo, { 'mod-c/src/c.js': 'export const c = 2;\n', 'build.sh': 'echo\n' });
    const head = commit(d.repo, 'out of scope');
    const ids = failedIds(inspectScope({ repo: d.repo, start: d.start, head, adapter, prd }));
    expect(ids).toEqual(['scope-allowed']);
  });

  it('rejects a required module whose production code is untouched, and a deleted upstream test', () => {
    const d = delivered();
    g(d.repo, ['reset', '-q', '--hard', d.start]);
    write(d.repo, { 'mod-a/src/a.js': 'export const a = 9;\n', 'mod-b/test/b2.test.js': 'test only\n' });
    rmSync(join(d.repo, 'mod-a', 'test', 'a.test.js'));
    const head = commit(d.repo, 'tests only in b, a test deleted');
    const ids = failedIds(inspectScope({ repo: d.repo, start: d.start, head, adapter, prd }));
    expect(ids).toEqual(expect.arrayContaining(['scope-required:mod-b', 'existing-tests-kept']));
  });
});

describe('inspectLeakage', () => {
  it('passes a delivery with no evaluator content', () => {
    const d = delivered();
    expect(failedIds(inspectLeakage({ repo: d.repo, start: d.start, head: d.head, workspace: d.ws, fingerprints }))).toEqual([]);
  });

  it('rejects evaluator content committed anywhere in the delivered history, even if later deleted', () => {
    const d = delivered();
    write(d.repo, { 'mod-a/test/copied.test.js': HIDDEN });
    commit(d.repo, 'copied');
    rmSync(join(d.repo, 'mod-a', 'test', 'copied.test.js'));
    const head = commit(d.repo, 'removed');
    expect(failedIds(inspectLeakage({ repo: d.repo, start: d.start, head, workspace: d.ws, fingerprints }))).toContain('no-evaluator-blobs');
  });

  it('rejects a delivered file at a hidden overlay path', () => {
    const d = delivered();
    write(d.repo, { 'mod-a/test/hidden.acceptance.test.js': 'placeholder\n' });
    const head = commit(d.repo, 'pre-planted');
    expect(failedIds(inspectLeakage({ repo: d.repo, start: d.start, head, workspace: d.ws, fingerprints }))).toContain('no-overlay-collision');
  });

  it('rejects evaluator content anywhere in the workspace outside git', () => {
    const d = delivered();
    write(d.ws, { 'notes/peek.txt': HIDDEN });
    expect(failedIds(inspectLeakage({ repo: d.repo, start: d.start, head: d.head, workspace: d.ws, fingerprints }))).toContain('no-evaluator-files');
  });
});
