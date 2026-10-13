/**
 * Claude Code hook entrypoint.
 *
 * Token-safe by construction:
 *  - a successful PreToolUse / PostToolUse / PreCompact hook writes nothing;
 *  - a block writes a reason of at most 1 KiB to stderr and exits 2;
 *  - SessionStart context is capped at 4 KiB, UserPromptSubmit delta at 2 KiB;
 *  - no file body, diff, tool output or image ever reaches stdout;
 *  - the hook never invokes a model.
 *
 * Verified against Claude Code 2.1.274: SessionStart, UserPromptSubmit,
 * PreCompact, PostCompact, PreToolUse, PostToolUse, TaskCreated,
 * TaskCompleted, SubagentStop, Stop, SessionEnd and PostToolUseFailure all
 * exist, as do the `hookSpecificOutput.additionalContext` and
 * `permissionDecision` output fields.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { ParsedArgs } from '../cli/args.js';
import type { CliIo } from '../cli/cli.js';
import { featurePaths, controlPaths } from '../workspace/paths.js';
import { loadConfig, loadGraph, loadRepositories } from '../workspace/workspace.js';
import { loadState } from '../state/feature-state.js';
import { deferredRegression, provedWithoutRed, redRequired } from '../state/transition.js';
import { isTestPath as isPolicyTestPath, tddPolicyFor, type RepositoryTddConfig } from '../engine/tdd-history.js';
import { commandIndex, readShell, wordText, type SimpleCommand } from '../security/shell.js';
import { shellWrites } from '../security/shell-writes.js';
import { workerBinding } from './worker-binding.js';
import { computeReady } from '../scheduler/ready.js';
import { leaseStatus } from '../resources/leases.js';
import { liveSessions } from '../sessions/registry.js';
import { appendEvent } from '../state/event-log.js';
import { matchGlob } from '../git/worktree.js';
import { isSafeFeatureId } from '../security/names.js';
import { isInsideReal, samePath } from '../security/paths.js';
import { isWorkerResultRel } from '../sessions/worker-protocol.js';
import type { FeatureState_, GraphNode, PortfolioGraph } from '../model/types.js';
import { fenceDecision, roleOf, unjudged, type FenceDecision, type FenceInput } from './fence.js';
import { recordAgentEnd, recordCallEnd, recordCallStart } from './worker-calls.js';
import { ATTESTATION_FILE, REVIEW_ATTESTATION_SCHEMA, canonicalVerdictSha256 } from '../engine/acceptance-review.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { duplicateReviewerLaunch, recordReviewerLaunch } from './review-launch.js';
import { recordAgentTask } from './agent-task.js';
import { recordHostBinding, recordWorkerLaunch, runsDispatch } from './provider-binding.js';

export interface HookInput {
  session_id?: string;
  /** Present only when the call comes from a subagent (Claude Code 2.1.290). */
  agent_id?: string;
  /** The subagent's type, e.g. mycelink:module-worker. */
  agent_type?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  task?: { id?: string; subject?: string; description?: string };
  subject?: string;
  description?: string;
  stop_hook_active?: boolean;
  reason?: string;
}

const MAX_BLOCK_BYTES = 1024;

/**
 * Controller-owned files a model must never edit directly.
 *
 * Note what is deliberately *not* here: `.mycelink/worktrees/**`,
 * `.mycelink/integration/**` and `.mycelink/deploy/**` are real source
 * checkouts that workers must be able to edit. Only controller bookkeeping
 * at the root of `.mycelink` is protected; the ownership fence below governs
 * the checkouts themselves.
 */
const MANAGED_PATTERNS = [
  '**/STATE.json',
  '**/PORTFOLIO-GRAPH.yaml',
  '**/events.jsonl',
  '**/RUNS.jsonl',
  '**/leases.json',
  '**/repos.lock.yaml',
  '**/candidates/*.yaml',
  '**/deliveries/*.json',
  '**/features/*/sessions/**',
  '**/features/*/reviews/**',
  '**/.mycelink/*.json',
  '**/.mycelink/*.lock',
  // Security-relevant configuration: shell mode, permission bypass, and the
  // hook registration itself. A model must not be able to switch these off.
  '**/mycelink.config.json',
  '**/.claude/settings.json',
];

/**
 * Commands that must go through the controller rather than raw shell, read
 * as the shell runs them (security/shell.ts) — never their text: a commit
 * message, a grep pattern or an echo naming one runs none of them.
 */
