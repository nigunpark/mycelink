/**
 * Ephemeral reproduction capsules: an exact focused reproduction of a review
 * gap, sealed without a commit (CSET-203 r17).
 *
 * r17's fault arm: after the late hidden defect R005 found AC-1 on
 * apply-release-plan. The rework worker wrote R005's exact reproduction as a
 * focused test file — two cases of one template-literal title, in a loop —
 * and kept it out of the branch, as a challenge's reproduction is kept. It
 * passed on the unchanged base. Nothing could name its tests: the red gate's
 * reader of declarations names a test by a static title only, so the gate
 * kept no challenge material; the challenge line answered GATE_UNKNOWN, the
 * check line CRITERION_TEST_UNKNOWN (and NO_DECLARED_TESTS once the file was
 * committed). The worker answered BLOCKED and the node was parked after six
 * attempts. Requiring a focused reproduction to be committed (or statically
 * named) before it could count was an overconstraint; what must hold is its
 * integrity.
 *
 * A capsule gives such a reproduction a trusted identity without a commit:
 *
 * - its files, read from the claim's worktree (relative, inside the node's
 *   module and fence, test paths only, never through a link, bounded, free
 *   of credentials, the controller key and prompt delimiters), are sealed
 *   byte for byte under the control repository's evidence
 *   (features/<f>/evidence/<node>/capsules/<id>/), never in the product
 *   branch, index or worktree;
 * - the controller runs them with the claim's own module command on a
 *   throwaway checkout of the claim's unchanged base, set up as the claim's
 *   worktree was, and removes the checkout afterwards; each test that run
 *   reported from the capsule's files (every one of a new file; those its
 *   delta adds or changes in an existing one) is recorded by canonical id,
 *   name and status, and where its declaration block is;
 * - its id is the hash of everything it binds — feature, node, claim and
 *   generation, the one criterion, the order (review, revision, receipt,
 *   reason and the gap's reproduction), the base, the module plan and each
 *   file's bytes — and its receipt's hash is held in the claim's registry,
 *   written only by the claim's capability holder.
 *
 * A passing capsule is challenge material and nothing else (a review-gap
 * challenge cites it); a failing one is RED material and nothing else (its
 * exact files committed test-first, its red gate, the fix). A capsule is used
 * only by the claim, generation, order revision, base, module and criterion
 * it was sealed for: anything else is stale — the controller's state, never
 * the work's (administrative, never charged) — unless explicitly carried to a
 * rebased order whose reproduction is unchanged, its bytes and base verified.
 * An id or hash no registry holds, or an archive that does not hash as sealed,
 * fails closed.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { CapsuleRegistryEntry, ClaimVerification, NodeRuntime } from '../model/types.js';
import { runGit } from '../git/git.js';
import { INPUT_CHILD_TIMEOUT_MS, childProblem, withStdinFile } from '../util/child-stdin.js';
import { matchGlob } from '../git/worktree.js';
import { stableStringify } from '../graph/validate.js';
import { RED_VALID_CATEGORIES } from '../evidence/red-classify.js';
import { normalizeTestPath, type CanonicalTest } from '../evidence/test-ids.js';
import { testTitle } from '../evidence/test-identity.js';
import { classifyRelativePath, namesOpenedFile } from '../security/paths.js';
import { credentialKinds, redactText } from '../security/redact.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { safeSegment } from '../workspace/paths.js';
import { bodyPreserved, declarationBlocks, declaredTestTemplates, declaredTests, priorTestChanges, templateMatches } from './test-declarations.js';
import { isTestPath, type TddPolicy } from './tdd-history.js';

export const CAPSULE_SCHEMA = 'mycelink-reproduction-capsule/1';
/** Where a node's capsules are archived, under its evidence directory. */
export const CAPSULES_DIR = 'capsules';
/** What a capsule may hold, and what its reviewer's artifact may be. */
export const CAPSULE_LIMITS = { files: 8, file_bytes: 256 * 1024, total_bytes: 1024 * 1024, depth: 16, path_length: 400, per_claim: 16, artifact_bytes: 64 * 1024, line_chars: 400, receipt_bytes: 1024 * 1024 } as const;

export type CapsuleCode =
  | 'CAPSULE_UNAVAILABLE'
  | 'CAPSULE_NOT_REVIEW_REWORK'
  | 'CAPSULE_CRITERION'
  | 'CAPSULE_PATH'
  | 'CAPSULE_SYMLINK'
  | 'CAPSULE_SIZE'
  | 'CAPSULE_UNSAFE'
  | 'CAPSULE_EMPTY'
  | 'CAPSULE_WEAKENS'
  | 'CAPSULE_NO_REPORT'
  | 'CAPSULE_NO_TESTS'
  | 'CAPSULE_RUN_INVALID'
  | 'CAPSULE_SETUP_FAILED'
  | 'CAPSULE_LIMIT'
  | 'CAPSULE_STALE'
  | 'CAPSULE_UNKNOWN'
  | 'CAPSULE_TAMPERED'
  | 'CAPSULE_FAILED'
  | 'CAPSULE_PASSED'
  | 'CAPSULE_CARRY_CHANGED';

export interface CapsuleRefusal {
  ok: false;
  code: CapsuleCode;
  detail: string;
}

/** The review order a capsule answers, as the claim's brief bound it when it was sealed. */
export interface CapsuleOrder {
  review_id: string;
  review: number;
  revision: number;
  receipt_path: string | null;
  receipt_sha256: string | null;
  reason_sha256: string;
  /** SHA-256 of the gap's exact reproduction of the capsule's criterion. */
  reproduction_sha256: string;
}

/** Everything a capsule's id binds. */
export interface CapsuleIdentityInput {
  feature_id: string;
  node_id: string;
  claim_id: string;
  generation: number;
  criterion: string;
  order: CapsuleOrder;
  base_sha: string;
  module: { id: string; sha256: string; plan_sha256: string } | null;
  command: string[];
  files: { path: string; sha256: string }[];
}

/** A file read for a capsule, byte for byte. */
export interface CapsuleFileInput {
  path: string;
  bytes: Buffer;
  sha256: string;
  /** Its blob id, as `git hash-object` names it. */
  blob: string;
  /** The base's blob of the same path; null when the base has no such file. */
  base_blob?: string | null;
}

