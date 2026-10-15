/**
 * A node's commit history, verified test-first from the repository.
 *
 * The worker contract (commit the RED tests alone, then production alone)
 * was prompt-only, and in the second PCM-101 pilot a real worker still
 * added a test-only commit after its production commit. The node was
 * integrated and delivered, and the independent replay rejected the whole
 * delivery. Settle now reads the history itself, from the node's base to
 * the exact head the worker submitted, and refuses the node before anything
 * is integrated unless:
 *
 *  - every production change starts with one or more test-only commits (a
 *    declarations-only change, by the repository's own declaration paths,
 *    needs none);
 *  - the test files those commits hold are exactly the ones a valid red
 *    gate ran with: `tdd red` binds the test-side working-tree delta, path
 *    by path and blob by blob, when it accepts the RED;
 *  - after production, no declared test is added, changed or removed unless
 *    the change starts a new complete RED -> production cycle (test data and
 *    support files that declare no test are maintenance);
 *  - no commit holds tests and production together, and there is no merge;
 *  - what the worker reported (`commit_sha`, the optional `tdd` claim) is
 *    exactly what the repository holds.
 *
 * Which paths are tests is a policy: conservative defaults for JVM, JS/TS,
 * Python, Go and .NET layouts, replaced by a repository's own `tdd` block in
 * repositories.yaml. A claim binds the policy it was dispatched with (its
 * hash is in the claim and the context pack), so a worker cannot change it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAncestor, resolveRef, runGit } from '../git/git.js';
import { spawnSync } from 'node:child_process';
import { INPUT_CHILD_TIMEOUT_MS, childProblem, withStdinFile } from '../util/child-stdin.js';
import { matchGlob } from '../git/worktree.js';
import { priorTestChanges, testsInDelta, type TestRef } from './test-declarations.js';
import type { TestIdentity } from '../evidence/test-identity.js';

export interface RepositoryTddConfig {
  /** Globs of test files (tests and their support and data). Replaces the defaults. */
  test_paths?: string[];
  /** Globs that are never test files, whatever `test_paths` says. Replaces the defaults. */
  production_roots?: string[];
  /** Production globs that can carry no runtime test (type declarations, documentation). */
  declaration_paths?: string[];
}

export interface TddPolicy {
  test_paths: string[];
  production_roots: string[];
  declaration_paths: string[];
  source: 'repository' | 'default';
}

/**
 * The commit trailer that binds a compatibility-regression unit to the
 * compatibility criteria it proves (`Mycelink-Compatibility: AC-5`): read by
 * settle here and by the independent benchmark replay alike.
 */
export const COMPATIBILITY_TRAILER = 'Mycelink-Compatibility';

const JS_TEST_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'];

/** Test files by the common conventions only: a support module in production source is never a test. */
export const DEFAULT_TEST_PATHS: readonly string[] = Object.freeze([
  // JVM (Maven, Gradle)
  '**/src/test/**',
  '**/src/testFixtures/**',
  '**/src/integrationTest/**',
  // JS/TS
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/__snapshots__/**',
  '**/__fixtures__/**',
  ...JS_TEST_EXTENSIONS.flatMap((ext) => [`**/*.test.${ext}`, `**/*.spec.${ext}`]),
  // Test directories in any ecosystem
  '**/test/**',
  '**/tests/**',
  // Python
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
  // Go
  '**/*_test.go',
  '**/testdata/**',
  // .NET test projects
  '**/*.Tests/**',
  '**/*.Test/**',
]);

/** Never tests: the JVM main source set holds production code even in a package named `test`. */
export const DEFAULT_PRODUCTION_ROOTS: readonly string[] = Object.freeze(['**/src/main/**']);

export const DEFAULT_TDD_POLICY: Readonly<TddPolicy> = Object.freeze({
  test_paths: [...DEFAULT_TEST_PATHS],
  production_roots: [...DEFAULT_PRODUCTION_ROOTS],
  declaration_paths: [],
  source: 'default' as const,
});

