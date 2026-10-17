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

function wslProcessScript(): string {
  if (process.platform !== 'win32') throw new Error('WSL_CODEX_REVOKE_UNAVAILABLE');
  const script = join(packageRoot(), 'scripts', 'wsl-codex-process.py');
  if (!existsSync(script)) throw new Error('WSL_CODEX_REVOKE_SCRIPT_MISSING');
  const linuxPath = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u', script.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (linuxPath.status !== 0 || !linuxPath.stdout?.trim().startsWith('/mnt/')) {
    throw new Error('WSL_CODEX_REVOKE_PATH_UNAVAILABLE');
  }
  return linuxPath.stdout.trim();
}

/** Only a trusted caller holding the live-claim mutex may use this experimental tracer. */
export function startExperimentalWslProcess(featureDir: string, claim: string, generation: string,
  command: readonly string[]): { claim: string; generation: string; pid: number; pgid: number; start: string } {
  if (process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1') throw new Error('WSL_CODEX_EXPERIMENT_NOT_ENABLED');
  if (command.length === 0 || !command[0]?.startsWith('/')) throw new Error('WSL_CODEX_COMMAND_UNSAFE');
  const script = wslProcessScript();
  const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', script,
    'start', wslCodexFeatureToken(featureDir), claim, generation, '--', ...command],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  try {
    if (result.status !== 0) throw new Error('WSL_CODEX_START_UNCONFIRMED');
    const receipt = JSON.parse(result.stdout) as { claim?: unknown; generation?: unknown; pid?: unknown; pgid?: unknown; start?: unknown };
    if (receipt.claim !== claim || receipt.generation !== generation ||
      !Number.isSafeInteger(receipt.pid) || (receipt.pid as number) <= 1 ||
      receipt.pgid !== receipt.pid || typeof receipt.start !== 'string' || !/^\d+$/.test(receipt.start)) {
      throw new Error('WSL_CODEX_START_RECEIPT_INVALID');
    }
    return receipt as { claim: string; generation: string; pid: number; pgid: number; start: string };
  } catch (error) {
    // A failed or malformed readiness response may nevertheless have started
    // a process. Never hand out an unconfirmed grant without revoking the slot.
    revokeWslCodexProcesses(featureDir);
    throw error;
  }
}

export function wslCodexProcessActive(featureDir: string, claim: string, generation: string): boolean {
  const script = wslProcessScript();
  const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', script,
    'status', wslCodexFeatureToken(featureDir), claim, generation],
    { encoding: 'utf8', timeout: 12_000, windowsHide: true });
  if (result.status !== 0) throw new Error('WSL_CODEX_STATUS_UNCONFIRMED');
  try {
    const response = JSON.parse(result.stdout) as { active?: unknown };
    if (Object.keys(response).length !== 1 || typeof response.active !== 'boolean') throw new Error('invalid status');
    return response.active;
  } catch {
    throw new Error('WSL_CODEX_STATUS_UNCONFIRMED');
  }
}

/** Root-supervisor termination evidence; never accepts worker-reported exit text. */
export function wslCodexProcessResult(featureDir: string, claim: string, generation: string):
  { exit_code: number; revoked: boolean } {
  const script = wslProcessScript();
  const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', script,
    'result', wslCodexFeatureToken(featureDir), claim, generation],
    { encoding: 'utf8', timeout: 12_000, windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error('WSL_CODEX_RESULT_UNCONFIRMED');
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid result');
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || !Number.isSafeInteger(value['exit_code']) ||
      (value['exit_code'] as number) < 0 || (value['exit_code'] as number) > 255 ||
      typeof value['revoked'] !== 'boolean') throw new Error('invalid result');
    return value as { exit_code: number; revoked: boolean };
  } catch {
    throw new Error('WSL_CODEX_RESULT_UNCONFIRMED');
  }
}

export function revokeWslCodexProcesses(featureDir: string): void {
  const script = wslProcessScript();
  const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', script,
    'revoke', wslCodexFeatureToken(featureDir)], { encoding: 'utf8', timeout: 12_000, windowsHide: true });
  if (result.status !== 0) throw new Error('WSL_CODEX_REVOKE_UNCONFIRMED');
}
