/**
 * `mycelink` — the only supported path that changes harness state.
 *
 * Every graph transition, evidence registration, lease, candidate and E2E run
 * goes through here, so a model editing a file can never advance the feature.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { parseArgs, flagString, flagBool, flagNumber, type ParsedArgs } from './args.js';
import { featurePaths, controlPaths, nodeEvidenceDir } from '../workspace/paths.js';
import {
  DEFAULT_CONFIG,
  initControlRepo,
  initFeatureDirs,
  loadConfig,
  loadGraph,
  loadRepositories,
  loadWorkspace,
  repositoryPath,
  validateFeatureGraph,
} from '../workspace/workspace.js';
import { validateGraph, validateRepositories } from '../graph/validate.js';
import { DEFAULT_BUDGET, initialState, loadState, mutateState, saveState } from '../state/feature-state.js';
import { applyNodeTransition, isDeclaredEdge, recordFailure } from '../state/transition.js';
import { IN_FLIGHT_STATES, computeReady, scheduleBatch } from '../scheduler/ready.js';
import { acquireResource, leaseStatus, recoverLeases, releaseAllForNode, releaseResource } from '../resources/leases.js';
import { runVerification, verifierInvocation, type VerificationInvocation } from '../evidence/runner.js';
import { createCandidate, listCandidates, loadCandidate, verifyCandidate } from '../git/candidate.js';
import { integrateNodeBranch } from '../git/integrate.js';
import { createWorkerWorktree, workerBranchName, integrationBranchName } from '../git/worktree.js';
import { isGitRepository, isWorktreeClean, resolveRef, runGit } from '../git/git.js';
import { Orchestrator } from '../engine/orchestrator.js';
import { ClaudeCliAdapter } from '../sessions/claude-cli-adapter.js';
import { liveSessions, loadRegistry } from '../sessions/registry.js';
import { defaultLoops, loadLoops, writeLoops } from '../loops/contracts.js';
import { runSummary } from '../loops/runs.js';
import { loadScenarios, runE2E } from '../e2e/runner.js';
import { planShards } from '../e2e/scheduler.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { appendEvent, readEvents } from '../state/event-log.js';
import { runHook } from '../hooks/entrypoint.js';
import { hookHealth, installHooks } from '../workspace/hook-settings.js';
import { memoryCommand } from '../knowledge/cli.js';
import type { EvidenceKind, PortfolioGraph } from '../model/types.js';
import { assertPlainFileName } from '../security/names.js';
import { getAdapter, listAdapters } from '../adapters/registry.js';
import { packageRoot } from '../util/paths.js';
import { assertDecisionUsable, markDecisionApplied } from '../state/decisions.js';
import { preflightAdapter } from '../sessions/preflight.js';
import { featureVerifyProblems } from '../engine/feature-verify.js';
import { deliverFeature } from '../engine/deliver.js';
import { assertClaimCapability, assertControllerRole, presentedCapability } from '../engine/capability.js';
import { assertControllerAuthority, openControllerAuthority } from '../engine/authority.js';
import { isInsideReal } from '../security/paths.js';
import { checkEvidenceOutput, relativeInside, resolveEvidenceOutput } from '../evidence/paths.js';

/** The installed package version, from the package.json that ships with it. */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  stdin?: string;
}

const defaultIo: CliIo = {
  out: (t) => process.stdout.write(t.endsWith('\n') ? t : t + '\n'),
  err: (t) => process.stderr.write(t.endsWith('\n') ? t : t + '\n'),
};

const USAGE = `mycelink <group> <command> [options]

  version | --version                        print the installed version
  doctor                                     environment and workspace health
  controller open [--authority <current>|--takeover]  mint (first time) or rotate the controller key that controller-only commands need
  init <control-repo-path>                   create a control repository
  repo register|audit|lock                   repository manifest operations
  feature init|verify|status|cancel          feature lifecycle
  graph compile|validate|ready|import|adapters  portfolio graph operations
  node claim|begin|block|verify|finalize|release|invalidate  node lifecycle
  context pack <feature> <node>              write a bounded worker context pack
  session spawn|status|stop|reconcile        worker sessions
  evidence record|validate                   evidence registration
  tdd red|green|regression <node> -- <cmd>   TDD wrappers that transition on exit code
  branch create|integrate|verify             worker and integration branches
  candidate create|verify|list               cross-repository candidate manifests
  resource acquire|release|recover|status    capacity-bounded resource leases
  e2e plan|preflight|run|cleanup             browser E2E against a candidate
  loop validate|status|budget                loop contracts and the run ledger
  decision list|record|apply                 product decisions
  checkpoint create|validate|restore         feature checkpoints
  dispatch <feature> [--resume <node>]       claim the next READY node for the host's Agent tool (JSON ticket)
  settle <feature> <node> --capability <c>   verify, integrate and conclude a dispatched node from its result slot
  deliver <feature> [--candidate <id>]       fast-forward every base branch to the verified candidate, then accept
  orchestrate ready|once|run                 the feature orchestration cycle (standalone CLI adapter)
  memory <...>                               LLM Wiki Brain adapter
  hook <event>                               Claude Code hook entrypoint (stdin JSON)

Global: --control-root <path> --json   Controller-only commands also need --authority <key>.`;

/**
 * Every subcommand that changes controller state, graphs, manifests,
 * decisions, leases or branches. Each needs positive controller authority
 * (`--authority`, see engine/authority.ts) and refuses anyone presenting a
 * claim capability; worker-scoped commands (tdd, evidence record, node
 * begin/finalize, settle) are checked against the claim instead.
 */
export const CONTROLLER_ONLY: Record<string, ReadonlySet<string> | '*'> = {
  init: '*',
  dispatch: '*',
  deliver: '*',
  repo: new Set(['register', 'lock']),
  graph: new Set(['compile', 'import']),
  feature: new Set(['init', 'cancel']),
  node: new Set(['claim', 'block', 'invalidate', 'release', 'verify']),
  session: new Set(['spawn', 'reconcile', 'stop']),
  evidence: new Set(['migrate']),
  branch: new Set(['create', 'integrate']),
  candidate: new Set(['create']),
  resource: new Set(['acquire', 'release', 'recover']),
  e2e: new Set(['run', 'cleanup']),
  decision: new Set(['record', 'apply']),
  checkpoint: new Set(['restore']),
  orchestrate: new Set(['once', 'run']),
};

/** Find the control repository: flag, env, or nearest ancestor with mycelink.config.json. */
export function resolveControlRoot(args: ParsedArgs, cwd = process.cwd()): string {
  const flag = args.flags['control-root'];
  if (typeof flag === 'string') return resolve(flag);
  const env = process.env['MYCELINK_CONTROL_ROOT'];
  if (env) return resolve(env);
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'mycelink.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd);
}

function emit(io: CliIo, args: ParsedArgs, value: unknown, human: () => string): void {
  if (flagBool(args, 'json')) io.out(JSON.stringify(value, null, 2));
  else io.out(human());
}

function adapterFor(controlRoot: string): ClaudeCliAdapter {
  const config = loadConfig(controlRoot);
  const fakeExecutable = process.env['MYCELINK_FAKE_CLAUDE'];
  if (config.session_adapter === 'fake-claude' || fakeExecutable) {
    return new ClaudeCliAdapter({
      executable: process.execPath,
      prefixArgs: [fakeExecutable ?? config.claude_executable],
      adapterName: 'fake-claude',
    });
  }
  return new ClaudeCliAdapter({
    executable: config.claude_executable,
    extraArgs: config.claude_extra_args,
    allowPermissionBypass: config.allow_dangerous_permission_bypass === true,
    adapterName: 'claude-background',
    mode: 'print',
  });
}

function orchestratorFor(controlRoot: string, featureId: string): Orchestrator {
  return new Orchestrator({
    controlRoot,
    featureId,
    adapter: adapterFor(controlRoot),
    preflight: () => preflightAdapter(loadConfig(controlRoot)),
  });
}

/**
 * Gate a controller-only command on positive controller authority. `init`
 * of a directory that is not yet a control repository is the one bootstrap:
 * there is nothing to protect there yet, and no claim can exist.
 */
function requireController(args: ParsedArgs, operation: string): void {
  if (args.positional[0] === 'init') {
    const target = resolve(args.positional[1] ?? '.');
    if (!existsSync(controlPaths(target).config)) {
      assertControllerRole(args, operation);
      return;
    }
    assertControllerAuthority(args, target, operation);
    return;
  }
  assertControllerAuthority(args, resolveControlRoot(args), operation);
}

/** `mycelink controller open [--takeover]`: mint the controller key (see engine/authority.ts). */
function controllerGroup(args: ParsedArgs, io: CliIo): number {
  const sub = requirePositional(args, 1, 'open');
  if (sub !== 'open') {
    io.err(`Unknown controller command "${sub}".`);
    return 2;
  }
  assertControllerRole(args, 'controller open');
  const current = args.flags['authority'];
  const opened = openControllerAuthority(resolveControlRoot(args), {
    takeover: flagBool(args, 'takeover'),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ...(typeof current === 'string' ? { current } : current === true ? { current: '' } : {}),
  });
  emit(io, args, opened, () =>
    [
      `authority: ${opened.authority}`,
      'Pass it as --authority to every controller command (dispatch, deliver, reconcile, decisions, ...).',
      'It is shown once and never stored; never put it in a worker prompt, file or environment.',
    ].join('\n'),
  );
  return 0;
}

