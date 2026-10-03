/**
 * Disposable three-repository portfolio fixture.
 *
 * core (producer) -> api (consumer) -> web (UI), plus an
 * control repository. Everything is real: real git repos, real
 * test commands, real exit codes. No company source is involved.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { makeGitRepo, commitAll, git } from './git-fixture.js';
import { makeTmpDir } from './tmp.js';
import { buildHookSettings } from '../../src/workspace/hook-settings.js';

export const FEATURE_ID = 'FEAT-901';

export interface Portfolio {
  root: string;
  control: string;
  core: string;
  api: string;
  app: string;
  featureDir: string;
  mycelink: string;
  fakeClaude: string;
  scenarioFile: string;
}

/**
 * Each repository's test runner. It checks for a required marker in source,
 * so a test genuinely fails before the implementation exists and genuinely
 * passes after — no mocking of the verdict.
 */
function testRunner(sourceFile: string, marker: string): string {
  return `import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.cwd(), ${JSON.stringify(sourceFile)});
if (!existsSync(file)) {
  console.error('AssertionError: expected ' + ${JSON.stringify(sourceFile)} + ' to exist');
  process.exit(1);
}
const body = readFileSync(file, 'utf8');
if (!body.includes(${JSON.stringify(marker)})) {
  console.error('AssertionError: expected ' + ${JSON.stringify(sourceFile)} + ' to contain ' + ${JSON.stringify(marker)});
  process.exit(1);
}
console.log('ok 1 - ' + ${JSON.stringify(marker)});
`;
}

/** A contract-aware runner: the consumer must agree with the producer's version. */
function contractRunner(sourceFile: string, contractRelPath: string): string {
  return `import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.cwd(), ${JSON.stringify(sourceFile)});
const contractPath = process.env.CONTRACT_PATH ?? ${JSON.stringify(contractRelPath)};
if (!existsSync(file)) {
  console.error('AssertionError: expected ' + ${JSON.stringify(sourceFile)} + ' to exist');
  process.exit(1);
}
if (!existsSync(contractPath)) {
  console.error('AssertionError: contract missing at ' + contractPath);
  process.exit(1);
}
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const body = readFileSync(file, 'utf8');
const needle = 'JOB_RESULT_V' + contract.version;
if (!body.includes(needle)) {
  console.error('AssertionError: ' + ${JSON.stringify(sourceFile)} + ' does not handle ' + needle +
    ' (contract ' + contractPath + ' is at version ' + contract.version + ')');
  process.exit(1);
}
console.log('ok 1 - handles ' + needle);
`;
}

/**
 * Materialise the current candidate into `.mycelink/deploy/<repo>`.
 *
 * This is the fixture's stand-in for a real deployment: it checks out each
 * repository at exactly the SHA the candidate manifest bound, so the E2E
 * genuinely runs against the immutable candidate rather than whatever happens
 * to be in a working tree.
 */
