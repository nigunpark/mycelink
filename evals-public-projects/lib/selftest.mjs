/**
 * The model-free selftest of the public-project suite, on the real projects
 * (run it where the caches live). Every check is a fact about the frozen
 * sources, the evaluator artifacts, the scaffolds and the verifier:
 *
 *   suite       the manifests are valid and the generated cases current
 *   sources     every frozen bundle verifies offline; the cache lock holds
 *   agent Maven a Maven project builds offline inside an agent session's
 *               sandbox profile, its JVM's user.home at the session HOME,
 *               the operator's ~/.m2 absent
 *   per PRD     the evaluator store matches its lock and is qualified (its
 *               qualification.json binds the same digest, every gating
 *               mutant killed); the case's generated scaffold, run the way
 *               `claude plugin eval` runs it (minimal environment, killed at
 *               120 s), finishes within SCAFFOLD_BUDGET_MS, and the workspace
 *               and HOME it builds hold no evaluator content; the verifier rejects the untouched
 *               workspace; it accepts the reference, replayed commit by
 *               commit with independent test blobs (as an agent would write
 *               them), with TDD required; on that delivery it rejects a dirty
 *               tree, an unsafe git config, rewritten history, smuggled
 *               hidden content and a tampered evaluator store; in a copy of
 *               it, the reference's production byte for byte is only a
 *               convergence warning while its own tests, its commits and a
 *               stored evaluator file fail the leakage section; a teammate's
 *               commit must be kept; the late defect fails hidden checks.
 *
 * Orchestration evidence (leases, sessions, state, candidates) is proved on
 * a genuine Mycelink delivery of the toy project by the CI-safe tests.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createAdapter } from './adapters/index.mjs';
import { sessionEnv } from './arms.mjs';
import { caseDrift } from './cases.mjs';
import { evaluatorDir, loadEvaluator, unbundleReference } from './evaluator.mjs';
import { injectConcurrentCommit, injectLateDefect, injectedEffects, inspectFaults, lateDefectPatch } from './faults.mjs';
import { catFileBatch, git, revParse } from './git.mjs';
import { gitBlobSha } from './hash.mjs';
import { inspectRepository, makeSection } from './hygiene.mjs';
import { agentToolchain, sessionSandbox } from './isolation.mjs';
import { inspectLeakage } from './leakage.mjs';
import { loadSuite } from './manifests.mjs';
import { changedPaths, inspectScope } from './scope.mjs';
import { INIT_SCRIPT, runSync } from './sandbox.mjs';
import { importSource, verifySourceBundle } from './source.mjs';
import { loadToolchains, toolchainDigests, verifyCacheLock } from './toolchain.mjs';
import { declaredTests } from './testids.mjs';
import { qualificationProblems, runHiddenTests, verifyDelivery } from './verify.mjs';
import { buildWorkspace } from './workspace.mjs';

/** The eval harness kills a case's scaffold after 120 s; a scaffold must finish well within it. */
export const HARNESS_SCAFFOLD_KILL_MS = 120_000;
export const SCAFFOLD_BUDGET_MS = 90_000;
const SCAFFOLD_TOOL = fileURLToPath(new URL('../tools/scaffold.mjs', import.meta.url));

/**
 * Build a case's workspace the way the eval harness does: its generated
 * `cases/<case>/scaffold.sh` (or, for a suite without the tools beside it,
 * tools/scaffold.mjs with --suite-root) in an empty run directory, with a
 * minimal environment, killed at HARNESS_SCAFFOLD_KILL_MS. Returns
 * `{ ok, duration_ms, detail }`.
 */