function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positional[index];
  if (value === undefined) throw new Error(`Missing required argument <${name}>`);
  return value;
}

// ---------------------------------------------------------------------------

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const args = parseArgs(argv);
  const group = args.positional[0];

  if (group === 'version' || (group === undefined && flagBool(args, 'version'))) {
    io.out(packageVersion());
    return 0;
  }

  if (group === undefined || group === 'help' || flagBool(args, 'help')) {
    io.out(USAGE);
    return group === undefined ? 1 : 0;
  }

  try {
    const sub = args.positional[1] ?? '';
    const only = CONTROLLER_ONLY[group];
    if (only === '*' || only?.has(sub)) requireController(args, `${group}${only === '*' ? '' : ` ${sub}`}`);
    switch (group) {
      case 'doctor':
        return doctor(args, io);
      case 'controller':
        return controllerGroup(args, io);
      case 'init':
        return cmdInit(args, io);
      case 'repo':
        return repoGroup(args, io);
      case 'feature':
        return featureGroup(args, io);
      case 'graph':
        return graphGroup(args, io);
      case 'node':
        return nodeGroup(args, io);
      case 'context':
        return contextGroup(args, io);
      case 'session':
        return await sessionGroup(args, io);
      case 'evidence':
        return evidenceGroup(args, io);
      case 'tdd':
        return tddGroup(args, io);
      case 'branch':
        return branchGroup(args, io);
      case 'candidate':
        return candidateGroup(args, io);
      case 'resource':
        return resourceGroup(args, io);
      case 'e2e':
        return await e2eGroup(args, io);
      case 'loop':
        return loopGroup(args, io);
      case 'decision':
        return decisionGroup(args, io);
      case 'checkpoint':
        return checkpointGroup(args, io);
      case 'orchestrate':
        return await orchestrateGroup(args, io);
      case 'dispatch':
        return await dispatchCommand(args, io);
      case 'settle':
        return settleCommand(args, io);
      case 'deliver':
        return deliverCommand(args, io);
      case 'memory':
        return memoryCommand(args, io, resolveControlRoot(args));
      case 'hook':
        return await runHook(requirePositional(args, 1, 'event'), args, io);
      default:
        io.err(`Unknown command group "${group}".\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err(message);
    return 1;
  }
}

// ---- doctor / init --------------------------------------------------------

function doctor(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const paths = controlPaths(controlRoot);
  const checks: { name: string; ok: boolean; detail: string; level?: 'ok' | 'warn' }[] = [];

  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  push('node', true, process.version);
  push('platform', true, `${process.platform} ${process.arch}`);
  push('control-root', existsSync(paths.controlRoot), paths.controlRoot);
  push('mycelink.config.json', existsSync(paths.config), paths.config);
  push('control repo is a git repository', isGitRepository(paths.controlRoot), paths.controlRoot);

  let repoOk = false;
  let repoDetail = 'repositories.yaml missing';
  const rawManifest = existsSync(paths.repositoriesManifest)
    ? (YAML.parse(readFileSync(paths.repositoriesManifest, 'utf8')) as { repositories?: unknown[] } | null)
    : null;
  if (rawManifest !== null && Array.isArray(rawManifest.repositories) && rawManifest.repositories.length === 0) {
    repoDetail = 'no repositories registered yet; run "mycelink repo register --name <name> --path <path> -- <test argv>"';
  } else if (existsSync(paths.repositoriesManifest)) {
    const result = validateRepositories(rawManifest);
    repoOk = result.ok;
    repoDetail = result.ok
      ? `${(YAML.parse(readFileSync(paths.repositoriesManifest, 'utf8')) as { repositories: unknown[] }).repositories.length} repositories`
      : result.problems.map((p) => p.detail).join('; ');
  }
  push('repositories.yaml', repoOk, repoDetail);

  if (repoOk) {
    const manifest = loadRepositories(controlRoot);
    for (const repo of manifest.repositories) {
      const path = resolve(controlRoot, repo.path);
      push(`repo:${repo.name}`, isGitRepository(path), path);
    }
  }

  const config = loadConfig(controlRoot);
  push('session adapter', true, config.session_adapter);
  // The standalone adapter is optional: host dispatch (the plugin's primary
  // path) never starts it. Its absence is reported, not failed.
  const adapter = preflightAdapter(config);
  checks.push({
    name: 'worker adapter (standalone)',
    ok: true,
    level: adapter.ok ? 'ok' : 'warn',
    detail: adapter.ok
      ? `${adapter.detail}`
      : `unavailable: ${adapter.detail}. orchestrate run cannot start workers; host dispatch (mycelink dispatch) does not need it.`,
  });

  if (existsSync(paths.config)) {
    const hooks = hookHealth(controlRoot);
    push('hooks', hooks.ok, hooks.detail);
  }

  const features = existsSync(paths.featuresDir)
    ? readdirSync(paths.featuresDir).filter((f) => !f.startsWith('.'))
    : [];
  push('features', true, features.join(', ') || '(none)');

  const ok = checks.every((c) => c.ok);
  emit(io, args, { ok, checks }, () =>
    checks.map((c) => `${c.level === 'warn' ? 'warn' : c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n'),
  );
  return ok ? 0 : 1;
}

function cmdInit(args: ParsedArgs, io: CliIo): number {
  const target = resolve(requirePositional(args, 1, 'control-repo-path'));
  const paths = initControlRepo(target);

  if (!existsSync(paths.repositoriesManifest)) {
    writeTextAtomic(
      paths.repositoriesManifest,
      YAML.stringify({ schema_version: 1, repositories: [] }, { lineWidth: 0 }),
    );
  }
  if (!existsSync(join(target, 'CLAUDE.md'))) {
    writeTextAtomic(join(target, 'CLAUDE.md'), CONTROL_REPO_CLAUDE_MD);
  }
  const settings = flagBool(args, 'no-hooks') ? null : installHooks(target);
  emit(io, args, { control_root: target, created: true, settings }, () =>
    `Initialised control repository at ${target}` +
      (settings ? `\nEnforcement hooks registered in ${settings}` : ''),
  );
  return 0;
}

const CONTROL_REPO_CLAUDE_MD = `# Mycelink control repository

This repository owns the authoritative execution state for multi-repository
features. Conversation history is never the source of truth.

## Authoritative artifacts

- \`repositories.yaml\` — the portfolio manifest
- \`features/<id>/PRD.md\`, \`PLAN.md\` — approved requirements
- \`features/<id>/PORTFOLIO-GRAPH.yaml\` — the executable dependency graph
- \`features/<id>/STATE.json\` — current node states (controller-owned)
- \`features/<id>/events.jsonl\`, \`RUNS.jsonl\` — append-only audit
- \`features/<id>/evidence/\` — real command output
- \`features/<id>/candidates/\` — immutable cross-repository manifests

## Rules

- Never edit \`STATE.json\`, \`PORTFOLIO-GRAPH.yaml\`, \`events.jsonl\`,
  \`RUNS.jsonl\`, \`leases.json\` or anything under \`candidates/\` by hand.
  Use \`mycelink\`; the project hooks block direct edits.
- A node advances only on a real exit code recorded as evidence.
- RED must fail because the behaviour is missing, not because of setup.
- Only one full runtime may exist; E2E holds a capacity-1 lease.
- Run features with \`/mycelink:run\` (dispatch, Agent, settle, deliver).
  Never hand-progress nodes or do a worker's job in the host session.
- Ask the user only for product decisions, recorded in \`DECISIONS.md\`.
`;

// ---- repo -----------------------------------------------------------------

function repoGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const paths = controlPaths(controlRoot);
  const sub = requirePositional(args, 1, 'register|audit|lock');

  if (sub === 'register') {
    const name = flagString(args, 'name');
    const path = flagString(args, 'path');
    const baseBranch = flagString(args, 'base-branch', 'main');
    const testCommand = args.passthrough.length > 0 ? args.passthrough : ['npm', 'test'];

    const manifest = existsSync(paths.repositoriesManifest)
      ? (YAML.parse(readFileSync(paths.repositoriesManifest, 'utf8')) as {
          schema_version: 1;
          repositories: Record<string, unknown>[];
        })
      : { schema_version: 1 as const, repositories: [] };

    manifest.repositories = manifest.repositories.filter((r) => r['name'] !== name);
    manifest.repositories.push({
      name,
      path,
      base_branch: baseBranch,
      ...(args.flags['role'] ? { role: String(args.flags['role']) } : {}),
      commands: { test: testCommand },
    });

    const result = validateRepositories(manifest);
    if (!result.ok) {
      io.err(result.problems.map((p) => `${p.code}: ${p.detail}`).join('\n'));
      return 1;
    }
    writeTextAtomic(paths.repositoriesManifest, YAML.stringify(manifest, { lineWidth: 0 }));
    emit(io, args, { registered: name }, () => `Registered repository "${name}".`);
    return 0;
  }

  if (sub === 'audit') {
    const manifest = loadRepositories(controlRoot);
    const rows = manifest.repositories.map((repo) => {
      const path = resolve(controlRoot, repo.path);
      const exists = isGitRepository(path);
      return {
        name: repo.name,
        path,
        git: exists,
        clean: exists ? isWorktreeClean(path) : false,
        head: exists ? resolveRef(path, 'HEAD') : null,
        base_branch: repo.base_branch,
        baseline_failures: repo.baseline_failures ?? [],
      };
    });
    const ok = rows.every((r) => r.git);
    emit(io, args, { ok, repositories: rows }, () =>
      rows
        .map((r) => `${r.git ? 'ok  ' : 'FAIL'} ${r.name} ${r.head ?? '(no git)'} ${r.path}`)
        .join('\n'),
    );
    return ok ? 0 : 1;
  }

  if (sub === 'lock') {
    const featureId = args.positional[2];
    const manifest = loadRepositories(controlRoot);
    const lock: Record<string, unknown> = { schema_version: 1, generated_at: new Date().toISOString(), repositories: {} };
    for (const repo of manifest.repositories) {
      const path = resolve(controlRoot, repo.path);
      const branch = featureId ? integrationBranchName(featureId) : repo.base_branch;
      const exists =
        runGit(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
          allowFail: true,
        }).exitCode === 0;
      (lock['repositories'] as Record<string, unknown>)[repo.name] = {
        branch: exists ? branch : repo.base_branch,
        sha: resolveRef(path, exists ? branch : repo.base_branch),
      };
    }
    writeTextAtomic(paths.reposLock, YAML.stringify(lock, { lineWidth: 0 }));
    emit(io, args, lock, () => `Wrote ${paths.reposLock}`);
    return 0;
  }

  io.err(`Unknown repo command "${sub}".`);
  return 2;
}

