/**
 * In-process deterministic session adapter.
 *
 * Used by unit-level tests of the orchestration loop where spawning a process
 * is not the thing under test. Every node must be scripted; an unscripted node
 * fails loudly rather than quietly succeeding, so a test can never pass
 * because a node was forgotten.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  zeroObservationUsage,
  type NodeResult,
  type SessionAdapter,
  type SessionHandle,
  type SessionObservation,
  type SessionStatus,
  type SpawnRequest,
} from './adapter.js';
import type { UsageTotals } from '../model/types.js';

export interface ScriptedOutcome {
  status: SessionStatus;
  result?: NodeResult | null;
  usage?: Partial<UsageTotals>;
  failure_reason?: string | null;
  exit_code?: number | null;
  /** Side effect applied in the worktree before the result is reported. */
  write_files?: Record<string, string>;
}

/** A script may hold one outcome per node, or one per attempt. */
export type Script = Record<string, ScriptedOutcome | ScriptedOutcome[]>;

export class FakeInProcessAdapter implements SessionAdapter {
  readonly name = 'fake-claude' as const;
  spawnCount = 0;
  readonly requests: SpawnRequest[] = [];
  private readonly observations = new Map<string, SessionObservation>();
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  private outcomeFor(request: SpawnRequest): ScriptedOutcome | null {
    const entry = this.script[request.nodeId];
    if (entry === undefined) return null;
    if (Array.isArray(entry)) {
      return entry[Math.min(request.attempt - 1, entry.length - 1)] ?? null;
    }
    return entry;
  }

  spawn(request: SpawnRequest): SessionHandle {
    this.spawnCount += 1;
    this.requests.push(request);
    const sessionId = randomUUID();
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

    const scripted = this.outcomeFor(request);
    if (scripted === null) {
      this.observations.set(sessionId, {
        status: 'failed',
        exit_code: 1,
        turns: 0,
        usage: zeroObservationUsage(),
        result: null,
        failure_reason: 'UNSCRIPTED_NODE',
        timed_out: false,
        last_progress_at: new Date().toISOString(),
      });
      return handle;
    }

    for (const [rel, content] of Object.entries(scripted.write_files ?? {})) {
      const full = resolve(request.cwd, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }

    const result = scripted.result ?? null;
    if (result !== null) {
      mkdirSync(dirname(resolve(request.resultPath)), { recursive: true });
      writeFileSync(resolve(request.resultPath), JSON.stringify(result, null, 2), 'utf8');
    }

    const usage: UsageTotals = {
      ...zeroObservationUsage(),
      ...scripted.usage,
      sessions: 1,
    };

    this.observations.set(sessionId, {
      status: scripted.status,
      exit_code: scripted.exit_code ?? (scripted.status === 'done' ? 0 : 1),
      turns: usage.model_turns,
      usage,
      result,
      failure_reason: scripted.failure_reason ?? null,
      timed_out: scripted.status === 'budget-exhausted',
      last_progress_at: new Date().toISOString(),
    });
    return handle;
  }

  poll(handle: SessionHandle): SessionObservation {
    const obs = this.observations.get(handle.session_id);
    if (!obs) throw new Error(`Unknown session ${handle.session_id}`);
    return obs;
  }

  async wait(handle: SessionHandle): Promise<SessionObservation> {
    return this.poll(handle);
  }

  stop(handle: SessionHandle): void {
    const obs = this.observations.get(handle.session_id);
    if (obs) this.observations.set(handle.session_id, { ...obs, status: 'stopped' });
  }
}
