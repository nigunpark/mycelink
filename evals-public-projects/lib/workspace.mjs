/**
 * Agent workspaces: what a scaffold builds for one case.
 *
 *   README.md                       guide: layout, modules, build/test commands, environment notes
 *   platform/                       coordination repository (git, one commit):
 *     README.md, requirements/<PRD>.md   the public requirement, verbatim
 *     requirements/<PRD>.acceptance.json its acceptance criteria, structured (acceptanceSidecar)
 *     repositories.yaml               the project repository as Mycelink registers it
 *                                     (`mycelink init` keeps it): its test command, test
 *                                     and declaration paths, and — when its dependencies
 *                                     are not tracked — the exact offline install every
 *                                     new worktree needs (`worktree_setup`)
 *   repos/<project>/                the frozen project, imported from its verified bundle
 *
 * The offline toolchain caches go into the sandbox HOME as private copies
 * (Maven: ~/.m2 with an offline settings.xml; pnpm: the store, corepack's
 * pinned pnpm, an offline global config, and node_modules installed from
 * the frozen lockfile by exactly the install every worktree gets). Nothing
 * from the evaluator is read, and no path of the cache or the suite is
 * written.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { git } from './git.mjs';
import { importSource } from './source.mjs';
import { loadToolchains, privateCopy } from './toolchain.mjs';

/** Where a session HOME keeps its private copy of a project's pnpm store (pnpm's own default location). */
export const PNPM_STORE = ['.local', 'share', 'pnpm', 'store'];
/** ... and of corepack's pinned pnpm (corepack's default COREPACK_HOME). */
export const COREPACK_HOME = ['.cache', 'node', 'corepack'];

/**
 * The worktree setup a project's repository needs, or null. A pnpm
 * workspace's dependencies live in an untracked node_modules that a git
 * worktree does not carry (CSET-201 r1: every Mycelink worktree had none,
 * and the first GREEN exited 127), so every new worktree installs them with
 * the adapter's own offline install, verbatim, from the session HOME's
 * sealed store and corepack's pinned pnpm (Mycelink fills in `${HOME}`
 * from the session). Maven needs none: ~/.m2 serves every checkout.
 */
export function worktreeSetupFor(adapter) {
  if (adapter.toolchain?.cache?.kind !== 'pnpm-store') return null;
  return {
    commands: [[...adapter.commands.install]],
    timeout_seconds: adapter.commands.timeout_seconds,
    env: { ...adapter.env, pnpm_config_store_dir: ['${HOME}', ...PNPM_STORE].join('/'), COREPACK_HOME: ['${HOME}', ...COREPACK_HOME].join('/') },
    required_paths: ['node_modules'],
    // What the install reads: a node that declares a workspace dependency gets the install again at its next gate.
    inputs: ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '**/package.json'],
  };
}

/**
 * The requirement's acceptance criteria, structured (CSET-202 r2: the
 * planner summarised them and lost their exact formats): each criterion's
 * id, its kind (the case manifest's: new-behavior unless it says
 * compatibility or declaration) and its exact text, cut verbatim from the
 * requirement — the `**AC-n ...` block up to the next one or the end of the
 * section, code blocks opaque — with the SHA-256 of each text and of the
 * requirement itself. The workspace carries it beside the requirement,
 * committed, in both arms; Mycelink's `feature acceptance` takes it as is.
 */
