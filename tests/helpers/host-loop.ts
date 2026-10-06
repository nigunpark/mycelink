/**
 * The host loop the plugin's /mycelink:run command describes, driven with
 * the fake Agent: dispatch -> Agent(ticket) -> settle, until the controller
 * says the feature is settled or stops for a reason.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { expect } from 'vitest';
import { main, type CliIo } from '../../src/cli/cli.js';
import { FEATURE_ID, commitControl, createPortfolio, portfolioGraph, writePrd, type Portfolio } from './portfolio-fixture.js';
import { fakeAgent, type AgentBehaviour, type DispatchTicket } from './host-agent.js';
import { asController } from './authority.js';

export const CORE = `${FEATURE_ID}.core.publish.impl`;
export const API = `${FEATURE_ID}.api.consume.impl`;
export const WEB = `${FEATURE_ID}.web.render.impl`;
export const CANDIDATE = `${FEATURE_ID}.release.candidate.build`;

export const WORK: Record<string, AgentBehaviour> = {
  [CORE]: { impl: { 'src/publish.js': 'export const JOB_RESULT_V2 = true;\n' } },
  [API]: { impl: { 'src/consume.js': 'export const JOB_RESULT_V2 = true;\n' } },
  [WEB]: { impl: { 'src/view.js': 'export const RENDER_JOB_RESULT = true;\n' } },
};

export interface CliRun {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI in-process as the controller: controller-only commands carry the controller key. */
export async function cli(p: Portfolio, argv: string[]): Promise<CliRun> {
  return cliRaw(p, asController(argv, p.control));
}

/** Run the CLI in-process exactly as given (a worker, or a test of the authority itself). */
export async function cliRaw(p: Portfolio, argv: string[]): Promise<CliRun> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const dd = argv.indexOf('--');
  const withRoot =
    dd === -1 ? [...argv, '--control-root', p.control] : [...argv.slice(0, dd), '--control-root', p.control, ...argv.slice(dd)];
  const code = await main(withRoot, io);
  return { code, out, err };
}

export interface DispatchOut {
  status: string;
  detail: string;
  ticket?: DispatchTicket;
  controller_reports: { node_id: string; outcome: string }[];
  pending: { node_id: string; expired: boolean }[];
}

export async function dispatch(p: Portfolio, extra: string[] = []): Promise<DispatchOut> {
  const r = await cli(p, ['dispatch', FEATURE_ID, '--json', ...extra]);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as DispatchOut;
}

export async function settle(p: Portfolio, nodeId: string, capability: string): Promise<Record<string, unknown>> {
  const r = await cli(p, ['settle', FEATURE_ID, nodeId, '--capability', capability, '--json']);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as Record<string, unknown>;
}

/** The fixture graph without the browser E2E node. */
export function hostGraph(): Record<string, unknown> {
  const g = portfolioGraph() as { nodes: { node_type: string }[] };
  g.nodes = g.nodes.filter((n) => n.node_type !== 'e2e-scenario');
  return g;
}

/** A committed, initialised fixture whose standalone adapter cannot run at all. */
export async function hostPortfolio(graph: Record<string, unknown> = hostGraph()): Promise<Portfolio> {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(graph, { lineWidth: 0 }));
  const configPath = join(p.control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, session_adapter: 'claude-background', claude_executable: join(p.root, 'no-such-claude') }, null, 2) + '\n',
  );
  const init = await cli(p, ['feature', 'init', FEATURE_ID]);
  expect(init.err).toBe('');
  commitControl(p, 'feature scaffolding');
  return p;
}

/** Bounded host loop. Returns the terminal dispatch status and every ticket fulfilled. */
export async function hostLoop(
  p: Portfolio,
  work: Record<string, AgentBehaviour> = WORK,
  maxIterations = 12,
): Promise<{ status: string; tickets: DispatchTicket[] }> {
  const tickets: DispatchTicket[] = [];
  for (let i = 0; i < maxIterations; i++) {
    const d = await dispatch(p);
    if (d.status !== 'DISPATCHED') return { status: d.status, tickets };
    const t = d.ticket as DispatchTicket;
    tickets.push(t);
    fakeAgent(t, work[t.node_id] ?? {}, p.control);
    await settle(p, t.node_id, t.capability);
  }
  return { status: 'MAX_ITERATIONS', tickets };
}
