/**
 * The acceptance test for the whole harness.
 *
 * One PRD, three independent repositories, dependency-ordered worker
 * sessions, per-repository integration branches, a cross-repository candidate
 * manifest, two parallel E2E scenarios plus one serialised, a deliberate
 * contract break attributed to the correct producer node, and a green rerun
 * on a new candidate — all with a fake Claude executable, so no model usage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import {
  FEATURE_ID,
  commitControl,
  createPortfolio,
  e2eScenarios,
  portfolioGraph,
  writePrd,
  type Portfolio,
} from '../helpers/portfolio-fixture.js';
import { main } from '../../src/cli/cli.js';
import type { CliIo } from '../../src/cli/cli.js';
import { parseArgs } from '../../src/cli/args.js';
import { loadState } from '../../src/state/feature-state.js';
import { listCandidates, loadCandidate } from '../../src/git/candidate.js';
import { resolveRef, runGit } from '../../src/git/git.js';
import { integrationBranchName } from '../../src/git/worktree.js';
import { readEvents } from '../../src/state/event-log.js';
import { planShards } from '../../src/e2e/scheduler.js';
import { loadScenarios } from '../../src/e2e/runner.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { asController } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

interface RunResult {
  code: number;
  out: string;
  err: string;
}

async function harness(p: Portfolio, argv: string[]): Promise<RunResult> {
  let out = '';
  let err = '';
  const io: CliIo = {
    out: (t) => {
      out += t + '\n';
    },
    err: (t) => {
      err += t + '\n';
    },
  };
  const code = await main([...asController(argv, p.control), '--control-root', p.control], io);
  return { code, out, err };
}

/** The `tdd` call a fake worker makes, as real argv. */
function tddStep(p: Portfolio, phase: string, nodeId: string): string[] {
  return [
    process.execPath,
    p.mycelink,
    'tdd',
    phase,
    FEATURE_ID,
    nodeId,
    '--control-root',
    p.control,
    '--',
    'node',
    'tests/run.mjs',
  ];
}

/** A worker scenario that does real TDD: failing test, RED, implement, GREEN. */
function tddScenario(
  p: Portfolio,
  nodeId: string,
  sourceFile: string,
  sourceBody: string,
): unknown {
  return {
    outcome: 'SUBMITTED',
    turns: 3,
    steps: [
      // The test file already exists in the fixture repo and fails because the
      // source is missing: commit nothing, just record the RED.
      { label: 'tdd-red', run: tddStep(p, 'red', nodeId), expect_exit: 0 },
      { write_files: { [sourceFile]: sourceBody } },
      { git_commit: `implement ${nodeId}` },
      { label: 'tdd-green', run: tddStep(p, 'green', nodeId), expect_exit: 0 },
      { label: 'tdd-regression', run: tddStep(p, 'regression', nodeId), expect_exit: 0 },
    ],
  };
}

/**
 * A worker re-opened after an upstream change whose own behaviour is
 * unchanged. The historical RED is retained by the controller, so the honest
 * action is to re-prove GREEN and regression, not to invent a new failing test.
 */
function revalidateScenario(p: Portfolio, nodeId: string): unknown {
  return {
    outcome: 'SUBMITTED',
    turns: 1,
    steps: [
      { label: 'tdd-green', run: tddStep(p, 'green', nodeId), expect_exit: 0 },
      { label: 'tdd-regression', run: tddStep(p, 'regression', nodeId), expect_exit: 0 },
    ],
  };
}

function writeScenarioFile(p: Portfolio, nodes: Record<string, unknown>): void {
  writeFileSync(p.scenarioFile, JSON.stringify({ nodes }, null, 2), 'utf8');
}

