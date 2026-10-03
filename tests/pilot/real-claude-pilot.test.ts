/**
 * Real-Claude pilot (opt-in; NOT part of `npm test`).
 *
 * Runs exactly one representative node with a real Claude Code session and
 * measures what the design requires before any fan-out is allowed: attempts,
 * unique model turns, token usage, wall-clock, hook bytes and verifier
 * quality.
 *
 * Passing requires a structured worker result with verified RED/GREEN
 * evidence, or a justified product decision; RESULT_MISSING fails the pilot
 * even when the session exited cleanly (rule in verdict.ts, unit-tested in
 * tests/unit/pilot-verdict.test.ts).
 *
 * This is the only suite that can incur model usage. It is skipped unless
 * MYCELINK_REAL_CLAUDE_PILOT=1 is set, and `npm test` excludes tests/pilot
 * entirely. Run it with: npm run test:pilot
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import {
  FEATURE_ID,
  commitControl,
  createPortfolio,
  portfolioGraph,
  writePrd,
  type Portfolio,
} from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { loadState } from '../../src/state/feature-state.js';
import { runSummary } from '../../src/loops/runs.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { claudeAvailable, claudeVersion } from '../helpers/isolated-profile.js';
import { loadRegistry } from '../../src/sessions/registry.js';
import { pilotVerdict, type PilotWorkerResult } from './verdict.js';

const ENABLED = process.env['MYCELINK_REAL_CLAUDE_PILOT'] === '1';
const NODE_ID = `${FEATURE_ID}.core.publish.impl`;

afterAll(() => cleanupTmpRoots());

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.warn(
    '[pilot] skipped. This suite uses real Claude model capacity. ' +
      'Enable deliberately with MYCELINK_REAL_CLAUDE_PILOT=1.',
  );
}

const describePilot = ENABLED && claudeAvailable() ? describe : describe.skip;

describePilot('real-Claude pilot: one representative node', () => {
  let p: Portfolio;

  async function cli(argv: string[]): Promise<{ code: number; out: string }> {
    let out = '';
    const io: CliIo = {
      out: (t) => {
        out += t + '\n';
      },
      err: () => {},
    };
    const code = await main([...argv, '--control-root', p.control], io);
    return { code, out };
  }

  it(
    'implements one node end to end with a real session and records the measurements',
    async () => {
      p = createPortfolio();
      writePrd(p);
      // The fixture's worker budget (20 counted turns, 2 minutes) is sized for
      // the fake. A real session counts every tool call as a turn, so the
      // pilot node gets a budget a real TDD loop can finish inside.
      const graph = portfolioGraph() as { nodes: { id: string; worker: Record<string, unknown> }[] };
      const pilotNode = graph.nodes.find((n) => n.id === NODE_ID);
      if (pilotNode) {
        pilotNode.worker['max_turns'] = 80;
        pilotNode.worker['max_wall_clock_minutes'] = 15;
      }
      writeFileSync(
        join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'),
        YAML.stringify(graph, { lineWidth: 0 }),
        'utf8',
      );
      mkdirSync(join(p.featureDir, 'e2e'), { recursive: true });

      // Point the adapter at the REAL CLI for this run only.
      const config = JSON.parse(
        readFileSync(join(p.control, 'mycelink.config.json'), 'utf8'),
      ) as Record<string, unknown>;
      config['claude_executable'] = 'claude';
      config['session_adapter'] = 'claude-background';
      config['session_timeout_ms'] = 15 * 60 * 1000;
      // The operator's least-privilege grant for this node type (see
      // docs/PERMISSION_MODEL.md): edit inside the fence, run the declared
      // verifier, and commit. The result file and the exact `mycelink tdd`
      // gate lines are pre-approved by the controller itself.
      config['claude_extra_args'] = [
        '--allowed-tools',
        'Read',
        'Glob',
        'Grep',
        'Edit(./src/**)',
        'Edit(./tests/**)',
        'Bash(node tests/run.mjs)',
        'Bash(git status:*)',
        'Bash(git diff:*)',
        'Bash(git add:*)',
        'Bash(git commit:*)',
        'Bash(git rev-parse:*)',
        'Bash(git log:*)',
      ];
      writeFileSync(
        join(p.control, 'mycelink.config.json'),
        JSON.stringify(config, null, 2),
        'utf8',
      );
      commitControl(p, 'pilot scaffold');

      expect((await cli(['feature', 'init', FEATURE_ID])).code).toBe(0);

      const started = Date.now();
      const run = await cli(['session', 'spawn', FEATURE_ID, NODE_ID, '--json']);
      const wallClockMs = Date.now() - started;

      const state = loadState(p.featureDir)?.data;
      const runtime = state?.nodes[NODE_ID];
      const paths = featurePaths(p.control, FEATURE_ID);
      const summary = runSummary(paths.runs, NODE_ID);
      const outcome = JSON.parse(run.out) as { detail?: string };

      // The structured result the controller accepted, from its own copy.
      const session = Object.values(loadRegistry(paths.sessionsRegistry).sessions)
        .filter((s) => s.node_id === NODE_ID)
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
        .pop();
      const workerResult =
        session?.result_path && existsSync(session.result_path)
          ? (JSON.parse(readFileSync(session.result_path, 'utf8')) as PilotWorkerResult & {
              commands?: unknown;
              commit_sha?: string | null;
              failure_fingerprint?: string | null;
            })
          : null;

      const verdict = pilotVerdict({
        final_state: runtime?.state,
        detail: outcome.detail ?? '',
        worker_result: workerResult,
        red: runtime?.evidence.red ?? null,
        green: runtime?.evidence.green ?? null,
      });

      const measurements = {
        claude: claudeVersion(),
        node_id: NODE_ID,
        verdict,
        outcome,
        worker_result: workerResult
          ? {
              outcome: workerResult.outcome,
              commit_sha: workerResult.commit_sha ?? null,
              failure_fingerprint: workerResult.failure_fingerprint ?? null,
              decision_request: workerResult.decision_request ?? null,
            }
          : null,
        session_log: session?.log_path ?? null,
        final_state: runtime?.state,
        attempts: runtime?.attempts,
        model_turns: runtime?.usage.model_turns,
        input_tokens: runtime?.usage.input_tokens,
        output_tokens: runtime?.usage.output_tokens,
        sessions: runtime?.usage.sessions,
        wall_clock_ms: wallClockMs,
        ledger: summary,
        red_evidence: runtime?.evidence.red
          ? {
              exit_code: runtime.evidence.red.exit_code,
              red_reason: runtime.evidence.red.red_reason,
              output_path: runtime.evidence.red.output_path,
            }
          : null,
        green_evidence: runtime?.evidence.green
          ? {
              exit_code: runtime.evidence.green.exit_code,
              output_path: runtime.evidence.green.output_path,
            }
          : null,
      };

      const reportDir = join(process.cwd(), 'implementation');
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        join(reportDir, 'PILOT-MEASUREMENTS.json'),
        JSON.stringify(measurements, null, 2) + '\n',
        'utf8',
      );

      // The pilot's purpose is measurement, so the measurements must exist
      // whatever the node's outcome.
      expect(existsSync(join(reportDir, 'PILOT-MEASUREMENTS.json'))).toBe(true);
      expect(measurements.sessions).toBeGreaterThanOrEqual(1);
      expect(measurements.model_turns).toBeGreaterThan(0);

      // The node is implementable. Only a structured result with verified
      // RED/GREEN, or a justified product decision, is a passing pilot;
      // RESULT_MISSING and every other non-ending fail it (see verdict.ts).
      expect(verdict.reasons).toEqual([]);
      expect(verdict.ok).toBe(true);
    },
    30 * 60 * 1000,
  );
});
