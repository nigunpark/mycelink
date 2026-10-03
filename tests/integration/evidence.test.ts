import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { makeGitRepo } from '../helpers/git-fixture.js';
import {
  classifyRedReason,
  failureFingerprint,
  runVerification,
} from '../../src/evidence/runner.js';
import { validateAgainstSchema } from '../../src/schema/registry.js';

afterAll(() => cleanupTmpRoots());

function workspace(files: Record<string, string> = {}): { repo: string; evidence: string } {
  const dir = makeTmpDir('ev-');
  const repo = join(dir, 'repo');
  makeGitRepo(repo, { files: { 'README.md': '# r\n', ...files } });
  const evidence = join(dir, 'evidence');
  mkdirSync(evidence, { recursive: true });
  return { repo, evidence };
}

describe('failureFingerprint', () => {
  it('is stable for the same failure and different for a different one', () => {
    const a = 'AssertionError: expected 1 to equal 2\n    at test.js:14:3\n';
    const b = 'AssertionError: expected 1 to equal 2\n    at test.js:97:9\n';
    const c = 'AssertionError: expected "x" to equal "y"\n    at test.js:14:3\n';
    expect(failureFingerprint(a, 1)).toBe(failureFingerprint(a, 1));
    // Line numbers and timings must not change the identity of a failure.
    expect(failureFingerprint(a, 1)).toBe(failureFingerprint(b, 1));
    expect(failureFingerprint(a, 1)).not.toBe(failureFingerprint(c, 1));
  });

  it('normalises absolute paths, durations and hex ids', () => {
    const a = 'FAIL C:\\work\\a\\tests\\x.test.js (231 ms) id=0x7ffab123\n  expected true\n';
    const b = 'FAIL D:\\other\\b\\tests\\x.test.js (4 ms) id=0x00112233\n  expected true\n';
    expect(failureFingerprint(a, 1)).toBe(failureFingerprint(b, 1));
  });

  it('is null for a successful run', () => {
    expect(failureFingerprint('all good', 0)).toBeNull();
  });
});

describe('classifyRedReason', () => {
  it('classifies an assertion failure as a missing behaviour', () => {
    expect(classifyRedReason('AssertionError: expected publish() to emit', 1)).toBe(
      'behaviour-missing',
    );
    expect(classifyRedReason('1 failing\n  expected 2 to equal 3', 1)).toBe('behaviour-missing');
  });

  it('classifies a missing module or import as a setup error', () => {
    expect(classifyRedReason("Error: Cannot find module './nope'", 1)).toBe('setup-error');
    expect(classifyRedReason('ERR_MODULE_NOT_FOUND', 1)).toBe('setup-error');
    expect(classifyRedReason('npm ERR! missing script: test', 1)).toBe('setup-error');
  });

  it('classifies a parse failure as a syntax error', () => {
    expect(classifyRedReason('SyntaxError: Unexpected token }', 1)).toBe('syntax-error');
    expect(classifyRedReason("TS1005: ';' expected.", 2)).toBe('syntax-error');
  });

  it('classifies an unreachable dependency as an environment error', () => {
    expect(classifyRedReason('Error: connect ECONNREFUSED 127.0.0.1:6379', 1)).toBe(
      'environment-error',
    );
    expect(classifyRedReason('EACCES: permission denied', 1)).toBe('environment-error');
  });
});

