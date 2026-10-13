/**
 * Mycelink orchestration evidence in a delivered workspace, for any project.
 *
 * Generalises the multi-module suite's orchestration checks to a workspace
 * with one registered project repository: a control root with inert git
 * config; readable { revision, data } state; every node DONE with its
 * evidence on disk; `mycelink feature verify` and `candidate verify`
 * passing; the candidate binding the project repository at exactly the
 * delivered HEAD; `deliver` having actually run: the feature COMPLETED, the
 * accepted delivery manifest STATE.json pins naming the repository at that
 * commit, its acceptance passing with its output on disk as hashed, and the
 * delivery in the event log; no recorded lease (even a reclaimable one), no live
 * session, no dirty worker worktree; and exactly one current feature —
 * superseded features count as history only through a valid supersession
 * chain, and must be at rest.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { candidateRepositories, readMycelinkDoc } from '../../evals-multimodule/tools/verify-workspace.mjs';
import YAML from 'yaml';
import { mycelinkEnv, neutralDir, pathKey, readEntry, safeGit, unsafeGitConfig } from './git.mjs';
import { runSync } from './sandbox.mjs';
import { makeSection } from './hygiene.mjs';
import { artifactBin, verifyPluginArtifact } from './plugin.mjs';

const LIVE_SESSION_STATUSES = new Set(['spawning', 'working', 'stalled']);
const IN_FLIGHT_STATES = new Set(['CLAIMED', 'RED_PENDING', 'RED_VERIFIED', 'GREEN_PENDING', 'GREEN_VERIFIED', 'REFACTOR_VERIFIED', 'REGRESSION_VERIFIED', 'REVIEW_VERIFIED', 'INTEGRATED']);
const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.mycelink', 'worktrees', '.gradle']);

export function findControlRoots(workspace, maxDepth = 3) {
  const roots = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'mycelink.config.json')) roots.push(dir);
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
  };
  walk(workspace, 0);
  return roots;
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

/**
 * Run the pinned Mycelink CLI on the workspace, inside the isolation boundary: only the workspace,
 * the sealed artifact, this Node and the neutral git configuration exist there, and there is no
 * network. The CLI gets no operator environment, and every git it starts is hardened.
 */
export function runMycelink({ isolation, artifact, workspace, args, timeout = 300_000 }) {
  const binds = [{ path: workspace, rw: true }, { path: artifact.dir }, { path: dirname(process.execPath) }, { path: neutralDir() }];
  const r = runSync(isolation, { argv: [process.execPath, artifactBin(artifact), ...args], env: mycelinkEnv(), cwd: workspace, binds }, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status ?? -1, json, stderr: r.stderr ?? '' };
}

const within = (root, path) => {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** `{ repos: [{ name, path }], problems }` from a control root's repositories.yaml, read without running anything. */
export function readRegistry(root) {
  const file = join(root, 'repositories.yaml');
  if (!existsSync(file)) return { repos: [], problems: [`${file} is missing`] };
  let doc;
  try {
    doc = YAML.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { repos: [], problems: [`${file}: ${error.message.split('\n')[0]}`] };
  }
  const list = Array.isArray(doc?.repositories) ? doc.repositories : null;
  if (list === null) return { repos: [], problems: [`${file} has no repositories list`] };
  const repos = [];
  const problems = [];
  for (const r of list) {
    if (typeof r?.name !== 'string' || typeof r?.path !== 'string') problems.push(`${file}: an entry without a name and path`);
    else repos.push({ name: r.name, path: resolve(root, r.path) });
  }
  return { repos, problems };
}

/**
 * Why Mycelink must not run git in the repositories `root` registers:
 * one outside the workspace, not a repository with its own `.git`
 * directory, or one (or one of its worktrees) whose configuration could
 * make git run a program.
 */
export function registeredRepositoryProblems({ root, workspace }) {
  const { repos, problems } = readRegistry(root);
  const real = (p) => (existsSync(p) ? realpathSync.native(p) : resolve(p));
  const realWorkspace = real(workspace);
  // A registration inside the workspace as spelled, whose real place (links resolved) is inside the workspace's real
  // place: macOS reaches a temp workspace through /var and git names everything by /private/var, and a link out of
  // the workspace still leads outside it (Mycelink's own rule, src/security/paths.ts isInsideReal).
  const inWorkspace = (p) => within(workspace, p) || pathKey(p) === pathKey(workspace);
  const inRealWorkspace = (p) => within(realWorkspace, p) || pathKey(p) === pathKey(realWorkspace);
  for (const r of repos) {
    if (!inWorkspace(r.path) || !inRealWorkspace(real(r.path))) {
      problems.push(`${r.name} (${r.path}) is outside the workspace`);
      continue;
    }
    if (readEntry(join(r.path, '.git')).kind !== 'directory') {
      problems.push(`${r.name} (${r.path}) has no .git directory of its own`);
      continue;
    }
    const unsafe = unsafeGitConfig(r.path);
    if (unsafe.length) {
      problems.push(`${r.name} (${unsafe.join(', ')})`);
      continue;
    }
    const list = safeGit(r.path, ['worktree', 'list', '--porcelain']);
    if (list.code !== 0) {
      problems.push(`${r.name}: cannot list its worktrees`);
      continue;
    }
    // Git names every worktree, its main checkout included, by its real path: compared by real places.
    for (const w of [...list.stdout.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]).filter((p) => pathKey(real(p)) !== pathKey(real(r.path)))) {
      if (!existsSync(w)) continue;
      if (!inRealWorkspace(real(w))) problems.push(`${r.name}: worktree ${w} is outside the workspace`);
      else if (unsafeGitConfig(w).length) problems.push(`${r.name}: worktree ${w} (${unsafeGitConfig(w).join(', ')})`);
    }
  }
  return problems;
}