const DEPLOY_SCRIPT = `import { readdirSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'node:path';

const control = process.cwd();
const featuresDir = join(control, 'features');
const featureId = process.env.MYCELINK_FEATURE_ID ?? readdirSync(featuresDir).filter((f) => !f.startsWith('.'))[0];
const featureDir = join(featuresDir, featureId);
const state = JSON.parse(readFileSync(join(featureDir, 'STATE.json'), 'utf8')).data;
const candidateId = state.current_candidate;
if (!candidateId) {
  console.error('deploy: no current candidate');
  process.exit(1);
}
const manifestText = readFileSync(join(featureDir, 'candidates', candidateId + '.yaml'), 'utf8');

// Minimal YAML read: we only need "<name>:\\n  sha: <sha>" pairs under repositories.
const repos = {};
let inRepos = false;
let current = null;
for (const raw of manifestText.split(/\\r?\\n/)) {
  if (/^repositories:/.test(raw)) { inRepos = true; continue; }
  if (inRepos && /^\\S/.test(raw)) { inRepos = false; }
  if (!inRepos) continue;
  const name = /^  ([A-Za-z0-9_-]+):\\s*$/.exec(raw);
  if (name) { current = name[1]; repos[current] = {}; continue; }
  const sha = /^    sha:\\s*([0-9a-f]{40})\\s*$/.exec(raw);
  if (sha && current) repos[current].sha = sha[1];
}

const manifestPaths = JSON.parse(readFileSync(join(control, 'repositories.yaml.json'), 'utf8'));
const deployRoot = join(control, '.mycelink', 'deploy');
rmSync(deployRoot, { recursive: true, force: true });
for (const [name, bound] of Object.entries(repos)) {
  const repoPath = resolve(control, manifestPaths[name]);
  const target = join(deployRoot, name);
  mkdirSync(target, { recursive: true });
  execFileSync('git', ['--work-tree=' + target, 'checkout', bound.sha, '--', '.'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['reset'], { cwd: repoPath, stdio: 'ignore' });
}
console.log('deployed ' + candidateId + ' -> ' + deployRoot);
void parse;
void existsSync;
`;

const HEALTHCHECK_SCRIPT = `import { existsSync } from 'node:fs';
import { join } from 'node:path';
const deployRoot = join(process.cwd(), '.mycelink', 'deploy');
for (const repo of ['core', 'api', 'web']) {
  if (!existsSync(join(deployRoot, repo))) {
    console.error('healthcheck: ' + repo + ' is not deployed');
    process.exit(1);
  }
}
console.log('healthcheck ok');
`;

const RESET_SCRIPT = `import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const fixtures = join(process.cwd(), '.mycelink', 'fixture-data');
rmSync(fixtures, { recursive: true, force: true });
mkdirSync(fixtures, { recursive: true });
console.log('fixture reset');
`;

/** `root` lets a test place the portfolio under another spelling of a scratch dir. */
export function createPortfolio(root: string = makeTmpDir('portfolio-')): Portfolio {
  const control = join(root, 'control');
  const core = join(root, 'core');
  const api = join(root, 'api');
  const app = join(root, 'web');

  // Producer: owns the order-status contract.
  makeGitRepo(core, {
    files: {
      'src/.gitkeep': '',
      'tests/run.mjs': testRunner('src/publish.js', 'JOB_RESULT_V2'),
      'README.md': '# core\n',
    },
  });

  // Consumer: must agree with whatever version the contract declares.
  makeGitRepo(api, {
    files: {
      'src/.gitkeep': '',
      'tests/run.mjs': contractRunner('src/consume.js', resolve(control, 'contracts/order-status.json').replace(/\\/g, '/')),
      'README.md': '# api\n',
    },
  });

  // UI.
  makeGitRepo(app, {
    files: {
      'src/.gitkeep': '',
      'tests/run.mjs': testRunner('src/view.js', 'RENDER_JOB_RESULT'),
      'README.md': '# web\n',
    },
  });

  const mycelink = resolve(process.cwd(), 'bin', 'mycelink.mjs');
  const fakeClaude = resolve(process.cwd(), 'tests', 'fake-claude', 'claude.mjs');

  makeGitRepo(control, {
    files: {
      'README.md': '# control\n',
      // What `mycelink init` writes: project hooks pointing at this checkout.
      '.claude/settings.json': JSON.stringify({ hooks: buildHookSettings(mycelink) }, null, 2) + '\n',
      'contracts/order-status.json': JSON.stringify({ name: 'order-status', version: 2 }, null, 2) + '\n',
      'mycelink.config.json':
        JSON.stringify(
          {
            schema_version: 1,
            claude_executable: fakeClaude,
            session_adapter: 'fake-claude',
            claude_extra_args: [],
            session_timeout_ms: 120000,
            context_pack_max_bytes: 16384,
            hook_session_start_max_bytes: 4096,
            hook_prompt_delta_max_bytes: 2048,
            brain_dir: null,
          },
          null,
          2,
        ) + '\n',
      'repositories.yaml':
        YAML.stringify(
          {
            schema_version: 1,
            repositories: [
              {
                name: 'core',
                path: relative(control, core).replace(/\\/g, '/'),
                base_branch: 'main',
                role: 'producer',
                commands: { test: ['node', 'tests/run.mjs'] },
              },
              {
                name: 'api',
                path: relative(control, api).replace(/\\/g, '/'),
                base_branch: 'main',
                role: 'service',
                commands: { test: ['node', 'tests/run.mjs'] },
              },
              {
                name: 'web',
                path: relative(control, app).replace(/\\/g, '/'),
                base_branch: 'main',
                role: 'client',
                commands: { test: ['node', 'tests/run.mjs'] },
              },
            ],
          },
          { lineWidth: 0 },
        ),
      // Feature state is tracked, as the design requires. Only the scratch
      // worktree/integration/deploy area is ignored.
      '.gitignore': '.mycelink/\n',
      'scripts/deploy-candidate.mjs': DEPLOY_SCRIPT,
      'scripts/healthcheck.mjs': HEALTHCHECK_SCRIPT,
      'scripts/reset-fixture.mjs': RESET_SCRIPT,
      // A tiny name -> path map so the deploy script does not need a YAML parser.
      'repositories.yaml.json':
        JSON.stringify(
          {
            core: relative(control, core).replace(/\\/g, '/'),
            'api': relative(control, api).replace(/\\/g, '/'),
            'web': relative(control, app).replace(/\\/g, '/'),
          },
          null,
          2,
        ) + '\n',
    },
  });

  const featureDir = join(control, 'features', FEATURE_ID);
  mkdirSync(featureDir, { recursive: true });

  return {
    root,
    control,
    core,
    api,
    app,
    featureDir,
    mycelink,
    fakeClaude,
    scenarioFile: join(root, 'fake-claude-scenario.json'),
  };
}