// ---- feature --------------------------------------------------------------

function featureGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'init|verify|status|cancel');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  if (sub === 'init') {
    assertControllerRole(args, 'feature init');
    // Re-initialising rewrites STATE.json from scratch. Once any node has
    // moved or failed, that would erase BLOCKED states and failure history,
    // so it needs a recorded decision.
    const existing = loadState(paths.featureDir)?.data;
    const progressed =
      existing !== undefined &&
      Object.values(existing.nodes).some(
        (n) => n.state !== 'PLANNED' || n.attempts > 0 || Object.keys(n.failure_counts).length > 0,
      );
    if (progressed) {
      const decisionId = args.flags['decision'];
      if (typeof decisionId !== 'string') {
        throw new Error(
          `STATE_EXISTS: ${featureId} already has progressed state; re-initialising would erase it. ` +
            'Pass --decision <recorded decision id> to start over deliberately.',
        );
      }
      assertDecisionUsable(paths.events, decisionId);
      markDecisionApplied(paths.events, featureId, decisionId, 'feature init');
    }
    initFeatureDirs(controlRoot, featureId);
    const graphPath = args.flags['graph'];
    if (typeof graphPath === 'string') {
      writeTextAtomic(paths.graph, readFileSync(resolve(graphPath), 'utf8'));
    }
    if (!existsSync(paths.graph)) {
      io.err(
        `No PORTFOLIO-GRAPH.yaml for ${featureId}. Write one (or pass --graph <path>) before "feature init".`,
      );
      return 1;
    }
    const validation = validateFeatureGraph(controlRoot, featureId);
    if (!validation.ok) {
      io.err(validation.problems.map((p) => `${p.code} ${p.path}: ${p.detail}`).join('\n'));
      return 1;
    }
    const graph = loadGraph(controlRoot, featureId);
    const budget = { ...DEFAULT_BUDGET };
    const wip = args.flags['writer-concurrency'];
    if (typeof wip === 'string') budget.max_writer_concurrency = Number(wip);

    saveState(paths.featureDir, initialState(graph, validation.graphHash, budget));
    if (!existsSync(paths.loops)) {
      writeLoops(paths.loops, defaultLoops(featureId, 'mycelink'));
    }
    for (const [file, body] of [
      [paths.decisions, `# Decisions for ${featureId}\n`],
      [paths.changes, `# Changes for ${featureId}\n`],
    ] as [string, string][]) {
      if (!existsSync(file)) writeTextAtomic(file, body);
    }
    appendEvent(paths.events, {
      idempotency_key: `feature.init:${featureId}:${validation.graphHash}`,
      type: 'feature.initialised',
      actor: 'mycelink',
      feature_id: featureId,
      data: { graph_hash: validation.graphHash, nodes: graph.nodes.length },
    });
    emit(io, args, { feature_id: featureId, graph_hash: validation.graphHash, nodes: graph.nodes.length }, () =>
      `Initialised ${featureId} with ${graph.nodes.length} nodes (graph ${validation.graphHash.slice(0, 12)}).`,
    );
    return 0;
  }

  if (sub === 'status') {
    const orchestrator = orchestratorFor(controlRoot, featureId);
    const summary = orchestrator.statusSummary();
    emit(io, args, summary, () => {
      const counts = Object.entries(summary.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return [
        `${summary.feature_id} ${summary.feature_state}`,
        `nodes: ${counts}`,
        `ready: ${summary.ready.join(', ') || '(none)'}`,
        `blocked: ${summary.blocked.join(', ') || '(none)'}`,
        `decisions: ${summary.pending_decisions.join(', ') || '(none)'}`,
        `candidate: ${summary.current_candidate ?? '(none)'}`,
      ].join('\n');
    });
    return 0;
  }

  if (sub === 'verify') {
    const problems = featureVerifyProblems(controlRoot, featureId);
    emit(io, args, { ok: problems.length === 0, problems }, () =>
      problems.length === 0 ? `${featureId} verified.` : problems.join('\n'),
    );
    return problems.length === 0 ? 0 : 1;
  }

  if (sub === 'cancel') {
    assertControllerRole(args, 'feature cancel');
    const graph = loadGraph(controlRoot, featureId);
    mutateState(paths.featureDir, (s) => {
      s.feature_state = 'CANCELLED';
      s.blocked_reason = typeof args.flags['reason'] === 'string' ? args.flags['reason'] : 'cancelled by user';
      for (const [id, runtime] of Object.entries(s.nodes)) {
        // Every claim-holding state, not only the pending ones: a node at
        // RED_VERIFIED or REGRESSION_VERIFIED still holds its claim.
        if (IN_FLIGHT_STATES.has(runtime.state) && runtime.state !== 'INTEGRATED') {
          s = applyNodeTransition(graph, s, id, 'PAUSED', { actor: 'mycelink', reason: 'feature cancelled' });
        }
      }
      return s;
    });
    for (const nodeId of Object.keys(loadState(paths.featureDir)?.data.nodes ?? {})) {
      releaseAllForNode(paths.featureDir, nodeId);
    }
    emit(io, args, { feature_id: featureId, cancelled: true }, () => `${featureId} cancelled; claims and leases released.`);
    return 0;
  }

  io.err(`Unknown feature command "${sub}".`);
  return 2;
}

// ---- graph ----------------------------------------------------------------

function graphGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'compile|validate|ready|import|adapters');

  if (sub === 'adapters') {
    const adapters = listAdapters().map((a) => ({
      name: a.name,
      description: a.description,
      verification: a.verification,
      inputs: [...a.inputs],
    }));
    emit(io, args, { adapters }, () =>
      adapters
        .map((a) => `${a.name.padEnd(12)} ${a.verification.padEnd(22)} --${a.inputs.join(' --')}  ${a.description}`)
        .join('\n'),
    );
    return 0;
  }

  const featureId = requirePositional(args, 2, 'feature-id');

  if (sub === 'import') {
    // Adapters produce a DRAFT for human review. They never write the
    // canonical PORTFOLIO-GRAPH.yaml or STATE.json.
    const adapter = getAdapter(flagString(args, 'adapter'));
    const files: Record<string, string> = {};
    for (const role of adapter.inputs) {
      const file = args.flags[role];
      if (typeof file !== 'string') {
        io.err(`Adapter "${adapter.name}" needs --${role} <file>.`);
        return 2;
      }
      files[role] = readFileSync(resolve(file), 'utf8');
    }
    const repositories = existsSync(controlPaths(controlRoot).repositoriesManifest)
      ? loadRepositories(controlRoot)
      : undefined;
    const draft = adapter.draft({ files, ...(repositories ? { repositories } : {}) });
    const paths = featurePaths(controlRoot, featureId);
    const out = typeof args.flags['out'] === 'string' ? resolve(args.flags['out']) : join(paths.featureDir, 'PORTFOLIO-GRAPH.draft.yaml');
    if (resolve(out) === resolve(paths.graph)) {
      io.err('Refusing to write an adapter draft over the canonical PORTFOLIO-GRAPH.yaml; review it and copy it yourself.');
      return 2;
    }
    mkdirSync(dirname(out), { recursive: true });
    const header =
      `# DRAFT generated by the "${adapter.name}" adapter (${adapter.verification}).\n` +
      `# Requires human review. Not approved. Rename to PORTFOLIO-GRAPH.yaml only after review,\n` +
      `# then run: mycelink graph validate ${featureId}\n`;
    writeTextAtomic(out, header + YAML.stringify(draft.graph, { lineWidth: 0 }));
    const report = {
      adapter: adapter.name,
      verification: adapter.verification,
      draft: out,
      requires_review: true,
      problems: draft.problems,
      review_notes: draft.review_notes,
    };
    emit(io, args, report, () =>
      [`Draft written to ${out} (requires review).`, ...draft.problems.map((p) => `${p.code} ${p.path}: ${p.detail}`), ...draft.review_notes].join('\n'),
    );
    return 0;
  }

  if (sub === 'compile') {
    const source = flagString(args, 'from');
    const parsed = YAML.parse(readFileSync(resolve(source), 'utf8')) as PortfolioGraph;
    const repositories = existsSync(controlPaths(controlRoot).repositoriesManifest)
      ? loadRepositories(controlRoot)
      : undefined;
    const result = validateGraph(parsed, repositories ? { repositories } : {});
    if (!result.ok) {
      io.err(result.problems.map((p) => `${p.code} ${p.path}: ${p.detail}`).join('\n'));
      return 1;
    }
    const paths = featurePaths(controlRoot, featureId);
    mkdirSync(paths.featureDir, { recursive: true });
    writeTextAtomic(paths.graph, YAML.stringify(parsed, { lineWidth: 0 }));
    emit(io, args, { graph_hash: result.graphHash, nodes: parsed.nodes.length }, () =>
      `Compiled ${parsed.nodes.length} nodes (hash ${result.graphHash.slice(0, 12)}).`,
    );
    return 0;
  }

  if (sub === 'validate') {
    const result = validateFeatureGraph(controlRoot, featureId);
    emit(io, args, result, () =>
      result.ok
        ? `Graph valid (hash ${result.graphHash.slice(0, 12)}).`
        : result.problems.map((p) => `${p.code} ${p.path}: ${p.detail}`).join('\n'),
    );
    return result.ok ? 0 : 1;
  }

  if (sub === 'ready') {
    const paths = featurePaths(controlRoot, featureId);
    const graph = loadGraph(controlRoot, featureId);
    const doc = loadState(paths.featureDir);
    if (doc === null) throw new Error(`No STATE.json for ${featureId}`);
    const ready = computeReady(graph, doc.data);
    const plan = scheduleBatch(graph, doc.data, {
      writerConcurrency: doc.data.budget.max_writer_concurrency,
    });
    emit(io, args, { ready, plan }, () =>
      [
        `ready: ${ready.join(', ') || '(none)'}`,
        `scheduled: ${plan.scheduled.map((s) => s.node_id).join(', ') || '(none)'}`,
        ...plan.deferred.map((d) => `deferred ${d.node_id}: ${d.reason} (${d.detail})`),
      ].join('\n'),
    );
    return 0;
  }

  io.err(`Unknown graph command "${sub}".`);
  return 2;
}

// ---- node -----------------------------------------------------------------

function nodeGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'claim|begin|block|verify|finalize|release|invalidate');
  const featureId = requirePositional(args, 2, 'feature-id');
  const nodeId = requirePositional(args, 3, 'node-id');
  const orchestrator = orchestratorFor(controlRoot, featureId);

  switch (sub) {
    case 'claim': {
      assertControllerRole(args, 'node claim');
      // A manual claim goes through the same scheduler check as a dispatch.
      const claim = orchestrator.claim(nodeId, { mode: 'manual' });
      const pack = orchestrator.writeContextPack(nodeId, claim.claimId);
      emit(io, args, { ...claim, context_pack: pack }, () =>
        `Claimed ${nodeId} (${claim.claimId}) worktree=${claim.worktree ?? '-'} branch=${claim.branch ?? '-'}\n` +
        `capability: ${claim.capability} (pass it as --capability to tdd and node finalize; it is not stored)`,
      );
      return 0;
    }
    case 'begin': {
      const graph = loadGraph(controlRoot, featureId);
      const paths = featurePaths(controlRoot, featureId);
      const node = graph.nodes.find((n) => n.id === nodeId);
      const target = node?.required_evidence.includes('red') ? 'RED_PENDING' : 'GREEN_PENDING';
      const capability = presentedCapability(args);
      mutateState(paths.featureDir, (s) => {
        assertClaimCapability(nodeId, s.nodes[nodeId], capability);
        return applyNodeTransition(graph, s, nodeId, target, { actor: 'mycelink' });
      });
      emit(io, args, { node_id: nodeId, state: target }, () => `${nodeId} -> ${target}`);
      return 0;
    }
    case 'block': {
      assertControllerRole(args, 'node block');
      const graph = loadGraph(controlRoot, featureId);
      const paths = featurePaths(controlRoot, featureId);
      const reason = flagString(args, 'reason', 'blocked by operator');
      mutateState(paths.featureDir, (s) =>
        applyNodeTransition(graph, s, nodeId, 'BLOCKED', { actor: 'mycelink', reason }),
      );
      releaseAllForNode(paths.featureDir, nodeId);
      emit(io, args, { node_id: nodeId, state: 'BLOCKED', reason }, () => `${nodeId} -> BLOCKED (${reason})`);
      return 0;
    }
    case 'invalidate': {
      assertControllerRole(args, 'node invalidate');
      // Cascades: a downstream node's evidence was produced against the old
      // upstream, so leaving it DONE would let a stale candidate look verified.
      const decisionId = typeof args.flags['decision'] === 'string' ? args.flags['decision'] : undefined;
      const eventsLog = featurePaths(controlRoot, featureId).events;
      if (decisionId !== undefined) assertDecisionUsable(eventsLog, decisionId);
      const invalidated = orchestrator.invalidateWithDependents(
        nodeId,
        flagString(args, 'reason', 'invalidated'),
        decisionId !== undefined ? { decisionId } : {},
      );
      if (decisionId !== undefined) markDecisionApplied(eventsLog, featureId, decisionId, `node invalidate ${nodeId}`);
      emit(io, args, { node_id: nodeId, invalidated }, () =>
        `INVALIDATED: ${invalidated.join(', ')}`,
      );
      return 0;
    }
    case 'finalize': {
      // The deterministic tail for a node driven through the gates by hand:
      // fresh verification, gate advancement, integration, DONE, release.
      const report = orchestrator.finalize(nodeId, presentedCapability(args));
      emit(io, args, report, () =>
        `${report.node_id} -> ${report.outcome} (${report.state})${report.idempotent ? ' [already settled]' : ''} ${report.detail}`,
      );
      return report.outcome === 'DONE' ? 0 : 1;
    }
    case 'verify': {
      // A diagnostic: its logs never replace the evidence a settle recorded.
      const result = orchestrator.freshVerify(nodeId, { labelPrefix: 'check' });
      emit(io, args, result, () =>
        `${result.ok ? 'ok  ' : 'FAIL'} ${nodeId}: ${result.detail}`,
      );
      return result.ok ? 0 : 1;
    }
    case 'release': {
      assertControllerRole(args, 'node release');
      orchestrator.releaseClaim(nodeId, { removeWorktree: flagBool(args, 'remove-worktree') });
      emit(io, args, { node_id: nodeId, released: true }, () => `Released ${nodeId}`);
      return 0;
    }
    default:
      io.err(`Unknown node command "${sub}".`);
      return 2;
  }
}

// ---- context --------------------------------------------------------------

function contextGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'pack');
  if (sub !== 'pack') {
    io.err(`Unknown context command "${sub}".`);
    return 2;
  }
  const featureId = requirePositional(args, 2, 'feature-id');
  const nodeId = requirePositional(args, 3, 'node-id');
  const orchestrator = orchestratorFor(controlRoot, featureId);
  const claimId =
    loadState(featurePaths(controlRoot, featureId).featureDir)?.data.nodes[nodeId]?.claim?.claim_id ??
    'unclaimed';
  const file = orchestrator.writeContextPack(nodeId, claimId);
  emit(io, args, { path: file }, () => file);
  return 0;
}

// ---- session --------------------------------------------------------------

async function sessionGroup(args: ParsedArgs, io: CliIo): Promise<number> {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'spawn|status|stop|reconcile');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  if (sub === 'status') {
    const registry = loadRegistry(paths.sessionsRegistry);
    const sessions = Object.values(registry.sessions);
    emit(io, args, { sessions }, () =>
      sessions
        .map((s) => `${s.status.padEnd(16)} ${s.node_id} attempt=${s.attempt} turns=${s.turns}`)
        .join('\n') || '(no sessions)',
    );
    return 0;
  }

  if (sub === 'spawn') {
    assertControllerRole(args, 'session spawn');
    const nodeId = requirePositional(args, 3, 'node-id');
    const orchestrator = orchestratorFor(controlRoot, featureId);
    const report = await orchestrator.runNode(nodeId);
    emit(io, args, report, () => `${report.node_id} -> ${report.outcome} (${report.state}) ${report.detail}`);
    return report.outcome === 'DONE' ? 0 : 1;
  }

  if (sub === 'reconcile') {
    assertControllerRole(args, 'session reconcile');
    const orchestrator = orchestratorFor(controlRoot, featureId);
    const result = orchestrator.reconcile({ abandonDispatches: flagBool(args, 'abandon-dispatches') });
    emit(io, args, result, () =>
      [
        `recovered leases: ${result.recoveredLeases}; orphaned sessions: ${result.orphanedSessions.length}; released nodes: ${result.releasedNodes.join(', ') || '(none)'}`,
        `abandoned dispatches: ${result.abandoned_dispatches.join(', ') || '(none)'}; interrupted settles: ${result.interrupted_settles.join(', ') || '(none)'}`,
        ...result.pending_dispatches.map(
          (d) =>
            `pending dispatch ${d.node_id}${d.result_present ? ' (result written: resume, then settle)' : ''}${d.expired ? ' (expired)' : ''}: mycelink dispatch ${featureId} --resume ${d.node_id} --json`,
        ),
      ].join('\n'),
    );
    return 0;
  }

  if (sub === 'stop') {
    assertControllerRole(args, 'session stop');
    const orchestrator = orchestratorFor(controlRoot, featureId);
    const result = orchestrator.reconcile();
    emit(io, args, result, () => `Stopped; ${result.orphanedSessions.length} sessions closed.`);
    return 0;
  }

  io.err(`Unknown session command "${sub}".`);
  return 2;
}

