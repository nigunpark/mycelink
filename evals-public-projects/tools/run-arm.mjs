#!/usr/bin/env node
/**
 * Run one treatment arm of one case with Claude Code, then verify it.
 *
 *   node evals-public-projects/tools/run-arm.mjs --case <case|PRD> --arm with|without [--out-dir <dir>] [options]
 *   node evals-public-projects/tools/run-arm.mjs --case <case|PRD> --matrix --faults <plan.json> [--out-dir <dir>] [options]
 *
 * --matrix runs the four arms of the comparison — without and with the
 * plugin, normal and under the fault plan — one after another with
 * identical caps, into <out-dir>/<arm>-<condition>, and checks that they
 * match (same prompt, invocation but --plugin-dir, model, caps, plugin,
 * suite pin, isolation); matrix.json records the result. Pilot runs use it.
 *
 * --out-dir defaults to a fresh directory in the OS temp dir; one inside the
 * suite, the checkout, the cache or evaluator store, a toolchain or an
 * authoring clone is refused (exit 2).
 *
 * Options:
 *   --faults <plan.json>        apply an evaluator fault plan (the fault-injected
 *                               condition), e.g. evals-public-projects/fault-plans/default.json
 *   --model <model>             the session model (default: Claude Code's)
 *   --max-budget-usd <n>        per-session cost cap (claude --max-budget-usd)
 *   --budget-seconds <n>        wall clock for the task and its resumptions
 *                               (default: the case's timeout_seconds)
 *   --rework-budget-seconds <n> wall clock for a QA rework session (default: half)
 *   --claude <exe>              the claude executable (default: claude)
 *   --claude-arg <arg>          an argument before claude's own (repeatable)
 *   --cache-root <dir>          offline caches and evaluator store
 *   --suite-root <dir>          another suite (default: this checkout's)
 *   --expect-suite-commit <sha> refuse unless the suite's checkout is at this commit
 *   --require-mycelink          the with arm must show complete Mycelink evidence
 *   --require-tdd               every delivered unit must replay as test-first
 *   --poll-ms <n>               trigger polling interval (default 2000)
 *   --authoring-root <dir>      an evaluator authoring clone no transcript may name (repeatable)
 *   --allow-host <host:port>    another target the model proxy allows besides api.anthropic.com:443
 *                               (repeatable; e.g. a Bedrock or Vertex endpoint), recorded in run.json
 *   --out <file.json>           also write the run record here
 *
 * The suite is pinned to its commit (uncommitted changes, or another commit
 * than --expect-suite-commit, refuse the run) and the run reads the
 * committed tree, sealed. Every session runs inside the bubblewrap boundary
 * (lib/isolation.mjs), proved by a preflight from inside first; without
 * bubblewrap run-arm refuses (exit 2). The run directory gets the workspace,
 * a fresh HOME, the session transcripts, the proxy logs, run.json and
 * verification.json. Sessions inherit only the pinned toolchain PATH, model
 * access (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ...) and the Git
 * identity; a fresh HOME has no login, so provide one of those. Exit codes:
 * 0 verified, 1 not verified, 2 usage or internal error.
 */
import { resolve } from 'node:path';
import { runArm, runMatrix } from '../lib/arms.mjs';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { loadFaultPlan } from '../lib/faults.mjs';
import { suiteRoot } from '../lib/manifests.mjs';
import { DEFAULT_ALLOW } from '../lib/model-proxy.mjs';
import { requireSandbox } from '../lib/sandbox.mjs';
import { pinSuite, sealSuite } from '../lib/suite-pin.mjs';
import { resolveCacheRoot } from '../lib/toolchain.mjs';

/**
 * The command line. `options` exist for the harness's own tests only (the command line cannot set
 * them): `isolation` (without it, run-arm requires the bubblewrap boundary and fails closed), and the
 * stand-in agent's `sessionBinds` and `preflightProxy`.
 */
