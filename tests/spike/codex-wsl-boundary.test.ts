import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Opt-in adversarial check. The forbidden result assertion is intentionally RED
// until the WSL worker uses isolated write objects rather than an allowed bind.
const live = process.platform === 'win32' && process.env['MYCELINK_LIVE_WSL_SANDBOX'] === '1';

describe('WSL standalone Codex worker boundary (live opt-in)', () => {
  it.skipIf(!live)('does not overwrite an unmounted protected result via an allowed hardlink', () => {
    const script = join(process.cwd(), 'tests', 'spike', 'codex-wsl-probe.sh')
      .replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
      .replaceAll('\\', '/');
    const run = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'psh09', '--', 'bash', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 150_000, windowsHide: true,
    });
    if (run.error) throw run.error;
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('sandboxed_linux_codex=codex-cli 0.163.0');
    expect(run.stdout).toContain('sandboxed_codex_events=thread.started,turn.started');
    expect(run.stdout).toContain('sandboxed_codex_failure=API_DNS_UNREACHABLE');
    expect(run.stdout).toContain('interop=HIDDEN');
    expect(run.stdout).toContain('windows_drive=HIDDEN');
    expect(run.stdout).toContain('host_escape=ABSENT');
    expect(run.stdout).toContain('allowed_result=ALLOWED');
    expect(run.stdout).toContain('shared_network_http_status=HTTP/2 200');
    expect(run.stdout).toContain('safe_overlay_protected=ORIGINAL');
    expect(run.stdout).toContain('safe_overlay_persisted=ORIGINAL');
    // Independent object protection: a path-level writable bind is insufficient.
    expect(run.stdout).toContain('protected_result=ORIGINAL');
  }, 180_000);
});
