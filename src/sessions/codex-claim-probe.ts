/** Functional isolation for approved host commands; this is not hostile-process confinement. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runGit } from '../git/git.js';
import { matchGlob } from '../git/worktree.js';
import { classifyRelativePath, samePath } from '../security/paths.js';
import { redactText } from '../security/redact.js';
import { isTestPath } from '../engine/tdd-history.js';
import { runWorktreeSetup, setupEnvironment, setupInputs, type WorktreeSetupConfig } from '../engine/worktree-setup.js';
import { moduleInvocation, runVerification } from '../evidence/runner.js';
import { writeImmutable } from '../evidence/store.js';
import type { RawReportSnapshot } from '../evidence/runner.js';
import { canonicalTestId } from '../evidence/test-ids.js';
import type { ClaimVerification } from '../model/types.js';
import { boundChannelResponse, validProbeDiagnostic, type LiveClaim, type ProbeResult } from './codex-claim-channel.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function safeFile(root: string, path: string): Buffer | null {
  // Paths come from NUL-delimited Git enumeration/snapshots; brackets are literal filename characters.
  if (classifyRelativePath(path) || path.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\x7f\\*?{}]/.test(path)) throw new Error('CHANNEL_PROBE_PATH_INVALID');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('CHANNEL_PROBE_SYMLINK');
    // lstat also detects dangling links.
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('CHANNEL_PROBE_SYMLINK'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  if (!existsSync(current)) return null;
  if (!lstatSync(current).isFile()) throw new Error('CHANNEL_PROBE_PATH_INVALID');
  return readFileSync(current);
}
interface ProbeSnapshot {
  head: string; refs: string; headFile: string; index: string; indexFile: string; status: string; trackedDiff: string;
  tracked: string[]; files: Record<string, string | null>;
}
function snapshot(root: string, deadline: number): string {
  // Read-only Git commands must not refresh the index during observation.
  const git = (args: string[]) => runGit(root, args, { timeoutMs: Math.max(1, deadline - Date.now()), env: { GIT_OPTIONAL_LOCKS: '0' } }).stdout;
  const tracked = git(['ls-files', '-z', '--cached']).split('\0').filter(Boolean);
  // Ignored dependency trees belong to declared setup in the disposable clone.
  // Keep tracked files (even if ignored) and every non-ignored untracked path fenced.
  const paths = [...new Set([...tracked, ...git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)])].sort();
  if (paths.length > 100_000) throw new Error('CHANNEL_PROBE_SNAPSHOT_LIMIT');
  const gitPathHash = (name: string) => {
    const path = resolve(root, git(['rev-parse', '--git-path', name]).trim());
    return existsSync(path) ? hash(readFileSync(path)) : '';
  };
  return JSON.stringify({ head: git(['rev-parse', 'HEAD']), refs: git(['show-ref']), headFile: gitPathHash('HEAD'),
    index: git(['ls-files', '--stage', '-v', '-z']), indexFile: gitPathHash('index'),
    trackedDiff: git(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', 'HEAD']),
    status: git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), tracked,
    files: Object.fromEntries(paths.map(p => [p, (() => { const bytes = safeFile(root, p); return bytes === null ? null : hash(bytes); })()])) } satisfies ProbeSnapshot);
}

function cloneDelta(before: string, after: string, scope: LiveClaim, nodePath: string) {
  const a = JSON.parse(before) as ProbeSnapshot;
  const b = JSON.parse(after) as ProbeSnapshot;
  const tracked = new Set([...a.tracked, ...b.tracked]);
  const paths = [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort();
  const changes = paths.filter(p => a.files[p] !== b.files[p]).map(path => {
    const local = nodePath === '.' ? path : path.startsWith(nodePath + '/') ? path.slice(nodePath.length + 1) : '';
    // snapshot reads every tracked/non-ignored file through safeFile, rejecting symlinks and non-regular files.
    // Vitest also writes data in its clone-root cache, outside the module directory.
    // Test source is immutable even when it was overlaid as an untracked worker edit.
    const disposable = !tracked.has(path) && !/(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/i.test(path) &&
      (path.startsWith('node_modules/.vitest-cache/') || (!!local &&
        /^(?:test(?:s)?\/(?:fixtures|\.tmp|tmp|cache|reports)|\.cache|\.vite|coverage|test-results|reports)\//.test(local))) &&
      !/\.(?:[cm]?[jt]sx?)$/i.test(path.split('/').at(-1) ?? '') &&
      !scope.forbiddenPaths.some(g => matchGlob(g, path));
    return { path, before: a.files[path] ?? null, after: b.files[path] ?? null, disposable };
  });
  const metadata = (['head', 'refs', 'headFile', 'index', 'indexFile', 'status', 'trackedDiff'] as const).map(path => ({
    path, before: ['head', 'headFile', 'indexFile'].includes(path) ? a[path].trim() : hash(Buffer.from(a[path])),
    after: ['head', 'headFile', 'indexFile'].includes(path) ? b[path].trim() : hash(Buffer.from(b[path])),
  })).filter(p => p.before !== p.after);
  // Raw index stat-cache refreshes are harmless; staged entries (mode/blob/stage/path) must match.
  const disposableDelta = changes.length > 0 && changes.every(p => p.disposable);
  const refused = metadata.some(p => p.path === 'status' ? !disposableDelta : p.path !== 'indexFile') || changes.some(p => !p.disposable);
  return { refused, diagnostic: 'CLONE_DELTA=' + JSON.stringify({ metadata, count: changes.length, paths: changes.slice(0, 32).map(p => ({ ...p, path: p.path.slice(0, 256) })), truncated: changes.length > 32 || changes.some(p => p.path.length > 256) }) };
}

/** Render literals only; no dynamic substring may survive, even ordinary prose. */
function testCommandExcerpt(output: string | null): string | undefined {
  const vocabulary = new Set([
    'Error [ERR_MODULE_NOT_FOUND]: <redacted>',
    'TypeError: <redacted>',
    'at node:internal/<redacted>',
    'UNKNOWN',
  ]);
  const lines: string[] = [];
  for (const raw of (output ?? '').split(/\r\n|[\r\n]/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    if (lines.length === 0) {
      // Suppress the entire suffix, including paths, quoted values, emails,
      // token/key-shaped words and unquoted multiword values, with one literal.
      if (/^Error \[ERR_MODULE_NOT_FOUND\]: .*$/.test(line)) lines.push('Error [ERR_MODULE_NOT_FOUND]: <redacted>');
      else if (/^TypeError: .*$/.test(line)) lines.push('TypeError: <redacted>');
    } else if (/^    at node:internal\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[cm]?js)?:[0-9]+:[0-9]+$/.test(line)) {
      lines.push('at node:internal/<redacted>');
    }
    if (lines.length === 6) break;
  }
  if (lines.length === 0) return undefined;
  const excerpt = lines.join('\n');
  const redacted = redactText(excerpt);
  if (redacted !== excerpt || Buffer.byteLength(redacted) > 1024 ||
      redacted.split('\n').length > 6 || !redacted.split('\n').every(line => vocabulary.has(line))) return undefined;
  return redacted;
}