function happyPathScenarios(p: Portfolio): Record<string, unknown> {
  return {
    [`${FEATURE_ID}.core.publish.impl`]: tddScenario(
      p,
      `${FEATURE_ID}.core.publish.impl`,
      'src/publish.js',
      'export const JOB_RESULT_V2 = true;\nexport function publish() { return { type: "order-status", v: 2 }; }\n',
    ),
    [`${FEATURE_ID}.api.consume.impl`]: tddScenario(
      p,
      `${FEATURE_ID}.api.consume.impl`,
      'src/consume.js',
      'export const JOB_RESULT_V2 = true;\nexport function consume(e) { return e.v === 2 ? e : null; }\n',
    ),
    [`${FEATURE_ID}.web.render.impl`]: tddScenario(
      p,
      `${FEATURE_ID}.web.render.impl`,
      'src/view.js',
      'export const RENDER_JOB_RESULT = true;\nexport function render(r) { return String(r.v); }\n',
    ),
  };
}

describe('three-repository portfolio, end to end', () => {
  let p: Portfolio;

  beforeAll(async () => {
    p = createPortfolio();
    writePrd(p);

    // The graph the planner would have produced from the PRD.
    writeFileSync(
      join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'),
      YAML.stringify(portfolioGraph(), { lineWidth: 0 }),
      'utf8',
    );

    const scenariosDir = join(p.featureDir, 'e2e');
    mkdirSync(scenariosDir, { recursive: true });
    for (const scenario of e2eScenarios(p)) {
      writeFileSync(join(scenariosDir, `${scenario.id}.yaml`), scenario.yaml, 'utf8');
    }

    process.env['FAKE_CLAUDE_SCENARIO'] = p.scenarioFile;
    writeScenarioFile(p, happyPathScenarios(p));
    commitControl(p, 'feature scaffolding');
  });

  it('1. doctor reports a healthy portfolio of three real repositories', async () => {
    const result = await harness(p, ['doctor', '--json']);
    const report = JSON.parse(result.out) as {
      ok: boolean;
      checks: { name: string; ok: boolean }[];
    };
    expect(report.checks.find((c) => c.name === 'repo:core')?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'repo:api')?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'repo:web')?.ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(result.code).toBe(0);
  });

  it('2. the four-layer graph validates and initialises the feature', async () => {
    const validate = await harness(p, ['graph', 'validate', FEATURE_ID, '--json']);
    expect(validate.code).toBe(0);

    const init = await harness(p, ['feature', 'init', FEATURE_ID, '--json']);
    expect(init.code).toBe(0);
    const state = loadState(p.featureDir)?.data;
    expect(state?.feature_state).toBe('GRAPH_VALIDATED');
    expect(Object.keys(state?.nodes ?? {})).toHaveLength(5);
    expect(existsSync(join(p.featureDir, 'LOOPS.yaml'))).toBe(true);
  });

  it('3. loop contracts validate before any work starts', async () => {
    const result = await harness(p, ['loop', 'validate', FEATURE_ID, '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as { ok: boolean; loops: { loop_id: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.loops.length).toBeGreaterThanOrEqual(5);
  });

  it('4. only the producer is READY; the consumer waits on its contract', async () => {
    const result = await harness(p, ['graph', 'ready', FEATURE_ID, '--json']);
    const parsed = JSON.parse(result.out) as { ready: string[] };
    expect(parsed.ready).toEqual([`${FEATURE_ID}.core.publish.impl`]);
  });

  it('5. workers run in dependency order and each repository integrates', async () => {
    const result = await harness(p, ['orchestrate', 'run', FEATURE_ID, '--json', '--max-cycles', '12']);
    const report = JSON.parse(result.out) as {
      stop_reason: string;
      reports: { node_id: string; outcome: string; state: string; detail: string }[];
      feature_state: string;
    };

    const failures = report.reports.filter((r) => r.outcome !== 'DONE');
    expect(failures.map((f) => `${f.node_id}:${f.outcome}:${f.detail}`)).toEqual([]);
    expect(report.stop_reason).toBe('ALL_SETTLED');

    const state = loadState(p.featureDir)?.data;
    for (const nodeId of Object.keys(state?.nodes ?? {})) {
      expect(`${nodeId}=${state?.nodes[nodeId]?.state}`).toBe(`${nodeId}=DONE`);
    }

    // Each repository has the common feature branch at a real commit.
    for (const repo of [p.core, p.api, p.app]) {
      const branch = integrationBranchName(FEATURE_ID);
      expect(
        runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
          allowFail: true,
        }).exitCode,
      ).toBe(0);
      expect(resolveRef(repo, branch)).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('6. every node has real RED evidence that failed for a missing behaviour', () => {
    const state = loadState(p.featureDir)?.data;
    for (const nodeId of [
      `${FEATURE_ID}.core.publish.impl`,
      `${FEATURE_ID}.api.consume.impl`,
      `${FEATURE_ID}.web.render.impl`,
    ]) {
      const red = state?.nodes[nodeId]?.evidence.red;
      expect(red, `${nodeId} red evidence`).toBeDefined();
      expect(red?.exit_code).not.toBe(0);
      expect(red?.red_reason).toBe('behaviour-missing');
      // Stored relative to the control root, so a moved workspace still resolves it.
      expect(red?.output_path).toMatch(new RegExp(`^features/${FEATURE_ID}/evidence/`));
      expect(existsSync(join(p.control, red?.output_path ?? '-'))).toBe(true);

      const green = state?.nodes[nodeId]?.evidence.green;
      expect(green?.exit_code).toBe(0);
      // GREEN must be the same targeted command that produced the RED.
      expect(green?.command).toEqual(red?.command);
    }
  });

  it('7. a cross-repository candidate binds one exact SHA per repository', () => {
    const ids = listCandidates(p.featureDir);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const manifest = loadCandidate(p.featureDir, ids[0] as string);
    expect(Object.keys(manifest.repositories).sort()).toEqual(['api', 'core', 'web']);
    for (const [name, bound] of Object.entries(manifest.repositories)) {
      const repoPath = { core: p.core, 'api': p.api, 'web': p.app }[name] as string;
      expect(bound.sha).toBe(resolveRef(repoPath, integrationBranchName(FEATURE_ID)));
    }
    expect(manifest.created_from_clean_worktrees).toBe(true);
    expect(manifest.contracts.some((c) => c.path === 'contracts/order-status.json')).toBe(true);
  });

  it('8. two independent scenarios shard in parallel and the global one serialises', () => {
    const scenarios = loadScenarios(join(p.featureDir, 'e2e'));
    expect(scenarios).toHaveLength(3);
    const plan = planShards(scenarios, portfolioGraph()['resources'] as Record<string, { capacity: number }>);
    expect(plan.shards[0]?.scenarios.sort()).toEqual(['E2E-create', 'E2E-update']);
    expect(plan.shards[1]?.scenarios).toEqual(['E2E-global-reset']);
    expect(plan.serialised.find((s) => s.scenario === 'E2E-global-reset')?.reason).toBe(
      'GLOBAL_MUTATION',
    );
  });

  it('9. the feature verifies with no leaked leases and no live sessions', async () => {
    const result = await harness(p, ['feature', 'verify', FEATURE_ID, '--json']);
    const parsed = JSON.parse(result.out) as { ok: boolean; problems: string[] };
    expect(parsed.problems).toEqual([]);
    expect(result.code).toBe(0);
  });

  it('10. a deliberate contract break fails E2E and is attributed to the producer', async () => {
    // The producer bumps the contract to v3 but the consumer still handles v2.
    writeFileSync(
      join(p.control, 'contracts', 'order-status.json'),
      JSON.stringify({ name: 'order-status', version: 3 }, null, 2) + '\n',
      'utf8',
    );
    commitControl(p, 'contract: bump order-status to v3');

    // Re-open the consumer node: its input contract changed.
    const invalidate = await harness(p, [
      'node',
      'invalidate',
      FEATURE_ID,
      `${FEATURE_ID}.api.consume.impl`,
      '--reason',
      'contract order-status bumped to v3',
      '--json',
    ]);
    expect(invalidate.code).toBe(0);

    // The downstream UI node is re-opened by the cascade but its own behaviour
    // is unchanged, so it simply re-proves GREEN. The consumer "fixes" the
    // wrong thing: it keeps v2 handling.
    writeScenarioFile(p, {
      [`${FEATURE_ID}.core.publish.impl`]: revalidateScenario(
        p,
        `${FEATURE_ID}.core.publish.impl`,
      ),
      [`${FEATURE_ID}.web.render.impl`]: revalidateScenario(
        p,
        `${FEATURE_ID}.web.render.impl`,
      ),
      [`${FEATURE_ID}.api.consume.impl`]: tddScenario(
        p,
        `${FEATURE_ID}.api.consume.impl`,
        'src/consume.js',
        'export const JOB_RESULT_V2 = true;\nexport function consume(e) { return e.v === 2 ? e : null; }\n',
      ),
    });

    const run = await harness(p, ['orchestrate', 'run', FEATURE_ID, '--json', '--max-cycles', '6']);
    const report = JSON.parse(run.out) as {
      stop_reason: string;
      reports: { node_id: string; outcome: string; detail: string }[];
    };

    // The consumer's own fresh verification catches it: the contract now says
    // v3 and the source only handles v2.
    const consumer = report.reports.find(
      (r) => r.node_id === `${FEATURE_ID}.api.consume.impl`,
    );
    expect(consumer).toBeDefined();
    expect(consumer?.outcome).not.toBe('DONE');
    // The failure is reported as a structured fingerprint naming the gate that
    // refused, not as a bare process exit code.
    expect(consumer?.detail).toMatch(/step-failed:tdd-green|JOB_RESULT_V3|verifier/i);
    expect(['BLOCKED', 'NO_PROGRESS']).toContain(report.stop_reason);

    const state = loadState(p.featureDir)?.data;
    const runtime = state?.nodes[`${FEATURE_ID}.api.consume.impl`];
    expect(['BLOCKED', 'READY', 'INVALIDATED']).toContain(runtime?.state);
    expect(Object.keys(runtime?.failure_counts ?? {}).length).toBeGreaterThan(0);
  });

  it('11. the repeated identical failure blocks the node instead of looping', () => {
    const state = loadState(p.featureDir)?.data;
    const runtime = state?.nodes[`${FEATURE_ID}.api.consume.impl`];
    const counts = Object.values(runtime?.failure_counts ?? {});
    expect(Math.max(...counts, 0)).toBeGreaterThanOrEqual(2);
    expect(runtime?.state).toBe('BLOCKED');
    expect(runtime?.blocked_reason).toMatch(/fingerprint/i);
  });

  it('12. a correct fix plus an approved decision produces a new green candidate', async () => {
    // The user decides: the consumer adopts v3.
    const record = await harness(p, [
      'decision',
      'record',
      FEATURE_ID,
      'DEC-contract-v3',
      '--answer',
      'The consumer adopts order-status v3.',
      '--json',
    ]);
    expect(record.code).toBe(0);
    const apply = await harness(p, ['decision', 'apply', FEATURE_ID, 'DEC-contract-v3', '--json']);
    expect(apply.code).toBe(0);

    writeScenarioFile(p, {
      [`${FEATURE_ID}.core.publish.impl`]: revalidateScenario(
        p,
        `${FEATURE_ID}.core.publish.impl`,
      ),
      [`${FEATURE_ID}.web.render.impl`]: revalidateScenario(
        p,
        `${FEATURE_ID}.web.render.impl`,
      ),
      [`${FEATURE_ID}.api.consume.impl`]: tddScenario(
        p,
        `${FEATURE_ID}.api.consume.impl`,
        'src/consume.js',
        'export const JOB_RESULT_V3 = true;\nexport function consume(e) { return e.v === 3 ? e : null; }\n',
      ),
    });

    const candidatesBefore = listCandidates(p.featureDir).length;
    const run = await harness(p, ['orchestrate', 'run', FEATURE_ID, '--json', '--max-cycles', '12']);
    const report = JSON.parse(run.out) as { stop_reason: string; reports: { node_id: string; outcome: string; detail: string }[] };

    const failures = report.reports.filter((r) => r.outcome !== 'DONE');
    expect(failures.map((f) => `${f.node_id}:${f.outcome}:${f.detail}`)).toEqual([]);
    expect(report.stop_reason).toBe('ALL_SETTLED');

    // The fix produced a NEW candidate; the old one was never amended.
    const candidatesAfter = listCandidates(p.featureDir);
    expect(candidatesAfter.length).toBeGreaterThan(candidatesBefore);

    const state = loadState(p.featureDir)?.data;
    expect(state?.current_candidate).toBe(candidatesAfter[candidatesAfter.length - 1]);
    for (const nodeId of Object.keys(state?.nodes ?? {})) {
      expect(`${nodeId}=${state?.nodes[nodeId]?.state}`).toBe(`${nodeId}=DONE`);
    }
  });

  it('13. an earlier candidate is detectably stale rather than silently reused', async () => {
    const ids = listCandidates(p.featureDir);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const stale = await harness(p, ['candidate', 'verify', FEATURE_ID, ids[0] as string, '--json']);
    const parsed = JSON.parse(stale.out) as { ok: boolean; problems: { code: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.map((x) => x.code)).toContain('REPOSITORY_SHA_DRIFT');
    expect(stale.code).toBe(1);
  });

  it('14. the audit log records the whole run without inlining any payload', () => {
    const paths = featurePaths(p.control, FEATURE_ID);
    const events = readEvents(paths.events, { includeRotated: true });
    expect(events.length).toBeGreaterThan(10);

    const types = new Set(events.map((e) => e.type));
    expect(types.has('node.claimed')).toBe(true);
    expect(types.has('node.transition')).toBe(true);
    expect(types.has('evidence.recorded')).toBe(true);
    expect(types.has('node.integrated')).toBe(true);

    for (const event of events) {
      expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThanOrEqual(8192);
    }
    const whole = readFileSync(paths.events, 'utf8');
    expect(whole).not.toContain('AssertionError');
    expect(whole).not.toContain('diff --git');
  });

  it('15. the run ledger accumulates child usage into the feature budget', async () => {
    const result = await harness(p, ['loop', 'budget', FEATURE_ID, '--json']);
    const parsed = JSON.parse(result.out) as {
      summary: { attempts: number; total_model_turns: number };
      usage: { model_turns: number; sessions: number };
      budget: { max_total_model_turns: number };
    };
    expect(parsed.summary.attempts).toBeGreaterThan(0);
    expect(parsed.usage.sessions).toBeGreaterThan(0);
    expect(parsed.usage.model_turns).toBeGreaterThan(0);
    expect(parsed.usage.model_turns).toBeLessThanOrEqual(parsed.budget.max_total_model_turns);
  });

  it('16. no worker ever edited outside its repository', () => {
    // The core worker only ever touched core files, and so on. Proven by
    // the integration branch diff against the base branch.
    for (const [repo, expected] of [
      [p.core, 'src/publish.js'],
      [p.api, 'src/consume.js'],
      [p.app, 'src/view.js'],
    ] as [string, string][]) {
      const changed = runGit(repo, [
        'diff',
        '--name-only',
        `main...${integrationBranchName(FEATURE_ID)}`,
      ]).stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      expect(changed).toContain(expected);
      expect(changed.every((f) => f.startsWith('src/') || f.startsWith('tests/'))).toBe(true);
    }
  });
});

describe('fixture argv parsing sanity', () => {
  it('keeps a verifier command after -- intact', () => {
    const parsed = parseArgs(['tdd', 'red', 'FEAT-1', 'N', '--control-root', 'C:/x', '--', 'node', 'tests/run.mjs']);
    expect(parsed.passthrough).toEqual(['node', 'tests/run.mjs']);
    expect(parsed.flags['control-root']).toBe('C:/x');
  });
});