const WHY_WORKTREE = 'worker worktrees are created by mycelink';
const WHY_INTEGRATION = 'integration goes through mycelink branch integrate';
const WHY_E2E = 'E2E must run under mycelink e2e run with a runtime lease';
const WHY_RUNTIME = 'the runtime is a capacity-1 lease held by mycelink';
/** Read when the shell reader cannot read the command: the old text match, never less than it refused. */
const GUARDED_COMMAND_PATTERNS: { rx: RegExp; why: string }[] = [
  { rx: /\bgit\s+worktree\s+(add|remove)\b/, why: WHY_WORKTREE },
  { rx: /\bgit\s+(push|merge|rebase|cherry-pick)\b/, why: WHY_INTEGRATION },
  { rx: /\bplaywright\b|\bnpx\s+playwright\b/, why: WHY_E2E },
  { rx: /\bdocker\s+compose\s+up\b/, why: WHY_RUNTIME },
];
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
/** Launchers that run a package's binary: `npx playwright`, `pnpm exec playwright`, `yarn playwright`. */
const LAUNCHERS = new Set(['npx', 'pnpx', 'bunx', 'pnpm', 'yarn', 'npm', 'bun']);
/** Git subcommands a module-worker may run on its own history, in its own worktree (settle judges the history it leaves). */
const OWN_HISTORY = new Set(['rebase', 'cherry-pick']);

const baseName = (w: string): string => posix.basename(w.replace(/\\/g, '/')).replace(/\.(cmd|exe|ps1)$/i, '');

/** The first word at or after `from` that is not an option. */
function operandAt(words: readonly string[], from: number): number {
  let i = from;
  while (i < words.length && (words[i] as string).startsWith('-')) i++;
  return i;
}

/** Why one simple command (its argv) must go through the controller, and for git its subcommand; null when it need not. */
function bypassOf(words: readonly string[]): { why: string; git?: string } | null {
  const name = baseName(words[0] ?? '');
  if (name === 'git') {
    let i = 1;
    while (i < words.length && (words[i] as string).startsWith('-')) i += GIT_VALUE_OPTIONS.has(words[i] as string) ? 2 : 1;
    const sub = words[i] ?? '';
    if (sub === 'worktree' && ['add', 'remove'].includes(words[operandAt(words, i + 1)] ?? '')) return { why: WHY_WORKTREE };
    if (['push', 'merge', 'rebase', 'cherry-pick'].includes(sub)) return { why: WHY_INTEGRATION, git: sub };
    return null;
  }
  const isPlaywright = (w: string | undefined): boolean => w !== undefined && (baseName(w) === 'playwright' || w.startsWith('@playwright/'));
  if (name === 'playwright') return { why: WHY_E2E };
  if (LAUNCHERS.has(name)) {
    let i = operandAt(words, 1);
    while (['exec', 'dlx', 'x'].includes(words[i] ?? '')) i = operandAt(words, i + 1);
    return isPlaywright(words[i]) ? { why: WHY_E2E } : null;
  }
  if (/^node(js)?$/.test(name)) {
    const script = words[operandAt(words, 1)];
    return script !== undefined && (isPlaywright(script) || /(^|\/)playwright\//.test(script.replace(/\\/g, '/'))) ? { why: WHY_E2E } : null;
  }
  if (name === 'docker' && words[operandAt(words, 1)] === 'compose' && words[operandAt(words, operandAt(words, 1) + 1)] === 'up') return { why: WHY_RUNTIME };
  if (name === 'docker-compose' && words[operandAt(words, 1)] === 'up') return { why: WHY_RUNTIME };
  return null;
}

/** The worktree of the claim this call's module-worker holds (a node's own session, or a subagent bound to its launch), else null. */
function ownWorktree(ctx: HookContext, input: HookInput): string | null {
  if (roleOf(input as FenceInput, process.env) !== 'worker') return null;
  const envNode = process.env['MYCELINK_NODE_ID'];
  if (envNode) return ctx.state?.nodes[envNode]?.claim?.worktree ?? null;
  try {
    return workerBinding(input, [ctx.controlRoot]).binding?.worktree ?? null;
  } catch {
    return null;
  }
}

/**
 * Why a Bash command must go through the controller, or null. A module-worker
 * rebases or cherry-picks its own history in its own worktree: that is no
 * integration, and settle judges the history it leaves.
 */
function bypassRefusal(ctx: HookContext, input: HookInput, command: string): string | null {
  let commands: SimpleCommand[];
  try {
    commands = readShell(command);
  } catch {
    return GUARDED_COMMAND_PATTERNS.find((g) => g.rx.test(command))?.why ?? null;
  }
  let history: string[] | null = null;
  for (const cmd of commands) {
    const hit = bypassOf(cmd.words.slice(commandIndex(cmd.words)).map(wordText));
    if (hit === null) continue;
    if (hit.git !== undefined && OWN_HISTORY.has(hit.git)) {
      const own = ownWorktree(ctx, input);
      if (own !== null) {
        // Where each rebase or cherry-pick of the call runs, as the shell's directory moves.
        history ??= shellWrites(command, { cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : null, home: process.env['HOME'] ?? process.env['USERPROFILE'] ?? null })
          .writes.filter((w) => w.action === 'git rebase' || w.action === 'git cherry-pick')
          .map((w) => w.path);
        if (history.length > 0 && history.every((p) => isInsideReal(own, p))) continue;
      }
    }
    return hit.why;
  }
  return null;
}

function truncate(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= max) return text;
  return buf.subarray(0, Math.max(0, max - 3)).toString('utf8') + '...';
}