export function runScaffold({ suiteRoot, caseName, target, home, cacheRoot, budgetMs = SCAFFOLD_BUDGET_MS }) {
  mkdirSync(target, { recursive: true });
  mkdirSync(home, { recursive: true });
  const script = join(suiteRoot, 'cases', caseName, 'scaffold.sh');
  const viaScript = existsSync(script) && existsSync(join(suiteRoot, 'tools', 'scaffold.mjs')) && process.platform !== 'win32';
  const argv = viaScript ? ['bash', script] : [process.execPath, SCAFFOLD_TOOL, caseName, '.', '--suite-root', suiteRoot, '--cache-root', cacheRoot, '--home', home];
  const env = {
    PATH: [dirname(process.execPath), ...(process.platform === 'win32' ? [process.env.PATH ?? ''] : ['/usr/local/bin', '/usr/bin', '/bin'])].join(delimiter),
    HOME: home,
    TMPDIR: home,
    GIT_CONFIG_NOSYSTEM: '1',
    MYCELINK_BENCH_CACHE: cacheRoot,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home, TEMP: home, TMP: home } : {}),
  };
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd: target, env, encoding: 'utf8', timeout: HARNESS_SCAFFOLD_KILL_MS, killSignal: 'SIGKILL', windowsHide: true });
  const duration = Date.now() - started;
  const ok = r.status === 0 && duration <= budgetMs;
  return { ok, duration_ms: duration, detail: r.status === 0 ? `${viaScript ? 'scaffold.sh' : 'tools/scaffold.mjs'} finished in ${Math.round(duration / 1000)} s (budget ${budgetMs / 1000} s, harness kill ${HARNESS_SCAFFOLD_KILL_MS / 1000} s)` : `the scaffold ${r.error?.code === 'ETIMEDOUT' || r.signal ? 'was killed at the harness limit' : `failed (exit ${r.status})`}: ${String(r.stderr ?? '').trim().slice(-300)}` };
}

const AGENT = {
  GIT_AUTHOR_NAME: 'Selftest Agent',
  GIT_AUTHOR_EMAIL: 'selftest@benchmark.invalid',
  GIT_COMMITTER_NAME: 'Selftest Agent',
  GIT_COMMITTER_EMAIL: 'selftest@benchmark.invalid',
};

const failedIds = (section) => section.checks.filter((c) => !c.ok && c.severity !== 'warning').map((c) => c.id);
const sectionsFailing = (r) =>
  Object.entries(r.sections ?? {})
    .filter(([name, s]) => s && (name !== 'orchestration' || s.required) && (name !== 'tdd' || s.required))
    .flatMap(([name, s]) => (s.checks ?? []).filter((c) => !c.ok && c.severity !== 'warning').map((c) => `${name}:${c.id}`))
    .concat(r.sections?.tdd?.required && r.sections.tdd.ok !== true ? [`tdd:${(r.sections.tdd.units ?? []).map((u) => u.verdict).join(',') || 'none'}`] : [])
    .concat(r.errors ?? []);

/** Files under `roots` (not .git) whose content is an evaluator blob; only sizes the fingerprints know are hashed. */
export function evaluatorContentIn(roots, fingerprints) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.git') walk(p);
      } else if (e.isFile()) {
        let size;
        try {
          size = statSync(p).size;
        } catch {
          continue;
        }
        if (fingerprints.sizes.has(size) && fingerprints.blobs.has(gitBlobSha(readFileSync(p)))) hits.push(p);
      }
    }
  };
  for (const r of roots) walk(r);
  return hits;
}

const CODE = /\.(java|kt|groovy|ts|tsx|mts|cts|js|jsx|mjs|cjs|snap)$/;

/** Files whose tests testids.mjs reads: a test's block runs to the next declaration or the end of the file. */
const DECLARES_TESTS = /\.(java|mjs|cjs|js|jsx|ts|mts|cts|tsx)$/;

/**
 * The same file, as another author would commit it: a different blob, the
 * same behaviour, the same declared tests. In a file that declares tests the
 * marker goes on top (after a byte order mark or a shebang): at the end it
 * would change the last test's block.
 */
