/**
 * The treatment-arm driver, model-free: a scripted stand-in for `claude -p`
 * (fake-claude.mjs) works the toy case, so every arm runs end to end —
 * fresh workspace and HOME, the generated prompt on stdin, fault triggers,
 * restarts, QA's late-defect report, and the authoritative verdict.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { dirname, join, relative } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { ISOLATED, TEST_ISOLATION } from './isolation-fixture.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TOY, TOY_PRD, preparedToy, toyGit, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { PASSED_ENV, claudeArgs, matrixProblems, outDirProblem, planProblems, pluginExposure, runArm, runMatrix, runOk, runVerdict } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { PROXY_ENV } from '../../evals-public-projects/lib/isolation.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { casePrompt } from '../../evals-public-projects/lib/cases.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { CORRECTIVE_PROMPT, RESUME_PROMPT, TASK_CORRECTIVE_PROMPT, correctivePrompt, lateDefectPrompt, resumePrompt, taskCorrectivePrompt } from '../../evals-public-projects/lib/faults.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { main as runArmMain } from '../../evals-public-projects/tools/run-arm.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { main as verifyRunMain } from '../../evals-public-projects/tools/verify-run.mjs';

afterAll(() => cleanupTmpRoots());

const FAKE = join(REPO_ROOT, 'tests', 'benchmark', 'fake-claude.mjs');
const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const REGRESSION = {
  'mod-a/test/regression.test.mjs': `${T}import { reserve } from '../src/stock.mjs';\ntest('reserving takes the quantity out of the stock again', () => {\n  assert.deepEqual(reserve(2, 1), { stock: 1, reserved: 1 });\n});\n`,
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/**
 * The QA prompt a run must have sent for its late-defect record: lateDefectPrompt's own output — no arm
 * changes a byte of it — with the checks the record says QA reported, as the prompt lists them.
 */
function qaPrompt(sent: string, defect: any, original: string): string {
  const failures = sent
    .split('\n\nThe original request follows.')[0]!
    .split('\n')
    .filter((l) => l.startsWith('- ') && l.includes(': '))
    .map((l) => ({ name: l.slice(2, l.indexOf(': ')), message: l.slice(l.indexOf(': ') + 2) }));
  expect(failures.map((f) => f.name)).toEqual(defect.reported);
  // The module the record binds, as the case's README names it, in both arms alike.
  expect(defect.affected).toEqual({ module: defect.module, path: defect.module, repository: 'repos/toyshop' });
  return lateDefectPrompt({ commit: defect.commit, failures, affected: defect.affected, original });
}
// The agent's own tests: the reference's verbatim would be evaluator content in the delivery.
const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));
// libuv copies these into every child environment on Windows.
const WINDOWS_REQUIRED = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];

let toy: Toy;
let project: any;
let prd: any;

// The model proxy's preflight target in these tests: a local server instead of the model API (no network needed).
let echo: net.Server;
let PROXY: { allowed: string; denied: string };

beforeAll(async () => {
  ({ toy, project, prd } = await preparedToy());
  echo = net.createServer((c) => c.end('echo'));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  PROXY = { allowed: `127.0.0.1:${(echo.address() as net.AddressInfo).port}`, denied: 'example.invalid:443' };
}, 300_000);
afterAll(() => echo?.close());