// ---- evidence / tdd -------------------------------------------------------

function evidenceGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'record|validate|migrate');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  if (sub === 'migrate') {
    // Rewrite legacy absolute output paths to control-root-relative ones.
    // Only records that resolve safely into this feature are rewritten;
    // the rest are left untouched and reported.
    const migrated: string[] = [];
    const refused: string[] = [];
    mutateState(paths.featureDir, (s) => {
      for (const [id, runtime] of Object.entries(s.nodes)) {
        for (const record of Object.values(runtime.evidence)) {
          if (!record) continue;
          const resolved = resolveEvidenceOutput(controlRoot, featureId, record);
          if (!resolved.ok) {
            refused.push(`${id} ${record.kind}: ${resolved.problem}`);
            continue;
          }
          const rel = relativeInside(controlRoot, resolved.path);
          if (rel !== null && rel !== record.output_path) {
            record.output_path = rel;
            record.cwd = relativeInside(controlRoot, record.cwd) ?? record.cwd;
            migrated.push(`${id} ${record.kind}`);
          }
        }
      }
      return s;
    });
    emit(io, args, { ok: refused.length === 0, migrated, refused }, () =>
      [`migrated ${migrated.length} record(s)`, ...refused].join('\n'),
    );
    return refused.length === 0 ? 0 : 1;
  }

  const nodeId = requirePositional(args, 3, 'node-id');

  if (sub === 'validate') {
    const doc = loadState(paths.featureDir);
    const runtime = doc?.data.nodes[nodeId];
    const graph = loadGraph(controlRoot, featureId);
    const node = graph.nodes.find((n) => n.id === nodeId);
    const problems: string[] = [];
    if (!runtime || !node) {
      problems.push(`UNKNOWN_NODE: ${nodeId}`);
    } else {
      for (const kind of node.required_evidence) {
        const record = runtime.evidence[kind];
        if (!record) problems.push(`MISSING_EVIDENCE: ${kind}`);
        else if (kind !== 'red' && record.exit_code !== 0) {
          problems.push(`FAILED_EVIDENCE: ${kind} exited ${record.exit_code}`);
        } else if (kind === 'red' && record.red_reason !== 'behaviour-missing') {
          problems.push(`INVALID_RED: ${record.red_reason ?? 'unclassified'}`);
        } else {
          const problem = checkEvidenceOutput(controlRoot, featureId, record);
          if (problem !== null) problems.push(problem);
        }
      }
    }
    emit(io, args, { ok: problems.length === 0, problems }, () =>
      problems.length === 0 ? `${nodeId} evidence complete.` : problems.join('\n'),
    );
    return problems.length === 0 ? 0 : 1;
  }

  if (sub === 'record') {
    const kind = flagString(args, 'kind') as EvidenceKind;
    // A worker may attest only what it does itself. Regression, review, E2E
    // and candidate evidence come from controller paths (fresh verification,
    // the E2E runner, candidate builds), never from a claim holder's argv.
    if (!WORKER_EVIDENCE_KINDS.has(kind)) {
      throw new Error(`EVIDENCE_KIND_NOT_ALLOWED: "${kind}" evidence is recorded by the controller, not by evidence record.`);
    }
    const capability = presentedCapability(args);
    const runtime = loadState(paths.featureDir)?.data.nodes[nodeId];
    assertClaimCapability(nodeId, runtime, capability);
    const cwd = claimedCwd(runtime?.claim?.worktree ?? null, args, controlRoot);
    const graph = loadGraph(controlRoot, featureId);
    const node = graph.nodes.find((n) => n.id === nodeId);
    const record = runVerification({
      kind,
      nodeId,
      repository: node?.repository ?? null,
      command: args.passthrough,
      cwd,
      evidenceDir: nodeEvidenceDir(controlRoot, featureId, nodeId),
      pathBase: controlRoot,
    });
    mutateState(paths.featureDir, (s) => {
      // The claim may have been released or rotated while the command ran.
      assertClaimCapability(nodeId, s.nodes[nodeId], capability);
      const rt = s.nodes[nodeId];
      if (rt) rt.evidence[kind] = record;
      return s;
    });
    emit(io, args, record, () => `${kind} exit=${record.exit_code} evidence=${record.output_path}`);
    return record.exit_code === 0 ? 0 : 1;
  }

  io.err(`Unknown evidence command "${sub}".`);
  return 2;
}

/**
 * TDD wrappers.
 *
 * These are the only way a node reaches RED_VERIFIED / GREEN_VERIFIED /
 * REGRESSION_VERIFIED: the controller runs the command itself, records the
 * real exit code as evidence, and transitions only if the gate is satisfied.
 */
function tddGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const phase = requirePositional(args, 1, 'red|green|regression');
  const featureId = requirePositional(args, 2, 'feature-id');
  const nodeId = requirePositional(args, 3, 'node-id');
  const paths = featurePaths(controlRoot, featureId);
  const graph = loadGraph(controlRoot, featureId);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node "${nodeId}" is not in the graph.`);

  const doc = loadState(paths.featureDir);
  const runtime = doc?.data.nodes[nodeId];
  if (!runtime) throw new Error(`Node "${nodeId}" has no runtime state.`);
  // Only the holder of the node's current claim may record its gates.
  const capability = presentedCapability(args);
  assertClaimCapability(nodeId, runtime, capability);

  // A gate that could not move the node is refused before it runs anything:
  // running the verifier anyway records evidence for nothing and, when it
  // fails, counts a failure the gate order caused.
  const gatePending = phase === 'red' ? 'RED_PENDING' : phase === 'green' ? 'GREEN_PENDING' : null;
  const gateVerified =
    phase === 'red' ? 'RED_VERIFIED' : phase === 'green' ? 'GREEN_VERIFIED' : 'REGRESSION_VERIFIED';
  const via = gatePending ?? runtime.state;
  const redMissing = phase === 'green' && node.required_evidence.includes('red') && runtime.evidence['red'] === undefined;
  if (redMissing || !isDeclaredEdge(runtime.state, via) || !isDeclaredEdge(via, gateVerified)) {
    const next = redMissing
      ? 'red'
      : runtime.state === 'RED_VERIFIED' || runtime.state === 'GREEN_PENDING'
        ? 'green'
        : runtime.state === 'GREEN_VERIFIED'
          ? 'regression'
          : runtime.state === 'CLAIMED' || runtime.state === 'RED_PENDING'
            ? 'red'
            : null;
    throw new Error(
      `GATE_OUT_OF_ORDER: ${nodeId} is ${runtime.state}; the ${phase} gate cannot run now${next ? ` (next: the ${next} gate)` : ''}. Nothing was run or recorded.`,
    );
  }

  const declared = node.verification_commands[0];
  // An explicit `-- <argv>` from the operator is always argv; a declared
  // verifier may ask for a shell, which the control-repo config must allow.
  let invocation: VerificationInvocation;
  if (args.passthrough.length > 0) invocation = { command: args.passthrough };
  else if (declared !== undefined && declared.command.length > 0) invocation = verifierInvocation(declared);
  else throw new Error('No command given and the node declares no verifier.');

  const cwd = claimedCwd(runtime.claim?.worktree ?? null, args, controlRoot);

  const repoDecl = node.repository
    ? loadRepositories(controlRoot).repositories.find((r) => r.name === node.repository)
    : undefined;

  const kind: EvidenceKind = phase === 'red' ? 'red' : phase === 'green' ? 'green' : 'regression';
  const record = runVerification({
    kind,
    nodeId,
    repository: node.repository,
    ...invocation,
    cwd,
    evidenceDir: nodeEvidenceDir(controlRoot, featureId, nodeId),
    ...(phase === 'red' ? { expectExit: -1 } : {}),
    baselineFailures: repoDecl?.baseline_failures ?? [],
    allowShell: loadConfig(controlRoot).allow_shell_commands,
    pathBase: controlRoot,
  });

  mutateState(paths.featureDir, (s) => {
    // Re-checked where the evidence lands: the claim may have been released
    // or rotated while the command ran, and then this evidence is not its.
    assertClaimCapability(nodeId, s.nodes[nodeId], capability);
    const rt = s.nodes[nodeId];
    if (rt) rt.evidence[kind] = record;
    return s;
  });

  const pending = phase === 'red' ? 'RED_PENDING' : phase === 'green' ? 'GREEN_PENDING' : null;
  const verified =
    phase === 'red' ? 'RED_VERIFIED' : phase === 'green' ? 'GREEN_VERIFIED' : 'REGRESSION_VERIFIED';

  try {
    mutateState(paths.featureDir, (s) => {
      assertClaimCapability(nodeId, s.nodes[nodeId], capability);
      let next = s;
      if (pending !== null && next.nodes[nodeId]?.state !== pending) {
        next = applyNodeTransition(graph, next, nodeId, pending, { actor: 'mycelink' });
      }
      return applyNodeTransition(graph, next, nodeId, verified, { actor: 'mycelink' });
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (record.failure_fingerprint !== null) {
      mutateState(paths.featureDir, (s) =>
        recordFailure(graph, s, nodeId, record.failure_fingerprint as string, { actor: 'mycelink' }),
      );
    }
    io.err(`${phase} gate refused: ${detail}`);
    emit(io, args, { ok: false, detail, evidence: record }, () => '');
    return 2;
  }

  emit(io, args, { ok: true, state: verified, evidence: record }, () =>
    `${nodeId} -> ${verified} (exit ${record.exit_code}, evidence ${record.output_path})`,
  );
  return 0;
}

/**
 * Where a worker-scoped command runs: the claim's worktree, or a `--cwd`
 * inside it. A gate run somewhere else would prove nothing about the claim.
 */
const WORKER_EVIDENCE_KINDS: ReadonlySet<string> = new Set(['red', 'green', 'refactor']);

function claimedCwd(worktree: string | null, args: ParsedArgs, controlRoot: string): string {
  const base = worktree ?? controlRoot;
  if (typeof args.flags['cwd'] !== 'string') return base;
  const requested = resolve(String(args.flags['cwd']));
  if (!isInsideReal(base, requested)) {
    throw new Error(`CWD_OUTSIDE_WORKTREE: ${requested} is outside the claim's working directory ${base}.`);
  }
  return requested;
}