export function acceptanceSidecar(prd) {
  const bytes = readFileSync(prd.requirementPath);
  const lines = bytes.toString('utf8').split('\n');
  const heading = /^(#{1,6})\s/;
  const fence = /^\s*(```|~~~)/;
  const start = lines.findIndex((l) => heading.test(l) && /acceptance criteria/i.test(l));
  if (start < 0) throw new Error(`${prd.manifest.id}: the requirement has no acceptance criteria section`);
  const blocks = [];
  let current = null;
  let fenced = false;
  for (const l of lines.slice(start + 1)) {
    if (!fenced && heading.test(l)) break;
    const id = fenced ? null : /^\*\*(AC-[0-9]+)\b/.exec(l)?.[1];
    if (id) {
      current = { id, lines: [l] };
      blocks.push(current);
    } else if (current) current.lines.push(l);
    if (fence.test(l)) fenced = !fenced;
  }
  const kinds = new Map(prd.manifest.acceptance_criteria.map((a) => [a.id, a.kind ?? 'new-behavior']));
  const criteria = blocks.map((b) => {
    if (!kinds.has(b.id)) throw new Error(`${prd.manifest.id}: the requirement defines ${b.id}, which case.json does not list`);
    const text = b.lines.join('\n').trimEnd();
    return { id: b.id, kind: kinds.get(b.id), text, sha256: createHash('sha256').update(text).digest('hex') };
  });
  if (criteria.length !== kinds.size) throw new Error(`${prd.manifest.id}: the requirement defines ${criteria.length} criteria, case.json ${kinds.size}`);
  return { schema: 'mycelink-acceptance/1', feature_id: prd.manifest.id, source: { path: `requirements/${prd.manifest.id}.md`, sha256: createHash('sha256').update(bytes).digest('hex') }, criteria };
}

const shellWord = (arg) => (/^[A-Za-z0-9_@%+=:,./!-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'"'"'`)}'`);

/** The project's test command as a fresh checkout runs it (a pnpm workspace builds first, and undoes its tolerated build rewrites). */
function testCommand(adapter) {
  if (adapter.implementation === 'maven-junit') return ['./mvnw', ...adapter.commands.maven_args, 'test'];
  if (adapter.implementation === 'pnpm-vitest') {
    const restore = (adapter.tolerated_build_mutations ?? []).map((m) => m.path);
    const steps = [
      adapter.commands.build.map(shellWord).join(' '),
      ...(restore.length > 0 ? [`git checkout -- ${restore.map(shellWord).join(' ')}`] : []),
      adapter.commands.test.map(shellWord).join(' '),
    ];
    return ['sh', '-c', steps.join(' && ')];
  }
  return ['node', '--test'];
}

/**
 * The project's module descriptors (Mycelink's `modules`), derived from the
 * adapter: each module verifies itself with the project's own runner scoped
 * to its directory, shell-free, with a structured report — so a node's gates
 * run its own module's tests (CSET-202 r1: a producer's whole-suite RED was
 * poisoned by its dependents' tests). The full suite stays `commands.test`.
 *
 *  - pnpm-vitest: the build (and the restore of the tolerated build
 *    rewrites) as steps, then `vitest run <module>/` with Vitest's JSON
 *    report; a module with no runtime tests (declarations) is typechecked.
 *  - maven-junit: `./mvnw -pl <module> test`, Surefire's reports read from
 *    the module's target/surefire-reports.
 *
 * Modules outside the baseline (a separate dependency set) get none.
 */
export function moduleDescriptorsFor(adapter) {
  const excluded = (adapter.baseline_exclusions ?? []).map((e) => e.scope.replace(/\/\*\*$/, ''));
  const modules = adapter.modules.filter((m) => !excluded.includes(m.path));
  if (adapter.implementation === 'pnpm-vitest') {
    const restore = (adapter.tolerated_build_mutations ?? []).map((m) => m.path);
    return {
      module_defaults: {
        build: [[...adapter.commands.build], ...(restore.length > 0 ? [['git', 'checkout', '--', ...restore]] : [])],
        test: [...adapter.commands.test, '--reporter=default', '--reporter=json', '--outputFile.json=${REPORT}', '${MODULE_PATH}/'],
        report: { format: 'vitest-json' },
        timeout_seconds: adapter.commands.timeout_seconds,
      },
      modules: modules.map((m) => ({ id: m.id, path: m.path, ...(m.runtime_tests === false ? { runtime_tests: false, test: ['pnpm', 'tsc'], report: null } : {}) })),
    };
  }
  if (adapter.implementation === 'maven-junit') {
    return {
      module_defaults: {
        test: ['./mvnw', ...adapter.commands.maven_args, '-pl', '${MODULE_PATH}', 'test'],
        report: { format: 'junit-xml', dir: '${MODULE_PATH}/target/surefire-reports' },
        timeout_seconds: adapter.commands.timeout_seconds,
      },
      modules: modules.map((m) => ({ id: m.id, path: m.path, ...(m.runtime_tests === false ? { runtime_tests: false } : {}) })),
    };
  }
  return null;
}

/**
 * The repositories.yaml the coordination repository starts with: the
 * project repository as Mycelink registers it, with its test command,
 * which paths are tests and which are declarations (modules with no
 * runtime tests), and its worktree setup when it needs one.
 */
export function repositoryManifest(project) {
  const a = project.adapter;
  const declarations = a.modules.filter((m) => m.runtime_tests === false).map((m) => `${m.path}/**`);
  const setup = worktreeSetupFor(a);
  const modules = moduleDescriptorsFor(a);
  return {
    schema_version: 1,
    repositories: [
      {
        name: a.id,
        path: `../${a.workspace.repo_dir}`,
        base_branch: a.workspace.branch,
        commands: { test: testCommand(a) },
        tdd: { test_paths: [...a.test_paths], ...(declarations.length > 0 ? { declaration_paths: declarations } : {}) },
        ...(setup ? { worktree_setup: setup } : {}),
        ...(modules ?? {}),
      },
    ],
  };
}

const AUTHOR = {
  GIT_AUTHOR_NAME: 'Platform Team',
  GIT_AUTHOR_EMAIL: 'platform@workspace.invalid',
  GIT_COMMITTER_NAME: 'Platform Team',
  GIT_COMMITTER_EMAIL: 'platform@workspace.invalid',
  GIT_AUTHOR_DATE: '2026-10-01T09:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-01T09:00:00Z',
};

const COMMANDS = {
  'maven-junit': [
    'Maven runs offline from `~/.m2` (its `settings.xml` turns offline mode on).',
    '- everything: `./mvnw test`',
    '- one module: `./mvnw -pl <module-dir> test`',
    '- one test: `./mvnw -pl <module-dir> test -Dtest=<Class>#<method>`',
  ],
  'pnpm-vitest': [
    'Dependencies are installed from an offline pnpm store (`pnpm` comes from corepack and runs offline).',
    '- build the workspace packages: `pnpm build`',
    '- run tests: `pnpm vitest run [files...]`',
  ],
  'node-test': ['- run a module\'s tests: `node --test`'],
};

export function workspaceGuide({ project, prd }) {
  const a = project.adapter;
  const lines = [
    '# Workspace',
    '',
    `One approved change request for **${a.name}**.`,
    '',
    '| Path | What |',
    '|---|---|',
    `| \`platform/\` | coordination repository (Git); the approved requirement is \`platform/requirements/${prd.manifest.id}.md\`, and \`platform/repositories.yaml\` registers the code repository |`,
    `| \`${a.workspace.repo_dir}/\` | the code (Git, branch \`${a.workspace.branch}\`) |`,
    '',
    '## Modules',
    '',
    ...a.modules.map((m) => `- \`${m.id}\` (\`${m.path}/\`) — ${m.description}`),
    '',
    '## Build and test',
    '',
    ...COMMANDS[a.implementation],
    ...setupGuide(a),
    ...(moduleDescriptorsFor(a) ? ['- `platform/repositories.yaml` also declares each module\'s own build-and-test commands (`modules`): a change to one module is verified by its own tests, the whole suite runs for regression.'] : []),
    '',
  ];
  if ((a.workspace_notes ?? []).length > 0) lines.push('## Environment notes', '', ...a.workspace_notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
}

/** What the guide says about a repository's worktree setup: the install, and that the generated manifest is what runs it. */
function setupGuide(adapter) {
  const setup = worktreeSetupFor(adapter);
  if (setup === null) return [];
  const install = setup.commands.map((argv) => `\`${argv.join(' ')}\``).join(', then ');
  return [
    `- a new Git worktree of \`${adapter.workspace.repo_dir}/\` starts without \`node_modules\` (it is not tracked): install it there, offline from the same store, with ${install}. \`platform/repositories.yaml\` registers the repository with exactly that install as its \`worktree_setup\`.`,
  ];
}

function platformReadme(project) {
  return `# platform\n\nCoordination repository for changes to ${project.adapter.name}.\n\n- \`requirements/\` — approved requirements, each with its acceptance criteria structured beside it (\`<id>.acceptance.json\`: id, kind, exact text)\n- \`repositories.yaml\` — the code repository: its test command, its test and declaration paths, and what a new worktree of it needs\n`;
}

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function prepareMaven({ project, home, cacheRoot }) {
  const cache = project.adapter.toolchain.cache;
  const m2 = join(home, '.m2');
  privateCopy(join(cacheRoot, cache.dir), join(m2, 'repository'));
  privateCopy(join(cacheRoot, cache.wrapper_dir, 'wrapper'), join(m2, 'wrapper'));
  write(
    join(m2, 'settings.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">\n  <localRepository>${join(m2, 'repository')}</localRepository>\n  <offline>true</offline>\n</settings>\n`,
  );
}

function preparePnpm({ project, home, cacheRoot, repo, toolchains }) {
  const cache = project.adapter.toolchain.cache;
  const store = join(home, ...PNPM_STORE);
  privateCopy(join(cacheRoot, cache.dir), store);
  privateCopy(join(cacheRoot, cache.corepack_dir), join(home, ...COREPACK_HOME));
  write(join(home, '.config', 'pnpm', 'rc'), `store-dir=${store}\noffline=true\n`);
  // The base checkout is installed exactly as every Mycelink worktree is: the adapter's own offline
  // install, its files copied (never linked to the store), from this HOME's store and corepack. The
  // frozen workspace's release-age and trust policies need registry metadata: offline, from a frozen
  // lockfile, the adapter turns them off.
  const setup = worktreeSetupFor(project.adapter);
  const env = {
    PATH: `${toolchains.node.bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: join(home, '.tmp'),
    ...Object.fromEntries(Object.entries(setup.env).map(([k, v]) => [k, v.split('${HOME}').join(home)])),
  };
  for (const argv of setup.commands) {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: repo, encoding: 'utf8', env, timeout: setup.timeout_seconds * 1000 });
    if (r.status !== 0) throw new Error(`offline install failed (exit ${r.status}): ${String(r.stdout ?? '').slice(-800)}${String(r.stderr ?? '').slice(-800)}`);
  }
}

/** Build the workspace for one PRD at `target` (which must be empty). */
export async function buildWorkspace({ project, prd, target, home, cacheRoot, toolchains }) {
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`workspace target ${target} is not empty`);
  const a = project.adapter;
  const repo = join(target, ...a.workspace.repo_dir.split('/'));
  await importSource({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file), target: repo, branch: a.workspace.branch });

  const platform = join(target, 'platform');
  mkdirSync(platform, { recursive: true });
  git(platform, ['init', '-q', '-b', 'main']);
  git(platform, ['config', 'core.autocrlf', 'false']);
  write(join(platform, 'README.md'), platformReadme(project));
  write(join(platform, 'requirements', `${prd.manifest.id}.md`), readFileSync(prd.requirementPath));
  write(join(platform, 'requirements', `${prd.manifest.id}.acceptance.json`), `${JSON.stringify(acceptanceSidecar(prd), null, 2)}\n`);
  write(join(platform, 'repositories.yaml'), YAML.stringify(repositoryManifest(project), { lineWidth: 0 }));
  git(platform, ['add', '--all']);
  git(platform, ['commit', '-q', '--no-verify', '-m', `${prd.manifest.id}: approved requirement`], { env: AUTHOR });

  write(join(target, 'README.md'), workspaceGuide({ project, prd }));

  const kind = a.toolchain.cache.kind;
  if (kind !== 'none') {
    if (!home) throw new Error('a sandbox HOME is needed to prepare the offline toolchain');
    mkdirSync(join(home, '.tmp'), { recursive: true });
    if (kind === 'maven-repository') prepareMaven({ project, home, cacheRoot });
    else if (kind === 'pnpm-store') preparePnpm({ project, home, cacheRoot, repo, toolchains: toolchains ?? loadToolchains(cacheRoot) });
  }
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty !== '') throw new Error(`the prepared repository is not clean: ${dirty.split('\n').slice(0, 5).join(' | ')}`);
  return { workspace: target, repo, platform, start: project.lock.commit };
}
