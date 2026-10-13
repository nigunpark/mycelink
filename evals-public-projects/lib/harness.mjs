/**
 * The trusted test harness.
 *
 * Acceptance and regression never run a delivery's own test harness. They
 * run on a trusted tree: the delivered tree with every test path and every
 * frozen build/test-runner configuration path exactly as at the frozen
 * commit (an upstream test the delivery changed is reverted, one it deleted
 * restored, a test file it added left out), plus — for acceptance — the
 * evaluator's hidden overlay. Only production code is the delivery's.
 *
 * Statically (inspectHarness), a delivery is rejected for:
 *   harness-config-frozen         changing frozen configuration (the
 *                                 adapter's `harness.frozen` globs);
 *   harness-no-injection          adding a harness hook file anywhere
 *                                 (`harness.forbidden_new`: test-runner
 *                                 config, service loaders, Spring or JUnit
 *                                 registrations, automocks, ...);
 *   harness-production-references production lines that reference a test
 *                                 framework (`harness.framework_modules`)
 *                                 or detect the test run;
 *   harness-manifests             (pnpm) package manifests or lockfile
 *                                 changes beyond dependencies on workspace
 *                                 packages.
 * These are the second line: the trusted tree is the first, and the
 * isolation boundary keeps evaluator content away altogether.
 */
import { posix } from 'node:path';
import YAML from 'yaml';
import { catFileBatch, lsTree, safeGit } from './git.mjs';
import { makeSection } from './hygiene.mjs';
import { isTestPath, matchesAny } from './scope.mjs';

const NONE = { frozen: [], forbidden_new: [], framework_modules: [], manifests: 'none' };
export const harnessPolicy = (adapter) => ({ ...NONE, ...(adapter.harness ?? {}) });

/** `git diff --name-status` of the delivery, without the paths only excluded (injected) commits touched. */
export function deliveredChanges({ repo, start, head, excludeCommits = new Set() }) {
  const r = safeGit(repo, ['diff', '--name-status', '-z', '--no-renames', start, head]);
  if (r.code !== 0) throw new Error(`git diff ${start}..${head} failed: ${r.stderr}`);
  const parts = r.stdout.split('\0');
  let out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === '') break;
    out.push({ status: parts[i][0], path: parts[i + 1] });
  }
  if (excludeCommits.size > 0) {
    out = out.filter((c) => {
      const touching = safeGit(repo, ['log', '--full-history', '--format=%H', `${start}..${head}`, '--', c.path]).stdout.split(/\r?\n/).filter(Boolean);
      return touching.some((sha) => !excludeCommits.has(sha));
    });
  }
  return out;
}

