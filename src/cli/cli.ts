/**
 * `mycelink` — the only supported path that changes harness state.
 *
 * Every graph transition, evidence registration, lease, candidate and E2E run
 * goes through here, so a model editing a file can never advance the feature.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import { DEFAULT_BUDGET, initialState, loadState, mutateState, saveState, zeroUsage } from '../state/feature-state.js';
import { criterionClauses, reviewCriteria, reviewGateProblems, reviewPolicyOf, type Gap } from '../engine/acceptance-review.js';
import { capsuleUse } from '../engine/reproduction-capsule.js';
import { reviewRevisionProblems } from '../engine/review-revision.js';
import { reproductionSha256 } from '../engine/review-challenge.js';
import { MAX_RESULT_BYTES } from '../engine/review-transport.js';
import { applyNodeTransition, deferredRegression, isDeclaredEdge, provedWithoutRed, recordFailure, redRequired } from '../state/transition.js';
import { IN_FLIGHT_STATES, computeReady, scheduleBatch } from '../scheduler/ready.js';
import { acquireResource, leaseStatus, recoverLeases, releaseAllForNode, releaseResource } from '../resources/leases.js';
import { moduleInvocation, runVerification, verifierInvocation, type VerificationInvocation } from '../evidence/runner.js';
import { createCandidate, listCandidates, loadCandidate, verifyCandidate } from '../git/candidate.js';
import { withFeatureLock } from '../engine/feature-lock.js';
import { createWorkerWorktree, workerBranchName, integrationBranchName } from '../git/worktree.js';
import { isGitRepository, isWorktreeClean, resolveRef, runGit } from '../git/git.js';
import { Orchestrator, REVIEW_AWAIT_MAX_SECONDS, REVIEW_AWAIT_SECONDS } from '../engine/orchestrator.js';
import { ClaudeCliAdapter } from '../sessions/claude-cli-adapter.js';
import { CodexCliAdapter } from '../sessions/codex-cli-adapter.js';
import { wslCodexPrefix } from '../sessions/codex-cli-adapter.js';
import { codexRefinementPrompt, codexReviewPrompt } from '../engine/codex-review-session.js';
import { liveSessions, loadRegistry } from '../sessions/registry.js';
import { defaultLoops, loadLoops, writeLoops } from '../loops/contracts.js';
import { runSummary } from '../loops/runs.js';
import { loadScenarios, runE2E } from '../e2e/runner.js';
import { planShards } from '../e2e/scheduler.js';
import { createExclusive, writeTextAtomic } from '../state/atomic-json.js';
import { appendEvent, readEvents } from '../state/event-log.js';
import { runHook } from '../hooks/entrypoint.js';
import { hookHealth, installHooks } from '../workspace/hook-settings.js';
import { codexHealth } from '../workspace/codex-settings.js';
import { memoryCommand } from '../knowledge/cli.js';
import type { ChallengeRedSnapshot, EvidenceKind, EvidenceRecord, GraphNode, NodeRuntime, PortfolioGraph } from '../model/types.js';
import type { NodeResult } from '../sessions/adapter.js';
import { MAX_WORKER_RESULT_BYTES, WORKER_RESULT_DIR, WORKER_RESULT_FILE } from '../sessions/worker-protocol.js';
import { validateAgainstSchema } from '../schema/registry.js';
import { assertPlainFileName } from '../security/names.js';
import { getAdapter, listAdapters } from '../adapters/registry.js';
import { packageRoot } from '../util/paths.js';
import { assertDecisionUsable, markDecisionApplied } from '../state/decisions.js';
import { preflightAdapter } from '../sessions/preflight.js';
import { featureDeliveryProblems, featureVerifyProblems } from '../engine/feature-verify.js';
import { withLock } from '../state/process-lock.js';
import { portfolioRefs, registeredRepositories } from '../engine/portfolio.js';
import { deliverFeature } from '../engine/deliver.js';
import { assertClaimCapability, assertControllerRole, presentedCapability } from '../engine/capability.js';
import { assertControllerAuthority, openControllerAuthority } from '../engine/authority.js';
import { continueController, continueReviewedController } from '../engine/codex-continuation.js';
import { importCompletions } from '../engine/continuation-import.js';
import { finalizeCodexDelivery } from '../engine/codex-finalize.js';
import { isInsideReal, readRegular, samePath } from '../security/paths.js';
import { changedInputs, runWorktreeSetup, setupInputs, worktreeSetupOf, worktreeSetupSha256 } from '../engine/worktree-setup.js';
import { modulesOf, verifierFor } from '../engine/modules.js';
import { regressionDeferral, type DeferralDecision } from '../engine/regression-deferral.js';
import { capsulePathDetail, criterionKind, judgeCriteria, requiredGate, settledUncoveredCriteria } from '../engine/criteria.js';
import { carriedRed, ledgerOf } from '../engine/criterion-ledger.js';
import { checkEvidenceOutput, relativeInside, resolveEvidenceOutput } from '../evidence/paths.js';
import { artifactAt } from '../evidence/store.js';
import { repairEvidence } from '../engine/evidence-integrity.js';
import { productionSince, redBinding, redBoundFiles, redDeclaredTests, tddPolicyFor, verifyTddHistory } from '../engine/tdd-history.js';
import { RED_RETRY_GUIDANCE } from '../evidence/red-classify.js';
import { namesDeclared, readGateTests, shownTests, testLine } from '../evidence/gate-tests.js';
import { sessionHolder } from '../util/process-identity.js';
import { ACCEPTANCE_FILE, AcceptanceError, buildManifest, extractAcceptanceCriteria, loadAcceptanceManifest, manifestProblems, sidecarPath } from '../engine/acceptance.js';

/** Whether a path is a link (for a message only: nothing is read from this look). */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

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

  help | --help | -h                         print this usage
  version | --version                        print the installed version
  doctor                                     environment and workspace health
  codex init <control-repo-path>             bootstrap planning-only Codex control (no Claude hooks)
  codex status <feature>                     inspect local plan and runtime denial
  codex run <feature>                      run one disposable worker with held authority
  codex continue <feature> [--max-nodes 2]  hold new controller authority across bounded worker invocations (--review --deliver: one-shot candidate/delivery)
    [--import-source-control <separate-control> --import-state-sha256 <pinned-sha256> --import-nodes <id,id>]
                                           on a fresh target only: initialise and validate pinned DONE imports under that same held key before dispatch
  codex review <feature>                    launch one separate read-only reviewer with held authority (experimental)
  codex resume|verify|deliver <feature>    unsupported Codex execution
  controller open [--authority <current>|--recover|--takeover]  mint (first time), rotate, or recover (a fresh session after the holder ended) the controller key
  init <control-repo-path>                   create a control repository
  repo register|modules|audit|lock           repository manifest operations (register --worktree-setup <argv JSON>|none; modules: the verifier allowlist)
  feature init|acceptance|verify|status|owners|rework|cancel|supersede  feature lifecycle (verify --delivered: complete and delivered; supersede <old> --by <new> --reason <why>)
  feature acceptance <feature> --source <requirement.md> [--kind AC-n=compatibility|declaration,...]
                                 write the approved criteria verbatim, with their kinds (features/<feature>/ACCEPTANCE.json)
  feature owners <feature> [<repo>:<path>...] [--acceptance <AC,..>] [--since-delivery]
                                 the producer nodes that own a failure, and what reworking each reopens
  feature rework <feature> --reason <QA's report> [<repo>:<path>...] [--acceptance <AC,..>] [--since-delivery]
                                 rework the producer nodes that own a reported failure (QA after a delivery), dependents first
  graph compile|validate|ready|import|adapters  portfolio graph operations
  node claim|begin|block|verify|finalize|release|invalidate|rework|discard  node lifecycle
  node discard <feature> <node> --capability <c> --reason <why>
                                 hand back a dispatch the controller reached into: unspent, its branch archived, its evidence forgotten
  node rework <feature> <node> --reason <why> [--acceptance <AC,..>] [--evidence <path,..>] [--decision <id>]
                                 reopen DONE work found wrong, inside the same feature; the reason goes to its next worker
  context pack <feature> <node>              write a bounded worker context pack
  session spawn|status|stop|reconcile        worker sessions
  session provider-interrupt <feature> [--phase <phase>]
                                             reconcile the leases whose holder a model provider ended (from Claude Code's records)
  session provider-reset <feature>           clear a PROVIDER_UNAVAILABLE stop (controller)
  evidence record|validate                   evidence registration
  evidence repair <feature> [--dry-run]      restore stale evidence pointers from exact archives (controller): administrative,
                                 nothing rerun, reopened or charged; EVIDENCE_REPAIR_REQUIRED when no exact archive exists
  tdd red|green|regression <node> -- <cmd>   TDD wrappers that transition on exit code
  tdd capsule <feature> <node> --capability <c> --criterion <AC> [--files <path,..>] [--carry <CAP-id>]
                                 seal the exact uncommitted reproduction of a review gap: run on the claim's unchanged base, archived, never committed
  capsule verify <feature> [--node <id>] [--capsule <CAP-id>] [--replay]   check every reproduction capsule; --replay runs the cited ones again
  tdd tests|check <feature> <node>           a claim's gate test ids by words; its result's criterion evidence judged as settle will
  branch create|integrate|verify             worker and integration branches
  candidate create|verify|list               cross-repository candidate manifests
  resource acquire|release|recover|status    capacity-bounded resource leases
  e2e plan|preflight|run|cleanup             browser E2E against a candidate
  loop validate|status|budget                loop contracts and the run ledger
  decision list|record|apply                 product decisions
  checkpoint create|validate|restore         feature checkpoints
  dispatch <feature> [--resume <node>|<review>]  claim the next READY node (or hand out the acceptance review) for the host's Agent tool (JSON ticket)
  settle <feature> <node> --capability <c>   verify, integrate and conclude a dispatched node from its result slot
  review status <feature>                    the acceptance review: policy, rounds, the review with its reviewer, verdicts, a block
  review await <feature> [--review <id>] [--capability <c>] [--wait-seconds <n>]
                                 once the reviewer's Agent call is made: wait while it runs (at most n s, default 90)
                                 and say what comes next: RUNNING (await again; never settle it), COMPLETED (ingest,
                                 settle), TIMED_OUT or LOST (interrupted: dispatch again, nothing spent), MISSING (launch it)
  review ingest <feature> --review <id> --capability <c> [--agent-id <id>] [--result-file <file>|-]
                                 once the reviewer completed: take its final answer (exactly one JSON
                                 object) as the verdict when it wrote none, proved from Claude Code's own records
  review settle <feature> --review <id> --capability <c>
                                 take the reviewer's verdict: PASS lets the candidate be cut; GAPS reworks the producers
  deliver <feature> [--candidate <id>]       fast-forward every base branch to the verified candidate, then accept
  orchestrate ready|once|run                 the feature orchestration cycle (standalone CLI adapter)
  memory <...>                               LLM Wiki Brain adapter
  hook <event>                               Claude Code hook entrypoint (stdin JSON)

Global: --control-root <path> --json   Controller-only commands also need --authority <key>.`;

/**
 * What the red gate tells a worker whose production edits are in the way of
 * a RED (RED_NOT_TEST_ONLY). CSET-203 r12: it used to say `git stash
 * --include-untracked`, and the stash is every worktree's: an entry set aside
 * is taken back by the worktree that made it, and none is left behind.
 */
export const RED_NOT_TEST_ONLY_GUIDANCE =
  'Move those edits out of the worktree: remove them, or set them aside with git stash push -m <your node> and take back only your own entry (git stash pop, or stash@{N} from git stash list) once the test commit is made — the stash is shared by every worktree of the repository, so leave none behind. Run red with the test changes only, commit them alone, then write the production change. Nothing was run or recorded.';

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
  feature: new Set(['init', 'acceptance', 'rework', 'cancel', 'supersede']),
  node: new Set(['claim', 'block', 'invalidate', 'rework', 'release', 'verify']),
  session: new Set(['spawn', 'reconcile', 'stop', 'provider-reset']),
  evidence: new Set(['migrate', 'repair']),
  branch: new Set(['create', 'integrate']),
  candidate: new Set(['create']),
  resource: new Set(['acquire', 'release', 'recover']),
  e2e: new Set(['run', 'cleanup']),
  decision: new Set(['record', 'apply']),
  checkpoint: new Set(['restore']),
  orchestrate: new Set(['once', 'run']),
  capsule: '*',
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

function adapterFor(controlRoot: string): ClaudeCliAdapter | CodexCliAdapter {
  const config = loadConfig(controlRoot);
  if (config.provider.provider === 'codex') {
    // The CLI gate and preflight require explicit disposable-repository opt-in.
    return new CodexCliAdapter({
      executable: config.experimental_codex?.wsl ? 'wsl.exe' : config.provider.executable ?? 'codex',
      extraArgs: config.provider.extra_args,
      sandbox: config.provider.sandbox ?? 'workspace-write',
      disposableRepositories: preflightAdapter(config, process.env, controlRoot).ok,
      wsl: config.experimental_codex?.wsl,
      ...(config.experimental_codex?.wsl ? {
        gitTrustRoots: [controlRoot, ...loadRepositories(controlRoot).repositories.map((repo) => resolve(controlRoot, repo.path))],
      } : {}),
    });
  }
  const fakeExecutable = process.env['MYCELINK_FAKE_CLAUDE'];
  if (config.adapter === 'fake-provider' || fakeExecutable) {
    return new ClaudeCliAdapter({
      executable: process.execPath,
      prefixArgs: [fakeExecutable ?? config.provider.executable ?? 'claude'],
      adapterName: 'fake-claude',
    });
  }
  if (config.adapter !== 'claude-cli') {
    throw new Error(`Session adapter ${config.adapter} is configured but not implemented.`);
  }
  return new ClaudeCliAdapter({
    executable: config.provider.executable ?? 'claude',
    extraArgs: config.provider.extra_args ?? [],
    allowPermissionBypass: config.allow_dangerous_permission_bypass === true,
    adapterName: 'claude-background',
    mode: 'print',
  });
}

function orchestratorFor(controlRoot: string, featureId: string): Orchestrator {
  // Crash-recovery testing: MYCELINK_CRASH_AT=<settle boundary> kills this
  // process at that boundary, with nothing cleaned up, as a crash would.
  const crashAt = process.env['MYCELINK_CRASH_AT'];
  return new Orchestrator({
    controlRoot,
    featureId,
    adapter: adapterFor(controlRoot),
    preflight: () => preflightAdapter(loadConfig(controlRoot), process.env, controlRoot),
    ...(crashAt !== undefined && crashAt !== ''
      ? {
          settleFault: (point: string) => {
            if (point === crashAt) process.kill(process.pid, 'SIGKILL');
          },
        }
      : {}),
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
    recover: flagBool(args, 'recover'),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    // The Claude Code session this call runs in, verified as its ancestor: the key is bound to it.
    holder: sessionHolder(),
    ...(typeof current === 'string' ? { current } : current === true ? { current: '' } : {}),
  });
  emit(io, args, opened, () =>
    [
      `authority: ${opened.authority}${opened.recovered ? ' (recovered: the session that held the previous key has ended)' : ''}`,
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

  // A request for help — `help`, `--help` (whatever token it took as its value) or `-h`, with or without a
  // command group — is answered, not an error. No command group at all is.
  const help = group === 'help' || (args.flags['help'] !== undefined && args.flags['help'] !== 'false') || args.positional.includes('-h');
  if (help || group === undefined) {
    io.out(USAGE);
    return help ? 0 : 1;
  }

  try {
    const sub = args.positional[1] ?? '';
    if (group === 'codex') return await codexGroup(args, io);
    // Codex controls cannot reach other mutable paths by spelling a generic command.
    const target = group === 'init' ? resolve(args.positional[1] ?? '.') : resolveControlRoot(args);
    if (existsSync(controlPaths(target).config) && loadConfig(target).provider.provider === 'codex') {
      const planning = (group === 'graph' && ['compile', 'validate', 'import', 'adapters', 'ready'].includes(sub)) ||
        (group === 'feature' && ['acceptance', 'init'].includes(sub)) ||
        (group === 'repo' && ['register', 'modules', 'audit'].includes(sub)) ||
        (group === 'controller' && sub === 'open') || group === 'doctor';
      const experimentalWorker = (group === 'orchestrate' && ['ready', 'once'].includes(sub)) || group === 'tdd';
      const gate = preflightAdapter(loadConfig(target), process.env, target);
      if (!planning && !(experimentalWorker && gate.ok)) throw new Error(`CODEX_RUNTIME_DENIED: ${gate.detail}; ${group} ${sub} is not enabled for this Codex control. Use codex status for read-only inspection.`);
    }
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
      case 'review':
        return reviewGroup(args, io);
      case 'capsule':
        return capsuleGroup(args, io);
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

/** Codex host workflow: opt-in disposable worker slice, not review or delivery. */
async function codexGroup(args: ParsedArgs, io: CliIo): Promise<number> {
  const sub = requirePositional(args, 1, 'init|status|run|continue|review|resume|verify|deliver');
  if (sub === 'init') {
    assertControllerRole(args, 'codex init');
    const target = resolve(requirePositional(args, 2, 'control-repo-path'));
    // Idempotent for Codex; never convert Claude or edit a project config.
    if (existsSync(controlPaths(target).config) && loadConfig(target).provider.provider !== 'codex') throw new Error('CODEX_INIT_EXISTS: existing Claude control configuration must not be replaced.');
    if (existsSync(join(target, '.claude')) || existsSync(join(target, 'CLAUDE.md'))) throw new Error('CODEX_INIT_OCCUPIED: Claude assets must not be modified.');
    const paths = initControlRepo(target, { provider: { provider: 'codex', executable: 'codex', extra_args: [] } });
    if (!existsSync(paths.repositoriesManifest)) writeTextAtomic(paths.repositoriesManifest, YAML.stringify({ schema_version: 1, repositories: [] }));
    emit(io, args, { control_root: target, planning_only: true, runtime_enabled: false }, () => `Planning-only Codex control initialised at ${target}; no Claude hooks installed. Runtime denied.`);
    return 0;
  }
  if (!['status', 'run', 'continue', 'review', 'resume', 'verify', 'deliver'].includes(sub)) throw new Error(`Unknown codex command "${sub}".`);
  const controlRoot = resolveControlRoot(args);
  if (loadConfig(controlRoot).provider.provider !== 'codex' || !existsSync(controlPaths(controlRoot).config)) {
    throw new Error('CODEX_CONTROL_REQUIRED: use a planning-only Codex control repository; refusing to operate on a Claude control.');
  }
  const gate = preflightAdapter(loadConfig(controlRoot), process.env, controlRoot);
  const runReview = async (featureId: string) => {
    const orchestrator = orchestratorFor(controlRoot, featureId);
    const dispatched = await orchestrator.dispatchNext();
    if (dispatched.ticket?.schema !== 'mycelink-review-ticket/1' || dispatched.status !== 'DISPATCHED') throw new Error(`CODEX_REVIEW_NOT_READY: ${dispatched.status}: ${dispatched.detail}`);
    const ticket = dispatched.ticket;
    if (ticket.correction !== null) throw new Error('CODEX_REVIEW_CORRECTION_UNSUPPORTED');
    const config = loadConfig(controlRoot);
    const wsl = config.experimental_codex?.wsl;
    return orchestrator.settleCodexReview({ ...ticket, prompt: ticket.refinement !== null
      ? codexRefinementPrompt(ticket.prompt, ticket.packet_path)
      : codexReviewPrompt(ticket.prompt, ticket.packet_path) }, {
      executable: wsl ? 'wsl.exe' : config.provider.executable ?? 'codex',
      ...(wsl ? { prefixArgs: wslCodexPrefix(wsl), wsl: true } : {}),
      timeoutMs: 20 * 60_000,
    });
  };
  if (sub === 'continue' && gate.ok) {
    assertControllerRole(args, 'codex continue');
    if (args.flags['deliver'] !== undefined && args.flags['review'] !== true) {
      throw new Error('CODEX_DELIVERY_REQUIRES_REVIEW: --deliver requires --review and a fresh PASS in this held-authority continuation.');
    }
    if (args.flags['deliver'] !== undefined && args.flags['deliver'] !== true) {
      throw new Error('CODEX_DELIVERY_FLAG_INVALID: --deliver takes no value.');
    }
    if (args.flags['authority'] !== undefined || args.flags['recover'] !== undefined || args.flags['takeover'] !== undefined) {
      throw new Error('CODEX_CONTINUATION_AUTHORITY: continue opens its own new authority; it does not recover, take over or accept a key.');
    }
    const featureId = requirePositional(args, 2, 'feature-id');
    const validation = validateFeatureGraph(controlRoot, featureId);
    if (!validation.ok) throw new Error(`CODEX_GRAPH_INVALID: ${validation.problems.map((p) => `${p.code} ${p.path}: ${p.detail}`).join('; ')}`);
    const rawBound = args.flags['max-nodes'];
    const maxNodes = rawBound === undefined ? args.flags['review'] === true ? 3 : 2 : typeof rawBound === 'string' ? Number(rawBound) : NaN;
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 8) throw new Error('CODEX_CONTINUATION_BOUND: --max-nodes must be an integer from 1 to 8.');
    const importFlags = ['import-source-control', 'import-state-sha256', 'import-nodes'];
    const importing = importFlags.some((name) => args.flags[name] !== undefined);
    if (importing && (importFlags.some((name) => typeof args.flags[name] !== 'string') || loadState(featurePaths(controlRoot, featureId).featureDir) !== null)) {
      throw new Error('CODEX_CONTINUATION_IMPORT_FRESH: import requires all three explicit flags and no existing target STATE.json.');
    }
    const sourceControlRoot = importing ? resolve(args.flags['import-source-control'] as string) : null;
    const sourceSha = importing ? args.flags['import-state-sha256'] as string : null;
    const completedNodes = importing ? (args.flags['import-nodes'] as string).split(',') : [];
    if (importing && (sourceControlRoot === controlRoot || !/^[0-9a-f]{64}$/.test(sourceSha!) || completedNodes.length === 0 || completedNodes.some((id) => !id || !loadGraph(controlRoot, featureId).nodes.some((n) => n.id === id)))) {
      throw new Error('CODEX_CONTINUATION_IMPORT_INPUT: separate source, pinned SHA-256 and named graph nodes required.');
    }
    const sourceBytes = importing ? readFileSync(featurePaths(sourceControlRoot!, featureId).state) : null;
    if (sourceBytes && createHash('sha256').update(sourceBytes).digest('hex') !== sourceSha) throw new Error('IMPORT_SOURCE_HASH: source STATE.json differs from the independently pinned SHA-256.');
    const detail: { node_id: string; outcome: string; state: string }[] = [];
    const open = () => openControllerAuthority(controlRoot, { holder: sessionHolder() }).authority;
    const prepare = (authority: string) => {
        // A newly approved graph has no STATE.json. Initialise it once under
        // this same controller key, without printing or persisting the key.
        if (loadState(featurePaths(controlRoot, featureId).featureDir) === null) {
          const initOutput: string[] = [];
          const initCode = featureGroup({ ...args, positional: ['feature', 'init', featureId], flags: { ...args.flags, authority, json: true } }, {
            out: (text) => initOutput.push(text), err: (text) => { throw new Error(text); },
          });
          if (initCode !== 0) throw new Error(`CODEX_CONTINUATION_INIT_FAILED: ${initOutput.join(' ').slice(0, 500)}`);
        }
        if (importing) {
          const workspace = loadWorkspace(controlRoot);
          const graph = loadGraph(controlRoot, featureId);
          const repos = [...new Set(completedNodes.map((id) => graph.nodes.find((n) => n.id === id)?.repository))];
          if (repos.length !== 1 || repos[0] === null || repos[0] === undefined) throw new Error('CODEX_CONTINUATION_IMPORT_REPOSITORY: one registered producer repository required.');
          const repo = repositoryPath(workspace, repos[0]);
          const head = resolveRef(repo, 'HEAD');
          const state = loadState(featurePaths(controlRoot, featureId).featureDir)?.data;
          if (!state) throw new Error('CODEX_CONTINUATION_INIT_FAILED: missing fresh state.');
          const imported = importCompletions({ sourceControlRoot: sourceControlRoot!, targetControlRoot: controlRoot,
            sourceStateBytes: sourceBytes!, expectedSourceSha256: sourceSha!, sourceGraph: loadGraph(sourceControlRoot!, featureId), targetGraph: graph,
            targetState: state, repositoryPath: repo, head, policy: tddPolicyFor(loadRepositories(controlRoot).repositories.find((r) => r.name === repos[0])), completedNodes });
          if (!imported.ok) throw new Error(`CODEX_CONTINUATION_IMPORT_FAILED: ${imported.problems.map((p) => `${p.code}: ${p.detail}`).join('; ')}`);
        }
    };
    const run = async (authority: string) => {
        // Refuse parallel schedules: the bound counts actual node invocations.
        const plan = orchestratorFor(controlRoot, featureId).plan();
        if (plan.scheduled.length !== 1) return { outcome: 'NO_PROGRESS' };
        const output: string[] = [];
        const code = await orchestrateGroup({ ...args, positional: ['orchestrate', 'once', featureId], flags: { ...args.flags, authority, json: true } }, {
          out: (text) => output.push(text), err: (text) => { throw new Error(text); },
        });
        const cycle = JSON.parse(output.join('\n')) as { reports: { node_id: string; outcome: string; state: string }[] };
        if (cycle.reports.length !== 1 || cycle.reports[0]?.node_id !== plan.scheduled[0]?.node_id) throw new Error('CODEX_CONTINUATION_SCHEDULE_CHANGED: one scheduled node was not settled as expected.');
        const report = cycle.reports[0]!;
        // A challenge deliberately makes orchestrate once nonzero: the archived
        // challenge restores DONE and schedules a separate refinement reviewer.
        const challenged = report.outcome === 'REVIEW_CHALLENGED' && report.state === 'DONE' &&
          orchestratorFor(controlRoot, featureId).state().acceptance_review?.challenges?.some((c) =>
            c.node_id === report.node_id && c.status === 'pending');
        const outcome = code === 0 || challenged ? report.outcome : 'NODE_NOT_DONE';
        detail.push({ node_id: report.node_id, outcome, state: report.state });
        return { node_id: report.node_id, outcome };
    };
    if (args.flags['review'] === true) {
      const rawReviews = args.flags['max-reviews'];
      const maxReviews = rawReviews === undefined ? 2 : typeof rawReviews === 'string' ? Number(rawReviews) : NaN;
      if (!Number.isSafeInteger(maxReviews) || maxReviews < 1 || maxReviews > 3) throw new Error('CODEX_REVIEW_CONTINUATION_BOUND: --max-reviews must be an integer from 1 to 3.');
      const reviewReports: Awaited<ReturnType<typeof runReview>>[] = [];
      const result = await continueReviewedController({ maxNodes, maxReviews, open, prepare, run, review: async () => {
        const report = await runReview(featureId);
        reviewReports.push(report);
        return report;
      } });
      const delivery = args.flags['deliver'] === true && result.stop_reason === 'REVIEW_PASS'
        ? await finalizeCodexDelivery(controlRoot, featureId, orchestratorFor(controlRoot, featureId))
        : null;
      emit(io, args, { ...result, reports: detail, review: reviewReports.at(-1) ?? null, ...(delivery ? { delivery } : {}) }, () => `${result.stop_reason}: ${detail.map((r) => `${r.node_id} ${r.outcome}`).join(', ') || '(no node)'}${delivery ? `; ${delivery.candidate_id} ${delivery.status}` : ''}`);
      return result.stop_reason === 'REVIEW_PASS' && (delivery === null || delivery.ok) ? 0 : 1;
    }
    if (args.flags['max-reviews'] !== undefined) throw new Error('CODEX_REVIEW_CONTINUATION_BOUND: --max-reviews requires --review.');
    const result = await continueController({ maxNodes, open, prepare, run });
    emit(io, args, { ...result, reports: detail }, () => `${result.stop_reason}: ${detail.map((r) => `${r.node_id} ${r.outcome} ${r.state}`).join(', ') || '(no node)'}`);
    return result.stop_reason === 'BOUND_REACHED' && detail.every((r) => r.outcome === 'DONE') ? 0 : 1;
  }
  if (sub === 'run' && gate.ok) {
    requireController(args, 'codex run');
    const featureId = requirePositional(args, 2, 'feature-id');
    return orchestrateGroup({ ...args, positional: ['orchestrate', 'once', featureId] }, io);
  }
  if (sub === 'review' && gate.ok) {
    requireController(args, 'codex review');
    const report = await runReview(requirePositional(args, 2, 'feature-id'));
    emit(io, args, report, () => `Codex review ${report.review_id}: ${report.outcome}; ${report.reworked.join(', ')}`);
    return report.outcome === 'PASS' || report.outcome === 'GAPS' ? 0 : 1;
  }
  if (sub !== 'status') {
    throw new Error(`CODEX_RUNTIME_DENIED: ${gate.detail}; ${sub} is not enabled for this Codex control. No reviewer, verifier or delivery was started.`);
  }
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);
  const state = loadState(paths.featureDir)?.data ?? null;
  const graph = existsSync(paths.graph) ? validateFeatureGraph(controlRoot, featureId) : null;
  const report = {
    feature_id: featureId, graph_valid: graph?.ok ?? false,
    graph_problems: graph?.problems ?? [], state_present: state !== null,
    feature_state: state?.feature_state ?? null,
    nodes: state ? Object.fromEntries(Object.entries(state.nodes).map(([id, runtime]) => [id, runtime.state])) : {},
    runtime_enabled: gate.ok, runtime_reason: gate.ok ? 'Experimental disposable worker only; review, verification and delivery are not enabled.' : gate.detail,
  };
  emit(io, args, report, () => `${featureId}: graph ${report.graph_valid ? 'valid' : 'not valid'}, state ${report.feature_state ?? 'not initialised'}; ${report.runtime_reason}`);
  return 0;
}

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
  push('session adapter', true, config.adapter);
  // The standalone adapter is optional: host dispatch (the plugin's primary
  // path) never starts it. Its absence is reported, not failed.
  const adapter = preflightAdapter(config);
  checks.push({
    name: 'worker adapter (standalone)',
    ok: true,
    level: adapter.ok ? 'ok' : 'warn',
    detail: config.provider.provider === 'codex'
      ? `Codex worker preflight ${adapter.ok ? 'ready (experimental disposable only)' : 'denied'}: ${adapter.detail}; reviewer and delivery are disabled.`
      : adapter.ok
        ? `${adapter.detail}`
        : `unavailable: ${adapter.detail}. orchestrate run cannot start workers; host dispatch (mycelink dispatch) does not need it.`,
  });

  if (existsSync(paths.config)) {
    if (config.provider.provider === 'codex') checks.push(...codexHealth(controlRoot, config.provider.executable ?? 'codex'));
    else {
      const hooks = hookHealth(controlRoot);
      push('hooks', hooks.ok, hooks.detail);
    }
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
  const sub = requirePositional(args, 1, 'register|modules|audit|lock');

  if (sub === 'register') {
    const name = flagString(args, 'name');
    const manifest = existsSync(paths.repositoriesManifest)
      ? (YAML.parse(readFileSync(paths.repositoriesManifest, 'utf8')) as {
          schema_version: 1;
          repositories: Record<string, unknown>[];
        })
      : { schema_version: 1 as const, repositories: [] };
    // Registering a name again updates what is given and keeps the rest: a
    // generated entry's worktree_setup and tdd policy survive a new test command.
    const existing = manifest.repositories.find((r) => r['name'] === name);
    const path = flagString(args, 'path', typeof existing?.['path'] === 'string' ? existing['path'] : undefined);
    const other = manifest.repositories.find((r) => r['name'] !== name && typeof r['path'] === 'string' && samePath(resolve(controlRoot, r['path']), resolve(controlRoot, path)));
    if (other !== undefined) {
      io.err(
        `REPOSITORY_ALREADY_REGISTERED: ${path} is registered as "${String(other['name'])}"; register that name again to change it (its worktree_setup and tdd policy are kept). One repository has one name.`,
      );
      return 1;
    }
    const before = (existing ?? {}) as Record<string, unknown>;
    const commands = { ...((before['commands'] as Record<string, unknown> | undefined) ?? {}) };
    if (args.passthrough.length > 0 || commands['test'] === undefined) commands['test'] = args.passthrough.length > 0 ? args.passthrough : ['npm', 'test'];

    // Which paths are tests for the test-first history check: comma-separated
    // globs, each list replacing its default (see engine/tdd-history.ts).
    const globs = (flag: string): string[] | undefined => {
      const v = args.flags[flag];
      return typeof v === 'string' ? v.split(',').map((g) => g.trim()).filter((g) => g !== '') : undefined;
    };
    const tdd = {
      ...((before['tdd'] as Record<string, unknown> | undefined) ?? {}),
      ...(globs('test-paths') !== undefined ? { test_paths: globs('test-paths') } : {}),
      ...(globs('production-roots') !== undefined ? { production_roots: globs('production-roots') } : {}),
      ...(globs('declaration-paths') !== undefined ? { declaration_paths: globs('declaration-paths') } : {}),
    };
    // What every new worktree needs (engine/worktree-setup.ts): JSON — one argv, or
    // { commands, timeout_seconds, env, required_paths } — or `none`. Never a shell string.
    let setup: unknown = before['worktree_setup'];
    const setupFlag = args.flags['worktree-setup'];
    if (setupFlag !== undefined) {
      if (setupFlag === 'none') setup = undefined;
      else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(setupFlag));
        } catch {
          io.err('WORKTREE_SETUP_INVALID: --worktree-setup takes JSON: an argv array (["pnpm","install","--offline"]), an object { "commands": [[...]], "timeout_seconds", "env", "required_paths" }, or none. A shell string is never run.');
          return 1;
        }
        setup = Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? { commands: [parsed] } : Array.isArray(parsed) ? { commands: parsed } : parsed;
      }
    }
    const entry: Record<string, unknown> = {
      ...before,
      name,
      path,
      base_branch: flagString(args, 'base-branch', typeof before['base_branch'] === 'string' ? before['base_branch'] : 'main'),
      ...(args.flags['role'] ? { role: String(args.flags['role']) } : {}),
      commands,
      ...(Object.keys(tdd).length > 0 ? { tdd } : {}),
    };
    if (setup === undefined) delete entry['worktree_setup'];
    else entry['worktree_setup'] = setup;
    if (existing !== undefined) manifest.repositories[manifest.repositories.indexOf(existing)] = entry;
    else manifest.repositories.push(entry);

    const result = validateRepositories(manifest);
    if (!result.ok) {
      io.err(result.problems.map((p) => `${p.code}: ${p.detail}`).join('\n'));
      return 1;
    }
    writeTextAtomic(paths.repositoriesManifest, YAML.stringify(manifest, { lineWidth: 0 }));
    emit(io, args, { registered: name }, () => `Registered repository "${name}".`);
    return 0;
  }

  if (sub === 'modules') {
    // The allowlist a planner selects node verifiers from: each module's commands and hash, and the whole suite.
    const manifest = loadRepositories(controlRoot);
    const repositories = manifest.repositories.map((repo) => ({
      name: repo.name,
      full_suite: repo.commands.regression ?? repo.commands.test,
      commands: repo.commands,
      modules: modulesOf(repo).map((m) => ({ ...m, verifier: verifierFor(m) })),
    }));
    emit(io, args, { repositories }, () =>
      repositories
        .flatMap((r) => [
          `${r.name} full suite: ${r.full_suite.join(' ')}`,
          ...(r.modules.length === 0 ? [`${r.name} declares no modules: node verifiers name its commands`] : []),
          ...r.modules.map((m) => `${r.name} ${m.id} ${m.path}${m.runtime_tests ? '' : ' (declarations)'} ${m.sha256.slice(0, 12)}: ${[...m.setup, ...m.build, m.test].map((a) => a.join(' ')).join(' && ')}`),
        ])
        .join('\n'),
    );
    return 0;
  }

  if (sub === 'audit') {
    const manifest = loadRepositories(controlRoot);
    const rows = manifest.repositories.map((repo) => {
      const path = resolve(controlRoot, repo.path);
      const exists = isGitRepository(path);
      const setup = worktreeSetupOf(repo);
      return {
        name: repo.name,
        path,
        git: exists,
        clean: exists ? isWorktreeClean(path) : false,
        head: exists ? resolveRef(path, 'HEAD') : null,
        base_branch: repo.base_branch,
        baseline_failures: repo.baseline_failures ?? [],
        worktree_setup: setup === null ? null : { sha256: worktreeSetupSha256(setup), commands: setup.commands, required_paths: setup.required_paths },
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

/**
 * A switch a positional argument may follow (`--since-delivery web:src/x`):
 * the parser took that argument as the switch's value, so it goes back to
 * the positionals and the switch is on.
 */
function switchFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags[name];
  if (typeof value === 'string' && value !== 'true' && value !== 'false') {
    args.positional.push(value);
    args.flags[name] = true;
  }
  return flagBool(args, name);
}

function featureGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'init|acceptance|verify|status|owners|rework|cancel|supersede');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  if (sub === 'acceptance') return featureAcceptance(args, io, controlRoot, featureId);

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

    // The approved criteria the graph copies (engine/acceptance.ts), bound by their manifest's hash.
    const acceptance = loadAcceptanceManifest(controlRoot, featureId);
    // The acceptance review's policy (engine/acceptance-review.ts), fixed for the feature now.
    const reviewPolicy = reviewPolicyOf(loadConfig(controlRoot));
    const state = initialState(graph, validation.graphHash, budget);
    if (acceptance !== null) state.acceptance = { path: acceptance.path, sha256: acceptance.sha256 };
    // Its budget per criterion, then the safety it converges under (CSET-201 final): the emergency ceiling, the session and wall-clock budgets.
    state.acceptance_review = { required: reviewPolicy.required, max_rounds: reviewPolicy.max_rounds, criterion_ceiling: reviewPolicy.criterion_ceiling, max_review_sessions: reviewPolicy.max_review_sessions, review_wall_clock_ms: reviewPolicy.review_wall_clock_ms, reviewer_timeout_ms: reviewPolicy.reviewer_timeout_ms, open: null, reviews: [], blocked: null, usage: zeroUsage() };
    saveState(paths.featureDir, state);
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
        ...(summary.acceptance_review?.required
          ? [`acceptance review: ${summary.acceptance_review.blocked ? `BLOCKED ${summary.acceptance_review.blocked.code}` : summary.acceptance_review.passed ? 'PASS bound to the current heads' : summary.acceptance_review.open ? `${summary.acceptance_review.open.review_id} with its reviewer` : 'not passed'} (accepted reworks per criterion: ${summary.acceptance_review.budget_line || `none of ${summary.acceptance_review.max_rounds}`})`]
          : []),
        `next: ${summary.next_action.kind}${summary.next_action.resumable ? ' (resumable)' : ''}${summary.next_action.command !== null ? ` — mycelink ${summary.next_action.command}` : ''}: ${summary.next_action.detail}`,
      ].join('\n');
    });
    return 0;
  }

  if (sub === 'owners') {
    // A read for attributing a failure: which producer node to rework, and what that reopens.
    const acceptance = args.flags['acceptance'];
    const sinceDelivery = switchFlag(args, 'since-delivery');
    const report = orchestratorFor(controlRoot, featureId).owners({
      paths: args.positional.slice(3),
      acceptance: typeof acceptance === 'string' ? acceptance.split(',').map((x) => x.trim()).filter((x) => x !== '') : [],
      sinceDelivery,
    });
    emit(io, args, report, () =>
      [
        ...report.since_delivery.map((d) => `${d.paths.map((p) => `${d.repository}:${p}`).join(', ') || '(no paths)'} changed on ${d.base_branch} since the delivery (${d.from.slice(0, 12)}..${d.to.slice(0, 12)})`),
        ...report.owners.map((o) => `${o.node_id} (${o.state ?? '?'}) owns ${[...o.paths, ...o.acceptance].join(', ')}; node rework reopens ${o.reopens.join(', ')}`),
        ...(report.unowned.length > 0 ? [`unowned: ${report.unowned.join(', ')}`] : []),
        ...(report.owners.length === 0 ? ['no producer node owns these paths or acceptance criteria'] : []),
      ].join('\n'),
    );
    return 0;
  }

  if (sub === 'rework') {
    assertControllerRole(args, 'feature rework');
    // QA's report after a delivery: attributed to its producer nodes and reworked, inside this feature.
    const acceptance = args.flags['acceptance'];
    const reason = args.flags['reason'];
    const sinceDelivery = switchFlag(args, 'since-delivery');
    const report = orchestratorFor(controlRoot, featureId).reworkOwners({
      reason: typeof reason === 'string' ? reason : '',
      paths: args.positional.slice(3),
      acceptance: typeof acceptance === 'string' ? acceptance.split(',').map((x) => x.trim()).filter((x) => x !== '') : [],
      sinceDelivery,
    });
    emit(io, args, { ...report, next: 'dispatch' }, () =>
      [
        `${report.idempotent ? 'already reworked' : 'reworked'} ${report.targets.join(', ')} (attributed by ${report.attribution.by}${report.attribution.paths.length > 0 ? `: ${report.attribution.paths.join(', ')}` : ''})`,
        `reopened ${[...new Set(report.reworks.flatMap((r) => r.reopened))].join(', ')}; dispatch again, then cut and deliver a new candidate.`,
      ].join('\n'),
    );
    return 0;
  }

  if (sub === 'verify') {
    // --delivered: complete only when the current candidate was delivered and accepted, too.
    const problems = [...featureVerifyProblems(controlRoot, featureId), ...(flagBool(args, 'delivered') ? featureDeliveryProblems(controlRoot, featureId) : [])];
    emit(io, args, { ok: problems.length === 0, problems }, () =>
      problems.length === 0 ? `${featureId} verified.` : problems.join('\n'),
    );
    return problems.length === 0 ? 0 : 1;
  }

  if (sub === 'cancel') {
    assertControllerRole(args, 'feature cancel');
    const graph = loadGraph(controlRoot, featureId);
    const cancel = () => {
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
    };
    cancel();
    emit(io, args, { feature_id: featureId, cancelled: true }, () => `${featureId} cancelled; claims and leases released.`);
    return 0;
  }

  if (sub === 'supersede') {
    assertControllerRole(args, 'feature supersede');
    // Prefer `node rework` inside the feature. When a feature really is
    // replaced, the replacement is explicit and the old one must be at rest.
    const by = args.flags['by'];
    const reason = typeof args.flags['reason'] === 'string' ? args.flags['reason'].trim() : '';
    if (typeof by !== 'string' || by === featureId || loadState(featurePaths(controlRoot, by).featureDir) === null) {
      throw new Error(`SUPERSEDING_FEATURE_MISSING: --by must name another initialised feature (got ${typeof by === 'string' ? by : 'nothing'}).`);
    }
    if (reason === '') throw new Error('SUPERSEDE_REASON_REQUIRED: say why the feature is replaced (--reason).');
    const first = loadState(paths.featureDir)?.data;
    if (!first) throw new Error(`NO_STATE: ${featureId} has no STATE.json.`);
    if (first.superseded_by === by) {
      emit(io, args, { feature_id: featureId, superseded_by: by, idempotent: true }, () => `${featureId} is already superseded by ${by}.`);
      return 0;
    }
    // Both features' delivery locks, always in the same order: not while a
    // delivery of either runs, and two supersedes can never cross into a
    // cycle. Everything is judged once both are held.
    const [lockA, lockB] = [featureId, by].sort();
    withFeatureLock(featurePaths(controlRoot, lockA as string).featureDir, 'feature supersede', () =>
      withFeatureLock(featurePaths(controlRoot, lockB as string).featureDir, 'feature supersede', () => {
        // No cycle: the replacement must not itself be (transitively) replaced by this one.
        const seen = new Set<string>([featureId]);
        for (let next: string | null | undefined = by; typeof next === 'string'; ) {
          if (seen.has(next)) throw new Error(`SUPERSEDE_CYCLE: ${by} is already superseded, directly or not, by ${featureId}.`);
          seen.add(next);
          next = loadState(featurePaths(controlRoot, next).featureDir)?.data.superseded_by;
        }
        // The replacement must be a live, valid feature: never history, never stopped.
        const target = loadState(featurePaths(controlRoot, by).featureDir)?.data;
        const unusable =
          !target
            ? 'it has no STATE.json'
            : typeof target.superseded_by === 'string'
              ? `it is itself superseded by ${target.superseded_by}`
              : target.feature_state === 'CANCELLED'
                ? 'it is cancelled'
                : null;
        const validation = unusable === null ? validateFeatureGraph(controlRoot, by) : null;
        const invalid =
          unusable ??
          (validation && validation.problems.length > 0
            ? `its graph does not validate (${validation.problems.map((p) => p.code).join(', ')})`
            : validation && target && target.graph_hash !== validation.graphHash
              ? 'its graph changed since its STATE.json was created'
              : null);
        if (invalid !== null) {
          throw new Error(`SUPERSEDING_FEATURE_NOT_VIABLE: ${by} cannot replace ${featureId}: ${invalid}.`);
        }
        const current = loadState(paths.featureDir)?.data;
        if (!current) throw new Error(`NO_STATE: ${featureId} has no STATE.json.`);
        if (typeof current.superseded_by === 'string' && current.superseded_by !== by) {
          throw new Error(`ALREADY_SUPERSEDED: ${featureId} is superseded by ${current.superseded_by}.`);
        }
        const busy = [
          ...Object.entries(current.nodes)
            .filter(([, rt]) => rt.claim !== null || IN_FLIGHT_STATES.has(rt.state))
            .map(([id, rt]) => `${id}=${rt.state}`),
          ...Object.entries(leaseStatus(paths.featureDir))
            .filter(([, st]) => st.held > 0)
            .map(([resource]) => `lease ${resource}`),
          ...liveSessions(paths.sessionsRegistry).map((x) => `session ${x.session_id}`),
        ];
        if (busy.length > 0) {
          throw new Error(`FEATURE_NOT_QUIESCENT: ${featureId} still has work in flight (${busy.join(', ')}); settle, reconcile or cancel it first.`);
        }
        // Re-checked under the state lock.
        mutateState(paths.featureDir, (s) => {
          const started = Object.entries(s.nodes).find(([, rt]) => rt.claim !== null || IN_FLIGHT_STATES.has(rt.state));
          if (started) throw new Error(`FEATURE_NOT_QUIESCENT: ${started[0]} started meanwhile.`);
          if (s.feature_state !== 'COMPLETED') s.feature_state = 'CANCELLED';
          s.blocked_reason = `superseded by ${by}: ${reason}`;
          s.superseded_by = by;
          s.superseded_reason = reason;
          s.superseded_at = new Date().toISOString();
          return s;
        });
      }),
    );
    appendEvent(paths.events, {
      idempotency_key: `feature.superseded:${featureId}:${by}`,
      type: 'feature.superseded',
      actor: 'mycelink',
      feature_id: featureId,
      data: { superseded_by: by, reason: reason.slice(0, 500) },
    });
    emit(io, args, { feature_id: featureId, superseded_by: by, idempotent: false }, () => `${featureId} is superseded by ${by}; it is history now.`);
    return 0;
  }

  io.err(`Unknown feature command "${sub}".`);
  return 2;
}

// ---- graph ----------------------------------------------------------------

/**
 * `mycelink feature acceptance <feature> --source <requirement.md> [--kind AC-n=<kind>,...]`:
 * the approved acceptance criteria of a requirement, verbatim, with their
 * kinds, as features/<feature>/ACCEPTANCE.json (engine/acceptance.ts). A
 * structured sidecar beside the requirement (`<requirement>.acceptance.json`)
 * is the manifest, byte for byte, when it matches its source; otherwise every
 * criterion is cut from the requirement's markdown, a new behavior unless
 * `--kind` says otherwise. Fixed once the feature is initialised. Without
 * `--source`, prints the manifest.
 */
function featureAcceptance(args: ParsedArgs, io: CliIo, controlRoot: string, featureId: string): number {
  const paths = featurePaths(controlRoot, featureId);
  const target = join(paths.featureDir, ACCEPTANCE_FILE);
  const show = (written: Buffer, from: string): number => {
    const loaded = loadAcceptanceManifest(controlRoot, featureId);
    if (loaded === null) throw new AcceptanceError('ACCEPTANCE_MISSING', `${featureId} has no ${ACCEPTANCE_FILE}`);
    const { manifest } = loaded;
    emit(io, args, { path: loaded.path, sha256: createHash('sha256').update(written).digest('hex'), from, source: manifest.source, criteria: manifest.criteria }, () =>
      [
        `${loaded.path} (${from}): ${manifest.criteria.map((c) => `${c.id} ${c.kind}`).join(', ')}`,
        'Copy the criteria into the graph exactly (acceptance_criteria: [{id, text, kind}] from this file); never summarise them.',
      ].join('\n'),
    );
    return 0;
  };
  const source = args.flags['source'];
  if (typeof source !== 'string') {
    if (!existsSync(target)) throw new AcceptanceError('ACCEPTANCE_MISSING', `${featureId} has no ${ACCEPTANCE_FILE}; write it with --source <the approved requirement>`);
    return show(readFileSync(target), 'manifest');
  }
  if (loadState(paths.featureDir) !== null) {
    throw new AcceptanceError('ACCEPTANCE_IMMUTABLE', `${featureId} is initialised: its approved criteria are bound (STATE.json); plan a change as a new feature`);
  }
  const sourceFile = resolve(controlRoot, source);
  const sourceRel = relativeInside(controlRoot, sourceFile);
  if (sourceRel === null || !existsSync(sourceFile)) throw new AcceptanceError('ACCEPTANCE_SOURCE_MISSING', `${source} is not a file inside the control repository`);
  const bytes = readFileSync(sourceFile);
  const kinds = new Map<string, string>();
  const flag = args.flags['kind'];
  for (const pair of (typeof flag === 'string' ? flag : '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [id, kind] = pair.split('=');
    if (!id || !kind || !['new-behavior', 'compatibility', 'declaration'].includes(kind)) {
      throw new AcceptanceError('ACCEPTANCE_KIND_INVALID', `--kind ${pair}: name it AC-n=new-behavior|compatibility|declaration`);
    }
    kinds.set(id, kind);
  }
  const sidecar = resolve(controlRoot, sidecarPath(sourceRel));
  mkdirSync(paths.featureDir, { recursive: true });
  if (existsSync(sidecar)) {
    const raw = readFileSync(sidecar);
    let parsed: { criteria?: { id: string; kind: string }[]; source?: { sha256?: string } };
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      throw new AcceptanceError('ACCEPTANCE_MANIFEST_INVALID', `${sidecarPath(sourceRel)} is not JSON: ${(err as Error).message}`);
    }
    const problems = manifestProblems(parsed, { featureId, source: bytes });
    if (problems.length > 0) {
      const stale = parsed.source?.sha256 !== createHash('sha256').update(bytes).digest('hex');
      throw new AcceptanceError(stale ? 'ACCEPTANCE_SOURCE_MISMATCH' : 'ACCEPTANCE_MANIFEST_INVALID', `${sidecarPath(sourceRel)}: ${problems.join('; ')}`);
    }
    for (const [id, kind] of kinds) {
      const approved = (parsed.criteria ?? []).find((c) => c.id === id);
      if (approved === undefined || approved.kind !== kind) {
        throw new AcceptanceError('ACCEPTANCE_KIND_MISMATCH', `${id} is approved as ${approved?.kind ?? 'nothing'} in ${sidecarPath(sourceRel)}, not ${kind}: the approved criteria are not the planner's to change`);
      }
    }
    writeTextAtomic(target, raw.toString('utf8'));
    return show(raw, 'sidecar');
  }
  const criteria = extractAcceptanceCriteria(bytes.toString('utf8'));
  if (criteria.length === 0) throw new AcceptanceError('ACCEPTANCE_NONE', `${sourceRel} names no acceptance criterion (**AC-n ...**, - **AC-n** or ### AC-n)`);
  for (const id of kinds.keys()) {
    if (!criteria.some((c) => c.id === id)) throw new AcceptanceError('ACCEPTANCE_KIND_INVALID', `--kind ${id}: ${sourceRel} has no criterion ${id}`);
  }
  const manifest = buildManifest(featureId, sourceRel, bytes, criteria.map((c) => ({ ...c, kind: kinds.get(c.id) ?? 'new-behavior' })));
  const body = JSON.stringify(manifest, null, 2) + '\n';
  writeTextAtomic(target, body);
  return show(Buffer.from(body, 'utf8'), 'requirement');
}

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
  const sub = requirePositional(args, 1, 'claim|begin|block|verify|finalize|release|invalidate|rework|discard');
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
    case 'rework': {
      assertControllerRole(args, 'node rework');
      // Repair within the same feature: never a follow-up feature id.
      const reason = args.flags['reason'];
      const decision = args.flags['decision'];
      // Comma-separated: the acceptance criteria and evidence the failure points at.
      const list = (name: string): string[] => {
        const v = args.flags[name];
        return typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter((x) => x !== '') : [];
      };
      const report = orchestrator.rework(nodeId, {
        reason: typeof reason === 'string' ? reason : '',
        ...(typeof decision === 'string' ? { decisionId: decision } : {}),
        acceptance: list('acceptance'),
        evidence: list('evidence'),
      });
      emit(io, args, { ...report, next: 'dispatch' }, () =>
        [
          `${report.idempotent ? 'already reworked' : 'reworked'} ${nodeId}: reopened ${report.reopened.join(', ')}`,
          `candidate ${report.invalidated_candidate ?? '(none)'} is no longer current; dispatch again, then cut and deliver a new candidate.`,
        ].join('\n'),
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
    case 'discard': {
      // The holder of the claim's capability gives up a dispatch nothing of which is trusted any more (engine/orchestrator.ts).
      const report = orchestrator.discard(nodeId, presentedCapability(args), flagString(args, 'reason', 'discarded'));
      emit(io, args, report, () => `Discarded ${nodeId}'s dispatch (claim ${report.claim_id}): ${report.state}; branch archived at ${report.archived_ref ?? '(none)'}; the next claim starts afresh.`);
      return 0;
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
  const sub = requirePositional(args, 1, 'spawn|status|stop|reconcile|provider-interrupt|provider-reset');
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
        `abandoned dispatches: ${result.abandoned_dispatches.join(', ') || '(none)'}; interrupted settles: ${result.interrupted_settles.join(', ') || '(none)'}; interrupted controller runs: ${result.interrupted_controller_runs.join(', ') || '(none)'} (the next dispatch runs them again)`,
        ...result.pending_dispatches.map(
          (d) =>
            `pending dispatch ${d.node_id}${d.settlement === 'correction' ? ' (held for its criterion evidence: resume it and give the correction ticket to a module-worker)' : d.result_present ? ' (result written: resume, then settle)' : ''}${d.expired ? ' (expired)' : ''}: mycelink dispatch ${featureId} --resume ${d.node_id} --json`,
        ),
      ].join('\n'),
    );
    return 0;
  }

  if (sub === 'provider-interrupt') {
    // Evidence-bound, not authority-bound: only a lease whose own holder's transcript ended on a transient provider failure
    // is touched (engine/provider-interrupt.ts), so a harness that saw its session exit may ask, and a repeat is a no-op.
    assertControllerRole(args, 'session provider-interrupt');
    const phase = flagString(args, 'phase', 'session');
    const orchestrator = orchestratorFor(controlRoot, featureId);
    const r = orchestrator.providerInterrupt({ phase });
    emit(io, args, r, () =>
      [
        `${r.outcome}: ${r.interrupted.length} lease(s) interrupted by the model provider`,
        ...r.interrupted.map((i) => `  ${i.node_id ?? i.review_id} (${i.kind}, ${i.lease_id}): ${i.failure.class}${i.failure.request_id !== null ? ` ${i.failure.request_id}` : ''} -> ${i.action} (ticket ${i.count.ticket}, phase ${i.count.phase})`),
        ...r.kept.map((k) => `  kept ${k.node_id ?? k.review_id}: ${k.why}`),
        `next: ${r.next_action.kind}`,
      ].join('\n'),
    );
    return 0;
  }

  if (sub === 'provider-reset') {
    const orchestrator = orchestratorFor(controlRoot, featureId);
    const r = orchestrator.providerReset();
    emit(io, args, r, () => (r.cleared ? 'PROVIDER_UNAVAILABLE cleared; the provider counts start again.' : 'Nothing to clear.'));
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
  const sub = requirePositional(args, 1, 'record|validate|migrate|repair');
  const featureId = requirePositional(args, 2, 'feature-id');
  const paths = featurePaths(controlRoot, featureId);

  if (sub === 'repair') {
    // Restore stale evidence pointers from exact archives, administratively (engine/evidence-integrity.ts): nothing is
    // run again, reopened or charged. --dry-run says what it would do and writes nothing.
    assertControllerRole(args, 'evidence repair');
    const dryRun = flagBool(args, 'dry-run');
    const report = repairEvidence(controlRoot, featureId, { dryRun, mark: !dryRun, candidateId: loadState(paths.featureDir)?.data.current_candidate ?? null });
    const ok = !report.required;
    emit(io, args, { ok, ...report }, () =>
      [
        dryRun
          ? `would repair ${report.planned.length} stale evidence pointer(s) from exact archives`
          : `repaired ${report.repaired.length} stale evidence pointer(s) from exact archives`,
        ...(dryRun ? report.planned : report.repaired).map((r) => `  ${r.repair_id} ${r.from_path} -> ${'to_path' in r ? r.to_path : `(from ${r.source.kind} ${r.source.path})`}`),
        ...report.unrepairable.map((u) => `  ${u.live ? 'UNREPAIRED' : 'unrepaired (history)'} ${u.key}: ${u.detail.slice(0, 600)}`),
        report.required
          ? `EVIDENCE_REPAIR_REQUIRED: evidence the delivered state stands on has no exact archive; nothing was rerun or reworked. Restore its exact bytes into the node's archives, or a person decides.`
          : 'no evidence the delivered state stands on is broken',
      ].join('\n'),
    );
    return ok ? 0 : 1;
  }

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
        if (!record && kind === 'red' && provedWithoutRed(runtime)) continue;
        if (!record) problems.push(`MISSING_EVIDENCE: ${kind}`);
        else if (kind !== 'red' && record.exit_code !== 0 && !deferredRegression(record)) {
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
  const phase = requirePositional(args, 1, 'red|green|regression|tests|check|cycle|challenge|capsule');
  const featureId = requirePositional(args, 2, 'feature-id');
  const nodeId = requirePositional(args, 3, 'node-id');
  const paths = featurePaths(controlRoot, featureId);
  const graph = loadGraph(controlRoot, featureId);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node "${nodeId}" is not in the graph.`);

  const doc = loadState(paths.featureDir);
  const runtime = doc?.data.nodes[nodeId];
  if (!runtime) throw new Error(`Node "${nodeId}" has no runtime state.`);
  // Only the holder of the node's current claim may record its gates, or read the tests they ran.
  const capability = presentedCapability(args);
  assertClaimCapability(nodeId, runtime, capability);

  if (phase === 'tests') return tddTests(args, io, controlRoot, featureId, nodeId, runtime.evidence);
  if (phase === 'check') return tddCheck(args, io, controlRoot, featureId, graph, node, runtime);
  if (phase === 'cycle') return tddCycle(args, io, controlRoot, featureId, node, runtime, capability);
  if (phase === 'challenge') return tddChallenge(args, io, controlRoot, featureId, graph, node, runtime);
  if (phase === 'capsule') return tddCapsule(args, io, controlRoot, featureId, nodeId, capability);

  // A submission held for criterion evidence correction is settled code: its gates do not run again, unless the
  // refusal is a new behaviour no RED proved, which a new RED cycle on top of the held commit may prove.
  const held = runtime.claim?.evidence_correction;
  if (held && held.cycle !== true) {
    io.err(
      `${phase} gate refused: EVIDENCE_CORRECTION_PENDING: ${nodeId}'s code, history and gate evidence are recorded and its submission is held only for its criterion evidence (${held.code}). Do not edit, commit or run a gate: write the corrected result (criterion_evidence by test_id) and settle. Nothing was run or recorded.`,
    );
    return 2;
  }

  // A gate that could not move the node is refused before it runs anything:
  // running the verifier anyway records evidence for nothing and, when it
  // fails, counts a failure the gate order caused.
  const gatePending = phase === 'red' ? 'RED_PENDING' : phase === 'green' ? 'GREEN_PENDING' : null;
  const gateVerified =
    phase === 'red' ? 'RED_VERIFIED' : phase === 'green' ? 'GREEN_VERIFIED' : 'REGRESSION_VERIFIED';
  const via = gatePending ?? runtime.state;
  const redMissing = phase === 'green' && redRequired(node, runtime) && runtime.evidence['red'] === undefined;
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
  // A claim bound to a module runs exactly its module's command (red, green)
  // and the repository's full suite (regression): nothing a worker passes
  // replaces either (engine/modules.ts).
  const bound = runtime.claim?.verification;
  if (bound !== undefined && (args.passthrough.length > 0 || typeof args.flags['cwd'] === 'string')) {
    throw new Error(
      `GATE_COMMAND_BOUND: ${nodeId}'s claim binds module ${bound.module} (${bound.module_sha256.slice(0, 12)}): its gates run that module's command at the repository root, and regression the full suite. Run the gate line exactly as given, without -- <command> or --cwd. Nothing was run or recorded.`,
    );
  }
  // An explicit `-- <argv>` from the operator is always argv; a declared
  // verifier may ask for a shell, which the control-repo config must allow.
  let invocation: VerificationInvocation & Partial<ReturnType<typeof moduleInvocation>>;
  if (bound !== undefined) invocation = phase === 'regression' ? { command: [...bound.regression.command] } : moduleInvocation(bound);
  else if (args.passthrough.length > 0) invocation = { command: args.passthrough };
  else if (declared !== undefined && declared.command.length > 0) invocation = verifierInvocation(declared);
  else throw new Error('No command given and the node declares no verifier.');

  const cwd = claimedCwd(runtime.claim?.worktree ?? null, args, controlRoot);

  const repoDecl = node.repository
    ? loadRepositories(controlRoot).repositories.find((r) => r.name === node.repository)
    : undefined;

  // A RED runs the tests alone, on top of committed production code: an
  // independent replay applies the test changes alone, so a RED over
  // production edits proves nothing. The claim's own policy says which
  // paths are tests.
  const worktree = node.repository !== null ? (runtime.claim?.worktree ?? null) : null;
  const policy = node.repository === null ? null : (runtime.claim?.tdd_policy ?? tddPolicyFor(repoDecl));
  if (phase === 'red' && worktree !== null && policy !== null) {
    const { production } = redBinding(worktree, policy, null);
    if (production.length > 0) {
      io.err(
        `red gate refused: RED_NOT_TEST_ONLY: the red gate runs your tests alone, but production files differ from HEAD in the worktree: ${production.slice(0, 20).join(', ')}${production.length > 20 ? ', ...' : ''}. ${RED_NOT_TEST_ONLY_GUIDANCE}`,
      );
      return 2;
    }
  }

  // A worktree whose setup inputs changed (a dependency manifest, a lockfile
  // the node declared) is set up again, with the claim's own setup, before
  // the gate runs anything there (engine/worktree-setup.ts).
  let resetUp: { files: string[]; receipt_sha256: string } | null = null;
  const setupBinding = worktree !== null ? runtime.claim?.worktree_setup : undefined;
  const nowInputs = worktree !== null && setupBinding !== undefined ? setupInputs(worktree, setupBinding.config) : null;
  if (worktree !== null && setupBinding !== undefined && nowInputs !== null && nowInputs.sha256 !== setupBinding.inputs_sha256) {
    const receiptFile = join(controlRoot, setupBinding.receipt_path);
    const before = existsSync(receiptFile) ? (JSON.parse(readFileSync(receiptFile, 'utf8')) as { input_files?: Record<string, string> }).input_files : undefined;
    const files = changedInputs(before, nowInputs.files);
    const workspace = loadWorkspace(controlRoot);
    const run = runWorktreeSetup({
      controlRoot,
      repository: node.repository as string,
      repoPath: repositoryPath(workspace, node.repository as string),
      worktree,
      root: workspace.paths.worktreesDir,
      config: setupBinding.config,
      evidenceDir: nodeEvidenceDir(controlRoot, featureId, nodeId),
      label: `${nodeId.replace(/[^\w.-]/g, '_')}.worktree-setup`,
      ...(bound !== undefined ? { verification: { module: bound.module, module_sha256: bound.module_sha256 } } : {}),
    });
    mutateState(paths.featureDir, (s) => {
      assertClaimCapability(nodeId, s.nodes[nodeId], capability);
      const rt = s.nodes[nodeId];
      if (!rt) return s;
      rt.worktree_setup = run.record;
      if (run.receipt.status === 'complete' && rt.claim) {
        rt.claim.worktree_setup = {
          status: 'complete',
          config: setupBinding.config,
          config_sha256: setupBinding.config_sha256,
          receipt_path: run.receipt_path,
          receipt_sha256: run.receipt_sha256,
          head_sha: run.receipt.head_sha,
          ...(run.receipt.inputs_sha256 !== undefined ? { inputs_sha256: run.receipt.inputs_sha256 } : {}),
        };
      }
      return s;
    });
    appendEvent(paths.events, {
      idempotency_key: `worktree.setup:${nodeId}:${run.receipt_sha256}`,
      type: 'worktree.setup',
      actor: 'mycelink',
      feature_id: featureId,
      node_id: nodeId,
      data: { claim_id: runtime.claim?.claim_id ?? null, purpose: 'inputs-changed', gate: phase, changed: files.slice(0, 20), status: run.receipt.status, code: run.receipt.code, receipt_path: run.receipt_path, receipt_sha256: run.receipt_sha256, output_path: run.receipt.output_path },
    });
    if (run.receipt.status !== 'complete') {
      io.err(
        `${phase} gate refused: WORKTREE_SETUP_FAILED: the worktree setup ran again because its inputs changed (${files.slice(0, 10).join(', ')}) and did not complete: ${run.receipt.code}: ${run.receipt.detail}; log ${run.receipt.output_path}. ` +
          'It installs offline from what is already there: make the changed manifest or lockfile consistent (a dependency between the repository\'s own packages, never an external one), then run the gate again. Nothing was run or recorded.',
      );
      return 2;
    }
    resetUp = { files, receipt_sha256: run.receipt_sha256 };
    // The gate runs with what is on record now.
    if (runtime.claim) runtime.claim.worktree_setup = loadState(paths.featureDir)!.data.nodes[nodeId]!.claim!.worktree_setup!;
  }
  const resetUpNote = resetUp === null ? '' : `; worktree setup ran again: its inputs changed (${resetUp.files.slice(0, 10).join(', ')}), receipt ${resetUp.receipt_sha256.slice(0, 12)}`;

  const kind: EvidenceKind = phase === 'red' ? 'red' : phase === 'green' ? 'green' : 'regression';
  // A RED is judged on the tests its delta declares since the cycle began (engine/tdd-history.ts).
  const redDelta =
    phase === 'red' && worktree !== null && policy !== null
      ? redDeclaredTests(worktree, policy, runtime.claim?.base_sha ?? runtime.branch_base_sha ?? null)
      : null;
  const ran = runVerification({
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
    // Test files of a language Mycelink cannot read leave the declared tests unknown: the output alone decides.
    ...(redDelta !== null ? { redDeclared: redDelta.opaque.length > 0 && redDelta.declared.length === 0 ? null : redDelta.declared } : {}),
  });
  // The gate ran in the claim's worktree, as its setup left it.
  const setupReceipt = worktree !== null ? runtime.claim?.worktree_setup?.receipt_sha256 : undefined;
  const inputsSha = worktree !== null ? runtime.claim?.worktree_setup?.inputs_sha256 : undefined;
  const record: EvidenceRecord = {
    ...ran,
    ...(setupReceipt !== undefined ? { worktree_setup_sha256: setupReceipt } : {}),
    ...(inputsSha !== undefined ? { setup_inputs_sha256: inputsSha } : {}),
  };
  // A full-suite regression that fails only where dependents of this node re-verify passes to them (engine/regression-deferral.ts).
  let deferral: DeferralDecision | null = null;
  if (phase === 'regression' && bound !== undefined && record.exit_code !== 0) {
    deferral = regressionDeferral({ graph, state: loadState(paths.featureDir)!.data, nodeId, output: readFileSync(join(controlRoot, record.output_path), 'utf8'), exitCode: record.exit_code, checkout: cwd });
    if (deferral.deferred) record.regression_deferred = { to: deferral.to, failing: deferral.failing };
  }

  // A generation that needs no RED (a compatibility-only rework) keeps none a refused red gate recorded.
  const noRed = phase === 'red' && !redRequired(node, runtime);
  const priorRed = runtime.evidence.red;
  mutateState(paths.featureDir, (s) => {
    // Re-checked where the evidence lands: the claim may have been released
    // or rotated while the command ran, and then this evidence is not its.
    assertClaimCapability(nodeId, s.nodes[nodeId], capability);
    const rt = s.nodes[nodeId];
    if (rt) rt.evidence[kind] = record;
    if (phase === 'red' && rt?.claim) rt.claim.challenge_red = null;
    return s;
  });

  const pending = phase === 'red' ? 'RED_PENDING' : phase === 'green' ? 'GREEN_PENDING' : null;
  const verified =
    phase === 'red' ? 'RED_VERIFIED' : phase === 'green' ? 'GREEN_VERIFIED' : 'REGRESSION_VERIFIED';

  // The tests the gate ran, by their canonical ids (evidence/test-ids.ts): what criterion evidence names.
  // Shown first: the RED's declared tests, or for green and regression the tests the node's delta declares.
  const gateRan = readGateTests(controlRoot, record);
  const base = runtime.claim?.base_sha ?? runtime.branch_base_sha ?? null;
  const mine = phase === 'red' ? (record.red_declared ?? null) : worktree !== null && policy !== null ? redDeclaredTests(worktree, policy, base, { since: 'base' }).declared : null;
  const shown = gateRan === null ? [] : shownTests(gateRan, mine, 200);
  const testsJson = gateRan === null ? {} : { tests: shown.map((t) => ({ id: t.id, path: t.path, full_name: t.full_name, status: t.status })), tests_total: gateRan.length, tests_results_path: record.results?.path ?? null };
  const testsText =
    gateRan === null
      ? ''
      : [
          '',
          `tests the ${phase} gate ran: ${Math.min(shown.length, 30)} of ${gateRan.length} shown (every test with its test_id: ${record.results?.path}; find any other one with: mycelink tdd tests ${featureId} ${nodeId} --capability <your capability> --match <words>)`,
          ...shown.slice(0, 30).map(testLine),
        ].join('\n');

  // What this RED ran with, bound when (and only when) the gate accepts it, with the ids of the tests it declared.
  const binding = phase === 'red' && worktree !== null && policy !== null ? redBinding(worktree, policy, record.output_sha256).binding : null;
  if (binding !== null && gateRan !== null) {
    binding.red_tests = shownTests(gateRan, record.red_declared ?? [], 64)
      .filter((t) => (record.red_declared ?? []).some((d) => namesDeclared(t, d)))
      .map((t) => ({ id: t.id, path: t.path, full_name: t.full_name, status: t.status, category: t.category, ...(t.identity !== undefined ? { identity: t.identity } : {}) }));
  }

  try {
    mutateState(paths.featureDir, (s) => {
      assertClaimCapability(nodeId, s.nodes[nodeId], capability);
      let next = s;
      if (pending !== null && next.nodes[nodeId]?.state !== pending) {
        next = applyNodeTransition(graph, next, nodeId, pending, { actor: 'mycelink' });
      }
      next = applyNodeTransition(graph, next, nodeId, verified, { actor: 'mycelink' });
      const rt = next.nodes[nodeId];
      if (binding !== null && rt) rt.tdd_red_bindings = [...(rt.tdd_red_bindings ?? []), binding].slice(-64);
      // An accepted RED binds its test files anew: a declared cycle (tdd cycle) ends with it.
      if (binding !== null && rt?.claim) rt.claim.cycle_declared = null;
      return next;
    });
  } catch (err) {
    const transition = err instanceof Error ? err.message : String(err);
    // A RED that proves nothing: say why, in the replay's categories, and what to do instead.
    const invalidRed = phase === 'red' && record.red_reason !== 'behaviour-missing' && record.exit_code !== 0;
    const detail = invalidRed
      ? `RED_INVALID:${record.red_category ?? record.red_reason ?? 'unclassified'}: ${record.red_detail ?? transition}. ${RED_RETRY_GUIDANCE}`
      : deferral !== null && !deferral.deferred
        ? `${transition} REGRESSION_NOT_DEFERRED: ${deferral.reason}; a failure only a dependent's module shows passes to that dependent, any other is this node's to fix.`
        : transition;
    if (noRed) {
      mutateState(paths.featureDir, (s) => {
        const rt = s.nodes[nodeId];
        if (rt?.evidence.red?.output_sha256 === record.output_sha256) {
          if (priorRed === undefined) delete rt.evidence.red;
          else rt.evidence.red = priorRed;
        }
        return s;
      });
    }
    if (record.failure_fingerprint !== null) {
      mutateState(paths.featureDir, (s) =>
        recordFailure(graph, s, nodeId, record.failure_fingerprint as string, { actor: 'mycelink' }),
      );
    }
    // In an acceptance review's rework, a RED whose declared tests all pass on the unchanged base is the material of a
    // review-gap challenge (engine/review-challenge.ts), never a RED to fake (CSET-203 r6): what it ran is kept for it.
    const challenge = phase === 'red' && worktree !== null && binding !== null && gateRan !== null && runtime.rework_brief?.origin?.kind === 'acceptance-review' ? challengeSnapshot(controlRoot, featureId, nodeId, worktree, record, binding, gateRan) : null;
    if (challenge !== null) {
      // Challenge or re-proof material, never the generation's RED (CSET-203 r16): a RED this claim's gate accepted stays the
      // node's; with none, the attested RED of a completion its order carries stands for it (engine/criterion-ledger.ts), so
      // compatibility work beside it runs green and regression as any.
      const keep = noRed ? null : priorRed !== undefined && priorRed.exit_code !== 0 && priorRed.red_reason === 'behaviour-missing' ? priorRed : carriedRedOfOrder(controlRoot, featureId, graph, node, runtime);
      mutateState(paths.featureDir, (s) => {
        assertClaimCapability(nodeId, s.nodes[nodeId], capability);
        const rt = s.nodes[nodeId];
        const c = rt?.claim;
        if (c) {
          c.challenge_red = challenge;
          c.challenge_reds = [...(c.challenge_reds ?? []).filter((x) => x.evidence_sha256 !== challenge.evidence_sha256), challenge].slice(-16);
        }
        if (rt && keep !== null && rt.evidence.red?.output_sha256 === record.output_sha256) rt.evidence.red = keep;
        return s;
      });
    }
    const kindOf = (ac: string): string => graph.acceptance_criteria.find((a) => a.id === ac)?.kind ?? 'new-behavior';
    const ordered = runtime.rework_brief?.acceptance_criteria ?? [];
    const behaviours = ordered.filter((ac) => !['compatibility', 'declaration'].includes(kindOf(ac)));
    const compat = ordered.filter((ac) => kindOf(ac) === 'compatibility');
    // An ordered criterion an earlier generation completed (its completed proof in the pack): a passing reproduction re-proves it.
    const completedNow = runtime.rework_brief == null ? [] : (runtime.carried_criterion_proofs ?? []).filter((p) => p.ordered === true && ordered.includes(p.criterion)).map((p) => p.criterion);
    const challengeNote =
      challenge === null
        ? ''
        : [
            `\nThe tests this RED declares all pass on the unchanged base (${challenge.head_sha.slice(0, 12)}): never change production code for them and never make a test fail on purpose.`,
            completedNow.length > 0
              ? ` ${completedNow.join(', ')} ${completedNow.length === 1 ? 'was' : 'were'} completed by an earlier generation (rework.completed_criteria). If a passing test is exactly the review's reproduction, make a review-gap challenge first: run the challenge line with --criteria <AC>, fill its focused tests and assertion traces, write REVIEW_GAP_CHALLENGE and run the check line; no git restore is required for a challenge because the gate kept its copy and settlement abandons this worktree. Do not call the gap closed until a separate reviewer judges it. A distinct re-proof path may answer DONE only with both the completed proof from rework.completed_criteria and this test's test_id with gate "red" and this gate's sha256 (${record.output_sha256}); keep that test out of the branch without weakening an existing test.`
              : '',
            behaviours.filter((ac) => !completedNow.includes(ac)).length > 0
              ? ` If they are exactly the acceptance review's reproduction of ${behaviours.filter((ac) => !completedNow.includes(ac)).join(', ')}, its gap does not reproduce on this code: that is a review-gap challenge, not a RED to fake — run the challenge line (mycelink tdd challenge ${featureId} ${nodeId} --capability <your capability>, narrowed with --criteria), write outcome REVIEW_GAP_CHALLENGE for it, run the check line.`
              : completedNow.length > 0
                ? ''
                : '',
            compat.length > 0 ? ` A test of ${compat.join(', ')} (compatibility) is its compatibility-regression unit: commit it alone with its trailer, then green and regression.` : '',
            ' If they are not yet exactly the reproduction, make them so and run red again.',
          ].join('');
    // A reproduction this gate could keep nothing of (its tests named by no static title, CSET-203 r17): the capsule seals it.
    const capsuleNote =
      phase === 'red' && challenge === null && runtime.rework_brief?.origin?.kind === 'acceptance-review'
        ? `\nThis red gate kept nothing a review-gap challenge could cite: none of the tests it ran is one your RED declares by a title Mycelink can read (a title a template literal or a loop builds is never read as a declaration). If the test files you wrote are exactly the review's reproduction, seal them without committing them: the capsule line (mycelink tdd capsule ${featureId} ${nodeId} --capability <your capability> --criterion <AC>) runs them on the claim's unchanged base and records each test it ran — passing, it is challenge material (the challenge line with --capsule); failing, it is a RED (commit its exact files test-first, statically named, then the fix). Never change production code for a reproduction that passes.`
        : '';
    io.err(`${phase} gate refused: ${detail} (evidence ${record.output_path} sha256 ${record.output_sha256})${resetUpNote}${challengeNote}${capsuleNote}`);
    emit(io, args, { ok: false, detail, evidence: record, ...testsJson, ...(resetUp !== null ? { worktree_setup_rerun: resetUp } : {}) }, () => testsText.replace(/^\n/, ''));
    return 2;
  }

  // An accepted RED of an acceptance review's rework whose other declared tests passed on the unchanged base (CSET-203
  // r15: AC-3's reproduction failed, AC-4's passed in the same red gate): the passing ones are a per-criterion challenge's
  // material (engine/criterion-outcomes.ts), kept as the gate ran them.
  const partly = phase === 'red' && worktree !== null && binding !== null && gateRan !== null && runtime.rework_brief?.origin?.kind === 'acceptance-review' ? challengeSnapshot(controlRoot, featureId, nodeId, worktree, record, binding, gateRan, { accepted: true }) : null;
  if (partly !== null) {
    mutateState(paths.featureDir, (s) => {
      assertClaimCapability(nodeId, s.nodes[nodeId], capability);
      const c = s.nodes[nodeId]?.claim;
      if (c) c.challenge_reds = [...(c.challenge_reds ?? []).filter((x) => x.evidence_sha256 !== partly.evidence_sha256), partly].slice(-16);
      return s;
    });
  }
  const partlyNote =
    partly === null
      ? ''
      : `\nThis RED's other declared tests passed on the unchanged base (${partly.red_tests.filter((t) => t.status === 'passed').map((t) => t.id).join(', ')}). If they are exactly the acceptance review's reproduction of a criterion of this rework, its gap does not reproduce: change no production code for it and answer it on its own — the challenge line narrowed to it (--criteria <AC>), outcome REVIEW_GAP_CHALLENGE for that criterion in a per-criterion result (schema_version 2, outcome CRITERIA), beside the criteria you prove DONE.`;

  // The files this RED bound, each to stay byte-identical from now on (engine/tdd-history.ts).
  const redBound = binding === null ? [] : binding.tests.filter((t): t is { path: string; blob: string } => t.blob !== null);
  const redBoundText =
    redBound.length === 0
      ? ''
      : [
          '',
          'RED-bound test files: commit exactly these, then never change them after the production change begins. A compatibility test goes into a new test file; a later test in one of them goes in before its red gate, or after `mycelink tdd cycle` declares a new complete RED cycle.',
          ...redBound.map((t) => `  RED-bound ${t.path} ${t.blob}`),
        ].join('\n');
  emit(io, args, { ok: true, state: verified, evidence: record, ...testsJson, ...(redBound.length > 0 ? { red_bound: redBound } : {}), ...(resetUp !== null ? { worktree_setup_rerun: resetUp } : {}) }, () =>
    `${nodeId} -> ${verified} (exit ${record.exit_code}, evidence ${record.output_path} sha256 ${record.output_sha256})` +
      (record.regression_deferred
        ? `; the full suite fails only in ${record.regression_deferred.failing.join(', ')}, deferred to ${record.regression_deferred.to.join(', ')}: they re-verify after this node, and the candidate runs the full suite`
        : '') +
      resetUpNote +
      redBoundText +
      partlyNote +
      testsText,
  );
  return 0;
}

