/**
 * A CSET-202-shaped portfolio, small enough for every platform: one
 * repository, `shop`, with four runtime modules — errors, read, assemble,
 * cli — and a declaration-only one (types). The modules use each other the
 * way Changesets' packages do: read and assemble throw the error class the
 * errors module exports, and cli statically imports from all three, so a
 * missing export fails cli's test files before any test runs (the r1
 * with-faults poisoning). Tests run with Node's own runner.
 *
 * The feature, SHOP-202 (report every invalid changeset at once):
 *   AC-1 errors   ChangesetValidationError, issues sorted, one line each
 *   AC-2 read     every unparseable changeset, in one error
 *   AC-3 assemble every unknown package, in one error
 *   AC-4 cli      status prints the error once and exits 1
 *   AC-5 compatibility: valid changesets read, plan and print as before
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { main, type CliIo } from '../../src/cli/cli.js';
import { modulesOf, verifierFor, type ResolvedModule } from '../../src/engine/modules.js';
import type { RepositoryDecl } from '../../src/model/types.js';
import { buildHookSettings } from '../../src/workspace/hook-settings.js';
import { ensureScratchIgnored } from '../../src/workspace/workspace.js';
import { hashGraph } from '../../src/graph/validate.js';
import { mutateState } from '../../src/state/feature-state.js';
import { asController } from './authority.js';
import { commitAll, git, makeGitRepo } from './git-fixture.js';
import { makeTmpDir } from './tmp.js';

export const SHOP_FEATURE = 'SHOP-202';
export const ERRORS = `${SHOP_FEATURE}.shop.errors.impl`;
export const READ = `${SHOP_FEATURE}.shop.read.impl`;
export const ASSEMBLE = `${SHOP_FEATURE}.shop.assemble.impl`;
export const CLI_NODE = `${SHOP_FEATURE}.shop.cli.impl`;
export const SHOP_CANDIDATE = `${SHOP_FEATURE}.release.candidate.build`;

/** The whole suite, as the repository runs it (candidate, regression, acceptance). */
export const FULL_SUITE = ['node', '--test', 'packages/*/test/**/*.test.mjs'];

