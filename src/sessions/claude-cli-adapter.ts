/**
 * Claude Code CLI session adapter.
 *
 * Spawns a real `claude` print-mode session (`-p --output-format stream-json`)
 * confined to one worker worktree, streams its NDJSON to a log file, derives
 * turns and token usage from that stream, and enforces wall-clock and stall
 * budgets the CLI does not enforce itself.
 *
 * The automated suite points `executable` at `tests/fake-claude/claude.mjs`,
 * so the same spawn, stream-parse, timeout and result-validation code is
 * exercised without any model usage. Production points it at `claude`.
 *
 * Verified against Claude Code 2.1.274: `-p`, `--output-format stream-json`,
 * `--verbose`, `--model`, `--session-id`, `--add-dir`, `--allowed-tools`,
 * `--disallowed-tools`, `--permission-mode` and `--bg` all exist; there is no
 * `--max-turns`, which is why the turn ceiling is enforced here.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  statusForOutcome,
  zeroObservationUsage,
  type NodeResult,
  type SessionAdapter,
  type SessionHandle,
  type SessionObservation,
  type SessionStatus,
  type SpawnRequest,
} from './adapter.js';
import { validateAgainstSchema } from '../schema/registry.js';
import type { UsageTotals } from '../model/types.js';
import { LineRedactor } from '../security/redact.js';
import { planCommand } from '../security/exec.js';

export interface ClaudeCliAdapterOptions {
  /** The executable to run. `claude` in production. */
  executable: string;
  /** Argv inserted before the CLI flags (used to run the fake via node). */
  prefixArgs?: string[];
  /** Extra argv appended to every invocation. */
  extraArgs?: string[];
  adapterName?: 'fake-claude' | 'claude-background';
  /** 'print' owns the child process; 'background' hands it to Claude Code. */
  mode?: 'print' | 'background';
  /** Permission mode passed through to the CLI. Never bypassPermissions by default. */
  permissionMode?: string;
}

type WorkerChild = ChildProcessByStdio<null, Readable, Readable>;

interface RunState {
  handle: SessionHandle;
  child: WorkerChild | null;
  request: SpawnRequest;
  turns: number;
  usage: UsageTotals;
  startedAtMs: number;
  lastProgressMs: number;
  exitCode: number | null;
  settled: boolean;
  status: SessionStatus;
  failureReason: string | null;
  timedOut: boolean;
  stopped: boolean;
  done: Promise<void>;
  finish: () => void;
  timers: NodeJS.Timeout[];
}

const WORKER_PROMPT = [
  'You are a bounded Claude Code worker session driven by the multi-repo orchestrator.',
  'Read the JSON context pack at $MYCELINK_CONTEXT_PACK. It is your entire brief.',
  'Implement exactly the one node it names, inside this worktree only, and only within allowed_paths.',
  'Do not spawn subagents. Do not edit PRD, PLAN, PORTFOLIO-GRAPH, STATE or contracts.',
  'Write a failing test first; the RED must fail for a missing behaviour, not a setup error.',
  'When finished, write a node-result JSON to $MYCELINK_RESULT_PATH with your commands, exit codes,',
  'commit SHA, changed paths, evidence paths and an outcome of SUBMITTED, RETRYABLE, BLOCKED,',
  'NEEDS_DECISION or BUDGET_EXHAUSTED. Do not claim success in prose; the result file is the claim.',
].join(' ');

export class ClaudeCliAdapter implements SessionAdapter {
  readonly name: 'fake-claude' | 'claude-background';
  private readonly options: ClaudeCliAdapterOptions;
  private readonly runs = new Map<string, RunState>();

  constructor(options: ClaudeCliAdapterOptions) {
    this.options = options;
    this.name = options.adapterName ?? 'claude-background';
  }

