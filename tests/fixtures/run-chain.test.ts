/**
 * The /mycelink:run chain, executed deterministically.
 *
 * Every phase /mycelink:run lists is carried out here in order, through the
 * real CLI, the way the host carries it out: init the control repository,
 * write and commit the PRD, compile the graph and initialise the feature,
 * then dispatch -> Agent -> settle until the controller has cut the
 * candidate, then deliver. Nothing stops between phases: the run ends with
 * a delivered, accepted feature, and the phases it went through are exactly
 * the ones the command documents.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git, makeGitRepo } from '../helpers/git-fixture.js';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { loadState } from '../../src/state/feature-state.js';
import { runPhases } from '../helpers/run-phases.js';

afterAll(() => cleanupTmpRoots());

const FEATURE = 'FEAT-777';

function runner(file: string, marker: string): string {
  return `import { existsSync, readFileSync } from 'node:fs';
if (!existsSync(${JSON.stringify(file)}) || !readFileSync(${JSON.stringify(file)}, 'utf8').includes(${JSON.stringify(marker)})) {
  console.error('AssertionError: ${file} lacks ${marker}');
  process.exit(1);
}
console.log('ok');
`;
}

async function run(argv: string[], control: string, key?: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const dd = argv.indexOf('--');
  const extra = ['--control-root', control, ...(key ? ['--authority', key] : [])];
  const full = dd === -1 ? [...argv, ...extra] : [...argv.slice(0, dd), ...extra, ...argv.slice(dd)];
  const code = await main(full, io);
  return { code, out, err };
}

const budget = { model: 'sonnet', max_turns: 20, max_wall_clock_minutes: 2, max_attempts: 2, nested_delegation: false };

function graph(): Record<string, unknown> {
  const impl = (repo: string, file: string, marker: string, deps: string[], ac: string) => ({
    id: `${FEATURE}.${repo}.impl`,
    level: 'executable-node',
    repository: repo,
    capability: `CAP-${repo.toUpperCase()}`,
    node_type: 'implementation',
    depends_on: deps,
    allowed_paths: ['src/**'],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [{ id: 'targeted', command: ['node', 'tests/run.mjs'] }],
    worker: budget,
    invalidation_rules: [],
    acceptance_criteria: [ac],
    _file: file,
    _marker: marker,
  });
  const nodes = [impl('core', 'src/core.js', 'CORE_V1', [], 'AC-1'), impl('api', 'src/api.js', 'API_V1', [`${FEATURE}.core.impl`], 'AC-2')].map(
    ({ _file, _marker, ...n }) => n,
  );
  return {
    schema_version: 1,
    feature_id: FEATURE,
    title: 'Run chain',
    prd: 'PRD.md',
    acceptance_criteria: [
      { id: 'AC-1', text: 'core' },
      { id: 'AC-2', text: 'api' },
    ],
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['core', 'api'],
    capabilities: [
      { id: 'CAP-CORE', repository: 'core', title: 'core', acceptance_criteria: ['AC-1'] },
      { id: 'CAP-API', repository: 'api', title: 'api', acceptance_criteria: ['AC-2'] },
    ],
    nodes: [
      ...nodes,
      {
        id: `${FEATURE}.release.candidate.build`,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: nodes.map((n) => n.id),
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', FEATURE] }],
        worker: { ...budget, max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

const WORK: Record<string, Record<string, string>> = {
  [`${FEATURE}.core.impl`]: { 'src/core.js': 'export const CORE_V1 = true;\n' },
  [`${FEATURE}.api.impl`]: { 'src/api.js': 'export const API_V1 = true;\n' },
};

describe('/mycelink:run, init to delivery, without stopping', () => {
  it('runs every documented phase in order and ends delivered', async () => {
    const documented = runPhases(readFileSync(join(REPO_ROOT, 'commands', 'run.md'), 'utf8').replace(/\r\n/g, '\n'));
    const done: string[] = [];
    const root = makeTmpDir('run-chain-');
    const control = join(root, 'control');
    const repos = { core: join(root, 'core'), api: join(root, 'api') };
    makeGitRepo(repos.core, { files: { 'src/.gitkeep': '', 'tests/run.mjs': runner('src/core.js', 'CORE_V1') } });
    makeGitRepo(repos.api, { files: { 'src/.gitkeep': '', 'tests/run.mjs': runner('src/api.js', 'API_V1') } });

    // init: the control repository, the key, the repositories, committed.
    makeGitRepo(control, { files: { 'README.md': '# control\n' } });
    expect((await run(['init', control], control)).code).toBe(0);
    const opened = await run(['controller', 'open', '--json'], control);
    const key = (JSON.parse(opened.out) as { authority: string }).authority;
    for (const [name, path] of Object.entries(repos)) {
      const r = await run(['repo', 'register', '--name', name, '--path', relative(control, path).replace(/\\/g, '/'), '--base-branch', 'main', '--', 'node', 'tests/run.mjs'], control, key);
      expect(r.err).toBe('');
    }
    commitAll(control, 'mycelink control plane');
    done.push('init');

    // prd: a file, committed; then straight on.
    const featureDir = join(control, 'features', FEATURE);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'PRD.md'), `# ${FEATURE}\n\n- AC-1: core.\n- AC-2: api.\n`);
    commitAll(control, `${FEATURE}: PRD`);
    done.push('prd');

    // plan: graph, feature init, loop contracts, committed.
    writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(graph(), { lineWidth: 0 }));
    expect((await run(['graph', 'validate', FEATURE], control)).code).toBe(0);
    expect((await run(['feature', 'init', FEATURE], control, key)).err).toBe('');
    expect((await run(['loop', 'validate', FEATURE], control)).code).toBe(0);
    commitAll(control, `${FEATURE}: plan`);
    done.push('plan');

    // dispatch -> Agent -> settle, until the controller reports ALL_SETTLED;
    // the candidate build runs inside dispatch.
    let status = '';
    for (let i = 0; i < 9 && status !== 'ALL_SETTLED'; i++) {
      const d = JSON.parse((await run(['dispatch', FEATURE, '--json'], control, key)).out) as {
        status: string;
        ticket?: DispatchTicket;
        controller_reports: { node_id: string; outcome: string }[];
      };
      status = d.status;
      if (d.controller_reports.some((r) => r.node_id.endsWith('.candidate.build') && r.outcome === 'DONE') && !done.includes('candidate')) done.push('candidate');
      if (status !== 'DISPATCHED') break;
      if (!done.includes('dispatch')) done.push('dispatch');
      const t = d.ticket!;
      fakeAgent(t, { impl: WORK[t.node_id] }, control);
      const s = JSON.parse((await run(['settle', FEATURE, t.node_id, '--capability', t.capability, '--json'], control)).out) as { outcome: string };
      expect(s.outcome).toBe('DONE');
      if (!done.includes('settle')) done.push('settle');
    }
    expect(status).toBe('ALL_SETTLED');

    // deliver.
    expect((await run(['feature', 'verify', FEATURE], control)).code).toBe(0);
    expect((await run(['candidate', 'verify', FEATURE], control)).code).toBe(0);
    const delivered = await run(['deliver', FEATURE, '--json'], control, key);
    expect(delivered.err).toBe('');
    expect(JSON.parse(delivered.out)).toMatchObject({ status: 'ACCEPTED' });
    done.push('deliver');

    expect(done).toEqual(documented);
    expect(loadState(featureDir)!.data.feature_state).toBe('COMPLETED');
    const candidate = loadState(featureDir)!.data.current_candidate!;
    const manifest = YAML.parse(readFileSync(join(featureDir, 'candidates', `${candidate}.yaml`), 'utf8')) as { repositories: Record<string, { sha: string }> };
    for (const [name, path] of Object.entries(repos)) expect(git(path, ['rev-parse', 'main'])).toBe(manifest.repositories[name]!.sha);
  });
});
