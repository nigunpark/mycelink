/**
 * E2E execution against an immutable candidate.
 *
 * The whole run holds one `full-runtime` and one `deploy-slot` lease, so two
 * servers can never exist at once. Inside that lease, scenario shards run
 * with per-scenario browser profile, account and data-namespace isolation,
 * and every scenario's evidence is written under its own directory.
 *
 * Leases and cleanup run in `finally` on every path: success, failure,
 * cancellation or crash.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import type { EvidenceRecord, PortfolioGraph, ResourceDecl } from '../model/types.js';
import { validateAgainstSchema } from '../schema/registry.js';
import { runVerification } from '../evidence/runner.js';
import { redactValue } from '../security/redact.js';
import { acquireResource, releaseResource, type Lease } from '../resources/leases.js';
import { attributeFailure, planShards, type AttributionResult, type E2EPlan, type E2EScenario } from './scheduler.js';
import type { CandidateManifest } from '../git/candidate.js';

export function loadScenarios(scenariosDir: string): E2EScenario[] {
  const dir = resolve(scenariosDir);
  if (!existsSync(dir)) return [];
  const out: E2EScenario[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const parsed = YAML.parse(readFileSync(join(dir, file), 'utf8')) as E2EScenario;
    const problems = validateAgainstSchema('e2e-scenario', parsed);
    if (problems.length > 0) {
      throw new Error(
        `E2E scenario ${file} is invalid: ` + problems.map((p) => p.detail).join('; '),
      );
    }
    out.push(parsed);
  }
  return out;
}

export interface ScenarioResult {
  scenario_id: string;
  shard: number;
  passed: boolean;
  evidence: EvidenceRecord[];
  attribution: AttributionResult | null;
}

export interface E2ERunResult {
  candidate_id: string;
  plan: E2EPlan;
  results: ScenarioResult[];
  passed: boolean;
  preflight_failure: string | null;
}

export interface E2ERunArgs {
  featureDir: string;
  evidenceRoot: string;
  graph: PortfolioGraph;
  candidate: CandidateManifest;
  scenarios: E2EScenario[];
  resources: Record<string, ResourceDecl | { capacity: number }>;
  /** Working directory for setup/test/cleanup commands. */
  cwd: string;
  /** Build/deploy the candidate. Must be idempotent. */
  deployCommand?: string[];
  healthcheckCommand?: string[];
  fixtureResetCommand?: string[];
  /** Only run these scenario ids (targeted re-run after a fix). */
  only?: string[];
  owner?: string;
  timeoutMs?: number;
}

/**
 * Per-scenario isolation handed to the test command as environment.
 *
 * Deterministic from the candidate and scenario id so a rerun reuses the same
 * namespaces and a human can find the data afterwards.
 */
export function isolationEnv(candidateId: string, scenario: E2EScenario, root: string): Record<string, string> {
  const slug = scenario.id.replace(/[^A-Za-z0-9._-]/g, '_');
  const ns = `${candidateId}__${slug}`.toLowerCase();
  // Screenshot and trace metadata is persisted with the evidence.
  return redactValue({
    E2E_SCENARIO_ID: scenario.id,
    E2E_CANDIDATE_ID: candidateId,
    E2E_DATA_NAMESPACE: scenario.isolation.data_namespace === 'unique' ? ns : 'shared',
    E2E_ACCOUNT: scenario.isolation.account === 'unique' ? `user_${ns}` : scenario.isolation.account,
    E2E_BROWSER_PROFILE_DIR:
      scenario.isolation.browser_profile === 'unique'
        ? join(root, 'profiles', slug)
        : join(root, 'profiles', 'shared'),
    E2E_TRACE_DIR: join(root, 'traces', slug),
    E2E_SCREENSHOT_DIR: join(root, 'screenshots', slug),
  });
}

/**
 * Run the planned scenarios against one candidate.
 *
 * Scenarios inside a shard are independent by construction, so they are run
 * concurrently; shards themselves are strictly sequential.
 */
