/**
 * A deterministic module-worker for the shop portfolio, held to what a host
 * subagent can do: it edits files under the ticket's worktree, runs the
 * ticket's gate lines exactly as rendered, commits with git -C, and writes
 * one JSON result to the ticket's slot. Its RED commit holds the tests
 * alone, its production commit the implementation alone.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './git-fixture.js';

export interface ShopTicket {
  node_id: string;
  claim_id: string;
  dispatch_id?: string | null;
  capability: string;
  worktree: string;
  result_slot: string;
  prompt: string;
  gate_commands: { gate: string; command: string }[];
  verification?: Record<string, unknown> | null;
  acceptance_criteria?: { id: string; text: string; kind?: string }[];
  tdd?: { base_sha: string | null } | null;
}

/** A test a gate printed with its canonical id. */
export interface GateTest {
  id: string;
  status: string;
  path: string;
  full_name: string;
}

export interface GateRun {
  gate: string;
  code: number;
  out: string;
  /** The evidence hash the gate printed. */
  sha256: string | null;
  /** The tests the gate printed with their ids. */
  tests: GateTest[];
}

/** The `<id> <status> <path> › <full name>` lines a gate prints for the tests it ran. */
export function gateTests(out: string): GateTest[] {
  return [...out.matchAll(/^ {2}([0-9a-f]{16}) (passed|failed|skipped) (.+?) › (.*)$/gm)].map((m) => ({ id: m[1] as string, status: m[2] as string, path: m[3] as string, full_name: m[4] as string }));
}

/** The context pack a ticket's prompt carries. */
export function packOf(ticket: { prompt: string }): Record<string, any> {
  const m = /<mycelink-context-pack>\s*([\s\S]*?)\s*<\/mycelink-context-pack>/.exec(ticket.prompt);
  if (!m) throw new Error('no context pack in the prompt');
  // The pack's <, >, & and backticks are \u-escaped inside JSON strings: JSON.parse reads them back.
  return JSON.parse(m[1] as string) as Record<string, any>;
}

export function writeFiles(root: string, files: Record<string, string>): string[] {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return Object.keys(files);
}

