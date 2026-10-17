/* Experimental immutable source staging for a trusted WSL controller, not dispatch. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../util/paths.js';

function gitBytes(cwd: string, args: readonly string[], limit = 34 * 1024 * 1024): Buffer {
  const result = spawnSync('git', [...args], { cwd, encoding: 'buffer', maxBuffer: limit, timeout: 15_000, windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error('IMMUTABLE_GIT_SOURCE_UNAVAILABLE');
  return result.stdout;
}

export function immutableGitSource(worktree: string, base: string):
  { files: Record<string, Buffer>; hashes: Record<string, string> } {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('IMMUTABLE_GIT_BASE_INVALID');
  const tree = gitBytes(worktree, ['ls-tree', '-r', '-z', '--full-tree', base]);
  const files: Record<string, Buffer> = Object.create(null);
  const hashes: Record<string, string> = Object.create(null);
  let total = 0;
  for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)$/.exec(entry);
    if (!match) throw new Error('IMMUTABLE_GIT_TREE_UNSAFE');
    const name = match[3]!;
    const parts = name.split('/');
    // The worker snapshot deliberately omits tracked dotfiles (for example
    // .gitkeep); they are not included in the manifest or source hash map.
    if (parts.some(p => p.startsWith('.'))) continue;
    if (!/^[A-Za-z0-9_./-]{1,240}$/.test(name) || parts.some(p => !p || p.endsWith('.') || p.endsWith(' ')) ||
      Object.keys(files).some(p => p.toLowerCase() === name.toLowerCase())) throw new Error('IMMUTABLE_GIT_PATH_UNSAFE');
    const bytes = gitBytes(worktree, ['cat-file', 'blob', match[2]!], 2 * 1024 * 1024 + 1024);
    total += bytes.length;
    if (bytes.length > 2 * 1024 * 1024 || total > 32 * 1024 * 1024 || Object.keys(files).length >= 4096) {
      throw new Error('IMMUTABLE_GIT_SOURCE_BUDGET');
    }
    files[name] = bytes;
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
  }
  if (Object.keys(files).length === 0) throw new Error('IMMUTABLE_GIT_TREE_EMPTY');
  return { files, hashes };
}

function wslSourceScript(): string {
  if (process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1') {
    throw new Error('WSL_CODEX_EXPERIMENT_NOT_ENABLED');
  }
  const script = join(packageRoot(), 'scripts', 'wsl-codex-source.py');
  if (!existsSync(script)) throw new Error('WSL_CODEX_SOURCE_SCRIPT_MISSING');
  const translated = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u', script.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (translated.status !== 0 || !translated.stdout?.trim().startsWith('/mnt/')) throw new Error('WSL_CODEX_SOURCE_SCRIPT_UNAVAILABLE');
  return translated.stdout.trim();
}

/** Freeze exactly the claim's Git base, rejecting any mutable checkout drift. */
export function stageImmutableWslCodexSource(worktree: string, base: string, claim: string, generation: string):
  { source: string; manifest: string; hashes: Record<string, string>; dispose: () => void } {
  const data = immutableGitSource(worktree, base);
  if (gitBytes(worktree, ['rev-parse', 'HEAD']).toString('utf8').trim() !== base ||
      gitBytes(worktree, ['status', '--porcelain', '--untracked-files=all']).length !== 0) {
    throw new Error('SOURCE_DRIFT: claim worktree differs from immutable Git base');
  }
  const script = wslSourceScript();
  const encoded = Object.fromEntries(Object.entries(data.files).map(([name, bytes]) => [name, bytes.toString('base64')]));
  const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', script, 'stage'],
    { input: JSON.stringify({ claim, generation, files: encoded, hashes: data.hashes }),
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20_000, windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error('WSL_CODEX_SOURCE_STAGE_UNCONFIRMED');
  let receipt: { source?: string; manifest?: string };
  try { receipt = JSON.parse(result.stdout) as typeof receipt; }
  catch { throw new Error('WSL_CODEX_SOURCE_STAGE_UNCONFIRMED'); }
  if (!receipt.source || !/^\/var\/lib\/mycelink-codex\/claims\/source-[A-Za-z0-9_-]+\/snapshot$/.test(receipt.source) ||
      receipt.manifest !== `${receipt.source.slice(0, -'/snapshot'.length)}/manifest.json`) {
    throw new Error('WSL_CODEX_SOURCE_STAGE_UNCONFIRMED');
  }
  return { source: receipt.source, manifest: receipt.manifest, hashes: data.hashes,
    dispose: () => {
      const removed = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', script, 'remove', receipt.source!.slice(0, -'/snapshot'.length)],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      if (removed.status !== 0 || removed.error) throw new Error('WSL_CODEX_SOURCE_CLEANUP_UNCONFIRMED');
    } };
}