function readStdin(io: CliIo): HookInput {
  const raw = io.stdin ?? readAllStdinSync();
  if (!raw || raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

function readAllStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** The feature the hook should talk about: an explicit flag, or the only one. */
export function activeFeature(controlRoot: string, explicit?: string): string | null {
  if (explicit) return isSafeFeatureId(explicit) ? explicit : null;
  const envFeature = process.env['MYCELINK_FEATURE_ID'];
  if (envFeature) return isSafeFeatureId(envFeature) ? envFeature : null;
  const dir = controlPaths(controlRoot).featuresDir;
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir).filter(
    (f) => isSafeFeatureId(f) && existsSync(join(dir, f, 'STATE.json')),
  );
  if (candidates.length === 1) return candidates[0] as string;
  // Several features: prefer one that is actually running.
  for (const id of candidates.sort()) {
    const state = loadState(join(dir, id))?.data;
    if (state && ['RUNNING', 'E2E_RUNNING', 'CANDIDATE_READY'].includes(state.feature_state)) {
      return id;
    }
  }
  return candidates[0] ?? null;
}

interface HookContext {
  controlRoot: string;
  featureId: string | null;
  state: FeatureState_ | null;
  graph: PortfolioGraph | null;
  paths: ReturnType<typeof featurePaths> | null;
}

function loadHookContext(controlRoot: string, explicitFeature?: string): HookContext {
  const featureId = activeFeature(controlRoot, explicitFeature);
  if (featureId === null) {
    return { controlRoot, featureId: null, state: null, graph: null, paths: null };
  }
  const paths = featurePaths(controlRoot, featureId);
  let state: FeatureState_ | null = null;
  let graph: PortfolioGraph | null = null;
  try {
    state = loadState(paths.featureDir)?.data ?? null;
  } catch {
    state = null;
  }
  try {
    graph = loadGraph(controlRoot, featureId);
  } catch {
    graph = null;
  }
  return { controlRoot, featureId, state, graph, paths };
}

/** The node this session is currently working on, if any: never the controller's (its calls are no worker's, however many nodes are claimed). */
function activeNode(ctx: HookContext, cwd?: string, input: HookInput = {}): { id: string; node: GraphNode } | null {
  if (!ctx.state || !ctx.graph) return null;
  const envNode = process.env['MYCELINK_NODE_ID'];
  const claimed = Object.entries(ctx.state.nodes).filter(([, r]) => r.claim !== null);

  const pick = (id: string): { id: string; node: GraphNode } | null => {
    const node = ctx.graph?.nodes.find((n) => n.id === id);
    return node ? { id, node } : null;
  };

  if (envNode) return pick(envNode);
  if (cwd) {
    const here = resolve(cwd);
    for (const [id, runtime] of claimed) {
      const worktree = runtime.claim?.worktree;
      if (worktree && (resolve(worktree) === here || here.startsWith(resolve(worktree) + sep))) {
        return pick(id);
      }
    }
  }
  // One node claimed: a worker's call from outside its worktree is that node's; a controller's call is no worker's.
  if (claimed.length === 1 && roleOf(input as FenceInput, process.env) === 'worker') return pick(claimed[0]?.[0] as string);
  return null;
}

/** A registered repository's manifest entry (its `tdd` block), else undefined. */
function repositoryOf(ctx: HookContext, name: string | null): { tdd?: RepositoryTddConfig } | undefined {
  if (name === null) return undefined;
  try {
    return loadRepositories(ctx.controlRoot).repositories.find((r) => r.name === name) as { tdd?: RepositoryTddConfig } | undefined;
  } catch {
    return undefined;
  }
}

function block(io: CliIo, reason: string): number {
  io.err(truncate(reason, MAX_BLOCK_BYTES));
  return 2;
}

/**
 * The host session's own calls that bind a holder (hooks/provider-binding.ts): its Bash call running
 * Mycelink's `dispatch`, and its Agent call launching a module-worker. A subagent's call binds nothing.
 */
function recordHolders(call: FenceInput): void {
  if ((typeof call.agent_id === 'string' && call.agent_id !== '') || typeof call.session_id !== 'string' || typeof call.transcript_path !== 'string') return;
  const host = { session_id: call.session_id, transcript_path: call.transcript_path, cwd: typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : process.cwd(), ...(typeof call.tool_use_id === 'string' ? { tool_use_id: call.tool_use_id } : {}) };
  const input = call.tool_input ?? {};
  try {
    if (call.tool_name === 'Bash' && typeof input['command'] === 'string' && runsDispatch(input['command'])) recordHostBinding(host, process.env);
    const type = String(input['subagent_type'] ?? '');
    if ((call.tool_name === 'Agent' || call.tool_name === 'Task') && (type === 'mycelink:module-worker' || type === 'module-worker') && typeof input['prompt'] === 'string') {
      recordWorkerLaunch({ ...host, prompt: input['prompt'], subagent_type: type }, process.env);
    }
  } catch {
    // a holder nothing could record: its failure is then read from the host's binding, or its lease expires
  }
}

/** The controller/worker fence for one tool call: never a model's way around the controller. */
function controllerFence(io: CliIo): number {
  let decision: FenceDecision;
  let call: FenceInput | null = null;
  try {
    const raw = io.stdin ?? readAllStdinSync();
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      input = null;
    }
    call = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as FenceInput) : null;
    decision =
      call !== null && typeof call.tool_name === 'string'
        ? fenceDecision(call)
        : unjudged(call !== null && typeof call.cwd === 'string' ? { cwd: call.cwd } : {}, process.env, new Error('unreadable hook input'));
  } catch (err) {
    decision = unjudged({}, process.env, err);
  }
  if (!decision.ok) return block(io, decision.reason);
  // The host's launch of the acceptance reviewer: never a second one for a generation whose reviewer runs or answered (CSET-203
  // r13); recorded for its generation, what its final answer and its lifecycle are proved against.
  if (decision.launch !== undefined) {
    const duplicate = duplicateReviewerLaunch(decision.launch, process.env);
    if (duplicate !== null) return block(io, duplicate);
    try {
      recordReviewerLaunch(decision.launch, process.env);
    } catch {
      // a launch nothing could record: the reviewer may still Write its verdict
    }
  }
  // Which host session holds a dispatch, and which subagent works it: what a provider failure is read from. Never blocks.
  if (call !== null) recordHolders(call);
  // Who runs this call, and the shared Git state just before it (hooks/worker-calls.ts): a call the ledger cannot record does not run.
  if (call !== null) {
    try {
      recordCallStart(call, roleOf(call, process.env), process.env);
    } catch (err) {
      return block(io, `Blocked: the Mycelink hook could not record this call in the provenance ledger (${err instanceof Error ? err.message.slice(0, 200) : 'error'}); run it again.`);
    }
  }
  // The acceptance reviewer's verdict Write the fence allowed: attested beside it before it happens, or not allowed at all.
  if (decision.attest !== undefined && call !== null) {
    try {
      attestVerdictWrite(decision.attest, call);
    } catch (err) {
      return block(io, `Blocked: the Mycelink fence could not attest the acceptance reviewer's verdict (${err instanceof Error ? err.message.slice(0, 200) : 'error'}).`);
    }
  }
  return 0;
}