/** Run one of the ticket's gate lines as the worker's Bash tool would, from `cwd`. */
export function runGate(ticket: ShopTicket, gate: string, cwd: string): GateRun {
  const line = ticket.gate_commands.find((g) => g.gate === gate)?.command;
  if (line === undefined) throw new Error(`the ticket for ${ticket.node_id} offers no ${gate} gate`);
  let code = 0;
  let out = '';
  try {
    out = execSync(line, { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return { gate, code, out, sha256: /sha256 ([0-9a-f]{64})/.exec(out)?.[1] ?? null, tests: gateTests(out) };
}

/** The bound tests a worker looks up by words (`mycelink tdd tests`), from `cwd`, with its ticket's capability. */
export function lookupTests(ticket: ShopTicket, cwd: string, args: string[]): { code: number; out: string; tests: GateTest[] } {
  const gate = ticket.gate_commands.find((g) => g.gate === 'red' || g.gate === 'green')?.command;
  if (gate === undefined) throw new Error(`the ticket for ${ticket.node_id} offers no gate`);
  // The gate line with `tests` for the phase: the same launcher, feature, node, control root and capability.
  const line = gate.replace(/ tdd (red|green) /, ' tdd tests ') + (args.length > 0 ? ` ${args.map((a) => (/^[A-Za-z0-9_.=:/-]+$/.test(a) ? a : `"${a}"`)).join(' ')}` : '');
  let code = 0;
  let out = '';
  try {
    out = execSync(line, { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return { code, out, tests: gateTests(out) };
}

export function commit(worktree: string, paths: string[], message: string): string | null {
  git(worktree, ['add', '-A', '--', ...paths]);
  if (git(worktree, ['diff', '--cached', '--name-only']) === '') return null;
  git(worktree, ['commit', '-q', '-m', message]);
  return git(worktree, ['rev-parse', 'HEAD']);
}

export interface CriterionItem {
  criterion: string;
  /** A test reference: the legacy evidence without `test_id`, and only display beside one. */
  path?: string;
  name?: string;
  gate: 'red' | 'green' | 'regression';
  /** The test's canonical id, given. */
  test_id?: string;
  /** The test's canonical id, picked from what the item's gate printed by its full name. */
  full_name?: string;
}

export interface ShopWork {
  tests?: Record<string, string>;
  impl?: Record<string, string>;
  /** The criterion evidence to report: gate output hashes are filled in from the gates this worker ran. */
  criteria?: CriterionItem[];
  /** Report this instead of the computed criterion evidence. */
  criterionEvidence?: unknown;
}

export interface ShopRun {
  gates: GateRun[];
  result: Record<string, unknown>;
}

/**
 * Fulfil a ticket: the tests, red, the test commit, the implementation,
 * green, the production commit, regression — or, for a node reopened with
 * its RED on record (`next_required_gate` GREEN_VERIFIED), green and
 * regression only. A refused gate ends the attempt RETRYABLE.
 */
export function fulfil(ticket: ShopTicket, work: ShopWork, hostCwd: string): ShopRun {
  const pack = packOf(ticket);
  const gates: GateRun[] = [];
  const regreen = pack['next_required_gate'] === 'GREEN_VERIFIED';
  const go = (gate: string): boolean => {
    const r = runGate(ticket, gate, hostCwd);
    gates.push(r);
    return r.code === 0;
  };
  let ok = true;
  if (!regreen && work.tests !== undefined) {
    const tests = writeFiles(ticket.worktree, work.tests);
    ok = go('red');
    if (ok) commit(ticket.worktree, tests, `test: ${ticket.node_id} (RED)`);
  }
  if (ok && !regreen && work.impl !== undefined) {
    const impl = writeFiles(ticket.worktree, work.impl);
    ok = go('green');
    if (ok) commit(ticket.worktree, impl, `feat: ${ticket.node_id}`);
  } else if (ok && regreen) {
    ok = go('green');
  }
  if (ok) ok = go('regression');
  const hashOf = (gate: string): string | null => [...gates].reverse().find((g) => g.gate === gate && g.code === 0)?.sha256 ?? null;
  const redRecorded = (pack['latest_evidence'] as { kind: string; output_sha256?: string }[] | undefined)?.find((e) => e.kind === 'red')?.output_sha256 ?? null;
  // The id of the test the item's gate printed under that full name (and path, when the item names one).
  const printedId = (c: CriterionItem): string | undefined => {
    const run = [...gates].reverse().find((g) => g.gate === c.gate && g.code === 0);
    const hit = run?.tests.find((t) => t.full_name === c.full_name && (c.path === undefined || t.path === c.path));
    if (hit === undefined) throw new Error(`the ${c.gate} gate printed no test ${c.full_name}: ${run?.out.slice(-1200) ?? '(not run)'}`);
    return hit.id;
  };
  const criterion_evidence =
    work.criterionEvidence ??
    (work.criteria ?? []).map((c) => {
      const id = c.test_id ?? (c.full_name !== undefined ? printedId(c) : undefined);
      return {
        criterion: c.criterion,
        ...(id !== undefined ? { test_id: id } : {}),
        ...(c.path !== undefined && c.name !== undefined ? { test: { path: c.path, name: c.name } } : {}),
        gate: c.gate,
        output_sha256: (c.gate === 'red' ? (hashOf('red') ?? redRecorded) : hashOf(c.gate)) ?? '0'.repeat(64),
      };
    });
  const head = git(ticket.worktree, ['rev-parse', 'HEAD']);
  const failed = gates.find((g) => g.code !== 0);
  const result: Record<string, unknown> = {
    schema_version: 1,
    node_id: ticket.node_id,
    claim_id: ticket.claim_id,
    ...(ticket.dispatch_id ? { dispatch_id: ticket.dispatch_id } : {}),
    outcome: failed ? 'RETRYABLE' : 'SUBMITTED',
    commands: gates.map((g) => ({ command: [`gate:${g.gate}`], exit_code: g.code })),
    commit_sha: head,
    changed_paths: [...Object.keys(work.tests ?? {}), ...Object.keys(work.impl ?? {})],
    evidence_paths: [],
    failure_fingerprint: failed ? `gate-${failed.gate}-exit-${failed.code}` : null,
    decision_request: null,
    ...(Array.isArray(criterion_evidence) && criterion_evidence.length === 0 ? {} : { criterion_evidence }),
  };
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2));
  return { gates, result };
}
