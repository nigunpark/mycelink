/**
 * Maven + JUnit 5 (Surefire) adapter.
 *
 * Runs the project's own Maven wrapper offline (`-o`) against a private copy
 * of the prepared local repository and wrapper distribution, with a sandbox
 * HOME (no ~/.m2/settings.xml, no ~/.mavenrc: MAVEN_SKIP_RC=1). Targeted
 * runs select modules with `-pl` and tests with
 * `-Dtest=<fqcn>#<m1>+<m2>,...`. Every run is `--fail-at-end`: a module
 * whose tests fail does not keep the modules that do not depend on it from
 * running, so every requested test that can run, runs (the exit stays
 * nonzero). Results come from each module's target/surefire-reports.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { parseJUnit } from '../results.mjs';
import { placeholders, runCommand } from '../run.mjs';
import { loadToolchains, privateCopy } from '../toolchain.mjs';
import { sandboxEnv } from './index.mjs';

/** `<moduleDir>/src/test/java/<pkg>/<Class>.java` -> `{ moduleDir, fqcn }`. */
export function testClassOf(path) {
  const m = /^(.+?)\/src\/test\/java\/(.+)\.java$/.exec(path);
  return m ? { moduleDir: m[1], fqcn: m[2].replaceAll('/', '.') } : null;
}

/** The Maven argv for a run: every module, or the modules and methods that declare `tests`. */
export function mavenPlan({ manifest, tree, tests, repoLocal }) {
  const argv = [`${tree}/mvnw`, ...(manifest.commands.maven_args ?? []), `-Dmaven.repo.local=${repoLocal}`, '--fail-at-end'];
  if (tests === null || tests === undefined) return { argv: [...argv, 'test'], modules: manifest.modules.map((m) => m.path) };
  const byClass = new Map();
  for (const t of tests) {
    const cls = testClassOf(t.file);
    if (!cls) throw new Error(`${t.file} is not a Maven test source`);
    const key = `${cls.moduleDir}\0${cls.fqcn}`;
    if (!byClass.has(key)) byClass.set(key, { ...cls, methods: [] });
    if (!byClass.get(key).methods.includes(t.name)) byClass.get(key).methods.push(t.name);
  }
  const groups = [...byClass.values()];
  const modules = [...new Set(groups.map((g) => g.moduleDir))].sort();
  const selector = groups.map((g) => `${g.fqcn}#${g.methods.join('+')}`).join(',');
  return { argv: [...argv, '-pl', modules.join(','), 'test', `-Dtest=${selector}`, '-Dsurefire.failIfNoSpecifiedTests=false'], modules };
}

/** Why a Maven run ended, from its exit, its log and its reports. */
export function mavenCategory({ exitCode, timedOut, log, results }) {
  if (timedOut) return 'timeout';
  if (exitCode === 0) return 'ok';
  if (/COMPILATION ERROR|Compilation failure/.test(log)) return 'compile';
  if (/Could not resolve dependencies|Cannot access .* in offline mode|Non-resolvable (parent|import)|Could not transfer artifact|has not been downloaded from it before/.test(log)) return 'dependency';
  if (results.length > 0 && /There (are|were) test failures|Tests run:.*(Failures|Errors): [1-9]/.test(log)) return 'tests-failed';
  return results.length > 0 ? 'tests-failed' : 'build';
}

export function mavenJunitAdapter(base, options = {}) {
  return {
    ...base,
    // Parameterised and repeated tests report as `name(args)[n]`.
    matches: (result, expected) => result.file === expected.file && (result.name === expected.name || result.name.startsWith(`${expected.name}(`) || result.name.startsWith(`${expected.name}[`)),
    async runTests({ tree, tests, ctx, label }) {
      const manifest = base.manifest;
      const toolchains = ctx.toolchains ?? loadToolchains(ctx.cacheRoot);
      const scratch = join(ctx.workRoot, `${label}.scratch`);
      const home = join(scratch, 'home');
      // A temp root on another file system (qualification) still hashes as <tmp>.
      const tmp = ctx.tmpRoot ? mkdtempSync(join(ctx.tmpRoot, 'bench-tmp-')) : join(scratch, 'tmp');
      mkdirSync(home, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      const cache = manifest.toolchain.cache;
      const repoLocal = privateCopy(join(ctx.cacheRoot, cache.dir), join(scratch, 'repository'));
      const userHome = privateCopy(join(ctx.cacheRoot, cache.wrapper_dir), join(scratch, 'maven-user-home'));
      const { argv, modules } = mavenPlan({ manifest, tree, tests, repoLocal });
      const javaHome = toolchains.java.home;
      const env = sandboxEnv({ manifest, home, tmp, path: `${javaHome}/bin:/usr/bin:/bin`, extra: { JAVA_HOME: javaHome, MAVEN_USER_HOME: userHome, MAVEN_SKIP_RC: '1' } });
      // Inside the boundary only the tree, the scratch space (private repository and wrapper copies) and the JDK exist.
      const binds = [{ path: tree, rw: true }, { path: scratch, rw: true }, ...(ctx.tmpRoot ? [{ path: tmp, rw: true }] : []), { path: javaHome }];
      const run = await runCommand({ argv, cwd: tree, env, timeoutMs: ctx.timeoutMs ?? manifest.commands.timeout_seconds * 1000, outDir: ctx.outDir ?? ctx.workRoot, label, isolation: ctx.isolation, binds });
      const results = [];
      for (const moduleDir of modules) {
        const dir = join(tree, ...moduleDir.split('/'), 'target', 'surefire-reports');
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir).sort()) {
          if (!/^TEST-.*\.xml$/.test(name)) continue;
          results.push(...parseJUnit(readFileSync(join(dir, name), 'utf8'), { root: tree, moduleDir }));
        }
      }
      const log = existsSync(run.stdout_path) ? readFileSync(run.stdout_path, 'utf8') : '';
      run.category = mavenCategory({ exitCode: run.exit_code, timedOut: run.timed_out, log, results });
      const roots = { [tree]: '<tree>', [scratch]: '<scratch>', [tmp]: '<tmp>', [javaHome]: '<java>' };
      return { run, results, command: { argv: placeholders(argv, roots), env: placeholders(env, roots) } };
    },
  };
}