// ---- branch / candidate ---------------------------------------------------

function branchGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const workspace = loadWorkspace(controlRoot);
  const sub = requirePositional(args, 1, 'create|integrate|verify');
  const featureId = requirePositional(args, 2, 'feature-id');

  if (sub === 'create') {
    const nodeId = requirePositional(args, 3, 'node-id');
    const graph = loadGraph(controlRoot, featureId);
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node?.repository) throw new Error(`Node "${nodeId}" has no repository.`);
    const repoDecl = workspace.repositories.repositories.find((r) => r.name === node.repository);
    const created = createWorkerWorktree({
      repoPath: repositoryPath(workspace, node.repository),
      featureId,
      nodeId,
      baseBranch: repoDecl?.base_branch ?? 'main',
      worktreeRoot: workspace.paths.worktreesDir,
      repositoryName: node.repository,
    });
    emit(io, args, created, () => `${created.branch} -> ${created.worktree}`);
    return 0;
  }

  if (sub === 'integrate') {
    assertControllerRole(args, 'branch integrate');
    const nodeId = requirePositional(args, 3, 'node-id');
    const graph = loadGraph(controlRoot, featureId);
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node?.repository) throw new Error(`Node "${nodeId}" has no repository.`);
    // Only freshly verified work may reach the integration branch.
    const state = loadState(featurePaths(controlRoot, featureId).featureDir)?.data.nodes[nodeId]?.state;
    if (state !== 'REVIEW_VERIFIED' && state !== 'INTEGRATED' && state !== 'DONE') {
      throw new Error(
        `NODE_NOT_VERIFIED: ${nodeId} is ${state ?? 'unknown'}; only a node past fresh verification may be integrated. ` +
          'Settle or finalize it instead.',
      );
    }
    const repoDecl = workspace.repositories.repositories.find((r) => r.name === node.repository);
    const result = integrateNodeBranch({
      repoPath: repositoryPath(workspace, node.repository),
      featureId,
      nodeBranch: workerBranchName(featureId, nodeId),
      baseBranch: repoDecl?.base_branch ?? 'main',
      integrationRoot: workspace.paths.integrationDir,
      repositoryName: node.repository,
    });
    emit(io, args, result, () => `${result.strategy} -> ${result.sha}`);
    return 0;
  }

  if (sub === 'verify') {
    const rows = workspace.repositories.repositories.map((repo) => {
      const path = repositoryPath(workspace, repo.name);
      const branch = integrationBranchName(featureId);
      const exists =
        runGit(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
          allowFail: true,
        }).exitCode === 0;
      return {
        repository: repo.name,
        branch,
        exists,
        sha: exists ? resolveRef(path, branch) : null,
        clean: isWorktreeClean(path),
      };
    });
    const ok = rows.every((r) => r.clean);
    emit(io, args, { ok, branches: rows }, () =>
      rows.map((r) => `${r.clean ? 'ok  ' : 'DIRTY'} ${r.repository} ${r.sha ?? '(no branch)'}`).join('\n'),
    );
    return ok ? 0 : 1;
  }

  io.err(`Unknown branch command "${sub}".`);
  return 2;
}

function candidateGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const workspace = loadWorkspace(controlRoot);
  const sub = requirePositional(args, 1, 'create|verify|list');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  const repoRefs = workspace.repositories.repositories
    .filter((repo) => {
      const branch = integrationBranchName(featureId);
      return (
        runGit(repositoryPath(workspace, repo.name), ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
          allowFail: true,
        }).exitCode === 0
      );
    })
    .map((repo) => ({
      name: repo.name,
      path: repositoryPath(workspace, repo.name),
      branch: integrationBranchName(featureId),
    }));

  if (sub === 'create') {
    assertControllerRole(args, 'candidate create');
    const graph = loadGraph(controlRoot, featureId);
    const unfinished = Object.entries(loadState(paths.featureDir)?.data.nodes ?? {})
      .filter(([id, rt]) => {
        const type = graph.nodes.find((n) => n.id === id)?.node_type;
        if (type === 'candidate-build' || type === 'e2e-scenario') return false;
        return rt.state !== 'DONE' && rt.state !== 'EXCLUDED';
      })
      .map(([id, rt]) => `${id}=${rt.state}`);
    if (unfinished.length > 0) {
      throw new Error(`NODES_NOT_DONE: a candidate binds finished work only; not done: ${unfinished.join(', ')}`);
    }
    const contracts = existsSync(workspace.paths.contractsDir)
      ? readdirSync(workspace.paths.contractsDir)
          .filter((f) => !f.startsWith('.'))
          .map((f) => `contracts/${f}`)
      : [];
    const manifest = createCandidate({
      controlRepo: controlRoot,
      featureDir: paths.featureDir,
      featureId,
      repositories: repoRefs,
      contracts,
    });
    mutateState(paths.featureDir, (s) => {
      s.candidates.push(manifest.candidate_id);
      s.current_candidate = manifest.candidate_id;
      if (s.feature_state === 'RUNNING') s.feature_state = 'CANDIDATE_READY';
      return s;
    });
    emit(io, args, manifest, () =>
      `${manifest.candidate_id}: ${Object.entries(manifest.repositories)
        .map(([n, r]) => `${n}@${r.sha.slice(0, 12)}`)
        .join(' ')}`,
    );
    return 0;
  }

  if (sub === 'verify') {
    const id =
      args.positional[3] ?? loadState(paths.featureDir)?.data.current_candidate ?? '';
    if (id === '') throw new Error('No candidate id given and no current candidate recorded.');
    const manifest = loadCandidate(paths.featureDir, id);
    const result = verifyCandidate(manifest, { controlRepo: controlRoot, repositories: repoRefs });
    emit(io, args, result, () =>
      result.ok
        ? `${id} still matches every repository.`
        : result.problems.map((p) => `${p.code}: ${p.detail}`).join('\n'),
    );
    return result.ok ? 0 : 1;
  }

  if (sub === 'list') {
    const ids = listCandidates(paths.featureDir);
    emit(io, args, { candidates: ids }, () => ids.join('\n') || '(none)');
    return 0;
  }

  io.err(`Unknown candidate command "${sub}".`);
  return 2;
}

// ---- resource -------------------------------------------------------------

function resourceGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'acquire|release|recover|status');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  if (sub === 'status') {
    const status = leaseStatus(paths.featureDir);
    emit(io, args, status, () =>
      Object.entries(status)
        .map(([r, s]) => `${r}: ${s.held} held${s.holders.length ? ' by ' + s.holders.map((h) => h.node_id).join(', ') : ''}`)
        .join('\n') || '(no leases)',
    );
    return 0;
  }

  if (sub === 'acquire') {
    const resource = requirePositional(args, 3, 'resource');
    const nodeId = flagString(args, 'node', 'manual');
    const graph = loadGraph(controlRoot, featureId);
    const lease = acquireResource(paths.featureDir, resource, {
      nodeId,
      owner: flagString(args, 'owner', 'mycelink'),
      capacities: graph.resources,
      ...(typeof args.flags['idempotency-key'] === 'string'
        ? { idempotencyKey: String(args.flags['idempotency-key']) }
        : {}),
    });
    emit(io, args, lease, () => `${lease.resource} -> ${lease.lease_id}`);
    return 0;
  }

  if (sub === 'release') {
    const target = requirePositional(args, 3, 'lease-id|--node <node>');
    const released = target.startsWith('node:')
      ? releaseAllForNode(paths.featureDir, target.slice(5)).length
      : releaseResource(paths.featureDir, target)
        ? 1
        : 0;
    emit(io, args, { released }, () => `released ${released} lease(s)`);
    return 0;
  }

  if (sub === 'recover') {
    const recovered = recoverLeases(paths.featureDir);
    emit(io, args, { recovered }, () => `recovered ${recovered.length} lease(s)`);
    return 0;
  }

  io.err(`Unknown resource command "${sub}".`);
  return 2;
}