  buildArgs(request: SpawnRequest, sessionId: string): string[] {
    const args = [...(this.options.prefixArgs ?? [])];
    args.push('-p', WORKER_PROMPT);
    args.push('--output-format', 'stream-json', '--verbose');
    args.push('--model', request.model);
    args.push('--session-id', sessionId);
    if (this.options.mode === 'background') args.push('--bg');
    if (this.options.permissionMode) args.push('--permission-mode', this.options.permissionMode);
    for (const dir of request.addDirs ?? []) args.push('--add-dir', dir);
    if (request.allowedTools && request.allowedTools.length > 0) {
      args.push('--allowed-tools', ...request.allowedTools);
    }
    if (request.disallowedTools && request.disallowedTools.length > 0) {
      args.push('--disallowed-tools', ...request.disallowedTools);
    }
    args.push(...(this.options.extraArgs ?? []));
    return args;
  }

  spawn(request: SpawnRequest): SessionHandle {
    const sessionId = randomUUID();
    mkdirSync(dirname(resolve(request.logPath)), { recursive: true });
    mkdirSync(dirname(resolve(request.resultPath)), { recursive: true });
    // A stale result from a previous attempt must never be mistaken for this one's.
    if (existsSync(request.resultPath)) rmSync(request.resultPath, { force: true });

    const handle: SessionHandle = {
      session_id: sessionId,
      adapter: this.name,
      pid: null,
      node_id: request.nodeId,
      claim_id: request.claimId,
      started_at: new Date().toISOString(),
      log_path: request.logPath,
      result_path: request.resultPath,
    };

    // The configured executable is a file name, never a shell string; on
    // Windows an npm-installed claude.cmd goes through the batch-shim rules.
    const plan = planCommand([this.options.executable, ...this.buildArgs(request, sessionId)]);
    const child = spawn(plan.file, plan.args, {
      cwd: request.cwd,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MYCELINK_CONTEXT_PACK: resolve(request.contextPackPath),
        MYCELINK_RESULT_PATH: resolve(request.resultPath),
        MYCELINK_FEATURE_ID: request.featureId,
        MYCELINK_NODE_ID: request.nodeId,
        MYCELINK_CLAIM_ID: request.claimId,
        MYCELINK_ATTEMPT: String(request.attempt),
        ...(request.env ?? {}),
      },
    }) as WorkerChild;

    handle.pid = child.pid ?? null;

    let finish!: () => void;
    const done = new Promise<void>((res) => {
      finish = res;
    });

    const now = Date.now();
    const state: RunState = {
      handle,
      child,
      request,
      turns: 0,
      usage: zeroObservationUsage(),
      startedAtMs: now,
      lastProgressMs: now,
      exitCode: null,
      settled: false,
      status: 'working',
      failureReason: null,
      timedOut: false,
      stopped: false,
      done,
      finish,
      timers: [],
    };
    this.runs.set(sessionId, state);

