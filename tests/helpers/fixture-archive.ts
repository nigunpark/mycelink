/**
 * The benchmark's archived run trees (scripts/fixture-archive.mjs), extracted
 * for a test to read.
 *
 * An archive is verified against its manifest and extracted once per test
 * file into a short temporary directory of its own, never into the
 * repository: there Vitest could collect a recorded project's test file and
 * the constraint audit could count it. It is removed when the process exits.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain ESM script without type declarations
import { extractArchive } from '../../scripts/fixture-archive.mjs';

const trees = new Map<string, string>();

function removeTrees(): void {
  for (const dir of trees.values()) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can hold handles briefly; a leaked scratch dir must never fail a test.
    }
  }
  trees.clear();
}

/** The directory holding archive `name`'s files (`tests/benchmark/fixtures/<name>.tar`), exactly as the manifest lists them. */
export function fixtureTree(name: string): string {
  const known = trees.get(name);
  if (known !== undefined) return known;
  const dir = mkdtempSync(join(tmpdir(), 'mlfx-'));
  try {
    extractArchive(name, dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  if (trees.size === 0) process.once('exit', removeTrees);
  trees.set(name, dir);
  return dir;
}
