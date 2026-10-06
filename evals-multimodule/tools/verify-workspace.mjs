#!/usr/bin/env node
/**
 * Independent post-run verifier for the Ledgerline multi-module eval cases.
 *
 *   node evals-multimodule/tools/verify-workspace.mjs --workspace <dir> [options]
 *   node evals-multimodule/tools/verify-workspace.mjs --aggregate <aggregate-result.json> [options]
 *
 * Options:
 *   --scenario <greenfield|existing-cold|existing-informed>
 *                          expected scenario (default: detected from the
 *                          platform repository's baseline commit)
 *   --require-mycelink     also require complete Mycelink orchestration evidence
 *                          (in --aggregate mode: only for the "with" arm)
 *   --mycelink-bin <path>  Mycelink launcher (default: <repo>/bin/mycelink.mjs)
 *   --out <file.json>      also write the JSON result to this file
 *
 * Trust model: nothing in the workspace is trusted. Acceptance is re-run with
 * the suite's own pristine copy of the runner and tests (never the copy in the
 * workspace), baseline SHAs come from the suite's baseline-shas.json, and the
 * workspace's own acceptance-results/ are only compared, never believed.
 *
 * Fails closed: any error, missing artifact or unknown state is a failure.
 * Exit codes: 0 verified, 1 not verified, 2 usage or internal error. The JSON
 * result is always printed to stdout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pathKey, safeGit, unsafeGitConfig } from '../_lib/acceptance/lib/git-safe.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const SUITE = resolve(TOOLS, '..');
const LIB = join(SUITE, '_lib');
const REPO_ROOT = resolve(SUITE, '..');
export const VERIFIER_VERSION = '1.0.0';
const MODULES = ['core', 'api', 'worker', 'cli'];
const SCENARIOS = ['greenfield', 'existing-cold', 'existing-informed'];
/** Module test counts at the existing baseline (`node --test` totals). */
const BASELINE_TEST_COUNTS = { core: 10, api: 7, worker: 5, cli: 4 };
const CASE_SCENARIO = {
  'greenfield-refunds': 'greenfield',
  'existing-refunds-cold': 'existing-cold',
  'existing-refunds-informed': 'existing-informed',
};
const LIVE_SESSION_STATUSES = new Set(['spawning', 'working', 'stalled']);

// ------------------------------------------------------------ helpers ----

/** Every git call runs hardened (see _lib/acceptance/lib/git-safe.mjs). */
function git(cwd, args) {
  return safeGit(cwd, args);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Mycelink writes STATE.json, leases.json and sessions/registry.json as
 * `{ revision, data }` envelopes. Anything else is unreadable — never
 * silently treated as empty.
 */
export function readMycelinkDoc(path) {
  const doc = readJson(path);
  if (doc === null || typeof doc !== 'object' || !Number.isInteger(doc.revision) || doc.data === null || typeof doc.data !== 'object') {
    throw new Error(`${path} is not a Mycelink { revision, data } document`);
  }
  return doc.data;
}

function isRepoRoot(dir) {
  if (!existsSync(dir)) return false;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top.code === 0 && pathKey(top.stdout) === pathKey(dir);
}

function isAncestor(repo, ancestor, descendant) {
  return git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]).code === 0;
}

