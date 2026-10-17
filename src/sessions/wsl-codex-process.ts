/* Experimental Windows -> WSL root process revocation; not dispatch authorization. */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../util/paths.js';

/** Deterministic feature namespace; never accept a token from an isolated worker. */
export function wslCodexFeatureToken(featureDir: string): string {
  return createHash('sha256').update(realpathSync(featureDir).replace(/\\/g, '/').toLowerCase()).digest('hex');
}

export function revokeWslCodexProcesses(featureDir: string): void {
  if (process.platform !== 'win32') throw new Error('WSL_CODEX_REVOKE_UNAVAILABLE');
  const script = join(packageRoot(), 'scripts', 'wsl-codex-process.py');
  if (!existsSync(script)) throw new Error('WSL_CODEX_REVOKE_SCRIPT_MISSING');
  const linuxPath = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u', script.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (linuxPath.status !== 0 || !linuxPath.stdout?.trim().startsWith('/mnt/')) {
    throw new Error('WSL_CODEX_REVOKE_PATH_UNAVAILABLE');
  }
  const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', linuxPath.stdout.trim(),
    'revoke', wslCodexFeatureToken(featureDir)], { encoding: 'utf8', timeout: 12_000, windowsHide: true });
  if (result.status !== 0) throw new Error('WSL_CODEX_REVOKE_UNCONFIRMED');
}
