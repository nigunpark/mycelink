/**
 * Module descriptors: how each module of a repository verifies itself.
 *
 * CSET-202 r1, with-faults: the planner gave every per-package node the
 * whole suite (`sh -c 'pnpm build && ... && pnpm vitest run'`). When the
 * late defect removed the errors package's export, the errors node's rework
 * RED ran every package's tests; the cli tests already integrated in its base
 * statically imported the missing export and failed with a SyntaxError, and
 * the producer could never prove its own RED. A node's gates must run its own
 * module's tests; only regression and the candidate run the whole suite.
 *
 * repositories.yaml may declare, per repository:
 *
 *   module_defaults:            what every module inherits (null unsets)
 *     setup: [[argv], ...]      run first, in order
 *     build: [[argv], ...]      then these
 *     test: [argv]              the module's tests; `${MODULE_PATH}` and
 *                               `${MODULE_ID}` are filled in, `${REPORT}` names
 *                               a controller-owned report file at run time
 *     report: { format: vitest-json | junit-xml, dir? }
 *     timeout_seconds: n
 *   modules:
 *     - { id, path, runtime_tests?, ...any of the above }
 *
 * Every command is an argv run without a shell: a shell interpreter as the
 * executable (`sh -c`, `cmd /c`, PowerShell) is refused, as is any other
 * placeholder. A resolved module is hashed by what it runs; graphs, claims,
 * gate evidence, setup receipts and settlements bind that hash, so a module
 * command can be neither replaced by a worker nor changed under a feature.
 */
import { createHash } from 'node:crypto';
import type { ClaimVerification, ModuleCommands, ModuleDecl, ModuleReport, Problem, RepositoryDecl } from '../model/types.js';
import { CommandPolicyError, validateArgv } from '../security/exec.js';
import { classifyRelativePath } from '../security/paths.js';

export const DEFAULT_MODULE_TIMEOUT_SECONDS = 1800;

/** A module as it runs: every field present, its own placeholders filled in. */
export interface ResolvedModule {
  id: string;
  path: string;
  runtime_tests: boolean;
  setup: string[][];
  build: string[][];
  /** May hold `${REPORT}`, filled in for each run. */
  test: string[];
  report: ModuleReport | null;
  timeout_seconds: number;
  sha256: string;
}

/** A graph verifier bound to a module: what a planner selects from `repo modules`. */
export interface ModuleVerifier {
  id: string;
  module: string;
  module_sha256: string;
  command: string[];
}

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'busybox', 'cmd', 'powershell', 'pwsh']);