/** The approved PRD for the fixture feature. */
export const PRD = `# ${FEATURE_ID} — Order status notifications

## Acceptance criteria

- AC-1: the core publishes an order-status event at the contracted version.
- AC-2: the API consumes that event and exposes the result.
- AC-3: the Windows app renders the result for the operator.
`;

export function writePrd(p: Portfolio): void {
  writeFileSync(join(p.featureDir, 'PRD.md'), PRD, 'utf8');
}

interface WorkerBudgetOverrides {
  max_turns?: number;
  max_attempts?: number;
  max_wall_clock_minutes?: number;
}

function worker(overrides: WorkerBudgetOverrides = {}): Record<string, unknown> {
  return {
    model: 'sonnet',
    effort: 'high',
    max_turns: overrides.max_turns ?? 20,
    max_wall_clock_minutes: overrides.max_wall_clock_minutes ?? 2,
    max_attempts: overrides.max_attempts ?? 2,
    nested_delegation: false,
  };
}

/** The four-layer portfolio graph for the fixture feature. */
export function portfolioGraph(): Record<string, unknown> {
  return {
    schema_version: 1,
    feature_id: FEATURE_ID,
    title: 'Order status notifications',
    prd: 'PRD.md',
    acceptance_criteria: [
      { id: 'AC-1', text: 'The core publishes an order-status event at the contracted version.' },
      { id: 'AC-2', text: 'The API consumes that event and exposes the result.' },
      { id: 'AC-3', text: 'The Windows app renders the result for the operator.' },
    ],
    resources: {
      'full-runtime': { capacity: 1 },
      'deploy-slot': { capacity: 1 },
      'browser-worker': { capacity: 2 },
      'fixture-global-reset': { capacity: 1 },
    },
    repositories: ['core', 'api', 'web'],
    capabilities: [
      { id: 'CAP-CORE-PUBLISH', repository: 'core', title: 'Publish order-status events', acceptance_criteria: ['AC-1'] },
      { id: 'CAP-API-CONSUME', repository: 'api', title: 'Consume order-status events', acceptance_criteria: ['AC-2'] },
      { id: 'CAP-APP-RENDER', repository: 'web', title: 'Render the order status', acceptance_criteria: ['AC-3'] },
    ],
    nodes: [
      {
        id: `${FEATURE_ID}.core.publish.impl`,
        level: 'executable-node',
        repository: 'core',
        capability: 'CAP-CORE-PUBLISH',
        node_type: 'implementation',
        depends_on: [],
        allowed_paths: ['src/**', 'tests/**'],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: ['contracts/order-status.json'],
        required_resources: [],
        required_evidence: ['red', 'green', 'regression'],
        verification_commands: [{ id: 'targeted', command: ['node', 'tests/run.mjs'] }],
        worker: worker(),
        invalidation_rules: [],
        acceptance_criteria: ['AC-1'],
      },
      {
        id: `${FEATURE_ID}.api.consume.impl`,
        level: 'executable-node',
        repository: 'api',
        capability: 'CAP-API-CONSUME',
        node_type: 'implementation',
        depends_on: [`${FEATURE_ID}.core.publish.impl`],
        allowed_paths: ['src/**', 'tests/**'],
        forbidden_paths: [],
        contract_inputs: ['contracts/order-status.json'],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['red', 'green', 'regression'],
        verification_commands: [{ id: 'targeted', command: ['node', 'tests/run.mjs'] }],
        worker: worker(),
        invalidation_rules: [],
        acceptance_criteria: ['AC-2'],
      },
      {
        id: `${FEATURE_ID}.web.render.impl`,
        level: 'executable-node',
        repository: 'web',
        capability: 'CAP-APP-RENDER',
        node_type: 'implementation',
        depends_on: [`${FEATURE_ID}.api.consume.impl`],
        allowed_paths: ['src/**', 'tests/**'],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['red', 'green', 'regression'],
        verification_commands: [{ id: 'targeted', command: ['node', 'tests/run.mjs'] }],
        worker: worker(),
        invalidation_rules: [],
        acceptance_criteria: ['AC-3'],
      },
      {
        id: `${FEATURE_ID}.release.candidate.build`,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: [
          `${FEATURE_ID}.core.publish.impl`,
          `${FEATURE_ID}.api.consume.impl`,
          `${FEATURE_ID}.web.render.impl`,
        ],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', FEATURE_ID] }],
        worker: worker({ max_turns: 1 }),
        invalidation_rules: [],
        acceptance_criteria: [],
      },
      {
        id: `${FEATURE_ID}.release.acceptance.e2e`,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'e2e-scenario',
        depends_on: [`${FEATURE_ID}.release.candidate.build`],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: ['full-runtime'],
        required_evidence: ['e2e'],
        // The runtime sequence is part of the graph, not a hidden flag:
        // deploy the immutable candidate, prove it is up, reset fixtures.
        verification_commands: [
          { id: 'deploy', command: ['node', 'scripts/deploy-candidate.mjs'] },
          { id: 'healthcheck', command: ['node', 'scripts/healthcheck.mjs'] },
          { id: 'fixture-reset', command: ['node', 'scripts/reset-fixture.mjs'] },
        ],
        worker: worker({ max_turns: 1 }),
        invalidation_rules: [],
        acceptance_criteria: ['AC-1', 'AC-2', 'AC-3'],
      },
    ],
  };
}

