import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];

/**
 * Create an isolated scratch directory. Native Windows paths are used as-is;
 * no WSL/Docker assumptions. Registered for cleanup via `cleanupTmpRoots()`.
 */
export function makeTmpDir(prefix = 'harness-'): string {
  const base = join(tmpdir(), 'mycelink-tests');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, prefix));
  roots.push(dir);
  return resolve(dir);
}

/**
 * The Windows 8.3 short-name alias of an existing directory (`C:\Users\RUNNER~1\...`),
 * or null when there is none: not Windows, or 8.3 name generation is disabled
 * on the volume. GitHub-hosted Windows runners hand out such aliases as the
 * temp directory, while git records the long form of the same directory.
 */
export function windowsShortPathAlias(dir: string): string | null {
  if (process.platform !== 'win32') return null;
  const long = resolve(dir);
  const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  }).trim();
  return out !== '' && out.toLowerCase() !== long.toLowerCase() ? out : null;
}

export function cleanupTmpRoots(): void {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can hold handles briefly; a leaked scratch dir must never fail a test.
    }
  }
}