export async function main(argv, options = {}) {
  let flags;
  try {
    ({ flags } = parseArgs(argv, {
      valued: ['case', 'arm', 'out-dir', 'faults', 'model', 'max-budget-usd', 'budget-seconds', 'rework-budget-seconds', 'claude', 'cache-root', 'suite-root', 'expect-suite-commit', 'poll-ms', 'out'],
      repeated: ['claude-arg', 'authoring-root', 'allow-host'],
      booleans: ['require-mycelink', 'require-tdd', 'matrix'],
    }));
  } catch (error) {
    return { ok: false, exit: 2, errors: [`usage: ${error.message}`] };
  }
  if (!flags.case || Boolean(flags.arm) === Boolean(flags.matrix)) return { ok: false, exit: 2, errors: ['usage: run-arm.mjs --case <case|PRD> (--arm with|without | --matrix --faults <plan.json>) [--out-dir <dir>] [options]'] };
  if (flags.matrix && !flags.faults) return { ok: false, exit: 2, errors: ['usage: --matrix needs --faults <plan.json> for its fault arms'] };
  const number = (name) => (flags[name] === undefined ? null : Number(flags[name]));
  for (const name of ['max-budget-usd', 'budget-seconds', 'rework-budget-seconds', 'poll-ms']) {
    if (flags[name] !== undefined && !(Number(flags[name]) > 0)) return { ok: false, exit: 2, errors: [`usage: --${name} must be a positive number`] };
  }
  let faultPlan = null;
  try {
    faultPlan = flags.faults ? loadFaultPlan(resolve(flags.faults)) : null;
  } catch (error) {
    return { ok: false, exit: 2, errors: [`usage: ${error.message}`] };
  }
  let isolation = options.isolation ?? null;
  if (!isolation) {
    try {
      isolation = requireSandbox();
    } catch (error) {
      return { ok: false, exit: 2, errors: [`${error.message}: agent sessions run only inside the isolation boundary (see evals-public-projects/README.md, Isolation)`] };
    }
  }
  const pinned = pinSuite(flags['suite-root'] ? resolve(flags['suite-root']) : suiteRoot(), { expectCommit: flags['expect-suite-commit'] ?? null });
  if (!pinned.ok) return { ok: false, exit: 2, errors: pinned.problems };
  const allow = [...DEFAULT_ALLOW, ...(flags['allow-host'] ?? []), ...(options.preflightProxy ? [options.preflightProxy.allowed] : [])];
  let record;
  try {
    record = await (flags.matrix ? runMatrix : runArm)({
      isolation,
      suiteRoot: sealSuite(pinned.pin),
      suitePin: pinned.pin,
      caseKey: flags.case,
      arm: flags.arm,
      faultPlan,
      outDir: flags['out-dir'] ? resolve(flags['out-dir']) : null,
      cacheRoot: resolveCacheRoot({ explicit: flags['cache-root'] }),
      claude: [flags.claude ?? 'claude', ...(flags['claude-arg'] ?? [])],
      model: flags.model ?? null,
      maxBudgetUsd: number('max-budget-usd'),
      budgetSeconds: number('budget-seconds'),
      reworkBudgetSeconds: number('rework-budget-seconds'),
      pollMs: number('poll-ms') ?? 2000,
      requireMycelink: Boolean(flags['require-mycelink']),
      requireTdd: Boolean(flags['require-tdd']),
      authoringRoots: (flags['authoring-root'] ?? []).map((p) => resolve(p)),
      proxyAllow: allow,
      ...(options.sessionBinds ? { sessionBinds: options.sessionBinds } : {}),
      ...(options.preflightProxy ? { preflightProxy: options.preflightProxy } : {}),
      log: (line) => process.stderr.write(`[run-arm] ${line}\n`),
    });
  } catch (error) {
    if (error?.usage) return { ok: false, exit: 2, errors: [`usage: ${error.message}`] };
    throw error;
  }
  return { ...record, ...(flags.out ? { out: flags.out } : {}) };
}

runTool(import.meta.url, main);