/** What settle checks a verdict against: who wrote it, in which session, and the canonical hash of what was written. */
function attestVerdictWrite(attest: { file: string; content: string }, call: FenceInput): void {
  const body = {
    schema: REVIEW_ATTESTATION_SCHEMA,
    transport: 'file',
    agent_id: String(call.agent_id ?? ''),
    agent_type: String(call.agent_type ?? ''),
    session_id: typeof call.session_id === 'string' ? call.session_id : null,
    tool_use_id: typeof call.tool_use_id === 'string' ? call.tool_use_id : null,
    content_sha256: canonicalVerdictSha256(attest.content),
    at: new Date().toISOString(),
  };
  writeTextAtomic(join(attest.file, '..', ATTESTATION_FILE), JSON.stringify(body, null, 2) + '\n');
}

// ---------------------------------------------------------------------------

export async function runHook(event: string, args: ParsedArgs, io: CliIo): Promise<number> {
  // The plugin's controller/worker fence (hooks/fence.ts) is judged before any feature state is read, so a
  // state it cannot load never lets a call through: it fails closed inside a Mycelink workspace.
  if (event === 'controller-fence') return controllerFence(io);
  // A call's end and a subagent's stop, recorded for the provenance ledger (hooks/worker-calls.ts): never a block, never output.
  if (event === 'tool-end' || event === 'subagent-end') {
    try {
      const call = readStdin(io) as unknown as FenceInput & { hook_event_name?: string; tool_response?: unknown; is_interrupt?: boolean };
      if (event === 'tool-end') {
        // The Agent task a host's reviewer or worker launch started, bound to its launch (CSET-203 r13).
        recordAgentTask(call, process.env);
        recordCallEnd(call, roleOf(call, process.env), process.env);
      } else recordAgentEnd(call, process.env);
    } catch {
      // nothing recorded
    }
    return 0;
  }
  const input = readStdin(io);
  const controlRoot =
    (typeof args.flags['control-root'] === 'string' ? resolve(args.flags['control-root']) : null) ??
    process.env['MYCELINK_CONTROL_ROOT'] ??
    process.env['CLAUDE_PROJECT_DIR'] ??
    process.cwd();
  const explicit = typeof args.flags['feature'] === 'string' ? args.flags['feature'] : undefined;
  const ctx = loadHookContext(resolve(controlRoot), explicit);

  switch (event) {
    case 'session-start':
    case 'SessionStart':
      return sessionStart(ctx, io);
    case 'user-prompt-submit':
    case 'UserPromptSubmit':
      return userPromptSubmit(ctx, io);
    case 'pre-compact':
    case 'PreCompact':
      return preCompact(ctx, io);
    case 'post-compact':
    case 'PostCompact':
      return postCompact(ctx, io, input);
    case 'pre-tool-use':
    case 'PreToolUse':
      return preToolUse(ctx, io, input);
    case 'post-tool-use':
    case 'PostToolUse':
      return postToolUse(ctx, io, input);
    case 'task-created':
    case 'TaskCreated':
      return taskCreated(ctx, io, input);
    case 'task-completed':
    case 'TaskCompleted':
      return taskCompleted(ctx, io, input);
    case 'subagent-stop':
    case 'SubagentStop':
    case 'session-end':
    case 'SessionEnd':
      return subagentStop(ctx, io, input);
    case 'stop':
    case 'Stop':
      return stopGuard(ctx, io, input);
    default:
      // An unknown event must never break the session.
      return 0;
  }
}