// ---- e2e ------------------------------------------------------------------

async function e2eGroup(args: ParsedArgs, io: CliIo): Promise<number> {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'plan|preflight|run|cleanup');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);
  const graph = loadGraph(controlRoot, featureId);
  const scenarios = loadScenarios(paths.scenariosDir);

  if (sub === 'plan' || sub === 'preflight') {
    const plan = planShards(scenarios, graph.resources);
    const ok = sub === 'plan' || scenarios.length > 0;
    emit(io, args, { ok, plan }, () =>
      [
        ...plan.shards.map((s) => `shard ${s.index}: ${s.scenarios.join(', ')}`),
        ...plan.serialised.map((s) => `serialised ${s.scenario} after ${s.against}: ${s.reason}`),
      ].join('\n') || '(no scenarios)',
    );
    return ok ? 0 : 1;
  }

  if (sub === 'run') {
    const candidateId =
      (typeof args.flags['candidate'] === 'string' ? args.flags['candidate'] : null) ??
      loadState(paths.featureDir)?.data.current_candidate;
    if (!candidateId) throw new Error('No --candidate given and no current candidate recorded.');
    const candidate = loadCandidate(paths.featureDir, candidateId);

    const workspace = loadWorkspace(controlRoot);
    const repoRefs = Object.entries(candidate.repositories).map(([name, bound]) => ({
      name,
      path: repositoryPath(workspace, name),
      branch: bound.branch,
    }));
    const drift = verifyCandidate(candidate, { controlRepo: controlRoot, repositories: repoRefs });
    if (!drift.ok) {
      io.err(
        'Candidate no longer matches the repositories; create a new candidate:\n' +
          drift.problems.map((p) => `${p.code}: ${p.detail}`).join('\n'),
      );
      return 1;
    }

    mutateState(paths.featureDir, (s) => {
      s.feature_state = 'E2E_RUNNING';
      return s;
    });

    const only = typeof args.flags['only'] === 'string' ? String(args.flags['only']).split(',') : undefined;
    const result = await runE2E({
      featureDir: paths.featureDir,
      evidenceRoot: join(paths.evidenceDir, 'e2e'),
      graph,
      candidate,
      scenarios,
      resources: graph.resources,
      cwd: controlRoot,
      pathBase: controlRoot,
      ...(only ? { only } : {}),
      ...(typeof args.flags['deploy'] === 'string' ? { deployCommand: String(args.flags['deploy']).split(' ') } : {}),
      ...(typeof args.flags['healthcheck'] === 'string'
        ? { healthcheckCommand: String(args.flags['healthcheck']).split(' ') }
        : {}),
      ...(typeof args.flags['fixture-reset'] === 'string'
        ? { fixtureResetCommand: String(args.flags['fixture-reset']).split(' ') }
        : {}),
    });

    // Back-propagate a failure to the nodes that could have caused it.
    for (const scenarioResult of result.results) {
      if (scenarioResult.passed || !scenarioResult.attribution) continue;
      for (const nodeId of scenarioResult.attribution.nodes) {
        try {
          mutateState(paths.featureDir, (s) =>
            applyNodeTransition(graph, s, nodeId, 'INVALIDATED', {
              actor: 'e2e',
              reason: `E2E ${scenarioResult.scenario_id} failed (${scenarioResult.attribution?.strategy})`,
            }),
          );
        } catch {
          // Node is already in a state that cannot be invalidated.
        }
      }
    }

    mutateState(paths.featureDir, (s) => {
      s.feature_state = result.passed ? 'VERIFIED' : 'RUNNING';
      return s;
    });

    emit(io, args, result, () =>
      [
        `candidate ${result.candidate_id}: ${result.passed ? 'PASS' : 'FAIL'}`,
        ...(result.preflight_failure ? [`preflight: ${result.preflight_failure}`] : []),
        ...result.results.map(
          (r) =>
            `${r.passed ? 'ok  ' : 'FAIL'} shard ${r.shard} ${r.scenario_id}` +
            (r.attribution ? ` -> ${r.attribution.strategy}: ${r.attribution.nodes.join(', ')}` : ''),
        ),
      ].join('\n'),
    );
    return result.passed ? 0 : 1;
  }

  if (sub === 'cleanup') {
    const recovered = recoverLeases(paths.featureDir);
    releaseAllForNode(paths.featureDir, `e2e:${loadState(paths.featureDir)?.data.current_candidate ?? ''}`);
    emit(io, args, { recovered: recovered.length }, () => `E2E cleanup released ${recovered.length} lease(s).`);
    return 0;
  }

  io.err(`Unknown e2e command "${sub}".`);
  return 2;
}

// ---- loop / decision / checkpoint -----------------------------------------

function loopGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'validate|status|budget');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  if (sub === 'validate') {
    const result = loadLoops(paths.loops);
    emit(io, args, result, () =>
      result.ok
        ? `${result.loops.length} loop contracts valid.`
        : result.problems.map((p) => `${p.code} ${p.path}: ${p.detail}`).join('\n'),
    );
    return result.ok ? 0 : 1;
  }

  if (sub === 'status' || sub === 'budget') {
    const nodeId = args.positional[3];
    const summary = runSummary(paths.runs, nodeId);
    const state = loadState(paths.featureDir)?.data;
    emit(io, args, { summary, usage: state?.usage, budget: state?.budget }, () =>
      [
        `attempts: ${summary.attempts}`,
        `turns: ${summary.total_model_turns} / ${state?.budget.max_total_model_turns ?? '?'}`,
        `wall clock: ${summary.total_wall_clock_ms} ms`,
        `last failure: ${summary.last_failure_fingerprint ?? '(none)'}`,
        ...Object.entries(summary.repeated_failures).map(([fp, n]) => `  ${fp} x${n}`),
      ].join('\n'),
    );
    return 0;
  }

  io.err(`Unknown loop command "${sub}".`);
  return 2;
}

function decisionGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'list|record|apply');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  if (sub === 'list') {
    const state = loadState(paths.featureDir)?.data;
    const pending = state?.pending_decisions ?? [];
    emit(io, args, { pending }, () => pending.join('\n') || '(no pending decisions)');
    return 0;
  }

  if (sub === 'record') {
    const decisionId = requirePositional(args, 3, 'decision-id');
    const answer = flagString(args, 'answer');
    const body = existsSync(paths.decisions) ? readFileSync(paths.decisions, 'utf8') : '';
    writeTextAtomic(
      paths.decisions,
      body + `\n### ${decisionId} ANSWERED ${new Date().toISOString()}\n\n${answer}\n`,
    );
    appendEvent(paths.events, {
      idempotency_key: `decision.recorded:${decisionId}`,
      type: 'decision.recorded',
      actor: 'user',
      feature_id: featureId,
      data: { decision_id: decisionId },
    });
    emit(io, args, { decision_id: decisionId, recorded: true }, () => `Recorded ${decisionId}.`);
    return 0;
  }

  if (sub === 'apply') {
    assertControllerRole(args, 'decision apply');
    const decisionId = requirePositional(args, 3, 'decision-id');
    assertDecisionUsable(paths.events, decisionId);
    const graph = loadGraph(controlRoot, featureId);
    const unblocked: string[] = [];
    mutateState(paths.featureDir, (s) => {
      let next = s;
      for (const [id, runtime] of Object.entries(next.nodes)) {
        if (runtime.state === 'NEEDS_DECISION' || runtime.state === 'BLOCKED') {
          next = applyNodeTransition(graph, next, id, 'READY', {
            actor: 'mycelink',
            decisionId,
          });
          unblocked.push(id);
        }
      }
      next.pending_decisions = next.pending_decisions.filter((d) => d !== decisionId);
      if (next.pending_decisions.length === 0 && next.feature_state === 'NEEDS_DECISION') {
        next.feature_state = 'RUNNING';
      }
      return next;
    });
    markDecisionApplied(paths.events, featureId, decisionId, 'decision apply');
    emit(io, args, { decision_id: decisionId, unblocked }, () =>
      `Applied ${decisionId}; unblocked ${unblocked.join(', ') || '(none)'}.`,
    );
    return 0;
  }

  io.err(`Unknown decision command "${sub}".`);
  return 2;
}

function checkpointGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'create|validate|restore');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);
  mkdirSync(paths.checkpointsDir, { recursive: true });

  if (sub === 'create') {
    const doc = loadState(paths.featureDir);
    if (doc === null) throw new Error(`No STATE.json for ${featureId}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(paths.checkpointsDir, `${stamp}.json`);
    const checkpoint = {
      created_at: new Date().toISOString(),
      feature_id: featureId,
      state_revision: doc.revision,
      graph_hash: doc.data.graph_hash,
      state: doc.data,
      leases: leaseStatus(paths.featureDir),
      last_event_seq: readEvents(paths.events, { limit: 1 })[0]?.seq ?? 0,
    };
    writeTextAtomic(file, JSON.stringify(checkpoint, null, 2) + '\n');
    emit(io, args, { path: file }, () => file);
    return 0;
  }

  if (sub === 'validate') {
    const files = existsSync(paths.checkpointsDir)
      ? readdirSync(paths.checkpointsDir).filter((f) => f.endsWith('.json')).sort()
      : [];
    const latest = files[files.length - 1];
    if (!latest) {
      io.err('No checkpoint found.');
      return 1;
    }
    const checkpoint = JSON.parse(readFileSync(join(paths.checkpointsDir, latest), 'utf8')) as {
      graph_hash: string;
    };
    const current = validateFeatureGraph(controlRoot, featureId);
    const ok = checkpoint.graph_hash === current.graphHash;
    emit(io, args, { ok, checkpoint: latest }, () =>
      ok ? `${latest} matches the current graph.` : `${latest} was taken against a different graph.`,
    );
    return ok ? 0 : 1;
  }

  if (sub === 'restore') {
    assertControllerRole(args, 'checkpoint restore');
    const name = requirePositional(args, 3, 'checkpoint-file');
    assertPlainFileName(name);
    // Restoring rewrites STATE.json wholesale, outside the state machine:
    // it could unblock parked nodes or revive invalidated work, so it needs
    // a recorded decision, like any other way out of a parked state.
    const decisionId = args.flags['decision'];
    if (typeof decisionId !== 'string') {
      throw new Error('DECISION_REQUIRED: checkpoint restore rewrites the feature state; pass --decision <recorded decision id>.');
    }
    assertDecisionUsable(paths.events, decisionId);
    const file = join(paths.checkpointsDir, name);
    const checkpoint = JSON.parse(readFileSync(file, 'utf8')) as { state: Parameters<typeof saveState>[1] };
    const restored = structuredClone(checkpoint.state);
    // No claim survives a restore: its capability may since have been
    // rotated or abandoned, and its holder is not this checkpoint.
    for (const runtime of Object.values(restored.nodes)) {
      if (runtime.claim !== null && IN_FLIGHT_STATES.has(runtime.state)) runtime.state = 'READY';
      runtime.claim = null;
    }
    saveState(paths.featureDir, restored);
    for (const nodeId of Object.keys(restored.nodes)) releaseAllForNode(paths.featureDir, nodeId);
    markDecisionApplied(paths.events, featureId, decisionId, `checkpoint restore ${name}`);
    emit(io, args, { restored: name }, () => `Restored ${name}.`);
    return 0;
  }

  io.err(`Unknown checkpoint command "${sub}".`);
  return 2;
}

// ---- host dispatch --------------------------------------------------------

/**
 * `mycelink dispatch <feature>`: the host-native primary path.
 *
 * Runs any controller nodes that are due, then claims the next schedulable
 * worker node in host mode and prints a ticket for the host's own Agent
 * tool. It never starts a worker process.
 */
async function dispatchCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  assertControllerRole(args, 'dispatch');
  const controlRoot = resolveControlRoot(args);
  const featureId = requirePositional(args, 1, 'feature-id');
  const orchestrator = orchestratorFor(controlRoot, featureId);
  const paths = featurePaths(controlRoot, featureId);
  mutateState(paths.featureDir, (s) => {
    if (s.feature_state === 'GRAPH_VALIDATED' || s.feature_state === 'PLAN_APPROVED') s.feature_state = 'RUNNING';
    return s;
  });

  const resume = args.flags['resume'];
  const result =
    typeof resume === 'string'
      ? orchestrator.resumeDispatch(resume)
      : await orchestrator.dispatchNext({ maxControllerSteps: flagNumber(args, 'max-controller-steps', 10) });

  emit(io, args, result, () =>
    [
      `dispatch: ${result.status} — ${result.detail}`,
      ...result.controller_reports.map((r) => `controller ${r.node_id} -> ${r.outcome} (${r.state})`),
      ...(result.ticket
        ? [
            `ticket: ${result.ticket.node_id} attempt ${result.ticket.attempt} -> agent ${result.ticket.agent}`,
            `result slot: ${result.ticket.result_slot}`,
            'Re-run with --json to get the full ticket (prompt and capability).',
          ]
        : []),
      ...result.pending.map((x) => `pending ${x.node_id} until ${x.expires_at}${x.expired ? ' (expired)' : ''}`),
    ].join('\n'),
  );
  return ['DISPATCHED', 'ALL_SETTLED', 'WAITING'].includes(result.status) ? 0 : 1;
}

/** `mycelink settle <feature> <node> --capability <c>`. */
function settleCommand(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const featureId = requirePositional(args, 1, 'feature-id');
  const nodeId = requirePositional(args, 2, 'node-id');
  const orchestrator = orchestratorFor(controlRoot, featureId);
  const report = orchestrator.settle(nodeId, presentedCapability(args));
  emit(io, args, { ...report, next: 'dispatch' }, () =>
    `${report.node_id} -> ${report.outcome} (${report.state})${report.idempotent ? ' [already settled]' : ''} ${report.detail}`,
  );
  return report.outcome === 'DONE' ? 0 : 1;
}

/**
 * `mycelink deliver <feature>`: fast-forward each base branch to exactly the
 * current candidate (all checks first, rollback on a mid-way failure, never
 * a push), write the delivery manifest, then run and record acceptance.
 */
function deliverCommand(args: ParsedArgs, io: CliIo): number {
  assertControllerRole(args, 'deliver');
  const controlRoot = resolveControlRoot(args);
  const featureId = requirePositional(args, 1, 'feature-id');
  const candidateId = typeof args.flags['candidate'] === 'string' ? args.flags['candidate'] : undefined;
  const result = deliverFeature(controlRoot, featureId, candidateId !== undefined ? { candidateId } : {});
  emit(io, args, result, () =>
    [
      `${result.candidate_id}: ${result.status}${result.idempotent ? ' (already delivered)' : ''}`,
      ...Object.entries(result.repositories).map(
        ([name, r]) => `${name} ${r.base_branch}: ${r.before.slice(0, 12)} -> ${(r.after ?? '?').slice(0, 12)} (${r.method})`,
      ),
      ...result.acceptance.map(
        (a) => `${a.failure_fingerprint === null ? 'ok  ' : 'FAIL'} acceptance ${a.repository} exit ${a.exit_code} ${a.output_path}`,
      ),
    ].join('\n'),
  );
  return result.ok ? 0 : 1;
}

// ---- orchestrate ----------------------------------------------------------

async function orchestrateGroup(args: ParsedArgs, io: CliIo): Promise<number> {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'ready|once|run');
  const featureId = requirePositional(args, 2, 'feature-id');
  const orchestrator = orchestratorFor(controlRoot, featureId);

  if (sub === 'ready') {
    const plan = orchestrator.plan();
    emit(io, args, plan, () =>
      [
        `scheduled: ${plan.scheduled.map((s) => s.node_id).join(', ') || '(none)'}`,
        ...plan.deferred.map((d) => `deferred ${d.node_id}: ${d.reason}`),
      ].join('\n'),
    );
    return 0;
  }

  assertControllerRole(args, `orchestrate ${sub}`);
  const paths = featurePaths(controlRoot, featureId);
  mutateState(paths.featureDir, (s) => {
    if (s.feature_state === 'GRAPH_VALIDATED' || s.feature_state === 'PLAN_APPROVED') {
      s.feature_state = 'RUNNING';
    }
    return s;
  });

  if (sub === 'once') {
    const cycle = await orchestrator.runOnce();
    emit(io, args, cycle, () =>
      cycle.reports.map((r) => `${r.node_id} -> ${r.outcome} (${r.state}) ${r.detail}`).join('\n') ||
      '(nothing scheduled)',
    );
    return cycle.reports.every((r) => r.outcome === 'DONE') ? 0 : 1;
  }

  if (sub === 'run') {
    const report = await orchestrator.runToCompletion({
      maxCycles: flagNumber(args, 'max-cycles', 50),
    });
    emit(io, args, report, () =>
      [
        `stop: ${report.stop_reason} after ${report.cycles} cycle(s); feature ${report.feature_state}`,
        ...(report.stop_reason === 'ADAPTER_UNAVAILABLE' && report.adapter
          ? [`adapter: ${report.adapter.detail ?? 'unavailable'} (nothing was charged; fix it and re-run, or use mycelink dispatch)`]
          : []),
        // Every node that did not finish says why, not only in --json.
        ...report.reports.map(
          (r) => `${r.node_id} -> ${r.outcome} (${r.state})${r.outcome === 'DONE' ? '' : `: ${r.detail.slice(0, 300)}`}`,
        ),
      ].join('\n'),
    );
    return report.stop_reason === 'ALL_SETTLED' ? 0 : 1;
  }

  io.err(`Unknown orchestrate command "${sub}".`);
  return 2;
}

export { USAGE };