/** A test the capsule's run reported from its files. */
export interface CapsuleTest {
  id: string;
  path: string;
  full_name: string;
  name: string;
  status: string;
  category: string;
  /** How it is the capsule's: every test of a new file; a test its delta declares statically; or one its delta's template-titled declaration produced. */
  declared: 'file' | 'static' | 'template';
  /** Its declaration block, 1-based lines of its file; null when no declaration names or produces it. */
  block: { from: number; to: number } | null;
}

export interface CapsuleReceipt {
  schema: typeof CAPSULE_SCHEMA;
  capsule_id: string;
  identity_sha256: string;
  feature_id: string;
  node_id: string;
  repository: string;
  claim: { claim_id: string; generation: number; dispatch_id: string | null; capability_sha256: string };
  criterion: string;
  order: CapsuleOrder;
  base_sha: string;
  /** The integrated work the review judged, as the order's brief names it. */
  integration_sha: string | null;
  module: { id: string; sha256: string; plan_sha256: string; path: string | null } | null;
  command: string[];
  /** The module plan the claim bound (its setup, build, test command and report), so an independent replay runs exactly it. */
  verification?: ClaimVerification | null;
  files: { path: string; base_blob: string | null; blob: string; sha256: string; bytes: number; archived: string }[];
  tests: CapsuleTest[];
  result: 'passed' | 'failed';
  run: {
    output_path: string;
    output_sha256: string;
    results_path: string | null;
    results_sha256: string | null;
    exit_code: number;
    commit_sha: string | null;
    worktree_setup_sha256: string | null;
    started_at: string;
    finished_at: string;
  };
  /** The bounded, sanitized rendering a reviewer reads: the tests and the files' source with line numbers. */
  artifact: { path: string; sha256: string };
  /** Carried to a rebased order: the capsule it was sealed as first. */
  carried_from: { capsule_id: string; capsule_sha256: string } | null;
  registered_at: string;
}

/** A capsule as the claim's registry holds it (STATE.json, written by the capability holder only). */
export type { CapsuleRegistryEntry };

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const slash = (p: string): string => p.replace(/\\/g, '/');

// ---- paths and content ------------------------------------------------------------

/** Why a capsule path is not one (relative, inside the repository, bounded, no device or stream), or null. */
export function capsulePathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return 'is empty';
  if (path.length > CAPSULE_LIMITS.path_length) return `is too long (over ${CAPSULE_LIMITS.path_length} characters)`;
  if (path.includes('\u0000')) return 'holds a NUL byte';
  if (path.includes('\\')) return 'holds a backslash: name it with forward slashes';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'is absolute';
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'is not a plain relative path (an empty, "." or ".." segment)';
  if (segments.length > CAPSULE_LIMITS.depth) return `is too deep (over ${CAPSULE_LIMITS.depth} segments)`;
  const problem = classifyRelativePath(path);
  if (problem !== null) return `is unsafe (${problem})`;
  return null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const LITERAL_CAPABILITY = /--(?:authority|capability)[\s=,"'`]+[0-9a-f]{32,}/i;
const DELIMITER = /<\/?\s*mycelink-[a-z0-9-]+\b[^>]*>/i;

/**
 * Why a capsule file's content may not be sealed, or null: it is UTF-8 text with no control, bidirectional-override
 * or byte-order character, no credential, no controller key or literal capability, no Mycelink prompt delimiter.
 */
export function capsuleContentProblem(content: string | Buffer, holdsAuthority?: (text: string) => boolean): string | null {
  let text: string;
  if (typeof content === 'string') text = content;
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      return 'is not UTF-8 text';
    }
  }
  if (CONTROL.test(text)) return 'carries a control, bidirectional-override or byte-order character';
  const credentials = credentialKinds(text);
  if (credentials.length > 0) return `carries a credential (${credentials.join(', ')})`;
  if (holdsAuthority?.(text) === true) return 'carries the controller key';
  if (LITERAL_CAPABILITY.test(text)) return 'carries a literal capability or authority value';
  if (DELIMITER.test(text)) return 'carries a Mycelink prompt delimiter';
  return null;
}

/** Read a regular file without following a link at its name, bounded; null when it is no such file. */
function readNoFollow(file: string, max: number): { bytes: Buffer } | { problem: 'missing' | 'link' | 'not-file' | 'too-large' } {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return { problem: 'link' };
    try {
      return lstatSync(file).isSymbolicLink() ? { problem: 'link' } : { problem: 'missing' };
    } catch {
      return { problem: 'missing' };
    }
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return { problem: 'not-file' };
    if (opened.nlink !== 1n || !namesOpenedFile(file, opened)) return { problem: 'link' };
    if (opened.size > BigInt(max)) return { problem: 'too-large' };
    return { bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

/** The first link on the way from `root` to `rel` (the file itself included), or null. */
function linkOnTheWay(root: string, rel: string): string | null {
  let at = root;
  for (const segment of rel.split('/')) {
    at = join(at, segment);
    try {
      if (lstatSync(at).isSymbolicLink()) return slash(relative(root, at));
    } catch {
      return null;
    }
  }
  return null;
}

/** Paths that differ from HEAD in a worktree (staged, unstaged or untracked; deletions and ignored files excluded). */
function changedPaths(worktree: string): string[] {
  const out = runGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).stdout;
  const paths = new Set<string>();
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue;
    if (entry[0] === 'D' || entry[1] === 'D') continue;
    paths.add(slash(entry.slice(3)));
  }
  return [...paths].sort();
}