/** The policy of a repository: its own `tdd` block, else the defaults. */
export function tddPolicyFor(repository: { tdd?: RepositoryTddConfig } | undefined | null): TddPolicy {
  const own = repository?.tdd;
  if (own === undefined) {
    return { test_paths: [...DEFAULT_TEST_PATHS], production_roots: [...DEFAULT_PRODUCTION_ROOTS], declaration_paths: [], source: 'default' };
  }
  return {
    test_paths: [...(own.test_paths ?? DEFAULT_TEST_PATHS)],
    production_roots: [...(own.production_roots ?? DEFAULT_PRODUCTION_ROOTS)],
    declaration_paths: [...(own.declaration_paths ?? [])],
    source: 'repository',
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** What the policy decides, hashed: the patterns, not where they came from. */
export function tddPolicySha256(policy: TddPolicy): string {
  return sha256(canonical({ test_paths: policy.test_paths, production_roots: policy.production_roots, declaration_paths: policy.declaration_paths }));
}

const slash = (path: string): string => path.replace(/\\/g, '/');

export function isTestPath(policy: TddPolicy, path: string): boolean {
  const p = slash(path);
  if (policy.production_roots.some((g) => matchGlob(g, p))) return false;
  return policy.test_paths.some((g) => matchGlob(g, p));
}

export function isDeclarationPath(policy: TddPolicy, path: string): boolean {
  const p = slash(path);
  return !isTestPath(policy, p) && policy.declaration_paths.some((g) => matchGlob(g, p));
}

export interface BoundTest {
  path: string;
  /** Git blob id of the content; null when the file is removed. */
  blob: string | null;
}

/** The test files a red gate accepted a RED with, on top of `head_sha`. */
export interface RedBinding {
  head_sha: string;
  tests: BoundTest[];
  tests_sha256: string;
  /** output_sha256 of the RED evidence the gate recorded. */
  evidence_sha256: string | null;
  recorded_at: string;
  /** The tests the RED declared, by canonical id (evidence/test-ids.ts), and how each ended. */
  red_tests?: { id: string; path: string; full_name: string; status: string; category: string; identity?: TestIdentity }[];
}

const byPath = (a: BoundTest, b: BoundTest): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function testsSha256(tests: readonly BoundTest[]): string {
  return sha256(canonical([...tests].sort(byPath)));
}

/** Paths that differ from HEAD in a worktree (staged, unstaged or untracked; ignored files excluded). */
function workingTreeChanges(worktree: string): string[] {
  const out = runGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).stdout;
  const paths = new Set<string>();
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue;
    paths.add(slash(entry.slice(3)));
  }
  return [...paths].sort();
}