const blobAt = (repo, rev, path) => {
  const r = safeGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}:${path}`]);
  return r.code === 0 ? r.stdout : null;
};
const textAt = (repo, rev, path) => {
  const r = safeGit(repo, ['cat-file', 'blob', `${rev}:${path}`], { encoding: 'buffer' });
  return r.code === 0 ? r.stdout.toString('utf8') : null;
};

/** Test-run detection, in any language: production code that behaves differently under test. */
const TEST_RUN_MARKERS = [
  /\bprocess\.env\.(VITEST\w*|JEST_WORKER_ID|NODE_TEST_CONTEXT|NODE_TEST\w*)\b/,
  /\bprocess\.env\[\s*['"`](VITEST\w*|JEST_WORKER_ID|NODE_TEST_CONTEXT)['"`]\s*\]/,
  /\bimport\.meta\.vitest\b/,
  /__vitest_/,
  /Symbol\.for\(\s*['"`]vitest/,
  /\bNODE_ENV\b[^\n]{0,20}['"`]test['"`]/,
  /\b(globalThis|global)\.(expect|describe|it|test|vi|jest)\b/,
  /System\.(getProperty|getenv)\(\s*"(surefire|junit|maven\.test)/,
];

/** Production files whose added lines are scanned: code and the configuration resources it loads (manifests are checked structurally). */
const SCANNED = /\.(m?[jt]sx?|c[jt]s|java|kt|kts|groovy|scala|properties|xml|ya?ml|json|conf)$/;
const MANIFEST = /(^|\/)(package\.json|pnpm-lock\.yaml)$/;

const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** A reference to a framework module: a JS module specifier (string literal) or a Java/Kotlin package name. */
function frameworkPatterns(modules) {
  return modules.map((m) => {
    if (m.includes('/') || m.startsWith('@') || m.startsWith('node:') || !m.includes('.')) {
      const spec = m.endsWith('/*') ? `${escape(m.slice(0, -2))}/[^'"\`/]+` : escape(m);
      return new RegExp(`(['"\`])${spec}(?:/[^'"\`]*)?\\1`);
    }
    return new RegExp(`\\b${escape(m)}\\b`);
  });
}

/** Lines the delivery adds to production text files: `[{ path, line }]`. */
function addedProductionLines(repo, start, head, paths) {
  if (paths.length === 0) return [];
  const r = safeGit(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '--no-renames', start, head, '--', ...paths], { encoding: 'buffer' });
  if (r.code !== 0) throw new Error(`git diff for the harness scan failed: ${r.stderr}`);
  const out = [];
  let path = null;
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (line.startsWith('+++ ')) path = line === '+++ /dev/null' ? null : line.slice(6);
    else if (line.startsWith('+') && path !== null) out.push({ path, line: line.slice(1) });
  }
  return out;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * The `packages` key an importer entry resolves to: `<name>@<version>`, or,
 * for an alias (`npm-10: npm:npm@10.9.8`), the real package pnpm records
 * as its version (`npm@10.9.8`); peer suffixes aside.
 */
function packageKey(name, version) {
  const bare = version.replace(/\(.*$/, '');
  return /^(@[^/@]+\/)?[^@]+@/.test(bare) ? bare : `${name}@${bare}`;
}
const SAFE_SPEC = /^(workspace:)?[\^~]?(\*|\d[\w.+-]*)$|^workspace:[\^~*]?$/;

/** Problems with the delivery's package manifests and pnpm lockfile (pnpm projects). */
function pnpmManifestProblems({ repo, start, head, changed, policy, tolerated }) {
  const problems = [];
  const startTree = lsTree(repo, start);
  const workspaceNames = new Map();
  for (const e of startTree.filter((x) => /(^|\/)package\.json$/.test(x.path) && x.path !== 'package.json')) {
    try {
      const name = JSON.parse(textAt(repo, start, e.path)).name;
      if (typeof name === 'string') workspaceNames.set(name, posix.dirname(e.path));
    } catch {
      // not a manifest the workspace resolves
    }
  }
  const frameworks = policy.framework_modules;
  const isFramework = (name) => frameworks.some((m) => (m.endsWith('/*') ? name.startsWith(m.slice(0, -1)) : name === m));
  for (const c of changed.filter((x) => /(^|\/)package\.json$/.test(x.path) && x.status === 'M')) {
    const rule = tolerated.get(c.path);
    if (rule && blobAt(repo, head, c.path) === rule.built_blob) continue;
    let before;
    let after;
    try {
      before = JSON.parse(textAt(repo, start, c.path));
      after = JSON.parse(textAt(repo, head, c.path));
    } catch {
      problems.push(`${c.path} is not valid JSON`);
      continue;
    }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (DEPENDENCY_FIELDS.includes(key)) continue;
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) problems.push(`${c.path} changes ${key}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(after[field] ?? {})) {
        if (before[field]?.[name] === spec) continue;
        if (isFramework(name)) problems.push(`${c.path} adds the test framework ${name}`);
        else if (!workspaceNames.has(name)) problems.push(`${c.path} adds ${name}, which is not a workspace package`);
        else if (typeof spec !== 'string' || !SAFE_SPEC.test(spec)) problems.push(`${c.path} resolves ${name} through ${JSON.stringify(spec)}`);
      }
    }
  }
  const lockfile = changed.find((x) => x.path === 'pnpm-lock.yaml');
  if (lockfile) {
    let before;
    let after;
    try {
      before = YAML.parse(textAt(repo, start, 'pnpm-lock.yaml') ?? '');
      after = YAML.parse(textAt(repo, head, 'pnpm-lock.yaml') ?? '');
    } catch (error) {
      return [...problems, `pnpm-lock.yaml does not parse: ${error.message.split('\n')[0]}`];
    }
    for (const section of ['packages', 'snapshots']) {
      const known = new Set(Object.keys(before?.[section] ?? {}));
      for (const key of Object.keys(after?.[section] ?? {})) if (!known.has(key)) problems.push(`pnpm-lock.yaml resolves a new package ${key}`);
    }
    const workspaceDirs = new Set(workspaceNames.values());
    for (const [importer, deps] of Object.entries(after?.importers ?? {})) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, entry] of Object.entries(deps?.[field] ?? {})) {
          const version = String(entry?.version ?? '');
          if (version.startsWith('link:')) {
            const target = posix.normalize(posix.join(importer === '.' ? '' : importer, version.slice(5)));
            if (!workspaceDirs.has(target) || workspaceNames.get(name) !== target) problems.push(`pnpm-lock.yaml links ${name} in ${importer} to ${target}, not its workspace package`);
          } else if (!Object.hasOwn(before?.packages ?? {}, packageKey(name, version))) {
            problems.push(`pnpm-lock.yaml resolves ${name}@${version} in ${importer}, unknown at the frozen commit`);
          }
        }
      }
    }
  }
  return problems;
}

/** The harness section: frozen configuration, injected hooks, production references, manifests. */
export function inspectHarness({ repo, start, head, adapter, excludeCommits = new Set() }) {
  const { checks, check } = makeSection();
  const policy = harnessPolicy(adapter);
  const tolerated = new Map((adapter.tolerated_build_mutations ?? []).map((m) => [m.path, m]));
  const changed = deliveredChanges({ repo, start, head, excludeCommits });

  const frozen = changed
    .filter((c) => matchesAny(policy.frozen, c.path))
    .filter((c) => !(tolerated.has(c.path) && c.status === 'M' && blobAt(repo, head, c.path) === tolerated.get(c.path).built_blob));
  check('harness-config-frozen', frozen.length === 0, frozen.length ? `frozen build/test-runner configuration changed: ${frozen.map((c) => `${c.status} ${c.path}`).join(', ')}` : 'no frozen configuration changed');

  const hooks = changed.filter((c) => c.status === 'A' && matchesAny(policy.forbidden_new, c.path));
  check('harness-no-injection', hooks.length === 0, hooks.length ? `harness hook files added: ${hooks.map((c) => c.path).join(', ')}` : 'no test-framework configuration, service loader or harness hook added');

  const production = changed.filter((c) => c.status !== 'D' && !isTestPath(adapter, c.path) && SCANNED.test(c.path) && !MANIFEST.test(c.path)).map((c) => c.path);
  const patterns = [...frameworkPatterns(policy.framework_modules), ...TEST_RUN_MARKERS];
  const references = addedProductionLines(repo, start, head, production).filter(({ line }) => patterns.some((re) => re.test(line)));
  check(
    'harness-production-references',
    references.length === 0,
    references.length ? `production code references a test framework or the test run: ${references.slice(0, 5).map((r) => `${r.path}: ${r.line.trim().slice(0, 120)}`).join(' | ')}` : 'no production line references a test framework or the test run',
  );

  if (policy.manifests === 'pnpm') {
    const problems = pnpmManifestProblems({ repo, start, head, changed, policy, tolerated });
    check('harness-manifests', problems.length === 0, problems.length ? problems.slice(0, 10).join('; ') : 'package manifests change only dependencies on workspace packages');
  }
  return { checks, facts: { frozen: frozen.map((c) => c.path), hooks: hooks.map((c) => c.path), references: references.slice(0, 20) } };
}

/**
 * The trusted tree, as overrides of the delivered tree for exportTree:
 * every test path and every frozen configuration path exactly as at the
 * frozen commit (`{ content, mode }`, or null where it did not exist).
 */
export function trustedOverrides({ repo, start, head, adapter }) {
  const policy = harnessPolicy(adapter);
  const frozenPath = (p) => isTestPath(adapter, p) || matchesAny(policy.frozen, p);
  const atStart = new Map(lsTree(repo, start).filter((e) => frozenPath(e.path)).map((e) => [e.path, e]));
  const atHead = new Map(lsTree(repo, head).filter((e) => frozenPath(e.path)).map((e) => [e.path, e]));
  const summary = { tests_reverted: 0, tests_restored: 0, tests_left_out: 0, config_reverted: 0 };
  const overrides = new Map();
  const wanted = [];
  for (const [path, s] of atStart) {
    const h = atHead.get(path);
    if (h && h.sha === s.sha && h.mode === s.mode) continue;
    wanted.push(s);
    if (!isTestPath(adapter, path)) summary.config_reverted += 1;
    else if (h) summary.tests_reverted += 1;
    else summary.tests_restored += 1;
  }
  for (const path of atHead.keys()) {
    if (atStart.has(path)) continue;
    overrides.set(path, null);
    if (isTestPath(adapter, path)) summary.tests_left_out += 1;
    else summary.config_reverted += 1;
  }
  const blobs = catFileBatch(repo, wanted.map((e) => e.sha));
  for (const e of wanted) overrides.set(e.path, { content: blobs.get(e.sha), mode: e.mode });
  return { overrides, summary };
}