/** The shell an argv would hand its arguments to, or null. */
export function shellInterpreter(argv: readonly string[]): string | null {
  const exe = (argv[0] ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const name = exe.toLowerCase().replace(/\.(exe|com|bat|cmd)$/, '');
  return SHELLS.has(name) ? name : null;
}

const slash = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

function fill(value: string, decl: Pick<ModuleDecl, 'id' | 'path'>): string {
  return value.replace(/\$\{MODULE_PATH\}/g, slash(decl.path)).replace(/\$\{MODULE_ID\}/g, decl.id);
}

function pick<K extends keyof ModuleCommands>(decl: ModuleDecl, defaults: ModuleCommands, key: K): ModuleCommands[K] {
  return decl[key] !== undefined ? decl[key] : defaults[key];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** What a module runs, hashed: the same commands hash the same however they were written down. */
export function moduleSha256(m: Omit<ResolvedModule, 'sha256'>): string {
  const { id, path, runtime_tests, setup, build, test, report, timeout_seconds } = m;
  return createHash('sha256').update(canonical({ id, path, runtime_tests, setup, build, test, report, timeout_seconds })).digest('hex');
}

function resolveModule(decl: ModuleDecl, defaults: ModuleCommands): ResolvedModule {
  const argvs = (list: string[][] | null | undefined): string[][] => (list ?? []).map((argv) => argv.map((a) => fill(a, decl)));
  const report = pick(decl, defaults, 'report') ?? null;
  const resolved: Omit<ResolvedModule, 'sha256'> = {
    id: decl.id,
    path: slash(decl.path),
    runtime_tests: decl.runtime_tests !== false,
    setup: argvs(pick(decl, defaults, 'setup')),
    build: argvs(pick(decl, defaults, 'build')),
    test: (pick(decl, defaults, 'test') ?? []).map((a) => fill(a, decl)),
    report: report === null ? null : { format: report.format, ...(report.dir !== undefined ? { dir: fill(report.dir, decl) } : {}) },
    timeout_seconds: pick(decl, defaults, 'timeout_seconds') ?? DEFAULT_MODULE_TIMEOUT_SECONDS,
  };
  return { ...resolved, sha256: moduleSha256(resolved) };
}

/** The repository's modules, resolved, in declaration order; none when it declares none. */
export function modulesOf(repo: Pick<RepositoryDecl, 'modules' | 'module_defaults'> | undefined | null): ResolvedModule[] {
  const defaults = repo?.module_defaults ?? {};
  return (repo?.modules ?? []).map((decl) => resolveModule(decl, defaults));
}

export function moduleById(repo: Pick<RepositoryDecl, 'modules' | 'module_defaults'> | undefined | null, id: string): ResolvedModule | null {
  return modulesOf(repo).find((m) => m.id === id) ?? null;
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/** The module a repository path belongs to (the deepest one), or null. */
export function moduleForPath(modules: readonly ResolvedModule[], path: string): ResolvedModule | null {
  const p = slash(path);
  let best: ResolvedModule | null = null;
  for (const m of modules) if (inside(p, m.path) && (best === null || m.path.length > best.path.length)) best = m;
  return best;
}

/** The literal part of a glob, up to its last complete segment before the first wildcard. */
function globPrefix(glob: string): string {
  const g = slash(glob);
  const wildcard = g.search(/[*?[\]{}]/);
  if (wildcard === -1) return g;
  const head = g.slice(0, wildcard);
  const cut = head.lastIndexOf('/');
  return cut === -1 ? '' : head.slice(0, cut);
}

/** The modules a node's fence (its allowed paths) reaches into, in declaration order. */
export function modulesTouched(modules: readonly ResolvedModule[], globs: readonly string[]): ResolvedModule[] {
  const prefixes = globs.map(globPrefix);
  return modules.filter((m) => prefixes.some((p) => p === '' || inside(p, m.path) || inside(m.path, p)));
}

/** The graph verifier that runs `m`, exactly as validation expects it. */
export function verifierFor(m: ResolvedModule): ModuleVerifier {
  return { id: `module-${m.id}`, module: m.id, module_sha256: m.sha256, command: [...m.test] };
}

/** The graph's module verifier no longer names the module the repository declares: nothing is claimed under it. */
export class ModuleDriftError extends Error {
  readonly code = 'MODULE_DRIFT';
  constructor(nodeId: string, detail: string) {
    super(
      `MODULE_DRIFT: ${nodeId}: ${detail}. A feature's module commands are fixed when its graph is planned: restore the module in repositories.yaml, or plan the change as a new feature (feature supersede). Nothing was claimed or charged.`,
    );
    this.name = 'ModuleDriftError';
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Hash of exactly what a module run executes: steps, command, report, timeout. */
export function planSha256(plan: ClaimVerification['plan']): string {
  return sha256(canonical({ setup: plan.setup, build: plan.build, test: plan.test, report: plan.report, timeout_seconds: plan.timeout_seconds }));
}

/**
 * What a claim binds for a node whose first verifier names a module: the
 * repository's current descriptor of that module, which must still be
 * exactly the one the graph was planned against, and the full suite.
 * Null for a node without a module verifier.
 */
export function claimVerificationFor(nodeId: string, verifier: { module?: string; module_sha256?: string; command: string[] } | undefined, repo: RepositoryDecl): ClaimVerification | null {
  if (verifier?.module === undefined) return null;
  const m = moduleById(repo, verifier.module);
  if (m === null) throw new ModuleDriftError(nodeId, `repository "${repo.name}" no longer declares module "${verifier.module}"`);
  if (m.sha256 !== verifier.module_sha256) {
    throw new ModuleDriftError(nodeId, `module "${m.id}" was planned as ${String(verifier.module_sha256).slice(0, 12)} but repository "${repo.name}" now declares it as ${m.sha256.slice(0, 12)}`);
  }
  if (verifier.command.length !== m.test.length || verifier.command.some((a, i) => a !== m.test[i])) {
    throw new ModuleDriftError(nodeId, `the graph's command is not module "${m.id}"'s test command`);
  }
  const plan = { setup: m.setup.map((a) => [...a]), build: m.build.map((a) => [...a]), test: [...m.test], report: m.report, timeout_seconds: m.timeout_seconds };
  const regression = [...(repo.commands.regression ?? repo.commands.test)];
  return { module: m.id, module_sha256: m.sha256, path: m.path, runtime_tests: m.runtime_tests, plan, plan_sha256: planSha256(plan), regression: { command: regression, sha256: sha256(canonical(regression)) } };
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;

/** Problems with a repository's module descriptors that its schema cannot express. */
export function moduleProblems(repo: RepositoryDecl, at: string): Problem[] {
  const problems: Problem[] = [];
  const decls = repo.modules ?? [];
  if (decls.length === 0) return problems;
  const problem = (code: string, path: string, detail: string): void => {
    problems.push({ code, path: `${at}${path}`, detail: `Repository "${repo.name}": ${detail}` });
  };
  const seen = new Set<string>();
  decls.forEach((d, i) => {
    if (seen.has(d.id)) problem('DUPLICATE_MODULE', `/modules/${i}/id`, `module "${d.id}" is declared more than once`);
    seen.add(d.id);
    const path = slash(d.path);
    if (classifyRelativePath(path) !== null || /[*?[\]{}$]/.test(path) || path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      problem('MODULE_PATH_INVALID', `/modules/${i}/path`, `module "${d.id}" path ${JSON.stringify(d.path)} is not a directory inside the repository`);
    }
  });
  const paths = decls.map((d) => slash(d.path));
  paths.forEach((a, i) =>
    paths.forEach((b, j) => {
      if (i < j && (inside(a, b) || inside(b, a))) problem('MODULE_PATH_OVERLAP', `/modules/${j}/path`, `modules "${decls[i]?.id}" (${a}) and "${decls[j]?.id}" (${b}) overlap; a path belongs to one module`);
    }),
  );
  modulesOf(repo).forEach((m, i) => {
    const where = `/modules/${i}`;
    const check = (argv: string[], field: string, allowReport: boolean): void => {
      try {
        validateArgv(argv);
      } catch (err) {
        problem('MODULE_COMMAND_INVALID', `${where}/${field}`, `module "${m.id}" ${field} is not a safe argv: ${err instanceof CommandPolicyError ? err.message : String(err)}`);
        return;
      }
      const shell = shellInterpreter(argv);
      if (shell !== null) problem('MODULE_COMMAND_SHELL', `${where}/${field}`, `module "${m.id}" ${field} runs ${shell}: module commands are argv run without a shell; list the steps instead`);
      for (const arg of argv) {
        for (const ph of arg.matchAll(PLACEHOLDER)) {
          if (ph[1] === 'REPORT' && allowReport) continue;
          problem('MODULE_PLACEHOLDER_UNKNOWN', `${where}/${field}`, `module "${m.id}" ${field} uses \${${ph[1]}}; only \${MODULE_PATH}, \${MODULE_ID}${allowReport ? ' and ${REPORT}' : ''} are filled in here`);
        }
      }
    };
    m.setup.forEach((argv, k) => check(argv, `setup/${k}`, false));
    m.build.forEach((argv, k) => check(argv, `build/${k}`, false));
    if (m.test.length === 0) {
      problem('MODULE_TEST_MISSING', `${where}/test`, `module "${m.id}" has no test command (its own, or module_defaults.test)`);
      return;
    }
    check(m.test, 'test', true);
    const reports = m.test.some((a) => a.includes('${REPORT}'));
    if (m.report !== null && m.report.dir === undefined && !reports) {
      problem('MODULE_REPORT_UNBOUND', `${where}/report`, `module "${m.id}" declares a ${m.report.format} report but its test argv never writes \${REPORT}`);
    }
    if (reports && (m.report === null || m.report.dir !== undefined)) {
      problem('MODULE_REPORT_UNBOUND', `${where}/test`, `module "${m.id}" test writes \${REPORT} but declares no report file format`);
    }
    if (m.report?.dir !== undefined) {
      const dir = slash(m.report.dir);
      if (classifyRelativePath(dir) !== null || /[*?[\]{}$]/.test(dir) || dir.split('/').some((s) => s === '' || s === '.' || s === '..')) {
        problem('MODULE_PATH_INVALID', `${where}/report/dir`, `module "${m.id}" report directory ${JSON.stringify(m.report.dir)} is not a directory inside the repository`);
      }
    }
  });
  return problems;
}
