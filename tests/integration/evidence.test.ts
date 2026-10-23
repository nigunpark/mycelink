import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
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
import { readGateTests } from '../../src/evidence/gate-tests.js';

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

  it('names the same failure alike in any directory, POSIX ones without an extension included (a fresh worktree per attempt)', () => {
    // A verifier that exits non-zero printing nothing: its log is the command and where it ran.
    const at = (dir: string) => `$ node -e process.exit(3)\n(cwd: ${dir})\n\n`;
    expect(failureFingerprint(at('/tmp/mycelink-tests/ver-AbC123/control/.mycelink/worktrees/repo__node'), 3)).toBe(failureFingerprint(at('/tmp/mycelink-tests/ver-XyZ789/control/.mycelink/worktrees/repo__node'), 3));
    expect(failureFingerprint(at('/private/var/folders/x/T/run-1'), 3)).toBe(failureFingerprint(at('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\run-2'), 3));
    expect(failureFingerprint(at('/tmp/a'), 3)).not.toBe(failureFingerprint('$ node -e process.exit(4)\n(cwd: /tmp/a)\n\n', 3));
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

  it('never calls a test that used a symbol that does not exist yet a missing behaviour (CSET-202 r1)', () => {
    const r1 = ' FAIL  packages/errors/src/index.test.ts > ChangesetValidationError > sorts issues\nTypeError: ChangesetValidationError is not a constructor\n Test Files  1 failed | 38 passed (39)\n';
    expect(classifyRedReason(r1, 1)).toBe('setup-error');
    expect(classifyRedReason("SyntaxError: The requested module '@changesets/errors' does not provide an export named 'ChangesetValidationError'", 1)).toBe('syntax-error');
    // A nonzero exit with nothing that shows a failing assertion proves nothing either.
    expect(classifyRedReason(' FAIL  some.test.ts\n', 1)).toBe('setup-error');
  });
});

