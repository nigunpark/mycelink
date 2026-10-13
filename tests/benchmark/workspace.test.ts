/**
 * The agent-visible workspace a scaffold builds: the frozen project
 * imported from its verified bundle, a coordination repository holding the
 * public requirement, and a guide — and nothing from the evaluator, not even
 * the path of the cache or the suite.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { validateRepositories } from '../../src/graph/validate.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TOY_PRD, TOY_REQUIREMENT, buildToy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { buildWorkspace } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadProject } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { importEvaluator } from '../../evals-public-projects/lib/evaluator.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { scanForFingerprints } from '../../evals-public-projects/lib/leakage.mjs';

afterAll(() => cleanupTmpRoots());

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      if (n === '.git') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(root);
  return out;
}

async function built() {
  const toy = buildToy();
  const project = loadProject(toy.suite, 'toyshop');
  const prd = project.prds[0];
  const target = join(makeTmpDir('bench-ws-'), 'ws');
  const home = makeTmpDir('bench-ws-home-');
  const ws = await buildWorkspace({ project, prd, target, home, cacheRoot: toy.cacheRoot });
  return { toy, project, prd, target, home, ws };
}

describe('buildWorkspace', () => {
  it('lays out the frozen project, the coordination repository and the guide', async () => {
    const { toy, target, ws } = await built();
    expect(files(target)).toEqual([
      'README.md',
      'platform/README.md',
      'platform/repositories.yaml',
      `platform/requirements/${TOY_PRD}.acceptance.json`,
      `platform/requirements/${TOY_PRD}.md`,
      'repos/toyshop/LICENSE',
      'repos/toyshop/README.md',
      'repos/toyshop/mod-a/src/stock.mjs',
      'repos/toyshop/mod-a/test/stock.test.mjs',
      'repos/toyshop/mod-b/src/orders.mjs',
      'repos/toyshop/mod-b/test/orders.test.mjs',
    ]);
    const repo = join(target, 'repos', 'toyshop');
    expect(ws).toMatchObject({ repo, platform: join(target, 'platform'), start: toy.start });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(toy.start);
    expect(git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(git(repo, ['remote'])).toBe('');
    expect(git(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(readFileSync(join(target, 'platform', 'requirements', `${TOY_PRD}.md`), 'utf8')).toBe(TOY_REQUIREMENT);
    // Beside it, the criteria structured: exact text, kind, hashes.
    const sidecar = JSON.parse(readFileSync(join(target, 'platform', 'requirements', `${TOY_PRD}.acceptance.json`), 'utf8'));
    expect(sidecar).toMatchObject({ schema: 'mycelink-acceptance/1', feature_id: TOY_PRD, source: { path: `requirements/${TOY_PRD}.md` } });
    expect(sidecar.criteria.map((c: { id: string; kind: string }) => [c.id, c.kind])).toEqual([['AC-1', 'new-behavior'], ['AC-2', 'new-behavior'], ['AC-3', 'new-behavior']]);
    expect(sidecar.criteria[2].text).toBe('**AC-3 (mod-a, mod-b).** Existing behaviour is unchanged.');
    expect(git(join(target, 'platform'), ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(join(target, 'platform'), ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const guide = readFileSync(join(target, 'README.md'), 'utf8');
    expect(guide).toContain(`platform/requirements/${TOY_PRD}.md`);
    expect(guide).toContain('`mod-a` (`mod-a/`)');
    expect(guide).toContain('Run `node --test` from a module directory.');
    // The repository as Mycelink registers it (`mycelink init` keeps it); a node --test project needs no worktree setup.
    const manifest = YAML.parse(readFileSync(join(target, 'platform', 'repositories.yaml'), 'utf8'));
    expect(validateRepositories(manifest).ok).toBe(true);
    expect(manifest.repositories).toEqual([{ name: 'toyshop', path: '../repos/toyshop', base_branch: 'main', commands: { test: ['node', '--test'] }, tdd: { test_paths: expect.any(Array) } }]);
  });

  it('carries nothing from the evaluator: no hidden or reference content, no cache or suite path', async () => {
    const { toy, project, target, home } = await built();
    const ev = importEvaluator({ project, prdId: TOY_PRD, from: toy.authoring, cacheRoot: toy.cacheRoot });
    const fp = JSON.parse(readFileSync(join(ev.dir, 'fingerprints.json'), 'utf8'));
    expect(scanForFingerprints(target, { paths: new Set(), blobs: new Set(fp.blobs) })).toEqual([]);
    expect(scanForFingerprints(home, { paths: new Set(), blobs: new Set(fp.blobs) })).toEqual([]);
    for (const root of [target, home]) {
      for (const f of files(root)) {
        const text = readFileSync(join(root, f), 'utf8');
        for (const needle of [toy.cacheRoot, toy.suite, REPO_ROOT, 'evaluator', 'hidden/', 'reference/', 'mutant']) {
          expect(text.includes(needle), `${f} mentions ${needle}`).toBe(false);
        }
      }
    }
  });

  it('is deterministic: the same case builds byte-identical files and the same coordination commit', async () => {
    const a = await built();
    const b = await built();
    expect(readFileSync(join(a.target, 'README.md'))).toEqual(readFileSync(join(b.target, 'README.md')));
    expect(git(join(a.target, 'platform'), ['rev-parse', 'HEAD'])).toBe(git(join(b.target, 'platform'), ['rev-parse', 'HEAD']));
  });

  it('refuses a target that is not empty', async () => {
    const toy = buildToy();
    const project = loadProject(toy.suite, 'toyshop');
    const target = makeTmpDir('bench-ws-busy-');
    writeFileSync(join(target, 'x'), 'x');
    await expect(buildWorkspace({ project, prd: project.prds[0], target, home: makeTmpDir('h-'), cacheRoot: toy.cacheRoot })).rejects.toThrow(/not empty/);
  });
});
