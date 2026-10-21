import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { codexHealth } from '../../src/workspace/codex-settings.js';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

describe('Codex doctor status', () => {
  it('accepts a successful login-status line on stderr and describes the opt-in runtime accurately', () => {
    vi.mocked(spawnSync).mockImplementation((_file, argv) => {
      const command = JSON.stringify(argv);
      if (command.includes('--version')) return { status: 0, stdout: 'codex-cli 0.163.0\n', stderr: '' } as ReturnType<typeof spawnSync>;
      if (command.includes('login') && command.includes('status')) return { status: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' } as ReturnType<typeof spawnSync>;
      return { status: 0, stdout: '{"installed":[]}', stderr: '' } as ReturnType<typeof spawnSync>;
    });
    const checks = codexHealth(makeTmpDir('codex-doctor-stderr-'));
    expect(checks.find((x) => x.name === 'codex login')).toMatchObject({ ok: true, detail: 'logged in (credentials not displayed)' });
    const runtime = checks.find((x) => x.name === 'codex runtime');
    expect(runtime).toMatchObject({ ok: false, level: 'warn' });
    expect(runtime?.detail).toMatch(/explicit.*disposable.*opt-in/i);
    expect(runtime?.detail).not.toMatch(/pending whole-process/i);
    expect(checks.find((x) => x.name === 'hooks')?.detail).not.toMatch(/pending security review/i);
    expect(JSON.stringify(checks)).not.toMatch(/Logged in using ChatGPT/);
    cleanupTmpRoots();
  });
});
