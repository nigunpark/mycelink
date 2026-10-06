/**
 * `mycelink init` must ignore its own scratch area.
 *
 * Worker worktrees, integration worktrees and dispatch tickets live under
 * `.mycelink/`. Without an ignore entry every one of them shows up as an
 * untracked path, and candidate creation refuses the control repository as
 * dirty (root cause A7). The test fixtures used to paper over this by writing
 * the entry by hand; these tests exercise the production path instead.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { makeGitRepo, git } from '../helpers/git-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { createCandidate } from '../../src/git/candidate.js';
import { controllerArgv } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

async function run(argv: string[]): Promise<{ code: number; err: string }> {
  let err = '';
  const io: CliIo = { out: () => {}, err: (t) => (err += t + '\n') };
  const code = await main(controllerArgv(argv), io);
  return { code, err };
}

function gitignoreLines(control: string): string[] {
  return readFileSync(join(control, '.gitignore'), 'utf8').split(/\r?\n/);
}

describe('init writes the .mycelink/ ignore entry', () => {
  it('creates .gitignore with an anchored .mycelink/ entry so scratch state stays untracked', async () => {
    const control = makeGitRepo(join(makeTmpDir('init-ignore-'), 'control'), { files: { 'README.md': '# c\n' } });
    expect((await run(['init', control, '--no-hooks'])).code).toBe(0);

    expect(gitignoreLines(control)).toContain('/.mycelink/');
    mkdirSync(join(control, '.mycelink', 'worktrees', 'core__N'), { recursive: true });
    writeFileSync(join(control, '.mycelink', 'worktrees', 'core__N', 'file.txt'), 'x');
    const status = git(control, ['status', '--porcelain', '--untracked-files=all']);
    expect(status).not.toMatch(/\.mycelink\//);
  });

  it('keeps existing entries, appends once and is idempotent', async () => {
    const control = makeGitRepo(join(makeTmpDir('init-ignore-'), 'control'), {
      files: { '.gitignore': 'node_modules/\n*.log' },
    });
    expect((await run(['init', control, '--no-hooks'])).code).toBe(0);
    expect((await run(['init', control, '--no-hooks'])).code).toBe(0);
    const lines = gitignoreLines(control);
    expect(lines).toContain('node_modules/');
    expect(lines).toContain('*.log');
    expect(lines.filter((l) => l === '/.mycelink/')).toHaveLength(1);
  });

  it('does not duplicate an equivalent entry the user already wrote', async () => {
    const control = makeGitRepo(join(makeTmpDir('init-ignore-'), 'control'), {
      files: { '.gitignore': '.mycelink/\n' },
    });
    expect((await run(['init', control, '--no-hooks'])).code).toBe(0);
    expect(readFileSync(join(control, '.gitignore'), 'utf8')).toBe('.mycelink/\n');
  });

  it('refuses to write through a .gitignore that is a link', async (ctx) => {
    const root = makeTmpDir('init-ignore-link-');
    const control = makeGitRepo(join(root, 'control'), { files: { 'README.md': '# c\n' } });
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    try {
      symlinkSync(victim, join(control, '.gitignore'), 'file');
    } catch {
      ctx.skip(); // No symlink privilege on this Windows account.
    }
    const result = await run(['init', control, '--no-hooks']);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/\.gitignore/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
  });

  it('refuses a .gitignore that is not a regular file', async () => {
    const control = makeGitRepo(join(makeTmpDir('init-ignore-dir-'), 'control'), { files: { 'README.md': '# c\n' } });
    mkdirSync(join(control, '.gitignore'));
    const result = await run(['init', control, '--no-hooks']);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/\.gitignore/);
  });

  it('lets a candidate be cut while worktrees exist under .mycelink/ (production path)', async () => {
    const root = makeTmpDir('init-ignore-cand-');
    const control = makeGitRepo(join(root, 'control'), { files: { 'README.md': '# c\n' } });
    const core = makeGitRepo(join(root, 'core'), { files: { 'README.md': '# core\n' } });
    expect((await run(['init', control, '--no-hooks'])).code).toBe(0);
    git(control, ['add', '-A']);
    git(control, ['commit', '-q', '-m', 'init']);

    // A worker worktree and a dispatch ticket appear under the scratch area.
    mkdirSync(join(control, '.mycelink', 'worktrees', 'core__FEAT-1.x'), { recursive: true });
    writeFileSync(join(control, '.mycelink', 'worktrees', 'core__FEAT-1.x', 'a.js'), '1');
    const featureDir = join(control, 'features', 'FEAT-1');
    mkdirSync(featureDir, { recursive: true });

    const manifest = createCandidate({
      controlRepo: control,
      featureDir,
      featureId: 'FEAT-1',
      repositories: [{ name: 'core', path: core, branch: 'main' }],
      contracts: [],
    });
    expect(manifest.candidate_id).toBe('FEAT-1-C001');
    expect(existsSync(join(featureDir, 'candidates', 'FEAT-1-C001.yaml'))).toBe(true);
  });
});
