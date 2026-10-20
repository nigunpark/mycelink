import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { statusForOutcome, zeroObservationUsage, type NodeResult, type SessionAdapter, type SessionHandle, type SessionObservation, type SessionStatus, type SpawnRequest } from './adapter.js';
import type { UsageTotals } from '../model/types.js';
import { LineRedactor, redactValue } from '../security/redact.js';
import { planCommand } from '../security/exec.js';
import { buildWorkerPrompt, collectWorkerResult, loadPromptPack, prepareResultSlot, type WorkerGate } from './worker-protocol.js';
import type { ProviderStreamParser, StreamProgress } from './provider-stream.js';

type WorkerChild = ChildProcessByStdio<Writable, Readable, Readable>;
interface RunState extends StreamProgress {
  handle: SessionHandle;
  child: WorkerChild | null;
  request: SpawnRequest;
  startedAtMs: number;
  lastProgressMs: number;
  exitCode: number | null;
  settled: boolean;
  status: SessionStatus;
  failureReason: string | null;
  result: NodeResult | null;
  resultFailure: string | null;
  workerEnv: NodeJS.ProcessEnv;
  timedOut: boolean;
  stopped: boolean;
  done: Promise<void>;
  finish: () => void;
  timers: NodeJS.Timeout[];
  parser: ProviderStreamParser;
  codexEvidence?: SessionObservation['codex_evidence'];
  codexProvenance?: SessionObservation['codex_provenance'];
  cleanup?: () => void;
}

/** Shared process lifecycle; provider-specific argv and JSONL interpretation are injected. */
export abstract class ProcessSessionAdapter implements SessionAdapter {
  abstract readonly name: SessionHandle['adapter'];
  protected abstract readonly executable: string;
  protected abstract readonly parser: ProviderStreamParser;
  protected newParser(): ProviderStreamParser { return this.parser; }
  protected readonly requireCompletedTurn: boolean = false;
  protected abstract buildArgs(request: SpawnRequest, sessionId: string): string[];
  protected abstract gateLines(request: SpawnRequest): { gate: WorkerGate; line: string }[];
  protected workerPrompt(pack: ReturnType<typeof loadPromptPack>, request: SpawnRequest): string {
    return buildWorkerPrompt({ pack, gates: this.gateLines(request) });
  }
  protected startWorkerServices(_request: SpawnRequest): (() => void) | undefined { return undefined; }
  private readonly runs = new Map<string, RunState>();

