import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { createPortfolio } from '../helpers/portfolio-fixture.js';
import { git } from '../helpers/git-fixture.js';
import { stageImmutableWslCodexSource, immutableGitSource } from '../../src/sessions/wsl-codex-source.js';

afterAll(() => cleanupTmpRoots());
const live = process.platform === 'win32' && process.env['MYCELINK_LIVE_WSL_WORKER'] === '1';

describe('controller-owned immutable Git source', () => {
  it('derives an exact bounded manifest from Git objects, never mutable worktree bytes', () => {
    const p = createPortfolio();
    const base = git(p.core, ['rev-parse', 'HEAD']);
    const original = readFileSync(join(p.core, 'tests/run.mjs'));
    const manifest = immutableGitSource(p.core, base);
    expect(manifest.files['tests/run.mjs']).toEqual(original);
    expect(manifest.hashes['tests/run.mjs']).toBe(createHash('sha256').update(original).digest('hex'));
    writeFileSync(join(p.core, 'tests/run.mjs'), 'hostile mutable bytes');
    expect(immutableGitSource(p.core, base).files['tests/run.mjs']).toEqual(original);
    expect(() => stageImmutableWslCodexSource(p.core, base, 'claim-1', 'gen-1'))
      .toThrow(/SOURCE_DRIFT|DIRTY/);
  });

  it.skipIf(!live)('copies exact Git object bytes into a root-private WSL stage and never follows a later DrvFS edit', () => {
    const p = createPortfolio();
    const base = git(p.core, ['rev-parse', 'HEAD']);
    const stage = stageImmutableWslCodexSource(p.core, base, 'claim-2', 'gen-2');
    try {
      const original = readFileSync(join(p.core, 'tests/run.mjs'));
      expect(stage.hashes['tests/run.mjs']).toBe(createHash('sha256').update(original).digest('hex'));
      writeFileSync(join(p.core, 'tests/run.mjs'), 'hostile late edit');
      const check = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'sha256sum', `${stage.source}/tests/run.mjs`],
        { encoding: 'utf8', timeout: 10_000 });
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout).toContain(stage.hashes['tests/run.mjs']!);
      const mode = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'stat', '-c', '%a:%u', stage.source],
        { encoding: 'utf8', timeout: 10_000 });
      expect(mode.stdout.trim()).toBe('700:0');
    } finally {
      stage.dispose();
    }
  });
});
