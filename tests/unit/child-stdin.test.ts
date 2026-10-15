/**
 * A child process that reads its standard input gets it as a finished file
 * (CI 38635817750, macOS, Node 22.12.0).
 *
 * integration-2 and fixtures-1 ran to the job's 60 minutes and were
 * cancelled, each with one test file never reported (review-lifecycle,
 * cset203-r4-e2e) and an orphan `git` left beside a node process. No test's
 * 300 s timeout fired: the Vitest worker itself was blocked in a synchronous
 * child. The only children Mycelink runs with nothing to bound them are the
 * git commands it feeds through spawnSync's `input` — `hash-object
 * --stdin-paths` and `cat-file --batch` (a red gate's binding and declared
 * tests, run in the worker by the in-process CLI or in a gate's CLI child)
 * and `hash-object --stdin` (a reproduction capsule's blobs). `input` is a
 * stream the parent writes and must end while the child runs; on macOS it is
 * a socketpair, and a child there can wait for an end that never comes. A
 * file has its end. And every such child is bounded: one that still does not
 * end is killed, and what it was is said.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fstatSync, readdirSync, readSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import { DEFAULT_TDD_POLICY, redBinding, redDeclaredTests } from '../../src/engine/tdd-history.js';
import { collectCapsuleFiles } from '../../src/engine/reproduction-capsule.js';
import { runCommandSync } from '../../src/security/exec.js';
// @ts-expect-error -- plain ESM module without type declarations
import { safeGit } from '../../evals-public-projects/lib/git.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { run as quickstartRun } from '../../examples/quickstart/lib/quickstart.mjs';

afterAll(() => cleanupTmpRoots());

const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');

interface Seen {
  argv: string[];
  streamed: boolean;
  stdin: null | { file: boolean; text: string };
  timeout: number | null;
}

/** Every child started meanwhile, as it was started: its stdin a stream, a file (and what it holds), or neither; its bound. */
let seen: Seen[] = [];
let original: typeof cp.spawnSync;
/** This file's own temporary directory (os.tmpdir() while a test runs): what a child's input leaves is this file's alone. */
let ownTmp = '';
const TMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;
let savedTmp: Record<string, string | undefined> = {};
beforeEach(() => {
  ownTmp = makeTmpDir('child-stdin-tmp-');
  savedTmp = Object.fromEntries(TMP_VARS.map((k) => [k, process.env[k]]));
  for (const k of TMP_VARS) process.env[k] = ownTmp;
  seen = [];
  original = cp.spawnSync;
  (cp as { spawnSync: unknown }).spawnSync = function (file: string, args?: readonly string[], options?: Record<string, any>) {
    const fd = options?.['stdio']?.[0];
    let stdin: Seen['stdin'] = null;
    if (typeof fd === 'number') {
      const st = fstatSync(fd);
      const buf = Buffer.alloc(st.size);
      // At its offset, never moving it: what the child will read from its start.
      readSync(fd, buf, 0, st.size, 0);
      stdin = { file: st.isFile(), text: buf.toString('utf8') };
    }
    seen.push({ argv: [file, ...(args ?? [])], streamed: options?.['input'] !== undefined, stdin, timeout: options?.['timeout'] ?? null });
    return original.call(cp, file, args as string[], options as never);
  };
  syncBuiltinESMExports();
});
afterEach(() => {
  (cp as { spawnSync: unknown }).spawnSync = original;
  syncBuiltinESMExports();
  for (const k of TMP_VARS) {
    if (savedTmp[k] === undefined) delete process.env[k];
    else process.env[k] = savedTmp[k];
  }
});

/** The children whose argv has `sub` (`hash-object`, `cat-file`) right after git and its options. */
const gitChildren = (sub: string) => seen.filter((s) => s.argv[0] === 'git' && s.argv.includes(sub));

function expectFileStdin(children: Seen[], text: string): void {
  expect(children.length).toBeGreaterThan(0);
  for (const c of children) {
    expect(c.streamed, `${c.argv.join(' ')}: its input was a stream`).toBe(false);
    expect(c.stdin, `${c.argv.join(' ')}: no stdin file`).toEqual({ file: true, text });
    expect(c.timeout, `${c.argv.join(' ')}: unbounded`).toBeGreaterThan(0);
  }
}

const scratchLeft = () => readdirSync(ownTmp).filter((n) => n.startsWith('mycelink-stdin-'));