/**
 * Three E2E scenarios: two fully isolated (parallel) and one that resets the
 * global fixture and mutates global state (must be serialised).
 */
export function e2eScenarios(p: Portfolio): { id: string; yaml: string }[] {
  /**
   * Assert against the DEPLOYED candidate, never a working tree. The
   * deployment is materialised by scripts/deploy-candidate.mjs at exactly the
   * SHAs the candidate manifest bound.
   */
  const check = (name: string): string[] => [
    'node',
    '-e',
    `const {readFileSync,existsSync}=require('node:fs');const {join}=require('node:path');` +
      `const deploy=join(process.cwd(),'.mycelink','deploy');` +
      `const contract=JSON.parse(readFileSync(join(process.cwd(),'contracts','order-status.json'),'utf8'));` +
      `const view=join(deploy,'web','src','view.js');` +
      `const consume=join(deploy,'api','src','consume.js');` +
      `if(!existsSync(view)){console.error('AssertionError: ${name}: deployed view missing');process.exit(1);}` +
      `if(!existsSync(consume)){console.error('AssertionError: ${name}: deployed consumer missing');process.exit(1);}` +
      `if(!readFileSync(view,'utf8').includes('RENDER_JOB_RESULT')){console.error('AssertionError: ${name}: view does not render the order status');process.exit(1);}` +
      `const needle='JOB_RESULT_V'+contract.version;` +
      `if(!readFileSync(consume,'utf8').includes(needle)){console.error('AssertionError: ${name}: contracts/order-status.json is at version '+contract.version+' but the deployed consumer does not handle '+needle);process.exit(1);}` +
      `console.log('ok ${name} namespace='+(process.env.E2E_DATA_NAMESPACE||'-')+' account='+(process.env.E2E_ACCOUNT||'-'));`,
  ];

  return [
    {
      id: 'E2E-create',
      yaml: YAML.stringify(
        {
          schema_version: 1,
          id: 'E2E-create',
          title: 'Operator sees a newly created order status',
          depends_on: [],
          acceptance_criteria: ['AC-1', 'AC-2', 'AC-3'],
          resources: ['browser-worker'],
          isolation: {
            browser_profile: 'unique',
            account: 'unique',
            data_namespace: 'unique',
            global_fixture_reset: false,
            mutates_global_state: false,
            order_dependent: false,
            writes: ['db:jobs_create'],
          },
          conflicts_with: [],
          test_command: check('E2E-create'),
          attributed_nodes: [],
          evidence: { screenshots: true, trace: true, junit: true },
        },
        { lineWidth: 0 },
      ),
    },
    {
      id: 'E2E-update',
      yaml: YAML.stringify(
        {
          schema_version: 1,
          id: 'E2E-update',
          title: 'Operator sees an updated order status',
          depends_on: [],
          acceptance_criteria: ['AC-2', 'AC-3'],
          resources: ['browser-worker'],
          isolation: {
            browser_profile: 'unique',
            account: 'unique',
            data_namespace: 'unique',
            global_fixture_reset: false,
            mutates_global_state: false,
            order_dependent: false,
            writes: ['db:jobs_update'],
          },
          conflicts_with: [],
          test_command: check('E2E-update'),
          attributed_nodes: [],
          evidence: { screenshots: true, trace: true, junit: true },
        },
        { lineWidth: 0 },
      ),
    },
    {
      id: 'E2E-global-reset',
      yaml: YAML.stringify(
        {
          schema_version: 1,
          id: 'E2E-global-reset',
          title: 'Admin resets global state and re-checks the dashboard',
          depends_on: [],
          acceptance_criteria: ['AC-3'],
          resources: ['browser-worker', 'fixture-global-reset'],
          isolation: {
            browser_profile: 'shared',
            account: 'global-admin',
            data_namespace: 'shared',
            global_fixture_reset: true,
            mutates_global_state: true,
            order_dependent: true,
            writes: ['global:settings'],
          },
          conflicts_with: [],
          test_command: check('E2E-global-reset'),
          attributed_nodes: [],
          evidence: { screenshots: true, trace: true, junit: true },
        },
        { lineWidth: 0 },
      ),
    },
  ];
}

/** Commit the control repo, tolerating "nothing to commit". */
export function commitControl(p: Portfolio, message: string): string | null {
  if (git(p.control, ['status', '--porcelain']).trim() === '') return null;
  return commitAll(p.control, message);
}
