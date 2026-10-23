import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as gitCommands from '../../src/git/git.js';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git, makeGitRepo } from '../helpers/git-fixture.js';
import { BASE_FILES, createShop, ERRORS, ERRORS_RED, ERRORS_RED_STATIC_IMPORT, initialisedWithGraph, moduleVerifier, SHOP_FEATURE, shopGraph, shopState } from '../helpers/shop-fixture.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { modulesOf, verifierFor } from '../../src/engine/modules.js';
import * as contextPack from '../../src/sessions/context-pack.js';
import type { ModuleReport, RepositoryDecl } from '../../src/model/types.js';
import { ClaimChannel, type LiveClaim } from '../../src/sessions/codex-claim-channel.js';
import * as hostGate from '../../src/sessions/codex-host-gate.js';
import type { ChannelResponse } from '../../src/sessions/codex-claim-channel.js';
import { executeHostClaimGate } from '../../src/sessions/codex-host-gate.js';
import { redactText } from '../../src/security/redact.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { createHash } from 'node:crypto';
import { CodexCliAdapter, windowsToWslPath } from '../../src/sessions/codex-cli-adapter.js';
import * as verificationRunner from '../../src/evidence/runner.js';
import { ClaimFileTransport } from '../../src/sessions/codex-claim-files.js';

afterAll(() => cleanupTmpRoots());

// Assert only metadata so failed assertions cannot print private fixture output.
function expectPrivateText(actual: unknown, expected: string) {
  expect.soft(typeof actual === 'string').toBe(true);
  if (typeof actual !== 'string') return;
  expect.soft(createHash('sha256').update(actual).digest('hex'))
    .toBe(createHash('sha256').update(expected).digest('hex'));
  expect.soft(Buffer.byteLength(actual)).toBe(Buffer.byteLength(expected));
}


// Proposed API: the fourth channel callback takes NO worker arguments. The
// controller re-derives the current module plan and owns the per-claim budget.
// diagnostic.tests are informational identities, never criterion_evidence.
const request = (sequence: number, extra: Record<string, unknown> = {}) => ({
  claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', sequence, operation: 'probe', ...extra,
});
const scope = (): LiveClaim => ({ claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', repoPath: 'unused', worktree: 'unused',
  expectedHead: '0'.repeat(40), allowedPaths: [], forbiddenPaths: [], nextGate: 'red',
  gateCommands: [{ gate: 'red', argv: ['node', 'controller-only'] }] });
const diagnostic = () => ({ exitCode: 1, output: 'AssertionError: missing behavior', diagnostic: {
  role: 'diagnostic-only' as const, tests: [{ id: canonicalTestId('junit-xml', 'tests/a.mjs', 'behavior'), path: 'tests/a.mjs', full_name: 'behavior', status: 'failed' as const }],
} });

