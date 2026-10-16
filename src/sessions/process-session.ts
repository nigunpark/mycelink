import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { statusForOutcome, zeroObservationUsage, type NodeResult, type SessionAdapter, type SessionHandle, type SessionObservation, type SessionStatus, type SpawnRequest } from './adapter.js';
import type { UsageTotals } from '../model/types.js';
import { LineRedactor } from '../security/redact.js';
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
}

/** Shared process lifecycle; provider-specific argv and JSONL interpretation are injected. */
export abstract class ProcessSessionAdapter implements SessionAdapter {
  abstract readonly name: SessionHandle['adapter'];
  protected abstract readonly executable: string;
  protected abstract readonly parser: ProviderStreamParser;
  protected abstract buildArgs(request: SpawnRequest, sessionId: string): string[];
  protected abstract gateLines(request: SpawnRequest): { gate: WorkerGate; line: string }[];
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
      workerEnv, timedOut: false, stopped: false, done, finish, timers: [],
    };
    this.runs.set(sessionId, state);

    let prompt: string;
    let args: string[];
    try {
      const pack = loadPromptPack(request.contextPackPath, request, workerEnv);
      prompt = buildWorkerPrompt({ pack, gates: this.gateLines(request) });
      args = this.buildArgs(request, sessionId);
      prepareResultSlot(request.cwd);
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
    child.stdout.on('data', (chunk: Buffer) => {
      state.lastProgressMs = Date.now();
      const text = chunk.toString('utf8');
      log.write(outRedactor.push(text));
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line !== '') this.parser.consume(line, state);
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
      if (buffer.trim()) this.parser.consume(buffer.trim(), state);
      if (state.exitCode !== 127) state.exitCode = code;
      this.settle(state, null, log);
    });
    return handle;
  }

  private kill(state: RunState, status: SessionStatus): void {
    if (state.settled || state.child === null) return;
    state.status = status;
    try { state.child.kill('SIGKILL'); } catch { /* Already gone. */ }
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
    if (forced !== null) state.status = forced;
    else if (state.stopped) state.status = 'stopped';
    else if (state.status === 'stalled' || state.status === 'budget-exhausted') { /* Watchdog decided. */ }
    else if (state.exitCode !== 0) {
      state.status = 'failed';
      state.failureReason ??= `EXIT_${state.exitCode}`;
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
