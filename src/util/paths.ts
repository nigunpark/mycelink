import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the installed package root from either the TypeScript sources
 * (`src/...` under vitest) or the compiled output (`dist/...`).
 *
 * The marker is `schemas`, which ships in both layouts.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'schemas', 'portfolio-graph.schema.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Unable to locate the orchestrator package root (no schemas directory found above ' +
      dirname(fileURLToPath(import.meta.url)) +
      ')',
  );
}

export function schemasDir(): string {
  return join(packageRoot(), 'schemas');
}

/** Normalise a path to POSIX separators for stable comparison and hashing. */
export function toPosix(p: string): string {
  return p.split(sep).join('/').replace(/\\/g, '/');
}

/** True when `child` resolves inside `parent` (or equals it). */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}
