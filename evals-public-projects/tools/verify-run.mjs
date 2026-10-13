#!/usr/bin/env node
/**
 * Authoritative post-run verifier for the public-project benchmark.
 *
 *   node evals-public-projects/tools/verify-run.mjs --workspace <dir> --case <case|PRD> [options]
 *   node evals-public-projects/tools/verify-run.mjs --aggregate <eval.json> [options]
 *
 * Options:
 *   --require-mycelink   also require complete Mycelink orchestration evidence
 *                        (in --aggregate mode: only for the "with" arm)
 *   --require-tdd        also require every delivered unit to replay as test-first
 *   --no-tdd             skip the TDD replay (it is reported as not run)
 *   --faults <file>      the fault records of a fault-injected run (its run.json
 *                        from tools/run-arm.mjs, or a JSON list); --workspace only
 *   --suite-root <dir>   another suite (default: this checkout's evals-public-projects)
 *   --expect-suite-commit <sha>  refuse unless the suite's checkout is at this commit
 *   --cache-root <dir>   offline caches and evaluator store (default: see toolchain.mjs)
 *   --work-dir <dir>     scratch directory (default: a fresh temp dir)
 *   --mycelink-package <zip> --mycelink-sha256 <hex>
 *                        the pinned Mycelink release package to run (its SHA-256 is
 *                        checked, it is unpacked and sealed outside the workspace);
 *                        default: this checkout's plugin, packaged and recorded
 *   --authoring-root <d> an evaluator authoring clone no transcript may name (repeatable;
 *                        --aggregate: every transcript of every run is scanned)
 *   --out <file.json>    also write the JSON result to this file
 *
 * --workspace verifies against the suite pinned to its commit: a suite
 * with uncommitted changes (or at another commit than --expect-suite-commit)
 * is refused, and the verdict reads the committed tree, sealed.
 *
 * Exit codes: 0 verified, 1 not verified, 2 usage or internal error. The
 * JSON result is always printed. Run it on the host that ran the evals: it
 * executes the delivered code (in fresh exports, with private toolchain
 * copies), so treat it like the eval run itself.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { readFaultRecords } from '../lib/faults.mjs';
import { sealPlugin } from '../lib/plugin.mjs';
import { requireSandbox } from '../lib/sandbox.mjs';
import { pinSuite, sealSuite } from '../lib/suite-pin.mjs';
import { pathKey } from '../lib/git.mjs';
import { loadSuite, suiteRoot as defaultSuiteRoot } from '../lib/manifests.mjs';
import { forbiddenAccess, transcriptFiles } from '../lib/transcripts.mjs';
import { resolveCacheRoot } from '../lib/toolchain.mjs';
import { CORE_SECTIONS, VERIFIER_VERSION, verifyDelivery } from '../lib/verify.mjs';

/** Is `dir` shaped like a scaffolded workspace (a coordination repository and a project repository)? */
function workspaceShaped(dir, repoDirs) {
  return existsSync(join(dir, 'platform', 'requirements')) && repoDirs.some((r) => existsSync(join(dir, ...r.split('/'), '.git')));
}

/**
 * The workspace of one `claude plugin eval` run, derived exactly from its
 * trace path (needs --keep-temp): the harness runs the session in
 * `<sandbox>/home/cwd` (the trace's init event says so) and keeps it on
 * disk at `<sandbox>/sealed/home/cwd` (or `<sandbox>/home/cwd`). Exactly one
 * of those must hold the workspace, and no other directory in the sandbox
 * may look like one: a decoy or an ambiguous sandbox is refused, never
 * searched. Returns `{ sandbox, workspace, problems }`.
 */
export function harnessWorkspace(tracePath, repoDirs) {
  const problems = [];
  if (!tracePath || !existsSync(tracePath)) return { sandbox: null, workspace: null, problems: [`no trace at ${tracePath ?? '(no trace path)'}; re-run the eval with --keep-temp`] };
  const sandbox = dirname(dirname(resolve(tracePath)));
  const runtime = join(sandbox, 'home', 'cwd');
  let init = null;
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e?.type === 'system' && e.subtype === 'init') {
        init = e;
        break;
      }
    } catch {
      // not an event
    }
  }
  const comparable = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (typeof init?.cwd !== 'string') problems.push('the trace records no session cwd (no init event)');
  else if (comparable(init.cwd) !== comparable(runtime) && pathKey(init.cwd) !== pathKey(runtime)) problems.push(`the session ran in ${init.cwd}, not in its sandbox's home/cwd (${runtime})`);
  const candidates = [join(sandbox, 'sealed', 'home', 'cwd'), runtime].filter((d) => workspaceShaped(d, repoDirs));
  if (candidates.length === 0) problems.push(`no workspace at ${join(sandbox, 'sealed', 'home', 'cwd')} or ${runtime}; re-run the eval with --keep-temp`);
  if (candidates.length > 1) problems.push(`ambiguous sandbox: both ${candidates.join(' and ')} hold a workspace`);
  const decoys = [];
  const walk = (dir, depth) => {
    if (decoys.length >= 10) return;
    if (!candidates.includes(dir) && workspaceShaped(dir, repoDirs)) decoys.push(dir);
    if (depth >= 8) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && e.name !== '.git') walk(join(dir, e.name), depth + 1);
  };
  walk(sandbox, 0);
  if (decoys.length > 0) problems.push(`decoy workspace(s) in the sandbox: ${decoys.join(', ')}`);
  return { sandbox, workspace: problems.length === 0 ? candidates[0] : null, problems };
}