describe('runVerification', () => {
  it('records a passing command as evidence with exit 0 and no fingerprint', () => {
    const { repo, evidence } = workspace();
    const record = runVerification({
      kind: 'green',
      nodeId: 'FEAT-1.a.b.impl',
      repository: 'core',
      command: [process.execPath, '-e', 'console.log("ok")'],
      cwd: repo,
      evidenceDir: evidence,
    });

    expect(record.exit_code).toBe(0);
    expect(record.failure_fingerprint).toBeNull();
    expect(record.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(validateAgainstSchema('evidence', record)).toEqual([]);
  });

  it('writes the output to a file and records its hash, never the body', () => {
    const { repo, evidence } = workspace();
    // The command itself must not mention the output string, so that finding
    // it in the record would mean the body really was inlined.
    writeFileSync(join(repo, 'say.js'), 'console.log("hello-evidence");\n');
    const record = runVerification({
      kind: 'green',
      nodeId: 'FEAT-1.a.b.impl',
      repository: 'core',
      command: [process.execPath, 'say.js'],
      cwd: repo,
      evidenceDir: evidence,
    });

    expect(existsSync(record.output_path)).toBe(true);
    const body = readFileSync(record.output_path, 'utf8');
    expect(body).toContain('hello-evidence');
    expect(createHash('sha256').update(readFileSync(record.output_path)).digest('hex')).toBe(
      record.output_sha256,
    );
    expect(JSON.stringify(record)).not.toContain('hello-evidence');
  });

  it('records a failing command with a fingerprint and a RED classification', () => {
    const { repo, evidence } = workspace();
    const record = runVerification({
      kind: 'red',
      nodeId: 'FEAT-1.a.b.red',
      repository: 'core',
      command: [
        process.execPath,
        '-e',
        'console.error("AssertionError: expected publish to emit"); process.exit(1)',
      ],
      cwd: repo,
      evidenceDir: evidence,
    });

    expect(record.exit_code).toBe(1);
    expect(record.failure_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(record.red_reason).toBe('behaviour-missing');
  });

  it('marks a RED that failed to even load the suite as a setup error', () => {
    const { repo, evidence } = workspace();
    const record = runVerification({
      kind: 'red',
      nodeId: 'FEAT-1.a.b.red',
      repository: 'core',
      command: [process.execPath, join(repo, 'does-not-exist.js')],
      cwd: repo,
      evidenceDir: evidence,
    });
    expect(record.exit_code).not.toBe(0);
    expect(record.red_reason).toBe('setup-error');
  });

  it('honours expect_exit so a deliberately failing verifier can pass', () => {
    const { repo, evidence } = workspace();
    const record = runVerification({
      kind: 'red',
      nodeId: 'FEAT-1.a.b.red',
      repository: 'core',
      command: [process.execPath, '-e', 'process.exit(3)'],
      cwd: repo,
      evidenceDir: evidence,
      expectExit: 3,
    });
    expect(record.exit_code).toBe(3);
    expect(record.failure_fingerprint).toBeNull();
  });

  it('times out a hanging verifier instead of blocking the harness', () => {
    const { repo, evidence } = workspace();
    const record = runVerification({
      kind: 'regression',
      nodeId: 'FEAT-1.a.b.impl',
      repository: 'core',
      command: [process.execPath, '-e', 'setTimeout(()=>{}, 60000)'],
      cwd: repo,
      evidenceDir: evidence,
      timeoutMs: 400,
    });
    expect(record.exit_code).not.toBe(0);
    expect(record.failure_fingerprint).not.toBeNull();
    expect(readFileSync(record.output_path, 'utf8')).toMatch(/timed out/i);
  });

  it('excludes known baseline failures from a regression verdict', () => {
    const { repo, evidence } = workspace();
    writeFileSync(
      join(repo, 'suite.js'),
      'console.log("FAIL legacy/flaky.test.js");\nconsole.log("FAIL new/thing.test.js");\nprocess.exit(1);\n',
    );
    const record = runVerification({
      kind: 'regression',
      nodeId: 'FEAT-1.a.b.impl',
      repository: 'core',
      command: [process.execPath, 'suite.js'],
      cwd: repo,
      evidenceDir: evidence,
      baselineFailures: ['legacy/flaky.test.js'],
    });
    expect(record.baseline_excluded).toEqual(['legacy/flaky.test.js']);
    // The genuinely new failure still dominates the fingerprint.
    expect(record.failure_fingerprint).not.toBeNull();
  });

  it('reports a run whose only failures are baseline as a baseline-clean pass', () => {
    const { repo, evidence } = workspace();
    writeFileSync(
      join(repo, 'suite.js'),
      'console.log("FAIL legacy/flaky.test.js");\nprocess.exit(1);\n',
    );
    const record = runVerification({
      kind: 'regression',
      nodeId: 'FEAT-1.a.b.impl',
      repository: 'core',
      command: [process.execPath, 'suite.js'],
      cwd: repo,
      evidenceDir: evidence,
      baselineFailures: ['legacy/flaky.test.js'],
    });
    expect(record.baseline_excluded).toEqual(['legacy/flaky.test.js']);
    expect(record.failure_fingerprint).toBeNull();
  });
});
