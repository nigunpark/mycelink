import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface GitRepoSpec {
  /** path -> content, relative to the repo root */
  files: Record<string, string>;
  branch?: string;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Harness Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Harness Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
    },
  }).trim();
}

/** Create a real git repository on disk with an initial commit. */
export function makeGitRepo(dir: string, spec: GitRepoSpec): string {
  mkdirSync(dir, { recursive: true });
  const branch = spec.branch ?? 'main';
  git(dir, ['init', '-q', '-b', branch]);
  git(dir, ['config', 'user.name', 'Harness Fixture']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFiles(dir, spec.files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
}

export function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

export function headSha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']);
}
