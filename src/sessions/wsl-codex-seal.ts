/* Experimental controller-side WSL broker consumer. No apply or settlement. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../util/paths.js';
import { immutableGitSource } from './wsl-codex-source.js';
import { wslCodexFeatureToken, wslCodexProcessResult } from './wsl-codex-process.js';

export type WslCodexWorkerSeal = {
  claim: string; generation: string; role: 'worker' | 'reviewer'; sha256: Record<string, string>; submission_sha256: string;
};

function sealRegisteredWslCodexRole(featureDir: string, controlRoot: string,
  grant: { claim: string; generation: string; worktree: string; base_sha: string; allowed_paths: string[] },
  role: 'worker' | 'reviewer'): WslCodexWorkerSeal {
  if (process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1') {
    throw new Error('WSL_CODEX_EXPERIMENT_NOT_ENABLED');
  }
  const outcome = wslCodexProcessResult(featureDir, grant.claim, grant.generation);
  if (outcome.exit_code !== 0 || outcome.revoked) throw new Error('WSL_CODEX_GENERATION_NOT_SUCCESSFUL');
  const script = join(packageRoot(), 'scripts', 'wsl-codex-seal.py');
  if (!existsSync(script)) throw new Error('WSL_CODEX_BROKER_SCRIPT_MISSING');
  const translated = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u', script.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (translated.status !== 0 || !translated.stdout?.trim().startsWith('/mnt/')) {
    throw new Error('WSL_CODEX_BROKER_SCRIPT_UNAVAILABLE');
  }
  const hashes = immutableGitSource(grant.worktree, grant.base_sha).hashes;
  const response = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', translated.stdout.trim(),
    '--feature-token', wslCodexFeatureToken(featureDir), '--claim', grant.claim,
    '--generation', grant.generation, '--control-root', controlRoot.replace(/\\/g, '/'), '--role', role],
  { encoding: 'utf8', input: JSON.stringify({ source_hashes: hashes, allowed_paths: grant.allowed_paths }),
    maxBuffer: 1024 * 1024, timeout: 45_000, windowsHide: true });
  if (response.status !== 0 || response.error) throw new Error('WSL_CODEX_BROKER_DENIED');
  let parsed: unknown;
  try { parsed = JSON.parse(response.stdout); }
  catch { throw new Error('WSL_CODEX_BROKER_RECEIPT_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('WSL_CODEX_BROKER_RECEIPT_INVALID');
  const receipt = parsed as Record<string, unknown>;
  if (receipt['claim'] !== grant.claim || receipt['generation'] !== grant.generation || receipt['role'] !== role ||
      !receipt['sha256'] || typeof receipt['sha256'] !== 'object' || Array.isArray(receipt['sha256']) ||
      !Object.keys(receipt['sha256']).every(path => grant.allowed_paths.includes(path) &&
        /^[0-9a-f]{64}$/.test((receipt['sha256'] as Record<string, string>)[path] ?? '')) ||
      typeof receipt['submission_sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(receipt['submission_sha256'])) {
    throw new Error('WSL_CODEX_BROKER_RECEIPT_INVALID');
  }
  return receipt as WslCodexWorkerSeal;
}

export function sealRegisteredWslCodexWorker(featureDir: string, controlRoot: string,
  grant: { claim: string; generation: string; worktree: string; base_sha: string; allowed_paths: string[] }): WslCodexWorkerSeal {
  return sealRegisteredWslCodexRole(featureDir, controlRoot, grant, 'worker');
}

export function sealRegisteredWslCodexReviewer(featureDir: string, controlRoot: string,
  grant: { claim: string; generation: string; worktree: string; base_sha: string; allowed_paths: string[] }): WslCodexWorkerSeal {
  return sealRegisteredWslCodexRole(featureDir, controlRoot, grant, 'reviewer');
}
