import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { planCommand, resolveWindowsExecutable } from '../../src/security/exec.js';

// Deliberately RED on the installed host. This is a release-blocking contract
// test, not a test to weaken or skip by changing production security policy.
const live = process.platform === 'win32' && process.env['MYCELINK_LIVE_CODEX_SANDBOX'] === '1';


describe('Windows MXC worker path boundary (live opt-in)', () => {
  it.skipIf(!live)('cannot modify a forbidden worker/result file via an allowed hardlink alias', () => {
    const root = mkdtempSync(join(process.cwd(), '.codex-mxc-boundary-'));
    try {
      mkdirSync(join(root, 'allowed'));
      mkdirSync(join(root, 'forbidden'));
      const codexHome = join(root, 'codex-home');
      mkdirSync(codexHome);
      writeFileSync(join(codexHome, 'config.toml'), [
        'default_permissions = "mycelink_probe"',
        '[windows]', 'sandbox = "mxc"',
        '[permissions.mycelink_probe.filesystem]', '":minimal" = "read"',
        '[permissions.mycelink_probe.filesystem.":workspace_roots"]',
        '"." = "read"', '"allowed" = "write"', '',
      ].join('\n'));
      const forbidden = join(root, 'forbidden', 'result.txt');
      writeFileSync(forbidden, 'ORIGINAL');
      linkSync(forbidden, join(root, 'allowed', 'alias.txt'));
      const shim = resolveWindowsExecutable('codex', process.env);
      if (!shim) throw new Error('Codex CLI is not installed');
      const binary = join(dirname(shim), 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
        'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
      if (!existsSync(binary)) throw new Error('Installed Codex native binary not found');
      const run = (command: string) => {
        const argv = [binary, 'sandbox', '-P', 'mycelink_probe', '-C', root, '--', 'cmd.exe', '/d', '/c', command];
        const plan = planCommand(argv);
        const result = spawnSync(plan.file, plan.args, {
          cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
          env: { ...process.env, CODEX_HOME: codexHome },
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
        });
        if (result.error) throw result.error;
        return result.status;
      };
      expect(run('echo CONTROL>allowed\\control.txt')).toBe(0);
      expect(existsSync(join(root, 'allowed', 'control.txt'))).toBe(true);
      expect(run('echo DENIED>forbidden\\direct.txt')).not.toBe(0);
      expect(existsSync(join(root, 'forbidden', 'direct.txt'))).toBe(false);
      // A filesystem security boundary must resolve the target object, not only the alias path.
      // On codex-cli 0.163.0 MXC allows this write and this assertion fails.
      run('echo ATTACK>allowed\\alias.txt');
      expect(readFileSync(forbidden, 'utf8')).toBe('ORIGINAL');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