describe('PRE-RED probe protocol', () => {
  it('allows a failed verifier diagnostic without accepting RED or exposing evidence handles', () => {
    const gate = vi.fn(() => ({ exitCode: 0, output: 'accepted' }));
    const probe = vi.fn(diagnostic);
    const channel = new ClaimChannel(scope, gate, undefined, probe);
    expect(channel.handle(request(1))).toEqual({ ok: true, sequence: 1, ...diagnostic() });
    expect(probe).toHaveBeenCalledWith();
    expect(gate).not.toHaveBeenCalled();
    const red = channel.handle(request(2, { operation: 'gate', gate: 'red' }));
    expect(red).toMatchObject({ ok: true });
    expect(channel.handle(request(3))).toMatchObject({ ok: false, code: 'CHANNEL_PROBE_UNAVAILABLE' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each(['argv', 'path', 'cwd', 'filter', 'module', 'report', 'deadlineMs'])('denies worker-supplied %s before invoking the host', (field) => {
    const probe = vi.fn(diagnostic);
    const channel = new ClaimChannel(scope, vi.fn(), undefined, probe);
    expect(channel.handle(request(1, { [field]: 'worker-controlled' }))).toMatchObject({ ok: false, code: 'CHANNEL_REQUEST_INVALID' });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'generation', 'head', 'worktree'] as const)('rejects %s changes during execution', (change) => {
    let current: LiveClaim | null = scope();
    const channel = new ClaimChannel(() => current, vi.fn(), undefined, () => {
      current = change === 'cancelled' ? null : { ...scope(), ...(change === 'generation' ? { claimId: 'claim-2' }
        : change === 'head' ? { expectedHead: '1'.repeat(40) } : { worktree: 'other' }) };
      return diagnostic();
    });
    expect(channel.handle(request(1))).toMatchObject({ ok: false, code: 'CHANNEL_CLAIM_STALE' });
  });

  it('keeps probe opt-in and unavailable when the current phase is not pre-RED', () => {
    expect(new ClaimChannel(scope, vi.fn()).handle(request(1))).toMatchObject({ ok: false, code: 'CHANNEL_PROBE_UNAVAILABLE' });
    const probe = vi.fn(diagnostic);
    expect(new ClaimChannel(() => ({ ...scope(), nextGate: 'green' }), vi.fn(), undefined, probe).handle(request(1)))
      .toMatchObject({ ok: false, code: 'CHANNEL_PROBE_UNAVAILABLE' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses an oversized diagnostic from a callback that bypasses the host', () => {
    const result = diagnostic();
    result.diagnostic.tests[0]!.full_name = 'n'.repeat(32769);
    const channel = new ClaimChannel(scope, vi.fn(), undefined, () => result);
    expect(channel.handle(request(1))).toEqual({ ok: true, sequence: 1,
      exitCode: 2, output: 'CHANNEL_PROBE_REPORT_INVALID:SIZE' });
  });

  it('never forwards runner receipts as criterion_evidence handles', () => {
    const channel = new ClaimChannel(scope, vi.fn(), undefined, () => ({ ...diagnostic(),
      outputSha256: 'a'.repeat(64), output_sha256: 'a'.repeat(64), testIds: ['receipt'], test_ids: ['receipt'],
      output_path: 'features/F/evidence/probe.log', results: { path: 'probe.results.json' },
    }));
    const response = channel.handle(request(1));
    expect(response).toMatchObject({ ok: true, diagnostic: { role: 'diagnostic-only' } });
    for (const key of ['outputSha256', 'output_sha256', 'testIds', 'test_ids', 'output_path', 'results']) expect(response).not.toHaveProperty(key);
  });
});

async function fixture(options: Parameters<typeof createShop>[0] = {}, command?: string[] | ((s: Awaited<ReturnType<typeof createShop>>) => string[]), plan: { setup?: string[][]; build?: string[][]; report?: ModuleReport } = {}, beforeClaim?: (s: Awaited<ReturnType<typeof createShop>>) => void) {
  const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier(), { compatibility: false }), ...options });
  if (command) {
    const path = join(s.control, 'repositories.yaml');
    const registry = YAML.parse(readFileSync(path, 'utf8')) as { repositories: RepositoryDecl[] };
    Object.assign(registry.repositories[0]!.module_defaults!, { test: typeof command === 'function' ? command(s) : command, ...plan });
    writeFileSync(path, YAML.stringify(registry));
    const modules = modulesOf(registry.repositories[0]);
    initialisedWithGraph(s, shopGraph((id) => verifierFor(modules.find((m) => m.id === id)!), { compatibility: false }));
  }
  beforeClaim?.(s);
  const controller = new Orchestrator({ controlRoot: s.control, featureId: SHOP_FEATURE,
    adapter: beforeClaim ? new CodexCliAdapter({ executable: process.execPath, disposableRepositories: true }) : {} as never });
  const claim = controller.claim(ERRORS, { mode: 'adapter' });
  const worktree = claim.worktree!;
  const test = join(worktree, 'packages/errors/test/errors.test.mjs');
  const probe = (deadlineMs = 30_000) => controller.codexProbeClaim(ERRORS, claim.claimId, claim.capability, worktree, { deadlineMs });
  const state = () => readFileSync(join(s.featureDir, 'STATE.json'), 'utf8');
  const evidence = () => readdirSync(s.featureDir, { recursive: true }).map(String).filter((p) => /evidence|probe|results|\.log$/.test(p)).sort();
  return { s, controller, claim, worktree, test, probe, state, evidence };
}

describe('controller-owned probe with a real registered module and native host verifier', () => {
  // Real disposable Git baseline and manifest: no sealed pilot fixture and no
  // validator/runner mocks. The registered verifier consumes the path as data.
  async function boundFixture(mutateAfter = false) {
    let manifest = '';
    let bytes = '';
    let declaration: { manifest: string; baseline: string; sha256: string };
    const markerName = 'fixture-child-ran.txt';
    const f = await fixture({}, s => {
      const baseline = join(dirname(s.control), 'probe-baseline');
      makeGitRepo(baseline, { files: { 'pnpm-lock.yaml': 'disposable fixture lock\n' } });
      const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
      manifest = join(dirname(s.control), 'probe-fixture.json');
      bytes = JSON.stringify({ schema: 'mycelink-frozen-git-build/1',
        frozen_sha: git(baseline, ['rev-parse', 'HEAD']), tree: git(baseline, ['rev-parse', 'HEAD^{tree}']),
        lock_git_blob: git(baseline, ['rev-parse', 'HEAD:pnpm-lock.yaml']), baseline_windows_root: baseline,
        baseline_wsl_root: process.platform === 'win32' ? windowsToWslPath(baseline) : baseline,
        files_sha256: { 'pnpm-lock.yaml': hash('disposable fixture lock\n') },
        dependency_audit: { root_confined: true }, build_receipts_sha256: { build: 'a'.repeat(64) } });
      writeFileSync(manifest, bytes);
      declaration = { manifest: '../probe-fixture.json', baseline: '../probe-baseline', sha256: hash(bytes) };
      return ['node', '-e', `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        const hash = b => require('node:crypto').createHash('sha256').update(b).digest('hex');
        fs.writeFileSync(${JSON.stringify(join(dirname(s.control), markerName))}, 'started');
        assert.equal(process.env.MYCELINK_AC5_FIXTURE, ${JSON.stringify(manifest)}, 'AC5_FIXTURE_ENV_UNBOUND');
        assert.equal(hash(fs.readFileSync(process.env.MYCELINK_AC5_FIXTURE)), ${JSON.stringify(hash(bytes))});
        assert.deepEqual(Object.keys(process.env).filter(k => k.toUpperCase().startsWith('MYCELINK_')), ['MYCELINK_AC5_FIXTURE']);
        for (const key of ['SECRET_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY']) assert.equal(process.env[key], undefined);
        console.log('FIXTURE_CHILD_VERIFIED');
        ${mutateAfter ? `fs.appendFileSync(process.env.MYCELINK_AC5_FIXTURE, ' ');` : ''}
        fs.writeFileSync(process.argv[1], '<testsuites><testsuite tests="1"><testcase name="fixture data binding" file="packages/errors/test/errors.test.mjs"/></testsuite></testsuites>');
      `, '${REPORT}'];
    }, {}, s => {
      const configPath = join(s.control, 'mycelink.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.experimental_codex = { enabled: true, disposable_repositories: ['shop'] };
      writeFileSync(configPath, JSON.stringify(config));
      const graph = YAML.parse(readFileSync(join(s.featureDir, 'PORTFOLIO-GRAPH.yaml'), 'utf8'));
      graph.nodes.find((n: { id: string }) => n.id === ERRORS).readonly_fixture = declaration!;
      initialisedWithGraph(s, graph);
      contextPack.verifyReadonlyFixture(s.control, declaration!);
    });
    return { ...f, manifest, bytes, marker: join(dirname(f.s.control), markerName), declaration: declaration! };
  }

  it('passes only the verified graph-bound absolute fixture path to the real registered verifier child', async () => {
    const f = await boundFixture();
    const before = f.state();
    const evidence = f.evidence();
    const verify = vi.spyOn(contextPack, 'verifyReadonlyFixture'); // call-through, never replace validation
    const run = vi.spyOn(verificationRunner, 'runVerification'); // call-through: the host child really runs
    vi.stubEnv('MYCELINK_AC5_FIXTURE', join(f.s.root, 'worker-controlled.json'));
    vi.stubEnv('MYCELINK_CAPABILITY', 'inherited-capability-must-not-leak');
    vi.stubEnv('MYCELINK_WORKER_ENV', 'inherited-worker-value');
    vi.stubEnv('SECRET_TOKEN', 'inherited-secret');
    vi.stubEnv('OPENAI_API_KEY', 'inherited-api-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'inherited-aws-secret');
    try {
      expect(f.probe()).toMatchObject({ exitCode: 0, output: expect.stringContaining('FIXTURE_CHILD_VERIFIED'),
        diagnostic: { role: 'diagnostic-only', tests: [expect.objectContaining({ status: 'passed' })] } });
      expect(readFileSync(f.marker, 'utf8')).toBe('started');
      expect(verify).toHaveBeenCalledTimes(3);
      expect(run).toHaveBeenCalledTimes(1);
      expect(verify.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[1]!);
      expect(verify.mock.invocationCallOrder[1]).toBeLessThan(run.mock.invocationCallOrder[0]!);
      expect(verify.mock.invocationCallOrder[2]).toBeGreaterThan(run.mock.invocationCallOrder[0]!);
      for (const call of verify.mock.calls) expect(call).toEqual([f.s.control, f.declaration]);
      expect(readFileSync(f.manifest, 'utf8')).toBe(f.bytes);
      expect(f.state()).toBe(before);
      expect(f.evidence()).toEqual(evidence);
    } finally { verify.mockRestore(); run.mockRestore(); vi.unstubAllEnvs(); }
  });

  it.each(['missing', 'tampered'] as const)('rejects a %s graph-bound fixture before starting the real child', async kind => {
    const f = await boundFixture();
    if (kind === 'missing') unlinkSync(f.manifest);
    else writeFileSync(f.manifest, f.bytes + ' ');
    const before = f.state();
    expect(f.probe()).toMatchObject({ exitCode: 2, output: expect.stringContaining('FIXTURE_INVALID') });
    expect(existsSync(f.marker)).toBe(false);
    expect(f.state()).toBe(before);
  });

  it('rejects fixture tampering by the real verifier child on the post-run verification', async () => {
    const f = await boundFixture(true);
    const before = f.state();
    const result = f.probe();
    expect(readFileSync(f.marker, 'utf8')).toBe('started');
    expect(readFileSync(f.manifest, 'utf8')).toBe(f.bytes + ' ');
    expect(result).toMatchObject({ exitCode: 2, output: expect.stringContaining('FIXTURE_INVALID') });
    expect(result).not.toHaveProperty('diagnostic');
    expect(f.state()).toBe(before);
  });

  it('accepts literal bracketed tracked paths in independent probe clone', async () => {
    const bracketed = {
      'site/packages/[pkg].md': '# Literal package page\n',
      'site/packages/[pkg].paths.ts': 'export default { paths: [] };\n',
    };
    const testPath = 'packages/errors/test/errors.test.mjs';
    const name = 'literal bracketed baseline reaches native verifier';
    // baseFiles are committed by createShop before the controller claims the node.
    // Bind the native host executable and exact test through the registered module graph.
    const f = await fixture({ baseFiles: bracketed }, [process.execPath, '--test',
      '--test-reporter=junit', '--test-reporter-destination=${REPORT}', testPath]);
    const live = f.controller.codexClaimScope(ERRORS, f.claim.claimId, f.claim.capability, f.worktree)!;
    expect(live.nextGate).toBe('red');
    expect(live.allowedPaths).toContain('packages/errors/**');
    for (const [path, bytes] of Object.entries(bracketed)) {
      expect(git(f.worktree, ['ls-files', '-z']).split('\0')).toContain(path);
      expect(git(f.worktree, ['show', `HEAD:${path}`])).toBe(bytes.trim());
      expect(readFileSync(join(f.worktree, path), 'utf8')).toBe(bytes);
    }
    const workerTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, lstatSync } from 'node:fs';
import { GitError } from '../src/index.mjs';
test(${JSON.stringify(name)}, () => {
  assert.equal(lstatSync('.git').isDirectory(), true);
  for (const [path, bytes] of Object.entries(${JSON.stringify(bracketed)})) {
    assert.equal(readFileSync(path, 'utf8'), bytes);
  }
  assert.equal(new GitError(7, 'probe').code, 8, 'intentional verifier assertion');
});
`;
    writeFileSync(f.test, workerTest); // Legal, uncommitted test-only worker edit.
    expect(git(f.worktree, ['diff', '--name-only'])).toBe(testPath);
    const snapshot = (root: string) => {
      const observe = (argv: string[]) => git(root, ['--no-optional-locks', ...argv]);
      return {
        head: observe(['rev-parse', 'HEAD']), refs: observe(['show-ref']),
        index: observe(['ls-files', '--stage', '-z']),
        status: observe(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        tracked: observe(['ls-files', '-z']).split('\0').filter(Boolean)
          .map(path => [path, readFileSync(join(root, path)).toString('base64')]),
      };
    };
    const before = snapshot(f.worktree);
    const repositoryBefore = snapshot(f.s.repo);
    const state = f.state();
    const evidence = f.evidence();
    const originalCommon = realpathSync(resolve(f.worktree, git(f.worktree, ['rev-parse', '--git-common-dir'])));
    let clone = '';
    let report = '';
    let runnerCalls = 0;
    const realGit = gitCommands.runGit;
    const commands = vi.spyOn(gitCommands, 'runGit').mockImplementation((cwd, argv, options) => {
      const result = realGit(cwd, argv, options);
      if (argv[0] === 'clone') clone = argv.at(-1)!;
      return result;
    });
    const realRun = verificationRunner.runVerification;
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      expect(realpathSync(args.cwd)).toBe(realpathSync(clone));
      expect(realpathSync(args.cwd).toLowerCase()).not.toBe(realpathSync(f.worktree).toLowerCase());
      expect(lstatSync(join(args.cwd, '.git')).isDirectory()).toBe(true);
      const common = realpathSync(resolve(args.cwd, git(args.cwd, ['rev-parse', '--git-common-dir'])));
      expect(common.toLowerCase()).not.toBe(originalCommon.toLowerCase());
      expect(snapshot(args.cwd).head).toBe(before.head);
      expect(snapshot(args.cwd).tracked).toEqual(before.tracked);
      expect(snapshot(f.worktree)).toEqual(before);
      expect(snapshot(f.s.repo)).toEqual(repositoryBefore);
      const record = realRun(args); // Real child and report parser; no verifier substitution.
      expect(record.results).toMatchObject({ format: 'junit-xml', total: 1, passed: 0, failed: 1 });
      report = record.results!.path;
      expect(existsSync(report)).toBe(true);
      return record;
    });
    let result: ReturnType<typeof f.probe>;
    try { result = f.probe(); }
    finally { runnerCalls = runner.mock.calls.length; runner.mockRestore(); commands.mockRestore(); }
    // Verify preservation even when the current bug refuses the baseline before cloning.
    expect(snapshot(f.worktree)).toEqual(before);
    expect(snapshot(f.s.repo)).toEqual(repositoryBefore);
    expect(f.state()).toBe(state);
    expect(f.evidence()).toEqual(evidence);
    if (clone) expect(existsSync(dirname(clone))).toBe(false);
    if (report) expect(existsSync(report)).toBe(false);
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 1, diagnostic: {
      role: 'diagnostic-only', tests: [{ id: canonicalTestId('junit-xml', testPath, name),
        path: testPath, full_name: name, status: 'failed' }],
    } });
    expect(runnerCalls).toBe(1);
    expect(clone).not.toBe('');
    expect(report).not.toBe('');
    for (const key of ['output_sha256', 'outputSha256', 'test_ids', 'testIds', 'results', 'output_path', 'criterion_evidence']) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it.each(['../outside.test.mjs', '/outside.test.mjs', 'C:/outside.test.mjs',
    'packages/errors/test/../outside.test.mjs', 'site/packages/a\u0001.md', 'site/packages/a\u007f.md'])(
    'refuses unsafe enumerated tracked path %s before clone or verifier', async path => {
      const f = await fixture();
      writeFileSync(f.test, ERRORS_RED);
      const state = f.state();
      const evidence = f.evidence();
      const realGit = gitCommands.runGit;
      // Git cannot create traversal/absolute index entries normally. Inject only
      // the NUL-delimited enumeration to exercise the host's path boundary.
      const commands = vi.spyOn(gitCommands, 'runGit').mockImplementation((cwd, argv, options) => {
        const result = realGit(cwd, argv, options);
        return argv[0] === 'ls-files' && argv.includes('--cached')
          ? { ...result, stdout: result.stdout + path + '\0' } : result;
      });
      const runner = vi.spyOn(verificationRunner, 'runVerification');
      try {
        expect(f.probe()).toMatchObject({ exitCode: 2, output: 'CHANNEL_PROBE_PATH_INVALID' });
        expect(commands.mock.calls.some(([, argv]) => argv[0] === 'clone')).toBe(false);
        expect(runner).not.toHaveBeenCalled();
        expect(f.state()).toBe(state);
        expect(f.evidence()).toEqual(evidence);
      } finally { runner.mockRestore(); commands.mockRestore(); }
    });

  it('diagnoses failure, permits test repair and success, then runs exactly one real RED with fresh acceptance evidence', async () => {
    const f = await fixture();
    const before = f.state();
    const files = f.evidence();
    const head = git(f.worktree, ['rev-parse', 'HEAD']);
    writeFileSync(f.test, ERRORS_RED_STATIC_IMPORT);
    expect(f.probe()).toMatchObject({ exitCode: 1, diagnostic: { role: 'diagnostic-only' } });
    expect(f.state()).toBe(before);
    writeFileSync(f.test, BASE_FILES['packages/errors/test/errors.test.mjs']);
    const passed = f.probe();
    expect(passed).toMatchObject({ exitCode: 0, diagnostic: { role: 'diagnostic-only', tests: [expect.objectContaining({ status: 'passed' })] } });
    writeFileSync(f.test, ERRORS_RED);
    const failed = f.probe();
    const id = canonicalTestId('junit-xml', 'packages/errors/test/errors.test.mjs', 'ChangesetValidationError sorts the issues and lists one per line');
    expect(failed).toMatchObject({ exitCode: 1, diagnostic: { tests: expect.arrayContaining([expect.objectContaining({ id, status: 'failed' })]) } });
    for (const result of [passed, failed]) {
      for (const key of ['output_sha256', 'outputSha256', 'test_ids', 'testIds', 'results', 'output_path']) expect(result).not.toHaveProperty(key);
      expect(result.output.length).toBeLessThanOrEqual(32 * 1024);
    }
    expect(f.state()).toBe(before);
    expect(f.evidence()).toEqual(files); // no durable diagnostic receipts to cite
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(f.worktree, ['diff', '--cached', '--name-only'])).toBe('');
    expect(readFileSync(join(f.worktree, 'packages/errors/src/index.mjs'), 'utf8')).toBe(BASE_FILES['packages/errors/src/index.mjs']);
    // A fresh channel cannot reset the host's per-claim budget.
    expect(f.probe()).toMatchObject({ exitCode: 2, output: 'CHANNEL_PROBE_LIMIT' });
    const live = () => f.controller.codexClaimScope(ERRORS, f.claim.claimId, f.claim.capability, f.worktree);
    const premature = new ClaimChannel(live, vi.fn(), undefined, () => f.probe());
    expect(premature.handle({ claimId: f.claim.claimId, featureId: SHOP_FEATURE, nodeId: ERRORS, sequence: 1,
      operation: 'commit', paths: ['packages/errors/test/errors.test.mjs'], message: 'test: premature diagnostic commit' }))
      .toMatchObject({ ok: false });
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(head);
    const gate = vi.fn((argv: readonly string[], cwd: string) => executeHostClaimGate({ controlRoot: f.s.control, featureId: SHOP_FEATURE,
      gate: 'red', argv, cwd, deadlineMs: 30_000, readRecord: () => shopState(f.s).nodes[ERRORS].evidence.red }));
    const channel = new ClaimChannel(live, gate, undefined, () => f.probe());
    const identity = { claimId: f.claim.claimId, featureId: SHOP_FEATURE, nodeId: ERRORS };
    expect(channel.handle({ ...identity, sequence: 1, operation: 'gate', gate: 'red' })).toMatchObject({ ok: true, output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), test_ids: expect.arrayContaining([id]) });
    expect(shopState(f.s).nodes[ERRORS].state).toBe('RED_VERIFIED');
    expect(channel.handle({ ...identity, sequence: 2, operation: 'gate', gate: 'red' })).toMatchObject({ ok: false });
    expect(f.probe()).toMatchObject({ exitCode: 2, output: 'CHANNEL_PROBE_UNAVAILABLE' });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it.each(['tracked product', 'untracked product', 'outside module', 'symlink'])('refuses %s edits without changing acceptance state', async (kind) => {
    const f = await fixture();
    writeFileSync(f.test, ERRORS_RED);
    if (kind === 'tracked product') writeFileSync(join(f.worktree, 'packages/errors/src/index.mjs'), 'export const unsafe = true;');
    if (kind === 'untracked product') writeFileSync(join(f.worktree, 'packages/errors/src/unsafe.mjs'), 'unsafe');
    if (kind === 'outside module') writeFileSync(join(f.worktree, 'packages/read/test/read.test.mjs'), 'throw new Error("unsafe");');
    if (kind === 'symlink') symlinkSync(join(f.s.repo, 'packages/errors/src/index.mjs'), join(f.worktree, 'packages/errors/test/linked.test.mjs'), 'file');
    const before = f.state();
    const commands = vi.spyOn(gitCommands, 'runGit');
    try {
      expect(f.probe()).toMatchObject({ exitCode: 2 });
      // Fence validation must precede disposable checkout allocation.
      expect(commands.mock.calls.some(([, args]) => args[0] === 'clone' || (args[0] === 'worktree' && args[1] === 'add'))).toBe(false);
      expect(f.state()).toBe(before);
    } finally { commands.mockRestore(); }
  });

  it('refuses a cancelled claim before launching any verifier', async () => {
    const f = await fixture();
    f.controller.releaseForInfrastructure(ERRORS, f.claim.claimId, 'test cancellation');
    const before = f.state();
    expect(f.probe()).toMatchObject({ exitCode: 2, output: 'CHANNEL_CLAIM_STALE' });
    expect(f.state()).toBe(before);
  });

  it.each([0, 600_001, NaN])('refuses invalid host deadline %s', async (deadline) => {
    const f = await fixture();
    const before = f.state();
    expect(f.probe(deadline)).toMatchObject({ exitCode: 2 });
    expect(f.state()).toBe(before);
  });

  it('refuses module descriptor drift rather than running a replacement verifier', async () => {
    const f = await fixture();
    const path = join(f.s.control, 'repositories.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('timeout_seconds: 300', 'timeout_seconds: 301'));
    const before = f.state();
    expect(f.probe()).toMatchObject({ exitCode: 2 });
    expect(f.state()).toBe(before);
  });

  it.each(['missing', 'malformed', 'empty', 'noncanonical'])('fails closed on a %s structured report even when the verifier exits zero', async (kind) => {
    const body = kind === 'malformed' ? '<testsuite><broken' : kind === 'empty' ? '<testsuites></testsuites>'
      : '<testsuites><testsuite><testcase name="outside" file="../../outside.test.mjs"/></testsuite></testsuites>';
    const command = ['node', '-e', kind === 'missing' ? 'process.exit(0)'
      : `require('node:fs').writeFileSync(process.argv[1], ${JSON.stringify(body)})`, '${REPORT}'];
    const f = await fixture({}, command);
    const before = f.state();
    const files = f.evidence();
    const result = f.probe();
    expect(result).toMatchObject({ exitCode: 2 });
    expect(result).not.toHaveProperty('diagnostic');
    for (const key of ['output_sha256', 'outputSha256', 'test_ids', 'testIds', 'results', 'output_path', 'criterion_evidence']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(f.state()).toBe(before);
    expect(f.evidence()).toEqual(files);
  });

  it.each(['huge name', 'huge path', 'aggregate', 'small'] as const)(
    'bounds a declared module report through the host and mailbox: %s', async kind => {
      const limit = 32 * 1024;
      const testPath = 'packages/errors/test/errors.test.mjs';
      const tests = Array.from({ length: kind === 'aggregate' ? 128 : 1 }, (_, i) => ({
        path: kind === 'huge path' ? 'packages/errors/test/' + 'p'.repeat(limit + 1) + '.test.mjs' : testPath,
        full_name: kind === 'huge name' ? 'n'.repeat(limit + 1)
          : kind === 'aggregate' ? `case ${i} ` + 'n'.repeat(256) : 'small canonical behavior',
      }));
      const expected = tests.map(t => ({ ...t, id: canonicalTestId('junit-xml', t.path, t.full_name), status: 'passed' }));
      if (kind !== 'small') expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(limit);
      // Build large data in the declared child, keeping Windows argv short.
      // These paths are report data, never worker-supplied probe arguments.
      const f = await fixture({}, ['node', '-e', `
        const kind = ${JSON.stringify(kind)};
        const tests = Array.from({ length: kind === 'aggregate' ? 128 : 1 }, (_, i) => {
          const path = kind === 'huge path' ? 'packages/errors/test/' + 'p'.repeat(32769) + '.test.mjs' : '${testPath}';
          const name = kind === 'huge name' ? 'n'.repeat(32769)
            : kind === 'aggregate' ? 'case ' + i + ' ' + 'n'.repeat(256) : 'small canonical behavior';
          return '<testcase name="' + name + '" file="' + path + '"/>';
        });
        require('node:fs').writeFileSync(process.argv[1], '<testsuites><testsuite>' + tests.join('') + '</testsuite></testsuites>');
      `, '${REPORT}'], { report: { format: 'junit-xml' } });
      const before = f.state();
      const evidence = f.evidence();
      const result = f.probe();
      const live = () => f.controller.codexClaimScope(ERRORS, f.claim.claimId, f.claim.capability, f.worktree);
      const probe = vi.fn(() => result);
      const gate = vi.fn();
      const channel = new ClaimChannel(live, gate, undefined, probe);
      mkdirSync(join(f.worktree, '.mycelink-worker'), { recursive: true });
      const transport = new ClaimFileTransport(f.worktree, f.claim.claimId, input => channel.handle(input), {},
        { featureId: SHOP_FEATURE, nodeId: ERRORS });
      transport.start();
      try {
        const payload = { claimId: f.claim.claimId, featureId: SHOP_FEATURE, nodeId: ERRORS, sequence: 1, operation: 'probe' };
        writeFileSync(join(transport.dir, 'request-1.json'), JSON.stringify(payload));
        transport.tick();
        const bytes = readFileSync(join(transport.dir, 'response-1.json'));
        const response = JSON.parse(bytes.toString('utf8'));
        expect(probe).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledWith();
        expect(gate).not.toHaveBeenCalled();
        expect.soft(bytes.length).toBeLessThanOrEqual(limit);
        expect.soft(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(limit);
        if (kind === 'small') {
          expect(result).toMatchObject({ exitCode: 0, diagnostic: { role: 'diagnostic-only', tests: expected } });
          expect(response).toMatchObject({ ok: true, sequence: 1, exitCode: 0,
            diagnostic: { role: 'diagnostic-only', tests: expected } });
        } else {
          expect.soft(result.exitCode).toBe(2);
          expect.soft(result).not.toHaveProperty('diagnostic');
          expect.soft(response.exitCode).toBe(2);
          expect.soft(response).not.toHaveProperty('diagnostic');
        }
        for (const value of [result, response]) {
          for (const key of ['output_sha256', 'outputSha256', 'test_ids', 'testIds', 'results', 'output_path', 'criterion_evidence']) {
            expect(value).not.toHaveProperty(key);
          }
        }
        expect(f.state()).toBe(before);
        expect(f.evidence()).toEqual(evidence);
      } finally { transport.stop(); }
    });

  it.each([
    ['hash', 'HASH'], ['json', 'FORMAT'], ['schema', 'FORMAT'], ['format', 'FORMAT'],
    ['null document', 'FORMAT'], ['results', 'FORMAT'], ['missing entry', 'ENTRY'], ['missing file', 'ENTRY'],
    ['missing name', 'ENTRY'], ['huge file', 'ENTRY'], ['huge name', 'ENTRY'],
    ['traversal', 'IDENTITY:PATH'], ['absolute path', 'IDENTITY:PATH'],
    ['Windows absolute path', 'IDENTITY:PATH'], ['unsafe path', 'IDENTITY:PATH'],
    ['unsafe Vitest suite', 'IDENTITY:PATH'], ['legitimate Vitest suite', null],
    ['id', 'IDENTITY:ID'], ['todo status', 'IDENTITY:STATUS'], ['unknown status', 'IDENTITY:STATUS'],
    ['empty', 'IDENTITY:EMPTY'], ['count', 'IDENTITY:COUNT'], ['aggregate', 'SIZE'],
  ] as const)('checks normalized report %s with bounded refusal stage %s', async (kind, stage) => {
    const testPath = 'packages/errors/test/errors.test.mjs';
    const f = await fixture({}, [process.execPath, '--test', '--test-reporter=junit',
      '--test-reporter-destination=${REPORT}', testPath]);
    const snapshot = (root: string) => ({
      head: git(root, ['--no-optional-locks', 'rev-parse', 'HEAD']),
      refs: git(root, ['--no-optional-locks', 'show-ref']),
      index: git(root, ['--no-optional-locks', 'ls-files', '--stage', '-z']),
      status: git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
      files: git(root, ['--no-optional-locks', 'ls-files', '-z']).split('\0').filter(Boolean)
        .map(path => [path, readFileSync(join(root, path)).toString('base64')]),
    });
    const before = snapshot(f.worktree);
    const repositoryBefore = snapshot(f.s.repo);
    const state = f.state();
    const evidence = f.evidence();
    const realRun = verificationRunner.runVerification;
    let report = '';
    let clone = '';
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      const record = realRun(args); // Real native child and normalization precede mutation.
      expect(record.results).toMatchObject({ format: 'junit-xml', total: 1 });
      clone = args.cwd;
      report = record.results!.path;
      expect(realpathSync(clone)).not.toBe(realpathSync(f.worktree));
      const doc = JSON.parse(readFileSync(report, 'utf8'));
      const entry = doc.results[0];
      expect(entry).toMatchObject({ file: testPath, test_id: expect.any(String) });
      if (kind === 'schema' || kind === 'format') doc[kind] = 'unexpected';
      if (kind === 'results') doc.results = {};
      if (kind === 'missing entry') doc.results = [null];
      if (kind === 'missing file') delete entry.file;
      if (kind === 'missing name') delete entry.full_name;
      if (kind === 'huge file') entry.file = 'p'.repeat(1025);
      if (kind === 'huge name') entry.full_name = 'n'.repeat(4097);
      if (kind === 'traversal') {
        entry.file = 'packages/errors/test/../outside.test.mjs';
        entry.test_id = canonicalTestId('junit-xml', entry.file, entry.full_name);
      }
      if (kind === 'absolute path') {
        entry.file = '/outside.test.mjs';
        entry.test_id = canonicalTestId('junit-xml', entry.file, entry.full_name);
      }
      if (kind === 'Windows absolute path' || kind === 'unsafe path') {
        entry.file = kind === 'Windows absolute path' ? 'C:/private/report-secret.test.mjs'
          : 'packages/errors/test/NUL.test.mjs';
        entry.test_id = canonicalTestId('junit-xml', entry.file, entry.full_name);
      }
      if (kind === 'unsafe Vitest suite' || kind === 'legitimate Vitest suite') {
        // Model the normalized entry for a Vitest suite that failed before collecting tests.
        // A safe <suite> identity remains diagnostic-only; unsafe files must still be refused.
        record.results!.format = doc.format = 'vitest-json';
        entry.file = kind === 'unsafe Vitest suite' ? 'packages/errors/test/../suite-secret.test.mjs' : testPath;
        entry.full_name = '<suite>';
        entry.status = 'failed';
        entry.message = 'private suite load failure report content';
        entry.test_id = canonicalTestId('vitest-json', entry.file, entry.full_name);
        record.exit_code = 1;
      }
      if (kind === 'id') entry.test_id = '0'.repeat(16);
      if (kind === 'todo status') entry.status = 'todo';
      if (kind === 'unknown status') entry.status = 'unknown';
      if (kind === 'empty') doc.results = [];
      if (kind === 'count') doc.results = Array.from({ length: 10001 }, () => ({ ...entry }));
      if (kind === 'aggregate') doc.results = Array.from({ length: 8 }, (_, i) => {
        const full_name = String(i) + 'n'.repeat(3000);
        return { ...entry, full_name, test_id: canonicalTestId('junit-xml', entry.file, full_name) };
      });
      const bytes = kind === 'json' ? '{invalid-json' : kind === 'null document' ? 'null' : JSON.stringify(doc) + (kind === 'hash' ? ' ' : '');
      writeFileSync(report, bytes);
      if (kind !== 'hash') record.results!.sha256 = createHash('sha256').update(bytes).digest('hex');
      return record;
    });
    let result: ReturnType<typeof f.probe>;
    try {
      result = f.probe();
      expect(runner).toHaveBeenCalledTimes(1);
    } finally { runner.mockRestore(); }
    expect(report).not.toBe(''); // A refusal before the mutation is a harness failure.
    expect(existsSync(report)).toBe(false);
    expect(existsSync(clone)).toBe(false);
    expect(snapshot(f.worktree)).toEqual(before);
    expect(snapshot(f.s.repo)).toEqual(repositoryBefore);
    expect(f.state()).toBe(state);
    expect(f.evidence()).toEqual(evidence);
    if (kind === 'legitimate Vitest suite') {
      expect(result!).toMatchObject({ exitCode: 1, diagnostic: { role: 'diagnostic-only', tests: [{
        id: canonicalTestId('vitest-json', testPath, '<suite>'), path: testPath,
        full_name: '<suite>', status: 'failed',
      }] } });
    } else {
      // Exact constant output excludes file/test names, report content and child diagnostics.
      expect(result!).toEqual({ exitCode: 2, output: `CHANNEL_PROBE_REPORT_INVALID:${stage}` });
      expect(result!).not.toHaveProperty('diagnostic');
      expect(Buffer.byteLength(JSON.stringify(result!))).toBeLessThan(128);
    }
    for (const key of ['output_sha256', 'outputSha256', 'test_ids', 'testIds', 'results', 'output_path',
      'criterion_evidence', 'accepted', 'acceptance', 'evidence']) {
      expect(result!).not.toHaveProperty(key);
    }
  });

  // A deterministic pnpm-shaped install: Git ignores node_modules, but
  // ls-files --others (without --exclude-standard) still enumerates the link.
  // These are declared setup outputs, never worker test edits.
  const ignoredDependencySetup = {
    commands: [['node', '-e', `
      const fs = require('node:fs');
      const path = require('node:path');
      const target = 'node_modules/.pnpm/read/node_modules/@changesets/read';
      const link = 'packages/cli/node_modules/@changesets/read';
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), '{"name":"@changesets/read"}');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(target), link, 'junction');
    `]],
    timeout_seconds: 30,
    required_paths: ['packages/cli/node_modules/@changesets/read/package.json'],
  };

  it.each([false, true])('probes declared ignored dependency links with non-ignored clone mutation=%s', async mutate => {
    const dependency = 'packages/cli/node_modules/@changesets/read';
    const mutation = 'packages/errors/src/suspicious.json';
    const f = await fixture({ baseFiles: { '.gitignore': '# fixture\n# dependencies\n\nnode_modules\n' },
      worktreeSetup: ignoredDependencySetup }, ['node', '-e', `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      assert.equal(fs.lstatSync(${JSON.stringify(dependency)}).isSymbolicLink(), true);
      assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(dependency + '/package.json')}, 'utf8')).name, '@changesets/read');
      if (${mutate}) fs.writeFileSync(${JSON.stringify(mutation)}, 'suspicious data');
      fs.writeFileSync(process.argv[1], '<testsuites><testsuite><testcase name="ignored dependency" file="packages/errors/test/errors.test.mjs"/></testsuite></testsuites>');
    `, '${REPORT}']);
    writeFileSync(f.test, ERRORS_RED);
    const snapshot = () => ({
      head: git(f.worktree, ['rev-parse', 'HEAD']), refs: git(f.s.repo, ['show-ref']),
      index: git(f.worktree, ['ls-files', '--stage']),
      status: git(f.worktree, ['status', '--porcelain=v1', '--untracked-files=all']),
      bytes: git(f.worktree, ['ls-files', '-z']).split('\0').filter(Boolean)
        .map(p => [p, readFileSync(join(f.worktree, p)).toString('base64')]),
    });
    const before = snapshot();
    const state = f.state();
    const evidence = f.evidence();
    let clone = '';
    const realGit = gitCommands.runGit;
    const commands = vi.spyOn(gitCommands, 'runGit').mockImplementation((cwd, argv, options) => {
      const result = realGit(cwd, argv, options);
      if (argv[0] === 'clone') {
        clone = argv.at(-1)!;
      }
      return result;
    });
    const realRun = verificationRunner.runVerification;
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      expect(realpathSync(args.cwd)).toBe(realpathSync(clone));
      expect(lstatSync(join(clone, dependency)).isSymbolicLink()).toBe(true);
      const target = relative(realpathSync(clone), realpathSync(join(clone, dependency)));
      expect(isAbsolute(target)).toBe(false);
      expect(target).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(git(clone, ['check-ignore', dependency]).replace(/\\/g, '/')).toBe(dependency);
      expect(git(clone, ['ls-files', '--others', '--exclude-standard', '--', dependency])).toBe('');
      return realRun(args);
    });
    let result: ReturnType<typeof f.probe>;
    let runnerCalls = 0;
    try { result = f.probe(); }
    finally { runnerCalls = runner.mock.calls.length; runner.mockRestore(); commands.mockRestore(); }
    // Check preservation and cleanup even on the expected pre-fix RED path.
    expect(clone).not.toBe('');
    expect(existsSync(dirname(clone))).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(f.state()).toBe(state);
    expect(f.evidence()).toEqual(evidence);
    if (mutate) {
      expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 2, output: expect.stringContaining('CHANNEL_PROBE_CLONE_MUTATED') });
      expect(result.output).toContain(mutation);
      expect(result).not.toHaveProperty('diagnostic');
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, diagnostic: { role: 'diagnostic-only', tests: [{
        id: canonicalTestId('junit-xml', 'packages/errors/test/errors.test.mjs', 'ignored dependency'),
        path: 'packages/errors/test/errors.test.mjs', full_name: 'ignored dependency', status: 'passed',
      }] } });
    }
    expect(runnerCalls).toBe(1);
  });

  it.each(['test-path junction', 'outside-node test edit'])('refuses %s before snapshot despite declared dependency setup', async kind => {
    const f = await fixture({ baseFiles: { '.gitignore': 'node_modules\n' }, worktreeSetup: ignoredDependencySetup });
    if (kind === 'test-path junction') {
      symlinkSync(join(f.worktree, 'packages/read/test'), join(dirname(f.test), 'linked'), 'junction');
    } else writeFileSync(join(f.worktree, 'packages/read/test/read.test.mjs'), 'throw new Error("unsafe");');
    const state = f.state();
    const evidence = f.evidence();
    const commands = vi.spyOn(gitCommands, 'runGit');
    const runner = vi.spyOn(verificationRunner, 'runVerification');
    try {
      const result = f.probe();
      expect(result).toMatchObject({ exitCode: 2, output: kind === 'test-path junction' ? 'CHANNEL_PROBE_SYMLINK' : 'CHANNEL_PROBE_FENCE' });
      expect(result).not.toHaveProperty('diagnostic');
      expect(commands.mock.calls.some(([, argv]) => argv[0] === 'clone' || argv.includes('--cached'))).toBe(false);
      expect(runner).not.toHaveBeenCalled();
      expect(f.state()).toBe(state);
      expect(f.evidence()).toEqual(evidence);
    } finally { commands.mockRestore(); runner.mockRestore(); }
  });

  // Functional isolation for a non-adversarial plugin. These commands intentionally
  // mutate their cwd; this does not promise confinement of hostile host processes.
  it('runs setup/build/test in a disposable independent clone and preserves the coding checkout', async () => {
    const product = 'packages/errors/src/index.mjs';
    const testPath = 'packages/errors/test/errors.test.mjs';
    const fixturePath = 'packages/errors/test/probe-fixture.json';
    const removedPath = 'packages/errors/test/removed-fixture.json';
    const stage = (name: string) => ['node', '-e', `
      const fs = require('node:fs');
      if (${JSON.stringify(name)} === 'setup') {
        const cp = require('node:child_process');
        const tracked = cp.execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
          .split('\\0').filter(Boolean).map(p => [p, fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : null]);
        fs.writeFileSync('snapshot.probe', JSON.stringify(tracked));
      }
      fs.appendFileSync(${JSON.stringify(product)}, '\\n// ${name} changed product');
      fs.writeFileSync('${name}.probe', process.cwd());
    `];
    const command = ['node', '-e', `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const path = require('node:path');
      const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8' }).trim();
      const cwd = fs.realpathSync(process.cwd());
      const observation = {
        cwd, common: fs.realpathSync(path.resolve(git('rev-parse', '--git-common-dir'))),
        tracked: JSON.parse(fs.readFileSync('snapshot.probe', 'utf8')),
        ownGit: fs.lstatSync('.git').isDirectory(), head: git('rev-parse', 'HEAD'),
        product: fs.readFileSync(${JSON.stringify(product)}, 'utf8'),
        test: fs.readFileSync(${JSON.stringify(testPath)}, 'utf8'),
        fixture: fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8'),
        removed: fs.existsSync(${JSON.stringify(removedPath)}),
        stages: ['setup', 'build'].map(s => fs.readFileSync(s + '.probe', 'utf8')),
      };
      fs.appendFileSync(${JSON.stringify(product)}, '\\n// test changed product');
      observation.written = fs.readFileSync(${JSON.stringify(product)}, 'utf8');
      console.log('CLONE_OBSERVATION=' + JSON.stringify(observation));
      fs.writeFileSync(process.argv[1], '<testsuites><testsuite tests="1"><testcase name="clone isolation" file="packages/errors/test/errors.test.mjs"/></testsuite></testsuites>');
    `, '${REPORT}'];
    const f = await fixture({ baseFiles: { [removedPath]: '{}\n' } }, command,
      { setup: [stage('setup')], build: [stage('build')] });
    writeFileSync(f.test, ERRORS_RED);
    writeFileSync(join(f.worktree, fixturePath), '{"exact":"fixture bytes"}\n');
    unlinkSync(join(f.worktree, removedPath));
    const snapshot = () => ({
      head: git(f.worktree, ['rev-parse', 'HEAD']),
      refs: git(f.s.repo, ['show-ref', '--heads']),
      index: git(f.worktree, ['ls-files', '--stage']),
      status: git(f.worktree, ['status', '--porcelain=v1', '--untracked-files=all']),
      tracked: git(f.worktree, ['ls-files', '-z']).split('\0').filter(Boolean).map(p =>
        [p, existsSync(join(f.worktree, p)) ? readFileSync(join(f.worktree, p)).toString('base64') : null]),
      fixture: readFileSync(join(f.worktree, fixturePath), 'utf8'),
    });
    const before = snapshot();
    const state = f.state();
    const evidence = f.evidence();
    const result = f.probe();
    // Commands can mutate only the disposable clone; a changed clone cannot supply a diagnostic report.
    expect(result).toMatchObject({ exitCode: 2, output: expect.stringContaining('CHANNEL_PROBE_CLONE_MUTATED') });
    expect(result).not.toHaveProperty('diagnostic');
    const line = result.output.split(/\r?\n/).find(line => line.startsWith('CLONE_OBSERVATION='));
    expect(line).toBeDefined();
    const seen = JSON.parse(line!.slice('CLONE_OBSERVATION='.length));
    expect(seen.ownGit).toBe(true);
    const originalCommon = realpathSync(resolve(f.worktree, git(f.worktree, ['rev-parse', '--git-common-dir'])));
    expect(seen.common.toLowerCase()).not.toBe(originalCommon.toLowerCase());
    expect(lstatSync(join(f.worktree, '.git')).isFile()).toBe(true);
    expect(seen.head).toBe(before.head);
    expect(seen.tracked).toEqual(before.tracked);
    expect(seen.cwd).not.toBe(realpathSync(f.worktree));
    expect(seen.product).toBe(BASE_FILES[product] + '\n// setup changed product\n// build changed product');
    expect(seen.written).toBe(seen.product + '\n// test changed product');
    expect(seen.test).toBe(ERRORS_RED);
    expect(seen.fixture).toBe(before.fixture);
    expect(seen.removed).toBe(false);
    expect(seen.stages.map((p: string) => resolve(p))).toEqual([seen.cwd, seen.cwd]);
    if (process.platform === 'win32') {
      expect(process.env.LOCALAPPDATA).toBeTruthy();
      const scratch = realpathSync(join(process.env.LOCALAPPDATA!, 'hermes', 'cache', 'scratch'));
      const below = relative(scratch, seen.cwd);
      expect(isAbsolute(below)).toBe(false);
      expect(below).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(below).not.toBe('');
      // Leave headroom below legacy MAX_PATH for package test/report paths.
      expect(seen.cwd.length).toBeLessThanOrEqual(180);
    }
    expect(existsSync(seen.cwd)).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(f.state()).toBe(state);
    expect(f.evidence()).toEqual(evidence);
  });

  it.each([
    ['packages/errors/test/fixtures/generated.json', true],
    ['packages/errors/.cache/result.json', true],
    ['packages/errors/reports/report.json', true],
    ['packages/errors/src/generated.json', false],
    ['packages/read/reports/report.json', false],
    ['packages/errors/test/generated.test.mjs', false],
    ['packages/errors/test/errors.test.mjs', false],
    ['packages/errors/src/index.mjs', false],
    ['node_modules/.vitest-cache-sibling/result.json', false],
    ['node_modules/.cache/result.json', false],
    ['node_modules/vitest/result.json', false],
    ['packages/errors/node_modules/.vitest-cache/result.json', false],
    ['node_modules/.vitest-cache/generated.test.mjs', false],
  ] as const)('bounds disposable clone writes at %s', async (path, allowed) => {
    const f = await fixture({}, ['node', '-e', `
      const fs = require('node:fs');
      fs.mkdirSync(require('node:path').dirname(${JSON.stringify(path)}), { recursive: true });
      fs.writeFileSync(${JSON.stringify(path)}, 'disposable data');
      fs.writeFileSync(process.argv[1], '<testsuites><testsuite><testcase name="scratch" file="packages/errors/test/errors.test.mjs"/></testsuite></testsuites>');
    `, '${REPORT}']);
    const before = readFileSync(f.test, 'utf8');
    const state = f.state();
    const evidence = f.evidence();
    const result = f.probe();
    if (allowed) expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, diagnostic: { role: 'diagnostic-only' } });
    else {
      expect(result).toMatchObject({ exitCode: 2, output: expect.stringContaining('CHANNEL_PROBE_CLONE_MUTATED') });
      const line = result.output.split('\n').find(line => line.startsWith('CLONE_DELTA='));
      expect(line).toBeDefined();
      const delta = JSON.parse(line!.slice('CLONE_DELTA='.length));
      expect(delta.paths).toContainEqual(expect.objectContaining({ path, disposable: false, after: expect.stringMatching(/^[a-f0-9]{64}$/) }));
      expect(line.includes('disposable data')).toBe(false);
      expect(result).not.toHaveProperty('diagnostic');
    }
    expect(readFileSync(f.test, 'utf8')).toBe(before);
    expect(f.state()).toBe(state);
    expect(f.evidence()).toEqual(evidence);
  });

  it.each([false, true])('bounds the four-file Vitest cache status delta with sibling write=%s', async siblingWrite => {
    const paths = ['CACHEDIR.TAG', '_metadata.json', 'a'.repeat(64), 'b'.repeat(64)]
      .map(name => 'node_modules/.vitest-cache/' + name);
    const f = await fixture({}, ['node', '-e', `
      const fs = require('node:fs');
      fs.mkdirSync('node_modules/.vitest-cache', { recursive: true });
      for (const path of ${JSON.stringify(paths)}) fs.writeFileSync(path, 'cache data');
      if (${siblingWrite}) fs.writeFileSync('node_modules/unsafe.json', 'unsafe data');
      fs.writeFileSync(process.argv[1], '<testsuites><testsuite><testcase name="cache" file="packages/errors/test/errors.test.mjs"/></testsuite></testsuites>');
    `, '${REPORT}']);
    const state = f.state();
    const evidence = f.evidence();
    const result = f.probe();
    if (siblingWrite) {
      expect(result).toMatchObject({ exitCode: 2, output: expect.stringContaining('CHANNEL_PROBE_CLONE_MUTATED') });
      expect(result).not.toHaveProperty('diagnostic');
    } else expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, diagnostic: { role: 'diagnostic-only' } });
    const line = result.output.split('\n').find(line => line.startsWith('CLONE_DELTA='));
    expect(line).toBeDefined();
    const delta = JSON.parse(line!.slice('CLONE_DELTA='.length));
    expect(delta.metadata.map((p: { path: string }) => p.path)).toEqual(['status']);
    expect(delta).toMatchObject({ count: siblingWrite ? 5 : 4, truncated: false });
    expect(delta.paths).toEqual([...paths, ...(siblingWrite ? ['node_modules/unsafe.json'] : [])].sort().map(path => ({ path, before: null,
      after: expect.stringMatching(/^[a-f0-9]{64}$/), disposable: paths.includes(path) })));
    for (const path of paths) expect(existsSync(join(f.worktree, path))).toBe(false);
    expect(f.state()).toBe(state);
    expect(f.evidence()).toEqual(evidence);
  });

  it('refuses tracked data in the clone-root Vitest cache', async () => {
    const path = 'node_modules/.vitest-cache/_metadata.json';
    const f = await fixture({ baseFiles: { [path]: 'tracked cache' } }, ['node', '-e', `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(path)}, 'changed cache');
      fs.writeFileSync(process.argv[1], '<testsuites><testsuite><testcase name="tracked cache" file="packages/errors/test/errors.test.mjs"/></testsuite></testsuites>');
    `, '${REPORT}']);
    expect(f.probe()).toMatchObject({ exitCode: 2, output: expect.stringContaining('CHANNEL_PROBE_CLONE_MUTATED') });
    expect(readFileSync(join(f.worktree, path), 'utf8')).toBe('tracked cache');
  });

  it.each(['head', 'ref', 'index', 'symlink', 'cache-symlink'] as const)('refuses clone %s mutation', async kind => {
    const f = await fixture({}, ['node', '-e', `
      const fs = require('node:fs');
      const git = (...args) => require('node:child_process').execFileSync('git', args);
      const kind = ${JSON.stringify(kind)};
      if (kind === 'head') git('symbolic-ref', 'HEAD', 'refs/heads/probe-moved');
      if (kind === 'ref') git('update-ref', 'refs/heads/probe-moved', 'HEAD');
      if (kind === 'index') git('update-index', '--assume-unchanged', 'packages/errors/src/index.mjs');
      if (kind === 'symlink') {
        fs.mkdirSync('packages/errors/reports', { recursive: true });
        fs.symlinkSync(require('node:path').resolve('packages/read'), 'packages/errors/reports/link', 'junction');
      }
      if (kind === 'cache-symlink') {
        fs.mkdirSync('node_modules', { recursive: true });
        fs.symlinkSync(require('node:path').resolve('packages/read'), 'node_modules/.vitest-cache', 'junction');
      }
      fs.writeFileSync(process.argv[1], '<testsuites><testsuite><testcase name="metadata" file="packages/errors/test/errors.test.mjs"/></testsuite></testsuites>');
    `, '${REPORT}']);
    const before = git(f.worktree, ['rev-parse', 'HEAD']);
    const result = f.probe();
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 2 });
    expect(result).not.toHaveProperty('diagnostic');
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it.skipIf(process.platform !== 'win32')('runs a bounded native Windows Vitest JSON canary in an independent probe clone', async () => {
    const testPath = 'packages/errors/test/errors.test.mjs';
    // Resolve against this project's installation, never PATH or the clone's
    // absent node_modules. Globals avoid bare package imports in the worker test.
    const node = realpathSync(process.execPath);
    const cli = realpathSync(resolve('node_modules/vitest/vitest.mjs'));
    expect(isAbsolute(node)).toBe(true);
    expect(node.toLowerCase()).toMatch(/node\.exe$/);
    expect(isAbsolute(cli)).toBe(true);
    const command = [node, cli, 'run', '--globals', testPath, '--reporter=json', '--outputFile=${REPORT}'];
    const f = await fixture({ baseFiles: {
      // Plain config needs no package resolution from the independent clone.
      // Vite's writable cache belongs to the controller's disposable temp root.
      'vitest.config.mjs': `export default {
        cacheDir: process.env.TMPDIR + '/vitest-cache',
        test: { include: ['${testPath}'], pool: 'forks', maxWorkers: 1, fileParallelism: false }
      };\n`,
    } }, command, { report: { format: 'vitest-json' } });
    const workerTest = `import { lstatSync } from 'node:fs';