function treeOf(repo, rev) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`]);
  return r.code === 0 ? r.stdout : null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

class Section {
  constructor() {
    this.checks = [];
  }
  check(id, ok, detail, extra = {}) {
    this.checks.push({ id, ok: Boolean(ok), detail, ...extra });
    return Boolean(ok);
  }
  get ok() {
    return this.checks.length > 0 && this.checks.every((c) => c.ok || c.severity === 'warning');
  }
}

// -------------------------------------------------------- completion ----

export function detectScenario(workspace) {
  const expected = readJson(join(LIB, 'baseline-shas.json'));
  const platform = join(workspace, 'platform');
  const unsafe = existsSync(platform) ? unsafeGitConfig(platform) : [];
  if (unsafe.length > 0) throw new Error(`platform/ has an unsafe git configuration (${unsafe.join(', ')}); refusing to run git there`);
  if (!isRepoRoot(platform)) return null;
  const head = git(platform, ['rev-parse', 'HEAD']).stdout;
  for (const scenario of SCENARIOS) {
    const sha = expected[scenario]?.platform;
    if (sha && git(platform, ['cat-file', '-e', `${sha}^{commit}`]).code === 0 && isAncestor(platform, sha, head)) {
      return scenario;
    }
  }
  return null;
}

async function verifyCompletion(workspace, scenario, result) {
  const s = new Section();
  const baseline = readJson(join(LIB, 'baseline-shas.json'))[scenario];
  const modules = {};
  result.evidence.modules = modules;

  for (const name of MODULES) {
    const repo = join(workspace, 'repos', name);
    const info = { path: repo, head: null, branch: null, clean: false, dirty: [], baseline_sha: baseline?.[name] ?? null };
    modules[name] = info;
    const unsafe = existsSync(repo) ? unsafeGitConfig(repo) : [];
    if (!s.check(`git-config-safe:${name}`, unsafe.length === 0 || !existsSync(join(repo, '.git')), unsafe.length ? `refusing to run git: unsafe local configuration ${unsafe.join(', ')}` : 'local git configuration is inert')) continue;
    if (!s.check(`repo-exists:${name}`, isRepoRoot(repo), `repos/${name} is the root of a git repository`)) continue;
    const head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!s.check(`repo-has-head:${name}`, head.code === 0, `repos/${name} has a HEAD commit`)) continue;
    info.head = head.stdout;
    const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    info.branch = branch.code === 0 ? branch.stdout : null;
    const status = git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
    info.dirty = status.stdout.split('\n').filter((l) => l.trim() !== '');
    info.clean = status.code === 0 && info.dirty.length === 0;
    s.check(`no-uncommitted-code:${name}`, info.clean, info.clean ? 'working tree clean' : `uncommitted: ${info.dirty.slice(0, 10).join(' | ')}`);

    const known = info.baseline_sha && git(repo, ['cat-file', '-e', `${info.baseline_sha}^{commit}`]).code === 0;
    info.baseline_is_ancestor = Boolean(known && isAncestor(repo, info.baseline_sha, info.head));
    s.check(
      `history-preserved:${name}`,
      info.baseline_is_ancestor,
      `baseline ${String(info.baseline_sha).slice(0, 12)} is an ancestor of the delivered HEAD (history not rewritten or re-created)`,
    );
    info.commits_since_baseline = info.baseline_is_ancestor
      ? Number(git(repo, ['rev-list', '--count', `${info.baseline_sha}..${info.head}`]).stdout)
      : null;
    s.check(
      `module-changed:${name}`,
      (info.commits_since_baseline ?? 0) > 0,
      `${info.commits_since_baseline ?? 0} commit(s) delivered on top of the baseline (the feature touches every module)`,
    );
  }

  // The workspace's acceptance suite must be the pristine one.
  const { suiteSha256, runAcceptance } = await import(pathToFileURL(join(LIB, 'acceptance', 'run.mjs')).href);
  const trustedSuite = suiteSha256(join(LIB, 'acceptance'));
  const wsSuiteDir = join(workspace, 'acceptance');
  const wsSuite = existsSync(join(wsSuiteDir, 'run.mjs')) ? suiteSha256(wsSuiteDir) : null;
  result.evidence.suite_sha256 = { trusted: trustedSuite, workspace: wsSuite };
  s.check('acceptance-suite-untampered', wsSuite === trustedSuite, `workspace acceptance/ hashes to ${wsSuite ?? 'missing'}, trusted ${trustedSuite}`);

  // Independent re-run with the trusted runner against the committed HEADs.
  const out = mkdtempSync(join(tmpdir(), 'ledger-verify-'));
  try {
    const report = await runAcceptance({ workspace, out });
    result.evidence.acceptance_rerun = {
      verdict: report.verdict,
      failures: report.failures,
      acceptance: report.acceptance && {
        tests: report.acceptance.tests,
        pass: report.acceptance.pass,
        fail: report.acceptance.fail,
        failing: report.acceptance.cases.filter((c) => !c.ok).map((c) => c.name),
      },
      modules: Object.fromEntries(MODULES.map((m) => [m, { head: report.modules[m]?.head, tests: report.modules[m]?.tests }])),
    };
    s.check('acceptance-rerun-pass', report.ok, report.ok ? 'trusted acceptance re-run: PASS' : `trusted acceptance re-run: FAIL — ${report.failures.join('; ')}`);
    for (const name of MODULES) {
      if (report.modules[name]?.head !== modules[name].head) {
        s.check(`rerun-tested-delivered-head:${name}`, false, 'the re-run did not test the delivered HEAD');
      }
    }
    for (const name of MODULES) {
      const count = report.modules[name]?.tests?.pass ?? 0;
      const min = scenario === 'greenfield' ? 1 : BASELINE_TEST_COUNTS[name] + 1;
      s.check(`tests-added:${name}`, count >= min, `${count} passing module tests (need ≥ ${min}: new behaviour must be tested in the owning repository)`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  if (scenario !== 'greenfield' && modules.core.head) {
    const pkg = git(join(workspace, 'repos', 'core'), ['show', `${modules.core.head}:package.json`]);
    let version = null;
    try {
      version = JSON.parse(pkg.stdout).version;
    } catch {
      version = null;
    }
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
    const bumped = m !== null && (Number(m[1]) > 1 || (Number(m[1]) === 1 && Number(m[2]) >= 5));
    result.evidence.core_version = version;
    s.check('core-minor-release', bumped, `ledger-core version ${version ?? 'unreadable'} (AC-11: new minor release over 1.4.0)`);
  }
  return s;
}

function verifyReporting(workspace, result) {
  const s = new Section();
  const path = join(workspace, 'acceptance-results', 'report.json');
  if (!s.check('in-run-report-present', existsSync(path), 'acceptance-results/report.json written during the run')) return s;
  let report;
  try {
    report = readJson(path);
  } catch (error) {
    s.check('in-run-report-parses', false, String(error.message));
    return s;
  }
  s.check('in-run-report-pass', report.verdict === 'PASS' && report.ok === true, `in-run verdict ${report.verdict}`);
  s.check(
    'in-run-report-suite',
    report.suite_sha256 === result.evidence.suite_sha256?.trusted,
    'in-run report was produced by the pristine suite',
  );
  for (const name of MODULES) {
    const delivered = result.evidence.modules?.[name]?.head;
    s.check(
      `in-run-report-head:${name}`,
      delivered && report.modules?.[name]?.head === delivered,
      `in-run report tested ${String(report.modules?.[name]?.head).slice(0, 12)}, delivered ${String(delivered).slice(0, 12)}`,
    );
  }
  return s;
}

// ----------------------------------------------------- orchestration ----

function findControlRoots(workspace) {
  const roots = [];
  const skip = new Set(['.git', 'node_modules', 'acceptance', 'acceptance-results', 'vendor', 'worktrees']);
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'mycelink.config.json')) roots.push(dir);
    for (const e of entries) if (e.isDirectory() && !skip.has(e.name)) walk(join(dir, e.name), depth + 1);
  };
  walk(workspace, 0);
  return roots;
}

function mycelink(bin, args) {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status ?? -1, json, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Extract `repositories: { name: { sha } }` from a Mycelink candidate YAML. */
export function candidateRepositories(yamlText) {
  const out = {};
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^repositories:\s*$/.test(l));
  if (start === -1) return out;
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const name = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (name) {
      current = name[1];
      out[current] = {};
      continue;
    }
    const field = /^ {4}(sha|branch):\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (field && current) out[current][field[1]] = field[2];
  }
  return out;
}

function verifyOrchestration(workspace, bin, result) {
  const s = new Section();
  const orch = { control_roots: [], features: [], usage: null };
  result.evidence.mycelink = orch;
  const roots = findControlRoots(workspace);
  orch.control_roots = roots;
  if (!s.check('control-root-present', roots.length > 0, roots.length ? `control root(s): ${roots.join(', ')}` : 'no mycelink.config.json in the workspace')) {
    return { section: s, present: false };
  }
  if (!s.check('mycelink-bin', existsSync(bin), `Mycelink launcher ${bin}`)) return { section: s, present: true };
  // Mycelink itself runs git in the control and module repositories.
  const unsafeRepos = [...roots, ...MODULES.map((m) => join(workspace, 'repos', m))]
    .filter((r) => existsSync(join(r, '.git')))
    .map((r) => [r, unsafeGitConfig(r)])
    .filter(([, u]) => u.length > 0);
  if (!s.check('git-config-safe:mycelink', unsafeRepos.length === 0, unsafeRepos.length ? `refusing to run Mycelink: unsafe git configuration in ${unsafeRepos.map(([r, u]) => `${r} (${u.join(', ')})`).join('; ')}` : 'control and module repositories have inert git configuration')) {
    return { section: s, present: true };
  }

  const features = [];
  for (const root of roots) {
    const dir = join(root, 'features');
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir)) if (existsSync(join(dir, id, 'STATE.json'))) features.push({ root, id });
  }
  if (!s.check('feature-initialised', features.length > 0, `${features.length} feature(s) with STATE.json`)) return { section: s, present: true };

  const deliveredHeads = Object.fromEntries(MODULES.map((m) => [m, result.evidence.modules?.[m]?.head ?? null]));
  const moduleByPath = Object.fromEntries(MODULES.map((m) => [pathKey(resolve(workspace, 'repos', m)), m]));
  let anyComplete = false;

  for (const { root, id } of features) {
    const tag = `${id}`;
    const f = { control_root: root, feature_id: id };
    orch.features.push(f);
    const featureDir = join(root, 'features', id);
    let state;
    try {
      state = readMycelinkDoc(join(featureDir, 'STATE.json'));
    } catch (error) {
      s.check(`state-readable:${tag}`, false, error.message);
      continue;
    }
    const nodes = Object.entries(state.nodes ?? {});
    f.feature_state = state.feature_state;
    f.node_states = Object.fromEntries(nodes.map(([n, r]) => [n, r.state]));
    f.current_candidate = state.current_candidate ?? null;
    const allDone = nodes.length > 0 && nodes.every(([, r]) => r.state === 'DONE' || r.state === 'EXCLUDED');
    const okNodes = s.check(`nodes-done:${tag}`, allDone, `${nodes.length} node(s): ${nodes.map(([n, r]) => `${n}=${r.state}`).join(', ')}`);

    // Evidence files referenced by STATE.json must exist.
    const missing = [];
    let evidenceCount = 0;
    for (const [n, r] of nodes) {
      for (const [kind, rec] of Object.entries(r.evidence ?? {})) {
        evidenceCount += 1;
        if (rec?.output_path && !existsSync(resolve(root, rec.output_path))) missing.push(`${n}:${kind}`);
      }
      if (r.state === 'DONE' && Object.keys(r.evidence ?? {}).length === 0) missing.push(`${n}:no-evidence`);
    }
    f.evidence_records = evidenceCount;
    s.check(`evidence-files:${tag}`, missing.length === 0 && evidenceCount > 0, missing.length ? `missing: ${missing.join(', ')}` : `${evidenceCount} evidence record(s) with output on disk`);

    const verify = mycelink(bin, ['feature', 'verify', id, '--control-root', root, '--json']);
    f.feature_verify = verify.json;
    const okVerify = s.check(`feature-verify:${tag}`, verify.code === 0 && verify.json?.ok === true, verify.json ? `problems: ${JSON.stringify(verify.json.problems)}` : `exit ${verify.code}: ${verify.stderr.slice(0, 300)}`);

    // Leases: strict — any recorded lease is a leak, expired or not.
    let leases = [];
    try {
      leases = existsSync(join(featureDir, 'leases.json')) ? readMycelinkDoc(join(featureDir, 'leases.json')).leases : [];
      if (!Array.isArray(leases)) throw new Error('leases.json has no leases array');
    } catch (error) {
      leases = [{ unreadable: error.message }];
    }
    f.leases = leases;
    // Strict: an unreleased lease is a leak even when its holder has exited
    // (Mycelink's own `feature verify` treats dead-holder leases as reclaimable).
    const okLeases = s.check(
      `no-leaked-leases:${tag}`,
      leases.length === 0,
      leases.length
        ? `${leases.length} unreleased lease(s): ${leases.map((l) => `${l.resource ?? '?'} by ${l.node_id ?? '?'} (holder pid ${l.pid ?? '?'} ${pidAlive(l.pid) ? 'alive' : 'exited'})`).join(', ')}`
        : 'leases.json empty',
    );

    let sessions = {};
    try {
      sessions = existsSync(join(featureDir, 'sessions', 'registry.json')) ? readMycelinkDoc(join(featureDir, 'sessions', 'registry.json')).sessions : {};
      if (sessions === null || typeof sessions !== 'object') throw new Error('registry.json has no sessions map');
    } catch (error) {
      sessions = { unreadable: { status: 'working', detail: error.message } };
    }
    const live = Object.values(sessions).filter((x) => LIVE_SESSION_STATUSES.has(x.status) || (x.pid && !x.finished_at && pidAlive(x.pid)));
    f.sessions = { total: Object.keys(sessions).length, live: live.map((x) => x.session_id ?? '?') };
    const okSessions = s.check(`no-live-sessions:${tag}`, live.length === 0, `${f.sessions.total} session(s), ${live.length} live`);

    // Candidate: integrity, coverage of every module, and equality with what was delivered.
    let okCandidate = false;
    if (s.check(`candidate-recorded:${tag}`, Boolean(state.current_candidate), `current candidate ${state.current_candidate ?? '(none)'}`)) {
      const file = join(featureDir, 'candidates', `${state.current_candidate}.yaml`);
      const cv = mycelink(bin, ['candidate', 'verify', id, state.current_candidate, '--control-root', root, '--json']);
      f.candidate_verify = cv.json;
      const okCv = s.check(`candidate-verify:${tag}`, cv.code === 0 && cv.json?.ok === true, cv.json ? `problems: ${JSON.stringify(cv.json.problems ?? [])}` : `exit ${cv.code}: ${cv.stderr.slice(0, 300)}`);
      const audit = mycelink(bin, ['repo', 'audit', '--control-root', root, '--json']);
      const pathOf = Object.fromEntries((audit.json?.repositories ?? []).map((r) => [r.name, pathKey(r.path)]));
      const bound = existsSync(file) ? candidateRepositories(readFileSync(file, 'utf8')) : {};
      f.candidate_repositories = bound;
      const boundModules = {};
      for (const [repoName, rec] of Object.entries(bound)) {
        const mod = moduleByPath[pathOf[repoName]];
        if (mod) boundModules[mod] = { repo: repoName, sha: rec.sha };
      }
      const covered = MODULES.filter((m) => boundModules[m]);
      const okCover = s.check(`candidate-binds-every-module:${tag}`, covered.length === MODULES.length, `candidate binds ${covered.join(', ') || 'nothing'} of ${MODULES.join(', ')}`);
      const matches = [];
      const mismatches = [];
      for (const m of covered) {
        const repo = join(workspace, 'repos', m);
        const sha = boundModules[m].sha;
        const same = deliveredHeads[m] && /^[0-9a-f]{40}$/.test(sha ?? '') && treeOf(repo, sha) !== null && treeOf(repo, sha) === treeOf(repo, deliveredHeads[m]);
        (same ? matches : mismatches).push(`${m}:${String(sha).slice(0, 12)}${same ? '' : `≠${String(deliveredHeads[m]).slice(0, 12)}`}`);
      }
      f.candidate_matches_delivery = { matches, mismatches };
      const okMatch = s.check(
        `candidate-equals-delivery:${tag}`,
        covered.length > 0 && mismatches.length === 0,
        mismatches.length ? `delivered trees differ from the candidate: ${mismatches.join(', ')}` : `delivered trees equal the candidate's bound SHAs (${matches.join(', ')})`,
      );
      okCandidate = okCv && okCover && okMatch;
    }

    const budget = mycelink(bin, ['loop', 'budget', id, '--control-root', root, '--json']);
    f.usage = budget.json?.usage ?? null;
    orch.usage = f.usage;
    if (okNodes && okVerify && okLeases && okSessions && okCandidate) anyComplete = true;
  }

  // Worker/integration worktrees must not hold uncommitted work.
  for (const m of MODULES) {
    const repo = join(workspace, 'repos', m);
    if (!isRepoRoot(repo)) continue;
    const list = git(repo, ['worktree', 'list', '--porcelain']).stdout;
    const trees = [...list.matchAll(/^worktree (.+)$/gm)].map((x) => x[1]).filter((p) => pathKey(p) !== pathKey(repo));
    const dirty = trees.filter((p) => existsSync(p) && (unsafeGitConfig(p).length > 0 || git(p, ['status', '--porcelain']).stdout !== ''));
    s.check(`worktrees-clean:${m}`, dirty.length === 0, `${trees.length} extra worktree(s)${dirty.length ? `, dirty: ${dirty.join(', ')}` : ''}`);
  }

  for (const root of roots) {
    const status = isRepoRoot(root) ? git(root, ['status', '--porcelain', '--untracked-files=all']).stdout : 'not a git repository';
    const dirty = status.split('\n').filter((l) => l.trim() !== '');
    s.check(`control-repo-committed:${root}`, dirty.length === 0, dirty.length ? `${dirty.length} uncommitted path(s) in the control repository` : 'control repository clean', { severity: 'warning' });
  }
  s.check('a-feature-is-complete', anyComplete, anyComplete ? 'at least one feature is fully verified with a delivered candidate' : 'no feature is fully verified');
  return { section: s, present: true };
}