export async function runE2E(args: E2ERunArgs): Promise<E2ERunResult> {
  const selected =
    args.only && args.only.length > 0
      ? args.scenarios.filter((s) => (args.only as string[]).includes(s.id))
      : args.scenarios;

  const plan = planShards(selected, args.resources);
  const owner = args.owner ?? 'e2e-runner';
  const evidenceRoot = resolve(args.evidenceRoot, args.candidate.candidate_id);
  mkdirSync(evidenceRoot, { recursive: true });

  const leases: Lease[] = [];
  const results: ScenarioResult[] = [];
  let preflightFailure: string | null = null;

  try {
    for (const resource of ['full-runtime', 'deploy-slot']) {
      if (args.resources[resource] === undefined) continue;
      leases.push(
        acquireResource(args.featureDir, resource, {
          nodeId: `e2e:${args.candidate.candidate_id}`,
          owner,
          capacities: args.resources,
        }),
      );
    }

    for (const [label, command] of [
      ['deploy', args.deployCommand],
      ['healthcheck', args.healthcheckCommand],
      ['fixture-reset', args.fixtureResetCommand],
    ] as [string, string[] | undefined][]) {
      if (!command) continue;
      const record = runVerification({
        kind: 'e2e',
        nodeId: `e2e:${label}`,
        repository: null,
        command,
        cwd: args.cwd,
        evidenceDir: evidenceRoot,
        label,
        candidateId: args.candidate.candidate_id,
        ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      });
      if (record.failure_fingerprint !== null) {
        preflightFailure = `${label} failed (exit ${record.exit_code}, ${record.failure_fingerprint})`;
        return {
          candidate_id: args.candidate.candidate_id,
          plan,
          results,
          passed: false,
          preflight_failure: preflightFailure,
        };
      }
    }

    const byId = new Map(selected.map((s) => [s.id, s]));
    for (const shard of plan.shards) {
      const shardResults = await Promise.all(
        shard.scenarios.map(async (id) => {
          const scenario = byId.get(id);
          if (!scenario) {
            return { scenario_id: id, shard: shard.index, passed: false, evidence: [], attribution: null };
          }
          return runScenario(scenario, shard.index, args, evidenceRoot);
        }),
      );
      results.push(...shardResults);
      // A failing shard stops the run: the next step is attribution and a new
      // candidate, never another blind pass over the remaining scenarios.
      if (shardResults.some((r) => !r.passed)) break;
    }

    return {
      candidate_id: args.candidate.candidate_id,
      plan,
      results,
      passed: results.length > 0 && results.every((r) => r.passed),
      preflight_failure: null,
    };
  } finally {
    for (const lease of leases) releaseResource(args.featureDir, lease.lease_id);
  }
}

async function runScenario(
  scenario: E2EScenario,
  shardIndex: number,
  args: E2ERunArgs,
  evidenceRoot: string,
): Promise<ScenarioResult> {
  const env = isolationEnv(args.candidate.candidate_id, scenario, evidenceRoot);
  for (const dir of [env['E2E_BROWSER_PROFILE_DIR'], env['E2E_TRACE_DIR'], env['E2E_SCREENSHOT_DIR']]) {
    if (dir) mkdirSync(dir, { recursive: true });
  }
  const evidence: EvidenceRecord[] = [];
  const scenarioEvidenceDir = join(evidenceRoot, scenario.id.replace(/[^A-Za-z0-9._-]/g, '_'));
  mkdirSync(scenarioEvidenceDir, { recursive: true });

  const run = (label: string, command: string[]): EvidenceRecord =>
    runVerification({
      kind: 'e2e',
      nodeId: scenario.id,
      repository: null,
      command,
      cwd: args.cwd,
      evidenceDir: scenarioEvidenceDir,
      label,
      env,
      candidateId: args.candidate.candidate_id,
      scenarioId: scenario.id,
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
    });

  try {
    if (scenario.setup_command && scenario.setup_command.length > 0) {
      const setup = run('setup', scenario.setup_command);
      evidence.push(setup);
      if (setup.failure_fingerprint !== null) {
        return {
          scenario_id: scenario.id,
          shard: shardIndex,
          passed: false,
          evidence,
          attribution: attributeFailure(
            scenario,
            args.graph,
            readFileSync(setup.output_path, 'utf8'),
          ),
        };
      }
    }

    const test = run('test', scenario.test_command);
    evidence.push(test);
    const passed = test.failure_fingerprint === null;
    return {
      scenario_id: scenario.id,
      shard: shardIndex,
      passed,
      evidence,
      attribution: passed
        ? null
        : attributeFailure(scenario, args.graph, readFileSync(test.output_path, 'utf8')),
    };
  } finally {
    // Cleanup runs whether the scenario passed, failed or threw.
    if (scenario.cleanup_command && scenario.cleanup_command.length > 0) {
      evidence.push(run('cleanup', scenario.cleanup_command));
    }
  }
}