// ---- context injection ----------------------------------------------------

function sessionStart(ctx: HookContext, io: CliIo): number {
  if (!ctx.state || !ctx.graph || !ctx.paths) return 0;
  const config = loadConfig(ctx.controlRoot);
  const ready = computeReady(ctx.graph, ctx.state).slice(0, 8);
  const blocked = Object.entries(ctx.state.nodes)
    .filter(([, r]) => r.state === 'BLOCKED' || r.state === 'NEEDS_DECISION')
    .map(([id]) => id)
    .slice(0, 8);
  const leases = Object.entries(leaseStatus(ctx.paths.featureDir))
    .filter(([, s]) => s.held > 0)
    .map(([r, s]) => `${r}x${s.held}`);

  const lines = [
    `# Orchestrator state (controller-owned; do not edit these files)`,
    `feature: ${ctx.state.feature_id} ${ctx.state.feature_state}`,
    `graph: ${ctx.state.graph_hash.slice(0, 12)} nodes=${Object.keys(ctx.state.nodes).length}`,
    `ready: ${ready.join(' ') || '(none)'}`,
    `blocked: ${blocked.join(' ') || '(none)'}`,
    `decisions: ${ctx.state.pending_decisions.join(' ') || '(none)'}`,
    `candidate: ${ctx.state.current_candidate ?? '(none)'}`,
    `leases: ${leases.join(' ') || '(none)'}`,
    `usage: turns=${ctx.state.usage.model_turns}/${ctx.state.budget.max_total_model_turns} sessions=${ctx.state.usage.sessions}/${ctx.state.budget.max_total_sessions}`,
    `next: mycelink orchestrate ready ${ctx.state.feature_id}`,
  ];
  io.out(truncate(lines.join('\n'), config.hook_session_start_max_bytes));
  return 0;
}