/**
 * Why the record of `deliver` does not prove that this feature's current
 * candidate was delivered at `deliveredHead` (empty: it does): the accepted
 * delivery manifest STATE.json pins by hash, naming the repository at
 * exactly that commit, every acceptance record passing on it with its output
 * on disk and hashing as recorded, and the delivery in the event log.
 */
export function deliveryProblems({ root, featureId, state, repository, candidateSha, deliveredHead }) {
  const featureDir = join(root, 'features', featureId);
  const candidate = state.current_candidate;
  const file = join(featureDir, 'deliveries', `${candidate}.json`);
  if (!existsSync(file)) return [`no delivery manifest for ${candidate}: deliver never ran`];
  const bytes = readFileSync(file);
  const problems = [];
  if (state.accepted_deliveries?.[candidate] !== sha256Hex(bytes)) problems.push('the manifest is not the accepted delivery STATE.json pins');
  let m;
  try {
    m = JSON.parse(bytes.toString('utf8'));
  } catch {
    return [...problems, 'the delivery manifest is not JSON'];
  }
  if (m?.schema !== 'mycelink-delivery/1' || m.status !== 'ACCEPTED' || m.feature_id !== featureId || m.candidate_id !== candidate) problems.push(`the manifest is ${m?.status ?? 'unreadable'} for ${m?.feature_id}/${m?.candidate_id}`);
  if (typeof m?.delivered_at !== 'string' || typeof m?.accepted_at !== 'string') problems.push('the manifest has no delivery and acceptance times');
  const delivered = m?.repositories?.[repository];
  if (!delivered || delivered.target !== candidateSha || delivered.after !== deliveredHead) problems.push(`the manifest does not deliver ${repository} at ${String(deliveredHead).slice(0, 12)}`);
  const acceptance = Array.isArray(m?.acceptance) ? m.acceptance.filter((a) => a?.repository === repository) : [];
  if (acceptance.length !== 1) problems.push(`${acceptance.length} acceptance record(s) for ${repository}`);
  for (const a of acceptance) {
    if (a.exit_code !== 0 || a.failure_fingerprint !== null || a.sha !== deliveredHead) problems.push(`acceptance of ${repository} did not pass on the delivered commit`);
    const output = typeof a.output_path === 'string' ? resolve(root, a.output_path) : null;
    if (!output || !within(featureDir, output) || !existsSync(output)) problems.push('the acceptance output is missing');
    else if (sha256Hex(readFileSync(output)) !== a.output_sha256) problems.push('the acceptance output does not hash as recorded');
  }
  const events = existsSync(featureDir) ? readdirSync(featureDir).filter((n) => /^events(\.\d+)?\.jsonl$/.test(n)) : [];
  const logged = events.some((n) =>
    readFileSync(join(featureDir, n), 'utf8')
      .split('\n')
      .some((line) => {
        try {
          const e = JSON.parse(line);
          return e?.type === 'delivery.delivered' && e.data?.candidate_id === candidate && e.data?.repositories?.[repository] === deliveredHead;
        } catch {
          return false;
        }
      }),
  );
  if (!logged) problems.push('the event log records no delivery of this candidate');
  return problems;
}