/** A worktree file's blob id, as `git add` would name it. */
function blobOf(worktree: string, path: string, bytes: Buffer): string {
  // The bytes read, as a finished file; the child bounded (util/child-stdin.ts).
  const proc = withStdinFile(bytes, (stdin) =>
    spawnSync('git', ['hash-object', '--path', path, '--stdin'], { cwd: worktree, stdio: [stdin, 'pipe', 'pipe'], encoding: 'utf8', shell: false, windowsHide: true, timeout: INPUT_CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
  );
  const blob = String(proc.stdout ?? '').trim();
  if (proc.status === 0 && /^[0-9a-f]{40,64}$/.test(blob)) return blob;
  throw new Error(`${childProblem(`git hash-object for ${path}`, proc, bytes.length)} in ${worktree}`);
}

/** The blob of `path` at `rev`, or null when the revision has no such file. */
export function blobAt(repo: string, rev: string, path: string): string | null {
  const r = runGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}:${path}`], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * The files of a capsule, read from the claim's worktree: the named ones, else every test file that differs from
 * HEAD. Each is a test path of the claim's policy inside the node's fence and module, a regular file reached through
 * no link, bounded, safe to seal, and not as `base` (else HEAD) holds it. Nothing of the worktree is changed.
 */
export function collectCapsuleFiles(args: {
  worktree: string;
  policy: TddPolicy;
  allowed: readonly string[];
  forbidden: readonly string[];
  modulePath: string | null;
  paths: readonly string[] | null;
  base?: string | null;
  holdsAuthority?: (text: string) => boolean;
}): { ok: true; files: CapsuleFileInput[] } | CapsuleRefusal {
  const refuse = (code: CapsuleCode, detail: string): CapsuleRefusal => ({ ok: false, code, detail });
  const named = args.paths !== null;
  const candidates = named ? [...new Set((args.paths as readonly string[]).map((p) => p.trim()).filter((p) => p !== ''))] : changedPaths(args.worktree).filter((p) => isTestPath(args.policy, p));
  if (candidates.length === 0) {
    return refuse('CAPSULE_EMPTY', named ? 'no file was named' : "no test file differs from the worktree's HEAD: write the exact focused reproduction of the review's gap as a test file (it stays uncommitted), then seal it");
  }
  if (candidates.length > CAPSULE_LIMITS.files) return refuse('CAPSULE_SIZE', `${candidates.length} files: a capsule holds at most ${CAPSULE_LIMITS.files} (name its own files with --files)`);
  let root: string;
  try {
    root = realpathSync(args.worktree);
  } catch {
    return refuse('CAPSULE_UNAVAILABLE', `the claim's worktree ${args.worktree} cannot be read`);
  }
  const reference = args.base ?? 'HEAD';
  const files: CapsuleFileInput[] = [];
  let total = 0;
  for (const path of candidates) {
    const problem = capsulePathProblem(path);
    if (problem !== null) return refuse('CAPSULE_PATH', `${JSON.stringify(path.slice(0, 120))} ${problem}`);
    if (!isTestPath(args.policy, path)) return refuse('CAPSULE_PATH', `${path} is not a test path of the claim's policy: a capsule holds tests only`);
    const inFence = args.allowed.some((g) => matchGlob(g, path)) && !args.forbidden.some((g) => matchGlob(g, path));
    const inModule = args.modulePath === null || path.startsWith(`${args.modulePath}/`);
    if (!inFence || !inModule) return refuse('CAPSULE_PATH', `${path} is outside the node's ${args.modulePath !== null ? `module (${args.modulePath})` : 'allowed paths'}`);
    const link = linkOnTheWay(root, path);
    if (link !== null) return refuse('CAPSULE_SYMLINK', `${path}: ${link} is a link; a capsule never reads through one`);
    const full = join(root, ...path.split('/'));
    const read = readNoFollow(full, CAPSULE_LIMITS.file_bytes);
    if ('problem' in read) {
      if (read.problem === 'link') return refuse('CAPSULE_SYMLINK', `${path} is a link (or has another name); a capsule never reads through one`);
      if (read.problem === 'too-large') return refuse('CAPSULE_SIZE', `${path} is over ${CAPSULE_LIMITS.file_bytes} bytes`);
      return refuse('CAPSULE_PATH', `${path} is not a regular file in the worktree`);
    }
    // Contained after every link was resolved too.
    try {
      const real = realpathSync(full);
      if (real !== root && !real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return refuse('CAPSULE_SYMLINK', `${path} resolves outside the worktree`);
    } catch {
      return refuse('CAPSULE_PATH', `${path} cannot be resolved`);
    }
    total += read.bytes.length;
    if (total > CAPSULE_LIMITS.total_bytes) return refuse('CAPSULE_SIZE', `the files are over ${CAPSULE_LIMITS.total_bytes} bytes together`);
    const unsafe = capsuleContentProblem(read.bytes, args.holdsAuthority);
    if (unsafe !== null) return refuse('CAPSULE_UNSAFE', `${path} ${unsafe}`);
    const blob = blobOf(root, path, read.bytes);
    if (blob === blobAt(root, reference, path)) return refuse('CAPSULE_EMPTY', `${path} is as ${args.base !== undefined && args.base !== null ? `the base ${reference.slice(0, 12)}` : 'HEAD'} holds it: a capsule seals a reproduction, a change`);
    files.push({ path, bytes: read.bytes, sha256: sha256(read.bytes), blob });
  }
  return { ok: true, files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

// ---- identity -------------------------------------------------------------------------

/** A capsule's id and identity hash: everything it binds, canonical; the id is `CAP-` and the hash's first 16 hex digits. */
export function capsuleIdentity(input: CapsuleIdentityInput): { identity_sha256: string; capsule_id: string } {
  const canonical = { schema: CAPSULE_SCHEMA, ...input, files: [...input.files].map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  const identity = sha256(stableStringify(canonical));
  return { identity_sha256: identity, capsule_id: `CAP-${identity.slice(0, 16)}` };
}

/** The identity a receipt binds, recomputed from its own fields. */
function receiptIdentity(c: CapsuleReceipt): { identity_sha256: string; capsule_id: string } {
  return capsuleIdentity({
    feature_id: c.feature_id,
    node_id: c.node_id,
    claim_id: c.claim.claim_id,
    generation: c.claim.generation,
    criterion: c.criterion,
    order: c.order,
    base_sha: c.base_sha,
    module: c.module === null ? null : { id: c.module.id, sha256: c.module.sha256, plan_sha256: c.module.plan_sha256 },
    command: c.command,
    files: c.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
  });
}

// ---- the tests a run reported --------------------------------------------------------------

/** The 1-based line span of a test's declaration block in `source`: its static declaration, else the one template that produces its title. */
export function capsuleTestBlock(source: string, path: string, test: { name: string; full_name: string }): { from: number; to: number } | null {
  const text = source.replace(/\r\n/g, '\n');
  const name = test.name !== '' ? test.name : testTitle(path, test.full_name);
  const statics = declaredTests(path, text).filter((t) => t.name === test.full_name || t.name === name);
  let block: string | null = statics.length === 1 ? (statics[0] as { block: string }).block : null;
  if (block === null && statics.length === 0) {
    const templates = declaredTestTemplates(path, text).filter((t) => templateMatches(t.template, name));
    if (templates.length === 1) block = (templates[0] as { block: string }).block;
  }
  if (block === null) return null;
  const start = text.indexOf(block);
  if (start < 0) return null;
  const from = text.slice(0, start).split('\n').length;
  return { from, to: from + block.split('\n').length - 1 };
}

/** Parameterised and repeated tests report as `name(args)[n]`. */
const nameMatches = (reported: string, declared: string): boolean => reported === declared || reported.startsWith(`${declared}(`) || reported.startsWith(`${declared}[`);

/**
 * The capsule's tests: what its run reported from its own files — every test of a file the base does not have; of an
 * existing file, the tests its delta adds or changes (a static declaration's, or one a template-titled declaration of
 * the delta produced). Report order, without duplicates.
 */
export function capsuleTests(args: { files: readonly { path: string; before: string | null; after: string }[]; ran: readonly CanonicalTest[] }): CapsuleTest[] {
  const out: CapsuleTest[] = [];
  const seen = new Set<string>();
  for (const f of args.files) {
    const path = normalizeTestPath(f.path);
    const reported = args.ran.filter((t) => t.path === path);
    let mine: { test: CanonicalTest; declared: CapsuleTest['declared'] }[];
    if (f.before === null) mine = reported.map((test) => ({ test, declared: 'file' as const }));
    else {
      // The declarations the delta adds, or whose body it changes (a block that only grew by what was appended after it is
      // the same test), static and template-titled alike, each block bounded by the next declaration of either kind.
      const before = new Map(declarationBlocks(f.path, f.before).map((d) => [`${d.kind}:${d.key}`, d.block]));
      const delta = declarationBlocks(f.path, f.after).filter((d) => {
        const was = before.get(`${d.kind}:${d.key}`);
        return was === undefined || (was !== d.block && !bodyPreserved(was, d.block));
      });
      mine = reported.flatMap((test): { test: CanonicalTest; declared: CapsuleTest['declared'] }[] => {
        if (delta.some((d) => d.kind === 'static' && (nameMatches(test.name, d.key) || test.full_name === d.key))) return [{ test, declared: 'static' }];
        if (delta.some((d) => d.kind === 'template' && templateMatches(d.key, test.name))) return [{ test, declared: 'template' }];
        return [];
      });
    }
    for (const { test, declared } of mine) {
      if (seen.has(test.id)) continue;
      seen.add(test.id);
      out.push({ id: test.id, path: test.path, full_name: test.full_name, name: test.name, status: test.status, category: test.category, declared, block: capsuleTestBlock(f.after, f.path, test) });
    }
  }
  return out;
}

/**
 * What a capsule's delta does to tests its base already has — the only thing a reproduction may not do: remove or
 * edit one (its body, statically or template-titled), change existing test data or test code Mycelink cannot read.
 * Empty when it only adds.
 */
export function capsuleWeakening(files: readonly { path: string; before: string | null; after: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.before === null || f.before === f.after) continue;
    const prior = priorTestChanges([{ path: f.path, before: f.before, after: f.after }]);
    out.push(...prior.removed.map((t) => `removes ${t.file} › ${t.name}`), ...prior.edited.map((t) => `edits ${t.file} › ${t.name}`), ...prior.data.map((p) => `changes the existing test data ${p}`), ...prior.opaque.map((p) => `changes test code Mycelink cannot read (${p})`));
  }
  return [...out, ...templateWeakening(files)];
}

/** What a delta does to the template-titled tests its base already has (which no static reader names): removes or edits one. */
export function templateWeakening(files: readonly { path: string; before: string | null; after: string }[]): string[] {
  const out: string[] = [];
  const closers = /[\s)}\];,]+$/;
  for (const f of files) {
    if (f.before === null || f.before === f.after) continue;
    const now = new Map(declaredTestTemplates(f.path, f.after).map((t) => [t.template, t.block]));
    for (const t of declaredTestTemplates(f.path, f.before)) {
      const block = now.get(t.template);
      if (block === undefined) out.push(`removes ${f.path} › ${t.template}`);
      else if (block !== t.block && !block.startsWith(t.block.replace(closers, ''))) out.push(`edits ${f.path} › ${t.template}`);
    }
  }
  return out;
}