/** Only hashes of redacted text and a fixed vocabulary may survive the clone. */
function testCommandSummary(output: string | null) {
  const text = redactText(output ?? '');
  // Match anchored error prefixes or strict allowlisted standalone code fields only.
  const prefixes = [
    ['MODULE_NOT_FOUND', /^Error: Cannot find module(?:\s|$)/],
    ['ERR_MODULE_NOT_FOUND', /^Error: Cannot find package(?:\s|$)/],
    ['ERR_MODULE_NOT_FOUND', /^Error \[ERR_MODULE_NOT_FOUND\]:/],
    ['ENOENT', /^Error: ENOENT:/],
    ['EACCES', /^Error: EACCES:/],
    ['EPERM', /^Error: EPERM:/],
    ['ERR_DLOPEN_FAILED', /^Error \[ERR_DLOPEN_FAILED\]:/],
    ['NATIVE_BINDING', /^Error: Could not locate the bindings file\. Tried:/],
    ['SYNTAX_ERROR', /^SyntaxError:/],
    ['NO_TEST_FILES', /^No test files found, exiting with code 1(?:\s|$)/],
  ] as const;
  const lines = text.split(/\r?\n/);
  const nonempty = lines.filter(line => line.trim() !== '');
  // Strip boundary SGR sequences in memory only; fingerprints retain the redacted bytes.
  const classified = nonempty.map(line => line.replace(/^(?:\x1b\[[0-9;]*m)+|(?:\x1b\[[0-9;]*m)+$/g, ''));
  const standalone = /^[ \t]*code: '(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|ERR_DLOPEN_FAILED)',?[ \t]*$/;
  const code = prefixes.find(([, pattern]) => classified.some(line => pattern.test(line)))?.[0] ??
    classified.map(line => standalone.exec(line)?.[1]).find(value => value !== undefined) ??
    (/^Node\.js v[0-9]+\.[0-9]+\.[0-9]+$/.test(classified.at(-1) ?? '') ? 'NODE_FATAL_UNKNOWN' : 'UNKNOWN');
  const last = Buffer.from(nonempty.at(-1) ?? '').subarray(-1024);
  const sanitizedExcerpt = testCommandExcerpt(output);
  return { code, last_error: { sha256: hash(last), bytes: last.length },
    ...(sanitizedExcerpt !== undefined ? { sanitized_excerpt: sanitizedExcerpt } : {}),
    lines: nonempty.slice(-12).map(line => {
      const bytes = Buffer.from(line);
      return { sha256: hash(bytes), bytes: bytes.length };
    }) };
}

function rawSummary(snapshot: RawReportSnapshot) {
  if (!snapshot || (snapshot.bytes !== null && (!Buffer.isBuffer(snapshot.bytes) || snapshot.bytes.length > 64 * 1024 * 1024)) ||
      (snapshot.bytes === null ? snapshot.sha256 !== null : hash(snapshot.bytes) !== snapshot.sha256) ||
      typeof snapshot.output !== 'string' || !Number.isSafeInteger(snapshot.exit_code) ||
      (snapshot.test_command_output !== null && (typeof snapshot.test_command_output !== 'string' ||
        Buffer.byteLength(snapshot.test_command_output) > 65536)) ||
      !Number.isSafeInteger(snapshot.normalized_count) || snapshot.normalized_count < 0 ||
      !Array.isArray(snapshot.steps) ||
      snapshot.steps.some(s => !Number.isSafeInteger(s.exit_code) || typeof s.timed_out !== 'boolean')) throw new Error('CHANNEL_PROBE_REPORT_INVALID:RAW');
  const fingerprint = (text: string) => {
    const bytes = Buffer.from(redactText(text));
    return { sha256: hash(bytes), bytes: bytes.length };
  };
  let doc: Record<string, unknown> | null = null;
  if (snapshot.bytes !== null) {
    try {
      const value: unknown = JSON.parse(snapshot.bytes.toString('utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).testResults)) doc = value as Record<string, unknown>;
    } catch { /* Malformed bytes contribute no report metadata. */ }
  }
  const count = (key: string) => typeof doc?.[key] === 'number' && Number.isSafeInteger(doc[key]) && (doc[key] as number) >= 0 ? doc[key] as number : 0;
  const errors: { type?: 'SyntaxError'; code?: 'ERR_MODULE_NOT_FOUND' | 'NO_TEST_FILES' }[] = [];
  const messages: { sha256: string; bytes: number }[] = [];
  if (Array.isArray(doc?.errors)) for (const value of doc.errors.slice(0, 16)) {
    if (!value || typeof value !== 'object') continue;
    const error = value as Record<string, unknown>;
    const allowed: typeof errors[number] = {};
    if (error.type === 'SyntaxError') allowed.type = 'SyntaxError';
    if (error.code === 'ERR_MODULE_NOT_FOUND') allowed.code = 'ERR_MODULE_NOT_FOUND';
    if (Object.keys(allowed).length) errors.push(allowed);
    if (typeof error.message === 'string' && error.message.startsWith('No test files found ') &&
        !errors.some(error => error.code === 'NO_TEST_FILES')) errors.push({ code: 'NO_TEST_FILES' });
    if (typeof error.message === 'string') messages.push(fingerprint(error.message));
  }
  if (doc?.error && typeof doc.error === 'object' && !Array.isArray(doc.error)) {
    const error = doc.error as Record<string, unknown>;
    if (typeof error.message === 'string' && error.message.startsWith('No test files found ') &&
        !errors.some(error => error.code === 'NO_TEST_FILES')) errors.push({ code: 'NO_TEST_FILES' });
  }
  return { runner: { exit_code: snapshot.exit_code, step_exit_codes: snapshot.steps.map(s => s.exit_code), normalized_count: snapshot.normalized_count },
    raw: { status: snapshot.bytes === null ? 'missing' : doc === null ? 'malformed' : 'valid',
      suite_count: count('numTotalTestSuites'), test_count: count('numTotalTests'), failed_suite_count: count('numFailedTestSuites'),
      ...(doc !== null && snapshot.bytes !== null ? { report: fingerprint(snapshot.bytes.toString('utf8')) } : {}),
      output: fingerprint(snapshot.output), messages }, errors,
    ...(snapshot.bytes === null && snapshot.exit_code === 1 && snapshot.normalized_count === 0
      ? { test_command: testCommandSummary(snapshot.test_command_output) } : {}) };
}

export function runClaimProbe(args: { scope: LiveClaim; bound: ClaimVerification; setup: WorktreeSetupConfig | null;
  controlRoot: string; deadline: number; current: () => boolean; fixture: () => string | void }): ProbeResult {
  const fail = (output: string): ProbeResult => ({ exitCode: 2, output: boundChannelResponse({
    ok: true, sequence: Number.MAX_SAFE_INTEGER, exitCode: 2, output: redactText(output),
  }).output ?? '' });
  let root: string | undefined;
  let original: string | undefined;
  let executed = false;
  let fixtureChecked = false;
  const remaining = () => { const ms = args.deadline - Date.now(); if (ms <= 0) throw new Error('CHANNEL_PROBE_TIMEOUT'); return ms; };
  try {
    const { scope } = args;
    const git = (argv: string[]) => runGit(scope.worktree, argv, { timeoutMs: remaining() }).stdout;
    args.fixture();
    if (!args.current()) throw new Error('CHANNEL_CLAIM_STALE');
    const changed = new Set<string>();
    // Use NUL-delimited paths, including both sides of renames (no rename detection).
    for (const p of (git(['diff', '--no-renames', '--name-only', '-z', 'HEAD']) + git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) changed.add(p);
    const files = [...changed].map(path => {
      if (!scope.tddPolicy || !isTestPath(scope.tddPolicy, path) || !scope.allowedPaths.some(g => matchGlob(g, path)) || scope.forbiddenPaths.some(g => matchGlob(g, path)) ||
          !(args.bound.path === '.' || path.startsWith(args.bound.path + '/'))) throw new Error('CHANNEL_PROBE_FENCE');
      return { path, bytes: safeFile(scope.worktree, path) };
    });
    const before = snapshot(scope.worktree, args.deadline + 2_000);
    original = before;
    for (const f of files) {
      const now = safeFile(scope.worktree, f.path);
      if (now === null ? f.bytes !== null : f.bytes === null || !now.equals(f.bytes)) throw new Error('CHANNEL_CLAIM_STALE');
    }
    const base = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? (() => { throw new Error('CHANNEL_PROBE_SCRATCH_UNAVAILABLE'); })(), 'hermes', 'cache', 'scratch') : tmpdir();
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, 'mp-'));
    const clone = join(root, 'c');
    if (process.platform === 'win32' && clone.length > 180) throw new Error('CHANNEL_PROBE_PATH_TOO_LONG');
    runGit(scope.repoPath, ['clone', '--no-local', '--no-checkout', '--', scope.repoPath, clone], { timeoutMs: remaining() });
    runGit(clone, ['config', 'core.autocrlf', 'false'], { timeoutMs: remaining() });
    runGit(clone, ['checkout', '--detach', scope.expectedHead], { timeoutMs: remaining() });
    const common = (dir: string) => realpathSync(resolve(dir, runGit(dir, ['rev-parse', '--git-common-dir'], { timeoutMs: remaining() }).stdout.trim()));
    if (!lstatSync(join(clone, '.git')).isDirectory() || samePath(common(clone), common(scope.worktree))) throw new Error('CHANNEL_PROBE_CLONE_INVALID');
    const evidence = join(root, 'diagnostic');
    if (args.setup) {
      executed = true;
      if (setupInputs(scope.worktree, args.setup)?.sha256 !== setupInputs(clone, args.setup)?.sha256) throw new Error('CHANNEL_PROBE_SETUP_INPUT_DRIFT');
      const setup = runWorktreeSetup({ controlRoot: root, repository: 'probe', repoPath: clone, worktree: clone, root,
        config: args.setup, deadline: args.deadline, evidenceDir: evidence, label: 'setup' });
      if (setup.receipt.status !== 'complete') throw new Error(`CHANNEL_PROBE_SETUP_FAILED: ${setup.receipt.code}: ${setup.receipt.detail}`);
    }
    for (const f of files) {
      safeFile(clone, f.path);
      const dest = join(clone, f.path);
      if (f.bytes === null) rmSync(dest, { force: true });
      else { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, f.bytes); }
    }
    const cloneBefore = snapshot(clone, args.deadline + 2_000);
    const config = args.setup ?? { commands: [], timeout_seconds: 1, env: {}, required_paths: [] };
    const env = setupEnvironment({ config, worktree: clone, tmp: root });
    // Only controller-verified fixture data may enter the scrubbed child environment.
    const fixturePath = args.fixture();
    if (fixturePath) env.MYCELINK_AC5_FIXTURE = fixturePath;
    executed = true;
    let summary: ReturnType<typeof rawSummary> | undefined;
    const record = runVerification({ kind: 'red', nodeId: scope.nodeId, repository: null, ...moduleInvocation(args.bound),
      timeoutMs: Math.min(args.bound.plan.timeout_seconds * 1000, remaining()), cwd: clone, evidenceDir: evidence, label: 'probe', env, cleanEnv: true, reportScratchRoot: root,
      onRawReport: value => { if (summary) throw new Error('CHANNEL_PROBE_REPORT_INVALID:RAW'); summary = rawSummary(value); } });
    let output = redactText(readFileSync(record.output_path, 'utf8')).slice(0, 32 * 1024);
    fixtureChecked = true;
    args.fixture();
    if (!args.current() || snapshot(scope.worktree, args.deadline + 2_000) !== before) throw new Error('CHANNEL_CLAIM_STALE');
    const delta = cloneDelta(cloneBefore, snapshot(clone, args.deadline + 2_000), scope, args.bound.path);
    if (delta.refused) return fail('CHANNEL_PROBE_CLONE_MUTATED\n' + delta.diagnostic + '\n' + output);
    output = (delta.diagnostic + '\n' + output).slice(0, 32 * 1024);
    if (Date.now() >= args.deadline || record.exit_code === 124) return fail('CHANNEL_PROBE_TIMEOUT');
    if (!record.results || record.steps?.some(s => s.exit_code !== 0 || s.timed_out)) return fail('CHANNEL_PROBE_REPORT_UNAVAILABLE');
    const bytes = readFileSync(record.results.path);
    if (hash(bytes) !== record.results.sha256) return fail('CHANNEL_PROBE_REPORT_INVALID:HASH');
    let doc;
    try { doc = JSON.parse(bytes.toString('utf8')); }
    catch { return fail('CHANNEL_PROBE_REPORT_INVALID:FORMAT'); }
    if (doc === null || typeof doc !== 'object' || doc.schema !== 'mycelink-test-results/1' ||
        doc.format !== record.results.format || !Array.isArray(doc.results)) return fail('CHANNEL_PROBE_REPORT_INVALID:FORMAT');
    if (doc.results.some((t: unknown) => !t || typeof t !== 'object' ||
      typeof (t as Record<string, unknown>).file !== 'string' || typeof (t as Record<string, unknown>).full_name !== 'string' ||
      Buffer.byteLength((t as { file: string }).file) > 1024 || Buffer.byteLength((t as { full_name: string }).full_name) > 4096)) return fail('CHANNEL_PROBE_REPORT_INVALID:ENTRY');
    const tests = (doc.results ?? []).map((t: { test_id: string; file: string; full_name: string; status: string }) => ({ id: t.test_id, path: t.file, full_name: t.full_name, status: t.status }));
    if (!tests.length) {
      if (!summary) return fail('CHANNEL_PROBE_REPORT_INVALID:RAW');
      // Preserve the existing refusal when normalized identities were altered after the run.
      if (summary.runner.normalized_count !== 0) return fail('CHANNEL_PROBE_REPORT_INVALID:IDENTITY:EMPTY');
      const segments = [scope.featureId, scope.nodeId, scope.claimId];
      // An adapter claim may precede dispatch; preserve that absence explicitly in the private summary.
      if (segments.some(s => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(s) || classifyRelativePath(s)) ||
          !/^[a-f0-9]{64}$/.test(args.bound.plan_sha256) || !Number.isSafeInteger(scope.generation) ||
          (scope.dispatchId !== undefined && (typeof scope.dispatchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(scope.dispatchId)))) return fail('CHANNEL_PROBE_REPORT_INVALID:RAW');
      const body = JSON.stringify({ schema: 'mycelink-probe-diagnostic/1', stage: 'IDENTITY:EMPTY',
        claim: { id: scope.claimId, generation: scope.generation, dispatch_id: scope.dispatchId ?? null },
        plan_sha256: args.bound.plan_sha256, timestamp: new Date().toISOString(), ...summary }) + '\n';
      if (Buffer.byteLength(body) > 8192) return fail('CHANNEL_PROBE_REPORT_INVALID:RAW');
      // Refuse links at every private directory component, including existing parents.
      let dir = resolve(args.controlRoot);
      for (const part of ['.mycelink', 'probe-diagnostics', ...segments]) {
        dir = join(dir, part);
        try { const st = lstatSync(dir); if (st.isSymbolicLink() || !st.isDirectory()) return fail('CHANNEL_PROBE_REPORT_INVALID:RAW'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return fail('CHANNEL_PROBE_REPORT_INVALID:RAW'); }
      }
      remaining();
      args.fixture();
      if (!args.current() || snapshot(scope.worktree, args.deadline + 2_000) !== before) throw new Error('CHANNEL_CLAIM_STALE');
      if (!args.current()) throw new Error('CHANNEL_CLAIM_STALE');
      let kept;
      try { kept = writeImmutable(dir, 'diagnostic', '.json', body); }
      catch { return fail('CHANNEL_PROBE_REPORT_INVALID:RAW'); }
      let current = false;
      try { current = args.current(); }
      finally { if (!current && kept.created) rmSync(kept.file, { force: true }); }
      if (!current) throw new Error('CHANNEL_CLAIM_STALE');
      return fail('CHANNEL_PROBE_REPORT_INVALID:IDENTITY:EMPTY DIAGNOSTIC_ID=' + kept.sha256);
    }
    if (tests.length > 10_000) return fail('CHANNEL_PROBE_REPORT_INVALID:IDENTITY:COUNT');
    if (tests.some((t: { path: string }) => classifyRelativePath(t.path) || t.path.split('/').includes('..'))) return fail('CHANNEL_PROBE_REPORT_INVALID:IDENTITY:PATH');
    if (tests.some((t: { id: string; path: string; full_name: string }) => t.id !== canonicalTestId(record.results!.format, t.path, t.full_name))) return fail('CHANNEL_PROBE_REPORT_INVALID:IDENTITY:ID');
    if (tests.some((t: { status: string }) => !['passed', 'failed', 'skipped', 'not-run'].includes(t.status))) return fail('CHANNEL_PROBE_REPORT_INVALID:IDENTITY:STATUS');
    const diagnostic: NonNullable<ProbeResult['diagnostic']> = { role: 'diagnostic-only', tests: tests.slice(0, 256) };
    if (!validProbeDiagnostic(diagnostic)) return fail('CHANNEL_PROBE_REPORT_INVALID:SIZE');
    const bounded = boundChannelResponse({ ok: true, sequence: Number.MAX_SAFE_INTEGER, exitCode: record.exit_code, output, diagnostic });
    return { exitCode: bounded.exitCode ?? 2, output: bounded.output ?? '',
      ...('diagnostic' in bounded && bounded.diagnostic ? { diagnostic: bounded.diagnostic } : {}) };
  } catch (e) { return fail(Date.now() >= args.deadline ? 'CHANNEL_PROBE_TIMEOUT' : (e as Error).message); }
  finally {
    let refusal: string | undefined;
    try {
      if (executed && !fixtureChecked) args.fixture();
      if (original !== undefined && (!args.current() || snapshot(args.scope.worktree, args.deadline + 2_000) !== original)) refusal = 'CHANNEL_CLAIM_STALE';
    } catch (e) { refusal = Date.now() >= args.deadline ? 'CHANNEL_PROBE_TIMEOUT' : (e as Error).message; }
    try { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch { refusal = 'CHANNEL_PROBE_CLEANUP_FAILED'; }
    if (refusal) return fail(refusal);
  }
}
