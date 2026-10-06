/**
 * A deterministic stand-in for Claude Code's Agent tool running the
 * `module-worker` subagent on a Mycelink dispatch ticket.
 *
 * It is held to what a host subagent can actually do: it shares the host's
 * working directory (not the worktree), so it edits files by absolute path
 * under `ticket.worktree`, runs the ticket's gate lines exactly as rendered
 * through a shell (like the Bash tool), commits with `git -C`, and writes
 * one JSON result to `ticket.result_slot`. It never touches controller state.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './git-fixture.js';

export interface DispatchTicket {
  schema: string;
  feature_id: string;
  node_id: string;
  claim_id: string;
  dispatch_id?: string | null;
  attempt: number;
  capability: string;
  agent: string;
  repository: string | null;
  worktree: string | null;
  branch: string | null;
  allowed_paths: string[];
  forbidden_paths: string[];
  verification_commands: { id: string; command: string[] }[];
  gate_commands: { gate: string; command: string }[];
  result_slot: string;
  settle_command: string;
  prompt: string;
  expires_at: string;
  resumed?: boolean;
  result_present?: boolean;
}

export interface AgentBehaviour {
  /** Files written before the RED gate (e.g. a failing test). */
  tests?: Record<string, string>;
  /** Implementation written after RED, committed before GREEN. */
  impl?: Record<string, string>;
  /** Skip the gates entirely (a worker that only claims success). */
  skipGates?: boolean;
  /** Leave the implementation uncommitted. */
  noCommit?: boolean;
  outcome?: 'SUBMITTED' | 'RETRYABLE' | 'BLOCKED' | 'NEEDS_DECISION' | 'BUDGET_EXHAUSTED';
  failure_fingerprint?: string | null;
  decision_request?: { question: string; options: string[] } | null;
  /** Do not write a result at all. */
  omitResult?: boolean;
  /** Fields merged over the result (tampering tests). */
  resultOverrides?: Record<string, unknown>;
}

export interface AgentRun {
  gates: { gate: string; exit: number }[];
  result: Record<string, unknown> | null;
}

function writeAll(root: string, files: Record<string, string> | undefined): string[] {
  const written: string[] = [];
  for (const [rel, body] of Object.entries(files ?? {})) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
    written.push(rel);
  }
  return written;
}

function runGate(ticket: DispatchTicket, gate: string, hostCwd: string): number {
  const line = ticket.gate_commands.find((g) => g.gate === gate)?.command;
  if (line === undefined) return 0;
  try {
    execSync(line, { cwd: hostCwd, stdio: 'pipe' });
    return 0;
  } catch (err) {
    return typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 1;
  }
}

/** Fulfil one ticket the way the module-worker subagent would. */
export function fakeAgent(ticket: DispatchTicket, behaviour: AgentBehaviour, hostCwd: string): AgentRun {
  const worktree = ticket.worktree ?? hostCwd;
  const gates: AgentRun['gates'] = [];
  const changed = writeAll(worktree, behaviour.tests);
  if (!behaviour.skipGates) gates.push({ gate: 'red', exit: runGate(ticket, 'red', hostCwd) });
  changed.push(...writeAll(worktree, behaviour.impl));
  if (!behaviour.noCommit && ticket.worktree !== null && changed.length > 0) {
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-q', '-m', `implement ${ticket.node_id}`]);
  }
  if (!behaviour.skipGates) {
    gates.push({ gate: 'green', exit: runGate(ticket, 'green', hostCwd) });
    gates.push({ gate: 'regression', exit: runGate(ticket, 'regression', hostCwd) });
  }
  if (behaviour.omitResult) return { gates, result: null };

  const failed = gates.find((g) => g.exit !== 0);
  const result: Record<string, unknown> = {
    schema_version: 1,
    node_id: ticket.node_id,
    claim_id: ticket.claim_id,
    ...(ticket.dispatch_id ? { dispatch_id: ticket.dispatch_id } : {}),
    outcome: behaviour.outcome ?? (failed ? 'RETRYABLE' : 'SUBMITTED'),
    commands: gates.map((g) => ({ command: [`gate:${g.gate}`], exit_code: g.exit })),
    commit_sha: ticket.worktree ? git(worktree, ['rev-parse', 'HEAD']) : null,
    changed_paths: changed,
    evidence_paths: [],
    failure_fingerprint: behaviour.failure_fingerprint ?? (failed ? `gate-${failed.gate}-exit-${failed.exit}` : null),
    decision_request: behaviour.decision_request ?? null,
    usage: { model_turns: 3, input_tokens: 300, output_tokens: 150 },
    ...(behaviour.resultOverrides ?? {}),
  };
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2), 'utf8');
  return { gates, result };
}