function fakePlan(extra: Record<string, unknown> = {}) {
  const dir = makeTmpDir('bench-a-fake-');
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  const file = join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify({ log, tests: AGENT_TESTS, code: TOY.referenceCode, regression: REGRESSION, ...extra }));
  return { dir, file, entries: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const arm = (name: string, fake: { dir: string; file: string }, options: Record<string, unknown> = {}) =>
  runArm({
    suiteRoot: toy.suite,
    caseKey: TOY_PRD,
    arm: name,
    outDir: join(makeTmpDir('bench-a-run-'), 'run'),
    cacheRoot: toy.cacheRoot,
    claude: [process.execPath, FAKE],
    pollMs: 100,
    env: { FAKE_CLAUDE_PLAN: fake.file },
    isolation: TEST_ISOLATION,
    // Inside the boundary the stand-in agent sees its plan and log only because they are bound in.
    sessionBinds: [{ path: fake.dir, rw: true }],
    preflightProxy: PROXY,
    proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
    ...options,
  });

describe('normal arms', () => {
  it('gives both orchestration arms the generated prompt byte for byte, a fresh workspace and HOME each, and differ only by --plugin-dir', async () => {
    const fake = fakePlan();
    process.env.BENCH_OPERATOR_MARKER = 'must not reach a session';
    let without: any;
    let withMycelink: any;
    try {
      without = await arm('without', fake);
      // fake-claude is no Mycelink host: it changes product code itself, as the without arm's agent does. The guard is off (and the run untrusted for it).
      withMycelink = await arm('with', fake, { controllerGuard: false });
    } finally {
      delete process.env.BENCH_OPERATOR_MARKER;
    }
    const [a, b] = fake.entries();
    const prompt = casePrompt({ project, prd });
    expect(a.prompt_sha256).toBe(sha(prompt));
    expect(b.prompt_sha256).toBe(a.prompt_sha256);
    expect(without.prompt_sha256).toBe(sha(prompt));
    expect(a.argv).toEqual(claudeArgs({ plugin: false }));
    // The with arm loads the sealed release package, never this checkout.
    expect(b.argv).toEqual([...a.argv, '--plugin-dir', withMycelink.plugin.dir]);
    expect(withMycelink.plugin).toMatchObject({ zip_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), tree_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(withMycelink.plugin.dir.startsWith(REPO_ROOT)).toBe(false);
    expect(a.argv).toEqual(expect.arrayContaining(['-p', '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Glob,Grep,Write,Edit,Bash,Skill,Agent,TodoWrite']));
    expect(a.home).toBe(without.home);
    expect(b.home).toBe(withMycelink.home);
    expect(a.home).not.toBe(b.home);
    // Nothing of the operator's environment reaches a session beyond the passed list (bwrap's --chdir sets PWD, the workspace).
    const allowed = new Set([...PASSED_ENV, ...Object.keys(PROXY_ENV), 'HOME', 'USERPROFILE', 'TMPDIR', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'FAKE_CLAUDE_PLAN', 'MYCELINK_PROVENANCE', ...(ISOLATED ? ['PWD'] : []), ...(process.platform === 'win32' ? WINDOWS_REQUIRED : [])].map((k) => k.toUpperCase()));
    expect(a.env.filter((k: string) => !allowed.has(k.toUpperCase()))).toEqual([]);
    expect(a.env).not.toContain('BENCH_OPERATOR_MARKER');
    for (const run of [without, withMycelink]) {
      expect(run.sessions.map((s: any) => [s.purpose, s.ended_by, s.exit_code])).toEqual([['task', 'exit', 0]]);
      expect(run.sessions[0].result).toMatchObject({ subtype: 'success', num_turns: 4 });
      expect(run.condition).toBe('normal');
      expect(run.plugin_exposure).toEqual([]);
      expect(run.ok).toBe(true);
      expect(JSON.parse(readFileSync(run.verification, 'utf8')).ok).toBe(true);
    }
  }, 240_000);

  it('ends a session at the wall-clock budget, and the verdict judges what was delivered', async () => {
    const run = await arm('without', fakePlan({ stall: true }), { budgetSeconds: 3 });
    expect(run.sessions.map((s: any) => [s.purpose, s.ended_by])).toEqual([['task', 'budget']]);
    expect(run.ok).toBe(false);
    const v = JSON.parse(readFileSync(run.verification, 'utf8'));
    expect(v.sections.acceptance.ok).toBe(false);
  }, 240_000);
});

describe('the control arm never sees the plugin', () => {
  it('fails, untrusted, a without-arm run whose session or worker named the sealed package or --plugin-dir', async () => {
    const outDir = join(makeTmpDir('bench-a-run-'), 'run');
    const plugin = join(outDir, 'plugin');
    const fake = fakePlan({
      peek: ['/run/bench/bin/claude -p --plugin-dir /opt/elsewhere "build it"'],
      workerPeek: join(plugin, '.claude-plugin', 'plugin.json'),
    });
    const run = await arm('without', fake, { outDir });
    // The delivery itself verifies: what fails the run is the exposure.
    expect(run.verified).toBe(true);
    expect(run.plugin_exposure.join(' | ')).toMatch(/--plugin-dir/);
    expect(run.plugin_exposure.join(' | ')).toMatch(/names the plugin package/);
    expect(run.plugin_exposure.some((p: string) => p.includes('subagents'))).toBe(true);
    expect(run.ok).toBe(false);
    expect(run.trusted).toBe(false);
    expect(run.verdict).toBe('untrusted');
    expect(run.trust.problems.join(' | ')).toMatch(/plugin exposure/);
    // The worker's transcript is summarised in the record.
    expect(run.workers).toEqual([{ transcript: expect.stringMatching(/subagents[\\/]agent-1\.jsonl$/), node_id: null, claim_id: null, dispatch_id: null, settlement: null, tool_uses: 1, gates: { red: 0, green: 0, regression: 0 }, outcome: null }]);
  }, 240_000);

  it('names every way a record lets the plugin into the without arm, or another plugin into the with arm', () => {
    const root = makeTmpDir('bench-a-exp-');
    const dir = join(root, 'plugin');
    const ws = join(root, 'workspace');
    const without = { arm: 'without', dir, args: claudeArgs({ plugin: false }), binds: [{ path: ws, dest: ws, rw: true }], files: [] };
    expect(pluginExposure(without)).toEqual([]);
    expect(pluginExposure({ ...without, args: claudeArgs({ plugin: true, pluginDir: dir }) }).join(' | ')).toMatch(/--plugin-dir/);
    expect(pluginExposure({ ...without, binds: [...without.binds, { path: root, dest: root }] }).join(' | ')).toMatch(/binds/);
    expect(pluginExposure({ ...without, binds: [...without.binds, { path: join(root, 'x'), dest: join(dir, 'skills') }] }).join(' | ')).toMatch(/binds/);
    const transcript = join(root, 'session.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'init', cwd: ws })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls ../plugin' } }] } })}\n`);
    expect(pluginExposure({ ...without, files: [transcript] }).join(' | ')).toMatch(/names the plugin package/);
    const init = join(root, 'init.jsonl');
    writeFileSync(init, `${JSON.stringify({ type: 'system', subtype: 'init', cwd: ws, plugins: [{ name: 'mycelink', path: dir }] })}\n`);
    expect(pluginExposure({ ...without, files: [init] }).join(' | ')).toMatch(/names the plugin package/);
    // The with arm loads the sealed package once, and nothing else.
    const withArm = { arm: 'with', dir, args: claudeArgs({ plugin: true, pluginDir: dir }), binds: [{ path: dir, dest: dir, rw: false }], files: [] };
    expect(pluginExposure(withArm)).toEqual([]);
    expect(pluginExposure({ ...withArm, args: [...withArm.args, '--plugin-dir', join(root, 'other')] }).join(' | ')).toMatch(/only the sealed plugin/);
    expect(pluginExposure({ ...withArm, args: claudeArgs({ plugin: false }) }).join(' | ')).toMatch(/does not load/);
  });
});

describe('run verdicts: the delivery apart from the evidence', () => {
  const confined = { kind: 'bubblewrap', enforced: true, preflight: { ok: true, checks: [] } };
  const base = { isolation: confined, sessions: [{ confined: true, survivors: [] }], evaluator_access: { hits: [], probes: [] }, plugin_exposure: [] };
  const section = (ok: boolean, checks: any[] = []) => ({ ok, checks });
  const passing = () => ({
    ok: true,
    trusted: true,
    trust: { isolation: true, suite_pinned: true, qualification_filesystems: true },
    errors: [],
    sections: { identity: section(true), hygiene: section(true), scope: section(true), leakage: section(true, [{ id: 'reference-convergence', ok: false, severity: 'warning', detail: 'x' }]), harness: section(true), regression: section(true), acceptance: section(true), tdd: { ok: true, required: true, units: [{ verdict: 'valid' }] }, orchestration: { required: false, present: false, ok: false, checks: [] }, faults: null, integrity: section(true) },
  });

  it('a verified, confined, clean run is trusted and verified; a convergence warning changes nothing', () => {
    expect(runVerdict({ record: base, verification: passing() })).toEqual({ verdict: 'verified', trust: { ok: true, problems: [] }, delivery: { ok: true, failures: [] } });
  });

  it('a delivery the model got wrong is a delivery failure of a trusted run', () => {
    const v = passing();
    v.ok = false;
    v.sections.acceptance = section(false, [{ id: 'hidden:AC-2', ok: false, detail: 'failed (assertion)' }]);
    v.sections.tdd = { ok: false, required: true, units: [{ verdict: 'no-test-first' }] };
    const r = runVerdict({ record: base, verification: v });
    expect(r).toMatchObject({ verdict: 'delivery-failed', trust: { ok: true, problems: [] }, delivery: { ok: false } });
    expect(r.delivery.failures).toEqual(['acceptance:hidden:AC-2 (failed (assertion))', 'tdd:no-test-first']);
  });

  it('names an injection the TDD replay could not see through apart from the units', () => {
    const v = passing();
    v.ok = false;
    const detail = `late-hidden-defect ${'a'.repeat(12)}: not in the delivered history (amended, replaced or dropped)`;
    v.sections.tdd = { ok: false, required: true, units: [{ verdict: 'valid', ok: true }], injections: [{ kind: 'late-hidden-defect', commit: 'a'.repeat(40), ok: false, detail }] } as any;
    expect(runVerdict({ record: base, verification: v }).delivery.failures).toEqual([`tdd:injection:late-hidden-defect (${detail})`]);
  });

  it('a run whose evidence cannot be trusted is untrusted, whatever its delivery', () => {
    const cases: [string, any, any, RegExp][] = [
      ['no boundary', { ...base, isolation: { kind: 'none', enforced: false } }, passing(), /outside the isolation boundary/],
      ['a failed preflight', { ...base, isolation: { ...confined, preflight: { ok: false, checks: [{ id: 'vsock', ok: false, detail: 'allowed' }] } } }, passing(), /preflight failed: vsock/],
      ['a survivor', { ...base, sessions: [{ confined: true, survivors: [{ pid: 1, cmd: 'sleep' }] }] }, passing(), /outlived its session/],
      ['transcript access', { ...base, evaluator_access: { hits: [{ file: 't', line: 3, tool: 'Read', root: '/c', path: '/c/x' }], probes: [] } }, passing(), /evaluator access: t:3/],
      ['plugin exposure', { ...base, plugin_exposure: ['t:4 names the plugin package'] }, passing(), /plugin exposure: t:4/],
      ['an untrusted verdict', base, { ...passing(), trusted: false, trust: { isolation: true, suite_pinned: false, qualification_filesystems: true } }, /verification is not trusted: suite_pinned/],
      ['a broken evaluator store', base, { ...passing(), ok: false, sections: { ...passing().sections, identity: section(false, [{ id: 'evaluator-lock', ok: false, detail: 'mismatch' }]) } }, /identity:evaluator-lock/],
      ['proof of leakage', base, { ...passing(), ok: false, sections: { ...passing().sections, leakage: section(false, [{ id: 'no-evaluator-blobs', ok: false, detail: 'hidden test' }]) } }, /leakage:no-evaluator-blobs/],
      ['a verifier error', base, { ...passing(), ok: false, errors: ['Error: boom'] }, /the verifier failed: Error: boom/],
      ['no verdict', base, null, /no verification/],
    ];
    for (const [what, record, verification, re] of cases) {
      const r = runVerdict({ record, verification });
      expect(r.verdict, what).toBe('untrusted');
      expect(r.trust.ok, what).toBe(false);
      expect(r.trust.problems.join(' | '), what).toMatch(re);
    }
  });

  /**
   * A with arm whose controller changed the workspace itself (CSET-203 r9/r10):
   * trusted only when the harness attested its rollback afterwards
   * (lib/controller-txn.mjs attestRollbacks) — the manifest the record names,
   * verified, and nothing the controller wrote left — never on the record's
   * word that it was verified.
   */
  it('a controller violation is trusted only by an attested rollback', () => {
    const M = 'm'.repeat(64);
    const violation = { fingerprint: 'f'.repeat(64), summary: ['platform/gen.py (created; a helper or scratch file in the workspace)'], mode: 'selective', verified: true, manifest_sha256: M, discarded: [] };
    const sessions = [
      { index: 1, purpose: 'task', confined: true, survivors: [], ended_by: 'controller-violation', violation, controller_txn: { dir: '/t/session-1', violation: true, rollback: { verified: true, manifest_sha256: M } } },
      { index: 2, purpose: 'corrective', corrects: 1, confined: true, survivors: [], ended_by: 'exit', controller_txn: { dir: '/t/session-2', violation: false, rollback: null } },
    ];
    const controller = { ok: true, failures: [], recovered: ['controller-violation: session 1 ...'], violations: [{ session: 1, verified: true, manifest_sha256: M, recovered_by: 2 }], authority_recovered: true };
    const attested = { ok: true, problems: [], sessions: [{ session: 1, ok: true, mode: 'selective', manifest_sha256: M, checked: 4 }] };
    const withArm = { ...base, arm: 'with', controller_guard: true, sessions, controller, controller_rollbacks: attested };
    expect(runVerdict({ record: withArm, verification: passing() })).toMatchObject({ verdict: 'verified', trust: { ok: true, problems: [] } });
    const cases: [string, any, RegExp][] = [
      ['never attested', { ...withArm, controller_rollbacks: undefined }, /controller rollback: session 1's rollback was never attested/],
      ['attested and found wanting', { ...withArm, controller_rollbacks: { ok: false, problems: ['session 1: platform/gen.py is still as the controller left it'], sessions: [{ session: 1, ok: false }] } }, /controller rollback: session 1: platform\/gen\.py is still as the controller left it/],
      ['an attestation of another session', { ...withArm, controller_rollbacks: { ok: true, problems: [], sessions: [{ session: 2, ok: true, manifest_sha256: M }] } }, /controller rollback: session 1's rollback was never attested/],
      ['an attestation of another manifest', { ...withArm, controller_rollbacks: { ...attested, sessions: [{ ...attested.sessions[0], manifest_sha256: 'n'.repeat(64) }] } }, /controller rollback: session 1's rollback was never attested/],
      ['a rollback not verified', { ...withArm, sessions: [{ ...sessions[0], violation: { ...violation, verified: false } }, sessions[1]] }, /controller rollback: session 1's rollback was not verified/],
      ['a violation only the controller report names', { ...withArm, sessions: [{ ...sessions[0], violation: undefined }, sessions[1]], controller_rollbacks: { ok: true, problems: [], sessions: [] } }, /controller rollback: session 1's rollback was never attested/],
    ];
    for (const [what, record, re] of cases) {
      const r = runVerdict({ record, verification: passing() });
      expect(r.verdict, what).toBe('untrusted');
      expect(r.trust.problems.join(' | '), what).toMatch(re);
      // Nor is such a run ok, however the delivery verified.
      expect(runOk({ record, verification: passing() }), what).toBe(false);
    }
    expect(runOk({ record: withArm, verification: passing() })).toBe(true);
  });
});

describe('the four-arm matrix', () => {
  it('runs all four arms with identical caps and prompts, differing only by the plugin and the fault plan, and checks that they match', async () => {
    const fake = fakePlan();
    const plan = { schema: 'mycelink-bench/fault-plan@1', id: 'matrix', faults: [{ kind: 'concurrent-commit', trigger: { on: 'first-commit' } }] };
    const outDir = join(makeTmpDir('bench-a-matrix-'), 'matrix');
    const m = await runMatrix({
      suiteRoot: toy.suite,
      caseKey: TOY_PRD,
      faultPlan: plan,
      outDir,
      cacheRoot: toy.cacheRoot,
      claude: [process.execPath, FAKE],
      budgetSeconds: 120,
      maxBudgetUsd: 1,
      pollMs: 100,
      env: { FAKE_CLAUDE_PLAN: fake.file },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: fake.dir, rw: true }],
      preflightProxy: PROXY,
      proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
    });
    expect(m.runs.map((r: any) => [r.arm, r.condition])).toEqual([
      ['without', 'normal'],
      ['with', 'normal'],
      ['without', 'faults'],
      ['with', 'faults'],
    ]);
    expect(m.problems).toEqual([]);
    expect(m.matched).toBe(true);
    // Each run's entry keeps its verdict apart from its trust, its sessions and its workers.
    const written = JSON.parse(readFileSync(join(outDir, 'matrix.json'), 'utf8'));
    for (const [i, entry] of written.runs.entries()) {
      const r = m.records[i];
      expect(entry).toMatchObject({ verified: r.verified, ok: r.ok, trusted: r.trusted, verdict: r.verdict, trust_problems: r.trust.problems, delivery_failures: r.delivery.failures });
      expect(entry.sessions).toEqual(r.sessions.map((s: any) => ({ index: s.index, purpose: s.purpose, phase: s.phase, resumes: s.resumes, continuation: s.continuation === true, ended_by: s.ended_by, exit_code: s.exit_code, duration_ms: s.duration_ms, num_turns: s.result?.num_turns ?? null, cost_usd: s.result?.total_cost_usd ?? null, confined: s.confined, survivors: (s.survivors ?? []).length })));
      expect(entry).toMatchObject({ continuations: r.continuations, extra_sessions: r.sessions.filter((s: any) => s.continuation === true).length });
      expect(entry.phases).toEqual(r.phases.map((p: any) => ({ phase: p.phase, sessions: p.sessions, ended_by: p.ended_by, mycelink: p.mycelink && { complete: p.mycelink.complete, candidate: p.mycelink.candidate, incomplete: p.mycelink.incomplete } })));
      expect(entry.workers).toEqual(r.workers);
    }
    // Unconfined here: every run is untrusted for that reason alone, never for its delivery.
    if (!ISOLATED) for (const r of m.records) expect(r.trust.problems).toContain('sessions ran outside the isolation boundary');
    expect(written.verdicts).toEqual(Object.fromEntries(m.records.map((r: any) => [`${r.arm}-${r.condition}`, r.verdict])));
    expect(JSON.parse(readFileSync(join(outDir, 'matrix.json'), 'utf8')).matched).toBe(true);
    expect(new Set(m.records.map((r: any) => r.prompt_sha256)).size).toBe(1);
    expect(new Set(m.records.map((r: any) => r.budget_seconds))).toEqual(new Set([120]));
    // A record whose caps differ from the others' is a confound, and is named.
    const skewed = m.records.map((r: any, i: number) => (i === 3 ? { ...r, budget_seconds: 60 } : r));
    expect(matrixProblems(skewed).join(' | ')).toMatch(/budget_seconds/);
    const otherPlugin = m.records.map((r: any, i: number) => (i === 1 ? { ...r, plugin: { ...r.plugin, tree_sha256: 'f'.repeat(64) } } : r));
    expect(matrixProblems(otherPlugin).join(' | ')).toMatch(/plugin/);
    // A without-arm record that reports exposure, or has no exposure check at all, breaks the match.
    const exposed = m.records.map((r: any, i: number) => (i === 2 ? { ...r, plugin_exposure: ['a transcript names the plugin package'] } : r));
    expect(matrixProblems(exposed).join(' | ')).toMatch(/without arm's record .*plugin exposure/);
    const unchecked = m.records.map((r: any, i: number) => (i === 0 ? { ...r, plugin_exposure: undefined } : r));
    expect(matrixProblems(unchecked).join(' | ')).toMatch(/without arm's record .*plugin exposure/);
    // The sandboxes differ by the plugin's bind in the with arms and by nothing else.
    const profiled = m.records.map((r: any) => {
      const runDir = dirname(r.workspace);
      const binds = [
        { path: r.workspace, dest: r.workspace, rw: true },
        { path: r.home, dest: r.home, rw: true },
        ...(r.arm === 'with' ? [{ path: r.plugin.dir, dest: r.plugin.dir, rw: false }] : []),
        { path: '/opt/node', dest: '/opt/node', rw: false },
      ];
      expect(r.plugin.dir.startsWith(runDir)).toBe(true);
      return { ...r, isolation: { ...r.isolation, profile: { binds, path: '/run/bench/bin:/usr/bin' } } };
    });
    expect(matrixProblems(profiled)).toEqual([]);
    const leaky = profiled.map((r: any, i: number) => (i === 2 ? { ...r, isolation: { ...r.isolation, profile: { ...r.isolation.profile, binds: [...r.isolation.profile.binds, { path: r.plugin.dir, dest: r.plugin.dir, rw: false }] } } } : r));
    expect(matrixProblems(leaky).join(' | ')).toMatch(/without arm's sandbox binds the plugin/);
    const unbound = profiled.map((r: any, i: number) => (i === 1 ? { ...r, isolation: { ...r.isolation, profile: { ...r.isolation.profile, binds: r.isolation.profile.binds.filter((b: any) => b.path !== r.plugin.dir) } } } : r));
    expect(matrixProblems(unbound).join(' | ')).toMatch(/with arm's sandbox does not bind the plugin/);
    const extra = profiled.map((r: any, i: number) => (i === 0 ? { ...r, isolation: { ...r.isolation, profile: { ...r.isolation.profile, binds: [...r.isolation.profile.binds, { path: '/opt/extra', dest: '/opt/extra', rw: false }] } } } : r));
    expect(matrixProblems(extra).join(' | ')).toMatch(/sandbox \(but the plugin\) differs/);
    // The JVM option each session gets names its own HOME: the same in every arm but for the run directory.
    const jvm = profiled.map((r: any) => ({ ...r, isolation: { ...r.isolation, profile: { ...r.isolation.profile, jvm_options: `-Duser.home=${r.home}` } } }));
    expect(matrixProblems(jvm)).toEqual([]);
    const elsewhere = jvm.map((r: any, i: number) => (i === 3 ? { ...r, isolation: { ...r.isolation, profile: { ...r.isolation.profile, jvm_options: '-Duser.home=/home/operator' } } } : r));
    expect(matrixProblems(elsewhere).join(' | ')).toMatch(/sandbox \(but the plugin\) differs/);
    // On the command line the matrix needs its fault plan, and is exclusive with --arm.
    expect(await runArmMain(['--case', TOY_PRD, '--matrix'], { isolation: TEST_ISOLATION })).toMatchObject({ ok: false, exit: 2, errors: [expect.stringMatching(/--faults/)] });
    expect(await runArmMain(['--case', TOY_PRD, '--matrix', '--arm', 'with'], { isolation: TEST_ISOLATION })).toMatchObject({ ok: false, exit: 2 });
  }, 600_000);
});

describe('fault-injected arm', () => {
  const PLAN = {
    schema: 'mycelink-bench/fault-plan@1',
    id: 'test',
    faults: [
      { kind: 'concurrent-commit', trigger: { on: 'first-commit' } },
      { kind: 'interrupt-restart', trigger: { on: 'commits', count: 1 } },
      { kind: 'duplicate-result', trigger: { on: 'session-end' } },
      { kind: 'late-hidden-defect', trigger: { on: 'session-end' } },
    ],
  };

  it('lands a teammate commit, interrupts and resumes, reports a late defect, and verifies the repaired delivery', async () => {
    const fake = fakePlan({ stall: true });
    const run = await arm('without', fake, { faultPlan: PLAN, requireTdd: true });
    expect(run.condition).toBe('faults');
    expect(run.sessions.map((s: any) => [s.purpose, s.ended_by])).toEqual([
      ['task', 'interrupt'],
      ['resume', 'exit'],
      ['rework', 'exit'],
    ]);
    const [task, resume, rework] = fake.entries();
    const prompt = casePrompt({ project, prd });
    expect(task.prompt_sha256).toBe(sha(prompt));
    expect(resume.prompt_sha256).toBe(sha(`${RESUME_PROMPT}\n\nThe original request follows.\n\n${prompt}`));
    expect(rework.prompt_head).toMatch(/^QA ran its end-to-end checks/);

    const byKind = Object.fromEntries(run.faults.map((f: any) => [f.kind, f]));
    expect(rework.prompt).toBe(qaPrompt(rework.prompt, byKind['late-hidden-defect'], prompt));
    expect(byKind['concurrent-commit']).toMatchObject({ applied: true, path: 'TEAM-NOTES.md' });
    expect(byKind['interrupt-restart']).toMatchObject({
      applied: true,
      resumed: true,
      interrupted_session: { index: 1, purpose: 'task', phase: 'task', ended_by: 'interrupt' },
      successor_session: { index: 2, purpose: 'resume', phase: 'task', ended_by: 'exit' },
    });
    expect(byKind['duplicate-result']).toMatchObject({ applied: false, detail: 'a Mycelink-only fault: not applicable without the plugin' });
    expect(byKind['late-hidden-defect']).toMatchObject({ applied: true, module: 'mod-a', paths: ['mod-a/src/stock.mjs'] });
    expect(byKind['late-hidden-defect'].reported).toEqual(['AC-1 reserving reduces the stock', 'AC-2 an order reports the remaining stock']);

    const v = JSON.parse(readFileSync(run.verification, 'utf8'));
    expect(v.sections.faults.checks.map((c: any) => [c.id, c.ok, c.severity ?? null])).toEqual([
      ['fault:concurrent-commit:bound', true, null],
      ['fault:concurrent-commit:kept', true, null],
      ['fault:duplicate-result:no-second-effect', true, 'warning'],
      ['fault:late-hidden-defect:bound', true, null],
      ['fault:late-hidden-defect:kept', true, null],
      ['fault:interrupt-restart:resumed', true, null],
    ]);
    // The injected commits are nobody's cycle: the agent's two cycles replay as test-first.
    expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid']);
    expect(v.ok).toBe(true);
    expect(run.ok).toBe(true);
  }, 300_000);

  it('runs from the command line, and verify-run re-verifies the run from its record, fault records included', async () => {
    const fake = fakePlan({ stall: true });
    const planFile = join(makeTmpDir('bench-a-plan-'), 'plan.json');
    writeFileSync(planFile, JSON.stringify(PLAN));
    const outDir = join(makeTmpDir('bench-a-cli-'), 'run');
    const common = ['--suite-root', toy.suite, '--cache-root', toy.cacheRoot];
    const run = await runArmMain(['--case', TOY_PRD, '--arm', 'without', '--out-dir', outDir, '--faults', planFile, '--claude', process.execPath, '--claude-arg', FAKE, '--claude-arg', fake.file, '--poll-ms', '100', ...common], { isolation: TEST_ISOLATION, sessionBinds: [{ path: dirname(fake.file), rw: true }], preflightProxy: PROXY });
    expect(run.sessions.map((s: any) => s.purpose)).toEqual(['task', 'resume', 'rework']);
    expect(run.ok).toBe(true);
    // The run read the suite pinned to its commit, sealed.
    expect(run.suite).toEqual({ commit: toyGit(toy.suite, ['rev-parse', 'HEAD']), path: '', tree: toyGit(toy.suite, ['rev-parse', 'HEAD^{tree}']), clean: true });
    // A suite with uncommitted changes, or at another commit than expected, is refused before anything runs.
    writeFileSync(join(toy.suite, 'stray.json'), '{}');
    try {
      expect(await runArmMain(['--case', TOY_PRD, '--arm', 'without', ...common], { isolation: TEST_ISOLATION })).toMatchObject({ ok: false, exit: 2, errors: [expect.stringMatching(/uncommitted changes/)] });
      expect(await verifyRunMain(['--workspace', run.workspace, '--case', TOY_PRD, ...common], { isolation: TEST_ISOLATION })).toMatchObject({ ok: false, exit: 2 });
    } finally {
      rmSync(join(toy.suite, 'stray.json'));
    }
    expect(await runArmMain(['--case', TOY_PRD, '--arm', 'without', '--expect-suite-commit', 'f'.repeat(40), ...common], { isolation: TEST_ISOLATION })).toMatchObject({ ok: false, exit: 2, errors: [expect.stringMatching(/expected f{40}/)] });
    // A case the pinned suite does not have is a usage error, refused like any other.
    expect(await runArmMain(['--case', 'NOPE-999', '--arm', 'without', ...common], { isolation: TEST_ISOLATION })).toMatchObject({ ok: false, exit: 2, errors: [expect.stringMatching(/unknown case NOPE-999/)] });

    const runJson = join(outDir, 'run.json');
    const again = await verifyRunMain(['--workspace', run.workspace, '--case', TOY_PRD, '--faults', runJson, ...common], { isolation: TEST_ISOLATION, sessionBinds: [{ path: dirname(fake.file), rw: true }], preflightProxy: PROXY });
    expect(again.ok).toBe(true);
    expect(again.sections.faults.ok).toBe(true);
    // A record that claims a commit the delivery does not contain is a lost update.
    const forged = join(makeTmpDir('bench-a-forged-'), 'faults.json');
    writeFileSync(forged, JSON.stringify(run.faults.map((f: any) => (f.kind === 'concurrent-commit' ? { ...f, commit: 'f'.repeat(40) } : f))));
    const lost = await verifyRunMain(['--workspace', run.workspace, '--case', TOY_PRD, '--faults', forged, ...common], { isolation: TEST_ISOLATION, sessionBinds: [{ path: dirname(fake.file), rw: true }], preflightProxy: PROXY });
    expect(lost.ok).toBe(false);
    expect(lost.sections.faults.checks.find((c: any) => c.id === 'fault:concurrent-commit:kept').ok).toBe(false);

    expect(await verifyRunMain(['--aggregate', runJson, '--faults', runJson])).toMatchObject({ ok: false, exit: 2 });
    expect(await runArmMain(['--case', TOY_PRD, '--arm', 'without'])).toMatchObject({ ok: false, exit: 2 });
    expect(await runArmMain(['--case', TOY_PRD, '--arm', 'without', '--out-dir', outDir, '--budget-seconds', '0'])).toMatchObject({ ok: false, exit: 2 });
  }, 300_000);

  describe('an interrupt in any phase is resumed by a fresh session of that phase', () => {
    const LATE = { kind: 'late-hidden-defect', trigger: { on: 'session-end' } };
    const plan = (...faults: unknown[]) => ({ schema: 'mycelink-bench/fault-plan@1', id: 'phases', faults });
    const sessionsOf = (run: any) => run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by]);
    const interrupts = (run: any) => run.faults.filter((f: any) => f.kind === 'interrupt-restart');
    const subjects = (run: any) => execFileSync('git', ['log', '--format=%s', `${toy.start}..HEAD`], { cwd: join(run.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim().split('\n').reverse();
    const AGENT_HISTORY = ['test: failing tests first', 'feat: orders reserve stock', 'chore: sync platform changes', 'test: regression for the QA report', 'fix: restore the behaviour QA reported'];

    it('interrupts the QA rework exactly 2 s in, resumes it with a fresh rework session, and verifies the repair', async () => {
      const fake = fakePlan({ reworkStalls: ['start'] });
      const run = await arm('without', fake, { faultPlan: plan({ kind: 'interrupt-restart', trigger: { on: 'elapsed-seconds', seconds: 2, phase: 'rework' } }, LATE), requireTdd: true });
      expect(sessionsOf(run)).toEqual([
        [1, 'task', 'task', 'exit'],
        [2, 'rework', 'rework', 'interrupt'],
        [3, 'rework-resume', 'rework', 'exit'],
      ]);
      expect(run.sessions[1].duration_ms).toBeGreaterThanOrEqual(2000);
      expect(run.sessions[1].duration_ms).toBeLessThan(15_000);
      const [, rework, resumed] = fake.entries();
      expect(rework.prompt_head).toMatch(/^QA ran its end-to-end checks/);
      expect(resumed.prompt).toBe(resumePrompt(rework.prompt));
      expect(interrupts(run)).toEqual([
        expect.objectContaining({
          applied: true,
          resumed: true,
          interrupted_session: { index: 2, purpose: 'rework', phase: 'rework', ended_by: 'interrupt' },
          successor_session: { index: 3, purpose: 'rework-resume', phase: 'rework', ended_by: 'exit' },
        }),
      ]);
      expect(run.phases.map((p: any) => [p.phase, p.sessions, p.ended_by])).toEqual([
        ['task', [1], 'exit'],
        ['rework', [2, 3], 'exit'],
      ]);
      expect(subjects(run)).toEqual(AGENT_HISTORY);
      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      expect(v.sections.faults.checks.map((c: any) => [c.id, c.ok])).toEqual([
        ['fault:late-hidden-defect:bound', true],
        ['fault:late-hidden-defect:kept', true],
        ['fault:interrupt-restart:resumed', true],
      ]);
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid']);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
    }, 300_000);

    it('resumes the rework wherever the interrupt finds it: after the regression test, after the fix', async () => {
      for (const [stage, count] of [['red', 1], ['green', 2]] as const) {
        const fake = fakePlan({ reworkStalls: [stage] });
        const run = await arm('without', fake, { faultPlan: plan({ kind: 'interrupt-restart', trigger: { on: 'commits', count, phase: 'rework' } }, LATE), requireTdd: true });
        expect(sessionsOf(run), stage).toEqual([
          [1, 'task', 'task', 'exit'],
          [2, 'rework', 'rework', 'interrupt'],
          [3, 'rework-resume', 'rework', 'exit'],
        ]);
        // The fresh session found what was done and finished the rest: one regression test, one fix.
        expect(subjects(run), stage).toEqual(AGENT_HISTORY);
        expect(interrupts(run)[0], stage).toMatchObject({ resumed: true, interrupted_session: { index: 2 }, successor_session: { index: 3 } });
        expect(run.ok, stage).toBe(true);
      }
    }, 600_000);

    it('a plan interrupt that comes due in the rework, not the task, is resumed there (the third pilot)', async () => {
      // The task commits twice; the plan's interrupt is due at the third agent commit, the rework's regression test.
      const fake = fakePlan({ reworkStalls: ['red'] });
      const run = await arm('without', fake, { faultPlan: plan({ kind: 'interrupt-restart', trigger: { on: 'commits', count: 3 } }, LATE) });
      expect(sessionsOf(run)).toEqual([
        [1, 'task', 'task', 'exit'],
        [2, 'rework', 'rework', 'interrupt'],
        [3, 'rework-resume', 'rework', 'exit'],
      ]);
      expect(run.ok).toBe(true);
    }, 300_000);

    it('an interrupt of the resumed rework is resumed again, and each interrupt fires once', async () => {
      const fake = fakePlan({ reworkStalls: ['start', 'red'] });
      const run = await arm('without', fake, {
        faultPlan: plan({ kind: 'interrupt-restart', trigger: { on: 'elapsed-seconds', seconds: 2, phase: 'rework' } }, { kind: 'interrupt-restart', trigger: { on: 'commits', count: 1, phase: 'rework' } }, LATE),
      });
      expect(sessionsOf(run)).toEqual([
        [1, 'task', 'task', 'exit'],
        [2, 'rework', 'rework', 'interrupt'],
        [3, 'rework-resume', 'rework', 'interrupt'],
        [4, 'rework-resume', 'rework', 'exit'],
      ]);
      expect(interrupts(run).map((f: any) => [f.interrupted_session.index, f.successor_session.index])).toEqual([
        [2, 3],
        [3, 4],
      ]);
      expect(subjects(run)).toEqual(AGENT_HISTORY);
      expect(run.ok).toBe(true);
    }, 300_000);

    it('a rework phase ends at its budget: a stalled fresh session is not extended, and the unrepaired defect fails', async () => {
      const fake = fakePlan({ reworkStalls: ['start', 'start'] });
      const run = await arm('without', fake, { faultPlan: plan({ kind: 'interrupt-restart', trigger: { on: 'elapsed-seconds', seconds: 2, phase: 'rework' } }, LATE), reworkBudgetSeconds: 6 });
      expect(sessionsOf(run)).toEqual([
        [1, 'task', 'task', 'exit'],
        [2, 'rework', 'rework', 'interrupt'],
        [3, 'rework-resume', 'rework', 'budget'],
      ]);
      expect(run.sessions[1].duration_ms + run.sessions[2].duration_ms).toBeLessThan(15_000);
      expect(run.phases.at(-1)).toMatchObject({ phase: 'rework', ended_by: 'budget' });
      expect(interrupts(run)[0]).toMatchObject({ resumed: true, successor_session: { index: 3, ended_by: 'budget' } });
      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      expect(v.sections.acceptance.ok).toBe(false);
      expect(run.ok).toBe(false);
    }, 300_000);
  });

  describe('the with arm, model-free: a stand-in host on the sealed Mycelink', () => {
    const FAKE_HOST = join(REPO_ROOT, 'tests', 'benchmark', 'fake-mycelink-host.mjs');
    const testOf = (path: string) => AGENT_TESTS[path]!;
    function hostPlan(extra: Record<string, unknown> = {}) {
      const dir = makeTmpDir('bench-a-host-');
      const log = join(dir, 'log.jsonl');
      writeFileSync(log, '');
      const file = join(dir, 'plan.json');
      const work = {
        'mod-a': { tests: { 'mod-a/test/reserve.test.mjs': testOf('mod-a/test/reserve.test.mjs') }, impl: { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] } },
        'mod-b': { tests: { 'mod-b/test/place.test.mjs': testOf('mod-b/test/place.test.mjs') }, impl: { 'mod-b/src/orders.mjs': TOY.referenceCode['mod-b/src/orders.mjs'] } },
      };
      // QA's rework: a regression test for what the late defect broke, then the fix (the module's production again).
      const regression = {
        'mod-a': { 'mod-a/test/reserve.test.mjs': `${testOf('mod-a/test/reserve.test.mjs')}test('reserving two takes two out of the stock', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });\n});\n` },
        'mod-b': { 'mod-b/test/place.test.mjs': `${testOf('mod-b/test/place.test.mjs')}test('an order of two leaves the rest', () => {\n  assert.deepEqual(placeOrder(5, 2), { status: 'placed', stock: 3 });\n});\n` },
      };
      writeFileSync(file, JSON.stringify({ log, work, regression, ...extra }));
      return { dir, file, entries: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
    }
    const DEFAULT_SHAPE = (interrupt: unknown) => ({
      schema: 'mycelink-bench/fault-plan@1',
      id: 'with-faults',
      faults: [
        { kind: 'concurrent-commit', trigger: { on: 'first-commit' } },
        { kind: 'interrupt-restart', trigger: interrupt },
        { kind: 'duplicate-result', trigger: { on: 'session-end' } },
        { kind: 'stale-result', trigger: { on: 'session-end' } },
        { kind: 'late-hidden-defect', trigger: { on: 'session-end' } },
      ],
    });

    it('works every fault of the plan: teammate commit, replayed settles, late defect, an interrupt 2 s into the rework, and a Mycelink rework that delivers C002', async () => {
      const fake = hostPlan({ reworkStalls: ['start'] });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: DEFAULT_SHAPE({ on: 'elapsed-seconds', seconds: 2, phase: 'rework' }), requireMycelink: true, requireTdd: true });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by])).toEqual([
        [1, 'task', 'task', 'exit'],
        [2, 'rework', 'rework', 'interrupt'],
        [3, 'rework-resume', 'rework', 'exit'],
      ]);
      const byKind = Object.fromEntries(run.faults.map((f: any) => [f.kind, f]));
      expect(byKind['concurrent-commit']).toMatchObject({ applied: true, path: 'TEAM-NOTES.md', sync: 'done' });
      for (const kind of ['duplicate-result', 'stale-result']) expect(byKind[kind], kind).toMatchObject({ applied: true, state_changed: false, effect: expect.stringMatching(/^(receipt|refused|stale)$/) });
      expect(byKind['late-hidden-defect']).toMatchObject({ applied: true, module: 'mod-a' });
      expect(byKind['late-hidden-defect'].reported.length).toBeGreaterThan(0);
      expect(byKind['interrupt-restart']).toMatchObject({ resumed: true, interrupted_session: { index: 2, phase: 'rework' }, successor_session: { index: 3, phase: 'rework', ended_by: 'exit' } });

      // As in the third pilot, the teammate commit reached the delivery through an integration merge.
      const inRepo = (args: string[]) => execFileSync('git', args, { cwd: join(run.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
      expect(inRepo(['log', '--merges', '--format=%P', `${toy.start}..main`]).split('\n').some((parents) => parents.split(' ').includes(byKind['concurrent-commit'].commit))).toBe(true);
      // The task delivered C001; the late defect made it stale; the rework delivered C002 at the delivery branch's head.
      const head = inRepo(['rev-parse', 'main']);
      expect(run.phases.map((p: any) => [p.phase, p.sessions, p.ended_by, p.mycelink.complete, p.mycelink.candidate])).toEqual([
        ['task', [1], 'exit', true, 'TOY-001-C001'],
        ['rework', [2, 3], 'exit', true, 'TOY-001-C002'],
      ]);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002', candidate_sha: head, branch_head: head, incomplete: [] });
      expect(run.controller).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: true });

      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      const failing = Object.entries(v.sections).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));
      expect(failing).toEqual([]);
      expect(v.sections.scope.checks.find((c: any) => c.id === 'fault-owned:TEAM-NOTES.md')).toMatchObject({ ok: true, severity: 'warning' });
      expect(v.sections.orchestration.checks.find((c: any) => c.id === 'candidate-equals-delivery:TOY-001')).toMatchObject({ ok: true });
      expect(v.sections.faults.checks.every((c: any) => c.ok)).toBe(true);
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid', 'valid']);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
      // The run's own evidence holds: no evaluator access, no plugin exposure, no survivor. What keeps it from
      // `verified` here is this harness's setup alone — no suite pin (the library is called directly), a toy
      // qualified on one file system, and off Linux no boundary — never the delivery.
      expect(run.evaluator_access).toMatchObject({ hits: [], probes: [] });
      expect(run.plugin_exposure).toEqual([]);
      expect(run.delivery).toEqual({ ok: true, failures: [] });
      expect(run.trust.problems).toEqual(
        ISOLATED
          ? ['the verification is not trusted: suite_pinned, qualification_filesystems']
          : ['sessions ran outside the isolation boundary', 'a session ran unconfined', 'the verification is not trusted: isolation, suite_pinned, qualification_filesystems'],
      );
    }, 900_000);

    it('the fourth pilot’s shape: an interrupted task resumed to C001, the exact late defect, and a controller rework through the producer node that delivers C002', async () => {
      // The task is interrupted at its first commit, mod-a's test after its RED; a fresh session resumes it.
      const fake = hostPlan({ taskStalls: ['red'] });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: DEFAULT_SHAPE({ on: 'commits', count: 1, phase: 'task' }), requireMycelink: true, requireTdd: true });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by])).toEqual([
        [1, 'task', 'task', 'interrupt'],
        [2, 'resume', 'task', 'exit'],
        [3, 'rework', 'rework', 'exit'],
      ]);
      const byKind = Object.fromEntries(run.faults.map((f: any) => [f.kind, f]));
      expect(byKind['interrupt-restart']).toMatchObject({
        applied: true,
        resumed: true,
        interrupted_session: { index: 1, purpose: 'task', phase: 'task', ended_by: 'interrupt' },
        successor_session: { index: 2, purpose: 'resume', phase: 'task', ended_by: 'exit' },
      });
      expect(byKind['concurrent-commit']).toMatchObject({ applied: true, path: 'TEAM-NOTES.md', sync: 'done' });
      for (const kind of ['duplicate-result', 'stale-result']) expect(byKind[kind], kind).toMatchObject({ applied: true, state_changed: false });
      const defect = byKind['late-hidden-defect'];
      expect(defect).toMatchObject({ applied: true, module: 'mod-a', paths: ['mod-a/src/stock.mjs'] });
      expect(defect.reported.length).toBeGreaterThan(0);

      const repo = join(run.workspace, 'repos', 'toyshop');
      const inRepo = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      // The defect is exactly the revert of mod-a's delivered production: each path as the start had it.
      const blobAt = (rev: string, path: string) => inRepo(['ls-tree', rev, '--', path]);
      for (const path of defect.paths) expect(blobAt(defect.commit, path), path).toBe(blobAt(toy.start, path));
      expect(inRepo(['diff', '--name-only', defect.parent, defect.commit])).toBe('mod-a/src/stock.mjs');

      // The resumed task recovered the key and delivered C001; the rework delivered C002 at main's head.
      const head = inRepo(['rev-parse', 'main']);
      expect(run.phases.map((p: any) => [p.phase, p.sessions, p.ended_by, p.mycelink.complete, p.mycelink.candidate])).toEqual([
        ['task', [1, 2], 'exit', true, 'TOY-001-C001'],
        ['rework', [3], 'exit', true, 'TOY-001-C002'],
      ]);
      expect(run.phases[0].mycelink).toMatchObject({ authority_recovered: true, incomplete: [] });
      expect(run.phases[0].mycelink.candidate_sha).toBe(defect.parent);
      // What the run reports after every fault is C002, bound to the delivered head.
      for (const summary of [run.phases[1].mycelink, run.mycelink]) expect(summary).toMatchObject({ complete: true, candidate: 'TOY-001-C002', candidate_sha: head, branch_head: head, incomplete: [] });
      expect(run.controller).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: true });
      expect(run.sessions[2].controller_edits).toEqual([]);

      // The rework session, as the controller: status, the producer node of what moved since the delivery, its rework, then dispatch, deliver, verify.
      const events = readFileSync(run.sessions[2].transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const calls = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c: any) => c.type === 'tool_use').map((c: any) => ({ ...c, parent: e.parent_tool_use_id })));
      const controller = calls.filter((c: any) => c.parent === null);
      const at = (pattern: RegExp) => controller.findIndex((c: any) => c.name === 'Bash' && pattern.test(c.input.command));
      const steps = [/ feature status TOY-001 /, / feature owners TOY-001 --since-delivery /, / node rework TOY-001 TOY-001\.mod-a\.impl /, / dispatch TOY-001 /, / deliver TOY-001 /, / feature verify TOY-001 --delivered /].map(at);
      expect(steps.every((i) => i >= 0)).toBe(true);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
      // Each reopened producer is a fresh module-worker: the reworked one proves RED, commits its test alone, then GREEN and its production alone.
      const agents = controller.filter((c: any) => c.name === 'Agent');
      // The plugin's reviewer, recorded apart from the workers: C001's review and the repair's, both passed.
      expect(run.reviewers.map((r: any) => [r.review_id, r.verdict?.overall, r.settlement?.outcome])).toEqual([['TOY-001-R001', 'PASS', 'PASS'], ['TOY-001-R002', 'PASS', 'PASS']]);
      expect(run.workers.every((w: any) => w.node_id !== null)).toBe(true);
      // The reopened producers' fresh workers, then the acceptance review of the repair before C002.
      expect(agents.map((c: any) => c.input.description)).toEqual(['TOY-001.mod-a.impl', 'TOY-001.mod-b.impl', 'acceptance review TOY-001-R002']);
      const workerSteps = calls
        .filter((c: any) => c.parent === agents[0].id)
        .map((c: any) => (/\btdd (red|green|regression)\b/.exec(c.input.command)?.[1] ?? (/ commit /.test(c.input.command) ? 'commit' : null)))
        .filter(Boolean);
      expect(workerSteps).toEqual(['red', 'commit', 'green', 'commit', 'regression']);
      const [test, fix] = inRepo(['log', '--no-merges', '--format=%H', '--reverse', `${defect.commit}..main`, '--', 'mod-a']).split('\n');
      expect(inRepo(['diff', '--name-only', `${test}~1`, test!])).toBe('mod-a/test/reserve.test.mjs');
      expect(inRepo(['diff', '--name-only', `${fix}~1`, fix!])).toBe('mod-a/src/stock.mjs');
      expect(inRepo(['rev-parse', `${fix}~1`])).toBe(test);
      // The regression test was written on top of the defect: RED against exactly what QA reported.
      expect(inRepo(['merge-base', defect.commit, test!])).toBe(defect.commit);

      // Mycelink's own record: the rework of the producer node invalidated C001; C002 was built, accepted and delivered.
      const control = join(run.workspace, 'platform');
      const state = JSON.parse(readFileSync(join(control, 'features', 'TOY-001', 'STATE.json'), 'utf8')).data;
      expect(state.reworks.map((r: any) => [r.node_id, r.invalidated_candidate, r.reopened])).toEqual([
        ['TOY-001.mod-a.impl', 'TOY-001-C001', ['TOY-001.mod-a.impl', 'TOY-001.mod-b.impl', 'TOY-001.release.candidate.build']],
      ]);
      for (const name of defect.reported) expect(state.reworks[0].reason).toContain(name);
      expect(state).toMatchObject({ current_candidate: 'TOY-001-C002', feature_state: 'COMPLETED' });
      expect(Object.keys(state.accepted_deliveries)).toContain('TOY-001-C002');
      const verified = execFileSync(process.execPath, [join(run.plugin.dir, 'bin', 'mycelink.mjs'), 'feature', 'verify', 'TOY-001', '--delivered', '--control-root', control, '--json'], { encoding: 'utf8' });
      expect(JSON.parse(verified)).toEqual({ ok: true, problems: [] });

      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      const failing = Object.entries(v.sections).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));
      expect(failing).toEqual([]);
      expect(v.sections.orchestration.checks.find((c: any) => c.id === 'candidate-equals-delivery:TOY-001')).toMatchObject({ ok: true });
      // The injected commits are in no cycle, yet each is still exactly the commit its record binds.
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid', 'valid']);
      expect(v.sections.tdd.units.flatMap((u: any) => u.commits)).not.toEqual(expect.arrayContaining([byKind['concurrent-commit'].commit]));
      expect(v.sections.tdd.units.flatMap((u: any) => u.commits)).not.toEqual(expect.arrayContaining([defect.commit]));
      expect(v.sections.tdd.injections.map((x: any) => [x.kind, x.commit, x.ok])).toEqual([
        ['concurrent-commit', byKind['concurrent-commit'].commit, true],
        ['late-hidden-defect', defect.commit, true],
      ]);
      expect(v.sections.faults.checks.every((c: any) => c.ok)).toBe(true);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
      expect(run.delivery).toEqual({ ok: true, failures: [] });
    }, 900_000);

    const LATE_ONLY = { schema: 'mycelink-bench/fault-plan@1', id: 'late', faults: [{ kind: 'late-hidden-defect', trigger: { on: 'session-end' } }] };

    /** The rework session's top-level tool calls and its worker calls, from its stream. */
    const callsOf = (transcript: string) => {
      const events = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c: any) => c.type === 'tool_use').map((c: any) => ({ ...c, parent: e.parent_tool_use_id })));
    };
    const failingOf = (v: any) => Object.entries(v.sections).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));
    /** The PCM-103 controller's own reviews: mod-a's first worker under-implements; two reworks before C001 finish it. */
    const REVIEWED = () => {
      const reserve = testOf('mod-a/test/reserve.test.mjs');
      const t1 = `${reserve}test('reserving two out of five leaves three', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });\n});\n`;
      const t2 = `${t1}test('reserving four reserves four', () => {\n  assert.deepEqual(reserve(9, 4), { stock: 5, reserved: 4 });\n});\n`;
      const qa = `${t2}test('reserving one out of seven leaves six', () => {\n  assert.deepEqual(reserve(7, 1), { stock: 6, reserved: 1 });\n});\n`;
      return {
        draft: { 'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock: stock - 3, reserved: qty };\n}\n' },
        reviews: {
          'mod-a': [
            { reason: 'own review: reserving two out of five must leave three in stock', tests: { 'mod-a/test/reserve.test.mjs': t1 }, impl: { 'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock: stock - qty, reserved: Math.min(qty, 3) };\n}\n' } },
            { reason: 'own review: reserving four must reserve all four', tests: { 'mod-a/test/reserve.test.mjs': t2 }, impl: { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] } },
          ],
        },
        regression: { 'mod-a/test/reserve.test.mjs': qa },
      };
    };

    it('the PCM-103 shape: two own reviews before C001, an interrupted task, the late defect, and /mycelink:rework reworks the producer a third time to C002', async () => {
      const r = REVIEWED();
      const fake = hostPlan({ taskStalls: ['red'], reworkVia: 'command', reviews: r.reviews });
      // mod-a's first worker writes the draft; QA's regression keeps every reviewed test.
      const plan = JSON.parse(readFileSync(fake.file, 'utf8'));
      plan.work['mod-a'].draft = r.draft;
      plan.regression['mod-a'] = r.regression;
      writeFileSync(fake.file, JSON.stringify(plan));
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: DEFAULT_SHAPE({ on: 'commits', count: 1, phase: 'task' }), requireMycelink: true, requireTdd: true });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by])).toEqual([
        [1, 'task', 'task', 'interrupt'],
        [2, 'resume', 'task', 'exit'],
        [3, 'rework', 'rework', 'exit'],
      ]);
      const defect = run.faults.find((f: any) => f.kind === 'late-hidden-defect');
      expect(defect).toMatchObject({ applied: true, module: 'mod-a', affected: { module: 'mod-a', path: 'mod-a', repository: 'repos/toyshop' } });
      // QA's report names the module, then the plugin's rework command as the first action.
      const qa = fake.entries()[2].prompt;
      expect(qa).toBe(qaPrompt(qa, defect, casePrompt({ project, prd })));
      expect(qa).toContain('QA traced the failing checks to the module `mod-a` (`mod-a/`) of the repository `repos/toyshop/`.');

      // The rework session: the command first, then status, the one-step attribution, dispatch, deliver, verify; no edit of its own.
      const calls = callsOf(run.sessions[2].transcript);
      const top = calls.filter((c: any) => c.parent === null);
      expect(top[0]).toMatchObject({ name: 'Skill', input: { skill: 'mycelink:rework' } });
      const at = (pattern: RegExp) => top.findIndex((c: any) => c.name === 'Bash' && pattern.test(c.input.command));
      const steps = [/ controller open /, / feature status TOY-001 /, / feature rework TOY-001 --since-delivery toyshop:mod-a\/ /, / dispatch TOY-001 /, / deliver TOY-001 /, / feature verify TOY-001 --delivered /].map(at);
      expect(steps.every((i) => i > 0), String(steps)).toBe(true);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
      expect(run.sessions[2].controller_edits).toEqual([]);
      const agents = top.filter((c: any) => c.name === 'Agent');
      // The reopened producers' fresh workers, then the acceptance review of the repair before C002.
      expect(agents.map((c: any) => c.input.description)).toEqual(['TOY-001.mod-a.impl', 'TOY-001.mod-b.impl', 'acceptance review TOY-001-R002']);
      const workerSteps = calls.filter((c: any) => c.parent === agents[0].id).map((c: any) => /\btdd (red|green|regression)\b/.exec(c.input.command)?.[1] ?? (/ commit /.test(c.input.command) ? 'commit' : null)).filter(Boolean);
      expect(workerSteps).toEqual(['red', 'commit', 'green', 'commit', 'regression']);

      // Mycelink's record: two own reviews before C001, then QA's rework of the same node after it was accepted.
      const control = join(run.workspace, 'platform');
      const state = JSON.parse(readFileSync(join(control, 'features', 'TOY-001', 'STATE.json'), 'utf8')).data;
      expect(state.reworks.map((x: any) => [x.node_id, x.invalidated_candidate, x.delivered])).toEqual([
        ['TOY-001.mod-a.impl', null, false],
        ['TOY-001.mod-a.impl', null, false],
        ['TOY-001.mod-a.impl', 'TOY-001-C001', true],
      ]);
      expect(state.nodes['TOY-001.mod-a.impl'].rework_history).toHaveLength(3);
      for (const name of defect.reported) expect(state.reworks[2].reason).toContain(name);
      expect(state).toMatchObject({ current_candidate: 'TOY-001-C002', feature_state: 'COMPLETED' });
      const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(run.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002', candidate_sha: head, branch_head: head, incomplete: [] });
      expect(run.controller).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: true });

      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      expect(failingOf(v)).toEqual([]);
      // mod-a's three cycles before C001, mod-b's, and QA's regression: each test-first.
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid', 'valid', 'valid', 'valid']);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
      expect(run.delivery).toEqual({ ok: true, failures: [] });
    }, 900_000);

    it('a first rework session whose revert lands on main is stopped and rolled back; a corrective session reworks through Mycelink to C002, and the violation stays on the record', async () => {
      // A host that runs no plugin hook: the revert lands, and the harness finds it in the workspace, stops it and rolls it back.
      const fake = hostPlan({ reworkDirect: [true, false], reworkVia: 'command', hooks: false });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by, s.corrects ?? null])).toEqual([
        [1, 'task', 'task', 'exit', null],
        [2, 'rework', 'rework', 'controller-violation', null],
        [3, 'rework-corrective', 'rework', 'exit', 2],
      ]);
      expect(run.phases.map((p: any) => [p.phase, p.sessions, p.ended_by])).toEqual([
        ['task', [1], 'exit'],
        ['rework', [2, 3], 'exit'],
      ]);
      expect(run.sessions[1].duration_ms).toBeLessThan(60_000);
      expect(run.sessions[1].controller_edits.map((e: any) => [e.tool, e.action])).toEqual([['Bash', 'git revert']]);
      // Rolled back exactly: main is at the defect again, the revert reachable from no ref, the files as QA found them.
      const defect = run.faults.find((f: any) => f.kind === 'late-hidden-defect');
      const repo = join(run.workspace, 'repos', 'toyshop');
      const inRepo = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      const txn = run.sessions[1].controller_txn;
      expect(txn).toMatchObject({ violation: true, mode: 'selective', rollback: { verified: true } });
      const moved = txn.rollback.refs.find((r: any) => r.ref === 'refs/heads/main');
      expect(moved).toMatchObject({ to: defect.commit });
      expect(inRepo(['log', '-1', '--format=%s', moved.from])).toMatch(/^Revert /);
      expect(inRepo(['branch', '--contains', moved.from])).toBe('');
      expect(inRepo(['for-each-ref', '--contains', moved.from])).toBe('');
      // The corrective prompt: already undone, /mycelink:rework first, what was undone by path, then QA's report byte for byte.
      const [, rework, corrective] = fake.entries();
      const v2 = run.sessions[1].violation;
      expect(corrective.prompt).toBe(correctivePrompt(rework.prompt, { summary: v2.summary, mode: v2.mode, discarded: [] }));
      expect(corrective.prompt.startsWith(CORRECTIVE_PROMPT)).toBe(true);
      expect(run.sessions[2].prompt_sha256).toBe(sha(corrective.prompt));
      // It went through Mycelink: the command, the producer node, its worker RED -> GREEN, C002 delivered.
      const calls = callsOf(run.sessions[2].transcript);
      const top = calls.filter((c: any) => c.parent === null);
      expect(top[0]).toMatchObject({ name: 'Skill', input: { skill: 'mycelink:rework' } });
      expect(top.some((c: any) => c.name === 'Bash' && / feature rework TOY-001 --since-delivery toyshop:mod-a\/ /.test(c.input.command))).toBe(true);
      expect(run.sessions[2].controller_edits).toEqual([]);
      expect(run.sessions[2].violation ?? null).toBeNull();
      const agent = top.find((c: any) => c.name === 'Agent' && c.input.description === 'TOY-001.mod-a.impl');
      expect(calls.filter((c: any) => c.parent === agent.id).map((c: any) => /\btdd (red|green|regression)\b/.exec(c.input.command)?.[1] ?? (/ commit /.test(c.input.command) ? 'commit' : null)).filter(Boolean)).toEqual(['red', 'commit', 'green', 'commit', 'regression']);
      const head = inRepo(['rev-parse', 'main']);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002', candidate_sha: head, branch_head: head });
      expect(inRepo(['merge-base', defect.commit, head])).toBe(defect.commit);
      // Recorded and recovered, not failed.
      expect(run.controller).toMatchObject({
        ok: true,
        failures: [],
        recovered: [expect.stringMatching(/^controller-violation: session 2 \(rework\) changed the workspace itself: repos\/toyshop\/\.git:refs\/heads\/main \(moved from [0-9a-f]{12} to [0-9a-f]{12}; a product repository's ref\).*; stopped there; rolled back \(selective, verified\)\. Recovered by session 3 \(rework-corrective\), which completed it through Mycelink to TOY-001-C002$/)],
      });
      expect(run.delivery).toEqual({ ok: true, failures: [], recovered: run.controller.recovered });
      // Its rollback attested at the run's end: the manifest recorded, the revert reachable from no ref, nothing left.
      expect(run.controller_rollbacks).toMatchObject({ ok: true, problems: [], sessions: [{ session: 2, ok: true, mode: 'selective', manifest_sha256: v2.manifest_sha256 }] });
      expect(run.trust.problems.filter((p: string) => /controller rollback/.test(p))).toEqual([]);
      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      expect(failingOf(v)).toEqual([]);
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid', 'valid']);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
    }, 900_000);

    it('a revert the plugin’s fence refused changed nothing: no violation, and the controller repairs through Mycelink to C002 (r9: blocked is not done)', async () => {
      const fake = hostPlan({ reworkDirect: true, reworkVia: 'command' });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, Boolean(s.violation)])).toEqual([
        [1, 'task', 'exit', false],
        [2, 'rework', 'exit', false],
      ]);
      const events = readFileSync(run.sessions[1].transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const revert = callsOf(run.sessions[1].transcript).find((c: any) => c.name === 'Bash' && /\bgit -C .* revert\b/.test(c.input.command));
      const result = events.flatMap((e: any) => (e.type === 'user' ? e.message.content : [])).find((c: any) => c.tool_use_id === revert.id);
      expect(result).toMatchObject({ is_error: true, content: expect.stringMatching(/^Blocked: /) });
      expect(run.sessions[1].controller_edits).toEqual([]);
      expect(run.sessions[1].fence_blocks).toBe(1);
      expect(run.sessions[1].controller_txn).toMatchObject({ violation: false, mode: 'none' });
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002' });
      expect(run.controller).toMatchObject({ ok: true, failures: [], recovered: [] });
      expect(run.ok).toBe(true);
    }, 900_000);

    it('the same revert again in the corrective session ends the phase: an identical repeat is terminal (the fourth pilot)', async () => {
      const fake = hostPlan({ reworkDirect: true, hooks: false });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by])).toEqual([
        [1, 'task', 'task', 'exit'],
        [2, 'rework', 'rework', 'controller-violation'],
        [3, 'rework-corrective', 'rework', 'controller-violation'],
      ]);
      // Stopped at the change, not when it would have ended: each was to carry on for ten minutes.
      for (const s of run.sessions.slice(1)) expect(s.duration_ms).toBeLessThan(60_000);
      expect(run.sessions[2].terminal).toBe('identical-violation');
      // Both rolled back: main is at the defect.
      const defect = run.faults.find((f: any) => f.kind === 'late-hidden-defect');
      expect(execFileSync('git', ['rev-parse', 'main'], { cwd: join(run.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim()).toBe(defect.commit);
      expect(run.phases.map((p: any) => [p.phase, p.ended_by])).toEqual([
        ['task', 'exit'],
        ['rework', 'controller-violation'],
      ]);
      expect(run.controller.ok).toBe(false);
      expect(run.controller.recovered).toEqual([]);
      expect(run.controller.failures).toEqual([
        expect.stringMatching(/^controller-violation: session 2 \(rework\) changed the workspace itself: .*rolled back \(selective, verified\)\. /),
        expect.stringMatching(/^controller-violation: session 3 \(rework-corrective\) changed the workspace itself: .*The phase ended: the same violation as before\. /),
      ]);
      expect(run.delivery.failures.slice(0, 2)).toEqual(run.controller.failures.map((f: string) => `controller:${f}`));
      // A controller failure, not untrusted evidence: both rollbacks attested.
      expect(run.controller_rollbacks).toMatchObject({ ok: true, problems: [], sessions: [{ session: 2, ok: true }, { session: 3, ok: true }] });
      expect(run.trust.problems.filter((p: string) => /controller rollback/.test(p))).toEqual([]);
      expect(run.ok).toBe(false);
      expect(run.sessions[0].controller_edits).toEqual([]);
    }, 900_000);

    /**
     * CSET-202 r2's shape in the task: while a module-worker runs, the
     * controller writes into that worker's result slot itself. With the
     * plugin's fence the write is refused and nothing happened; where it
     * lands (no hook ran), the harness sees the worktree it reached into
     * changed, stops the session, discards that dispatch through Mycelink
     * (claim handed back unspent, worktree removed, branch archived) and a
     * corrective session re-dispatches the node to a fresh worker to C001.
     */
    it('a task controller’s write to a running worker’s result slot, refused by the fence, is no violation', async () => {
      const fake = hostPlan({ taskTakeover: [true] });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, Boolean(s.violation)])).toEqual([[1, 'task', 'exit', false]]);
      expect(run.sessions[0].fence_blocks).toBe(1);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001' });
      expect(run.ok).toBe(true);
    }, 900_000);

    it('one that lands contaminates the worktree: the dispatch is discarded through Mycelink and a corrective session re-dispatches a fresh worker to C001', async () => {
      const fake = hostPlan({ taskTakeover: [true, false], hooks: false });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by, s.corrects ?? null])).toEqual([
        [1, 'task', 'task', 'controller-violation', null],
        [2, 'corrective', 'task', 'exit', 1],
      ]);
      expect(run.sessions[0].duration_ms).toBeLessThan(60_000);
      const [edit] = run.sessions[0].controller_edits;
      expect(edit).toMatchObject({ tool: 'Write', action: 'Write', path: expect.stringMatching(/\.mycelink\/worktrees\/[^/]+TOY-001\.mod-a\.impl\/\.mycelink-worker\/result-[0-9a-f-]+\.json$/) });
      const v1 = run.sessions[0].violation;
      expect(v1.discarded).toEqual([expect.objectContaining({ node_id: 'TOY-001.mod-a.impl', discarded: true, archived_ref: expect.stringMatching(/^refs\/mycelink\/archive\//) })]);
      expect(run.sessions[0].controller_txn.contaminated).toEqual([expect.stringMatching(/platform\/\.mycelink\/worktrees\/[^/]+TOY-001\.mod-a\.impl$/)]);
      const repo = join(run.workspace, 'repos', 'toyshop');
      const inRepo = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      const archived = v1.discarded[0].archived_ref;
      expect(existsSync(v1.discarded[0].worktree)).toBe(false);
      // The corrective prompt names the discarded dispatch; /mycelink:run comes first.
      const [, corrective] = fake.entries();
      expect(corrective.prompt).toBe(taskCorrectivePrompt(fake.entries()[0].prompt, { summary: v1.summary, mode: v1.mode, discarded: ['TOY-001.mod-a.impl'] }, 'TOY-001'));
      expect(corrective.prompt.startsWith(TASK_CORRECTIVE_PROMPT)).toBe(true);
      // A fresh, genuine worker: a new claim on a new branch, RED -> GREEN -> regression, its own commits only.
      const calls = callsOf(run.sessions[1].transcript);
      const top = calls.filter((c: any) => c.parent === null);
      expect(top.some((c: any) => c.name === 'Bash' && / controller open --recover /.test(c.input.command))).toBe(true);
      const agent = top.find((c: any) => c.name === 'Agent' && c.input.description === 'TOY-001.mod-a.impl');
      expect(calls.filter((c: any) => c.parent === agent.id).map((c: any) => /\btdd (red|green|regression)\b/.exec(c.input.command ?? '')?.[1] ?? (/ commit /.test(c.input.command ?? '') ? 'commit' : null)).filter(Boolean)).toEqual(['red', 'commit', 'green', 'commit', 'regression']);
      expect(run.sessions[1].violation ?? null).toBeNull();
      const head = inRepo(['rev-parse', 'main']);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001', candidate_sha: head });
      expect(inRepo(['branch', '--contains', archived])).toBe('');
      expect(run.controller).toMatchObject({
        ok: true,
        failures: [],
        recovered: [expect.stringMatching(/^controller-violation: session 1 \(task\) changed the workspace itself: .*\.mycelink-worker\/result-[0-9a-f-]+\.json .*rolled back \(selective, verified\); the dispatch of TOY-001\.mod-a\.impl discarded through Mycelink\. Recovered by session 2 \(corrective\), which completed it through Mycelink to TOY-001-C001$/)],
      });
      // Attested: the dispatch discarded, nothing the controller wrote into the worktree left.
      expect(run.controller_rollbacks).toMatchObject({ ok: true, problems: [], sessions: [{ session: 1, ok: true, mode: 'selective', manifest_sha256: v1.manifest_sha256 }] });
      expect(run.trust.problems.filter((p: string) => /controller rollback/.test(p))).toEqual([]);
      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      expect(failingOf(v)).toEqual([]);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
    }, 900_000);

    it('a third violation ends the task: two corrective sessions at most', async () => {
      const fake = hostPlan({ taskTakeover: [true, true, true], hooks: false });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by])).toEqual([
        [1, 'task', 'controller-violation'],
        [2, 'corrective', 'controller-violation'],
        [3, 'corrective', 'controller-violation'],
      ]);
      expect(run.sessions[2].terminal).toBe('corrective-limit');
      expect(run.controller.ok).toBe(false);
      expect(run.controller.recovered).toEqual([]);
      expect(run.controller.failures).toHaveLength(3);
      expect(run.controller.failures[2]).toMatch(/The phase ended: no corrective session is left\./);
      expect(run.controller_rollbacks).toMatchObject({ ok: true, problems: [], sessions: [{ session: 1, ok: true }, { session: 2, ok: true }, { session: 3, ok: true }] });
      expect(run.ok).toBe(false);
    }, 900_000);

    it('QA’s report is the same bytes in both arms, but for the defect commit; the control arm still repairs directly, test-first', async () => {
      const without = fakePlan();
      const plain = await arm('without', without, { faultPlan: LATE_ONLY, requireTdd: true });
      const host = hostPlan({ reworkVia: 'command' });
      const plugin = await arm('with', host, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true, requireTdd: true });
      const promptOf = (entries: any[]) => entries.find((e) => /^QA ran its end-to-end checks/.test(e.prompt)).prompt as string;
      const defectOf = (run: any) => run.faults.find((f: any) => f.kind === 'late-hidden-defect');
      const a = promptOf(without.entries());
      const b = promptOf(host.entries());
      const original = casePrompt({ project, prd });
      expect(a).toBe(qaPrompt(a, defectOf(plain), original));
      expect(b).toBe(qaPrompt(b, defectOf(plugin), original));
      expect(a.replace(defectOf(plain).commit.slice(0, 12), '<commit>')).toBe(b.replace(defectOf(plugin).commit.slice(0, 12), '<commit>'));
      // Nothing beyond QA's checks and the public module: no file the defect touched, nothing of how it was made.
      for (const text of [a, b]) {
        expect(text.split('\n\nThe original request follows.')[0]).not.toMatch(/stock\.mjs|revert|inject|hidden|mutant|evaluator|reference/i);
      }
      // No plugin, no controller: the without arm's session repaired main itself, test-first, and verified.
      expect(plain.sessions.map((s: any) => [s.purpose, s.ended_by])).toEqual([
        ['task', 'exit'],
        ['rework', 'exit'],
      ]);
      expect(plain.controller).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: false });
      expect(plain.ok).toBe(true);
      expect(plugin.ok).toBe(true);
      expect(plugin.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002' });
    }, 900_000);

    it('a rework session that exits 0 without C002 and its delivery stays an explicit controller failure', async () => {
      const fake = hostPlan({ reworkNoop: true });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true });
      expect(run.sessions.map((s: any) => [s.purpose, s.ended_by, s.exit_code])).toEqual([
        ['task', 'exit', 0],
        ['rework', 'exit', 0],
      ]);
      expect(run.sessions[1].controller_edits).toEqual([]);
      expect(run.phases.map((p: any) => [p.phase, p.mycelink.complete, p.mycelink.candidate])).toEqual([
        ['task', true, 'TOY-001-C001'],
        ['rework', false, 'TOY-001-C001'],
      ]);
      expect(run.controller.failures).toEqual([expect.stringMatching(/^exited-incomplete: session 2 \(rework\) exited 0 with TOY-001 incomplete: candidate TOY-001-C001 binds toyshop at [0-9a-f]{12}, main is at [0-9a-f]{12}$/)]);
      expect(run.mycelink).toMatchObject({ complete: false, candidate: 'TOY-001-C001' });
      expect(run.verdict).not.toBe('verified');
    }, 600_000);

    it('resumes a Mycelink rework the interrupt stopped after its worker’s regression test, and after its fix', async () => {
      for (const [stage, count] of [['red', 1], ['green', 2]] as const) {
        const fake = hostPlan({ reworkStalls: [stage] });
        const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: DEFAULT_SHAPE({ on: 'commits', count, phase: 'rework' }), requireMycelink: true, requireTdd: true });
        expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by]), stage).toEqual([
          [1, 'task', 'exit'],
          [2, 'rework', 'interrupt'],
          [3, 'rework-resume', 'exit'],
        ]);
        expect(run.mycelink, stage).toMatchObject({ complete: true, candidate: 'TOY-001-C002', incomplete: [] });
        expect(run.controller, stage).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: true });
        const v = JSON.parse(readFileSync(run.verification, 'utf8'));
        expect(v.sections.tdd.units.map((u: any) => u.verdict), stage).toEqual(['valid', 'valid', 'valid']);
        expect(v.ok, stage).toBe(true);
        expect(run.ok, stage).toBe(true);
      }
    }, 1_800_000);
  });

  it('has QA report only the hidden checks the late defect broke, never ones the delivery already failed', async () => {
    const plan = { schema: 'mycelink-bench/fault-plan@1', id: 'late', faults: [{ kind: 'late-hidden-defect', trigger: { on: 'session-end' } }] };
    // The delivery never rejects too-large orders: that hidden check fails before any defect.
    const code = { ...TOY.referenceCode, ...TOY.mutants['no-reject'] };
    const fake = fakePlan({ code });
    const run = await arm('without', fake, { faultPlan: plan });
    const defect = run.faults.find((f: any) => f.kind === 'late-hidden-defect');
    expect(defect).toMatchObject({ applied: true, module: 'mod-a' });
    expect(defect.reported).toEqual(['AC-1 reserving reduces the stock', 'AC-2 an order reports the remaining stock']);
    expect(defect.already_failing).toBe(1);
    const rework = fake.entries().find((e: any) => e.prompt_head.startsWith('QA ran'));
    expect(rework.prompt).not.toContain('larger than the stock');
  }, 240_000);

  it('finishes a teammate commit the agent’s locked index delayed, without landing a second one', async () => {
    const plan = { schema: 'mycelink-bench/fault-plan@1', id: 'locked', faults: [{ kind: 'concurrent-commit', trigger: { on: 'first-commit' } }] };
    const run = await arm('without', fakePlan({ holdIndexLockMs: 1500, pauseMs: 1500 }), { faultPlan: plan });
    const injected = run.faults.filter((f: any) => f.kind === 'concurrent-commit');
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ applied: true, sync: 'done' });
    expect(injected[0].sync_attempts).toBeGreaterThan(1);
    const repo = join(run.workspace, 'repos', 'toyshop');
    const authors = execFileSync('git', ['log', '--format=%an'], { cwd: repo, encoding: 'utf8' }).split('\n');
    expect(authors.filter((a) => a === 'Platform Teammate')).toHaveLength(1);
    const v = JSON.parse(readFileSync(run.verification, 'utf8'));
    expect(v.sections.scope.ok).toBe(true);
    expect(v.sections.faults.checks.map((c: any) => [c.id, c.ok])).toEqual([
      ['fault:concurrent-commit:bound', true],
      ['fault:concurrent-commit:kept', true],
    ]);
    expect(v.ok).toBe(true);
  }, 240_000);

  // Where the boundary exists the command line would go on to start the real claude: never in these tests.
  it.runIf(!ISOLATED)('refuses, on the command line, to run or verify anything without the isolation boundary', async () => {
    const outDir = join(makeTmpDir('bench-a-noiso-'), 'run');
    const run = await runArmMain(['--case', TOY_PRD, '--arm', 'without', '--out-dir', outDir, '--suite-root', toy.suite, '--cache-root', toy.cacheRoot]);
    const verdict = await verifyRunMain(['--workspace', outDir, '--case', TOY_PRD, '--suite-root', toy.suite, '--cache-root', toy.cacheRoot]);
    expect(run).toMatchObject({ ok: false, exit: 2, errors: [expect.stringMatching(/isolation boundary/)] });
    expect(verdict).toMatchObject({ ok: false, exit: 2, errors: [expect.stringMatching(/isolation boundary/)] });
  }, 240_000);

  it('refuses an out-dir inside the suite, the checkout, the cache or evaluator store, a toolchain or an authoring clone, and defaults to the OS temp dir', async () => {
    const roots = { suiteRoot: toy.suite, cacheRoot: toy.cacheRoot, authoring: [toy.authoring], toolchains: [join(toy.root, 'node')] };
    for (const bad of [join(toy.suite, 'results', 'run'), join(REPO_ROOT, 'evals-public-projects', 'results', 'run'), join(toy.cacheRoot, 'evaluator', 'x'), toy.cacheRoot, join(toy.authoring, 'run'), join(toy.root, 'node', 'run')]) {
      expect(outDirProblem(bad, roots), bad).toMatch(/inside/);
    }
    expect(outDirProblem(join(makeTmpDir('bench-a-out-'), 'run'), roots)).toBeNull();
    await expect(arm('without', fakePlan(), { outDir: join(toy.suite, 'results', 'run') })).rejects.toThrow(/inside/);
    const refused = await runArmMain(['--case', TOY_PRD, '--arm', 'without', '--out-dir', join(REPO_ROOT, 'evals-public-projects', 'results', 'x'), '--suite-root', toy.suite, '--cache-root', toy.cacheRoot], { isolation: TEST_ISOLATION });
    expect(refused).toMatchObject({ ok: false, exit: 2, errors: [expect.stringMatching(/inside/)] });
  });

  it('rejects plans whose triggers cannot mean anything', () => {
    expect(planProblems({ faults: [{ kind: 'late-hidden-defect', trigger: { on: 'first-commit' } }] })).toEqual(['faults[0] late-hidden-defect: QA reports after the delivery: the trigger must be session-end']);
    expect(planProblems({ faults: [{ kind: 'interrupt-restart', trigger: { on: 'session-end' } }] })).toEqual(['faults[0] interrupt-restart: needs a mid-session trigger, not session-end']);
    expect(planProblems({ faults: [{ kind: 'concurrent-commit', trigger: { on: 'commits' } }] })).toEqual(['faults[0] concurrent-commit: a commits trigger needs a count']);
    expect(planProblems({ faults: [{ kind: 'late-hidden-defect', trigger: { on: 'session-end', phase: 'rework' } }] })).toEqual(['faults[0] late-hidden-defect: a phase scopes mid-session triggers only']);
    expect(planProblems({ faults: [{ kind: 'interrupt-restart', trigger: { on: 'elapsed-seconds', seconds: 2, phase: 'rework' } }] })).toEqual([]);
    expect(planProblems(null)).toEqual([]);
  });

  it('fails a run whose session or worker named the evaluator store, the cache or the suite, in any spelling', async () => {
    const fwd = (p: string) => p.replace(/\\/g, '/');
    const evaluator = join(toy.cacheRoot, 'evaluator', 'toyshop', TOY_PRD);
    const outDir = join(makeTmpDir('bench-a-run-'), 'run');
    const fake = fakePlan({
      peek: [
        // a glob that expands into the store, and a relative path climbing out of the workspace into the suite
        `cat ${fwd(toy.cacheRoot).slice(0, -1)}*/evaluator/*/${TOY_PRD}/hidden/*`,
        `ls ${fwd(relative(join(outDir, 'workspace'), join(toy.suite, 'projects')))}`,
        // an ordinary command in the workspace
        'git -C repos/toyshop status',
      ],
      workerPeek: join(evaluator, 'reference.bundle'),
    });
    const run = await arm('without', fake, { outDir });
    expect(run.ok).toBe(false);
    const hits = run.evaluator_access.hits;
    expect(hits.some((h: any) => h.tool === 'Bash' && h.path.includes('*'))).toBe(true);
    expect(hits.some((h: any) => h.tool === 'Read' && h.file.includes('subagents'))).toBe(true);
    expect(hits.every((h: any) => !h.path.startsWith('repos/'))).toBe(true);
  }, 240_000);
});