/** Roots a transcript must never name: the suite, the caches and the evaluator store, any authoring clones. */
function forbiddenRoots({ suiteRoot, cacheRoot, authoring = [] }) {
  return [suiteRoot, cacheRoot, join(cacheRoot, 'evaluator'), ...authoring].map((p) => resolve(p));
}

async function aggregate({ file, flags, cacheRoot, suiteRoot, artifact, isolation }) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const suite = loadSuite(suiteRoot);
  const cases = new Map(suite.projects.flatMap((p) => p.prds.map((prd) => [prd.manifest.case, { project: p, prd }])));
  const repoDirs = suite.projects.map((p) => p.adapter.workspace.repo_dir);
  const roots = forbiddenRoots({ suiteRoot, cacheRoot, authoring: (flags['authoring-root'] ?? []).map((p) => resolve(p)) });
  const runs = [];
  for (const c of data.cases ?? []) {
    for (const [arm, list] of Object.entries(c.arms ?? {})) {
      for (const [i, run] of (list ?? []).entries()) {
        const entry = { case: c.name, arm, run: i + 1, score: run.score, turns: run.turns, cost_usd: run.costUsd, trace: run.tracePath, workspace: null, trace_access: null };
        if (!cases.has(c.name)) {
          entry.result = { ok: false, errors: [`case ${c.name} is not part of this suite`] };
          entry.ok = false;
          runs.push(entry);
          continue;
        }
        const located = harnessWorkspace(run.tracePath, repoDirs);
        entry.workspace = located.workspace;
        if (located.sandbox) {
          // Every transcript of the run: the session's trace and everything under its config, the workers' included.
          const files = transcriptFiles({ streams: [resolve(run.tracePath)], dirs: [join(located.sandbox, 'config', 'projects'), join(located.sandbox, 'sealed', 'home', '.claude', 'projects')] });
          const access = forbiddenAccess({ files, roots, home: join(located.sandbox, 'home') });
          entry.trace_access = { hits: access.hits, probes: access.probes, transcripts: files.length };
        }
        if (!located.workspace) {
          entry.result = { ok: false, errors: located.problems };
        } else {
          const workRoot = mkdtempSync(join(flags['work-dir'] ?? tmpdir(), 'bench-verify-'));
          try {
            entry.result = await verifyDelivery({
              suiteRoot,
              isolation,
              caseKey: c.name,
              workspace: located.workspace,
              cacheRoot,
              workRoot,
              requireMycelink: Boolean(flags['require-mycelink']) && arm === 'with',
              requireTdd: Boolean(flags['require-tdd']),
              tdd: !flags['no-tdd'],
              ...(artifact ? { mycelink: artifact } : {}),
            });
          } finally {
            if (!flags['work-dir']) rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          }
        }
        entry.ok = entry.result.ok === true && entry.trace_access !== null && entry.trace_access.hits.length === 0;
        runs.push(entry);
      }
    }
  }
  const summary = {};
  for (const r of runs) {
    const k = `${r.case}/${r.arm}`;
    summary[k] ??= { runs: 0, verified: 0, completion_ok: 0, tdd_ok: 0, orchestration_ok: 0, evaluator_access: 0, mean_turns: 0, total_cost_usd: 0, mycelink_worker_tokens: 0 };
    const x = summary[k];
    x.runs += 1;
    x.verified += r.ok ? 1 : 0;
    const s = r.result.sections ?? {};
    x.completion_ok += CORE_SECTIONS.every((n) => s[n]?.ok === true) ? 1 : 0;
    x.tdd_ok += s.tdd?.ok === true ? 1 : 0;
    x.orchestration_ok += s.orchestration?.ok === true ? 1 : 0;
    x.evaluator_access += (r.trace_access?.hits.length ?? 0) > 0 ? 1 : 0;
    x.mean_turns += r.turns ?? 0;
    x.total_cost_usd += r.cost_usd ?? 0;
    const u = r.result.evidence?.mycelink?.usage;
    if (u) x.mycelink_worker_tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  for (const x of Object.values(summary)) x.mean_turns = x.runs ? x.mean_turns / x.runs : 0;
  return {
    schema: 'mycelink-bench/aggregate-verification@1',
    verifier_version: VERIFIER_VERSION,
    generated_at: new Date().toISOString(),
    aggregate: file,
    ok: runs.length > 0 && runs.every((r) => r.ok),
    // The verdicts ran inside the boundary, but `claude plugin eval` ran each agent session outside it, as the operator:
    // these runs are never pilot evidence (run every arm with tools/run-arm.mjs).
    agent_isolation: { enforced: false, runner: 'claude plugin eval' },
    trusted: false,
    summary,
    runs,
  };
}

