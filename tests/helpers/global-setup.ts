import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Build once per vitest run.
 *
 *  - `scripts/build.mjs` produces the shipped runtime bundle
 *    (`dist/mycelink.mjs`). Every suite that spawns the CLI or a hook goes
 *    through `bin/mycelink.mjs`, so the tests exercise exactly what ships.
 *  - `tsc` emits per-module output to `build/` for the few suites whose child
 *    processes import a single internal module (locks, leases, event log),
 *    and fails the run loudly on any TypeScript error.
 */
export default function setup(): void {
  execFileSync(process.execPath, [resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [resolve(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

export const BUILD_DIR = resolve(repoRoot, 'build');
export const REPO_ROOT = repoRoot;