/** What a capsule's run comes to: passed (every test passed), failed (one failed for a missing behaviour, none for another reason), or no capsule. */
export function capsuleOutcome(tests: readonly CapsuleTest[]): { ok: true; result: 'passed' | 'failed' } | { ok: false; detail: string } {
  if (tests.length === 0) return { ok: false, detail: "its run reported no test from the capsule's files: the files must declare the reproduction's tests and the module's command must run them" };
  const idle = tests.filter((t) => t.status !== 'passed' && t.status !== 'failed');
  if (idle.length > 0) return { ok: false, detail: `${idle.map((t) => `${t.full_name} (${t.status})`).slice(0, 5).join(', ')} did not run to an outcome (skipped, or not run): a reproduction runs every test it declares` };
  const wrong = tests.filter((t) => t.status === 'failed' && !RED_VALID_CATEGORIES.has(t.category));
  if (wrong.length > 0) return { ok: false, detail: `${wrong.map((t) => `${t.full_name} (${t.category})`).slice(0, 5).join(', ')} failed for another reason than a missing behaviour: fix the test (an import, a syntax error, a setup step) and seal it again` };
  return { ok: true, result: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed' };
}

// ---- the archive -----------------------------------------------------------------------

/** The directory of a capsule's archive, relative to the control root. */
export function capsuleDir(featureId: string, nodeId: string, capsuleId: string): string {
  return `features/${featureId}/evidence/${safeSegment(nodeId)}/${CAPSULES_DIR}/${capsuleId}`;
}

/** Sanitized for a reviewer: no credential, no control character, bounded per line. */
function cleanLine(line: string, redacted = false): string {
  // eslint-disable-next-line no-control-regex
  const plain = (redacted ? line : redactText(line)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '?');
  return plain.length > CAPSULE_LIMITS.line_chars ? `${plain.slice(0, CAPSULE_LIMITS.line_chars)} [cut]` : plain;
}

/**
 * The reviewer's artifact of a capsule: what it binds, each test (id, status, title, its block's lines) and each
 * file's source with line numbers — sanitized and bounded (CAPSULE_LIMITS.artifact_bytes), cut and marked beyond.
 */
export function capsuleArtifact(capsule: Pick<CapsuleReceipt, 'capsule_id' | 'criterion' | 'result' | 'order' | 'base_sha' | 'module' | 'tests' | 'files'>, sources: ReadonlyMap<string, string>): string {
  const limit = CAPSULE_LIMITS.artifact_bytes - 64;
  const kept: string[] = [];
  let bytes = 0;
  // Each line cleaned only as it is taken: the bound is reached before anything past it is read.
  const take = (line: () => string): boolean => {
    const l = line();
    const size = Buffer.byteLength(l, 'utf8') + 1;
    if (bytes + size > limit) {
      kept.push('[... cut: the artifact is bounded; the archived files are whole]');
      return false;
    }
    kept.push(l);
    bytes += size;
    return true;
  };
  const head = [
    `Reproduction capsule ${capsule.capsule_id}: ${capsule.criterion}, ${capsule.result} on the unchanged base ${capsule.base_sha.slice(0, 12)}`,
    `Order: ${capsule.order.review_id} revision ${capsule.order.revision}; reproduction sha256 ${capsule.order.reproduction_sha256}`,
    `Module: ${capsule.module?.id ?? '(the node verifier)'}`,
    'Tests (id, status, path › title, declaration lines):',
  ];
  const all = (): boolean => {
    for (const l of head) if (!take(() => cleanLine(l))) return false;
    for (const t of capsule.tests) if (!take(() => cleanLine(`  ${t.id} ${t.status} ${t.path} › ${t.full_name}${t.block !== null ? `  [L${t.block.from}-L${t.block.to}]` : ''}`))) return false;
    for (const f of capsule.files) {
      if (!take(() => '') || !take(() => cleanLine(`== ${f.path} (sha256 ${f.sha256}, ${f.base_blob === null ? 'a new file' : `changing the base's blob ${f.base_blob.slice(0, 12)}`})`))) return false;
      // Redacted once, whole (a key spans lines), then cut into lines.
      const text = redactText(sources.get(f.path) ?? '').replace(/\r\n/g, '\n').split('\n');
      const width = String(text.length).length;
      for (const [i, l] of text.entries()) if (!take(() => `${String(i + 1).padStart(width, ' ')}  ${cleanLine(l, true)}`)) return false;
    }
    return true;
  };
  all();
  return `${kept.join('\n')}\n`;
}

export interface WriteCapsuleArgs {
  controlRoot: string;
  featureId: string;
  nodeId: string;
  identity: CapsuleIdentityInput;
  identity_sha256: string;
  capsule_id: string;
  repository: string;
  claim: CapsuleReceipt['claim'];
  integration_sha: string | null;
  module_path?: string | null;
  verification?: ClaimVerification | null;
  files: readonly CapsuleFileInput[];
  tests: readonly CapsuleTest[];
  result: 'passed' | 'failed';
  /** The run, its output and results files where it wrote them (absolute paths), or already archived ones being carried. */
  run: { output_file: string; results_file: string | null; exit_code: number; commit_sha: string | null; worktree_setup_sha256: string | null; started_at: string; finished_at: string };
  carried_from: CapsuleReceipt['carried_from'];
}

/**
 * Seal a capsule's archive: its files byte for byte, its run's output and results, the reviewer's artifact and the
 * receipt binding them, written into a staging directory and moved into place in one rename. An archive already in
 * place for the same id is kept as it is: the receipt path and hash of what is there.
 */
export function writeCapsuleArchive(args: WriteCapsuleArgs): { receipt_path: string; capsule_sha256: string; capsule: CapsuleReceipt } {
  const rel = capsuleDir(args.featureId, args.nodeId, args.capsule_id);
  const final = join(args.controlRoot, ...rel.split('/'));
  const receiptPath = `${rel}/capsule.json`;
  if (existsSync(join(final, 'capsule.json'))) {
    const read = readCapsule(args.controlRoot, receiptPath);
    if (read.ok) return { receipt_path: receiptPath, capsule_sha256: read.capsule_sha256, capsule: read.capsule };
  }
  const parent = dirname(final);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.staging-${args.capsule_id}-${process.pid}-${Date.now().toString(36)}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const files = args.files.map((f) => {
      const target = join(staging, 'files', ...f.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.bytes, { flag: 'wx' });
      return { path: f.path, base_blob: f.base_blob ?? null, blob: f.blob, sha256: f.sha256, bytes: f.bytes.length, archived: `${rel}/files/${f.path}` };
    });
    mkdirSync(join(staging, 'run'), { recursive: true });
    const output = readFileSync(args.run.output_file);
    writeFileSync(join(staging, 'run', 'capsule.log'), output, { flag: 'wx' });
    const results = args.run.results_file === null ? null : readFileSync(args.run.results_file);
    if (results !== null) writeFileSync(join(staging, 'run', 'capsule.results.json'), results, { flag: 'wx' });
    const base = {
      capsule_id: args.capsule_id,
      criterion: args.identity.criterion,
      result: args.result,
      order: args.identity.order,
      base_sha: args.identity.base_sha,
      module: args.identity.module === null ? null : { ...args.identity.module, path: args.module_path ?? null },
      tests: [...args.tests],
      files,
    };
    const artifact = capsuleArtifact(base, new Map(args.files.map((f) => [f.path, f.bytes.toString('utf8')])));
    writeFileSync(join(staging, 'artifact.txt'), artifact, { encoding: 'utf8', flag: 'wx' });
    const receipt: CapsuleReceipt = {
      schema: CAPSULE_SCHEMA,
      capsule_id: args.capsule_id,
      identity_sha256: args.identity_sha256,
      feature_id: args.featureId,
      node_id: args.nodeId,
      repository: args.repository,
      claim: { ...args.claim },
      criterion: args.identity.criterion,
      order: { ...args.identity.order },
      base_sha: args.identity.base_sha,
      integration_sha: args.integration_sha,
      module: base.module,
      command: [...args.identity.command],
      verification: args.verification ?? null,
      files,
      tests: [...args.tests],
      result: args.result,
      run: {
        output_path: `${rel}/run/capsule.log`,
        output_sha256: sha256(output),
        results_path: results === null ? null : `${rel}/run/capsule.results.json`,
        results_sha256: results === null ? null : sha256(results),
        exit_code: args.run.exit_code,
        commit_sha: args.run.commit_sha,
        worktree_setup_sha256: args.run.worktree_setup_sha256,
        started_at: args.run.started_at,
        finished_at: args.run.finished_at,
      },
      artifact: { path: `${rel}/artifact.txt`, sha256: sha256(Buffer.from(artifact, 'utf8')) },
      carried_from: args.carried_from,
      registered_at: new Date().toISOString(),
    };
    const body = JSON.stringify(receipt, null, 2) + '\n';
    writeTextAtomic(join(staging, 'capsule.json'), body);
    try {
      renameSync(staging, final);
    } catch (err) {
      // Sealed meanwhile by another registration of the same identity: that one stands.
      if (!existsSync(join(final, 'capsule.json'))) throw err;
      rmSync(staging, { recursive: true, force: true });
      const read = readCapsule(args.controlRoot, receiptPath);
      if (!read.ok) throw new Error(`${read.code}: ${read.detail}`);
      return { receipt_path: receiptPath, capsule_sha256: read.capsule_sha256, capsule: read.capsule };
    }
    return { receipt_path: receiptPath, capsule_sha256: sha256(body), capsule: receipt };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** Staging directories a sealing that died left in a node's capsules directory. */
export function removeCapsuleStaging(controlRoot: string, featureId: string, nodeId: string): void {
  const dir = join(controlRoot, 'features', featureId, 'evidence', safeSegment(nodeId), CAPSULES_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) if (n.startsWith('.staging-') || n.startsWith('.run-')) rmSync(join(dir, n), { recursive: true, force: true });
}

/** A capsule's receipt, read back (bounded, never through a link) and, given `expected`, checked against the hash its registry holds. */
export function readCapsule(controlRoot: string, receiptPath: string, expected?: string | null): { ok: true; capsule: CapsuleReceipt; capsule_sha256: string } | CapsuleRefusal {
  if (capsulePathProblem(receiptPath) !== null || !/^features\/[^/]+\/evidence\/[^/]+\/capsules\/CAP-[0-9a-f]{16}\/capsule\.json$/.test(receiptPath)) {
    return { ok: false, code: 'CAPSULE_UNKNOWN', detail: `${receiptPath.slice(0, 200)} is not a capsule receipt's path` };
  }
  const read = readNoFollow(join(controlRoot, ...receiptPath.split('/')), CAPSULE_LIMITS.receipt_bytes);
  if ('problem' in read) return { ok: false, code: read.problem === 'missing' ? 'CAPSULE_UNKNOWN' : 'CAPSULE_TAMPERED', detail: `${receiptPath} is ${read.problem === 'missing' ? 'missing' : 'not a plain regular file'}` };
  const hash = sha256(read.bytes);
  if (expected !== undefined && expected !== null && hash !== expected) return { ok: false, code: 'CAPSULE_TAMPERED', detail: `${receiptPath} hashes to ${hash.slice(0, 12)}, not ${expected.slice(0, 12)} as sealed` };
  let capsule: CapsuleReceipt;
  try {
    capsule = JSON.parse(read.bytes.toString('utf8')) as CapsuleReceipt;
  } catch {
    return { ok: false, code: 'CAPSULE_TAMPERED', detail: `${receiptPath} is not JSON` };
  }
  if (capsule === null || typeof capsule !== 'object' || capsule.schema !== CAPSULE_SCHEMA || !Array.isArray(capsule.files) || !Array.isArray(capsule.tests) || typeof capsule.run !== 'object' || capsule.run === null || typeof capsule.artifact !== 'object' || capsule.artifact === null) {
    return { ok: false, code: 'CAPSULE_TAMPERED', detail: `${receiptPath} is not a capsule receipt (${CAPSULE_SCHEMA})` };
  }
  return { ok: true, capsule, capsule_sha256: hash };
}

/** Why a capsule's archive is not what its receipt sealed (a file, the run's output or results, the artifact), or null. */
export function capsuleArchiveProblem(controlRoot: string, capsule: CapsuleReceipt): string | null {
  const dir = capsuleDir(capsule.feature_id, capsule.node_id, capsule.capsule_id);
  const check = (rel: string, sha: string, what: string): string | null => {
    if (!rel.startsWith(`${dir}/`) || capsulePathProblem(rel) !== null) return `CAPSULE_TAMPERED: ${what} ${rel.slice(0, 160)} is outside the capsule's archive`;
    const read = readNoFollow(join(controlRoot, ...rel.split('/')), CAPSULE_LIMITS.total_bytes * 64);
    if ('problem' in read) return `CAPSULE_TAMPERED: ${what} ${rel} is ${read.problem === 'missing' ? 'missing' : 'not a plain regular file'}`;
    const got = sha256(read.bytes);
    return got === sha ? null : `CAPSULE_TAMPERED: ${what} ${rel} hashes to ${got.slice(0, 12)}, not ${sha.slice(0, 12)} as sealed`;
  };
  for (const f of capsule.files) {
    const problem = check(f.archived, f.sha256, `the file ${f.path}`);
    if (problem !== null) return problem;
  }
  const output = check(capsule.run.output_path, capsule.run.output_sha256, "the run's output");
  if (output !== null) return output;
  if (capsule.run.results_path !== null && capsule.run.results_sha256 !== null) {
    const results = check(capsule.run.results_path, capsule.run.results_sha256, "the run's results");
    if (results !== null) return results;
  }
  return check(capsule.artifact.path, capsule.artifact.sha256, "the reviewer's artifact");
}

/** Whether a receipt is self-consistent: its id and identity hash are what its own fields bind. A copy with another id is a forgery. */
export function capsuleSelfConsistent(capsule: CapsuleReceipt): boolean {
  const recomputed = receiptIdentity(capsule);
  return recomputed.identity_sha256 === capsule.identity_sha256 && recomputed.capsule_id === capsule.capsule_id;
}

// ---- use ---------------------------------------------------------------------------------

/** The order a claim's brief binds now, for a criterion: what a current capsule of it must have been sealed for. */
export function currentOrder(runtime: NodeRuntime, criterion: string): CapsuleOrder | null {
  const brief = runtime.rework_brief ?? null;
  const origin = brief?.origin ?? null;
  if (brief === null || origin === null || origin.kind !== 'acceptance-review') return null;
  const reproduction = brief.review_gaps?.find((g) => g.criterion === criterion)?.reproduction_sha256 ?? null;
  if (reproduction === null) return null;
  return { review_id: origin.review_id, review: origin.review, revision: origin.revision ?? 0, receipt_path: origin.receipt_path ?? null, receipt_sha256: origin.receipt_sha256 ?? null, reason_sha256: brief.reason_sha256, reproduction_sha256: reproduction };
}

/** Why a sealed order is not the claim's current one, or null. Only the review, revision, its receipt, the reason and the reproduction count. */
export function orderDrift(sealed: CapsuleOrder, now: CapsuleOrder | null): string | null {
  if (now === null) return 'the claim holds no review order of its criterion any more';
  if (sealed.review_id !== now.review_id) return `it answers ${sealed.review_id}, the order is ${now.review_id}'s`;
  if (sealed.revision !== now.revision || (sealed.receipt_sha256 !== null && now.receipt_sha256 !== null && sealed.receipt_sha256 !== now.receipt_sha256)) return `it was sealed for revision ${sealed.revision} of ${sealed.review_id}, the order is at revision ${now.revision}`;
  if (sealed.reason_sha256 !== now.reason_sha256) return "the order's exact reason changed since it was sealed";
  if (sealed.reproduction_sha256 !== now.reproduction_sha256) return "the gap's exact reproduction changed since it was sealed";
  return null;
}

export type CapsuleUse = { ok: true; capsule: CapsuleReceipt; capsule_sha256: string; entry: CapsuleRegistryEntry } | { ok: false; code: CapsuleCode; detail: string; administrative: boolean };

/**
 * A capsule as a claim may use it now: in the claim's own registry (an id or hash it does not hold fails closed —
 * unless an intact archive of it exists, sealed for another claim or before a rebase: stale, administrative), its
 * receipt and archive as sealed (else tampered), sealed for this claim, generation, base, module plan and current
 * order (else stale, administrative: carried explicitly, or sealed again), for `criterion` (another one is refused)
 * and with the result its use needs (passing for a challenge, failing for a RED).
 */
export function capsuleUse(args: {
  controlRoot: string;
  featureId: string;
  nodeId: string;
  runtime: NodeRuntime;
  capsuleId: string;
  capsuleSha256: string | null;
  criterion: string | null;
  want: 'passed' | 'failed' | null;
}): CapsuleUse {
  const refuse = (code: CapsuleCode, detail: string, administrative = false): CapsuleUse => ({ ok: false, code, detail: `${args.capsuleId}: ${detail}`, administrative });
  if (!/^CAP-[0-9a-f]{16}$/.test(args.capsuleId)) return refuse('CAPSULE_UNKNOWN', 'is not a capsule id (CAP- and 16 hex digits)');
  const claim = args.runtime.claim ?? null;
  const entry = (claim?.capsules ?? []).find((e) => e.capsule_id === args.capsuleId);
  if (claim === null || entry === undefined) {
    // Not this claim's: an intact archive of it is a late (or another claim's) reuse — stale; else no such capsule exists.
    const read = readCapsule(args.controlRoot, `${capsuleDir(args.featureId, args.nodeId, args.capsuleId)}/capsule.json`);
    if (read.ok && capsuleSelfConsistent(read.capsule) && read.capsule.capsule_id === args.capsuleId && (args.capsuleSha256 === null || args.capsuleSha256 === read.capsule_sha256)) {
      return refuse('CAPSULE_STALE', claim === null ? 'no claim of the node holds it now' : `it is not a capsule this claim sealed (it was sealed by claim ${read.capsule.claim.claim_id.slice(0, 8)}, generation ${read.capsule.claim.generation}): a capsule is used only by the claim that sealed it; seal the reproduction again`, true);
    }
    return refuse('CAPSULE_UNKNOWN', 'no capsule of this id and hash was sealed for this node');
  }
  if (args.capsuleSha256 !== null && args.capsuleSha256 !== entry.capsule_sha256) return refuse('CAPSULE_UNKNOWN', `its hash is ${entry.capsule_sha256.slice(0, 12)} as sealed, not ${args.capsuleSha256.slice(0, 12)}`);
  const read = readCapsule(args.controlRoot, entry.receipt_path, entry.capsule_sha256);
  if (!read.ok) return refuse(read.code === 'CAPSULE_UNKNOWN' ? 'CAPSULE_TAMPERED' : read.code, read.detail);
  const capsule = read.capsule;
  if (capsule.capsule_id !== entry.capsule_id || !capsuleSelfConsistent(capsule)) return refuse('CAPSULE_TAMPERED', 'its receipt does not bind the id it is registered under');
  const archive = capsuleArchiveProblem(args.controlRoot, capsule);
  if (archive !== null) return refuse('CAPSULE_TAMPERED', archive);
  if (capsule.claim.capability_sha256 !== entry.capability_sha256) return refuse('CAPSULE_UNKNOWN', "its registration names another capability than its receipt's");
  // Sealed for exactly this claim's generation, base, module plan and order: anything else is stale.
  if (capsule.claim.claim_id !== claim.claim_id || capsule.feature_id !== args.featureId || capsule.node_id !== args.nodeId) return refuse('CAPSULE_STALE', `it was sealed for claim ${capsule.claim.claim_id.slice(0, 8)}, not this claim`, true);
  if (capsule.claim.generation !== (claim.generation ?? 0)) return refuse('CAPSULE_STALE', `it was sealed in generation ${capsule.claim.generation}, the claim is at generation ${claim.generation ?? 0}`, true);
  const base = claim.base_sha ?? args.runtime.branch_base_sha ?? null;
  if (base === null || capsule.base_sha !== base) return refuse('CAPSULE_STALE', `it ran on ${capsule.base_sha.slice(0, 12)}, the claim's base is ${String(base).slice(0, 12)}`, true);
  const bound = claim.verification;
  if ((bound === undefined) !== (capsule.module === null) || (bound !== undefined && capsule.module !== null && (bound.module !== capsule.module.id || bound.module_sha256 !== capsule.module.sha256 || bound.plan_sha256 !== capsule.module.plan_sha256))) {
    return refuse('CAPSULE_STALE', "it ran another module command than the one the claim binds now", true);
  }
  const drift = orderDrift(capsule.order, currentOrder(args.runtime, capsule.criterion));
  if (drift !== null) return refuse('CAPSULE_STALE', `${drift}: carry it (tdd capsule --carry ${capsule.capsule_id}) when its reproduction is unchanged, else seal the new reproduction`, true);
  if (!(args.runtime.rework_brief?.acceptance_criteria ?? []).includes(capsule.criterion)) return refuse('CAPSULE_STALE', `${capsule.criterion} is not a criterion of the claim's order any more`, true);
  if (args.criterion !== null && args.criterion !== capsule.criterion) return refuse('CAPSULE_CRITERION', `it was sealed for ${capsule.criterion}, not ${args.criterion}: a capsule reproduces one criterion's gap`);
  if (args.want === 'passed' && capsule.result !== 'passed') return refuse('CAPSULE_FAILED', 'its reproduction failed on the unchanged base: the gap reproduces, so it is a RED (its files committed test-first, the red gate, the fix), never a challenge');
  if (args.want === 'failed' && capsule.result !== 'failed') return refuse('CAPSULE_PASSED', 'its reproduction passed on the unchanged base: it is challenge material (REVIEW_GAP_CHALLENGE), never a RED or a proof of DONE');
  return { ok: true, capsule, capsule_sha256: read.capsule_sha256, entry };
}

// ---- what the controller reports ------------------------------------------------------

/** A capsule sealed (or found sealed) for a claim, as `tdd capsule` reports it. */
export interface CapsuleRegistration {
  ok: true;
  capsule_id: string;
  capsule_sha256: string;
  criterion: string;
  result: 'passed' | 'failed';
  /** True when nothing was sealed now: the same reproduction was sealed already (or its registry write was finished). */
  idempotent: boolean;
  carried_from: CapsuleReceipt['carried_from'];
  receipt_path: string;
  artifact_path: string;
  base_sha: string;
  run_output_sha256: string;
  tests: { id: string; path: string; full_name: string; status: string; category: string; declared: CapsuleTest['declared']; block: CapsuleTest['block'] }[];
  files: { path: string; sha256: string; blob: string }[];
  /** What it is good for, and what to do next. */
  detail: string;
}

/** One run of an independent replay of a capsule. */
export interface CapsuleReplayRun {
  sha: string;
  ok: boolean;
  detail: string;
  statuses: Record<string, string>;
}

/** A capsule as `capsule verify` checks it. */
export interface CapsuleVerification {
  capsule_id: string;
  node_id: string;
  cited_by: string[];
  ok: boolean;
  problems: string[];
  /** With --replay, a cited capsule run again on its base (and, promoted to a RED, on the head that integrated its fix). */
  replay: { base: CapsuleReplayRun; head: CapsuleReplayRun | null } | null;
}

/**
 * Every capsule the feature cites — a challenge's receipt names, a promoted RED records — checked as sealed: its receipt
 * hashing as cited, self-consistent, its archive intact. What `feature verify` (and delivery) refuse.
 */
export function citedCapsuleProblems(controlRoot: string, featureId: string, state: { nodes: Record<string, NodeRuntime>; acceptance_review?: { challenges?: { challenge_id: string; node_id: string; receipt_path: string }[] } | null }): string[] {
  const cited: { id: string; sha: string | null; node: string; by: string }[] = [];
  for (const ch of state.acceptance_review?.challenges ?? []) {
    type Cites = { capsules?: { capsule_id: string; capsule_sha256: string }[] };
    let receipt: Cites = {};
    try {
      receipt = JSON.parse(readFileSync(join(controlRoot, ...ch.receipt_path.split('/')), 'utf8')) as Cites;
    } catch {
      receipt = {};
    }
    for (const k of receipt.capsules ?? []) cited.push({ id: k.capsule_id, sha: k.capsule_sha256, node: ch.node_id, by: `challenge ${ch.challenge_id}` });
  }
  for (const [id, rt] of Object.entries(state.nodes)) for (const c of rt.criteria ?? []) if (c.capsule) cited.push({ id: c.capsule.capsule_id, sha: c.capsule.capsule_sha256, node: id, by: `${c.criterion}'s RED` });
  const problems: string[] = [];
  for (const c of cited) {
    const read = readCapsule(controlRoot, `${capsuleDir(featureId, c.node, c.id)}/capsule.json`, c.sha);
    const problem = !read.ok ? `${read.code}: ${read.detail}` : !capsuleSelfConsistent(read.capsule) || read.capsule.capsule_id !== c.id ? `CAPSULE_TAMPERED: its receipt does not bind ${c.id}` : capsuleArchiveProblem(controlRoot, read.capsule);
    if (problem !== null) problems.push(`CAPSULE_INVALID: ${c.node} ${c.id} (cited by ${c.by}): ${problem}`);
  }
  return problems;
}