// ------------------------------------------------------------- driver ----

export async function verifyWorkspace({ workspace, scenario: expectedScenario, requireMycelink = false, mycelinkBin }) {
  const result = {
    schema: 'ledgerline-eval-verification/1',
    verifier_version: VERIFIER_VERSION,
    generated_at: new Date().toISOString(),
    workspace,
    scenario: null,
    ok: false,
    completion: null,
    reporting: null,
    orchestration: null,
    evidence: {},
    errors: [],
  };
  try {
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`workspace ${workspace} does not exist`);
    const detected = detectScenario(workspace);
    result.scenario = detected;
    if (!detected) throw new Error('cannot identify the scenario: platform/ does not descend from any known baseline commit');
    if (expectedScenario && expectedScenario !== detected) throw new Error(`expected scenario ${expectedScenario}, workspace is ${detected}`);

    const completion = await verifyCompletion(workspace, detected, result);
    result.completion = { ok: completion.ok, checks: completion.checks };
    const reporting = verifyReporting(workspace, result);
    result.reporting = { ok: reporting.ok, checks: reporting.checks };
    const orch = verifyOrchestration(workspace, mycelinkBin ?? join(REPO_ROOT, 'bin', 'mycelink.mjs'), result);
    result.orchestration = { required: requireMycelink, present: orch.present, ok: orch.section.ok, checks: orch.section.checks };
    result.ok = result.completion.ok && (!requireMycelink || result.orchestration.ok);
  } catch (error) {
    result.errors.push(String(error?.stack ?? error));
    result.ok = false;
  }
  return result;
}