/**
 * The command line. `options.isolation` exists for the harness's own tests only (the command line
 * cannot set it): without it, the verifier requires the bubblewrap boundary and fails closed.
 */
export async function main(argv, options = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv, {
      valued: ['workspace', 'aggregate', 'case', 'cache-root', 'work-dir', 'mycelink-package', 'mycelink-sha256', 'out', 'faults', 'suite-root', 'expect-suite-commit'],
      repeated: ['authoring-root'],
      booleans: ['require-mycelink', 'require-tdd', 'no-tdd', 'help'],
    });
  } catch (error) {
    return { ok: false, exit: 2, errors: [`usage: ${error.message}`] };
  }
  const { flags } = parsed;
  if (flags.help) return { ok: true, usage: readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0] };
  if (Boolean(flags.workspace) === Boolean(flags.aggregate)) return { ok: false, exit: 2, errors: ['usage: pass exactly one of --workspace or --aggregate'] };
  if (flags.workspace && !flags.case) return { ok: false, exit: 2, errors: ['usage: --workspace needs --case <case name or PRD id>'] };
  if (flags.faults && !flags.workspace) return { ok: false, exit: 2, errors: ['usage: --faults goes with --workspace'] };
  let faults = [];
  try {
    faults = flags.faults ? readFaultRecords(resolve(flags.faults)) : [];
  } catch (error) {
    return { ok: false, exit: 2, errors: [`usage: ${error.message}`] };
  }
  let isolation = options.isolation ?? null;
  if (!isolation) {
    try {
      isolation = requireSandbox();
    } catch (error) {
      return { ok: false, exit: 2, errors: [`${error.message}: the verifier runs delivered code only inside the isolation boundary (see evals-public-projects/README.md, Isolation)`] };
    }
  }
  const cacheRoot = resolveCacheRoot({ explicit: flags['cache-root'] });
  if (Boolean(flags['mycelink-package']) !== Boolean(flags['mycelink-sha256'])) return { ok: false, exit: 2, errors: ['usage: --mycelink-package and --mycelink-sha256 go together'] };
  let artifact = null;
  try {
    artifact = flags['mycelink-package'] ? sealPlugin({ zip: resolve(flags['mycelink-package']), sha256: flags['mycelink-sha256'], dir: join(mkdtempSync(join(tmpdir(), 'bench-mycelink-')), 'plugin') }) : null;
  } catch (error) {
    return { ok: false, exit: 2, errors: [String(error?.message ?? error)] };
  }
  let result;
  if (flags.aggregate) {
    result = await aggregate({ file: resolve(flags.aggregate), flags, cacheRoot, artifact, isolation, suiteRoot: flags['suite-root'] ? resolve(flags['suite-root']) : defaultSuiteRoot() });
  } else {
    const pinned = pinSuite(flags['suite-root'] ? resolve(flags['suite-root']) : defaultSuiteRoot(), { expectCommit: flags['expect-suite-commit'] ?? null });
    if (!pinned.ok) return { ok: false, exit: 2, errors: pinned.problems };
    const workRoot = mkdtempSync(join(flags['work-dir'] ?? tmpdir(), 'bench-verify-'));
    try {
      result = await verifyDelivery({
        isolation,
        suiteRoot: sealSuite(pinned.pin),
        suitePin: pinned.pin,
        caseKey: flags.case,
        workspace: resolve(flags.workspace),
        cacheRoot,
        workRoot,
        requireMycelink: Boolean(flags['require-mycelink']),
        requireTdd: Boolean(flags['require-tdd']),
        tdd: !flags['no-tdd'],
        faults,
        ...(artifact ? { mycelink: artifact } : {}),
      });
    } finally {
      if (!flags['work-dir']) rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  if (flags.out) result.out = flags.out;
  return result;
}

runTool(import.meta.url, main);
