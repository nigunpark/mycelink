/**
 * CSET-203 r6's acceptance-review challenge, step by step on the version
 * fixture. R001 found AC-1 with a public reproduction the apply-release-plan
 * code already satisfies (a rollback of a file the run created), plus r3's
 * AC-3 and AC-5 gaps on the cli. The apply-release-plan rework worker writes
 * exactly that reproduction as a focused test; the red gate runs it on the
 * unchanged integrated head and it passes ("the RED does not fail"). r6's
 * worker answered BLOCKED REVIEW_GAP_NOT_REPRODUCED:AC-1 and the node was
 * parked; here the worker challenges the gap with a structured
 * REVIEW_GAP_CHALLENGE instead, and a fresh reviewer refines it.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './git-fixture.js';
import { ARP_RED, ARP_TESTS, CLI_FAILURE_RED, CLI_TESTS, VER_FEATURE, verCli, type Ver } from './version-fixture.js';
import { packOf, runGate, writeFiles, type GateRun, type ShopTicket } from './shop-worker.js';
import { reviewed, GAP_AC3, GAP_AC5 } from './cset203-rework.js';
import type { VerdictOverride } from './review-agent.js';

/** R001's AC-1 gap as r6's reviewer reproduced it: a rollback of a file the run created — which the code already does. */
export const AC1_HOLDS_REPRODUCTION =
  'apply a plan whose first change creates packages/b/CHANGELOG.md and whose formatter then fails on packages/b/package.json; assert packages/b/CHANGELOG.md is absent afterwards, packages/b/package.json is back to its exact previous content and error.cause is the injected failure';
export const GAP_AC1_HOLDS: VerdictOverride = {
  gap: { missing: 'rollback of a file the run created is never exercised: the only failing test fails after files it changed', reproduction: AC1_HOLDS_REPRODUCTION, producer: { module: 'changesets:packages/apply-release-plan/src/index.mjs' } },
};

/** The worker's exact focused test of that reproduction: it passes on the integrated code. */
export const ARP_CHALLENGE_TEST = 'removes a changelog it created when a later change fails, with the original error as the cause';
export const ARP_CHALLENGE_BODY = `
test('${ARP_CHALLENGE_TEST}', async () => {
  const files = new Map([['packages/b/package.json', '{"version":"1.0.0"}']]);
  const failure = new Error('formatter crashed');
  const plan = [{ path: 'packages/b/CHANGELOG.md', content: '# b' }, { path: 'packages/b/package.json', content: '{"version":"1.1.0"}' }];
  const error = await applyReleasePlan(files, plan, { format: async (path) => { if (path === 'packages/b/package.json') throw failure; } }).then(() => null, (e) => e);
  assert.equal(error.cause, failure);
  assert.equal(files.has('packages/b/CHANGELOG.md'), false, 'the changelog it created is gone');
  assert.deepEqual([...files], [['packages/b/package.json', '{"version":"1.0.0"}']]);
});
`;
export const ARP_CHALLENGE_RED = `${ARP_RED}${ARP_CHALLENGE_BODY}`;

/** The boundary hidden acceptance checks, as the refinement reproduces it: a changelog write that fails part-way after the package version write. */
export const AC1_REFINED = {
  missing: 'a changelog write that fails part-way after the package version was written is never rolled back: the half-written changelog is left as the failed write left it',
  reproduction:
    'make the changelog writer fail part-way (a partial write, as a full disk would) after the package version write; assert every file, the half-written changelog included, is restored to its exact previous bytes and the rejection cause is the writer failure',
};

/** A clause traced by a challenge: the test, the assertion lines in its file, what it checks. */
export interface ChallengeClause {
  clause: string;
  test_id: string;
  assertions: string[];
  trace: string;
}

/** The 1-based line of `needle` in `source` (its first occurrence after `after`). */
export function lineOf(source: string, needle: string, after = 0): number {
  const lines = source.split('\n');
  for (let i = after; i < lines.length; i++) if ((lines[i] as string).includes(needle)) return i + 1;
  throw new Error(`no line holds ${needle}`);
}

/** A ticket line of the brief: `- <name> (...): <line>`. */
export function briefLine(ticket: { prompt: string }, name: string): string | null {
  return new RegExp(`^- ${name}(?: \\([^)]*\\))?: (.+)$`, 'm').exec(ticket.prompt)?.[1] ?? null;
}