function findWorkspaceUnder(root) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (existsSync(join(dir, 'acceptance', 'run.mjs')) && existsSync(join(dir, 'repos'))) return dir;
    if (depth >= 4) continue;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && !['.git', 'node_modules', 'repos', 'acceptance'].includes(e.name)) queue.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

export async function verifyAggregate({ aggregate, requireMycelink, mycelinkBin }) {
  const data = readJson(aggregate);
  const runs = [];
  for (const c of data.cases ?? []) {
    const scenario = CASE_SCENARIO[c.name];
    for (const [arm, list] of Object.entries(c.arms ?? {})) {
      for (const [i, run] of (list ?? []).entries()) {
        const entry = { case: c.name, arm, run: i + 1, score: run.score, turns: run.turns, cost_usd: run.costUsd, trace: run.tracePath };
        if (!scenario) {
          entry.result = { ok: false, errors: [`case ${c.name} is not part of this suite`] };
        } else {
          const sandbox = run.tracePath ? dirname(dirname(run.tracePath)) : null;
          const ws = sandbox && existsSync(sandbox) ? findWorkspaceUnder(sandbox) : null;
          entry.workspace = ws;
          entry.result = ws
            ? await verifyWorkspace({ workspace: ws, scenario, requireMycelink: requireMycelink && arm === 'with', mycelinkBin })
            : { ok: false, errors: [`no workspace under ${sandbox ?? '(no trace path)'} — re-run the eval with --keep-temp`] };
        }
        runs.push(entry);
      }
    }
  }
  const summary = {};
  for (const r of runs) {
    const k = `${r.case}/${r.arm}`;
    summary[k] ??= { runs: 0, verified: 0, completion_ok: 0, orchestration_ok: 0, mean_turns: 0, total_cost_usd: 0, mycelink_worker_tokens: 0 };
    const x = summary[k];
    x.runs += 1;
    x.verified += r.result.ok ? 1 : 0;
    x.completion_ok += r.result.completion?.ok ? 1 : 0;
    x.orchestration_ok += r.result.orchestration?.ok ? 1 : 0;
    x.mean_turns += r.turns ?? 0;
    x.total_cost_usd += r.cost_usd ?? 0;
    const u = r.result.evidence?.mycelink?.usage;
    if (u) x.mycelink_worker_tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  for (const x of Object.values(summary)) x.mean_turns = x.runs ? x.mean_turns / x.runs : 0;
  return {
    schema: 'ledgerline-eval-aggregate-verification/1',
    verifier_version: VERIFIER_VERSION,
    generated_at: new Date().toISOString(),
    aggregate,
    ok: runs.length > 0 && runs.every((r) => r.result.ok),
    summary,
    runs,
  };
}

function parseArgs(argv) {
  const flags = {};
  const valued = new Set(['workspace', 'aggregate', 'scenario', 'mycelink-bin', 'out']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (valued.has(name)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      flags[name] = argv[++i];
    } else if (name === 'require-mycelink' || name === 'help') flags[name] = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (flags.help) return flags;
  if (Boolean(flags.workspace) === Boolean(flags.aggregate)) throw new Error('pass exactly one of --workspace or --aggregate');
  if (flags.scenario && !SCENARIOS.includes(flags.scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(', ')}`);
  return flags;
}

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) {
    const out = { ok: false, errors: [`usage: ${error.message}`] };
    console.log(JSON.stringify(out, null, 2));
    return 2;
  }
  if (flags.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }
  let result;
  try {
    result = flags.aggregate
      ? await verifyAggregate({ aggregate: resolve(flags.aggregate), requireMycelink: Boolean(flags['require-mycelink']), mycelinkBin: flags['mycelink-bin'] && resolve(flags['mycelink-bin']) })
      : await verifyWorkspace({ workspace: resolve(flags.workspace), scenario: flags.scenario, requireMycelink: Boolean(flags['require-mycelink']), mycelinkBin: flags['mycelink-bin'] && resolve(flags['mycelink-bin']) });
  } catch (error) {
    result = { ok: false, errors: [String(error?.stack ?? error)] };
    console.log(JSON.stringify(result, null, 2));
    return 2;
  }
  const text = JSON.stringify(result, null, 2);
  if (flags.out) writeFileSync(resolve(flags.out), text + '\n');
  console.log(text);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (error) => {
      console.log(JSON.stringify({ ok: false, errors: [String(error?.stack ?? error)] }, null, 2));
      process.exitCode = 2;
    },
  );
}