/**
 * `mycelink tdd tests <feature> <node> --capability <c> [--gate red|green|regression] [--match <words>]`:
 * the tests the claim's recorded gates ran, with the canonical ids criterion
 * evidence names them by (evidence/test-ids.ts). Words match the path and
 * the full name, case-insensitively, all of them. Reads only.
 */
function tddTests(args: ParsedArgs, io: CliIo, controlRoot: string, featureId: string, nodeId: string, evidence: Partial<Record<EvidenceKind, EvidenceRecord>>): number {
  const only = typeof args.flags['gate'] === 'string' ? args.flags['gate'] : null;
  if (only !== null && !['red', 'green', 'regression'].includes(only)) throw new Error(`--gate is red, green or regression, not "${only}".`);
  const words = (typeof args.flags['match'] === 'string' ? args.flags['match'] : '').toLowerCase().split(/\s+/).filter(Boolean);
  const found: { id: string; path: string; full_name: string; status: string; gate: string; output_sha256: string }[] = [];
  let total = 0;
  for (const gate of ['red', 'green', 'regression'] as const) {
    if (only !== null && gate !== only) continue;
    const record = evidence[gate];
    const tests = readGateTests(controlRoot, record);
    if (record === undefined || tests === null) continue;
    total += tests.length;
    for (const t of tests) {
      const hay = `${t.path} ${t.full_name}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) found.push({ id: t.id, path: t.path, full_name: t.full_name, status: t.status, gate, output_sha256: record.output_sha256 });
    }
  }
  const shown = found.slice(0, 200);
  emit(io, args, { node_id: nodeId, tests: shown, matched: found.length, total }, () => {
    const lines = [`${found.length} of ${total} test(s) the ${only ?? 'recorded'} gate(s) of ${nodeId} ran match${words.length ? ` "${words.join(' ')}"` : ''}${found.length > 50 ? ' (50 shown: narrow the words)' : ''}`];
    let gate: string | null = null;
    for (const t of shown.slice(0, 50)) {
      if (t.gate !== gate) lines.push(`${(gate = t.gate)} gate (output sha256 ${t.output_sha256}):`);
      lines.push(testLine(t));
    }
    return lines.join('\n');
  });
  return found.length > 0 ? 0 : 1;
}

/**
 * `mycelink tdd check <feature> <node> --capability <c>`: the criterion
 * evidence of the result the worker wrote to its slot, judged exactly as
 * settle will (engine/criteria.ts) at the head of its branch, before it
 * submits (CSET-203 r1's cli worker learnt from settle that AC-4, a new
 * behaviour, mapped to a GREEN test proves nothing). Reads only: the result
 * stays in the slot and nothing is recorded.
 */
function tddCheck(args: ParsedArgs, io: CliIo, controlRoot: string, featureId: string, graph: PortfolioGraph, node: GraphNode, runtime: NodeRuntime): number {
  const claim = runtime.claim;
  const refuse = (code: string, detail: string, extra: Record<string, unknown> = {}): number => {
    emit(io, args, { ok: false, code, detail, ...extra }, () => [`${code}: ${detail}`, ...((extra['candidates'] as { id: string; path: string; full_name: string; status: string; gate: string }[] | undefined) ?? []).map((c) => `${testLine(c)}  [${c.gate}]`)].join('\n'));
    return 1;
  };
  if (claim === null || node.repository === null) return refuse('CHECK_UNAVAILABLE', `${node.id} has no claim with a repository to check`);
  const workspace = loadWorkspace(controlRoot);
  const repoPath = repositoryPath(workspace, node.repository);
  const branch = workerBranchName(featureId, node.id);
  const head = resolveRef(repoPath, branch);
  const slot = join(claim.worktree ?? controlRoot, WORKER_RESULT_DIR, claim.result_file ?? WORKER_RESULT_FILE);
  let result: NodeResult;
  // Read through one descriptor: what is checked is what is read.
  const read = readRegular(slot, MAX_WORKER_RESULT_BYTES);
  if (read === null) {
    if (existsSync(slot) || isLink(slot)) return refuse('RESULT_UNREADABLE', `${slot} is not a regular file under ${MAX_WORKER_RESULT_BYTES} bytes`);
    return refuse('RESULT_MISSING', `write your result to ${slot} first (it does not exist)`);
  }
  try {
    result = JSON.parse(read.bytes.toString('utf8')) as NodeResult;
  } catch (err) {
    return refuse('RESULT_MISSING', `write your result to ${slot} first (${(err as Error).message.split('\n')[0]})`);
  }
  const problems = validateAgainstSchema('node-result', result);
  if (problems.length > 0) return refuse('RESULT_SCHEMA_INVALID', problems.map((p) => p.detail).join('; ').slice(0, 1000));
  // A per-criterion answer: judged exactly as settle will (engine/criterion-outcomes.ts), read-only.
  if (result.outcome === 'CRITERIA') {
    const judged = orchestratorFor(controlRoot, featureId).checkCriteriaAnswer(node.id, result);
    if (!judged.ok) return refuse(judged.code, judged.detail, { criterion: judged.criterion, ...(judged.candidates !== undefined ? { candidates: judged.candidates } : {}), ...(judged.problems !== undefined ? { problems: judged.problems } : {}) });
    emit(io, args, { ok: true, head_sha: judged.head_sha, criteria: judged.criteria, accepted: judged.accepted, ...(judged.challenge_sha256 !== null ? { challenge_sha256: judged.challenge_sha256 } : {}) }, () =>
      [`per-criterion answer: OK at ${judged.head_sha.slice(0, 12)}`, ...judged.criteria.map((c) => `  ${c.criterion} ${c.outcome}`), 'Settle integrates the DONE criteria, records the challenged ones for a fresh reviewer and orders the unresolved ones again.'].join('\n'),
    );
    return 0;
  }
  // A review-gap challenge: judged exactly as settle will (engine/review-challenge.ts), read-only.
  if (result.outcome === 'REVIEW_GAP_CHALLENGE') {
    const judged = orchestratorFor(controlRoot, featureId).judgeChallengeOf(node.id, result);
    if (!judged.ok) return refuse(judged.code, judged.detail, { problems: judged.problems });
    emit(io, args, { ok: true, challenge_sha256: judged.challenge_sha256, review_id: judged.review.review_id, base_sha: judged.base_sha, head_sha: judged.head_sha, tests: judged.tests, gaps: judged.challenge.gaps.map((g) => ({ criterion: g.criterion, clauses: g.clauses.map((c) => c.clause) })) }, () =>
      [`review-gap challenge: OK (${judged.challenge_sha256.slice(0, 12)}) on ${judged.base_sha.slice(0, 12)}`, ...judged.challenge.gaps.map((g) => `  ${g.criterion}: ${g.tests.length} focused test(s), clauses ${g.clauses.map((c) => c.clause).join(', ')}`), 'Write nothing more: settle records it, restores the generation the rework replaced and hands the gap to a fresh reviewer.'].join('\n'),
    );
    return 0;
  }
  if (result.commit_sha !== head) return refuse('TDD_CLAIM_MISMATCH', `the result's commit_sha ${String(result.commit_sha).slice(0, 12)} is not the head of ${branch}, ${head.slice(0, 12)}; a submission names exactly the commit it submits`);
  // A held submission resubmitted at the held commit is judged with exactly the evidence it was held with.
  const hold = claim.evidence_correction;
  const judgedRuntime = hold?.held && head === hold.commit_sha ? { ...runtime, evidence: hold.held.evidence, tdd_red_bindings: (runtime.tdd_red_bindings ?? []).slice(0, hold.held.bindings) } : runtime;
  const repoDecl = workspace.repositories.repositories.find((r) => r.name === node.repository);
  const policy = claim.tdd_policy ?? tddPolicyFor(repoDecl);
  // The history settle will judge, with the result's own tdd claim (read here, recorded nowhere): a refusal settle would
  // charge as an attempt is said now; its compatibility-regression units' tests are bound to their criteria's evidence.
  const base = claim.base_sha ?? runtime.branch_base_sha ?? null;
  const history =
    base === null
      ? null
      : verifyTddHistory({
          repoPath,
          base,
          head,
          policy,
          bindings: judgedRuntime.tdd_red_bindings ?? [],
          requireRed: node.required_evidence.includes('red'),
          declarationsOnly: !node.required_evidence.includes('red') && node.node_type !== 'refactor',
          compatibility: { criteria: (node.acceptance_criteria ?? []).filter((ac) => criterionKind(graph, ac) === 'compatibility') },
          claimed: result.tdd ?? null,
        });
  if (history !== null && !history.ok && history.violation !== null) {
    // Refused only because a capsule's files were committed as a RED no static title declares (CSET-203 r17): its path.
    const k = orchestratorFor(controlRoot, featureId).capsuleOfHistory(node.id, history);
    if (k !== null) return refuse('CRITERION_CAPSULE_PATH', capsulePathDetail(k, k.criterion, `${history.violation.code}: ${history.violation.detail}`), { capsule_id: k.capsule_id, history: true });
    return refuse(history.violation.code, history.violation.detail, { commit: history.violation.commit, ...(history.violation.paths !== undefined ? { paths: history.violation.paths } : {}), history: true });
  }
  const compatibility = history?.compatibility ?? [];
  const judged = judgeCriteria({
    controlRoot,
    featureId,
    graph,
    node,
    runtime: judgedRuntime,
    evidence: result.criterion_evidence,
    repoPath,
    head,
    policy,
    modulePath: claim.verification?.path ?? null,
    compatibility,
  });
  if (!judged.ok) {
    const kind = judged.criterion !== null && graph.acceptance_criteria.some((a) => a.id === judged.criterion) ? criterionKind(graph, judged.criterion) : null;
    return refuse(judged.code, judged.detail, { criterion: judged.criterion, kind, required_gate: kind === null ? null : requiredGate(kind, !node.required_evidence.includes('red')), candidates: judged.candidates });
  }
  emit(io, args, { ok: true, head_sha: head, criteria: judged.accepted }, () =>
    [`criterion evidence: OK at ${head.slice(0, 12)}`, ...judged.accepted.map((a) => `  ${a.criterion} ${a.gate} ${a.test_id ?? '(no test)'}${a.identity != null && a.test !== null && a.identity.key !== a.test.name ? ` (${a.identity.key})` : ''}`)].join('\n'),
  );
  return 0;
}


/**
 * What a red gate of an acceptance review's rework ran, when every test its
 * RED declared passed on the unchanged base: the material of a review-gap
 * challenge. The declared test files are copied (as they ran) under the
 * node's evidence, with their blobs and the tests by canonical id. Null when
 * the RED is no such run.
 */
/**
 * The attested RED of a completion a rework's order carries (engine/criterion-ledger.ts), its re-provable completions
 * first: what a generation that runs no RED of its own stands on (CSET-203 r16). Null when its order carries none.
 */
function carriedRedOfOrder(controlRoot: string, featureId: string, graph: PortfolioGraph, node: GraphNode, runtime: NodeRuntime): EvidenceRecord | null {
  const proofs = runtime.carried_criterion_proofs ?? [];
  if (runtime.rework_brief == null || proofs.length === 0 || node.repository === null) return null;
  const workspace = loadWorkspace(controlRoot);
  const ledger = ledgerOf({ controlRoot, featureId, graph, node, runtime, repoPath: repositoryPath(workspace, node.repository), policy: runtime.claim?.tdd_policy ?? null });
  const ids = [...proofs.filter((p) => p.ordered === true), ...proofs.filter((p) => p.ordered !== true)].map((p) => p.record_id).filter((x): x is string => typeof x === 'string');
  return carriedRed(controlRoot, featureId, ledger, ids);
}

function challengeSnapshot(controlRoot: string, featureId: string, nodeId: string, worktree: string, record: EvidenceRecord, binding: { head_sha: string; tests: { path: string; blob: string | null }[] }, gateRan: ReturnType<typeof readGateTests>, options: { accepted?: boolean } = {}): ChallengeRedSnapshot | null {
  const declared = record.red_declared ?? [];
  const accepted = options.accepted === true;
  if (declared.length === 0 || gateRan === null) return null;
  if (!accepted && (record.exit_code !== 0 || record.red_category !== 'passed')) return null;
  const red = shownTests(gateRan, declared, 64).filter((t) => declared.some((d) => namesDeclared(t, d)));
  // Refused: every declared test passed. Accepted (a RED): at least one declared test passed beside the failing ones.
  if (red.length === 0 || (accepted ? !red.some((t) => t.status === 'passed') : red.some((t) => t.status !== 'passed'))) return null;
  // What the snapshot keeps: each declared test file as it ran, and the gate's output and results exactly as recorded.
  const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const planned: { at: string[]; bytes: Buffer; test?: { path: string; blob: string } }[] = [];
  let total = 0;
  for (const t of binding.tests) {
    if (t.blob === null) continue;
    const bytes = readFileSync(join(worktree, ...t.path.split('/')));
    total += bytes.length;
    if (total > 8 * 1024 * 1024) return null;
    planned.push({ at: ['files', ...t.path.split('/')], bytes, test: { path: t.path, blob: t.blob } });
  }
  const gateBytes = (rel: string, want: string): Buffer | null => {
    const src = join(controlRoot, ...rel.split('/'));
    if (!existsSync(src)) return null;
    const bytes = readFileSync(src);
    return sha(bytes) === want ? bytes : null;
  };
  const outputBytes = gateBytes(record.output_path, record.output_sha256);
  const resultsBytes = record.results ? gateBytes(record.results.path, record.results.sha256) : null;
  if (outputBytes !== null) planned.push({ at: ['gate', 'red.log'], bytes: outputBytes });
  if (resultsBytes !== null) planned.push({ at: ['gate', 'red.results.json'], bytes: resultsBytes });
  // Written once, never over anything (evidence/store.ts): the gate's own directory, or — when another snapshot with
  // other bytes holds it — the next free one beside it.
  const root = join(nodeEvidenceDir(controlRoot, featureId, nodeId), 'challenge-red');
  const name = record.output_sha256.slice(0, 16);
  let dir: string | null = null;
  for (let n = 0; n <= 16 && dir === null; n++) {
    const candidate = join(root, n === 0 ? name : `${name}-${n}`);
    if (planned.every((p) => artifactAt(join(candidate, ...p.at), sha(p.bytes)) !== 'other')) dir = candidate;
  }
  if (dir === null) return null;
  for (const p of planned) {
    const target = join(dir, ...p.at);
    if (artifactAt(target, sha(p.bytes)) === 'same') continue;
    mkdirSync(dirname(target), { recursive: true });
    if (createExclusive(target, p.bytes) === 'exists' && artifactAt(target, sha(p.bytes)) !== 'same') return null;
  }
  const rel = (at: string[]): string => (relativeInside(controlRoot, join(dir as string, ...at)) ?? join(dir as string, ...at)).replace(/\\/g, '/');
  const files: ChallengeRedSnapshot['files'] = planned.filter((p) => p.test !== undefined).map((p) => ({ path: (p.test as { path: string }).path, blob: (p.test as { blob: string }).blob, copy: rel(p.at), sha256: sha(p.bytes) }));
  const output = outputBytes === null ? null : { path: rel(['gate', 'red.log']), sha256: record.output_sha256 };
  const results = resultsBytes === null || !record.results ? null : { path: rel(['gate', 'red.results.json']), sha256: record.results.sha256 };
  return {
    evidence_sha256: record.output_sha256,
    head_sha: binding.head_sha,
    tests: binding.tests.map((t) => ({ ...t })),
    red_tests: red.map((t) => ({ id: t.id, path: t.path, full_name: t.full_name, status: t.status })),
    files,
    recorded_at: new Date().toISOString(),
    ...(accepted ? { accepted: true } : {}),
    ...(output !== null && output.sha256 === record.output_sha256
      ? { gate: { output_path: output.path, output_sha256: output.sha256, results_path: results?.path ?? null, results_sha256: results?.sha256 ?? null, exit_code: record.exit_code, commit_sha: record.commit_sha, red_category: record.red_category ?? null, module_sha256: record.module_sha256 ?? null, plan_sha256: record.plan_sha256 ?? null } }
      : {}),
  };
}

/**
 * `mycelink tdd challenge <feature> <node> --capability <c>`: what a
 * review-gap challenge of this claim binds (engine/review-challenge.ts),
 * read-only — the review and the rework's exact reason, each gap's criterion
 * and the SHA-256 of its exact reproduction (with the text and the
 * criterion's clauses), the base, the red gate's output whose declared tests
 * all passed and those tests by id. The worker traces each challenged clause
 * to its assertion lines, explains, writes it as outcome
 * REVIEW_GAP_CHALLENGE and runs the check line.
 */
function tddChallenge(args: ParsedArgs, io: CliIo, controlRoot: string, featureId: string, graph: PortfolioGraph, node: GraphNode, runtime: NodeRuntime): number {
  const refuse = (code: string, detail: string): number => {
    emit(io, args, { ok: false, code, detail }, () => `${code}: ${detail}`);
    return 1;
  };
  const claim = runtime.claim;
  const brief = runtime.rework_brief ?? null;
  if (claim === null || node.repository === null) return refuse('CHALLENGE_UNAVAILABLE', `${node.id} has no claim with a repository`);
  if (brief === null || brief.origin?.kind !== 'acceptance-review') return refuse('REVIEW_CHALLENGE_NOT_REVIEW_REWORK', `${node.id} is not in an acceptance review's rework: only a review's gap is challenged`);
  // The claim's last red gate whose declared tests all passed (a challenge of the whole order) — else the last of its red
  // gates that passed a declared test beside failing ones (a per-criterion challenge, engine/criterion-outcomes.ts).
  const red = runtime.evidence.red;
  const whole = claim.challenge_red ?? null;
  const named = typeof args.flags['criteria'] === 'string' ? String(args.flags['criteria']).split(',').map((x) => x.trim()).filter((x) => x !== '') : null;
  // Reproduction capsules (engine/reproduction-capsule.ts; CSET-203 r17): named, or — no red gate kept challenge
  // material — every current passing capsule of an ordered criterion.
  const capsuleIds = typeof args.flags['capsule'] === 'string' ? String(args.flags['capsule']).split(',').map((x) => x.trim()).filter((x) => x !== '') : null;
  const passingCapsules = (): string[] =>
    (claim.capsules ?? []).filter((e) => e.result === 'passed' && (named === null || named.includes(e.criterion)) && capsuleUse({ controlRoot, featureId, nodeId: node.id, runtime, capsuleId: e.capsule_id, capsuleSha256: e.capsule_sha256, criterion: null, want: 'passed' }).ok).map((e) => e.capsule_id);
  const hasSnapshot = whole !== null || (claim.challenge_reds ?? []).some((x) => x.red_tests.some((t) => t.status === 'passed'));
  if (capsuleIds !== null || (!hasSnapshot && passingCapsules().length > 0)) return tddCapsuleChallenge(args, io, controlRoot, featureId, graph, node, runtime, capsuleIds ?? passingCapsules(), named);
  const snapshot =
    named === null && whole !== null && red !== undefined && red.output_sha256 === whole.evidence_sha256
      ? whole
      : ([...(claim.challenge_reds ?? [])].reverse().find((x) => x.red_tests.some((t) => t.status === 'passed')) ?? null);
  if (snapshot === null) {
    return refuse('REVIEW_CHALLENGE_GATE_UNKNOWN', 'no red gate of this claim passed a test it declared: write the exact focused test of the review\'s reproduction, run the red gate, and run this line again; a challenge cites that output — or, when the gate names none of its tests (a title built by a template literal or a loop) or you keep it out of the branch, seal it as a capsule (mycelink tdd capsule ... --criterion <AC>) and run this line with --capsule <CAP-id>');
  }
  const unknown = (named ?? []).filter((ac) => !brief.acceptance_criteria.includes(ac));
  if (unknown.length > 0) return refuse('REVIEW_CHALLENGE_CRITERION', `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ordered by this rework (${brief.acceptance_criteria.join(', ')})`);
  const record = [...(loadState(featurePaths(controlRoot, featureId).featureDir)?.data.acceptance_review?.reviews ?? [])].reverse().find((r) => r.review_id === brief.origin?.review_id);
  let gaps: Gap[] = [];
  try {
    gaps = record === undefined ? [] : ((JSON.parse(readFileSync(join(controlRoot, ...record.receipt_path.split('/')), 'utf8')) as { gaps?: Gap[] }).gaps ?? []);
  } catch {
    gaps = [];
  }
  const texts = reviewCriteria(controlRoot, featureId, graph);
  const criteria = brief.acceptance_criteria.filter((ac) => criterionKind(graph, ac) === 'new-behavior' && (named === null || named.includes(ac)));
  const passed = snapshot.red_tests.filter((t) => t.status === 'passed');
  const failed = snapshot.red_tests.filter((t) => t.status === 'failed');
  const challenge = {
    review_id: brief.origin.review_id,
    reason_sha256: brief.reason_sha256,
    base_sha: claim.base_sha ?? runtime.branch_base_sha ?? '',
    gate_output_sha256: snapshot.evidence_sha256,
    gaps: criteria.map((ac) => {
      const gap = gaps.find((g) => g.criterion === ac);
      return { criterion: ac, reproduction_sha256: brief.review_gaps?.find((g) => g.criterion === ac)?.reproduction_sha256 ?? (gap !== undefined ? reproductionSha256(gap.reproduction) : ''), tests: passed.map((t) => t.id), clauses: [] as unknown[], explanation: '' };
    }),
  };
  const described = criteria.map((ac) => {
    const gap = gaps.find((g) => g.criterion === ac);
    const text = texts.find((t) => t.id === ac)?.text ?? '';
    return { id: ac, missing: gap?.missing ?? null, reproduction: gap?.reproduction ?? null, clauses: criterionClauses(ac, text) };
  });
  const partial = snapshot.accepted === true;
  emit(io, args, { ok: true, node_id: node.id, repository: node.repository, challenge, criteria: described, tests: passed, ...(partial ? { failed, per_criterion: true } : {}), files: snapshot.files.map((f) => ({ path: f.path, blob: f.blob })) }, () =>
    [
      `review-gap challenge of ${challenge.review_id} by ${node.id}: base ${challenge.base_sha.slice(0, 12)}, red gate ${challenge.gate_output_sha256}`,
      ...described.map((c) => `  ${c.id}: reproduction sha256 ${challenge.gaps.find((g) => g.criterion === c.id)?.reproduction_sha256 ?? ''}; clauses ${c.clauses.map((x) => x.id).join(', ')}`),
      'passing focused tests:',
      ...passed.map(testLine),
      ...(partial
        ? [
            'tests this red gate failed (a RED: their criteria are proved DONE by it and their fix, never challenged):',
            ...failed.map(testLine),
            'Keep in each gap only a criterion whose reproduction passed (narrow with --criteria). Fill in its tests, clauses and explanation; write a per-criterion result: schema_version 2, outcome CRITERIA, criteria (every ordered criterion once: DONE, REVIEW_GAP_CHALLENGE or BLOCKED/NEEDS_DECISION with its reason), criterion_evidence for the DONE ones, and this challenge; then run the check line.',
          ]
        : ['Fill in each gap: tests (the focused tests of its reproduction), clauses ({"clause", "test_id", "assertions": ["file:<repository>:<path>#L<a>-L<b>"], "trace"} for each clause the reproduction proves, its assertion lines inside that test), explanation. Write the result with outcome REVIEW_GAP_CHALLENGE and this challenge, then run the check line.']),
    ].join('\n'),
  );
  return 0;
}

/**
 * `mycelink tdd capsule <feature> <node> --capability <c> --criterion <AC> [--files <p,..>] [--carry <CAP-id>]`: seal the
 * exact focused reproduction of a review gap the worktree holds, uncommitted (engine/reproduction-capsule.ts; CSET-203
 * r17). The controller runs it on a throwaway checkout of the claim's unchanged base and archives it; nothing of the
 * product changes. Refused: exit 2, nothing recorded.
 */
function tddCapsule(args: ParsedArgs, io: CliIo, controlRoot: string, featureId: string, nodeId: string, capability: string | undefined): number {
  const criterion = typeof args.flags['criterion'] === 'string' ? String(args.flags['criterion']).trim() : '';
  const fail = (code: string, detail: string): number => {
    emit(io, args, { ok: false, code, detail }, () => `capsule refused: ${code}: ${detail} Nothing was sealed.`);
    return 2;
  };
  if (criterion === '') return fail('CAPSULE_CRITERION', 'name the one criterion whose review gap it reproduces: --criterion <AC>');
  const files = typeof args.flags['files'] === 'string' ? String(args.flags['files']).split(',').map((x) => x.trim()).filter((x) => x !== '') : null;
  const carry = typeof args.flags['carry'] === 'string' ? String(args.flags['carry']).trim() : null;
  const made = orchestratorFor(controlRoot, featureId).registerCapsule(nodeId, capability, { criterion, files, carry });
  if (!made.ok) return fail(made.code, made.detail);
  emit(io, args, made, () =>
    [
      `capsule ${made.capsule_id} (sha256 ${made.capsule_sha256}): ${made.criterion} ${made.result.toUpperCase()} on the unchanged base ${made.base_sha.slice(0, 12)}${made.idempotent ? ' (sealed before: nothing ran again)' : ''}${made.carried_from !== null ? `, carried from ${made.carried_from.capsule_id}` : ''}`,
      ...made.tests.map((t) => testLine(t)),
      `artifact: ${made.artifact_path}`,
      made.detail,
    ].join('\n'),
  );
  return 0;
}

/** The challenge line over reproduction capsules: each capsule's criterion a gap, its passing tests the gap's focused tests. */
function tddCapsuleChallenge(args: ParsedArgs, io: CliIo, controlRoot: string, featureId: string, graph: PortfolioGraph, node: GraphNode, runtime: NodeRuntime, ids: string[], named: string[] | null): number {
  const refuse = (code: string, detail: string): number => {
    emit(io, args, { ok: false, code, detail }, () => `${code}: ${detail}`);
    return 1;
  };
  const brief = runtime.rework_brief as NonNullable<NodeRuntime['rework_brief']>;
  const claim = runtime.claim as NonNullable<NodeRuntime['claim']>;
  if (ids.length === 0) return refuse('REVIEW_CHALLENGE_GATE_UNKNOWN', 'no current passing capsule of this claim: seal the exact reproduction (tdd capsule --criterion <AC>) first');
  const used: Extract<ReturnType<typeof capsuleUse>, { ok: true }>[] = [];
  for (const id of ids) {
    const u = capsuleUse({ controlRoot, featureId, nodeId: node.id, runtime, capsuleId: id, capsuleSha256: null, criterion: null, want: 'passed' });
    if (!u.ok) return refuse(u.code, u.detail);
    if (named !== null && !named.includes(u.capsule.criterion)) return refuse('CAPSULE_CRITERION', `${id} was sealed for ${u.capsule.criterion}, not ${named.join(', ')}: a capsule reproduces one criterion's gap`);
    if (used.some((x) => x.capsule.criterion === u.capsule.criterion)) return refuse('CAPSULE_CRITERION', `two capsules cite ${u.capsule.criterion}: one gap, one reproduction`);
    used.push(u);
  }
  const record = [...(loadState(featurePaths(controlRoot, featureId).featureDir)?.data.acceptance_review?.reviews ?? [])].reverse().find((r) => r.review_id === brief.origin?.review_id);
  let gaps: Gap[] = [];
  try {
    gaps = record === undefined ? [] : ((JSON.parse(readFileSync(join(controlRoot, ...record.receipt_path.split('/')), 'utf8')) as { gaps?: Gap[] }).gaps ?? []);
  } catch {
    gaps = [];
  }
  const texts = reviewCriteria(controlRoot, featureId, graph);
  const passed = used.flatMap((u) => u.capsule.tests.filter((t) => t.status === 'passed').map((t) => ({ id: t.id, path: t.path, full_name: t.full_name, status: t.status, capsule_id: u.capsule.capsule_id })));
  const challenge = {
    review_id: brief.origin?.review_id ?? '',
    reason_sha256: brief.reason_sha256,
    base_sha: claim.base_sha ?? runtime.branch_base_sha ?? '',
    gate_output_sha256: null,
    gaps: used.map((u) => ({
      criterion: u.capsule.criterion,
      reproduction_sha256: u.capsule.order.reproduction_sha256,
      capsule: { capsule_id: u.capsule.capsule_id, capsule_sha256: u.capsule_sha256 },
      tests: u.capsule.tests.filter((t) => t.status === 'passed').map((t) => t.id),
      clauses: [] as unknown[],
      explanation: '',
    })),
  };
  const described = used.map((u) => {
    const gap = gaps.find((g) => g.criterion === u.capsule.criterion);
    return { id: u.capsule.criterion, missing: gap?.missing ?? null, reproduction: gap?.reproduction ?? null, clauses: criterionClauses(u.capsule.criterion, texts.find((t) => t.id === u.capsule.criterion)?.text ?? '') };
  });
  const others = brief.acceptance_criteria.filter((ac) => !used.some((u) => u.capsule.criterion === ac));
  const capsules = used.map((u) => ({ capsule_id: u.capsule.capsule_id, capsule_sha256: u.capsule_sha256, criterion: u.capsule.criterion, artifact: join(controlRoot, ...u.capsule.artifact.path.split('/')).replace(/\\/g, '/'), tests: u.capsule.tests.map((t) => ({ id: t.id, status: t.status, full_name: t.full_name, block: t.block })) }));
  emit(io, args, { ok: true, node_id: node.id, repository: node.repository, challenge, criteria: described, tests: passed, capsules, files: used.flatMap((u) => u.capsule.files.map((f) => ({ path: f.path, blob: f.blob }))), ...(others.length > 0 ? { per_criterion: true, other_criteria: others } : {}) }, () =>
    [
      `review-gap challenge of ${challenge.review_id} by ${node.id}: base ${challenge.base_sha.slice(0, 12)}, reproduction capsules ${used.map((u) => u.capsule.capsule_id).join(', ')}`,
      ...described.map((c) => `  ${c.id}: reproduction sha256 ${challenge.gaps.find((g) => g.criterion === c.id)?.reproduction_sha256 ?? ''}; clauses ${c.clauses.map((x) => x.id).join(', ')}`),
      'passing focused tests (each capsule\'s, as its run on the unchanged base reported them):',
      ...passed.map(testLine),
      ...capsules.map((k) => `  ${k.capsule_id} source and test blocks: ${k.artifact}`),
      'Fill in each gap: tests, clauses ({"clause", "test_id", "assertions": ["file:<repository>:<path>#L<a>-L<b>"], "trace"}: lines inside the test\'s block of the capsule\'s file), explanation. Keep "capsule" and "gate_output_sha256": null as given. Write outcome REVIEW_GAP_CHALLENGE (or, beside DONE criteria, a per-criterion answer), keep the files out of the branch, then run the check line.',
      ...(others.length > 0 ? [`This order also names ${others.join(', ')}: answer each on its own (schema_version 2, outcome CRITERIA).`] : []),
    ].join('\n'),
  );
  return 0;
}

/** `mycelink capsule verify <feature> [--node <id>] [--capsule <CAP-id>] [--replay]` (controller): every capsule checked; --replay runs the cited ones again. */
function capsuleGroup(args: ParsedArgs, io: CliIo): number {
  const sub = requirePositional(args, 1, 'verify');
  if (sub !== 'verify') throw new Error(`Unknown capsule command "${sub}".`);
  const controlRoot = resolveControlRoot(args);
  const featureId = requirePositional(args, 2, 'feature-id');
  const checked = orchestratorFor(controlRoot, featureId).verifyCapsules({
    replay: flagBool(args, 'replay'),
    nodeId: typeof args.flags['node'] === 'string' ? String(args.flags['node']) : null,
    capsuleId: typeof args.flags['capsule'] === 'string' ? String(args.flags['capsule']) : null,
  });
  emit(io, args, checked, () =>
    [
      `capsules of ${featureId}: ${checked.ok ? 'OK' : 'NOT OK'} (${checked.capsules.length})`,
      ...checked.capsules.map((c) => `  ${c.capsule_id} ${c.node_id} ${c.ok ? 'ok' : 'NOT OK'}${c.cited_by.length > 0 ? ` cited by ${c.cited_by.join(', ')}` : ''}${c.replay !== null ? `; replay on ${c.replay.base.sha.slice(0, 12)}: ${c.replay.base.detail}${c.replay.head !== null ? `; on ${c.replay.head.sha.slice(0, 12)}: ${c.replay.head.detail}` : ''}` : ''}${c.problems.length > 0 ? `: ${c.problems.join('; ')}` : ''}`),
    ].join('\n'),
  );
  return checked.ok ? 0 : 1;
}

/**
 * `mycelink tdd cycle <feature> <node> --capability <c>`: declare a new
 * complete RED cycle after production began. A RED-bound test file stays
 * byte-identical from its RED on (engine/tdd-history.ts), and the plugin's
 * fence refuses a module-worker's edit of one once production began; a new
 * test that belongs in such a file is a new cycle: this declaration lets the
 * file change for that cycle's RED, and the RED the red gate accepts next
 * binds it anew and ends the declaration. Settle still judges the whole
 * history. Before production began nothing needs declaring: the RED's tests
 * may change, and the red gate runs again.
 */
function tddCycle(args: ParsedArgs, io: CliIo, controlRoot: string, featureId: string, node: GraphNode, runtime: NodeRuntime, capability: string | undefined): number {
  const refuse = (code: string, detail: string): number => {
    io.err(`tdd cycle refused: ${code}: ${detail} Nothing was recorded.`);
    if (flagBool(args, 'json')) io.out(JSON.stringify({ ok: false, code, detail }, null, 2));
    return 2;
  };
  const claim = runtime.claim;
  const worktree = node.repository !== null ? (claim?.worktree ?? null) : null;
  if (claim === null || worktree === null) return refuse('CYCLE_UNAVAILABLE', `${node.id} has no claim with a worktree.`);
  if (claim.evidence_correction && claim.evidence_correction.cycle !== true) {
    return refuse('EVIDENCE_CORRECTION_PENDING', `${node.id}'s submission is held only for its criterion evidence (${claim.evidence_correction.code}); write the corrected result and settle.`);
  }
  const repoDecl = loadRepositories(controlRoot).repositories.find((r) => r.name === node.repository);
  const policy = claim.tdd_policy ?? tddPolicyFor(repoDecl);
  const bindings = runtime.tdd_red_bindings ?? [];
  const bound = redBoundFiles(bindings);
  const latest = bindings[bindings.length - 1];
  if (bound.length === 0 || latest === undefined) {
    return refuse('CYCLE_NOT_NEEDED', `no RED of this claim bound a test file yet: write the failing tests and run the red gate.`);
  }
  const production = productionSince(worktree, policy, latest.head_sha);
  if (production.length === 0) {
    return refuse('CYCLE_NOT_NEEDED', `no production change since the last RED (on ${latest.head_sha.slice(0, 12)}): its tests may still change; run the red gate again after changing them.`);
  }
  const head = resolveRef(worktree, 'HEAD');
  const declared = { head_sha: head, at: new Date().toISOString() };
  const paths = featurePaths(controlRoot, featureId);
  mutateState(paths.featureDir, (s) => {
    assertClaimCapability(node.id, s.nodes[node.id], capability);
    const c = s.nodes[node.id]?.claim;
    if (c) c.cycle_declared = c.cycle_declared ?? declared;
    return s;
  });
  appendEvent(paths.events, {
    idempotency_key: `tdd.cycle_declared:${node.id}:${claim.claim_id}:${head}`,
    type: 'tdd.cycle_declared',
    actor: 'mycelink',
    feature_id: featureId,
    node_id: node.id,
    data: { claim_id: claim.claim_id, head_sha: head, red_bound: bound.map((t) => t.path).slice(0, 20) },
  });
  emit(io, args, { ok: true, cycle_declared: declared, red_bound: bound }, () =>
    `${node.id}: a new complete RED cycle declared at ${head.slice(0, 12)}. The RED-bound files (${bound.map((t) => t.path).join(', ')}) may change for its RED: write its failing tests, run the red gate, commit them alone, then the production change it drives.`,
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
    const repoPath = repositoryPath(workspace, node.repository);
    // Like a claim, a new branch starts where the feature's integration is.
    const integration = integrationBranchName(featureId);
    const created = createWorkerWorktree({
      repoPath,
      featureId,
      nodeId,
      baseBranch: repoDecl?.base_branch ?? 'main',
      worktreeRoot: workspace.paths.worktreesDir,
      repositoryName: node.repository,
      ...(runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${integration}`], { allowFail: true }).exitCode === 0
        ? { startPoint: integration }
        : {}),
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
    // The same road as a settle: only from the head the controller recorded,
    // journaled before the branch moves.
    const result = orchestratorFor(controlRoot, featureId).integrateNode(nodeId);
    if (result === null) throw new Error(`Node "${nodeId}" has no repository.`);
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

  // A candidate binds every registered repository (see engine/portfolio.ts).
  const repoRefs = portfolioRefs(workspace, featureId);

  if (sub === 'create') {
    assertControllerRole(args, 'candidate create');
    // Checked, bound and made current under the feature's delivery lock:
    // never in the middle of a delivery, a rework or a supersede, and the
    // work it binds is judged once the lock is held.
    const manifest = withFeatureLock(
      paths.featureDir,
      'candidate create',
      () => {
        const graph = loadGraph(controlRoot, featureId);
        const state = loadState(paths.featureDir)?.data;
        if (!state) throw new Error(`NO_STATE: ${featureId} has no STATE.json.`);
        const unfinished = Object.entries(state.nodes)
          .filter(([id, rt]) => {
            const type = graph.nodes.find((n) => n.id === id)?.node_type;
            if (type === 'candidate-build' || type === 'e2e-scenario') return false;
            return rt.state !== 'DONE' && rt.state !== 'EXCLUDED';
          })
          .map(([id, rt]) => `${id}=${rt.state}`);
        if (unfinished.length > 0) {
          throw new Error(`NODES_NOT_DONE: a candidate binds finished work only; not done: ${unfinished.join(', ')}`);
        }
        // Never a candidate before an acceptance review PASS bound to exactly what it binds (engine/acceptance-review.ts),
        // nor on a review lineage whose revisions were changed outside Mycelink (engine/review-revision.ts).
        const reviewedState = loadState(paths.featureDir)?.data;
        const unreviewed = [...reviewGateProblems(controlRoot, featureId), ...(reviewedState ? reviewRevisionProblems(controlRoot, reviewedState) : [])];
        if (unreviewed.length > 0) throw new Error(unreviewed.join('; '));
        const contracts = existsSync(workspace.paths.contractsDir)
          ? readdirSync(workspace.paths.contractsDir)
              .filter((f) => !f.startsWith('.'))
              .map((f) => `contracts/${f}`)
          : [];
        const cut = createCandidate({
          controlRepo: controlRoot,
          featureDir: paths.featureDir,
          featureId,
          // Only integration branches exactly where the controller left them.
          repositories: portfolioRefs(workspace, featureId, { create: true, trust: { graph, state } }),
          contracts,
        });
        mutateState(paths.featureDir, (s) => {
          if (!s.candidates.includes(cut.candidate_id)) s.candidates.push(cut.candidate_id);
          s.current_candidate = cut.candidate_id;
          if (s.feature_state === 'RUNNING') s.feature_state = 'CANDIDATE_READY';
          return s;
        });
        return cut;
      },
      5_000,
    );
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
    const verified = verifyCandidate(manifest, {
      controlRepo: controlRoot,
      repositories: repoRefs,
      requiredRepositories: registeredRepositories(workspace),
    });
    // A candidate of a feature whose criteria are not all evidenced is not deliverable (engine/criteria.ts).
    const state = loadState(paths.featureDir)?.data;
    const uncovered = state ? settledUncoveredCriteria(loadGraph(controlRoot, featureId), state.nodes) : [];
    // Nor one no acceptance review PASS binds (engine/acceptance-review.ts).
    const unreviewed = [...reviewGateProblems(controlRoot, featureId, { candidateRepositories: Object.fromEntries(Object.entries(manifest.repositories).map(([n, r]) => [n, r.sha])) }), ...(state ? reviewRevisionProblems(controlRoot, state) : [])];
    const result = {
      ...verified,
      ok: verified.ok && uncovered.length === 0 && unreviewed.length === 0,
      problems: [
        ...verified.problems,
        ...uncovered.map((ac) => ({ code: 'UNCOVERED_ACCEPTANCE_CRITERION', path: '/acceptance_criteria', detail: `${ac.id} (${ac.kind}) has no criterion evidence on a DONE node` })),
        ...unreviewed.map((p) => ({ code: p.slice(0, p.indexOf(':')), path: '/acceptance_review', detail: p.slice(p.indexOf(':') + 2) })),
      ],
    };
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
      ...(result.settled ? [`settled ${result.settled.node_id} -> ${result.settled.outcome} (${result.settled.state}); continue with dispatch`] : []),
      ...result.controller_reports.map((r) => `controller ${r.node_id} -> ${r.outcome} (${r.state})`),
      ...(result.review_reports ?? []).map((r) => `acceptance review ${r.review_id} -> ${r.outcome}${r.reworked.length > 0 ? `; reworked ${r.reworked.join(', ')}` : ''}`),
      ...(result.ticket
        ? [
            'kind' in result.ticket
              ? `ticket: acceptance review ${result.ticket.review_id} (generation ${result.ticket.attempt}) -> agent ${result.ticket.agent}`
              : `ticket: ${result.ticket.node_id} attempt ${result.ticket.attempt} -> agent ${result.ticket.agent}`,
            `result slot: ${result.ticket.result_slot}`,
            'Re-run with --json to get the full ticket (prompt and capability).',
          ]
        : []),
      ...result.pending.map((x) => `pending ${x.node_id} until ${x.expires_at}${x.expired ? ' (expired)' : ''}`),
      ...(result.pending_review ? [`pending acceptance review ${result.pending_review.review_id} until ${result.pending_review.expires_at}${result.pending_review.verdict_present ? ' (its verdict is in its slot)' : ''}`] : []),
    ].join('\n'),
  );
  return ['DISPATCHED', 'ALL_SETTLED', 'WAITING', 'SETTLED'].includes(result.status) ? 0 : 1;
}

/** `mycelink settle <feature> <node> --capability <c>`. */
function settleCommand(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const featureId = requirePositional(args, 1, 'feature-id');
  const nodeId = requirePositional(args, 2, 'node-id');
  const orchestrator = orchestratorFor(controlRoot, featureId);
  const report = orchestrator.settle(nodeId, presentedCapability(args));
  // Held for its criterion evidence: the worker that holds the capability corrects it (or dispatch hands it to a fresh one).
  const correct = report.outcome === 'EVIDENCE_CORRECTION_REQUIRED';
  // Its worker still runs: wait for its completion, then the same settle line (nothing was charged).
  const running = report.outcome === 'WORKER_RUNNING';
  emit(io, args, { ...report, next: correct ? 'correct' : running ? 'await' : 'dispatch' }, () =>
    [
      `${report.node_id} -> ${report.outcome} (${report.state})${report.idempotent ? ' [already settled]' : ''} ${report.detail}`,
      ...(correct
        ? [
            'Nothing was charged or integrated. The worker that holds this capability writes a corrected result (the same commit_sha; criterion_evidence by test_id) to its result file and settles again; or run dispatch, which hands the correction to a fresh worker. Never write the result yourself. Bound tests:',
            ...(report.candidates ?? []).map((c) => `${testLine(c)}  [${c.gate}]`),
          ]
        : []),
    ].join('\n'),
  );
  return report.outcome === 'DONE' ? 0 : 1;
}

/**
 * A host's copy of a reviewer's final answer for `review ingest
 * --result-file`: standard input (`-`), or a regular file (never a link)
 * inside the control repository, read within MAX_RESULT_BYTES. It is only
 * ever compared with the transcript's.
 */
function hostResultCopy(spec: string, controlRoot: string, io: CliIo): { ok: true; text: string } | { ok: false; detail: string } {
  if (spec === '-') {
    const text = io.stdin ?? readStdinBounded(MAX_RESULT_BYTES + 1);
    return Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES ? { ok: false, detail: `the copy on standard input is over ${MAX_RESULT_BYTES} bytes` } : { ok: true, text };
  }
  const file = resolve(spec);
  try {
    if (!isInsideReal(realpathSync.native(controlRoot), realpathSync.native(file))) return { ok: false, detail: `${spec} is not in the control repository` };
  } catch {
    return { ok: false, detail: `${spec} cannot be read` };
  }
  // Read through one descriptor, never following a link: what is checked is what is read.
  const read = readRegular(file, MAX_RESULT_BYTES);
  if (read !== null) return { ok: true, text: read.bytes.toString('utf8') };
  if (isLink(file)) return { ok: false, detail: `${spec} is not a regular file (a link is never followed)` };
  return { ok: false, detail: `${spec} is not a regular file of at most ${MAX_RESULT_BYTES} bytes` };
}

/** Standard input, read at most `max` bytes. */
function readStdinBounded(max: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((err as NodeJS.ErrnoException).code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
    if (total >= max) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `mycelink review status|ingest|settle <feature>`: the acceptance review
 * (engine/acceptance-review.ts). `ingest` takes the reviewer's final answer
 * as its verdict (engine/review-transport.ts) and `settle` takes the verdict,
 * each with the review ticket's capability, as the host's ingest_command and
 * settle_command run them.
 */
function reviewGroup(args: ParsedArgs, io: CliIo): number {
  const controlRoot = resolveControlRoot(args);
  const sub = requirePositional(args, 1, 'status|await|ingest|settle');
  const featureId = requirePositional(args, 2, 'feature-id');
  const orchestrator = orchestratorFor(controlRoot, featureId);
  if (sub === 'status') {
    const summary = orchestrator.statusSummary().acceptance_review;
    const reviewState = loadState(featurePaths(controlRoot, featureId).featureDir)?.data.acceptance_review;
    const reviews = reviewState?.reviews ?? [];
    const challenges = reviewState?.challenges ?? [];
    const reviewedState = loadState(featurePaths(controlRoot, featureId).featureDir)?.data;
    const problems = [...reviewGateProblems(controlRoot, featureId), ...(reviewedState ? reviewRevisionProblems(controlRoot, reviewedState) : [])];
    emit(io, args, { feature_id: featureId, acceptance_review: summary, lineage: summary?.lineage ?? null, revisions: summary?.revisions ?? [], orders: summary?.orders ?? [], reviews, challenges, problems }, () =>
      summary === null
        ? `${featureId} has no acceptance review (initialised before it existed).`
        : [
            `acceptance review: ${summary.required ? 'required' : 'not required'}; accepted reworks per criterion ${summary.budget_line || `none of ${summary.max_rounds}`}; review sessions ${summary.review_sessions.used} of ${summary.review_sessions.max}; ${summary.passed ? 'a PASS binds what the feature has now' : 'no current PASS'}`,
            ...Object.entries(summary.criteria).map(([id, c]) => `${id}: ${c.next_action}`),
            ...(summary.open ? [`with its reviewer: ${summary.open.review_id} (dispatch ${summary.open.dispatch_id})${summary.open.verdict_present ? ', verdict in its slot' : ''}`] : []),
            ...reviews.map((r) => `${r.review_id} review ${r.review}: ${r.overall} -> ${r.outcome}${r.reworks.length > 0 ? ` (reworked ${r.reworks.join(', ')})` : ''} ${r.receipt_path}${(r.refinements ?? []).length > 0 ? `; revision ${(r.refinements ?? []).length} (refined ${(r.refinements ?? []).length} time(s))` : ''}`),
            ...summary.orders.map((x) => `${x.node_id}: ordered by ${x.review_id} revision ${x.revision ?? '?'}${x.current ? '' : ' (not its current revision: dispatch reconciles it)'}${x.rebases.length > 0 ? `, rebased ${x.rebases.map((r) => `${r.from}->${r.to} (${r.by})`).join(', ')}` : ''}`),
            ...problems.map((p) => `problem: ${p}`),
            ...challenges.map((c) => `${c.challenge_id} (${c.node_id}) challenges ${c.gaps.map((g) => `${g.criterion} round ${g.round}${g.decision !== null ? ` ${g.decision}` : ''}`).join(', ')} of ${c.review_id}: ${c.status} ${c.receipt_path}`),
            ...(summary.blocked ? [`BLOCKED ${summary.blocked.code}: ${summary.blocked.detail}`] : []),
          ].join('\n'),
    );
    return 0;
  }
  if (sub === 'await') {
    const reviewFlag = args.flags['review'];
    if (reviewFlag !== undefined && (typeof reviewFlag !== 'string' || reviewFlag === '')) throw new Error('--review takes the ticket\'s review_id.');
    const waitFlag = args.flags['wait-seconds'];
    const wait = waitFlag === undefined ? REVIEW_AWAIT_SECONDS : Number(waitFlag);
    if (!Number.isFinite(wait) || wait < 0 || wait > REVIEW_AWAIT_MAX_SECONDS) throw new Error(`--wait-seconds takes 0..${REVIEW_AWAIT_MAX_SECONDS}.`);
    const report = orchestrator.awaitReview(typeof reviewFlag === 'string' ? reviewFlag : null, presentedCapability(args), { waitMs: wait * 1000 });
    emit(io, args, report, () => {
      const r = report.reviewer;
      const head = `${report.review_id ?? featureId}${report.dispatch_id !== null ? ` (dispatch ${report.dispatch_id})` : ''}: ${report.state}${r !== null && r.elapsed_ms !== null ? ` after ${Math.round(r.elapsed_ms / 1000)} s of its ${Math.round(r.timeout_ms / 1000)} s wall-clock` : ''}`;
      const next =
        report.next === 'await'
          ? 'Still running: run this line again. Never settle, correct or relaunch it while it runs.'
          : report.next === 'ingest'
            ? "Run the ticket's ingest line, then its settle line."
            : report.next === 'settle'
              ? "Run the ticket's settle line."
              : report.next === 'launch'
                ? "Launch the reviewer with the ticket's prompt (the Agent tool), then run this line."
                : report.next === 'stop'
                  ? 'The acceptance review stops the feature: report it.'
                  : 'Continue with dispatch.';
      return [head, report.detail, next].join('\n');
    });
    return 0;
  }
  if (sub === 'ingest') {
    const reviewId = args.flags['review'];
    if (typeof reviewId !== 'string' || reviewId === '') throw new Error('Missing --review <review id> (the ticket\'s review_id).');
    const agentFlag = args.flags['agent-id'];
    if (agentFlag !== undefined && (typeof agentFlag !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(agentFlag))) throw new Error('--agent-id takes the agentId the Agent tool returned.');
    const copyFlag = args.flags['result-file'];
    let hostText: string | undefined;
    if (copyFlag !== undefined) {
      const copy = typeof copyFlag === 'string' && copyFlag !== '' ? hostResultCopy(copyFlag, controlRoot, io) : { ok: false as const, detail: '--result-file takes a file or -' };
      if (!copy.ok) {
        const refused = { review_id: reviewId, outcome: 'REVIEW_RESULT_FILE_INVALID', code: 'REVIEW_RESULT_FILE_INVALID', detail: `nothing was read or written: ${copy.detail}`, written: false, idempotent: false, next: 'settle' };
        emit(io, args, refused, () => `${reviewId} -> REVIEW_RESULT_FILE_INVALID: ${refused.detail}`);
        return 1;
      }
      hostText = copy.text;
    }
    const report = orchestrator.ingestReview(reviewId, presentedCapability(args), { ...(typeof agentFlag === 'string' ? { agentId: agentFlag } : {}), ...(hostText !== undefined ? { hostText } : {}) });
    emit(io, args, report, () =>
      [
        `${report.review_id} (dispatch ${report.dispatch_id}) -> ${report.outcome}${report.idempotent ? ' [already]' : ''}${report.transport !== null ? ` [${report.transport}]` : ''}: ${report.detail}`,
        report.next === 'wait'
          ? "The reviewer is still running: run the ticket's await line until it completes, then this line again."
          : report.next === 'launch'
            ? "No reviewer was launched: launch it with the ticket's prompt, then run its await line."
            : report.next === 'settle'
              ? 'Run the ticket\'s settle_command.'
              : 'Continue with dispatch.',
      ].join('\n'),
    );
    return ['INGESTED', 'ALREADY_INGESTED', 'WRITTEN', 'SETTLED'].includes(report.outcome) ? 0 : 1;
  }
  if (sub === 'settle') {
    const reviewId = args.flags['review'];
    if (typeof reviewId !== 'string' || reviewId === '') throw new Error('Missing --review <review id> (the ticket\'s review_id).');
    const report = orchestrator.settleReview(reviewId, presentedCapability(args));
    emit(io, args, report, () =>
      [
        `${report.review_id} -> ${report.outcome}${report.idempotent ? ' [already settled]' : ''}${report.code ? ` (${report.code})` : ''}: ${report.detail}`,
        ...(report.refinement !== undefined ? [`refinement round ${report.refinement.round}: ${report.refinement.decisions.map((d) => `${d.criterion} of ${d.challenge_id} ${d.decision}`).join(', ')}`] : []),
        ...(report.reworked.length > 0 ? [`reworked ${report.reworked.join(', ')}; dispatch again: their module-workers write the focused RED for each gap.`] : []),
        report.next === 'stop'
          ? 'The acceptance review blocks the feature: report it; never cut a candidate around it.'
          : report.next === 'wait'
            ? "Nothing was settled: run the ticket's await line until the reviewer completes, then its ingest and settle lines."
            : report.next === 'launch'
              ? "Nothing was settled: launch the reviewer with the ticket's prompt, then run its await line."
              : 'Continue with dispatch.',
      ].join('\n'),
    );
    return report.outcome === 'PASS' || report.outcome === 'GAPS' || report.outcome === 'WITHDRAWN' ? 0 : 1;
  }
  io.err(`Unknown review command "${sub}".`);
  return 2;
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
