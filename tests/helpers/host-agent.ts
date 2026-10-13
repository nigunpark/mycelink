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
  tdd?: { base_sha: string | null; policy_sha256: string; test_paths: string[]; production_roots: string[]; declaration_paths: string[] } | null;
  acceptance_criteria?: { id: string; text: string; kind?: string }[];
}

/** One more red -> production cycle after the first. */
export interface AgentCycle {
  tests: Record<string, string>;
  impl: Record<string, string>;
}

export interface AgentBehaviour {
  /** Files written before the RED gate (e.g. a failing test). */
  tests?: Record<string, string>;
  /** Implementation written after RED, committed before GREEN. */
  impl?: Record<string, string>;
  /** Commits made before the first RED: `[files, message]` (e.g. a declarations-only change). */
  before?: { files: Record<string, string>; message: string }[];
  /** Production files written before the RED gate runs (an agent stubbing code to make its test compile). */
  productionBeforeRed?: Record<string, string>;
  /** Test files changed after the red gate accepted the RED, before the test commit. */
  editTestsAfterRed?: Record<string, string>;
  /** Commit the tests and the implementation together, after GREEN (the first pilot's workers). */
  mixed?: boolean;
  /** Further complete cycles: tests, red gate, test commit, implementation, green gate, production commit. */
  cycles?: AgentCycle[];
  /** Test files committed alone after the production commit, with no production after them (the second pilot's gateway worker). */
  testsAfter?: Record<string, string>;
  /** Report this commit as `commit_sha` instead of HEAD: 'red' names the first test-only commit. */
  reportCommit?: 'red';
  /** Report the worker's own `tdd` claim (base, head, cycles) in the result. */
  reportTdd?: boolean;
  /** Skip the gates entirely (a worker that only claims success). */
  skipGates?: boolean;
  /** Leave the implementation uncommitted. */
  noCommit?: boolean;
  outcome?: 'SUBMITTED' | 'RETRYABLE' | 'BLOCKED' | 'NEEDS_DECISION' | 'BUDGET_EXHAUSTED';
  failure_fingerprint?: string | null;
  decision_request?: { question: string; options: string[] } | null;
  /** Do not write a result at all. */
  omitResult?: boolean;
  /** Criterion evidence to report instead of the one derived from the tests and gates (tampering tests). */
  criterionEvidence?: unknown;
  /** Fields merged over the result (tampering tests). */
  resultOverrides?: Record<string, unknown>;
}