/** A worktree setup as Mycelink runs it (defaults filled in), or null. */
const normalSetup = (s) =>
  s === null || s === undefined
    ? null
    : { commands: s.commands ?? [], timeout_seconds: s.timeout_seconds ?? 900, env: s.env ?? {}, required_paths: s.required_paths ?? [], ...((s.inputs ?? []).length > 0 ? { inputs: s.inputs } : {}) };
/** The hash Mycelink binds a worktree setup by (engine/worktree-setup.ts worktreeSetupSha256). */
export const setupSha256 = (s) => (s === null || s === undefined ? null : sha256Hex(canonicalJson(normalSetup(s))));

/**
 * Why the with arm's Mycelink did not prepare the project's worktrees with
 * exactly the setup the workspace generated (empty: it did). The guide names
 * that install, but the agent cannot change what runs: the repository
 * registered at `repo` must still declare exactly the generated
 * `worktree_setup` (or, for a project that needs none, none), and every DONE
 * node of that repository, in every feature, must have last set its worktree
 * up with it, completely, with its receipt on disk as recorded.
 */
export function worktreeSetupProblems({ root, repo, expected }) {
  let doc;
  try {
    doc = YAML.parse(readFileSync(join(root, 'repositories.yaml'), 'utf8'));
  } catch (error) {
    return [`repositories.yaml: ${String(error?.message ?? error).split('\n')[0]}`];
  }
  const entries = (Array.isArray(doc?.repositories) ? doc.repositories : []).filter((r) => typeof r?.path === 'string' && pathKey(resolve(root, r.path)) === pathKey(repo));
  if (entries.length === 0) return [`the project repository is not registered in ${root}`];
  const want = setupSha256(expected);
  const problems = [];
  for (const e of entries) {
    const got = setupSha256(e.worktree_setup);
    if (got !== want) problems.push(`${e.name}: worktree_setup is not the generated one (${want === null ? 'none' : want.slice(0, 12)} generated, ${got === null ? 'none' : got.slice(0, 12)} registered)`);
  }
  if (want === null) return problems;
  const names = new Set(entries.map((e) => e.name));
  const featuresDir = join(root, 'features');
  for (const id of existsSync(featuresDir) ? readdirSync(featuresDir).sort() : []) {
    const dir = join(featuresDir, id);
    if (!existsSync(join(dir, 'STATE.json')) || !existsSync(join(dir, 'PORTFOLIO-GRAPH.yaml'))) continue;
    let state;
    let graph;
    try {
      state = readMycelinkDoc(join(dir, 'STATE.json'));
      graph = YAML.parse(readFileSync(join(dir, 'PORTFOLIO-GRAPH.yaml'), 'utf8'));
    } catch (error) {
      problems.push(`${id}: ${String(error?.message ?? error).split('\n')[0]}`);
      continue;
    }
    for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
      if (!names.has(node?.repository)) continue;
      const rt = state.nodes?.[node.id];
      if (rt?.state !== 'DONE') continue;
      const r = rt.worktree_setup ?? null;
      if (r === null) problems.push(`${node.id}: no worktree setup on record`);
      else if (r.status !== 'complete') problems.push(`${node.id}: its last setup failed (${r.code ?? '?'})`);
      else if (r.config_sha256 !== want) problems.push(`${node.id}: set up with ${String(r.config_sha256).slice(0, 12)}, not the generated setup ${want.slice(0, 12)}`);
      else {
        const file = typeof r.receipt_path === 'string' ? resolve(root, r.receipt_path) : null;
        if (!file || !within(dir, file) || !existsSync(file)) problems.push(`${node.id}: its setup receipt ${r.receipt_path} is missing`);
        else if (sha256Hex(readFileSync(file)) !== r.receipt_sha256) problems.push(`${node.id}: its setup receipt ${r.receipt_path} does not hash as recorded`);
      }
    }
  }
  return problems;
}