describe('runVerification', () => {
  it('records real Node JUnit identities from an explicitly declared reporter command without a module', () => {
    const { repo, evidence } = workspace({ 'tests/run.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('publishing emits JOB_RESULT_V2', () => assert.equal(1, 2));\n" });
    const record = runVerification({ kind: 'red', nodeId: 'N', repository: 'core',
      command: ['node', '--test-reporter=junit', '--test-reporter-destination=${REPORT}', 'tests/run.mjs'],
      cwd: repo, evidenceDir: evidence, pathBase: join(repo, '..'),
      redDeclared: [{ file: 'tests/run.mjs', name: 'publishing emits JOB_RESULT_V2' }] });
    expect(record.exit_code).not.toBe(0);
    expect(record.results?.format).toBe('junit-xml');
    expect(readGateTests(join(repo, '..'), record)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tests/run.mjs', name: 'publishing emits JOB_RESULT_V2', status: 'failed' }),
    ]));
  });
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
    // The category and its fingerprint are kept with the record.
    expect(record).toMatchObject({ red_category: 'assertion', red_fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(validateAgainstSchema('evidence', record)).toEqual([]);
  });

  it('records the category of a RED that used a missing symbol, and refuses it as a missing behaviour', () => {
    const { repo, evidence } = workspace();
    const record = runVerification({
      kind: 'red',
      nodeId: 'FEAT-1.a.b.red',
      repository: 'core',
      command: [process.execPath, '-e', 'console.error(" FAIL  a.test.ts > x\\nTypeError: ChangesetValidationError is not a constructor"); process.exit(1)'],
      cwd: repo,
      evidenceDir: evidence,
    });
    expect(record).toMatchObject({ exit_code: 1, red_reason: 'setup-error', red_category: 'missing-symbol' });
    expect(record.red_detail).toMatch(/is not a constructor/);
    expect(validateAgainstSchema('evidence', record)).toEqual([]);
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


// Proposed optional observer; no raw persistence and no caller-selected report
// path. Keeping this local permits native RED before the source API exists.
type RawReportObservation = {
  bytes: Buffer | null;
  sha256: string | null;
  output: string;
  exit_code: number;
  steps: { exit_code: number; timed_out: boolean }[];
  normalized_count: number;
};
type ObservedVerificationArgs = Parameters<typeof runVerification>[0] & {
  onRawReport?: (snapshot: RawReportObservation) => void;
};

describe('runner optional transient raw-report observer', () => {
  it('calls the observer once after normalization while raw scratch still exists and removes it before return', () => {
    const { repo, evidence } = workspace();
    const scratch = makeTmpDir('raw-lifetime-');
    const raw = JSON.stringify({ testResults: [], errors: [{ type: 'SyntaxError',
      message: 'token=private-runner-token C:/private/source.ts' }] });
    const observations: RawReportObservation[] = [];
    let rawPath = '';
    const args: ObservedVerificationArgs = {
      kind: 'red', nodeId: 'N', repository: null, cwd: repo, evidenceDir: evidence,
      cleanEnv: true, reportScratchRoot: scratch, report: { format: 'vitest-json' },
      steps: [[process.execPath, '-e', 'process.exit(0)']],
      command: [process.execPath, '-e', `require('node:fs').writeFileSync(process.argv[1], ${JSON.stringify(raw)}); process.exit(1)`, '${REPORT}'],
      onRawReport: snapshot => {
        observations.push(snapshot);
        const dirs = readdirSync(scratch);
        expect(dirs).toHaveLength(1);
        rawPath = join(scratch, dirs[0]!, 'report.json');
        expect(readFileSync(rawPath)).toEqual(Buffer.from(raw));
        expect(snapshot.bytes).toEqual(Buffer.from(raw));
        expect(snapshot.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
        expect(snapshot).toMatchObject({ exit_code: 1, normalized_count: 0,
          steps: [expect.objectContaining({ exit_code: 0, timed_out: false })] });
        expect(snapshot).not.toHaveProperty('path');
      },
    };
    const record = runVerification(args);
    expect(observations).toHaveLength(1); // Missing hook is the intended native RED.
    expect(rawPath).not.toBe('');
    expect(existsSync(rawPath)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
    expect(record.results).toMatchObject({ total: 0, format: 'vitest-json' });
    expect(record).not.toHaveProperty('raw');
    expect(record).not.toHaveProperty('diagnostic');
    expect(readdirSync(evidence).sort()).toEqual([
      record.output_path.split(/[\\/]/).at(-1)!, record.results!.path.split(/[\\/]/).at(-1)!,
    ].sort());
  });

  it.each(['malformed', 'missing'])('observes %s raw without inventing normalized identities and cleans scratch', kind => {
    const { repo, evidence } = workspace();
    const scratch = makeTmpDir('raw-unavailable-');
    const seen: RawReportObservation[] = [];
    const args: ObservedVerificationArgs = {
      kind: 'red', nodeId: 'N', repository: null, cwd: repo, evidenceDir: evidence,
      reportScratchRoot: scratch, report: { format: 'vitest-json' },
      command: [process.execPath, '-e', kind === 'missing' ? 'process.exit(1)' :
        "require('node:fs').writeFileSync(process.argv[1], '{invalid'); process.exit(1)", '${REPORT}'],
      onRawReport: value => { seen.push(value); },
    };
    const record = runVerification(args);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ bytes: kind === 'missing' ? null : Buffer.from('{invalid'),
      sha256: kind === 'missing' ? null : createHash('sha256').update('{invalid').digest('hex'), normalized_count: 0 });
    expect(record.results?.total).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('turns an observer exception into a static failure and still deletes raw scratch', () => {
    const { repo, evidence } = workspace();
    const scratch = makeTmpDir('raw-throw-');
    let calls = 0;
    const args: ObservedVerificationArgs = {
      kind: 'red', nodeId: 'N', repository: null, cwd: repo, evidenceDir: evidence,
      reportScratchRoot: scratch, report: { format: 'vitest-json' },
      command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '{\"testResults\":[]}')", '${REPORT}'],
      onRawReport: () => { calls++; throw new Error('token=private-exception C:/private/source.ts'); },
    };
    expect(() => runVerification(args)).toThrowError(/^CHANNEL_PROBE_REPORT_INVALID:RAW$/);
    expect(calls).toBe(1);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('keeps ordinary accepted verification unchanged with no observer or diagnostic artifacts', () => {
    const { repo, evidence } = workspace();
    const scratch = makeTmpDir('raw-ordinary-');
    const raw = JSON.stringify({ testResults: [{ name: join(repo, 'tests/ordinary.test.ts'),
      status: 'passed', assertionResults: [{ title: 'ordinary', fullName: 'ordinary', status: 'passed', ancestorTitles: [] }] }] });
    const record = runVerification({ kind: 'green', nodeId: 'N', repository: null, cwd: repo,
      evidenceDir: evidence, reportScratchRoot: scratch, report: { format: 'vitest-json' },
      command: [process.execPath, '-e', `require('node:fs').writeFileSync(process.argv[1], ${JSON.stringify(raw)})`, '${REPORT}'] });
    expect(record.exit_code).toBe(0);
    expect(record.results).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(record).not.toHaveProperty('diagnostic');
    expect(record).not.toHaveProperty('raw');
    expect(readdirSync(evidence)).toHaveLength(2);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