    const log = createWriteStream(resolve(request.logPath), { flags: 'a' });
    // The session log is durable: secrets echoed by tools or tests are
    // redacted line by line before they reach disk.
    const outRedactor = new LineRedactor();
    const errRedactor = new LineRedactor();
    child.stdout.on('end', () => log.write(outRedactor.flush()));
    child.stderr.on('end', () => log.write(errRedactor.flush()));
    let buffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      state.lastProgressMs = Date.now();
      log.write(outRedactor.push(chunk.toString('utf8')));
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line !== '') this.consumeStreamLine(state, line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      state.lastProgressMs = Date.now();
      log.write(errRedactor.push(chunk.toString('utf8')));
    });

    const watchdog = setInterval(() => {
      const elapsed = Date.now() - state.startedAtMs;
      const idle = Date.now() - state.lastProgressMs;
      if (elapsed >= request.maxWallClockMs) {
        state.timedOut = true;
        state.failureReason = 'WALL_CLOCK_EXCEEDED';
        this.kill(state, 'budget-exhausted');
      } else if (idle >= request.stallMs) {
        state.failureReason = 'NO_PROGRESS';
        this.kill(state, 'stalled');
      } else if (state.turns > request.maxTurns) {
        state.failureReason = 'TURN_LIMIT_EXCEEDED';
        this.kill(state, 'budget-exhausted');
      }
    }, 50);
    state.timers.push(watchdog);

    child.on('error', (err) => {
      state.exitCode = 127;
      state.failureReason = `SPAWN_FAILED: ${err.message}`;
      this.settle(state, 'failed', log);
    });

    child.on('close', (code) => {
      state.exitCode = code;
      this.settle(state, null, log);
    });

    return handle;
  }

  /** Accumulate turns and usage from one NDJSON line of the CLI stream. */
  private consumeStreamLine(state: RunState, line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Non-JSON output (banners, warnings) is logged but not counted.
    }
    const type = event['type'];
    if (type === 'assistant') {
      state.turns += 1;
      const message = event['message'] as { usage?: Record<string, number> } | undefined;
      const usage = message?.usage;
      if (usage) {
        state.usage.input_tokens += usage['input_tokens'] ?? 0;
        state.usage.output_tokens += usage['output_tokens'] ?? 0;
      }
    } else if (type === 'result') {
      const turns = event['num_turns'];
      if (typeof turns === 'number') state.turns = turns;
      const usage = event['usage'] as Record<string, number> | undefined;
      if (usage) {
        // The result envelope reports totals; prefer it over the running sum.
        state.usage.input_tokens = usage['input_tokens'] ?? state.usage.input_tokens;
        state.usage.output_tokens = usage['output_tokens'] ?? state.usage.output_tokens;
      }
    }
  }

  private kill(state: RunState, status: SessionStatus): void {
    if (state.settled || state.child === null) return;
    state.status = status;
    try {
      state.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private settle(state: RunState, forced: SessionStatus | null, log?: NodeJS.WritableStream): void {
    if (state.settled) return;
    state.settled = true;
    for (const t of state.timers) clearInterval(t);
    state.timers = [];
    state.usage.wall_clock_ms = Date.now() - state.startedAtMs;
    state.usage.sessions = 1;
    state.usage.model_turns = state.turns;
    if (log && 'end' in log) (log as unknown as { end(): void }).end();

    if (forced !== null) {
      state.status = forced;
    } else if (state.stopped) {
      state.status = 'stopped';
    } else if (state.status === 'stalled' || state.status === 'budget-exhausted') {
      // Watchdog already decided; keep it.
    } else if (state.exitCode !== 0) {
      state.status = 'failed';
      state.failureReason ??= `EXIT_${state.exitCode}`;
    } else {
      state.status = 'done';
    }
    state.finish();
  }

  private readResult(state: RunState): NodeResult | null {
    const file = resolve(state.request.resultPath);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as NodeResult;
      const problems = validateAgainstSchema('node-result', parsed);
      if (problems.length > 0) {
        state.failureReason = 'RESULT_SCHEMA_INVALID: ' + problems[0]?.detail;
        return null;
      }
      return parsed;
    } catch (err) {
      state.failureReason = `RESULT_UNREADABLE: ${(err as Error).message}`;
      return null;
    }
  }

  private observe(state: RunState): SessionObservation {
    let status = state.status;
    let result: NodeResult | null = null;
    let failureReason = state.failureReason;

    if (state.settled) {
      result = this.readResult(state);
      failureReason = state.failureReason;
      if (status === 'done') {
        if (result === null) {
          // A session that exits cleanly without a structured result has not
          // done anything the controller may act on.
          status = 'failed';
          failureReason ??= 'RESULT_MISSING';
        } else {
          status = statusForOutcome(result.outcome);
          if (status === 'failed' && failureReason === null) {
            failureReason = `WORKER_${result.outcome}`;
          }
        }
      }
    }

    return {
      status,
      exit_code: state.exitCode,
      turns: state.turns,
      usage: { ...state.usage, model_turns: state.turns },
      result,
      failure_reason: failureReason,
      timed_out: state.timedOut,
      last_progress_at: new Date(state.lastProgressMs).toISOString(),
    };
  }

  poll(handle: SessionHandle): SessionObservation {
    const state = this.runs.get(handle.session_id);
    if (!state) throw new Error(`Unknown session ${handle.session_id}`);
    return this.observe(state);
  }

  async wait(handle: SessionHandle): Promise<SessionObservation> {
    const state = this.runs.get(handle.session_id);
    if (!state) throw new Error(`Unknown session ${handle.session_id}`);
    await state.done;
    return this.observe(state);
  }

  stop(handle: SessionHandle): void {
    const state = this.runs.get(handle.session_id);
    if (!state) return;
    state.stopped = true;
    state.failureReason ??= 'STOPPED_BY_CONTROLLER';
    this.kill(state, 'stopped');
  }
}