/** A repository's module descriptors as compared: the declared `modules` and `module_defaults`, canonical. */
const descriptors = (e) => canonicalJson({ modules: e?.modules ?? null, module_defaults: e?.module_defaults ?? null });

/**
 * Why the project repository registered at `repo` does not declare exactly
 * the module descriptors the workspace generated (empty: it does). A node's
 * gates run its module's command; an agent that widened a module's command
 * to the whole suite, or removed the descriptors, re-opened what CSET-202 r1
 * failed on. `expected` null: the workspace generated none.
 */
export function moduleDescriptorProblems({ root, repo, expected }) {
  let doc;
  try {
    doc = YAML.parse(readFileSync(join(root, 'repositories.yaml'), 'utf8'));
  } catch (error) {
    return [`repositories.yaml: ${String(error?.message ?? error).split('\n')[0]}`];
  }
  const entries = (Array.isArray(doc?.repositories) ? doc.repositories : []).filter((r) => typeof r?.path === 'string' && pathKey(resolve(root, r.path)) === pathKey(repo));
  if (entries.length === 0) return [`the project repository is not registered in ${root}`];
  const want = descriptors(expected);
  return entries.filter((e) => descriptors(e) !== want).map((e) => `${e.name}: its modules are not the generated ones (${expected === null ? 'none' : `${expected.modules.length} modules`} generated)`);
}

/**
 * `repo` is the project repository's path, `deliveredHead` its HEAD;
 * `expectedModules` its generated module descriptors (null: none), and
 * `expectedSetup` the worktree setup the workspace generated for it (null:
 * none). Returns `{ present, checks, facts }`.
 */