import { GitError } from '../src/index.mjs';
it('native canary passes', () => {
  expect(lstatSync('.git').isDirectory()).toBe(true);
  expect(new GitError(7, 'canary').code).toBe(7);
});
it('native canary intentional assertion failure', () => { expect(new GitError(7, 'canary').code).toBe(8); });
`;
    const live = f.controller.codexClaimScope(ERRORS, f.claim.claimId, f.claim.capability, f.worktree)!;
    expect(live.nextGate).toBe('red');
    expect(live.allowedPaths).toContain('packages/errors/**');
    writeFileSync(f.test, workerTest); // Uncommitted, allowlisted test-only worker edit.
    const snapshot = () => ({
      head: git(f.worktree, ['rev-parse', 'HEAD']), refs: git(f.s.repo, ['show-ref', '--heads']),
      index: git(f.worktree, ['ls-files', '--stage']),
      status: git(f.worktree, ['status', '--porcelain=v1', '--untracked-files=all']),
      bytes: git(f.worktree, ['ls-files', '-z']).split('\0').filter(Boolean)
        .map(p => [p, readFileSync(join(f.worktree, p)).toString('base64')]),
    });
    const before = snapshot();
    const state = f.state();
    const evidence = f.evidence();
    const deadlineMs = 30_000;
    const observations: { cwd: string; common: string; ownGit: boolean; head: string; bytesSha256: string; report: string }[] = [];
    const realRunVerification = verificationRunner.runVerification;
    const run = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      // Inspect the real clone and original checkout before calling the real runner.
      expect(observations).toHaveLength(0);
      expect(snapshot()).toEqual(before);
      expect(readFileSync(join(args.cwd, testPath))).toEqual(Buffer.from(workerTest));
      const seen = {
        cwd: realpathSync(args.cwd),
        common: realpathSync(resolve(args.cwd, git(args.cwd, ['rev-parse', '--git-common-dir']))),
        ownGit: lstatSync(join(args.cwd, '.git')).isDirectory(),
        head: git(args.cwd, ['rev-parse', 'HEAD']),
        bytesSha256: createHash('sha256').update(readFileSync(join(args.cwd, testPath))).digest('hex'),
        report: '',
      };
      observations.push(seen);
      const record = realRunVerification(args);
      expect(record.results).toMatchObject({ format: 'vitest-json', total: 2, passed: 1, failed: 1 });
      seen.report = record.results!.path;
      expect(existsSync(seen.report)).toBe(true);
      expect(JSON.parse(readFileSync(seen.report, 'utf8'))).toMatchObject({
        schema: 'mycelink-test-results/1', format: 'vitest-json', results: expect.any(Array),
      });
      return record;
    });
    const started = Date.now();
    let result: ReturnType<typeof f.probe>;
    try {
      result = f.probe(deadlineMs);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { run.mockRestore(); }
    // Include real child output on failure: import/runtime failures must not be
    // mistaken for the intentional assertion failure or a successful canary.
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 1, diagnostic: { role: 'diagnostic-only', tests: [
      { id: canonicalTestId('vitest-json', testPath, 'native canary passes'), path: testPath,
        full_name: 'native canary passes', status: 'passed' },
      { id: canonicalTestId('vitest-json', testPath, 'native canary intentional assertion failure'), path: testPath,
        full_name: 'native canary intentional assertion failure', status: 'failed' },
    ] } });
    expect(Date.now() - started).toBeLessThan(deadlineMs + 8_000);
    expect(observations).toHaveLength(1);
    const seen = observations[0]!;
    expect(seen.ownGit).toBe(true);
    expect(seen.cwd.toLowerCase()).not.toBe(realpathSync(f.worktree).toLowerCase());
    expect(seen.common.toLowerCase()).not.toBe(realpathSync(resolve(f.worktree, git(f.worktree, ['rev-parse', '--git-common-dir']))).toLowerCase());
    expect(seen.head).toBe(before.head);
    expect(seen.bytesSha256).toBe(createHash('sha256').update(workerTest).digest('hex'));
    expect(isAbsolute(seen.report)).toBe(true);
    const reportRelative = relative(dirname(seen.cwd), seen.report);
    expect(isAbsolute(reportRelative)).toBe(false);
    expect(reportRelative).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(existsSync(seen.report)).toBe(false);
    expect(existsSync(seen.cwd)).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(f.state()).toBe(state);
    expect(f.evidence()).toEqual(evidence);
    for (const key of ['output_sha256', 'outputSha256', 'test_ids', 'testIds', 'results', 'output_path', 'criterion_evidence']) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it('uses the host deadline for the complete module run', async () => {
    const f = await fixture({}, ['node', '-e', 'setTimeout(() => {}, 10000)', '${REPORT}']);
    const before = f.state();
    const start = Date.now();
    expect(f.probe(400)).toMatchObject({ exitCode: 2, output: expect.stringMatching(/TIMEOUT/) });
    expect(Date.now() - start).toBeLessThan(8_000);
    expect(f.state()).toBe(before);
  });

  // Only the fixture validator is substituted: the module child still really
  // runs. This covers TOCTOU without mutating a frozen external fixture.
  it.each(['before', 'after'])('rechecks the approved fixture %s execution and refuses SHA mismatch', async (when) => {
    const f = await fixture();
    const graph = YAML.parse(readFileSync(join(f.s.featureDir, 'PORTFOLIO-GRAPH.yaml'), 'utf8'));
    graph.nodes.find((n: { id: string }) => n.id === ERRORS).readonly_fixture = {
      manifest: '../probe-fixture.json', baseline: '../probe-baseline', sha256: 'a'.repeat(64),
    };
    initialisedWithGraph(f.s, graph);
    const check = vi.spyOn(contextPack, 'verifyReadonlyFixture').mockImplementation((_root, declaration) => declaration);
    if (when === 'before') check.mockImplementationOnce(() => { throw new Error('FIXTURE_INVALID: manifest hash mismatch'); });
    else check.mockImplementationOnce((_root, declaration) => declaration)
      .mockImplementationOnce(() => { throw new Error('FIXTURE_INVALID: manifest hash mismatch'); });
    try {
      writeFileSync(f.test, ERRORS_RED);
      const before = f.state();
      expect(f.probe()).toMatchObject({ exitCode: 2, output: expect.stringContaining('FIXTURE_INVALID') });
      expect(check).toHaveBeenCalledTimes(when === 'before' ? 1 : 2);
      expect(f.state()).toBe(before);
    } finally { check.mockRestore(); }
  });
});


describe('orchestrated Codex claims without a bound module verifier', () => {
  it('omits probe guidance, refuses probe requests, and preserves direct test commit and gate dispatch', async () => {
    const s = await createShop(); // Legacy argv verifier, deliberately no module binding.
    const adapter = new CodexCliAdapter({ executable: process.execPath,
      prefixArgs: [resolve('tests/fake-codex/codex.mjs')] });
    const scenario = join(s.root, 'no-probe-scenario.json');
    writeFileSync(scenario, JSON.stringify({ omit_result: true }));
    const replies: ChannelResponse[] = [];
    let prompt = '';
    let base = '';
    let committed = '';
    let redRecord: unknown;
    const host = vi.spyOn(hostGate, 'executeHostClaimGate'); // real CLI and verifier
    const spawn = adapter.spawn.bind(adapter);
    const intercepted = vi.spyOn(adapter, 'spawn').mockImplementation(request => {
      const channel = request.claimChannel!; // Supplied by runNode, not constructed by the test.
      const identity = { claimId: request.claimId, featureId: SHOP_FEATURE, nodeId: ERRORS };
      base = git(request.cwd, ['rev-parse', 'HEAD']);
      writeFileSync(join(request.cwd, 'packages/errors/test/errors.test.mjs'), ERRORS_RED);
      replies.push(channel.handle({ ...identity, sequence: 1, operation: 'probe' }));
      replies.push(channel.handle({ ...identity, sequence: 2, operation: 'commit',
        message: 'test: legacy direct RED tests', paths: ['packages/errors/test/errors.test.mjs'] }));
      committed = git(request.cwd, ['rev-parse', 'HEAD']);
      replies.push(channel.handle({ ...identity, sequence: 3, operation: 'gate', gate: 'red' }));
      redRecord = shopState(s).nodes[ERRORS].evidence.red;
      request.env = { ...request.env, FAKE_CODEX_SCENARIO: scenario };
      return spawn(request);
    });
    try {
      const controller = new Orchestrator({ controlRoot: s.control, featureId: SHOP_FEATURE, adapter });
      await controller.runNode(ERRORS);
      expect(intercepted).toHaveBeenCalledTimes(1);
      const request = intercepted.mock.calls[0]![0];
      prompt = readFileSync(join(request.cwd, 'prompt-captured.txt'), 'utf8');
      // Soft assertions expose both integration regressions in a single RED run.
      expect.soft(prompt).not.toMatch(/client\.mjs probe/);
      expect.soft(prompt).not.toContain('Up to 3 probes before RED');
      expect.soft(replies[0]).toMatchObject({ ok: false, code: 'CHANNEL_PROBE_UNAVAILABLE' });
      expect.soft(replies[1]).toMatchObject({ ok: true, commitSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
      expect.soft(committed).not.toBe(base);
      expect(host).toHaveBeenCalledTimes(1);
      expect(host.mock.calls[0]![0]).toMatchObject({ gate: 'red', cwd: request.cwd });
      expect(redRecord).toMatchObject({ kind: 'red', exit_code: 1 });
      // Legacy argv verifiers have no structured test report. Preserve the
      // host's existing verdict/receipt requirements rather than changing them.
      const result = host.mock.results[0]!.value as ReturnType<typeof executeHostClaimGate>;
      expect(replies[2]).toMatchObject(result.exitCode === 0
        ? { ok: true, exitCode: 0, output: result.output }
        : { ok: false, code: 'CHANNEL_GATE_FAILED', exitCode: result.exitCode, output: result.output });
    } finally { intercepted.mockRestore(); host.mockRestore(); }
  });
});


// Proposed transient runner seam. No caller-selected persistence path; bytes
// exist only during the callback, before the runner removes its raw scratch.
// These are new forensic contracts, not an explanation of historical c69.
interface ProbeRawSnapshot {
  test_command_output?: string | null;
  bytes: Buffer | null;
  sha256: string | null;
  output: string;
  exit_code: number;
  steps: { exit_code: number; timed_out: boolean }[];
  normalized_count: number;
}
type ProbeRunnerArgs = verificationRunner.RunVerificationArgs & {
  onRawReport?: (snapshot: ProbeRawSnapshot) => void;
};

describe('empty-identity probe forensic sidecars', () => {
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const privateMessage = 'token=probe-private-token C:/private/customer/project.test.ts /private/customer.env';
  const rawFor = (kind: string) => JSON.stringify({ testResults: [], numTotalTestSuites: kind === 'no-tests' ? 0 : 3,
    numTotalTests: 0, numFailedTestSuites: kind === 'no-tests' ? 0 : 2,
    errors: [{ type: kind === 'syntax' ? 'SyntaxError' : 'Error',
      code: kind === 'module' ? 'ERR_MODULE_NOT_FOUND' : 'PRIVATE_CODE',
      message: (kind === 'no-tests' ? 'No test files found ' : '') + privateMessage }],
    private_field: 'raw-only-private-value', name: 'private-test-name' });
  async function emptyFixture(kind = 'syntax') {
    const raw = kind === 'malformed' ? '{' + privateMessage : rawFor(kind);
    const f = await fixture({}, [process.execPath, '-e', `
      const fs = require('node:fs');
      ${kind === 'missing' ? '' : `fs.writeFileSync(process.argv[1], ${JSON.stringify(raw)});`}
      console.error(${JSON.stringify(privateMessage)});
      process.exit(1);
    `, '${REPORT}'], { report: { format: 'vitest-json' },
      setup: [[process.execPath, '-e', 'process.exit(0)']], build: [] });
    const dir = join(f.s.control, '.mycelink', 'probe-diagnostics', SHOP_FEATURE, ERRORS, f.claim.claimId);
    const files = () => existsSync(dir) ? readdirSync(dir).sort() : [];
    return { ...f, raw, dir, files };
  }
  function noHandles(result: unknown) {
    for (const key of ['diagnostic', 'criterion_evidence', 'results', 'output_path', 'output_sha256',
      'outputSha256', 'test_ids', 'testIds', 'accepted', 'acceptance', 'evidence']) expect(result).not.toHaveProperty(key);
  }
  it.each(['syntax', 'module', 'no-tests'])('persists only bounded immutable metadata for top-level %s with no identities', async kind => {
    const f = await emptyFixture(kind);
    const state = f.state();
    const ledger = f.evidence();
    const live = f.controller.codexClaimScope(ERRORS, f.claim.claimId, f.claim.capability, f.worktree)!;
    const realRun = verificationRunner.runVerification;
    let clone = '';
    let snapshot: ProbeRawSnapshot | undefined;
    let calls = 0;
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      clone = args.cwd;
      const hook = (args as ProbeRunnerArgs).onRawReport;
      return realRun({ ...args, onRawReport: (value: ProbeRawSnapshot) => {
        calls++;
        snapshot = value;
        hook?.(value);
      } } as ProbeRunnerArgs);
    });
    let first: ReturnType<typeof f.probe>;
    let second: ReturnType<typeof f.probe>;
    let kept: Buffer | undefined;
    let firstName = '';
    try {
      first = f.probe();
      expect.soft(calls).toBe(1);
      expect.soft(first.output).toMatch(/^CHANNEL_PROBE_REPORT_INVALID:IDENTITY:EMPTY DIAGNOSTIC_ID=[a-f0-9]{64}$/);
      const names = f.files();
      expect(names).toHaveLength(1); // Native RED now: no sidecar exists.
      firstName = names[0]!;
      const target = join(f.dir, firstName);
      kept = readFileSync(target);
      expect(lstatSync(target).isFile()).toBe(true);
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(kept.byteLength).toBeLessThanOrEqual(8192);
      const id = digest(kept);
      expect(first.output).toContain(`DIAGNOSTIC_ID=${id}`);
      const doc = JSON.parse(kept.toString('utf8'));
      expect(Object.keys(doc).sort()).toEqual(['claim', 'errors', 'plan_sha256', 'raw', 'runner', 'schema', 'stage', 'timestamp'].sort());
      expect(live.dispatchId).toBeUndefined(); // fixture claims in adapter mode without dispatching
      expect(doc).toMatchObject({ schema: 'mycelink-probe-diagnostic/1', stage: 'IDENTITY:EMPTY',
        claim: { id: f.claim.claimId, generation: live.generation, dispatch_id: null },
        runner: { exit_code: 1, step_exit_codes: [0], normalized_count: 0 },
        raw: { status: 'valid', suite_count: kind === 'no-tests' ? 0 : 3, test_count: 0, failed_suite_count: kind === 'no-tests' ? 0 : 2,
          report: { sha256: digest(redactText(f.raw)), bytes: Buffer.byteLength(redactText(f.raw)) },
          output: { sha256: digest(snapshot!.output), bytes: Buffer.byteLength(snapshot!.output) },
          messages: [{ sha256: digest(redactText((kind === 'no-tests' ? 'No test files found ' : '') + privateMessage)),
            bytes: Buffer.byteLength(redactText((kind === 'no-tests' ? 'No test files found ' : '') + privateMessage)) }] },
        errors: kind === 'syntax' ? [{ type: 'SyntaxError' }] : kind === 'module' ? [{ code: 'ERR_MODULE_NOT_FOUND' }] : [{ code: 'NO_TEST_FILES' }],
      });
      if (kind === 'no-tests') expect(doc.errors).toEqual([{ code: 'NO_TEST_FILES' }]);
      expect(Object.keys(doc.claim).sort()).toEqual(['id', 'generation', 'dispatch_id'].sort());
      expect(Object.keys(doc.runner).sort()).toEqual(['exit_code', 'step_exit_codes', 'normalized_count'].sort());
      expect(doc.plan_sha256).toBe(shopState(f.s).nodes[ERRORS].claim!.verification!.plan_sha256);
      expect(Number.isFinite(Date.parse(doc.timestamp))).toBe(true);
      expect(Object.keys(doc.raw).sort()).toEqual(['status', 'suite_count', 'test_count', 'failed_suite_count', 'report', 'output', 'messages'].sort());
      for (const value of [doc.raw.report, doc.raw.output, ...doc.raw.messages]) {
        expect(Object.keys(value).sort()).toEqual(['bytes', 'sha256']);
        expect(value.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Number.isSafeInteger(value.bytes)).toBe(true);
      }
      for (const forbidden of [privateMessage, 'probe-private-token', 'C:/private', '/private/customer',
        'raw-only-private-value', 'private-test-name', 'PRIVATE_CODE', f.worktree, clone]) {
        expect(kept.toString('utf8').includes(forbidden)).toBe(false);
        expect(first.output.includes(forbidden)).toBe(false);
      }
      expect(git(f.s.control, ['check-ignore', target])).not.toBe('');
      second = f.probe();
      noHandles(second);
      expect(readFileSync(target)).toEqual(kept);
      const secondId = second.output.match(/DIAGNOSTIC_ID=([a-f0-9]{64})$/)?.[1];
      expect(secondId).toBeDefined();
      expect(f.files().some(name => digest(readFileSync(join(f.dir, name))) === secondId)).toBe(true);
    } finally { runner.mockRestore(); }
    noHandles(first!);
    expect(existsSync(dirname(clone))).toBe(false);
    expect(f.state()).toBe(state);
    expect(f.evidence()).toEqual(ledger);
    expect(f.state().includes(firstName)).toBe(false);
    expect(f.state().includes(digest(kept!))).toBe(false);
  });

  it.each(['malformed', 'missing'])('records static safe %s raw status without retaining invalid bytes', async kind => {
    const f = await emptyFixture(kind);
    const before = f.state();
    const result = f.probe();
    expect(result.output).toMatch(/^CHANNEL_PROBE_REPORT_INVALID:IDENTITY:EMPTY DIAGNOSTIC_ID=[a-f0-9]{64}$/);
    expect(f.files()).toHaveLength(1);
    const bytes = readFileSync(join(f.dir, f.files()[0]!));
    expect(bytes.byteLength).toBeLessThanOrEqual(8192);
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(doc.schema).toBe('mycelink-probe-diagnostic/1');
    expect(doc.stage).toBe('IDENTITY:EMPTY');
    expect(result.output).toContain(`DIAGNOSTIC_ID=${digest(bytes)}`);
    expect(doc.raw.status).toBe(kind);
    expect(doc.raw.messages).toEqual([]);
    expect(doc.raw.suite_count).toBe(0);
    expect(doc.raw.test_count).toBe(0);
    expect(doc.raw.failed_suite_count).toBe(0);
    expect(doc.errors).toEqual([]);
    expect(doc.runner.normalized_count).toBe(0);
    expect(bytes.toString().includes(privateMessage)).toBe(false);
    expect(result.output.includes(privateMessage)).toBe(false);
    noHandles(result);
    expect(f.state()).toBe(before);
  });

  it.each(['throws', 'wrong hash', 'oversize'])('fails closed on raw callback %s without sidecar or unsafe output', async kind => {
    const f = await emptyFixture();
    const before = f.state();
    const realRun = verificationRunner.runVerification;
    let clone = '';
    let calls = 0;
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      clone = args.cwd;
      const hook = (args as ProbeRunnerArgs).onRawReport;
      return realRun({ ...args, onRawReport: (value: ProbeRawSnapshot) => {
        calls++;
        if (kind === 'throws') throw new Error(privateMessage);
        const bytes = kind === 'oversize' ? Buffer.alloc(64 * 1024 * 1024 + 1, 120) : value.bytes;
        hook?.({ ...value, bytes, sha256: kind === 'wrong hash' ? '0'.repeat(64) : digest(bytes!) });
      } } as ProbeRunnerArgs);
    });
    let result: ReturnType<typeof f.probe>;
    try { result = f.probe(); } finally { runner.mockRestore(); }
    expect.soft(calls).toBe(1);
    expect(result!).toEqual({ exitCode: 2, output: 'CHANNEL_PROBE_REPORT_INVALID:RAW' });
    expect(f.files()).toEqual([]);
    expect(existsSync(dirname(clone))).toBe(false);
    expect(f.state()).toBe(before);
  });

  it.each(['cancelled', 'generation', 'dispatch'] as const)('publishes no sidecar after %s changes during the real run', async kind => {
    const f = await emptyFixture('missing');
    const scope = f.controller.codexClaimScope.bind(f.controller);
    let changed = false;
    const current = vi.spyOn(f.controller, 'codexClaimScope').mockImplementation((...args) => {
      const live = scope(...args);
      if (!changed || !live) return live;
      return kind === 'cancelled' ? null : { ...live,
        ...(kind === 'generation' ? { generation: (live.generation ?? 0) + 1 } : { dispatchId: 'different-dispatch' }) };
    });
    const realRun = verificationRunner.runVerification;
    let clone = '';
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      clone = args.cwd;
      const record = realRun(args);
      changed = true;
      return record;
    });
    const before = f.state();
    const ledger = f.evidence();
    try {
      expect(f.probe()).toEqual({ exitCode: 2, output: 'CHANNEL_CLAIM_STALE' });
      expect(f.files()).toEqual([]);
      expect(existsSync(dirname(clone))).toBe(false);
      expect(f.state()).toBe(before);
      expect(f.evidence()).toEqual(ledger);
    } finally { runner.mockRestore(); current.mockRestore(); }
  });
});


// Controlled launch failures only; these do not diagnose historical probes.
// Stable extension: test_command contains a static code, last_error, and at most
// twelve last nonempty redacted-line hashes with byte lengths. An optional
// excerpt uses only closed static templates. last_error hashes the final
// nonblank test-output line after redactText, capped to its last 1024 bytes.
describe('missing-report isolated test-command classification', () => {
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const poison = 'token=unregistered-canary-secret C:\\private\\customer\\secret.ts /private/customer/secret.env person@private.invalid "quoted-untrusted-value" ' + 'zQ7'.repeat(1500);
  const cases = [
    ['cjs module', "Error: Cannot find module 'untrusted'", 'MODULE_NOT_FOUND'],
    ['esm module', "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'untrusted'", 'ERR_MODULE_NOT_FOUND'],
    ['missing file', 'Error: ENOENT: no such file or directory, open untrusted', 'ENOENT'],
    ['permission', 'Error: EPERM: operation not permitted, open untrusted', 'EPERM'],
    ['native loader', 'Error [ERR_DLOPEN_FAILED]: untrusted', 'ERR_DLOPEN_FAILED'],
    ['native binding', 'Error: Could not locate the bindings file. Tried:', 'NATIVE_BINDING'],
    ['syntax', 'SyntaxError: Unexpected token untrusted', 'SYNTAX_ERROR'],
    ['no tests', 'No test files found, exiting with code 1', 'NO_TEST_FILES'],
    ['unknown code', "Error: unclassified\n  code: 'PRIVATE_ARBITRARY_CODE'", 'UNKNOWN'],
    ['standalone code', "  code: 'MODULE_NOT_FOUND'", 'MODULE_NOT_FOUND'],
    ...(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ENOENT', 'EACCES', 'EPERM', 'ERR_DLOPEN_FAILED'] as const)
      .flatMap(code => [
        [`allowlisted standalone ${code}`, `  code: '${code}',`, code],
        [`ANSI standalone ${code}`, `\x1b[31m  code: '${code}'\x1b[0m`, code],
      ] as const),
    ['package prefix', "Error: Cannot find package 'untrusted'", 'ERR_MODULE_NOT_FOUND'],
    ['access prefix', 'Error: EACCES: permission denied, open untrusted', 'EACCES'],
    ['forged in message', "Error: arbitrary message code: 'MODULE_NOT_FOUND',", 'UNKNOWN'],
    ['quoted path code', '"C:/private/code: \'MODULE_NOT_FOUND\'"', 'UNKNOWN'],
    ['quoted test name code', 'test "code: \'ERR_MODULE_NOT_FOUND\',"', 'UNKNOWN'],
    ['unsupported standalone code', "  code: 'ERR_UNKNOWN_PRIVATE',", 'UNKNOWN'],
    ['token suffix', "  code: 'MODULE_NOT_FOUND_EXTRA',", 'UNKNOWN'],
    ['code trailing message', "  code: 'MODULE_NOT_FOUND', arbitrary", 'UNKNOWN'],
    ['double quoted code', '  code: "MODULE_NOT_FOUND",', 'UNKNOWN'],
    ['unanchored syntax', 'test name mentions SyntaxError: arbitrary', 'UNKNOWN'],
    ['unanchored module', 'test name mentions Error: Cannot find module arbitrary', 'UNKNOWN'],
    ['unanchored no tests', 'test name mentions No test files found, exiting with code 1', 'UNKNOWN'],
  ] as const;
  const tailCases = [
    ['native registered missing entry', '', 'MODULE_NOT_FOUND'],
    ['controlled CJS shape', "Error: Cannot find module 'untrusted'\n" +
      Array.from({ length: 7 }, (_, i) => `    at node:internal/modules/cjs/loader:${i + 1}:1`).join('\n') +
      "\n  code: 'MODULE_NOT_FOUND',\n}\n\nNode.js v24.14.1\n", 'MODULE_NOT_FOUND'],
    ['fatal banner only', 'Node.js v24.14.1\n\n', 'NODE_FATAL_UNKNOWN'],
    ['ANSI fatal banner', '\x1b[31mNode.js v24.14.1\x1b[0m\n', 'NODE_FATAL_UNKNOWN'],
    ['fatal banner with CRLF', 'Node.js v24.14.1\r\n\r\n', 'NODE_FATAL_UNKNOWN'],
    ['banner followed by message', 'Node.js v24.14.1\nprivate trailer', 'UNKNOWN'],
    ['banner mention', 'Error: mentions Node.js v24.14.1', 'UNKNOWN'],
    ['quoted banner', '"Node.js v24.14.1"', 'UNKNOWN'],
    ['banner prefix', 'test Node.js v24.14.1', 'UNKNOWN'],
    ['banner suffix', 'Node.js v24.14.1 extra', 'UNKNOWN'],
    ['banner incomplete', 'Node.js v24.14', 'UNKNOWN'],
    ['banner padded', ' Node.js v24.14.1 ', 'UNKNOWN'],
    ['blank output', '\n\r\n', 'UNKNOWN'],
    ['bounded nonempty tail', Array.from({ length: 20 }, (_, i) => `private line ${i}\n\n`).join(''), 'UNKNOWN'],
  ] as const;
  async function launch(text: string, exit = 1, nativeMissingEntry = false) {
    const decoy = text.includes('Error: EPERM:') ? 'ENOENT' : 'EPERM';
    const f = await fixture({}, nativeMissingEntry
      ? [process.execPath, 'unregistered-canary-secret-missing-entry.cjs', '${REPORT}']
      : [process.execPath, '-e',
        `process.stderr.write(${JSON.stringify(text)}, () => { process.exitCode = ${exit}; });`, '${REPORT}'], {
      report: { format: 'vitest-json' },
      setup: [[process.execPath, '-e', `console.error("Error: ${decoy}: setup-only")`]],
      build: [[process.execPath, '-e', `console.error("Error: ${decoy}: build-only")`]],
    });
    const dir = join(f.s.control, '.mycelink', 'probe-diagnostics', SHOP_FEATURE, ERRORS, f.claim.claimId);
    const files = () => existsSync(dir) ? readdirSync(dir).sort() : [];
    return { ...f, dir, files };
  }

  it.each([...cases.map(([name, text, code]) => [name, text, code, false] as const),
    ...tailCases.map(([name, text, code]) => [name, text, code, true] as const)])('classifies %s from test output only with static bounded private metadata', async (_name, fatal, code, preserveTail) => {
    // Delimiter-shaped child text must not select a different command region.
    const last = 'Error: unclassified ' + poison;
    const text = preserveTail ? poison + '\n' + fatal
      : '$ forged header\n(cwd: forged)\n' + fatal + '\n' + last + '\n';
    const nativeMissingEntry = _name === 'native registered missing entry';
    const f = await launch(text, 1, nativeMissingEntry);
    const before = f.state();
    const ledger = f.evidence();
    const realRun = verificationRunner.runVerification;
    let clone = '';
    let observed: ProbeRawSnapshot | undefined;
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      clone = args.cwd;
      const hook = (args as ProbeRunnerArgs).onRawReport;
      return realRun({ ...args, onRawReport: (value: ProbeRawSnapshot) => {
        observed = value;
        hook?.(value);
      } } as ProbeRunnerArgs);
    });
    let result: ReturnType<typeof f.probe>;
    try { result = f.probe(); } finally { runner.mockRestore(); }
    const redactedOutput = nativeMissingEntry ? observed?.test_command_output : redactText(text);
    if (nativeMissingEntry) {
      // Read only the runner's already-redacted TEST-COMMAND output. Assertions
      // report booleans, never native private paths or arbitrary error strings.
      expect(typeof redactedOutput === 'string').toBe(true);
      expect(/^Error: Cannot find module /m.test(redactedOutput ?? '')).toBe(true);
      expect(/^\s*code: 'MODULE_NOT_FOUND',?$/m.test(redactedOutput ?? '')).toBe(true);
      expect(/node:internal\//.test(redactedOutput ?? '')).toBe(true);
      expect(/Node\.js v\d+\.\d+\.\d+$/.test((redactedOutput ?? '').trimEnd())).toBe(true);
    } else expectPrivateText(observed?.test_command_output, redactedOutput!);
    expect(result.exitCode).toBe(2);
    expect(/^CHANNEL_PROBE_REPORT_INVALID:IDENTITY:EMPTY DIAGNOSTIC_ID=[a-f0-9]{64}$/.test(result.output)).toBe(true);
    expect(f.files()).toHaveLength(1);
    const target = join(f.dir, f.files()[0]!);
    const bytes = readFileSync(target);
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(bytes.byteLength).toBeLessThanOrEqual(8192);
    expect(Object.keys(doc).sort()).toEqual(['schema', 'stage', 'claim', 'timestamp', 'plan_sha256', 'raw', 'runner', 'errors', 'test_command'].sort());
    const nonempty = (redactedOutput ?? '').split(/\r?\n/).filter(line => line.trim() !== '');
    const bounded = Buffer.from(nonempty.at(-1) ?? '').subarray(-1024);
    const lines = nonempty.slice(-12).map(line => ({ sha256: hash(line), bytes: Buffer.byteLength(line) }));
    const { sanitized_excerpt: _excerpt, sanitized_tail: _tail, ...fingerprints } = doc.test_command;
    expectPrivateText(JSON.stringify(fingerprints), JSON.stringify({ code,
      last_error: { sha256: hash(bounded), bytes: bounded.byteLength }, lines }));
    expect(Array.isArray(doc.test_command?.lines)).toBe(true);
    expect(doc.test_command?.lines?.length ?? Infinity).toBeLessThanOrEqual(12);
    expect(doc.stage).toBe('IDENTITY:EMPTY');
    const live = f.controller.codexClaimScope(ERRORS, f.claim.claimId, f.claim.capability, f.worktree)!;
    expectPrivateText(JSON.stringify(doc.claim), JSON.stringify({ id: f.claim.claimId,
      generation: live.generation, dispatch_id: live.dispatchId ?? null }));
    expect(Buffer.byteLength(JSON.stringify(fingerprints))).toBeLessThanOrEqual(2048);
    expect(Object.keys(doc.raw).sort()).toEqual(['status', 'suite_count', 'test_count', 'failed_suite_count', 'output', 'messages'].sort());
    expect(doc.raw.status).toBe('missing');
    expectPrivateText(JSON.stringify(doc.raw.messages), '[]');
    expectPrivateText(JSON.stringify(doc.errors), '[]');
    expect(doc.runner).toEqual({ exit_code: 1, step_exit_codes: [0, 0], normalized_count: 0 });
    expect(result.output.includes(`DIAGNOSTIC_ID=${hash(bytes)}`)).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    const first = Buffer.from(bytes);
    for (const secret of ['unregistered-canary-secret', 'C:\\private', '/private/customer', 'person@private.invalid',
      'quoted-untrusted-value', 'zQ7'.repeat(100), 'PRIVATE_ARBITRARY_CODE', 'setup-only', 'build-only', f.worktree, clone]) {
      expect(bytes.toString('utf8').includes(secret)).toBe(false);
      expect(result.output.includes(secret)).toBe(false);
    }
    expect(f.probe().exitCode).toBe(2);
    expectPrivateText(readFileSync(target, 'utf8'), first.toString('utf8')); // immutable readback
    expect(existsSync(dirname(clone))).toBe(false);
    expect(f.state()).toBe(before);
    expect(f.evidence()).toEqual(ledger);
    for (const key of ['diagnostic', 'results', 'criterion_evidence', 'output_path']) expect(result).not.toHaveProperty(key);
  });

  // This exact finite vocabulary is the entire permitted excerpt surface. No
  // dynamic message, path, function, code, test name, or environment name survives.
  const excerptVocabulary = new Set([
    'Error [ERR_MODULE_NOT_FOUND]: <redacted>',
    'TypeError: <redacted>',
    'at node:internal/<redacted>',
    'UNKNOWN',
  ]);
  const excerptCanaries = [
    'token=unregistered-canary-secret', 'unregistered-canary-secret',
    'amber orbit velvet', 'amber', 'orbit', 'velvet',
    '"quoted private path"', '`backtick private content`',
    'C:\\private\\secret.ts', '/mnt/c/private/secret.ts', '/private/secret.env',
    'person@private.invalid', 'arbitrary raw message', 'private synthetic test name',
    'PRIVATE_SYNTHETIC_ENV_KEY', 'setup-only', 'build-only',
  ];
  const excerptPoison = excerptCanaries.slice(0, -2).join(' ') + '\x1b[31m\x07\x00\x1b[0m';

  it.each(['module', 'type', 'bounded'] as const)('keeps a useful closed static %s excerpt private, bounded and immutable', async kind => {
    const marker = kind === 'type' ? 'TypeError: <redacted>' : 'Error [ERR_MODULE_NOT_FOUND]: <redacted>';
    const error = kind === 'type' ? 'TypeError: ' : 'Error [ERR_MODULE_NOT_FOUND]: ';
    const text = '\x1b[31m' + error + excerptPoison + '\x1b[0m\n' +
      Array.from({ length: kind === 'bounded' ? 30 : 2 }, () =>
        '    at node:internal/modules/esm/resolve:123:45').join('\n') +
      '\n    at privateFunction (C:\\private\\secret.ts:1:2)\n' +
      '    at privateFunction (/mnt/c/private/secret.ts:1:2)\n' +
      '    at privateFunction (/private/secret.env:1:2)\n' +
      'arbitrary raw message\nprivate synthetic test name\nPRIVATE_SYNTHETIC_ENV_KEY=amber orbit velvet\n';
    const f = await launch(text);
    const before = f.state();
    const ledger = f.evidence();
    const response = f.probe();
    expect(response.exitCode).toBe(2);
    expect(/^CHANNEL_PROBE_REPORT_INVALID:IDENTITY:EMPTY DIAGNOSTIC_ID=[a-f0-9]{64}$/.test(response.output)).toBe(true);
    const names = f.files();
    expect(names.length === 1).toBe(true);
    const target = join(f.dir, names[0]!);
    const bytes = readFileSync(target);
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(doc.raw.status === 'missing' && doc.stage === 'IDENTITY:EMPTY' && doc.runner.exit_code === 1).toBe(true);
    const excerpt: unknown = doc.test_command?.sanitized_excerpt;
    // Missing feature is RED here; avoid dereferencing it into a harness error.
    expect.soft(typeof excerpt === 'string').toBe(true);
    if (typeof excerpt === 'string') {
      const lines = excerpt.split('\n');
      expect(lines.length > 0 && lines.length <= 6).toBe(true);
      expect(Buffer.byteLength(excerpt) <= 1024).toBe(true);
      expect(lines.every(line => excerptVocabulary.has(line))).toBe(true);
      expect(lines.includes(marker)).toBe(true);
      expect(lines.includes('at node:internal/<redacted>')).toBe(true);
      expect(/[\x00-\x09\x0b-\x1f\x7f]/.test(excerpt)).toBe(false);
      expectPrivateText(excerpt, redactText(excerpt));
      expect(JSON.stringify(response).includes(excerpt)).toBe(false);
    }
    expect(bytes.byteLength <= 8192).toBe(true);
    expect(response.output.includes(`DIAGNOSTIC_ID=${hash(bytes)}`)).toBe(true);
    expect(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink()).toBe(true);
    for (const canary of [...excerptCanaries, f.worktree]) {
      expect(bytes.toString('utf8').includes(canary)).toBe(false);
      expect(JSON.stringify(response).includes(canary)).toBe(false);
    }
    expect(f.probe().exitCode).toBe(2);
    expectPrivateText(readFileSync(target, 'utf8'), bytes.toString('utf8'));
    for (const key of ['sanitized_excerpt', 'test_command', 'diagnostic', 'results', 'criterion_evidence', 'output_path']) {
      expect(Object.hasOwn(response, key)).toBe(false);
    }
    expectPrivateText(f.state(), before);
    expect(f.evidence()).toEqual(ledger);
  });

  it.each([
    'amber orbit velvet',
    'test name mentions TypeError: amber orbit velvet',
    'test name mentions Error [ERR_MODULE_NOT_FOUND]: amber orbit velvet',
    '"Error [ERR_MODULE_NOT_FOUND]: amber orbit velvet"',
    '`TypeError: amber orbit velvet`',
    'at privateFunction (/private/secret.env:1:2)',
    '$ Error [ERR_MODULE_NOT_FOUND]: amber orbit velvet\n(cwd: /private/secret.env)',
  ])('omits or uses fixed UNKNOWN for unrecognized content %#', async text => {
    const f = await launch(text + '\n' + excerptPoison);
    const before = f.state();
    const ledger = f.evidence();
    const response = f.probe();
    expect(response.exitCode).toBe(2);
    expect(f.files().length === 1).toBe(true);
    const bytes = readFileSync(join(f.dir, f.files()[0]!));
    const doc = JSON.parse(bytes.toString('utf8'));
    const excerpt: unknown = doc.test_command?.sanitized_excerpt;
    expect(excerpt === undefined || excerpt === 'UNKNOWN').toBe(true);
    for (const canary of excerptCanaries) {
      expect(bytes.toString('utf8').includes(canary)).toBe(false);
      expect(JSON.stringify(response).includes(canary)).toBe(false);
    }
    expectPrivateText(f.state(), before);
    expect(f.evidence()).toEqual(ledger);
  });

  it('never adds an excerpt for valid raw even with a recognized test-command exception', async () => {
    const raw = JSON.stringify({ testResults: [], numTotalTests: 0, numTotalTestSuites: 0, numFailedTestSuites: 0 });
    const f = await fixture({}, [process.execPath, '-e',
      `require('node:fs').writeFileSync(process.argv[1], ${JSON.stringify(raw)});` +
      `console.error(${JSON.stringify('Error [ERR_MODULE_NOT_FOUND]: ' + excerptPoison + '\n    at node:internal/modules/esm/resolve:1:2')});process.exitCode=1;`,
      '${REPORT}'], { report: { format: 'vitest-json' } });
    const before = f.state();
    const ledger = f.evidence();
    const response = f.probe();
    const dir = join(f.s.control, '.mycelink', 'probe-diagnostics', SHOP_FEATURE, ERRORS, f.claim.claimId);
    const names = existsSync(dir) ? readdirSync(dir) : [];
    expect(names.length === 1).toBe(true);
    const bytes = readFileSync(join(dir, names[0]!));
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(response.exitCode === 2 && doc.raw.status === 'valid').toBe(true);
    expect(Object.hasOwn(doc, 'test_command')).toBe(false);
    expect(bytes.toString('utf8').includes('sanitized_excerpt')).toBe(false);
    expect(Object.hasOwn(doc, 'sanitized_tail')).toBe(false);
    expect(Object.hasOwn(doc.test_command ?? {}, 'sanitized_tail')).toBe(false);
    for (const canary of excerptCanaries) {
      expect(bytes.toString('utf8').includes(canary)).toBe(false);
      expect(JSON.stringify(response).includes(canary)).toBe(false);
    }
    expectPrivateText(f.state(), before);
    expect(f.evidence()).toEqual(ledger);
  });

  // Targeted common-pattern protection, not a claim of perfect secrecy.
  // Entire permitted tail grammar: fixed category, finite English diagnostic
  // words in this exact message, and optional fixed redaction placeholders.
  // Unknown Node codes are deliberately NOT a vocabulary of accepted codes.
  const tailCategory = 'NODE_FATAL_ERROR';
  const tailMessage = 'Cannot resolve package exports in runtime';
  const tailWords = new Set(['NODE_FATAL_ERROR', 'Cannot', 'resolve', 'package', 'exports', 'in', 'runtime']);
  const tailCanaries = [
    'unregistered-canary-secret', 'sk-proj-' + 'Q7mX9pR2'.repeat(6),
    'amber orbit velvet', 'amber', 'orbit', 'velvet',
    'quoted private payload', 'backtick private payload',
    'C:\\private\\secret.ts', '/mnt/c/private/secret.ts', '/private/secret.env',
    'file:///private/secret.env', 'person@private.invalid',
    'PRIVATE_SYNTHETIC_ENV_KEY', 'arbitrary multiline message', 'private synthetic test name',
    'opaque' + 'Z9q'.repeat(100),
  ];
  const tailPayload = 'token=' + tailCanaries[0] + ' API_KEY=' + tailCanaries[1] +
    ' PASSWORD=' + tailCanaries[0] + ' ' + tailCanaries[2] +
    ' "' + tailCanaries[6] + '" `' + tailCanaries[7] + '` ' +
    tailCanaries.slice(8).join('\n') + '\nPRIVATE_SYNTHETIC_ENV_KEY=amber orbit velvet\n';

  function checkTail(tail: unknown) {
    expect(typeof tail === 'string').toBe(true);
    if (typeof tail !== 'string') return;
    expect(tail.includes(tailCategory)).toBe(true);
    expect(tail.includes(tailMessage)).toBe(true);
    expect(Buffer.byteLength(tail, 'utf8') <= 2048).toBe(true);
    expect(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(tail)).toBe(false);
    // Both lexical and structural checks: no unexpected words, numbers,
    // punctuation, Unicode prose, dynamic code, or untrusted placeholders.
    const withoutPlaceholders = tail.replace(/<redacted>/g, '');
    expect(/^[A-Za-z_ :\n]*$/.test(withoutPlaceholders)).toBe(true);
    expect(withoutPlaceholders.split(/[ :\n]+/).filter(Boolean).every(word => tailWords.has(word))).toBe(true);
    expect(/^(?:NODE_FATAL_ERROR[: ]*\n?Cannot resolve package exports in runtime)(?:[ \n]*<redacted>)*$/.test(tail)).toBe(true);
    expectPrivateText(tail, redactText(tail));
  }

  it.each(['ERR_UNSUPPORTED_DIR_IMPORT', 'ERR_SYNTHETIC_FUTURE_FAILURE', 'ERR_PRIVATE_FUTURE_PAYLOAD'] as const)(
    'retains a finite meaningful private tail for previously unallowlisted Node fatal code %s', async code => {
      const text = '\x1b[31mError [' + code + ']: ' + tailMessage + ' ' + tailPayload +
        '\x1b[0m\x07\x00\n' + tailPayload + '\nNode.js v24.14.1\n';
      const f = await launch(text);
      const before = f.state();
      const ledger = f.evidence();
      let observed: ProbeRawSnapshot | undefined;
      let clone = '';
      const realRun = verificationRunner.runVerification;
      const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
        clone = args.cwd;
        const hook = (args as ProbeRunnerArgs).onRawReport;
        return realRun({ ...args, onRawReport: (value: ProbeRawSnapshot) => {
          observed = value;
          hook?.(value);
        } } as ProbeRunnerArgs);
      });
      let response: ReturnType<typeof f.probe>;
      try { response = f.probe(); } finally { runner.mockRestore(); }
      expectPrivateText(observed?.test_command_output, redactText(text));
      expect(response.exitCode === 2).toBe(true);
      expect(f.files().length === 1).toBe(true);
      const target = join(f.dir, f.files()[0]!);
      const bytes = readFileSync(target);
      const doc = JSON.parse(bytes.toString('utf8'));
      expect(doc.stage === 'IDENTITY:EMPTY' && doc.raw.status === 'missing' &&
        doc.runner.exit_code === 1 && doc.runner.normalized_count === 0).toBe(true);
      checkTail(doc.test_command?.sanitized_tail);
      // Existing classifier, hashes and optional static excerpt stay unchanged.
      expect(doc.test_command.code === 'NODE_FATAL_UNKNOWN').toBe(true);
      expect(doc.test_command.sanitized_excerpt === undefined).toBe(true);
      const nonempty = redactText(text).split(/\r?\n/).filter(line => line.trim() !== '');
      const last = Buffer.from(nonempty.at(-1) ?? '').subarray(-1024);
      expectPrivateText(JSON.stringify(doc.test_command.last_error), JSON.stringify({ sha256: hash(last), bytes: last.length }));
      expectPrivateText(JSON.stringify(doc.test_command.lines), JSON.stringify(nonempty.slice(-12).map(line =>
        ({ sha256: hash(line), bytes: Buffer.byteLength(line) }))));
      expect(bytes.length <= 8192).toBe(true);
      expect(response.output === `CHANNEL_PROBE_REPORT_INVALID:IDENTITY:EMPTY DIAGNOSTIC_ID=${hash(bytes)}`).toBe(true);
      expect(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink()).toBe(true);
      expect(relative(f.s.control, target).replace(/\\/g, '/').startsWith('.mycelink/probe-diagnostics/')).toBe(true);
      expect(git(f.s.control, ['check-ignore', target]).length > 0).toBe(true);
      // POSIX mode is meaningful on native POSIX filesystems. Windows ACLs
      // require independent host inspection; chmod/mode is not ACL evidence.
      if (process.platform !== 'win32' && !target.startsWith('/mnt/')) {
        expect((lstatSync(target).mode & 0o777) === 0o600).toBe(true);
      }
      for (const secret of [...tailCanaries, code, f.worktree, clone, 'setup-only', 'build-only']) {
        expect(bytes.toString('utf8').includes(secret)).toBe(false);
        expect(JSON.stringify(response).includes(secret)).toBe(false);
      }
      expect(JSON.stringify(response).includes(tailMessage)).toBe(false);
      expect(f.probe().exitCode === 2).toBe(true);
      expectPrivateText(readFileSync(target, 'utf8'), bytes.toString('utf8'));
      for (const name of f.files()) expect(/^diagnostic\.[a-f0-9]{16}(?:-[1-9][0-9]*)?\.json$/.test(name)).toBe(true);
      expect(existsSync(dirname(clone))).toBe(false);
      expectPrivateText(f.state(), before);
      expectPrivateText(JSON.stringify(f.evidence()), JSON.stringify(ledger));
      for (const key of ['sanitized_tail', 'test_command', 'diagnostic', 'criterion_evidence', 'results', 'output_path', 'accepted']) {
        expect(Object.hasOwn(response, key)).toBe(false);
      }
    });

  it.each([
    'amber orbit velvet',
    'Error [ERR_SYNTHETIC_FUTURE_FAILURE]: amber orbit velvet',
    'test name Error [ERR_SYNTHETIC_FUTURE_FAILURE]: Cannot resolve package exports in runtime',
    '"Error [ERR_SYNTHETIC_FUTURE_FAILURE]: Cannot resolve package exports in runtime"',
    '`Error [ERR_SYNTHETIC_FUTURE_FAILURE]: Cannot resolve package exports in runtime`',
  ])('omits the private tail for unsafe unclassified shape %#', async text => {
    const f = await launch(text + '\n' + tailPayload + '\nNode.js v24.14.1\n');
    const before = f.state();
    const ledger = f.evidence();
    const response = f.probe();
    expect(response.exitCode === 2 && f.files().length === 1).toBe(true);
    const bytes = readFileSync(join(f.dir, f.files()[0]!));
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(Object.hasOwn(doc.test_command ?? {}, 'sanitized_tail')).toBe(false);
    for (const secret of tailCanaries) expect(bytes.toString('utf8').includes(secret)).toBe(false);
    expectPrivateText(f.state(), before);
    expectPrivateText(JSON.stringify(f.evidence()), JSON.stringify(ledger));
  });

  it('retains a safe meaningful tail for a registered native Node throw before any report', async () => {
    const script = `const error = new Error(${JSON.stringify(tailMessage + ' ' + tailPayload)});` +
      `error.name='Error [ERR_UNSUPPORTED_DIR_IMPORT]';throw error;`;
    const f = await fixture({}, [process.execPath, '-e', script, '${REPORT}'], { report: { format: 'vitest-json' } });
    const before = f.state();
    const ledger = f.evidence();
    const response = f.probe();
    const dir = join(f.s.control, '.mycelink', 'probe-diagnostics', SHOP_FEATURE, ERRORS, f.claim.claimId);
    const names = existsSync(dir) ? readdirSync(dir) : [];
    expect(response.exitCode === 2 && names.length === 1).toBe(true);
    const bytes = readFileSync(join(dir, names[0]!));
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(doc.stage === 'IDENTITY:EMPTY' && doc.raw.status === 'missing' &&
      doc.runner.exit_code === 1 && doc.runner.normalized_count === 0).toBe(true);
    checkTail(doc.test_command?.sanitized_tail);
    expect(bytes.length <= 8192).toBe(true);
    expect(response.output.endsWith('DIAGNOSTIC_ID=' + hash(bytes))).toBe(true);
    for (const secret of [...tailCanaries, script, f.worktree, 'ERR_UNSUPPORTED_DIR_IMPORT']) {
      expect(bytes.toString('utf8').includes(secret)).toBe(false);
      expect(JSON.stringify(response).includes(secret)).toBe(false);
    }
    expectPrivateText(f.state(), before);
    expectPrivateText(JSON.stringify(f.evidence()), JSON.stringify(ledger));
  });

  it.each(['malformed raw', 'valid raw', 'normalized identities', 'runner success', 'runner refusal'] as const)(
    'omits the meaningful private tail outside its boundary for %s', async kind => {
      const f = await launch('Error [ERR_UNSUPPORTED_DIR_IMPORT]: ' + tailMessage + '\nNode.js v24.14.1\n');
      const before = f.state();
      const ledger = f.evidence();
      const realRun = verificationRunner.runVerification;
      const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
        const hook = (args as ProbeRunnerArgs).onRawReport;
        return realRun({ ...args, onRawReport: (value: ProbeRawSnapshot) => {
          const bytes = kind === 'malformed raw' ? Buffer.from('invalid report') : kind === 'valid raw'
            ? Buffer.from(JSON.stringify({ testResults: [], numTotalTests: 0 })) : null;
          hook?.({ ...value, bytes, sha256: bytes === null ? null : hash(bytes),
            normalized_count: kind === 'normalized identities' ? 1 : 0,
            exit_code: kind === 'runner success' ? 0 : kind === 'runner refusal' ? 2 : 1 });
        } } as ProbeRunnerArgs);
      });
      let response: ReturnType<typeof f.probe>;
      try { response = f.probe(); } finally { runner.mockRestore(); }
      expect(response.exitCode === 2).toBe(true);
      for (const name of f.files()) {
        const doc = JSON.parse(readFileSync(join(f.dir, name), 'utf8'));
        expect(Object.hasOwn(doc.test_command ?? {}, 'sanitized_tail')).toBe(false);
        expect(Object.hasOwn(doc, 'sanitized_tail')).toBe(false);
      }
      expectPrivateText(f.state(), before);
      expectPrivateText(JSON.stringify(f.evidence()), JSON.stringify(ledger));
    });

  it.each(['cancelled', 'generation'] as const)('writes no meaningful tail sidecar after %s changes', async kind => {
    const f = await launch('Error [ERR_UNSUPPORTED_DIR_IMPORT]: ' + tailMessage + '\n' + tailPayload + '\nNode.js v24.14.1\n');
    const before = f.state();
    const ledger = f.evidence();
    const scope = f.controller.codexClaimScope.bind(f.controller);
    let changed = false;
    const current = vi.spyOn(f.controller, 'codexClaimScope').mockImplementation((...args) => {
      const live = scope(...args);
      return !changed || !live ? live : kind === 'cancelled' ? null : { ...live, generation: (live.generation ?? 0) + 1 };
    });
    const realRun = verificationRunner.runVerification;
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      const result = realRun(args);
      changed = true;
      return result;
    });
    try {
      const response = f.probe();
      expect(response.exitCode === 2 && response.output === 'CHANNEL_CLAIM_STALE').toBe(true);
      expect(f.files().length === 0).toBe(true);
      expectPrivateText(f.state(), before);
      expectPrivateText(JSON.stringify(f.evidence()), JSON.stringify(ledger));
    } finally { runner.mockRestore(); current.mockRestore(); }
  });

  it('bounds repeated meaningful UTF8 fatal output to the finite private tail grammar', async () => {
    const line = 'Error [ERR_UNSUPPORTED_DIR_IMPORT]: ' + tailMessage;
    const text = Array.from({ length: 100 }, () => line + ' amber orbit velvet \u79d8\u5bc6\ud83d\udd12').join('\n') + '\nNode.js v24.14.1\n';
    const f = await launch(text);
    const before = f.state();
    const ledger = f.evidence();
    const response = f.probe();
    expect(response.exitCode === 2 && f.files().length === 1).toBe(true);
    const bytes = readFileSync(join(f.dir, f.files()[0]!));
    const doc = JSON.parse(bytes.toString('utf8'));
    checkTail(doc.test_command?.sanitized_tail);
    expect(bytes.length <= 8192).toBe(true);
    expect(bytes.toString('utf8').includes('amber')).toBe(false);
    expect(bytes.toString('utf8').includes('\u79d8\u5bc6')).toBe(false);
    expect(bytes.toString('utf8').includes('\ud83d\udd12')).toBe(false);
    expectPrivateText(f.state(), before);
    expectPrivateText(JSON.stringify(f.evidence()), JSON.stringify(ledger));
  });

  it('does not select a meaningful tail from setup build headers or aggregate callback output', async () => {
    const decoy = 'Error [ERR_UNSUPPORTED_DIR_IMPORT]: ' + tailMessage;
    const f = await fixture({}, [process.execPath, '-e', 'process.exitCode=1', '${REPORT}'], {
      report: { format: 'vitest-json' },
      setup: [[process.execPath, '-e', `console.error(${JSON.stringify(decoy)})`]],
      build: [[process.execPath, '-e', `console.error(${JSON.stringify(decoy)})`]],
    });
    const before = f.state();
    const ledger = f.evidence();
    const realRun = verificationRunner.runVerification;
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      const hook = (args as ProbeRunnerArgs).onRawReport;
      return realRun({ ...args, onRawReport: (value: ProbeRawSnapshot) => {
        expect(value.test_command_output === '').toBe(true);
        hook?.({ ...value, output: value.output + '\n$ ' + decoy + '\n(cwd: ' + decoy + ')\n' });
      } } as ProbeRunnerArgs);
    });
    let response: ReturnType<typeof f.probe>;
    try { response = f.probe(); } finally { runner.mockRestore(); }
    const dir = join(f.s.control, '.mycelink', 'probe-diagnostics', SHOP_FEATURE, ERRORS, f.claim.claimId);
    const names = existsSync(dir) ? readdirSync(dir) : [];
    expect(response.exitCode === 2 && names.length === 1).toBe(true);
    const bytes = readFileSync(join(dir, names[0]!));
    const doc = JSON.parse(bytes.toString('utf8'));
    expect(Object.hasOwn(doc.test_command ?? {}, 'sanitized_tail')).toBe(false);
    expect(bytes.toString('utf8').includes(tailMessage)).toBe(false);
    expectPrivateText(f.state(), before);
    expectPrivateText(JSON.stringify(f.evidence()), JSON.stringify(ledger));
  });

  it.each(['object', 'oversize', 'missing'] as const)('fails closed on %s test-command callback data', async kind => {
    const f = await launch('SyntaxError: controlled\n' + poison);
    const before = f.state();
    const ledger = f.evidence();
    let clone = '';
    const realRun = verificationRunner.runVerification;
    const runner = vi.spyOn(verificationRunner, 'runVerification').mockImplementation(args => {
      clone = args.cwd;
      const hook = (args as ProbeRunnerArgs).onRawReport;
      return realRun({ ...args, onRawReport: (value: ProbeRawSnapshot) => {
        const malformed = { ...value, test_command_output: kind === 'object' ? { token: poison }
          : kind === 'oversize' ? 'x'.repeat(65537) : undefined };
        hook?.(malformed as unknown as ProbeRawSnapshot);
      } } as ProbeRunnerArgs);
    });
    let result: ReturnType<typeof f.probe>;
    try { result = f.probe(); } finally { runner.mockRestore(); }
    expectPrivateText(JSON.stringify(result), JSON.stringify({ exitCode: 2, output: 'CHANNEL_PROBE_REPORT_INVALID:RAW' }));
    expect(f.files()).toEqual([]);
    expect(existsSync(dirname(clone))).toBe(false);
    expect(f.state()).toBe(before);
    expect(f.evidence()).toEqual(ledger);
  });

  it.each([0, 2])('does not add launch classification when missing raw has runner exit %s', async exit => {
    const f = await launch('SyntaxError: controlled', exit);
    const result = f.probe();
    expect(result.exitCode).toBe(2);
    expect(f.files()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.dir, f.files()[0]!), 'utf8'))).not.toHaveProperty('test_command');
  });
});