  spawn(request: SpawnRequest): SessionHandle {
    const sessionId = randomUUID();
    mkdirSync(dirname(resolve(request.logPath)), { recursive: true });
    mkdirSync(dirname(resolve(request.resultPath)), { recursive: true });
    if (existsSync(request.resultPath)) rmSync(request.resultPath, { force: true });
    const handle: SessionHandle = {
      session_id: sessionId, adapter: this.name, pid: null, node_id: request.nodeId,
      claim_id: request.claimId, started_at: new Date().toISOString(),
      log_path: request.logPath, result_path: request.resultPath,
    };
    const workerEnv: NodeJS.ProcessEnv = {
      ...process.env, MYCELINK_FEATURE_ID: request.featureId, MYCELINK_NODE_ID: request.nodeId,
      MYCELINK_CLAIM_ID: request.claimId, MYCELINK_ATTEMPT: String(request.attempt), ...(request.env ?? {}),
    };
    delete workerEnv['MYCELINK_CONTEXT_PACK'];
    delete workerEnv['MYCELINK_RESULT_PATH'];
    let finish!: () => void;
    const done = new Promise<void>((res) => { finish = res; });
    const now = Date.now();
    const state: RunState = {
      handle, child: null, request, turns: 0, usage: zeroObservationUsage(),
      startedAtMs: now, lastProgressMs: now, exitCode: null, settled: false,
      status: 'working', failureReason: null, result: null, resultFailure: null,
      workerEnv, timedOut: false, stopped: false, done, finish, timers: [], parser: this.newParser(),
    };
    this.runs.set(sessionId, state);

    let prompt: string;
    let args: string[];
    try {
      const pack = loadPromptPack(request.contextPackPath, request, workerEnv);
      prompt = this.workerPrompt(pack, request);
      args = this.buildArgs(request, sessionId);
      prepareResultSlot(request.cwd);
      state.cleanup = this.startWorkerServices(request);
    } catch (err) {
      state.failureReason = (err as Error).message;
      this.settle(state, 'failed');
      return handle;
    }

    const plan = planCommand([this.executable, ...args]);
    const child = spawn(plan.file, plan.args, {
      cwd: request.cwd, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments,
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: workerEnv,
    }) as WorkerChild;
    state.child = child;
    handle.pid = child.pid ?? null;
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');

    const log = createWriteStream(resolve(request.logPath), { flags: 'a' });
    const outRedactor = new LineRedactor(workerEnv);
    const errRedactor = new LineRedactor(workerEnv);
    child.stdout.on('end', () => { const tail = outRedactor.flush(); if (tail) log.write(tail); });
    child.stderr.on('end', () => { const tail = errRedactor.flush(); if (tail) log.write(tail); });
    let buffer = '';
    let discardingOversizedLine = false;
    child.stdout.on('data', (chunk: Buffer) => {
      state.lastProgressMs = Date.now();
      const text = chunk.toString('utf8');
      log.write(outRedactor.push(text));
      // Keep framing bounded even if a provider emits an unterminated line forever.
      for (let offset = 0; offset < text.length; offset += 64 * 1024) {
        buffer += text.slice(offset, offset + 64 * 1024);
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!discardingOversizedLine && (line !== '' || state.parser.evidence)) state.parser.consume(line, state);
          discardingOversizedLine = false;
        }
        if (state.parser.evidence && buffer.length > 64 * 1024 && !discardingOversizedLine) {
          state.parser.consume(' '.repeat(64 * 1024 + 1), state);
          discardingOversizedLine = true;
        }
        if (discardingOversizedLine) buffer = '';
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
      // Wait for close and stdio end before ending the log or collecting the result.
    });
    child.on('close', (code) => {
      if (discardingOversizedLine && state.parser.evidence) state.parser.consume('', state);
      else if (buffer.trim()) state.parser.consume(buffer.trim(), state);
      if (state.exitCode !== 127) state.exitCode = code;
      this.settle(state, null, log);
    });
    return handle;
  }

  private kill(state: RunState, status: SessionStatus): void {
    if (state.settled || state.child === null) return;
    state.status = status;
    try { state.cleanup?.(); } catch { /* Still terminate the child if cleanup failed. */ }
    state.cleanup = undefined;
    try { state.child.kill('SIGKILL'); } catch { /* Already gone. */ }
  }

  private settle(state: RunState, forced: SessionStatus | null, log?: NodeJS.WritableStream): void {
    if (state.settled) return;
    state.settled = true;
    try { state.cleanup?.(); } catch { /* Preserve the process outcome; mailbox is no longer served. */ }
    state.cleanup = undefined;
    for (const t of state.timers) clearInterval(t);
    state.timers = [];
    state.usage.wall_clock_ms = Date.now() - state.startedAtMs;
    state.usage.sessions = 1;
    state.usage.model_turns = state.turns;
    if (state.parser.evidence) {
      state.codexEvidence = { ...state.parser.evidence(), process_session_id: state.handle.session_id };
      if (state.codexEvidence.terminal === 'invalid') {
        state.failureReason = 'PROVIDER_STREAM_INVALID';
      } else if (state.codexEvidence.terminal === 'incomplete') {
        state.failureReason = 'PROVIDER_STREAM_INCOMPLETE';
      }
    }
    if (log && 'end' in log) (log as unknown as { end(): void }).end();
    if (forced !== null) state.status = forced;
    else if (state.stopped) state.status = 'stopped';
    else if (state.status === 'stalled' || state.status === 'budget-exhausted') { /* Watchdog decided. */ }
    else if (state.codexEvidence?.terminal === 'invalid' || state.codexEvidence?.terminal === 'incomplete') state.status = 'failed';
    else if (state.providerFailure) {
      state.status = 'failed';
      state.failureReason = redactValue(state.providerFailure, state.workerEnv);
    } else if (state.exitCode !== 0) {
      state.status = 'failed';
      state.failureReason ??= `EXIT_${state.exitCode}`;
    } else if (this.requireCompletedTurn && state.turns === 0) {
      state.status = 'failed';
      state.failureReason = 'PROVIDER_STREAM_INCOMPLETE: no turn.completed event';
    } else state.status = 'done';
    if (state.child !== null) {
      try {
        const collected = collectWorkerResult(state.request.cwd, state.request, resolve(state.request.resultPath), state.workerEnv);
        state.result = collected.result;
        state.resultFailure = collected.failure;
      } catch (err) {
        state.resultFailure = `RESULT_UNREADABLE: ${(err as Error).message}`;
      }
    }
    if (state.parser.evidence) {
      const result = state.result;
      state.codexProvenance = {
        provider: 'codex', process_session_id: state.handle.session_id,
        worker_result: result === null ? null : {
          source: 'worktree-result-slot', attested: false,
          node_id: result.node_id, claim_id: result.claim_id,
          sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
        },
        reviewer_verdict: null,
      };
    }
    state.finish();
  }

  private observe(state: RunState): SessionObservation {
    let status = state.status;
    const result = state.settled ? state.result : null;
    let failureReason = state.failureReason;
    if (state.settled && status === 'done') {
      if (result === null) {
        status = 'failed';
        failureReason ??= state.resultFailure ?? 'RESULT_MISSING';
      } else {
        status = statusForOutcome(result.outcome);
        if (status === 'failed' && failureReason === null) failureReason = `WORKER_${result.outcome}`;
      }
    }
    return {
      ...(state.codexEvidence === undefined ? {} : { codex_evidence: state.codexEvidence }),
      ...(state.codexProvenance === undefined ? {} : { codex_provenance: state.codexProvenance }),
      status, exit_code: state.exitCode, turns: state.turns,
      usage: { ...state.usage, model_turns: state.turns }, result,
      failure_reason: failureReason, timed_out: state.timedOut,
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