export function inspectOrchestration({ workspace, repo, deliveredHead, mycelink, isolation, expectedSetup = null, expectedModules = null }) {
  const { checks, check } = makeSection();
  const facts = { control_roots: [], features: [], usage: null };
  const roots = findControlRoots(workspace);
  facts.control_roots = roots;
  if (!check('control-root-present', roots.length > 0, roots.length ? `control root(s): ${roots.join(', ')}` : 'no mycelink.config.json in the workspace')) return { present: false, checks, facts };
  // Only the pinned, packaged Mycelink runs, and only while its sealed tree is exactly the pinned one.
  const before = verifyPluginArtifact(mycelink);
  facts.mycelink_artifact = { version: mycelink?.version ?? null, zip_sha256: mycelink?.zip_sha256 ?? null, tree_sha256: mycelink?.tree_sha256 ?? null, before: before.ok, after: null };
  if (!check('mycelink-artifact', before.ok, before.ok ? `pinned Mycelink ${mycelink.version} (package ${mycelink.zip_sha256.slice(0, 12)}, tree ${mycelink.tree_sha256.slice(0, 12)})` : `refusing to run Mycelink: ${before.problems.join('; ')}`)) {
    return { present: true, checks, facts };
  }
  const cli = (args) => runMycelink({ isolation, artifact: mycelink, workspace, args });
  const unsafe = [...roots, repo].filter((r) => existsSync(join(r, '.git'))).map((r) => [r, unsafeGitConfig(r)]).filter(([, u]) => u.length > 0);
  if (!check('git-config-safe:mycelink', unsafe.length === 0, unsafe.length ? `refusing to run Mycelink: ${unsafe.map(([r, u]) => `${r} (${u.join(', ')})`).join('; ')}` : 'control and project repositories have inert git configuration')) {
    return { present: true, checks, facts };
  }
  // Mycelink runs git in every repository a control root registers (and their worktrees): all of them
  // must be inside the workspace and inert, checked before the CLI runs at all.
  const registered = roots.flatMap((root) => registeredRepositoryProblems({ root, workspace }));
  facts.registered_repositories = roots.flatMap((root) => readRegistry(root).repos.map((r) => r.path));
  if (!check('registered-repositories-safe', registered.length === 0, registered.length ? `refusing to run Mycelink: ${registered.join('; ')}` : `${facts.registered_repositories.length} registered repository(ies), inside the workspace, inert`)) {
    return { present: true, checks, facts };
  }

  const features = [];
  for (const root of roots) {
    const dir = join(root, 'features');
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir).sort()) if (existsSync(join(dir, id, 'STATE.json'))) features.push({ root, id });
  }
  if (!check('feature-initialised', features.length > 0, `${features.length} feature(s) with STATE.json`)) return { present: true, checks, facts };

  const key = (root, id) => `${pathKey(root)}\0${id}`;
  const states = new Map();
  for (const { root, id } of features) {
    try {
      states.set(key(root, id), readMycelinkDoc(join(root, 'features', id, 'STATE.json')));
    } catch {
      // reported below, per feature
    }
  }
  const chain = (root, id) => {
    const seen = [id];
    for (let next = states.get(key(root, id))?.superseded_by; typeof next === 'string'; ) {
      if (seen.includes(next)) return { ok: false, detail: `cycle: ${[...seen, next].join(' -> ')}` };
      const state = states.get(key(root, next));
      if (!features.some((x) => x.root === root && x.id === next) || state === undefined) return { ok: false, detail: `${[...seen, next].join(' -> ')}: ${next} is not a readable feature of this control repository` };
      seen.push(next);
      next = state.superseded_by;
    }
    const end = seen[seen.length - 1];
    if (states.get(key(root, end))?.feature_state === 'CANCELLED') return { ok: false, detail: `${seen.join(' -> ')}: the chain ends at ${end}, which is cancelled` };
    return { ok: true, detail: seen.join(' -> ') };
  };

  const current = [];
  for (const { root, id } of features) {
    const f = { control_root: root, feature_id: id };
    facts.features.push(f);
    const featureDir = join(root, 'features', id);
    let state;
    try {
      state = readMycelinkDoc(join(featureDir, 'STATE.json'));
    } catch (error) {
      check(`state-readable:${id}`, false, error.message);
      current.push({ id, complete: false });
      continue;
    }
    let supersededBy = null;
    if (typeof state.superseded_by === 'string') {
      const c = chain(root, id);
      if (check(`superseded-chain:${id}`, c.ok, c.detail)) supersededBy = state.superseded_by;
    }
    const t = supersededBy ? makeSection() : { checks, check };
    const nodes = Object.entries(state.nodes ?? {});
    f.feature_state = state.feature_state;
    f.node_states = Object.fromEntries(nodes.map(([n, r]) => [n, r.state]));
    f.current_candidate = state.current_candidate ?? null;
    const okNodes = t.check(`nodes-done:${id}`, nodes.length > 0 && nodes.every(([, r]) => r.state === 'DONE' || r.state === 'EXCLUDED'), `${nodes.length} node(s): ${nodes.map(([n, r]) => `${n}=${r.state}`).join(', ')}`);

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
    t.check(`evidence-files:${id}`, missing.length === 0 && evidenceCount > 0, missing.length ? `missing: ${missing.join(', ')}` : `${evidenceCount} evidence record(s) with output on disk`);

    const verify = cli(['feature', 'verify', id, '--control-root', root, '--json']);
    f.feature_verify = verify.json;
    const okVerify = t.check(`feature-verify:${id}`, verify.code === 0 && verify.json?.ok === true, verify.json ? `problems: ${JSON.stringify(verify.json.problems)}` : `exit ${verify.code}: ${verify.stderr.slice(0, 300)}`);

    let leases;
    try {
      leases = existsSync(join(featureDir, 'leases.json')) ? readMycelinkDoc(join(featureDir, 'leases.json')).leases : [];
      if (!Array.isArray(leases)) throw new Error('leases.json has no leases array');
    } catch (error) {
      leases = [{ unreadable: error.message }];
    }
    f.leases = leases;
    const okLeases = t.check(`no-leaked-leases:${id}`, leases.length === 0, leases.length ? `${leases.length} unreleased lease(s): ${leases.map((l) => `${l.resource ?? '?'} by ${l.node_id ?? '?'} (holder pid ${l.pid ?? '?'} ${pidAlive(l.pid) ? 'alive' : 'exited'})`).join(', ')}` : 'leases.json empty');

    let sessions;
    try {
      sessions = existsSync(join(featureDir, 'sessions', 'registry.json')) ? readMycelinkDoc(join(featureDir, 'sessions', 'registry.json')).sessions : {};
      if (sessions === null || typeof sessions !== 'object') throw new Error('registry.json has no sessions map');
    } catch (error) {
      sessions = { unreadable: { status: 'working', detail: error.message } };
    }
    const live = Object.values(sessions).filter((x) => LIVE_SESSION_STATUSES.has(x.status) || (x.pid && !x.finished_at && pidAlive(x.pid)));
    f.sessions = { total: Object.keys(sessions).length, live: live.map((x) => x.session_id ?? '?') };
    const okSessions = t.check(`no-live-sessions:${id}`, live.length === 0, `${f.sessions.total} session(s), ${live.length} live`);

    let okCandidate = false;
    if (t.check(`candidate-recorded:${id}`, Boolean(state.current_candidate), `current candidate ${state.current_candidate ?? '(none)'}`)) {
      const file = join(featureDir, 'candidates', `${state.current_candidate}.yaml`);
      const cv = cli(['candidate', 'verify', id, state.current_candidate, '--control-root', root, '--json']);
      f.candidate_verify = cv.json;
      const okCv = t.check(`candidate-verify:${id}`, cv.code === 0 && cv.json?.ok === true, cv.json ? `problems: ${JSON.stringify(cv.json.problems ?? [])}` : `exit ${cv.code}: ${cv.stderr.slice(0, 300)}`);
      const audit = cli(['repo', 'audit', '--control-root', root, '--json']);
      const registered = (audit.json?.repositories ?? []).find((r) => pathKey(r.path) === pathKey(repo));
      const bound = existsSync(file) ? candidateRepositories(readFileSync(file, 'utf8')) : {};
      f.candidate_repositories = bound;
      const sha = registered ? bound[registered.name]?.sha : undefined;
      const okBinds = t.check(`candidate-binds-repository:${id}`, Boolean(registered && sha), registered ? `candidate binds ${registered.name} at ${String(sha).slice(0, 12)}` : `the project repository ${repo} is not registered`);
      const same = okBinds && /^[0-9a-f]{40}$/.test(sha) && sha === deliveredHead;
      const okMatch = t.check(`candidate-equals-delivery:${id}`, same, same ? `delivered HEAD is the candidate's bound commit ${sha.slice(0, 12)}` : `delivered ${String(deliveredHead).slice(0, 12)}, candidate ${String(sha).slice(0, 12)}`);
      // deliver itself ran, and accepted exactly this commit.
      const okCompleted = t.check(`feature-completed:${id}`, state.feature_state === 'COMPLETED', `feature state ${state.feature_state}`);
      const delivery = registered ? deliveryProblems({ root, featureId: id, state, repository: registered.name, candidateSha: sha, deliveredHead }) : ['the project repository is not registered'];
      const okDelivered = t.check(`delivery-accepted:${id}`, delivery.length === 0, delivery.length ? delivery.join('; ') : `deliver accepted ${state.current_candidate} at ${String(deliveredHead).slice(0, 12)}`);
      okCandidate = okCv && okBinds && okMatch && okCompleted && okDelivered;
    }

    // The plugin's independent acceptance review ran, required, and passed what was delivered (feature verify and
    // candidate verify above check its receipt is bound to exactly the delivered heads, graph and criteria).
    const review = state.acceptance_review ?? null;
    f.acceptance_review = review === null ? null : { required: review.required === true, max_rounds: review.max_rounds ?? null, reviews: (review.reviews ?? []).map((r) => ({ review_id: r.review_id, overall: r.overall, outcome: r.outcome, reworks: r.reworks ?? [], refinements: (r.refinements ?? []).length, revision: r.revision ?? (r.refinements ?? []).length, receipt_sha256: r.receipt_sha256 ?? null })), challenges: (review.challenges ?? []).map((c) => ({ challenge_id: c.challenge_id, node_id: c.node_id, status: c.status, gaps: c.gaps })), blocked: review.blocked ?? null, usage: review.usage ?? null };
    // A challenge no refinement decided leaves the review's PASS unproven: the loop stopped half-way.
    const undecided = (review?.challenges ?? []).filter((c) => c.status === 'pending').map((c) => c.challenge_id);
    const passed = (review?.reviews ?? []).some((r) => r.overall === 'PASS') && undecided.length === 0;
    const okReview = t.check(
      `acceptance-review:${id}`,
      review?.required === true && passed && (review?.blocked ?? null) === null,
      review === null ? 'no acceptance review: the feature was initialised without it' : `${review.required === true ? 'required' : 'opted out'}; ${(review.reviews ?? []).map((r) => `${r.review_id} ${r.outcome}`).join(', ') || 'no review settled'}${(review.challenges ?? []).length > 0 ? `; challenges ${(review.challenges ?? []).map((c) => `${c.challenge_id} ${c.status}`).join(', ')}` : ''}${review.blocked ? `; blocked ${review.blocked.code}` : ''}`,
    );

    const budget = cli(['loop', 'budget', id, '--control-root', root, '--json']);
    f.usage = budget.json?.usage ?? null;
    if (!supersededBy) facts.usage = f.usage;
    const inFlight = nodes.filter(([, r]) => r.claim || IN_FLIGHT_STATES.has(r.state)).map(([n]) => n);
    if (supersededBy) {
      f.superseded_by = supersededBy;
      for (const c of t.checks) checks.push({ ...c, id: `history:${c.id}`, severity: 'warning' });
      check(`superseded-quiescent:${id}`, okLeases && okSessions && inFlight.length === 0, `superseded by ${supersededBy}; ${inFlight.length ? `in flight: ${inFlight.join(', ')}` : okLeases && okSessions ? 'at rest' : 'a lease or session is still held'}`);
    } else {
      current.push({ id, complete: okNodes && okVerify && okLeases && okSessions && okCandidate && okReview });
    }
  }

  if (existsSync(join(repo, '.git'))) {
    const list = safeGit(repo, ['worktree', 'list', '--porcelain']).stdout;
    const trees = [...list.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]).filter((p) => pathKey(p) !== pathKey(repo));
    const dirty = trees.filter((p) => existsSync(p) && (unsafeGitConfig(p).length > 0 || safeGit(p, ['status', '--porcelain']).stdout !== ''));
    check('worktrees-clean', dirty.length === 0, `${trees.length} extra worktree(s)${dirty.length ? `, dirty: ${dirty.join(', ')}` : ''}`);
  }
  for (const root of roots) {
    // Every worktree was prepared with exactly the setup the workspace generated.
    const setup = worktreeSetupProblems({ root, repo, expected: expectedSetup });
    // Every node's gates ran its module's command: the registered descriptors are the generated ones.
    const modules = moduleDescriptorProblems({ root, repo, expected: expectedModules });
    check(`module-descriptors:${root}`, modules.length === 0, modules.length ? modules.join('; ') : expectedModules ? `the generated ${expectedModules.modules.length} module descriptors` : 'no module descriptors, as generated');
    check(`worktree-setup:${root}`, setup.length === 0, setup.length ? setup.slice(0, 8).join('; ') : expectedSetup ? `every worktree set up with the generated worktree_setup ${setupSha256(expectedSetup).slice(0, 12)}` : 'no worktree setup, as generated');
  }
  for (const root of roots) {
    const status = safeGit(root, ['status', '--porcelain', '--untracked-files=all']);
    const dirty = status.code === 0 ? status.stdout.split('\n').filter((l) => l.trim() !== '') : ['not a git repository'];
    check(`control-repo-committed:${root}`, dirty.length === 0, dirty.length ? `${dirty.length} uncommitted path(s) in the control repository` : 'control repository clean', { severity: 'warning' });
  }
  check('exactly-one-current-feature', current.length === 1, `${current.length} current (not superseded) feature(s): ${current.map((c) => c.id).join(', ') || 'none'}`);
  const complete = current.length === 1 && current[0].complete;
  check('a-feature-is-complete', complete, complete ? `the current feature ${current[0].id} is fully verified with a delivered candidate` : `no single current feature is fully verified (${current.map((c) => `${c.id}:${c.complete ? 'complete' : 'incomplete'}`).join(', ') || 'none'})`);
  const after = verifyPluginArtifact(mycelink);
  facts.mycelink_artifact.after = after.ok;
  check('mycelink-artifact-after', after.ok, after.ok ? 'the Mycelink artifact is unchanged after every CLI call' : `the Mycelink artifact changed while it ran: ${after.problems.join('; ')}`);
  return { present: true, checks, facts };
}