export interface AgentRun {
  gates: { gate: string; exit: number }[];
  result: Record<string, unknown> | null;
  /** Commits the agent made, oldest first, with their kind. */
  commits: { sha: string; kind: 'test' | 'production' | 'mixed' | 'other' }[];
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

/** The evidence hash each gate printed, by claim and gate: what a worker names in its criterion evidence. */
const printed = new Map<string, string>();
/** The test a node's recorded RED declared first, by node. */
const redTests = new Map<string, { path: string; name: string }>();

function runGate(ticket: DispatchTicket, gate: string, hostCwd: string): number {
  const line = ticket.gate_commands.find((g) => g.gate === gate)?.command;
  if (line === undefined) return 0;
  let out = '';
  let code = 0;
  try {
    out = execSync(line, { cwd: hostCwd, stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = typeof e.status === 'number' ? e.status : 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const sha = /sha256 ([0-9a-f]{64})/.exec(out)?.[1];
  if (code === 0 && sha !== undefined) {
    printed.set(`${ticket.claim_id}:${gate}`, sha);
    // A RED stays on record across claims of the node: a reclaimed worker names it again.
    if (gate === 'red') printed.set(`node:${ticket.node_id}:red`, sha);
  }
  return code;
}

/** Test names a JS test file declares (`test('x')` / `it('x')`), in order. */
export function declaredNames(source: string): string[] {
  return [...source.matchAll(/(?<![\w$.])(?:it|test)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2] as string);
}

/**
 * Fulfil one ticket the way the module-worker subagent would, keeping the
 * worker contract's history: the tests committed alone once the red gate
 * accepted them, the implementation committed alone once green passed.
 * A refused red gate leads to no production edit; a failed green to no
 * production commit (the implementation is rolled back). The other
 * behaviours act out the histories real workers produced.
 */
export function fakeAgent(ticket: DispatchTicket, behaviour: AgentBehaviour, hostCwd: string): AgentRun {
  const worktree = ticket.worktree ?? hostCwd;
  const gates: AgentRun['gates'] = [];
  const commits: AgentRun['commits'] = [];
  const startHead = ticket.worktree ? git(worktree, ['rev-parse', 'HEAD']) : null;
  const commit = (paths: string[], message: string, kind: AgentRun['commits'][number]['kind']): void => {
    if (behaviour.noCommit || ticket.worktree === null || paths.length === 0) return;
    git(worktree, ['add', '-A', '--', ...paths]);
    if (git(worktree, ['diff', '--cached', '--name-only']) !== '') {
      git(worktree, ['commit', '-q', '-m', message]);
      commits.push({ sha: git(worktree, ['rev-parse', 'HEAD']), kind });
    }
  };
  for (const step of behaviour.before ?? []) commit(writeAll(worktree, step.files), step.message, 'other');
  const tests = writeAll(worktree, behaviour.tests);
  const changed = [...tests];
  const stubs = writeAll(worktree, behaviour.productionBeforeRed);
  changed.push(...stubs);
  const offered = (gate: string): boolean => ticket.gate_commands.some((g) => g.gate === gate);
  const red = behaviour.skipGates ? 0 : runGate(ticket, 'red', hostCwd);
  // A node with no red gate (declarations only) starts at green.
  if (!behaviour.skipGates && offered('red')) gates.push({ gate: 'red', exit: red });
  if (red === 0) {
    changed.push(...writeAll(worktree, behaviour.editTestsAfterRed));
    if (!behaviour.mixed) commit([...tests, ...Object.keys(behaviour.editTestsAfterRed ?? {})], `test: ${ticket.node_id} (RED)`, 'test');
    const impl = writeAll(worktree, behaviour.impl);
    changed.push(...impl);
    const green = behaviour.skipGates ? 0 : runGate(ticket, 'green', hostCwd);
    if (!behaviour.skipGates) gates.push({ gate: 'green', exit: green });
    if (green === 0) {
      if (behaviour.mixed) commit([...tests, ...impl, ...stubs], `feat: ${ticket.node_id} with its tests`, 'mixed');
      else commit([...impl, ...stubs], `implement ${ticket.node_id}`, 'production');
      for (const cycle of behaviour.cycles ?? []) {
        const more = writeAll(worktree, cycle.tests);
        changed.push(...more);
        const again = runGate(ticket, 'red', hostCwd);
        gates.push({ gate: 'red', exit: again });
        if (again !== 0) break;
        commit(more, `test: ${ticket.node_id} (RED, next cycle)`, 'test');
        const code = writeAll(worktree, cycle.impl);
        changed.push(...code);
        const pass = runGate(ticket, 'green', hostCwd);
        gates.push({ gate: 'green', exit: pass });
        if (pass !== 0) break;
        commit(code, `implement ${ticket.node_id} (next cycle)`, 'production');
      }
      const after = writeAll(worktree, behaviour.testsAfter);
      changed.push(...after);
      commit(after, `test: cover more of ${ticket.node_id}`, 'test');
    } else if (ticket.worktree !== null && impl.length > 0) {
      git(worktree, ['checkout', '--', '.']);
      git(worktree, ['clean', '-q', '-fd', '--', ...impl]);
    }
    if (!behaviour.skipGates && green === 0) gates.push({ gate: 'regression', exit: runGate(ticket, 'regression', hostCwd) });
  }
  if (behaviour.omitResult) return { gates, result: null, commits };

  const head = ticket.worktree ? git(worktree, ['rev-parse', 'HEAD']) : null;
  const firstTest = commits.find((c) => c.kind === 'test')?.sha ?? null;
  const failed = gates.find((g) => g.exit !== 0);
  const tddClaim = (): Record<string, unknown> => {
    // Cycles as the agent sees them: each run of test commits, then the production commits after it.
    const cycles: { red_commits: string[]; green_commits: string[] }[] = [];
    for (const c of commits) {
      if (c.kind === 'test') {
        const last = cycles[cycles.length - 1];
        if (last && last.green_commits.length === 0) last.red_commits.push(c.sha);
        else cycles.push({ red_commits: [c.sha], green_commits: [] });
      } else if (c.kind === 'production') cycles[cycles.length - 1]?.green_commits.push(c.sha);
    }
    return { base_sha: ticket.tdd?.base_sha ?? startHead, head_sha: head, cycles };
  };
  const result: Record<string, unknown> = {
    schema_version: 1,
    node_id: ticket.node_id,
    claim_id: ticket.claim_id,
    ...(ticket.dispatch_id ? { dispatch_id: ticket.dispatch_id } : {}),
    outcome: behaviour.outcome ?? (failed ? 'RETRYABLE' : 'SUBMITTED'),
    commands: gates.map((g) => ({ command: [`gate:${g.gate}`], exit_code: g.exit })),
    commit_sha: behaviour.reportCommit === 'red' ? firstTest : head,
    changed_paths: changed,
    evidence_paths: [],
    failure_fingerprint: behaviour.failure_fingerprint ?? (failed ? `gate-${failed.gate}-exit-${failed.exit}` : null),
    decision_request: behaviour.decision_request ?? null,
    usage: { model_turns: 3, input_tokens: 300, output_tokens: 150 },
    ...(behaviour.reportTdd && head !== null ? { tdd: tddClaim() } : {}),
    ...criterionEvidence(ticket, behaviour),
    ...(behaviour.resultOverrides ?? {}),
  };
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2), 'utf8');
  return { gates, result, commits };
}

/**
 * What a worker reports for its node's criteria: each one proved by the
 * first test its RED declared and the hash the red gate printed, or — for a
 * node with no red gate (declarations only) — by its GREEN alone.
 */
function criterionEvidence(ticket: DispatchTicket, behaviour: AgentBehaviour): Record<string, unknown> {
  if (behaviour.criterionEvidence !== undefined) return { criterion_evidence: behaviour.criterionEvidence };
  const acs = ticket.acceptance_criteria ?? [];
  if (acs.length === 0) return {};
  const red = printed.get(`${ticket.claim_id}:red`);
  const green = printed.get(`${ticket.claim_id}:green`);
  // The red gate printed last ran the last cycle's tests.
  const lastTests = behaviour.cycles?.at(-1)?.tests ?? behaviour.tests ?? {};
  const tests = Object.entries(lastTests).flatMap(([path, body]) => declaredNames(body).map((name) => ({ path, name })));
  let first = tests[0];
  if (red !== undefined && first !== undefined) redTests.set(ticket.node_id, first);
  if (red === undefined && first === undefined && printed.has(`node:${ticket.node_id}:red`)) {
    first = redTests.get(ticket.node_id);
    if (first !== undefined) return { criterion_evidence: acs.map((a) => ({ criterion: a.id, test: first, gate: 'red', output_sha256: printed.get(`node:${ticket.node_id}:red`) })) };
  }
  if (red !== undefined && first !== undefined) return { criterion_evidence: acs.map((a) => ({ criterion: a.id, test: first, gate: 'red', output_sha256: red })) };
  if (!ticket.gate_commands.some((g) => g.gate === 'red') && green !== undefined) return { criterion_evidence: acs.map((a) => ({ criterion: a.id, gate: 'green', output_sha256: green })) };
  return {};
}
