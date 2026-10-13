/**
 * The tests a recorded gate ran, by their canonical ids (evidence/test-ids.ts).
 *
 * Read back from the normalised results file the gate's evidence binds by
 * its hash: a file changed since the gate wrote it names nothing. A results
 * file written before ids were published gets them computed the same way.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceRecord } from '../model/types.js';
import type { TestResult } from './red-classify.js';
import { canonicalTestId, fullNameOf, normalizeTestPath, type CanonicalTest } from './test-ids.js';
import { TEST_IDENTITY_VERSION, type TestIdentity } from './test-identity.js';

/** The tests a gate's evidence ran, with ids; null when it has no results file or the file is not the one it recorded. */
export function readGateTests(controlRoot: string, record: EvidenceRecord | undefined): CanonicalTest[] | null {
  const results = record?.results;
  if (!results) return null;
  const file = join(controlRoot, results.path);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== results.sha256) return null;
  let doc: { format?: string; results?: (TestResult & { test_id?: string; full_name?: string; identity?: unknown })[] };
  try {
    doc = JSON.parse(bytes.toString('utf8')) as typeof doc;
  } catch {
    return null;
  }
  const adapter = doc.format ?? results.format;
  return (doc.results ?? []).map((r) => {
    const path = normalizeTestPath(r.file);
    // A result without an id (a report written by hand) is named by its own name, never a crash.
    const full = typeof r.full_name === 'string' ? r.full_name : typeof r.id === 'string' ? fullNameOf(r) : String(r.name ?? '');
    const identity = publishedIdentity(r.identity, path);
    return {
      id: typeof r.test_id === 'string' ? r.test_id : canonicalTestId(adapter, path, full),
      path,
      full_name: full,
      name: r.name,
      status: r.status,
      category: r.category,
      ...(typeof r.classname === 'string' ? { classname: r.classname } : {}),
      ...(identity !== null ? { identity } : {}),
    };
  });
}

/** The identity a results file published for a test of `path`: one of this version, of that path, well formed; else none. */
function publishedIdentity(value: unknown, path: string): TestIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['version'] !== TEST_IDENTITY_VERSION || v['path'] !== path || typeof v['key'] !== 'string' || !['junit', 'js', 'exact'].includes(String(v['runner']))) return null;
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');
  if (v['classes'] !== undefined && !strings(v['classes'])) return null;
  if (v['params'] !== undefined && !strings(v['params'])) return null;
  return { version: TEST_IDENTITY_VERSION, runner: v['runner'] as TestIdentity['runner'], path, key: v['key'], ...(v['classes'] !== undefined ? { classes: [...(v['classes'] as string[])] } : {}), ...(v['params'] !== undefined ? { params: [...(v['params'] as string[])] } : {}) };
}

/** Parameterised and repeated tests report as `name(args)[n]`. */
export function namesDeclared(t: Pick<CanonicalTest, 'path' | 'name'>, declared: { file: string; name: string }): boolean {
  return t.path === normalizeTestPath(declared.file) && (t.name === declared.name || t.name.startsWith(`${declared.name}(`) || t.name.startsWith(`${declared.name}[`));
}

/**
 * Which tests a gate shows its worker, at most `limit`: the tests the
 * node's own delta declares, then any that failed, in report order.
 */
export function shownTests(tests: readonly CanonicalTest[], declared: readonly { file: string; name: string }[] | null, limit: number): CanonicalTest[] {
  const mine = tests.filter((t) => (declared ?? []).some((d) => namesDeclared(t, d)));
  const failed = tests.filter((t) => t.status === 'failed' && !mine.includes(t));
  return [...mine, ...failed].slice(0, limit);
}

/** A test as a gate prints it: `  <id> <status> <path> › <full name>`. */
export function testLine(t: { id: string; status: string; path: string; full_name: string }): string {
  return `  ${t.id} ${t.status} ${t.path} › ${t.full_name.replace(/\s*\n\s*/g, ' ')}`;
}