/** Blob ids of working-tree files, hashed as `git add` would (path attributes applied). */
function hashWorkingFiles(worktree: string, paths: readonly string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  if (paths.length === 0) return hashes;
  // Its paths as a finished file, the child bounded (util/child-stdin.ts: a stream's end can be lost on macOS).
  const input = paths.join('\n') + '\n';
  const proc = withStdinFile(input, (stdin) =>
    spawnSync('git', ['hash-object', '--stdin-paths'], {
      cwd: worktree,
      stdio: [stdin, 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: INPUT_CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }),
  );
  if (proc.status !== 0) throw new Error(`${childProblem('git hash-object --stdin-paths', proc, Buffer.byteLength(input))} in ${worktree}`);
  const lines = String(proc.stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  paths.forEach((p, i) => hashes.set(p, (lines[i] as string).trim()));
  return hashes;
}

/**
 * The binding a red gate records for the RED it ran: the test-side delta of
 * the worktree against HEAD, file by file, and every production path that
 * differs from HEAD beside it (the gate refuses to run a RED over
 * production edits, because an independent replay applies the tests alone).
 */
export function redBinding(worktree: string, policy: TddPolicy, evidenceSha256: string | null): { binding: RedBinding; production: string[] } {
  const head = resolveRef(worktree, 'HEAD');
  const changed = workingTreeChanges(worktree);
  const testPaths = changed.filter((p) => isTestPath(policy, p));
  const production = changed.filter((p) => !isTestPath(policy, p));
  const present = testPaths.filter((p) => existsSync(join(worktree, p)));
  const hashes = hashWorkingFiles(worktree, present);
  const tests = testPaths.map((path) => ({ path, blob: hashes.get(path) ?? null })).sort(byPath);
  return {
    binding: { head_sha: head, tests, tests_sha256: testsSha256(tests), evidence_sha256: evidenceSha256, recorded_at: new Date().toISOString() },
    production,
  };
}

/**
 * The tests a RED run in `worktree` declares: what the test side adds or
 * changes since the cycle began — the commit before the trailing run of
 * test-only commits on HEAD (bounded by `base`, the node's own start), or
 * HEAD itself — up to the working tree, committed or not. `opaque` names
 * changed test files of a language Mycelink cannot read.
 */
export function redDeclaredTests(worktree: string, policy: TddPolicy, base: string | null, options: { since?: 'cycle' | 'base' } = {}): { start: string; declared: TestRef[]; opaque: string[] } {
  const head = resolveRef(worktree, 'HEAD');
  let start = head;
  if (options.since === 'base' && base !== null && isAncestor(worktree, base, head)) {
    // The node's whole delta: every test it adds or changes since its base.
    start = base;
  } else if (base !== null && isAncestor(worktree, base, head)) {
    const chain = runGit(worktree, ['rev-list', '--reverse', `${base}..${head}`]).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    let previous = base;
    const parents = new Map<string, string>();
    for (const sha of chain) {
      parents.set(sha, previous);
      previous = sha;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const sha = chain[i] as string;
      const changes = changesOf(worktree, parents.get(sha) as string, sha);
      if (changes.length === 0 || !changes.every((c) => isTestPath(policy, c.path))) break;
      start = parents.get(sha) as string;
    }
  }
  const committed = changesOf(worktree, start, head).filter((c) => isTestPath(policy, c.path)).map((c) => c.path);
  const working = workingTreeChanges(worktree).filter((p) => isTestPath(policy, p));
  const paths = [...new Set([...committed, ...working])].sort();
  const before = blobsAt(worktree, start, paths);
  const contents = readBlobs(worktree, [...before.values()]);
  const entries = paths.map((path) => {
    const full = join(worktree, path);
    let after: string | null = null;
    try {
      after = existsSync(full) ? readFileSync(full, 'utf8') : null;
    } catch {
      after = null;
    }
    const sha = before.get(path);
    return { path, before: sha === undefined ? null : (contents.get(sha) ?? null), after };
  });
  const { declared, opaque } = testsInDelta(entries);
  return { start, declared, opaque };
}

export type TddViolationCode =
  | 'BASE_NOT_ANCESTOR'
  | 'MERGE_IN_HISTORY'
  | 'MIXED_COMMIT'
  | 'NO_TEST_FIRST'
  | 'RED_NOT_BOUND'
  | 'CHANGED_RED_BLOBS'
  | 'NO_DECLARED_TESTS'
  | 'TEST_AFTER'
  | 'TDD_CLAIM_MISMATCH'
  // A compatibility-regression unit (tests alone, no production after them):
  | 'COMPATIBILITY_CRITERION_INVALID'
  | 'COMPATIBILITY_WEAKENS'
  // A node with no red gate (a declaration-only node, not a refactor):
  | 'DECLARATION_PATHS_UNBOUND'
  | 'NOT_DECLARATION_ONLY'
  | 'NO_DECLARATION_COMMIT';

export interface TddViolation {
  code: TddViolationCode;
  commit: string | null;
  detail: string;
  paths?: string[];
}

export interface TddCommit {
  sha: string;
  kind: 'test' | 'production' | 'mixed' | 'empty';
  tests: string[];
  production: string[];
}

export interface TddCycle {
  red_commits: string[];
  green_commits: string[];
  /** The test side of the cycle's RED, from the commit it starts on to its last test-only commit. */
  red_tests: BoundTest[];
  declared: TestRef[];
  /** Test files of a language Mycelink cannot read, changed in the RED. */
  opaque: string[];
  production: BoundTest[];
  /** The red gate binding the RED matched. */
  red_binding: { head_sha: string; tests_sha256: string; evidence_sha256: string | null } | null;
}

/**
 * Tests alone, with no production change after them, proving behaviour the
 * code already has: a compatibility criterion's regression tests
 * (CSET-203 r3's AC-5). Never a RED: its commits carry the trailer
 * `Mycelink-Compatibility: <AC>` naming compatibility criteria of the node,
 * it only adds tests, and settle binds those tests to the criterion's GREEN
 * or regression evidence at the head (engine/criteria.ts).
 */
export interface CompatibilityUnit {
  kind: 'compatibility-regression';
  commits: string[];
  /** The compatibility criteria its commits name. */
  criteria: string[];
  /** The tests it adds. */
  declared: TestRef[];
  /** Its test files at its last commit. */
  tests: BoundTest[];
}

/** What a worker reports about its own history (node result `tdd`). */
export interface WorkerTddClaim {
  base_sha: string;
  head_sha: string;
  cycles: { red_commits: string[]; green_commits: string[]; red_tests?: BoundTest[] }[];
}

export interface TddHistory {
  schema: 'mycelink-tdd-history/1';
  ok: boolean;
  base_sha: string;
  head_sha: string;
  policy_sha256: string;
  require_red: boolean;
  commits: TddCommit[];
  cycles: TddCycle[];
  /** Compatibility-regression units: tests alone proving existing behaviour, apart from the RED cycles. */
  compatibility: CompatibilityUnit[];
  /** Test changes after production that declare no test (data, support). */
  maintenance: { commit: string; paths: string[] }[];
  /** Production changes made only of declaration paths, needing no RED. */
  declarations: string[];
  declarations_only: boolean;
  violation: TddViolation | null;
}

export interface VerifyTddHistoryArgs {
  repoPath: string;
  base: string;
  head: string;
  policy: TddPolicy;
  bindings: readonly RedBinding[];
  /** False when the node's graph requires no red evidence: then no cycle is required. */
  requireRed?: boolean;
  /**
   * With requireRed false: the node has no red gate because it changes
   * declarations only (every node but a refactor). Its history must then be
   * production-only commits, at least one, inside the declaration paths its
   * claim binds; a test or a runtime change needs a RED.
   */
  declarationsOnly?: boolean;
  /** The node's compatibility criteria: a compatibility-regression unit may name them, and nothing else. Absent: none. */
  compatibility?: { criteria: readonly string[] };
  claimed?: WorkerTddClaim | null;
}

/** The criteria a commit's `Mycelink-Compatibility:` trailer names, or null when it carries none. */
export function compatibilityTrailer(message: string): string[] | null {
  const lines = message.split(/\r?\n/).filter((l) => l.startsWith(`${COMPATIBILITY_TRAILER}:`));
  if (lines.length === 0) return null;
  return [...new Set(lines.flatMap((l) => l.slice(COMPATIBILITY_TRAILER.length + 1).split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean))];
}

function commitMessage(repo: string, sha: string): string {
  return runGit(repo, ['show', '-s', '--format=%B', sha]).stdout;
}

function changesOf(repo: string, from: string, to: string): { status: string; path: string }[] {
  const out = runGit(repo, ['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '--no-renames', from, to]).stdout;
  const parts = out.split('\0');
  const changes: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === '') break;
    changes.push({ status: (parts[i] as string)[0] as string, path: slash(parts[i + 1] as string) });
  }
  return changes;
}

/** Blob ids of `paths` in `rev` (absent paths are left out). */
function blobsAt(repo: string, rev: string, paths: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const out = runGit(repo, ['ls-tree', '-r', '-z', rev, '--', ...chunk]).stdout;
    for (const entry of out.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [, type, sha] = entry.slice(0, tab).split(' ');
      if (type === 'blob' && sha !== undefined) blobs.set(slash(entry.slice(tab + 1)), sha);
    }
  }
  return blobs;
}

/** Contents of blobs, read from the object store (never a checkout). */
function readBlobs(repo: string, shas: readonly string[]): Map<string, string> {
  const unique = [...new Set(shas)];
  const contents = new Map<string, string>();
  if (unique.length === 0) return contents;
  const input = unique.join('\n') + '\n';
  const proc = withStdinFile(input, (stdin) =>
    spawnSync('git', ['cat-file', '--batch'], {
      cwd: repo,
      stdio: [stdin, 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      timeout: INPUT_CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }),
  );
  if (proc.status !== 0) throw new Error(`${childProblem('git cat-file --batch', proc, Buffer.byteLength(input))} in ${repo}`);
  const buf = proc.stdout as Buffer;
  let at = 0;
  for (const sha of unique) {
    const nl = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[1] === 'missing' || !Number.isFinite(size)) {
      at = nl + 1;
      continue;
    }
    contents.set(sha, buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
    at = nl + 1 + size + 1;
  }
  return contents;
}

/** The test-side delta between two commits, as bound tests. */
function testDelta(repo: string, policy: TddPolicy, from: string, to: string): BoundTest[] {
  const changes = changesOf(repo, from, to).filter((c) => isTestPath(policy, c.path));
  const blobs = blobsAt(repo, to, changes.filter((c) => c.status !== 'D').map((c) => c.path));
  return changes.map((c) => ({ path: c.path, blob: c.status === 'D' ? null : (blobs.get(c.path) ?? null) })).sort(byPath);
}

/** The test files that changed between two commits, with their contents before and after (null: absent). */
function testEntries(repo: string, policy: TddPolicy, from: string, to: string): { path: string; before: string | null; after: string | null }[] {
  const changes = changesOf(repo, from, to).filter((c) => isTestPath(policy, c.path));
  const before = blobsAt(repo, from, changes.filter((c) => c.status !== 'A').map((c) => c.path));
  const after = blobsAt(repo, to, changes.filter((c) => c.status !== 'D').map((c) => c.path));
  const contents = readBlobs(repo, [...before.values(), ...after.values()]);
  const text = (sha: string | undefined): string | null => (sha === undefined ? null : (contents.get(sha) ?? null));
  return changes.map((c) => ({ path: c.path, before: text(before.get(c.path)), after: text(after.get(c.path)) }));
}

/** Declared, opaque and removed tests between two commits. */
function declaredBetween(repo: string, policy: TddPolicy, from: string, to: string): ReturnType<typeof testsInDelta> {
  return testsInDelta(testEntries(repo, policy, from, to));
}

/**
 * The trailing test-only commits `commits` (from `start`, no production after
 * them) as a compatibility-regression unit: null when none of them names a
 * criterion in a `Mycelink-Compatibility:` trailer (they are judged as
 * before) or they declare nothing (maintenance); a violation when a commit
 * names none, names what is not a compatibility criterion of the node, or
 * the unit does more than add tests.
 */
function compatibilityUnit(repo: string, policy: TddPolicy, start: string, commits: readonly TddCommit[], allowed: readonly string[]): CompatibilityUnit | { violation: TddViolation } | null {
  const named = commits.map((c) => ({ sha: c.sha, criteria: compatibilityTrailer(commitMessage(repo, c.sha)) }));
  if (named.every((n) => n.criteria === null)) return null;
  const last = (commits[commits.length - 1] as TddCommit).sha;
  const entries = testEntries(repo, policy, start, last);
  const { declared, opaque, removed } = testsInDelta(entries);
  if (declared.length === 0 && opaque.length === 0 && removed.length === 0) return null;
  const violation = (code: TddViolationCode, commit: string | null, detail: string, paths?: string[]): { violation: TddViolation } => ({ violation: { code, commit, detail, ...(paths !== undefined ? { paths } : {}) } });
  const bare = named.find((n) => n.criteria === null || n.criteria.length === 0);
  if (bare !== undefined) {
    return violation('COMPATIBILITY_CRITERION_INVALID', bare.sha, `commit ${short(bare.sha)} carries no "${COMPATIBILITY_TRAILER}: <AC>" trailer: every commit of a compatibility-regression unit names the compatibility criteria its tests prove`);
  }
  const criteria = [...new Set(named.flatMap((n) => n.criteria as string[]))];
  const others = criteria.filter((ac) => !allowed.includes(ac));
  if (others.length > 0) {
    const at = named.find((n) => (n.criteria as string[]).some((ac) => others.includes(ac))) as { sha: string };
    return violation(
      'COMPATIBILITY_CRITERION_INVALID',
      at.sha,
      `commit ${short(at.sha)} names ${others.join(', ')} in its ${COMPATIBILITY_TRAILER} trailer, but ${allowed.length > 0 ? `this node's compatibility criteria are ${allowed.join(', ')}` : 'this node serves no compatibility criterion'}: tests after the code prove only existing behaviour; a new behaviour is proved by a RED cycle (its test alone, a red gate failing for the missing behaviour, then the production change)`,
    );
  }
  const prior = priorTestChanges(entries);
  const touched = [
    prior.removed.length > 0 ? `removes ${names(prior.removed)}` : '',
    prior.edited.length > 0 ? `edits ${names(prior.edited)}` : '',
    prior.deleted.length > 0 ? `deletes ${prior.deleted.join(', ')}` : '',
    prior.data.length > 0 ? `changes the existing test data ${prior.data.join(', ')}` : '',
    prior.opaque.length > 0 ? `changes test code Mycelink cannot read (${prior.opaque.join(', ')})` : '',
  ].filter(Boolean);
  if (touched.length > 0) {
    return violation(
      'COMPATIBILITY_WEAKENS',
      last,
      `the compatibility-regression unit ${commits.map((c) => short(c.sha)).join(', ')} ${touched.join('; ')}: it may only add tests (and new test data), never remove, edit or delete what was there, or a passing suite could be bought by weakening a test`,
      [...new Set([...prior.removed.map((t) => t.file), ...prior.edited.map((t) => t.file), ...prior.deleted, ...prior.data, ...prior.opaque])].sort(),
    );
  }
  const before = new Map<string, Set<string>>();
  for (const e of entries) before.set(e.path, new Set(e.before === null ? [] : testsInDelta([{ path: e.path, before: null, after: e.before }]).declared.map((t) => t.name)));
  return {
    kind: 'compatibility-regression',
    commits: commits.map((c) => c.sha),
    criteria,
    declared: declared.filter((t) => !(before.get(t.file)?.has(t.name) ?? false)),
    tests: testDelta(repo, policy, start, last),
  };
}

/** The test files the red gates of a claim bound, each at the blob its latest RED ran with (removed files left out). */
export function redBoundFiles(bindings: readonly RedBinding[]): { path: string; blob: string }[] {
  const latest = new Map<string, string | null>();
  for (const b of bindings) for (const t of b.tests) latest.set(t.path, t.blob);
  return [...latest.entries()].filter((e): e is [string, string] => e[1] !== null).map(([path, blob]) => ({ path, blob })).sort(byPath);
}

/** Production paths changed in `worktree` since the commit `since`: committed up to HEAD or in the working tree. */
export function productionSince(worktree: string, policy: TddPolicy, since: string): string[] {
  const committed = changesOf(worktree, since, resolveRef(worktree, 'HEAD')).map((c) => c.path);
  return [...new Set([...committed, ...workingTreeChanges(worktree)])].filter((p) => !isTestPath(policy, p)).sort();
}

const sameTests = (a: readonly BoundTest[], b: readonly BoundTest[]): boolean => canonical([...a].sort(byPath)) === canonical([...b].sort(byPath));

const short = (sha: string | null | undefined): string => String(sha ?? '').slice(0, 12);

const names = (tests: readonly TestRef[]): string => tests.map((t) => `${t.file} › ${t.name}`).join(', ');

/**
 * Verify `base..head` test-first, from the repository alone. Never throws
 * for a bad history: `violation` says what is wrong, with the commit.
 */
export function verifyTddHistory(args: VerifyTddHistoryArgs): TddHistory {
  const { repoPath: repo, base, head, policy } = args;
  const requireRed = args.requireRed !== false;
  const record: TddHistory = {
    schema: 'mycelink-tdd-history/1',
    ok: false,
    base_sha: base,
    head_sha: head,
    policy_sha256: tddPolicySha256(policy),
    require_red: requireRed,
    commits: [],
    cycles: [],
    compatibility: [],
    maintenance: [],
    declarations: [],
    declarations_only: false,
    violation: null,
  };
  const fail = (code: TddViolationCode, commit: string | null, detail: string, paths?: string[]): TddHistory => ({
    ...record,
    ok: false,
    violation: { code, commit, detail, ...(paths !== undefined ? { paths } : {}) },
  });

  if (!isAncestor(repo, base, head)) {
    return fail('BASE_NOT_ANCESTOR', null, `the node's base ${short(base)} is not in the history of ${short(head)}`);
  }
  const merge = runGit(repo, ['rev-list', '--merges', `${base}..${head}`]).stdout.split('\n').find((l) => l.trim() !== '');
  if (merge !== undefined) {
    return fail('MERGE_IN_HISTORY', merge.trim(), `merge commit ${short(merge)} in the node's history; keep the node branch linear (the controller integrates upstream work itself)`);
  }
  const chain = runGit(repo, ['rev-list', '--reverse', `${base}..${head}`]).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const parentOf = new Map<string, string>();
  let previous = base;
  for (const sha of chain) {
    parentOf.set(sha, previous);
    const changes = changesOf(repo, previous, sha);
    const tests = changes.filter((c) => isTestPath(policy, c.path)).map((c) => c.path).sort();
    const production = changes.filter((c) => !isTestPath(policy, c.path)).map((c) => c.path).sort();
    const kind: TddCommit['kind'] = tests.length > 0 && production.length > 0 ? 'mixed' : tests.length > 0 ? 'test' : production.length > 0 ? 'production' : 'empty';
    record.commits.push({ sha, kind, tests, production });
    previous = sha;
  }
  if (!requireRed && args.declarationsOnly === true) return declarationHistory(record, policy, args.claimed ?? null, fail);
  if (!requireRed) return { ...record, ok: true };

  const mixed = record.commits.find((c) => c.kind === 'mixed');
  if (mixed !== undefined) {
    return fail(
      'MIXED_COMMIT',
      mixed.sha,
      `commit ${short(mixed.sha)} holds tests (${mixed.tests.join(', ')}) and production (${mixed.production.join(', ')}) together; commit the RED tests alone, then the production change alone`,
      [...mixed.production, ...mixed.tests].sort(),
    );
  }

  // Runs of consecutive test-only or production-only commits.
  const runs: { kind: 'test' | 'production'; commits: TddCommit[] }[] = [];
  for (const c of record.commits) {
    if (c.kind === 'empty') continue;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === c.kind) last.commits.push(c);
    else runs.push({ kind: c.kind as 'test' | 'production', commits: [c] });
  }

  let pos = 0;
  let sawProduction = false;
  const lead = runs[0];
  if (lead?.kind === 'production') {
    const runtime = lead.commits.flatMap((c) => c.production.filter((p) => !isDeclarationPath(policy, p)).map((p) => ({ sha: c.sha, path: p })));
    if (runtime.length > 0) {
      const first = runtime[0] as { sha: string; path: string };
      return fail(
        'NO_TEST_FIRST',
        first.sha,
        `commit ${short(first.sha)} changes production code (${[...new Set(runtime.filter((r) => r.sha === first.sha).map((r) => r.path))].join(', ')}) before any test-only commit; a production change must follow a RED committed alone`,
        [...new Set(runtime.map((r) => r.path))].sort(),
      );
    }
    record.declarations.push(...lead.commits.flatMap((c) => c.production));
    sawProduction = true;
    pos = 1;
  }

  while (pos < runs.length) {
    const testRun = runs[pos] as { kind: 'test' | 'production'; commits: TddCommit[] };
    const productionRun = runs[pos + 1];
    const first = testRun.commits[0] as TddCommit;
    const last = testRun.commits[testRun.commits.length - 1] as TddCommit;
    const start = parentOf.get(first.sha) as string;
    if (productionRun === undefined) {
      // Tests alone with nothing after them, naming compatibility criteria: a compatibility-regression unit, never a RED.
      const unit = compatibilityUnit(repo, policy, start, testRun.commits, args.compatibility?.criteria ?? []);
      if (unit !== null && 'violation' in unit) return fail(unit.violation.code, unit.violation.commit, unit.violation.detail, unit.violation.paths);
      if (unit !== null) {
        // A RED-bound test file stays byte-identical from its RED on (CSET-203 r4's AC-5 appended to AC-3's RED file).
        const bound = new Set(record.cycles.flatMap((c) => c.red_tests.map((t) => t.path)));
        const touched = unit.tests.map((t) => t.path).filter((p) => bound.has(p)).sort();
        if (touched.length > 0) {
          const at = testRun.commits.find((c) => c.tests.some((p) => bound.has(p))) ?? first;
          return fail(
            'CHANGED_RED_BLOBS',
            at.sha,
            `the compatibility-regression unit ${unit.commits.map(short).join(', ')} changes ${touched.join(', ')}, RED-bound by an earlier RED of this history: a RED-bound test file stays byte-identical from its RED on. Put the compatibility test in a new test file (or one no RED bound), alone, after the code; a test that belongs in that file goes in before the red gate runs (part of that RED), or starts a new complete RED cycle (mycelink tdd cycle, then its red gate)`,
            touched,
          );
        }
        record.compatibility.push(unit);
        break;
      }
    }
    if (productionRun === undefined && sawProduction) {
      // Tests after production that start no new cycle: only maintenance is allowed.
      const { declared, opaque, removed } = declaredBetween(repo, policy, start, last.sha);
      if (declared.length > 0 || opaque.length > 0 || removed.length > 0) {
        const offender = testRun.commits.find((c) => {
          const d = declaredBetween(repo, policy, parentOf.get(c.sha) as string, c.sha);
          return d.declared.length > 0 || d.opaque.length > 0 || d.removed.length > 0;
        }) ?? first;
        const what = [
          declared.length > 0 ? `adds or changes ${names(declared)}` : '',
          removed.length > 0 ? `removes ${names(removed)}` : '',
          opaque.length > 0 ? `changes test code Mycelink cannot read (${opaque.join(', ')})` : '',
        ].filter(Boolean).join('; ');
        return fail(
          'TEST_AFTER',
          offender.sha,
          `commit ${short(offender.sha)} ${what} after the production code, with no production change of its own; a test added after GREEN must start a new RED cycle (tests alone, red gate, then the production change it drives), or be left out — unless it is a regression test proving a compatibility criterion of this node (it passes on the code as it is): then commit it alone, adding tests only, with the trailer "${COMPATIBILITY_TRAILER}: <AC>", as a compatibility-regression unit`,
          [...new Set([...declared.map((t) => t.file), ...removed.map((t) => t.file), ...opaque])].sort(),
        );
      }
      for (const c of testRun.commits) record.maintenance.push({ commit: c.sha, paths: c.tests });
      break;
    }

    const redTests = testDelta(repo, policy, start, last.sha);
    const { declared, opaque } = declaredBetween(repo, policy, start, last.sha);
    if (declared.length === 0 && opaque.length === 0) {
      return fail(
        'NO_DECLARED_TESTS',
        last.sha,
        `the test-only commits ${testRun.commits.map((c) => short(c.sha)).join(', ')} declare no new or changed test (${redTests.map((t) => t.path).join(', ')}); a RED must add or change a test`,
        redTests.map((t) => t.path),
      );
    }
    // The RED may have run before the tests were committed (on the commit the
    // cycle starts from) or after some or all of them were (on one of its
    // test-only commits); either way it ran on no production change.
    const heads = new Set([start, ...testRun.commits.map((c) => c.sha)]);
    const candidates = args.bindings.filter((b) => heads.has(b.head_sha));
    if (candidates.length === 0) {
      return fail(
        'RED_NOT_BOUND',
        first.sha,
        `no red gate accepted a RED on ${short(start)}, where the test-only commit ${short(first.sha)} starts; run the red gate on the tests before committing them`,
        redTests.map((t) => t.path),
      );
    }
    const match = [...candidates].reverse().find((b) => sameTests(b.tests, testDelta(repo, policy, b.head_sha, last.sha)));
    if (match === undefined) {
      const latest = candidates[candidates.length - 1] as RedBinding;
      const committed = testDelta(repo, policy, latest.head_sha, last.sha);
      const bound = new Map(latest.tests.map((t) => [t.path, t.blob]));
      const now = new Map(committed.map((t) => [t.path, t.blob]));
      const differing = [...new Set([...bound.keys(), ...now.keys()])].filter((p) => bound.get(p) !== now.get(p)).sort();
      return fail(
        'CHANGED_RED_BLOBS',
        last.sha,
        `the tests committed in ${testRun.commits.map((c) => short(c.sha)).join(', ')} are not the ones the red gate ran (${differing.join(', ')}); commit exactly what the RED ran, or run the red gate again after changing a test`,
        differing,
      );
    }
    const cycle: TddCycle = {
      red_commits: testRun.commits.map((c) => c.sha),
      green_commits: [],
      red_tests: redTests,
      declared,
      opaque,
      production: [],
      red_binding: { head_sha: match.head_sha, tests_sha256: match.tests_sha256, evidence_sha256: match.evidence_sha256 },
    };
    if (productionRun !== undefined) {
      const pStart = parentOf.get((productionRun.commits[0] as TddCommit).sha) as string;
      const pEnd = (productionRun.commits[productionRun.commits.length - 1] as TddCommit).sha;
      const changed = changesOf(repo, pStart, pEnd);
      const blobs = blobsAt(repo, pEnd, changed.filter((c) => c.status !== 'D').map((c) => c.path));
      cycle.green_commits = productionRun.commits.map((c) => c.sha);
      cycle.production = changed.map((c) => ({ path: c.path, blob: c.status === 'D' ? null : (blobs.get(c.path) ?? null) })).sort(byPath);
      sawProduction = true;
    }
    record.cycles.push(cycle);
    pos += 2;
  }
  record.declarations_only = record.cycles.length === 0 && record.declarations.length > 0 && record.maintenance.length === 0;

  const claimed = args.claimed;
  if (claimed !== undefined && claimed !== null) {
    const mismatch = claimMismatch(record, claimed);
    if (mismatch !== null) return fail('TDD_CLAIM_MISMATCH', null, `the result's tdd claim does not match the repository: ${mismatch}`);
  }
  return { ...record, ok: true };
}

/**
 * The history of a node with no red gate that is not a refactor: a
 * declaration change and nothing else. It may hold no test (a test needs a
 * RED) and no runtime production code (behaviour needs a RED): only
 * production-only commits, at least one, every path inside the declaration
 * paths the claim binds. A claim that binds none accepts nothing.
 */
function declarationHistory(
  record: TddHistory,
  policy: TddPolicy,
  claimed: WorkerTddClaim | null,
  fail: (code: TddViolationCode, commit: string | null, detail: string, paths?: string[]) => TddHistory,
): TddHistory {
  if (policy.declaration_paths.length === 0) {
    return fail(
      'DECLARATION_PATHS_UNBOUND',
      null,
      "this node has no red gate, so it may change only the repository's declaration paths, and its claim binds none; declare them (repositories.yaml tdd.declaration_paths) or give the node a RED",
    );
  }
  const changes = record.commits.filter((c) => c.kind !== 'empty');
  if (changes.length === 0) {
    return fail('NO_DECLARATION_COMMIT', null, 'this declaration-only node committed nothing; commit the declaration change alone, production files only, then run green and regression');
  }
  for (const c of changes) {
    const offending = [...c.tests, ...c.production.filter((p) => !isDeclarationPath(policy, p))].sort();
    if (offending.length > 0) {
      return fail(
        'NOT_DECLARATION_ONLY',
        c.sha,
        `commit ${short(c.sha)} changes ${offending.join(', ')}; a node with no red gate may change only the declaration paths (${policy.declaration_paths.join(', ')}), committed alone: a test or a runtime change needs a node with a RED`,
        offending,
      );
    }
  }
  const done: TddHistory = { ...record, declarations: changes.flatMap((c) => c.production), declarations_only: true };
  if (claimed !== null) {
    const mismatch = claimMismatch(done, claimed);
    if (mismatch !== null) return { ...done, ok: false, violation: { code: 'TDD_CLAIM_MISMATCH', commit: null, detail: `the result's tdd claim does not match the repository: ${mismatch}` } };
  }
  return { ...done, ok: true };
}

function claimMismatch(record: TddHistory, claimed: WorkerTddClaim): string | null {
  if (claimed.head_sha !== record.head_sha) return `head ${short(claimed.head_sha)} is not ${short(record.head_sha)}`;
  if (claimed.base_sha !== record.base_sha) return `base ${short(claimed.base_sha)} is not ${short(record.base_sha)}`;
  if (claimed.cycles.length !== record.cycles.length) return `${claimed.cycles.length} cycle(s) claimed, ${record.cycles.length} in the history`;
  for (const [i, c] of claimed.cycles.entries()) {
    const actual = record.cycles[i] as TddCycle;
    if (canonical(c.red_commits) !== canonical(actual.red_commits)) return `cycle ${i + 1}: RED commits ${c.red_commits.map(short).join(', ')} are not ${actual.red_commits.map(short).join(', ')}`;
    if (canonical(c.green_commits) !== canonical(actual.green_commits)) return `cycle ${i + 1}: GREEN commits ${c.green_commits.map(short).join(', ')} are not ${actual.green_commits.map(short).join(', ')}`;
    if (c.red_tests !== undefined && !sameTests(c.red_tests, actual.red_tests)) return `cycle ${i + 1}: the RED test files or their blobs differ`;
  }
  return null;
}
