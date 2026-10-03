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
