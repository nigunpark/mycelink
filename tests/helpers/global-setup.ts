import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Compile the controller once per vitest run.
 *
 * Several suites spawn real child processes (process locks, hook entrypoints,
 * the fake Claude adapter, the plugin harness). Those children must execute the
 * same code the CLI ships, so they load `dist/`. Building here also means every
 * `vitest run` fails loudly on a TypeScript error.
 */
export default function setup(): void {
  execFileSync(process.execPath, [resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

export const DIST_DIR = resolve(repoRoot, 'dist');
export const REPO_ROOT = repoRoot;