describe("git's stdin, as a finished file", () => {
  it('a red binding hashes the test files git hash-object --stdin-paths reads from a file holding exactly their paths', () => {
    const repo = makeGitRepo(makeTmpDir('child-stdin-red-'), { files: { 'src/a.js': 'export const a = 1;\n', 'test/a.test.js': "test('a', () => {});\n" } });
    writeFiles(repo, { 'test/a.test.js': "test('a', () => { expect(1).toBe(1); });\n", 'test/b.test.js': "test('b', () => {});\n" });
    const { binding } = redBinding(repo, DEFAULT_TDD_POLICY, null);
    expectFileStdin(gitChildren('hash-object'), 'test/a.test.js\ntest/b.test.js\n');
    // The same blobs git add would write.
    expect(binding.tests).toEqual([
      { path: 'test/a.test.js', blob: git(repo, ['hash-object', 'test/a.test.js']) },
      { path: 'test/b.test.js', blob: git(repo, ['hash-object', 'test/b.test.js']) },
    ]);
    expect(scratchLeft()).toEqual([]);
  });

  it("a RED's declared tests read their earlier contents through git cat-file --batch from a file holding exactly the blob ids", () => {
    const repo = makeGitRepo(makeTmpDir('child-stdin-decl-'), { files: { 'src/a.js': 'export const a = 1;\n', 'test/a.test.js': "test('first', () => {});\n" } });
    const blob = git(repo, ['rev-parse', 'HEAD:test/a.test.js']);
    writeFiles(repo, { 'test/a.test.js': "test('first', () => {});\ntest('second', () => {});\n" });
    commitAll(repo, 'test: second');
    const start = git(repo, ['rev-parse', 'HEAD~1']);
    const r = redDeclaredTests(repo, DEFAULT_TDD_POLICY, start, { since: 'base' });
    expectFileStdin(gitChildren('cat-file'), `${blob}\n`);
    expect(r.declared.map((t) => t.name)).toEqual(['second']);
  });

  it("a capsule's blob is git hash-object --stdin over a file holding exactly the bytes read", () => {
    const repo = makeGitRepo(makeTmpDir('child-stdin-capsule-'), { files: { 'src/a.js': 'export const a = 1;\n' } });
    const body = `test('gap', () => { expect(${'1 + '.repeat(4000)}1).toBe(4001); });\n`;
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test', 'gap.test.js'), body);
    const got = collectCapsuleFiles({ worktree: repo, policy: DEFAULT_TDD_POLICY, allowed: ['**'], forbidden: [], modulePath: null, paths: null });
    expect(got.ok, JSON.stringify(got)).toBe(true);
    if (!got.ok) return;
    expectFileStdin(gitChildren('hash-object'), body);
    expect(got.files[0]?.blob).toBe(git(repo, ['hash-object', 'test/gap.test.js']));
  });
});

describe('a command run with input', () => {
  const echo = "const fs = require('fs'); process.stdout.write(JSON.stringify({ file: fs.fstatSync(0).isFile(), text: fs.readFileSync(0, 'utf8') }));";

  it('reads it from a file with its end, whatever its size', () => {
    const input = `${'x'.repeat(256 * 1024)}\nend\n`;
    const r = runCommandSync([process.execPath, '-e', echo], { cwd: tmpdir(), input, timeoutMs: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ file: true, text: input });
    expect(scratchLeft()).toEqual([]);
  });

  it('that never ends is killed at its bound, its input removed', () => {
    const t0 = Date.now();
    const r = runCommandSync([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), input: 'y'.repeat(20_000), timeoutMs: 1500 });
    expect(r).toMatchObject({ timedOut: true, exitCode: 124 });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(scratchLeft()).toEqual([]);
  });

  // CI 38635817750 (Windows): a scanner or a handle still closing makes an unlink fail for a moment. The child has ended
  // and its result stands; removing its input is tried again, and never turns that result into a failure.
  it("whose input's removal Windows refuses for a moment still gives the child's result, and its input is removed", () => {
    const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const rm = fs.rmSync;
    let refused = 0;
    (fs as { rmSync: unknown }).rmSync = function (p: string, ...rest: unknown[]) {
      if (refused < 2 && String(p).includes('mycelink-stdin-')) {
        refused += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${p}'`), { code: 'EPERM', syscall: 'unlink', path: p });
      }
      return (rm as (...a: unknown[]) => void)(p, ...rest);
    };
    syncBuiltinESMExports();
    try {
        const r = runCommandSync([process.execPath, '-e', echo], { cwd: tmpdir(), input: 'z\n', timeoutMs: 60_000 });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ file: true, text: 'z\n' });
      expect(refused).toBe(2);
      expect(scratchLeft()).toEqual([]);
    } finally {
      (fs as { rmSync: unknown }).rmSync = rm;
      syncBuiltinESMExports();
    }
  });
});

describe("the benchmark harness's git", () => {
  it('reads what it is given from a file holding exactly it: git check-ignore --stdin, as a controller check runs it', () => {
    const repo = makeGitRepo(makeTmpDir('child-stdin-harness-'), { files: { '.gitignore': 'dist/\n', 'src/a.js': 'export {};\n' } });
    const input = 'dist/x.js\0src/a.js\0';
    const r = safeGit(repo, ['check-ignore', '--no-index', '-z', '--stdin'], { input });
    expectFileStdin(gitChildren('check-ignore'), input);
    expect(r.code).toBe(0);
    expect(String(r.stdout).split('\0').filter(Boolean)).toEqual(['dist/x.js']);
  });
});

describe("the quickstart's commands", () => {
  // Found by the same fault injection: the walkthrough hands the fence its reviewer's write through run()'s input.
  it('read what they are given from a file holding exactly it', () => {
    const echo = "const fs = require('fs'); process.stdout.write(JSON.stringify({ file: fs.fstatSync(0).isFile(), text: fs.readFileSync(0, 'utf8') }));";
    const r = quickstartRun([process.execPath, '-e', echo], { cwd: ownTmp, env: { ...process.env }, input: '{"hook_event_name":"PreToolUse"}\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ file: true, text: '{"hook_event_name":"PreToolUse"}\n' });
    expect(readdirSync(ownTmp).filter((n) => n.startsWith('mycelink-quickstart-stdin-'))).toEqual([]);
  });
});