/** Run a line of the brief as the worker's Bash tool would, from `cwd`: its exit code and JSON. */
export function runJsonLine(line: string, cwd: string): { code: number; out: Record<string, any>; raw: string } {
  try {
    const raw = execSync(line, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: JSON.parse(raw) as Record<string, any>, raw };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    let out: Record<string, any> = {};
    try {
      out = JSON.parse(e.stdout ?? '{}') as Record<string, any>;
    } catch {
      // not JSON
    }
    return { code: e.status ?? 1, out, raw: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The brief's challenge line (what a review-gap challenge binds; read-only), as JSON. */
export function challengeSkeleton(t: ShopTicket, cwd: string): { code: number; out: Record<string, any>; raw: string } {
  const line = briefLine(t, 'challenge');
  if (line === null) throw new Error(`the brief of ${t.node_id} offers no challenge line`);
  return runJsonLine(`${line} --json`, cwd);
}

/** The brief's check line, as JSON: the result in the slot judged as settle will. */
export function checkLine(t: ShopTicket, cwd: string): { code: number; out: Record<string, any>; raw: string } {
  const line = briefLine(t, 'check');
  if (line === null) throw new Error(`the brief of ${t.node_id} offers no check line`);
  return runJsonLine(`${line} --json`, cwd);
}

export interface ChallengeWork {
  /** The focused tests to write (default: ARP_CHALLENGE_RED in ARP_TESTS). */
  tests?: Record<string, string>;
  /** Commit the tests alone, test-only, before the challenge (a disposable challenge commit). */
  commit?: boolean;
  /** The clauses the challenge traces, from the test file and the passing test's id. */
  clauses?: (source: string, testId: string) => ChallengeClause[];
  /** The test the clauses cite (default ARP_CHALLENGE_TEST). */
  test?: string;
  /** Change the challenge before it is written. */
  mutate?: (challenge: Record<string, any>) => void;
  explanation?: string;
}

/** AC-1's two clauses, each traced to the focused test's own assertion lines. */
export function arpClauses(source: string, testId: string): ChallengeClause[] {
  const start = lineOf(source, ARP_CHALLENGE_TEST);
  const cause = lineOf(source, 'assert.equal(error.cause, failure);', start);
  const gone = lineOf(source, "assert.equal(files.has('packages/b/CHANGELOG.md'), false", start);
  const exact = lineOf(source, "assert.deepEqual([...files], [['packages/b/package.json'", start);
  return [
    { clause: 'AC-1.1', test_id: testId, assertions: [`file:changesets:${ARP_TESTS}#L${gone}-L${exact}`], trace: 'the created changelog is absent and package.json holds its exact previous bytes after the formatter failure the test injects' },
    { clause: 'AC-1.2', test_id: testId, assertions: [`file:changesets:${ARP_TESTS}#L${cause}`], trace: 'the rejection cause is the injected formatter failure itself' },
  ];
}

/**
 * The challenge worker: the exact focused test, the red gate (refused: its
 * declared tests pass), the challenge line, the REVIEW_GAP_CHALLENGE result in
 * the slot. Returns the red run, the skeleton and the result written.
 */
export function writeChallenge(t: ShopTicket, control: string, work: ChallengeWork = {}): { red: GateRun; skeleton: Record<string, any>; result: Record<string, any> } {
  const tests = work.tests ?? { [ARP_TESTS]: ARP_CHALLENGE_RED };
  writeFiles(t.worktree, tests);
  const red = runGate(t, 'red', control);
  if (work.commit === true) {
    git(t.worktree, ['add', '--', ...Object.keys(tests)]);
    git(t.worktree, ['commit', '-q', '-m', 'test: the review reproduction, as a challenge']);
  }
  const skeleton = challengeSkeleton(t, control);
  if (skeleton.code !== 0) throw new Error(`the challenge line refused: ${skeleton.raw}`);
  const challenge = structuredClone(skeleton.out['challenge']) as Record<string, any>;
  const path = Object.keys(tests)[0] as string;
  const source = readFileSync(join(t.worktree, ...path.split('/')), 'utf8');
  const name = work.test ?? ARP_CHALLENGE_TEST;
  const testId = (skeleton.out['tests'] as { id: string; full_name: string }[]).find((x) => x.full_name === name)?.id;
  if (testId === undefined) throw new Error(`the challenge line names no passing test ${name}: ${skeleton.raw}`);
  for (const gap of challenge['gaps'] as Record<string, any>[]) {
    gap['tests'] = [testId];
    gap['clauses'] = (work.clauses ?? arpClauses)(source, testId);
    gap['explanation'] = work.explanation ?? `The review's exact reproduction, written as ${name}, passes on the unchanged integrated head: the rollback already restores a file the run created.`;
  }
  work.mutate?.(challenge);
  const result = {
    schema_version: 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: 'REVIEW_GAP_CHALLENGE',
    commands: [{ command: ['gate:red'], exit_code: red.code }],
    commit_sha: git(t.worktree, ['rev-parse', 'HEAD']),
    changed_paths: Object.keys(tests),
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    challenge,
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return { red, skeleton: skeleton.out, result };
}

/** r6's own answer: BLOCKED REVIEW_GAP_NOT_REPRODUCED, the worktree restored, nothing committed. */
export function writeLegacyBlocked(t: ShopTicket, criterion = 'AC-1'): void {
  git(t.worktree, ['checkout', '--', '.']);
  git(t.worktree, ['clean', '-fdq']);
  const result = {
    schema_version: 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: 'BLOCKED',
    commands: [{ command: ['mycelink', 'tdd', 'red', VER_FEATURE, t.node_id], exit_code: 1 }],
    commit_sha: git(t.worktree, ['rev-parse', 'HEAD']),
    changed_paths: [],
    evidence_paths: [],
    failure_fingerprint: `REVIEW_GAP_NOT_REPRODUCED:${criterion}`,
    decision_request: null,
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
}

/** R001 as r6's: AC-1 (a reproduction the code satisfies) on apply-release-plan, AC-3 and AC-5 on the cli. */
export async function r6Reviewed(): Promise<Awaited<ReturnType<typeof reviewed>>> {
  return reviewed({ 'AC-1': GAP_AC1_HOLDS, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
}

/** `review status` and `feature status`, as JSON. */
export async function reviewStatus(s: Ver): Promise<Record<string, any>> {
  return JSON.parse((await verCli(s, ['review', 'status', VER_FEATURE, '--json'])).out) as Record<string, any>;
}

/** The pack's rework object of a ticket. */
export function reworkOf(t: ShopTicket): Record<string, any> {
  return packOf(t)['rework'] as Record<string, any>;
}

/** AC-4's own focused test on the cli, which the cli's code already passes: the failure message carries every cause, no stack. */
export const CLI_CHALLENGE_TEST = 'version reports a failed apply with every cause and no stack trace, exits 1 and commits nothing';
export const CLI_CHALLENGE_BODY = `
test('${CLI_CHALLENGE_TEST}', async () => {
  const errors = [];
  const calls = [];
  const code = await version({ files: new Map([['packages/a/package.json', '{"version":"1.0.0"}']]), changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }], config: { commit: true }, io: { log() {}, warn() {}, error: (m) => errors.push(m) }, git: { add: () => calls.push('add'), commit: () => calls.push('commit') }, format: async () => { throw new Error('disk exploded'); } });
  assert.equal(code, 1);
  assert.match(errors[0], /disk exploded/);
  assert.doesNotMatch(errors[0], /\\n\\s+at /);
  assert.deepEqual(calls, []);
});
`;
export const CLI_CHALLENGE_RED = `${CLI_FAILURE_RED}${CLI_CHALLENGE_BODY}`;
export const AC4_HOLDS_REPRODUCTION = 'make the formatter throw "disk exploded" with commit enabled; assert version exits 1, prints the failure with no stack trace line and runs neither git add nor git commit';
export const GAP_AC4_HOLDS: VerdictOverride = {
  gap: { missing: 'the failure message is never checked for a stack trace when the apply fails inside the formatter', reproduction: AC4_HOLDS_REPRODUCTION, producer: { module: 'changesets:packages/cli/src/index.mjs' } },
};

/** AC-4's two clauses, traced to the cli's focused test. */
export function cliClauses(source: string, testId: string): ChallengeClause[] {
  const start = lineOf(source, CLI_CHALLENGE_TEST);
  const exit = lineOf(source, 'assert.equal(code, 1);', start);
  const stack = lineOf(source, 'assert.doesNotMatch(errors[0]', start);
  const calls = lineOf(source, 'assert.deepEqual(calls, []);', start);
  return [
    { clause: 'AC-4.1', test_id: testId, assertions: [`file:changesets:${CLI_TESTS}#L${exit}-L${stack}`], trace: 'exit code 1 and a message holding the failure with no stack line, after the formatter failure the test injects' },
    { clause: 'AC-4.2', test_id: testId, assertions: [`file:changesets:${CLI_TESTS}#L${calls}`], trace: 'neither git add nor git commit ran with commit enabled' },
  ];
}