export function independentCopy(path, body) {
  const marker = '// independent copy (selftest)\n';
  if (!CODE.test(path)) return Buffer.concat([body, Buffer.from('\n')]);
  if (!DECLARES_TESTS.test(path)) return Buffer.concat([body, Buffer.from(`\n${marker}`)]);
  const text = body.toString('utf8');
  const prefix = /^﻿?(?:#![^\n]*(?:\n|$))?/.exec(text)[0];
  const separator = prefix.startsWith('#!', prefix.startsWith('﻿') ? 1 : 0) && !prefix.endsWith('\n') ? '\n' : '';
  return Buffer.from(`${prefix}${separator}${marker}${text.slice(prefix.length)}`);
}

/**
 * Replay the reference onto `repo` commit by commit, every file as an
 * independent copy (another blob, the same behaviour: the reference's own
 * blobs are evaluator fingerprints). The reference objects never enter
 * `repo`: they are read from a scratch import of the frozen source.
 */
export async function replayReference({ project, adapter, evaluator, cacheRoot, repo, scratch }) {
  const src = join(scratch, 'reference-src');
  rmSync(src, { recursive: true, force: true });
  await importSource({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file), target: src });
  try {
    const head = unbundleReference({ evaluator, repo: src });
    const commits = git(src, ['rev-list', '--reverse', `${project.lock.commit}..${head}`]).split('\n').filter(Boolean);
    for (const c of commits) {
      const changes = changedPaths(src, `${c}^`, c);
      const blobs = catFileBatch(src, changes.filter((ch) => ch.status !== 'D').map((ch) => revParse(src, `${c}:${ch.path}`)));
      for (const ch of changes) {
        const target = join(repo, ...ch.path.split('/'));
        if (ch.status === 'D') {
          rmSync(target, { force: true });
          continue;
        }
        const body = blobs.get(revParse(src, `${c}:${ch.path}`));
        mkdirSync(dirname(target), { recursive: true });
        // Every file as another author would write it: the reference's own blobs are evaluator fingerprints.
        writeFileSync(target, independentCopy(ch.path, body));
      }
      git(repo, ['add', '--all']);
      git(repo, ['commit', '-q', '--no-verify', '-m', git(src, ['log', '-1', '--format=%B', c])], { env: AGENT });
    }
    return { commits: commits.length, head: git(repo, ['rev-parse', 'HEAD']) };
  } finally {
    rmSync(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * The leakage proof on the real reference, in a copy of the delivered
 * repository `repo`: the reference's substantial production code, delivered
 * byte for byte, is convergence (a warning, nothing fails); its test files
 * that add its author's tests, its commits (the bundle unbundled) and a
 * stored evaluator file are proof.
 */
async function referenceLeakage({ project, evaluator, cacheRoot, repo, scratch, check, id }) {
  const start = project.lock.commit;
  const src = join(scratch, 'leak-reference-src');
  const root = join(scratch, 'leak');
  rmSync(src, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  await importSource({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file), target: src });
  try {
    const head = unbundleReference({ evaluator, repo: src });
    const changed = changedPaths(src, start, head).filter((c) => c.status !== 'D');
    const blobs = catFileBatch(src, changed.map((c) => revParse(src, `${head}:${c.path}`)));
    const files = changed.map((c) => {
      const body = blobs.get(revParse(src, `${head}:${c.path}`));
      const before = revParse(src, `${start}:${c.path}`);
      const had = new Set(before ? declaredTests(c.path, catFileBatch(src, [before]).get(before).toString('utf8')).map((t) => t.name) : []);
      return { path: c.path, body, blob: gitBlobSha(body), adds: declaredTests(c.path, body.toString('utf8')).filter((t) => !had.has(t.name)).length };
    });
    const copy = join(root, 'repo');
    cpSync(repo, copy, { recursive: true });
    // The mutations before this one (the smuggled hidden test among them) live on in the reflog.
    git(copy, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
    const commit = (list, message) => {
      for (const f of list) {
        mkdirSync(dirname(join(copy, ...f.path.split('/'))), { recursive: true });
        writeFileSync(join(copy, ...f.path.split('/')), f.body);
      }
      git(copy, ['add', '--all']);
      git(copy, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message], { env: AGENT });
    };
    const inspect = () => inspectLeakage({ repo: copy, start, head: git(copy, ['rev-parse', 'HEAD']), workspace: root, fingerprints: evaluator.fingerprints });
    const production = files.filter((f) => evaluator.fingerprints.production.has(f.blob));
    commit(production, 'feat: as the reference wrote it');
    const converged = inspect();
    const warning = converged.checks.find((c) => c.id === 'reference-convergence');
    check(
      `reference-production-convergence:${id}`,
      production.length > 0 && failedIds(converged).length === 0 && warning?.severity === 'warning',
      `${production.length} reference production file(s) byte for byte: ${failedIds(converged).length ? `fails ${failedIds(converged).join(', ')}` : `no failure, a warning (${String(warning?.detail).slice(0, 160)})`}`,
    );
    const authored = files.filter((f) => !evaluator.fingerprints.production.has(f.blob) && f.adds > 0);
    commit(authored, 'test: as the reference wrote them');
    const copied = failedIds(inspect());
    check(`rejects-reference-tests:${id}`, authored.length > 0 && copied.includes('no-evaluator-blobs'), `${authored.length} reference test file(s) adding the reference author's tests: fails ${copied.join(', ') || 'nothing'}`);
    git(copy, ['bundle', 'unbundle', evaluator.referenceBundle]);
    const imported = failedIds(inspect());
    check(`rejects-reference-objects:${id}`, imported.includes('no-reference-history'), `the reference bundle unbundled into the repository: fails ${imported.join(', ') || 'nothing'}`);
    mkdirSync(join(root, 'notes'), { recursive: true });
    cpSync(evaluator.referenceBundle, join(root, 'notes', 'x.bin'));
    const stored = failedIds(inspect());
    check(`rejects-store-copy:${id}`, stored.includes('no-evaluator-files'), `a copy of the reference bundle in the workspace: fails ${stored.join(', ') || 'nothing'}`);
  } finally {
    rmSync(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Selftest one PRD into `check`. */
async function selftestPrd({ suiteRoot, project, prd, cacheRoot, workRoot, check, log, isolation }) {
  const id = prd.manifest.id;
  const adapter = createAdapter(project.adapter);
  const branch = project.adapter.workspace.branch;
  const start = project.lock.commit;
  const ctx = { cacheRoot, toolchains: project.adapter.toolchain.cache.kind === 'none' ? null : loadToolchains(cacheRoot), isolation };
  const scratch = join(workRoot, id);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  mkdirSync(scratch, { recursive: true });

  let evaluator;
  try {
    evaluator = loadEvaluator({ cacheRoot, project, prdId: id });
    check(`evaluator:${id}`, true, `store matches the committed lock (${evaluator.lock.digest_sha256.slice(0, 12)})`);
  } catch (error) {
    check(`evaluator:${id}`, false, error.message);
    return;
  }
  // The verifier's own rule: qualified for this evaluator store, source, cache and toolchains.
  const { qualification: q, problems } = qualificationProblems({ prd, project, evaluator, cacheRoot, toolchains: toolchainDigests({ adapter: project.adapter, toolchains: ctx.toolchains }) });
  check(`qualified:${id}`, problems.length === 0, problems.length ? problems.join('; ') : `${q.hidden_tests.total} hidden tests, ${q.mutants.killed}/${q.mutants.gating} gating mutants killed, ${q.superseded_tests} superseded upstream test(s), ${q.filesystems.distinct} file system(s)`);

  // ---- the untouched scaffold: clean, and rejected.
  log(`${id}: scaffold`);
  const ws = join(scratch, 'baseline', 'ws');
  const home = join(scratch, 'baseline', 'home');
  const scaffold = runScaffold({ suiteRoot, caseName: prd.manifest.case, target: ws, home, cacheRoot });
  check(`scaffold-within-harness-limit:${id}`, scaffold.ok, scaffold.detail);
  if (!scaffold.ok) return;
  const leaked = evaluatorContentIn([ws, home], evaluator.fingerprints);
  check(`scaffold-clean:${id}`, leaked.length === 0, leaked.length ? `evaluator content in ${leaked.slice(0, 5).join(', ')}` : 'no evaluator content in the workspace or its HOME');
  log(`${id}: verify the untouched baseline`);
  const untouched = await verifyDelivery({ suiteRoot, caseKey: id, workspace: ws, cacheRoot, workRoot: join(scratch, 'verify-baseline'), tdd: false, isolation });
  check(
    `baseline-rejected:${id}`,
    untouched.ok === false && untouched.sections.acceptance?.ok === false && untouched.sections.scope?.ok === false,
    `rejected: ${sectionsFailing(untouched).length} failing check(s), acceptance ${untouched.sections.acceptance?.ok}, scope ${untouched.sections.scope?.ok}`,
  );
  rmSync(join(scratch, 'baseline'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  // ---- the reference as an agent would deliver it: accepted, test-first.
  log(`${id}: replay the reference`);
  const ws2 = join(scratch, 'reference', 'ws');
  await buildWorkspace({ project, prd, target: ws2, home: join(scratch, 'reference', 'home'), cacheRoot });
  const repo = join(ws2, ...project.adapter.workspace.repo_dir.split('/'));
  const replayed = await replayReference({ project, adapter, evaluator, cacheRoot, repo, scratch });
  log(`${id}: verify the reference delivery`);
  const accepted = await verifyDelivery({ suiteRoot, caseKey: id, workspace: ws2, cacheRoot, workRoot: join(scratch, 'verify-reference'), requireTdd: true, isolation });
  const failing = sectionsFailing(accepted);
  check(
    `reference-accepted:${id}`,
    accepted.ok === true,
    accepted.ok ? `${replayed.commits} commit(s); TDD ${accepted.sections.tdd.units.map((u) => u.verdict).join(', ')}` : failing.slice(0, 8).join('; '),
  );
  const head = replayed.head;
  const restore = () => {
    git(repo, ['update-ref', `refs/heads/${branch}`, head]);
    git(repo, ['reset', '-q', '--hard', head]);
    git(repo, ['clean', '-q', '-fd']);
  };
  const repoCheck = () => failedIds(inspectRepository({ repo, lock: project.lock, adapter: project.adapter }));

  // ---- mutations of that delivery, each rejected and undone.
  writeFileSync(join(repo, 'SELFTEST-UNCOMMITTED.txt'), 'uncommitted\n');
  check(`rejects-dirty:${id}`, repoCheck().includes('clean-worktree'), 'an uncommitted file fails clean-worktree');
  restore();

  const configFile = join(repo, '.git', 'config');
  const config = readFileSync(configFile);
  appendFileSync(configFile, '[core]\n\tfsmonitor = true\n');
  check(`rejects-unsafe-config:${id}`, repoCheck().includes('git-config-safe'), 'core.fsmonitor fails git-config-safe');
  writeFileSync(configFile, config);

  const orphan = git(repo, ['commit-tree', `${head}^{tree}`, '-m', 'rewritten history'], { env: AGENT });
  git(repo, ['update-ref', `refs/heads/${branch}`, orphan]);
  check(`rejects-rewritten-history:${id}`, repoCheck().some((c) => c === 'history-preserved' || c === 'start-present'), 'a history without the frozen commit is rejected');
  restore();

  const [hiddenPath, hiddenBody] = [...evaluator.hidden][0];
  mkdirSync(dirname(join(repo, ...hiddenPath.split('/'))), { recursive: true });
  writeFileSync(join(repo, ...hiddenPath.split('/')), hiddenBody);
  git(repo, ['add', '--all']);
  git(repo, ['commit', '-q', '--no-verify', '-m', 'test: more tests'], { env: AGENT });
  const smuggled = failedIds(inspectLeakage({ repo, start, head: git(repo, ['rev-parse', 'HEAD']), workspace: ws2, fingerprints: evaluator.fingerprints }));
  check(`rejects-smuggled-hidden:${id}`, smuggled.length > 0, `hidden content in the delivery fails ${smuggled.join(', ')}`);
  restore();

  // ---- the leakage proof on the real reference, in a copy of that delivery.
  log(`${id}: reference convergence and leakage`);
  await referenceLeakage({ project, evaluator, cacheRoot, repo, scratch, check, id });

  const tampered = join(scratch, 'tampered-cache');
  cpSync(evaluatorDir(cacheRoot, project.id, id), evaluatorDir(tampered, project.id, id), { recursive: true });
  appendFileSync(join(evaluatorDir(tampered, project.id, id), 'hidden', ...hiddenPath.split('/')), '\n');
  let refused = false;
  try {
    loadEvaluator({ cacheRoot: tampered, project, prdId: id });
  } catch {
    refused = true;
  }
  check(`rejects-tampered-evaluator:${id}`, refused, 'a weakened hidden test no longer matches the lock');
  rmSync(tampered, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  // ---- the fault injectors on the real delivery.
  const teammate = injectConcurrentCommit({ repo, branch, path: 'SELFTEST-TEAM-NOTES.md', content: '# Team notes\n', message: 'docs: team notes' });
  const faultCheck = (h, which) => inspectFaults({ repo, head: h, records: [teammate] }).checks.find((c) => c.id === `fault:concurrent-commit:${which}`)?.ok === true;
  const bound = faultCheck(teammate.commit, 'bound');
  const kept = faultCheck(teammate.commit, 'kept');
  const scoped = failedIds(inspectScope({ repo, start, head: teammate.commit, adapter: project.adapter, prd: prd.manifest, injected: injectedEffects({ repo, head: teammate.commit, records: [teammate] }) }));
  const lost = !faultCheck(head, 'kept');
  check(`fault-teammate-commit:${id}`, bound && kept && lost && scoped.length === 0, `bound ${bound}, kept ${kept}, a delivery without it rejected ${lost}, out of the delivered scope ${scoped.length === 0}`);
  restore();

  log(`${id}: late defect`);
  const defect = lateDefectPatch({ repo, start, head, adapter: project.adapter, prd: prd.manifest });
  if (!defect) {
    check(`fault-late-defect:${id}`, false, 'the reference has no production change in a required module');
  } else {
    const injected = injectLateDefect({ repo, branch, patch: defect.patch, message: 'chore: sync platform changes' });
    const qa = await runHiddenTests({ repo, head: injected.commit, evaluator, adapter, ctx, workRoot: join(scratch, 'qa') });
    const broken = qa.summary.filter((t) => t.status !== 'passed').length;
    check(`fault-late-defect:${id}`, broken > 0, `${broken}/${qa.summary.length} hidden check(s) fail once ${defect.module}'s delivered change is reverted`);
    restore();
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * A Maven project's build as an agent session runs it: a scaffolded
 * workspace and HOME, the session's sandbox profile (lib/isolation.mjs),
 * `./mvnw -o` compiling a required module's tests. It must resolve the
 * wrapper distribution, settings.xml and the local repository from the
 * HOME's private copies — the session's JVMs see user.home at the HOME —
 * and the operator's ~/.m2 must not exist inside. Returns `{ ok, detail }`.
 */
export async function agentMaven({ project, prd, cacheRoot, workRoot, isolation }) {
  const root = join(workRoot, `agent-maven-${project.id}`);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const ws = join(root, 'workspace');
  const home = join(root, 'home');
  mkdirSync(join(home, '.tmp'), { recursive: true });
  try {
    await buildWorkspace({ project, prd, target: ws, home, cacheRoot });
    const toolchain = agentToolchain({ adapter: project.adapter, toolchains: loadToolchains(cacheRoot) });
    const profile = sessionSandbox({ workspace: ws, home, artifactDir: join(root, 'plugin'), loadPlugin: false, claude: ['/usr/bin/true'], args: [], toolchain, env: sessionEnv({ home }) });
    const module = project.adapter.modules.find((m) => m.id === prd.manifest.modules.required[0]).path;
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const script = [
      `test -e ${q(join(homedir(), '.m2'))} && echo operator-m2:visible || echo operator-m2:absent`,
      `java -XshowSettings:properties -version 2>&1 | grep 'user.home ='`,
      `cd ${q(project.adapter.workspace.repo_dir)} && ./mvnw -o -B -q -pl ${q(module)} test-compile`,
    ].join('\n');
    const r = runSync(isolation, { argv: [process.execPath, INIT_SCRIPT, '--', '/bin/bash', '-c', script], env: profile.env, cwd: ws, binds: profile.binds, init: profile.init }, { encoding: 'utf8', timeout: 900_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const userHome = /user\.home = (.*)/.exec(out)?.[1]?.trim() ?? null;
    const absent = out.includes('operator-m2:absent');
    const ok = r.status === 0 && absent && userHome === home && profile.jvmOptions === `-Duser.home=${home}`;
    return {
      ok,
      detail: `./mvnw -o test-compile of ${module} in the session sandbox: exit ${r.status}; user.home ${userHome === home ? 'is the session HOME' : `= ${userHome}`} (${profile.jvmOptions}); the operator's ~/.m2 ${absent ? 'absent' : 'visible'}${ok ? '' : `: ${out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Run the selftest. `prds` limits the per-PRD part to those ids. */
export async function selftest({ suiteRoot, cacheRoot, workRoot, prds = null, isolation = null, log = () => {} }) {
  const started = Date.now();
  const { checks, check } = makeSection();
  const suite = loadSuite(suiteRoot);
  check('suite', suite.problems.length === 0, suite.problems.length ? suite.problems.slice(0, 5).join('; ') : `${suite.projects.length} project(s), ${suite.projects.reduce((n, p) => n + p.prds.length, 0)} PRD(s)`);
  if (suite.problems.length) return { schema: 'mycelink-bench/selftest@1', ok: false, checks, duration_ms: Date.now() - started };
  const drift = caseDrift(suite, join(suiteRoot, 'cases'));
  check('cases-current', drift.length === 0, drift.length ? drift.slice(0, 5).join('; ') : 'the generated cases match the manifests');
  for (const project of suite.projects) {
    const v = await verifySourceBundle({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file) });
    check(`source:${project.id}`, v.ok, v.ok ? `frozen ${project.lock.commit.slice(0, 12)} verified offline` : v.checks.filter((c) => !c.ok).map((c) => c.id).join(', '));
  }
  if (suite.projects.some((p) => p.adapter.toolchain.cache.kind !== 'none')) {
    const cache = verifyCacheLock(cacheRoot);
    check('cache-lock', cache.ok, cache.ok ? 'every offline cache matches cache.lock.json' : cache.problems.slice(0, 5).join('; '));
  }
  if (checks.some((c) => !c.ok)) return { schema: 'mycelink-bench/selftest@1', ok: false, checks, duration_ms: Date.now() - started };
  // A Maven project's offline build, as an agent session runs it (once per project).
  for (const project of suite.projects.filter((p) => p.adapter.toolchain.cache.kind === 'maven-repository')) {
    const prd = project.prds.find((p) => !prds || prds.includes(p.manifest.id));
    if (!prd) continue;
    log(`${project.id}: Maven in an agent session`);
    try {
      const m = await agentMaven({ project, prd, cacheRoot, workRoot, isolation });
      check(`agent-maven:${project.id}`, m.ok, m.detail);
    } catch (error) {
      check(`agent-maven:${project.id}`, false, String(error?.message ?? error).split('\n')[0]);
    }
  }
  for (const project of suite.projects) {
    for (const prd of project.prds) {
      if (prds && !prds.includes(prd.manifest.id)) continue;
      try {
        await selftestPrd({ suiteRoot, project, prd, cacheRoot, workRoot, check, log, isolation });
      } catch (error) {
        check(`error:${prd.manifest.id}`, false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
      }
    }
  }
  return { schema: 'mycelink-bench/selftest@1', ok: checks.length > 0 && checks.every((c) => c.ok || c.severity === 'warning'), checks, duration_ms: Date.now() - started };
}
