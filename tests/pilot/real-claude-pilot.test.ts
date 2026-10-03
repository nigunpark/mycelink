/**
 * Real-Claude pilot (opt-in; NOT part of `npm test`).
 *
 * Runs exactly one representative node with a real Claude Code session and
 * measures what the design requires before any fan-out is allowed: attempts,
 * unique model turns, token usage, wall-clock, hook bytes and verifier
 * quality.
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
      writeFileSync(
        join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'),
        YAML.stringify(portfolioGraph(), { lineWidth: 0 }),
        'utf8',
      );
      mkdirSync(join(p.featureDir, 'e2e'), { recursive: true });

      // Point the adapter at the REAL CLI for this run only.
      const config = JSON.parse(
        readFileSync(join(p.control, 'mycelink.config.json'), 'utf8'),
      ) as Record<string, unknown>;
      config['claude_executable'] = 'claude';
      config['session_adapter'] = 'claude-background';
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
      const summary = runSummary(featurePaths(p.control, FEATURE_ID).runs, NODE_ID);

      const measurements = {
        claude: claudeVersion(),
        node_id: NODE_ID,
        outcome: JSON.parse(run.out) as unknown,
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

      // A real session must still obey every gate: no unverified completion.
      if (runtime?.state === 'DONE') {
        expect(runtime.evidence.red?.red_reason).toBe('behaviour-missing');
        expect(runtime.evidence.green?.exit_code).toBe(0);
        expect(runtime.evidence.green?.command).toEqual(runtime.evidence.red?.command);
      } else {
        // Not done is an acceptable pilot result; silently passing is not.
        expect(['READY', 'BLOCKED', 'NEEDS_DECISION', 'BUDGET_EXHAUSTED', 'INVALIDATED']).toContain(
          runtime?.state,
        );
      }
    },
    30 * 60 * 1000,
  );
});