function userPromptSubmit(ctx: HookContext, io: CliIo): number {
  if (!ctx.state || !ctx.graph) return 0;
  const config = loadConfig(ctx.controlRoot);
  const counts: Record<string, number> = {};
  for (const runtime of Object.values(ctx.state.nodes)) {
    counts[runtime.state] = (counts[runtime.state] ?? 0) + 1;
  }
  const ready = computeReady(ctx.graph, ctx.state).slice(0, 5);
  const lines = [
    `orchestrator: ${ctx.state.feature_id} ${ctx.state.feature_state} ` +
      Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
    `ready: ${ready.join(' ') || '(none)'}`,
    ...(ctx.state.pending_decisions.length > 0
      ? [`awaiting decision: ${ctx.state.pending_decisions.join(' ')}`]
      : []),
  ];
  io.out(truncate(lines.join('\n'), config.hook_prompt_delta_max_bytes));
  return 0;
}

function preCompact(ctx: HookContext, io: CliIo): number {
  // Checkpoint silently. A compaction summary is never allowed to become the
  // source of truth, so the only job here is making the durable state correct.
  if (!ctx.paths || !ctx.state) return 0;
  appendEvent(ctx.paths.events, {
    idempotency_key: `precompact:${ctx.state.graph_hash}:${Date.now()}`,
    type: 'session.precompact',
    actor: 'hook',
    feature_id: ctx.state.feature_id,
    data: { feature_state: ctx.state.feature_state },
  });

  const leaked = Object.entries(leaseStatus(ctx.paths.featureDir)).filter(([, s]) => s.held > 0);
  const claimed = Object.entries(ctx.state.nodes).filter(([, r]) => r.claim !== null);
  if (leaked.length > 0 || claimed.length > 0) {
    // Not a block: compaction is allowed, but the inconsistency is recorded.
    appendEvent(ctx.paths.events, {
      idempotency_key: `precompact.inflight:${Date.now()}`,
      type: 'session.precompact_inflight',
      actor: 'hook',
      feature_id: ctx.state.feature_id,
      data: { leases: leaked.length, claims: claimed.length },
    });
  }
  void io;
  return 0;
}

function postCompact(ctx: HookContext, io: CliIo, input: HookInput): number {
  if (!ctx.paths || !ctx.state) return 0;
  appendEvent(ctx.paths.events, {
    idempotency_key: `postcompact:${input.session_id ?? 'unknown'}:${Date.now()}`,
    type: 'session.postcompact',
    actor: 'hook',
    feature_id: ctx.state.feature_id,
    data: { session_id: input.session_id ?? null },
  });
  void io;
  return 0;
}

// ---- authorisation --------------------------------------------------------

