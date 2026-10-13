/**
 * Canonical test ids: how a worker names a test a gate ran.
 *
 * CSET-202 r2: settle refused the cli node's criterion evidence twice with
 * CRITERION_TEST_UNKNOWN, because nobody but the verifier knows how it names
 * a nested Vitest test (`describe > it` or the bare `it`), and both refusals
 * consumed a product attempt. A model never spells a test's name for the
 * controller any more: every gate publishes, for each test it ran, an id
 * that is a stable hash of
 *
 *   the report adapter (`vitest-json`, `junit-xml`),
 *   the test file's repository-relative path ('/'-separated, no `./`),
 *   the framework's full name of the test: its describes and its title
 *   joined with ` > ` (Vitest, Node's runner), `<class>#<method>` (Surefire).
 *
 * The same test has the same id on every run and platform; another file,
 * describe or adapter is another test. The full name comes from the
 * normalised result id (evidence/red-classify.ts), which is in parity with
 * the benchmark's replay.
 */
import { createHash } from 'node:crypto';
import type { TestResult } from './red-classify.js';
import type { TestIdentity } from './test-identity.js';

/** 16 lowercase hex digits. */
export const TEST_ID_PATTERN = /^[0-9a-f]{16}$/;

/** A test a gate ran, as its evidence publishes it. */
export interface CanonicalTest {
  id: string;
  path: string;
  full_name: string;
  /** The test's own title (its last name segment). */
  name: string;
  status: TestResult['status'];
  category: string;
  /** Surefire: its binary class name, as reported. */
  classname?: string;
  /**
   * Its canonical identity (evidence/test-identity.ts), as the gate published it; absent in results written before
   * identities were (PCM-101 final), where it is derived when needed and recorded with an alias.
   */
  identity?: TestIdentity;
}

/** A repository-relative test path as ids are computed over it: '/'-separated, without `./` or doubled slashes. */
export function normalizeTestPath(path: string | null | undefined): string {
  if (!path) return '';
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '');
}

/**
 * The framework's full name of a result: what its normalised id holds after
 * `<file>::` (describes and title joined with ` > `), or for a Surefire
 * result (`<module>/<class>#<method>`) the class and method — from the class
 * and name it reported when it kept them (a name with a `/` in it, a
 * parameterized invocation's display, is never cut at that `/`).
 */
export function fullNameOf(r: Pick<TestResult, 'id' | 'file'> & Partial<Pick<TestResult, 'classname' | 'name'>>): string {
  const prefix = `${r.file}::`;
  if (r.id.startsWith(prefix)) return r.id.slice(prefix.length);
  if (typeof r.classname === 'string' && r.classname !== '' && typeof r.name === 'string' && r.id.endsWith(`/${r.classname}#${r.name}`)) return `${r.classname}#${r.name}`;
  return r.id.slice(r.id.lastIndexOf('/') + 1);
}

/** The canonical id of a test: 16 hex digits of SHA-256 over the adapter, the normalised path and the full name. */
export function canonicalTestId(adapter: string, path: string, fullName: string): string {
  return createHash('sha256').update(JSON.stringify([adapter, normalizeTestPath(path), fullName])).digest('hex').slice(0, 16);
}

/** Every result of a report with its canonical id, in report order. */
export function canonicalTests(results: readonly TestResult[], adapter: string): CanonicalTest[] {
  return results.map((r) => {
    const path = normalizeTestPath(r.file);
    const full = fullNameOf(r);
    return { id: canonicalTestId(adapter, path, full), path, full_name: full, name: r.name, status: r.status, category: r.category, ...(typeof r.classname === 'string' ? { classname: r.classname } : {}) };
  });
}