export const BASE_FILES: Record<string, string> = {
  'package.json': '{ "name": "shop", "private": true, "type": "module" }\n',
  'README.md': '# shop\n',
  'packages/errors/src/index.mjs': `export class GitError extends Error {
  constructor(code, message) {
    super(\`\${message}, exit code: \${code}\`);
    this.code = code;
  }
}
`,
  'packages/errors/test/errors.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitError } from '../src/index.mjs';

test('a git error carries its exit code', () => {
  assert.equal(new GitError(1, 'failed').code, 1);
});
`,
  'packages/read/src/index.mjs': `/** Every changeset of \`files\` (\`{ id: text }\`), parsed, in id order. */
export function readChangesets(files) {
  return Object.keys(files).sort().map((id) => parseChangeset(id, files[id]));
}

export function parseChangeset(id, text) {
  const m = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(text);
  if (!m) throw new Error(\`could not parse changeset \${id}: missing frontmatter\\nChangesets start with frontmatter delimited by "---".\`);
  const releases = m[1].split('\\n').filter(Boolean).map((line) => {
    const [name, type] = line.split(':').map((s) => s.trim());
    return { name, type };
  });
  return { id, releases, summary: m[2].trim() };
}
`,
  'packages/read/test/read.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChangesets } from '../src/index.mjs';

test('reads valid changesets in id order', () => {
  const read = readChangesets({ b: '---\\nweb: patch\\n---\\nfix', a: '---\\napi: minor\\n---\\nadd' });
  assert.deepEqual(read.map((c) => [c.id, c.releases]), [['a', [{ name: 'api', type: 'minor' }]], ['b', [{ name: 'web', type: 'patch' }]]]);
});
`,
  'packages/assemble/src/index.mjs': `/** The release plan of \`changesets\` over the workspace's \`packages\`. */
export function assembleReleasePlan(changesets, packages) {
  const releases = new Map();
  for (const changeset of changesets) {
    for (const release of changeset.releases) {
      if (!packages.includes(release.name)) throw new Error(\`Found changeset \${changeset.id} for package \${release.name} which is not in the workspace\`);
      releases.set(release.name, release.type);
    }
  }
  return { releases: [...releases].map(([name, type]) => ({ name, type })).sort((a, b) => (a.name < b.name ? -1 : 1)) };
}
`,
  'packages/assemble/test/assemble.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReleasePlan } from '../src/index.mjs';

test('plans one release per package', () => {
  const plan = assembleReleasePlan([{ id: 'a', releases: [{ name: 'web', type: 'patch' }] }], ['web', 'api']);
  assert.deepEqual(plan.releases, [{ name: 'web', type: 'patch' }]);
});
`,
  'packages/cli/src/index.mjs': `import { readChangesets } from '../../read/src/index.mjs';
import { assembleReleasePlan } from '../../assemble/src/index.mjs';

/** \`changeset status\`: the plan for \`files\` in \`packages\`, written through \`io\`. Returns the exit code. */
export function status({ files, packages, io }) {
  const plan = assembleReleasePlan(readChangesets(files), packages);
  for (const r of plan.releases) io.log(\`\${r.name}: \${r.type}\`);
  return 0;
}
`,
  'packages/cli/test/cli.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status } from '../src/index.mjs';

test('status prints the plan', () => {
  const lines = [];
  const code = status({ files: { a: '---\\nweb: patch\\n---\\nfix' }, packages: ['web'], io: { log: (l) => lines.push(l), error: (l) => lines.push('E ' + l) } });
  assert.equal(code, 0);
  assert.deepEqual(lines, ['web: patch']);
});
`,
  'packages/types/src/index.d.ts': "export type VersionType = 'major' | 'minor' | 'patch';\n",
};

/** The error class AC-1 asks for. */
export const ERRORS_IMPL = `export class GitError extends Error {
  constructor(code, message) {
    super(\`\${message}, exit code: \${code}\`);
    this.code = code;
  }
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export class ChangesetValidationError extends Error {
  constructor(issues) {
    const sorted = [...issues].sort((a, b) => compare(a.changesetId, b.changesetId) || compare(a.code, b.code) || compare(a.message, b.message));
    super(['Invalid changesets:', ...sorted.map((i) => \`- \${i.changesetId}: \${i.message}\`)].join('\\n'));
    this.issues = sorted;
  }
}
`;

/** RED for AC-1 that inspects the module: it compiles and fails an assertion while the class does not exist. */
export const ERRORS_RED = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitError } from '../src/index.mjs';

test('a git error carries its exit code', () => {
  assert.equal(new GitError(1, 'failed').code, 1);
});

test('ChangesetValidationError sorts the issues and lists one per line', async () => {
  const errors = await import('../src/index.mjs');
  assert.equal(typeof errors.ChangesetValidationError, 'function');
  const error = new errors.ChangesetValidationError([
    { changesetId: 'b', code: 'UNKNOWN_PACKAGE', message: 'y' },
    { changesetId: 'a', code: 'INVALID_FILE', message: 'x' },
  ]);
  assert.ok(error instanceof Error);
  assert.deepEqual(error.issues.map((i) => i.changesetId), ['a', 'b']);
  assert.equal(error.message, 'Invalid changesets:\\n- a: x\\n- b: y');
});
`;

/** The same criterion, written the way the r1 errors worker wrote it: a static import of a class that does not exist yet. */
export const ERRORS_RED_STATIC_IMPORT = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangesetValidationError } from '../src/index.mjs';

test('ChangesetValidationError sorts the issues and lists one per line', () => {
  const error = new ChangesetValidationError([{ changesetId: 'a', code: 'INVALID_FILE', message: 'x' }]);
  assert.equal(error.message, 'Invalid changesets:\\n- a: x');
});
`;

/** ... and calling the missing constructor without asserting it exists first: a missing symbol, not a missing behaviour. */
export const ERRORS_RED_NOT_A_CONSTRUCTOR = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as errors from '../src/index.mjs';

test('ChangesetValidationError sorts the issues and lists one per line', () => {
  const error = new errors.ChangesetValidationError([{ changesetId: 'a', code: 'INVALID_FILE', message: 'x' }]);
  assert.equal(error.message, 'Invalid changesets:\\n- a: x');
});
`;

export const READ_IMPL = `import { ChangesetValidationError } from '../../errors/src/index.mjs';

/** Every changeset of \`files\` (\`{ id: text }\`), parsed, in id order; every unparseable one is reported at once. */
export function readChangesets(files) {
  const issues = [];
  const read = [];
  for (const id of Object.keys(files).sort()) {
    try {
      read.push(parseChangeset(id, files[id]));
    } catch (error) {
      issues.push({ changesetId: id, code: 'INVALID_FILE', message: String(error.message).split('\\n')[0] });
    }
  }
  if (issues.length > 0) throw new ChangesetValidationError(issues);
  return read;
}

export function parseChangeset(id, text) {
  const m = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(text);
  if (!m) throw new Error(\`could not parse changeset \${id}: missing frontmatter\\nChangesets start with frontmatter delimited by "---".\`);
  const releases = m[1].split('\\n').filter(Boolean).map((line) => {
    const [name, type] = line.split(':').map((s) => s.trim());
    return { name, type };
  });
  return { id, releases, summary: m[2].trim() };
}
`;

export const READ_RED = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangesetValidationError } from '../../errors/src/index.mjs';
import { readChangesets } from '../src/index.mjs';

test('reads valid changesets in id order', () => {
  const read = readChangesets({ b: '---\\nweb: patch\\n---\\nfix', a: '---\\napi: minor\\n---\\nadd' });
  assert.deepEqual(read.map((c) => [c.id, c.releases]), [['a', [{ name: 'api', type: 'minor' }]], ['b', [{ name: 'web', type: 'patch' }]]]);
});

test('rejects once with an INVALID_FILE issue per unparseable changeset', () => {
  assert.throws(
    () => readChangesets({ a: 'nope', b: '---\\nweb: patch\\n---\\nfix', c: 'also nope' }),
    (error) => {
      assert.ok(error instanceof ChangesetValidationError, 'the error of the errors module');
      assert.deepEqual(error.issues.map((i) => [i.changesetId, i.code]), [['a', 'INVALID_FILE'], ['c', 'INVALID_FILE']]);
      assert.equal(error.issues[0].message, 'could not parse changeset a: missing frontmatter');
      return true;
    },
  );
});
`;

export const ASSEMBLE_IMPL = `import { ChangesetValidationError } from '../../errors/src/index.mjs';

/** The release plan of \`changesets\` over the workspace's \`packages\`; every unknown package is reported at once. */
export function assembleReleasePlan(changesets, packages) {
  const issues = [];
  const releases = new Map();
  for (const changeset of changesets) {
    for (const release of changeset.releases) {
      if (!packages.includes(release.name)) {
        issues.push({ changesetId: changeset.id, code: 'UNKNOWN_PACKAGE', message: \`Found changeset \${changeset.id} for package \${release.name} which is not in the workspace\` });
        continue;
      }
      releases.set(release.name, release.type);
    }
  }
  if (issues.length > 0) throw new ChangesetValidationError(issues);
  return { releases: [...releases].map(([name, type]) => ({ name, type })).sort((a, b) => (a.name < b.name ? -1 : 1)) };
}
`;

export const ASSEMBLE_RED = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangesetValidationError } from '../../errors/src/index.mjs';
import { assembleReleasePlan } from '../src/index.mjs';

test('plans one release per package', () => {
  const plan = assembleReleasePlan([{ id: 'a', releases: [{ name: 'web', type: 'patch' }] }], ['web', 'api']);
  assert.deepEqual(plan.releases, [{ name: 'web', type: 'patch' }]);
});

test('reports every unknown package in one error', () => {
  const changesets = [
    { id: 'b', releases: [{ name: 'nope', type: 'patch' }] },
    { id: 'a', releases: [{ name: 'gone', type: 'minor' }, { name: 'web', type: 'patch' }] },
  ];
  assert.throws(
    () => assembleReleasePlan(changesets, ['web']),
    (error) => {
      assert.ok(error instanceof ChangesetValidationError, 'the error of the errors module');
      assert.deepEqual(error.issues.map((i) => [i.changesetId, i.code]), [['a', 'UNKNOWN_PACKAGE'], ['b', 'UNKNOWN_PACKAGE']]);
      return true;
    },
  );
});
`;

export const CLI_IMPL = `import { ChangesetValidationError } from '../../errors/src/index.mjs';
import { readChangesets } from '../../read/src/index.mjs';
import { assembleReleasePlan } from '../../assemble/src/index.mjs';

/** \`changeset status\`: the plan for \`files\` in \`packages\`, written through \`io\`. Returns the exit code. */
export function status({ files, packages, io }) {
  let plan;
  try {
    plan = assembleReleasePlan(readChangesets(files), packages);
  } catch (error) {
    if (!(error instanceof ChangesetValidationError)) throw error;
    io.error(error.message);
    return 1;
  }
  for (const r of plan.releases) io.log(\`\${r.name}: \${r.type}\`);
  return 0;
}
`;

export const CLI_RED = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status } from '../src/index.mjs';

test('status prints the plan', () => {
  const lines = [];
  const code = status({ files: { a: '---\\nweb: patch\\n---\\nfix' }, packages: ['web'], io: { log: (l) => lines.push(l), error: (l) => lines.push('E ' + l) } });
  assert.equal(code, 0);
  assert.deepEqual(lines, ['web: patch']);
});

test('status prints every invalid changeset once and exits 1', () => {
  const out = [];
  const err = [];
  let code;
  try {
    code = status({ files: { a: 'nope', b: '---\\ngone: patch\\n---\\nx' }, packages: ['web'], io: { log: (l) => out.push(l), error: (l) => err.push(l) } });
  } catch (error) {
    code = 'threw ' + error.constructor.name;
  }
  assert.equal(code, 1);
  assert.deepEqual(err, ['Invalid changesets:\\n- a: could not parse changeset a: missing frontmatter']);
  assert.deepEqual(out, []);
});
`;

/** The work each node's worker does: a RED that inspects or drives behaviour, then the production change. */
export const SHOP_WORK: Record<string, { tests: Record<string, string>; impl: Record<string, string> }> = {
  [ERRORS]: { tests: { 'packages/errors/test/errors.test.mjs': ERRORS_RED }, impl: { 'packages/errors/src/index.mjs': ERRORS_IMPL } },
  [READ]: { tests: { 'packages/read/test/read.test.mjs': READ_RED }, impl: { 'packages/read/src/index.mjs': READ_IMPL } },
  [ASSEMBLE]: { tests: { 'packages/assemble/test/assemble.test.mjs': ASSEMBLE_RED }, impl: { 'packages/assemble/src/index.mjs': ASSEMBLE_IMPL } },
  [CLI_NODE]: { tests: { 'packages/cli/test/cli.test.mjs': CLI_RED }, impl: { 'packages/cli/src/index.mjs': CLI_IMPL } },
};

/** The test each criterion names as its evidence, by node. */
export const SHOP_CRITERIA: Record<string, { criterion: string; path: string; name: string; gate: 'red' | 'green' | 'regression' }[]> = {
  [ERRORS]: [{ criterion: 'AC-1', path: 'packages/errors/test/errors.test.mjs', name: 'ChangesetValidationError sorts the issues and lists one per line', gate: 'red' }],
  [READ]: [
    { criterion: 'AC-2', path: 'packages/read/test/read.test.mjs', name: 'rejects once with an INVALID_FILE issue per unparseable changeset', gate: 'red' },
    { criterion: 'AC-5', path: 'packages/read/test/read.test.mjs', name: 'reads valid changesets in id order', gate: 'green' },
  ],
  [ASSEMBLE]: [
    { criterion: 'AC-3', path: 'packages/assemble/test/assemble.test.mjs', name: 'reports every unknown package in one error', gate: 'red' },
    { criterion: 'AC-5', path: 'packages/assemble/test/assemble.test.mjs', name: 'plans one release per package', gate: 'green' },
  ],
  [CLI_NODE]: [
    { criterion: 'AC-4', path: 'packages/cli/test/cli.test.mjs', name: 'status prints every invalid changeset once and exits 1', gate: 'red' },
    { criterion: 'AC-5', path: 'packages/cli/test/cli.test.mjs', name: 'status prints the plan', gate: 'green' },
  ],
};

export type ShopModules = 'structured' | 'text' | false;

/** The module descriptors of the shop repository: a JUnit report from Node's runner when structured. */
export function shopModules(mode: Exclude<ShopModules, false>): Record<string, unknown> {
  const test =
    mode === 'structured'
      ? ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=${REPORT}', '${MODULE_PATH}/test/**/*.test.mjs']
      : ['node', '--test', '${MODULE_PATH}/test/**/*.test.mjs'];
  return {
    module_defaults: { test, ...(mode === 'structured' ? { report: { format: 'junit-xml' } } : {}), timeout_seconds: 300 },
    modules: [
      { id: 'errors', path: 'packages/errors' },
      { id: 'read', path: 'packages/read' },
      { id: 'assemble', path: 'packages/assemble' },
      { id: 'cli', path: 'packages/cli' },
      { id: 'types', path: 'packages/types', runtime_tests: false, test: ['node', '-e', "require('node:fs').accessSync('packages/types/src/index.d.ts')"], report: null },
    ],
  };
}

export interface Shop {
  root: string;
  control: string;
  repo: string;
  featureDir: string;
}

export interface ShopOptions {
  modules?: ShopModules;
  /** The graph; defaults to the legacy graph (no module binding) for a repository without modules. */
  graph?: Record<string, unknown>;
  /** Initialise the feature (default true). */
  init?: boolean;
  /** Give the repository a worktree setup: a trivial one (true), so receipts are written, or this one. */
  worktreeSetup?: boolean | Record<string, unknown>;
  /** Files committed on the shop's main before the feature starts. */
  baseFiles?: Record<string, string>;
}

/** Run the CLI in-process as the controller at `control`. */
export async function shopCli(s: Pick<Shop, 'control'>, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const withAuthority = asController(argv, s.control);
  const dd = withAuthority.indexOf('--');
  const withRoot = dd === -1 ? [...withAuthority, '--control-root', s.control] : [...withAuthority.slice(0, dd), '--control-root', s.control, ...withAuthority.slice(dd)];
  const code = await main(withRoot, io);
  return { code, out, err };
}

function worker(): Record<string, unknown> {
  return { model: 'sonnet', effort: 'high', max_turns: 20, max_wall_clock_minutes: 5, max_attempts: 2, nested_delegation: false };
}

export type Verifier = { id: string; command: string[]; module?: string; module_sha256?: string };

/** The SHOP-202 graph: errors -> (read, assemble) -> cli -> candidate, each node verified by `verifier(module)`. */
export function shopGraph(verifier: (module: string) => Verifier, options: { compatibility?: boolean } = {}): Record<string, unknown> {
  const node = (id: string, module: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    id,
    level: 'executable-node',
    repository: 'shop',
    capability: `CAP-${module.toUpperCase()}`,
    node_type: 'implementation',
    allowed_paths: [`packages/${module}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [verifier(module)],
    worker: worker(),
    invalidation_rules: [],
    ...extra,
  });
  const compat = options.compatibility === false ? [] : ['AC-5'];
  return {
    schema_version: 1,
    feature_id: SHOP_FEATURE,
    title: 'Report every invalid changeset at once',
    prd: 'PRD.md',
    acceptance_criteria: [
      { id: 'AC-1', text: 'errors: ChangesetValidationError sorts its issues and lists one per line' },
      { id: 'AC-2', text: 'read: every unparseable changeset is reported in one ChangesetValidationError' },
      { id: 'AC-3', text: 'assemble: every unknown package is reported in one ChangesetValidationError' },
      { id: 'AC-4', text: 'cli: status prints the error message once and exits 1' },
      ...(options.compatibility === false ? [] : [{ id: 'AC-5', text: 'valid changesets read, plan and print exactly as before', kind: 'compatibility' }]),
    ],
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['shop'],
    capabilities: ['errors', 'read', 'assemble', 'cli'].map((m) => ({ id: `CAP-${m.toUpperCase()}`, repository: 'shop', title: `${m} validation` })),
    nodes: [
      node(ERRORS, 'errors', { depends_on: [], acceptance_criteria: ['AC-1'] }),
      node(READ, 'read', { depends_on: [ERRORS], acceptance_criteria: ['AC-2', ...compat] }),
      node(ASSEMBLE, 'assemble', { depends_on: [ERRORS], acceptance_criteria: ['AC-3', ...compat] }),
      node(CLI_NODE, 'cli', { depends_on: [ERRORS, READ, ASSEMBLE], acceptance_criteria: ['AC-4', ...compat] }),
      {
        id: SHOP_CANDIDATE,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: [ERRORS, READ, ASSEMBLE, CLI_NODE],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', SHOP_FEATURE] }],
        worker: { ...worker(), max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

/** A plain node verifier: the module's tests through Node's runner, without a module binding. */
export const legacyVerifier = (module: string): Verifier => ({ id: 'module-tests', command: ['node', '--test', `packages/${module}/test/**/*.test.mjs`] });

/** The shop repository as repositories.yaml declares it (path aside). */
export function shopRepository(modules: ShopModules): RepositoryDecl {
  return { name: 'shop', path: '../shop', base_branch: 'main', commands: { test: FULL_SUITE }, ...(modules === false ? {} : shopModules(modules)) } as RepositoryDecl;
}

/** The verifier `repo modules` offers for each module: what a planner selects. */
export function moduleVerifier(mode: Exclude<ShopModules, false> = 'structured'): (module: string) => Verifier {
  const byId = new Map(modulesOf(shopRepository(mode)).map((m) => [m.id, m]));
  return (module) => verifierFor(byId.get(module) as ResolvedModule);
}

/** Build the shop, its control repository and (by default) the initialised feature. */
export async function createShop(options: ShopOptions = {}): Promise<Shop> {
  const root = makeTmpDir('shop portfolio-');
  const repo = makeGitRepo(join(root, 'shop'), { files: { ...BASE_FILES, ...(options.baseFiles ?? {}) } });
  const control = join(root, 'control');
  const modules = options.modules ?? false;
  const entry: Record<string, unknown> = {
    name: 'shop',
    path: relative(control, repo).replace(/\\/g, '/'),
    base_branch: 'main',
    commands: { test: FULL_SUITE },
    tdd: { test_paths: ['packages/*/test/**'], declaration_paths: ['packages/types/**'] },
    ...(modules === false ? {} : shopModules(modules)),
    ...(options.worktreeSetup === true
      ? { worktree_setup: { commands: [['node', '-e', '0']], timeout_seconds: 60 } }
      : typeof options.worktreeSetup === 'object'
        ? { worktree_setup: options.worktreeSetup }
        : {}),
  };
  const mycelink = join(process.cwd(), 'bin', 'mycelink.mjs');
  makeGitRepo(control, {
    files: {
      'README.md': '# control\n',
      '.claude/settings.json': JSON.stringify({ hooks: buildHookSettings(mycelink) }, null, 2) + '\n',
      'mycelink.config.json':
        JSON.stringify(
          {
            schema_version: 1,
            claude_executable: join(root, 'no-such-claude'),
            session_adapter: 'claude-background',
            claude_extra_args: [],
            session_timeout_ms: 120000,
            context_pack_max_bytes: 16384,
            hook_session_start_max_bytes: 4096,
            hook_prompt_delta_max_bytes: 2048,
            brain_dir: null,
            // These fixtures predate the acceptance review (engine/acceptance-review.ts); its own tests turn it on.
            acceptance_review: { required: false },
          },
          null,
          2,
        ) + '\n',
      'repositories.yaml': YAML.stringify({ schema_version: 1, repositories: [entry] }, { lineWidth: 0 }),
    },
  });
  ensureScratchIgnored(control);
  commitAll(control, 'ignore the mycelink scratch area');
  const featureDir = join(control, 'features', SHOP_FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'PRD.md'), `# ${SHOP_FEATURE} Report every invalid changeset at once\n\n- AC-1 errors\n- AC-2 read\n- AC-3 assemble\n- AC-4 cli\n- AC-5 compatibility\n`);
  const shop: Shop = { root, control, repo, featureDir };
  writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(options.graph ?? shopGraph(legacyVerifier), { lineWidth: 0 }));
  if (options.init !== false) {
    const init = await shopCli(shop, ['feature', 'init', SHOP_FEATURE]);
    if (init.code !== 0) throw new Error(`feature init failed: ${init.err}`);
  }
  commitAll(control, 'feature scaffolding');
  return shop;
}

export function shopState(s: Shop): Record<string, any> {
  return JSON.parse(readFileSync(join(s.featureDir, 'STATE.json'), 'utf8')).data;
}

/**
 * A feature initialised before a graph rule existed: `graph` (one `feature
 * init` refuses now) swapped in for the shop's valid one, STATE.json bound
 * to it as that init would have bound it.
 */
export function initialisedWithGraph(s: Shop, graph: unknown): void {
  writeFileSync(join(s.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(graph, { lineWidth: 0 }));
  mutateState(s.featureDir, (st) => ({ ...st, graph_hash: hashGraph(graph) }));
  commitShopControl(s, 'a graph from before the rule');
}

export function commitShopControl(s: Shop, message: string): void {
  if (git(s.control, ['status', '--porcelain']) === '') return;
  commitAll(s.control, message);
}