function editTarget(input: HookInput): string | null {
  const ti = input.tool_input ?? {};
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = ti[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function preToolUse(ctx: HookContext, io: CliIo, input: HookInput): number {
  const tool = input.tool_name ?? '';

  // 1. Managed state is never editable by a model, in any feature.
  const target = editTarget(input);
  if (target !== null && ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) {
    const normalised = resolve(target).replace(/\\/g, '/');
    // A feature's graph is the controller's to write until `feature init` binds its hash in STATE.json (/mycelink:plan).
    const unboundGraph = matchGlob('**/PORTFOLIO-GRAPH.yaml', normalised) && !existsSync(join(dirname(resolve(target)), 'STATE.json'));
    if (!unboundGraph && MANAGED_PATTERNS.some((p) => matchGlob(p, normalised))) {
      return block(
        io,
        `Blocked: ${relative(ctx.controlRoot, target) || target} is controller-owned state or protected configuration. ` +
          `Use mycelink (node/tdd/evidence/candidate/resource) instead of editing it.`,
      );
    }
    // The portfolio manifest names every command Mycelink runs (tests, worktree setup): controller configuration.
    if (samePath(resolve(target), join(ctx.controlRoot, 'repositories.yaml'))) {
      return block(io, 'Blocked: repositories.yaml names the commands Mycelink runs (tests, worktree setup). Change it with mycelink repo register.');
    }
  }

  // 2. Raw commands that would bypass the controller.
  if (tool === 'Bash') {
    const command = String((input.tool_input ?? {})['command'] ?? '');
    const why = bypassRefusal(ctx, input, command);
    if (why !== null) return block(io, `Blocked: ${why}. Run the equivalent mycelink command.`);
  }

  // 3. Recursive delegation is never allowed from a worker session.
  if ((tool === 'Agent' || tool === 'Task') && process.env['MYCELINK_NODE_ID']) {
    return block(
      io,
      'Blocked: a node worker may not spawn subagents. Return NEEDS_DECISION or finish the node.',
    );
  }

  if (!ctx.state || !ctx.graph) return 0;

  // 4. Ownership fence and RED gate, when we can tell which node is active.
  const active = activeNode(ctx, input.cwd, input);
  if (active !== null && target !== null && ['Edit', 'Write', 'MultiEdit'].includes(tool)) {
    const runtime = ctx.state.nodes[active.id];
    const worktree = runtime?.claim?.worktree;
    const rel = worktree
      ? relative(resolve(worktree), resolve(target)).replace(/\\/g, '/')
      : relative(ctx.controlRoot, resolve(target)).replace(/\\/g, '/');

    if (rel.startsWith('..')) {
      return block(
        io,
        `Blocked: ${active.id} may only edit inside its own worktree. "${target}" is outside it.`,
      );
    }

    // A symlink or junction inside the worktree must not lead outside it.
    if (worktree && !isInsideReal(worktree, resolve(worktree, rel))) {
      return block(
        io,
        `Blocked: "${rel}" resolves through a link to a location outside the worktree of ${active.id}.`,
      );
    }

    // The controller-assigned result file is the one path every worker must
    // be able to write, before RED and outside its fence; the controller
    // collects it with its own containment, schema and identity checks.
    if (isWorkerResultRel(rel)) return 0;

    const allowed = active.node.allowed_paths.some((g) => matchGlob(g, rel));
    const forbidden = (active.node.forbidden_paths ?? []).some((g) => matchGlob(g, rel));
    if (!allowed || forbidden) {
      return block(
        io,
        `Blocked: ${rel} is outside the ownership fence of ${active.id} ` +
          `(allowed: ${active.node.allowed_paths.join(', ') || 'none'}).`,
      );
    }

    // RED gate: production code may not change before a verified RED — tests told apart by the policy settle judges by,
    // and only where this generation needs a RED (a compatibility-only rework needs none).
    const needsRed = redRequired(active.node, runtime ?? {});
    const isTestPath = isPolicyTestPath(runtime?.claim?.tdd_policy ?? tddPolicyFor(repositoryOf(ctx, active.node.repository)), rel);
    const redRecord = runtime?.evidence.red;
    const redVerified =
      redRecord !== undefined &&
      redRecord.exit_code !== 0 &&
      redRecord.red_reason === 'behaviour-missing';
    if (needsRed && !isTestPath && !redVerified) {
      return block(
        io,
        `Blocked: ${active.id} has no verified RED yet. Write the failing test first, then ` +
          `run "mycelink tdd red ${ctx.state.feature_id} ${active.id} -- <test command>".`,
      );
    }
  }

  return 0;
}

function postToolUse(ctx: HookContext, io: CliIo, input: HookInput): number {
  // Compact metadata only. The tool payload is never echoed back.
  if (!ctx.paths || !ctx.state) return 0;
  const target = editTarget(input);
  const key = createHash('sha256')
    .update(`${input.session_id ?? ''}|${input.tool_name ?? ''}|${target ?? ''}|${Date.now()}`)
    .digest('hex')
    .slice(0, 24);
  try {
    appendEvent(ctx.paths.events, {
      idempotency_key: `posttool:${key}`,
      type: 'tool.used',
      actor: 'hook',
      feature_id: ctx.state.feature_id,
      ...(process.env['MYCELINK_NODE_ID'] ? { node_id: process.env['MYCELINK_NODE_ID'] } : {}),
      data: {
        tool: input.tool_name ?? null,
        // Path only, relative where possible; never the content.
        path: target ? relative(ctx.controlRoot, resolve(target)).replace(/\\/g, '/') : null,
      },
    });
  } catch {
    // The audit log must never break a tool call.
  }
  void io;
  return 0;
}

// ---- task guards ----------------------------------------------------------

function taskText(input: HookInput): string {
  return [input.task?.subject, input.task?.description, input.subject, input.description, input.prompt]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
}

function taskCreated(ctx: HookContext, io: CliIo, input: HookInput): number {
  if (!ctx.state || !ctx.graph) return 0;
  const text = taskText(input);
  const known = Object.keys(ctx.state.nodes);
  const mentioned = known.filter((id) => text.includes(id));

  if (mentioned.length === 0) {
    return block(
      io,
      `Blocked: a task must name an approved graph node id. Known READY nodes: ` +
        `${computeReady(ctx.graph, ctx.state).slice(0, 5).join(', ') || '(none)'}. ` +
        `Run "mycelink orchestrate ready ${ctx.state.feature_id}".`,
    );
  }

  const schedulable = mentioned.filter((id) => {
    const runtime = ctx.state?.nodes[id];
    return runtime && ['READY', 'CLAIMED'].includes(runtime.state);
  });
  if (schedulable.length === 0) {
    return block(
      io,
      `Blocked: node(s) ${mentioned.join(', ')} are not READY or CLAIMED ` +
        `(${mentioned.map((id) => `${id}=${ctx.state?.nodes[id]?.state}`).join(', ')}).`,
    );
  }
  return 0;
}

function taskCompleted(ctx: HookContext, io: CliIo, input: HookInput): number {
  if (!ctx.state || !ctx.graph) return 0;
  const text = taskText(input);
  const mentioned = Object.keys(ctx.state.nodes).filter((id) => text.includes(id));
  if (mentioned.length === 0) return 0;

  for (const id of mentioned) {
    const runtime = ctx.state.nodes[id];
    const node = ctx.graph.nodes.find((n) => n.id === id);
    if (!runtime || !node) continue;

    const missing = node.required_evidence.filter((kind) => {
      const record = runtime.evidence[kind];
      if (kind === 'red' && provedWithoutRed(runtime)) return false;
      if (!record) return true;
      if (kind === 'red') return record.red_reason !== 'behaviour-missing' || record.exit_code === 0;
      return record.exit_code !== 0 && !deferredRegression(record);
    });
    if (missing.length > 0) {
      return block(
        io,
        `Blocked: ${id} cannot complete without evidence for: ${missing.join(', ')}. ` +
          `Run "mycelink node verify ${ctx.state.feature_id} ${id}".`,
      );
    }
    if (!['REVIEW_VERIFIED', 'INTEGRATED', 'DONE'].includes(runtime.state)) {
      return block(
        io,
        `Blocked: ${id} is ${runtime.state}; only the controller may mark it DONE after fresh verification.`,
      );
    }
  }
  return 0;
}

function subagentStop(ctx: HookContext, io: CliIo, input: HookInput): number {
  // Reclaim anything a dying worker was holding. Never blocks.
  if (!ctx.paths || !ctx.state) return 0;
  try {
    appendEvent(ctx.paths.events, {
      idempotency_key: `subagent-stop:${input.session_id ?? 'unknown'}:${Date.now()}`,
      type: 'session.stopped',
      actor: 'hook',
      feature_id: ctx.state.feature_id,
      data: { session_id: input.session_id ?? null },
    });
  } catch {
    // ignore
  }
  void io;
  return 0;
}

function stopGuard(ctx: HookContext, io: CliIo, input: HookInput): number {
  // An explicit user stop is always allowed; we only checkpoint.
  if (input.stop_hook_active === true) return 0;
  if (!ctx.state || !ctx.paths) return 0;

  const problems: string[] = [];
  const leaked = Object.entries(leaseStatus(ctx.paths.featureDir)).filter(([, s]) => s.held > 0);
  if (leaked.length > 0) {
    problems.push(`leaked leases: ${leaked.map(([r, s]) => `${r}x${s.held}`).join(' ')}`);
  }
  const live = liveSessions(ctx.paths.sessionsRegistry);
  if (live.length > 0) problems.push(`live worker sessions: ${live.length}`);

  const unfinished = Object.entries(ctx.state.nodes).filter(
    ([, r]) => !['DONE', 'EXCLUDED', 'BLOCKED', 'NEEDS_DECISION', 'BUDGET_EXHAUSTED', 'PLANNED'].includes(r.state),
  );
  if (unfinished.length > 0) {
    problems.push(`in-flight nodes: ${unfinished.map(([id, r]) => `${id}=${r.state}`).slice(0, 3).join(' ')}`);
  }

  if (problems.length === 0) return 0;
  return block(
    io,
    `Blocked: the feature is not in a safe stopping state (${problems.join('; ')}). ` +
      `Run "mycelink session reconcile ${ctx.state.feature_id}" first, or stop explicitly.`,
  );
}
