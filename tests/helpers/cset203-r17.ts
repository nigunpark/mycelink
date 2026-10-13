/**
 * CSET-203 r17's fault arm on the version fixture: reproduction capsules.
 *
 * r17 with-faults (trusted; the concurrent commit, duplicate and stale
 * replays, the interrupted and restarted host and the late hidden defect all
 * handled): after C001 a teammate's commit broke apply-release-plan on main;
 * QA reworked it, and R004 found AC-1 on it (a reproduction its code already
 * satisfied) and AC-3 on the cli. The cli challenged AC-3 with its focused
 * test committed alone. R005 found AC-1 again — a changelog the run changed
 * or created, restored when removing a changeset fails — and the worker wrote
 * that exact reproduction as two cases of one template-literal title in a
 * loop, kept out of the branch. It passed on the unchanged base; the static
 * reader of declarations named no test of it, so the red gate kept no
 * challenge material, the challenge line answered GATE_UNKNOWN and the check
 * line CRITERION_TEST_UNKNOWN (NO_DECLARED_TESTS once it was committed). The
 * worker answered BLOCKED; the node was parked; no candidate.
 *
 * A capsule seals such a reproduction without a commit: `tdd capsule` runs it
 * with the claim's module command on a throwaway checkout of the claim's
 * base, records each test the run reported from its files, and the challenge
 * cites it by id and hash.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { git } from './git-fixture.js';
import { ARP, CLI, VER_FEATURE } from './version-fixture.js';
import { briefLine, lineOf, runJsonLine, type ChallengeClause } from './cset203-challenge.js';
import { writeFiles, type ShopTicket } from './shop-worker.js';
import type { VerdictOverride } from './review-agent.js';

// ---- R004's AC-1: a file the run created, removed when a later change fails (its code holds it) ----

export const AC1_R004_REPRODUCTION =
  'apply a plan whose first change creates a file of packages/b (its CHANGELOG.md, or a release note) and whose formatter then fails on packages/b/package.json; assert the created file is gone, package.json holds its exact previous bytes and error.cause is the injected failure';
export const GAP_AC1_R004: VerdictOverride = {
  gap: { missing: 'no test shows that a file the run created is removed when a later change fails', reproduction: AC1_R004_REPRODUCTION, producer: { node_id: ARP } },
};

/** R004's AC-1 reproduction as r17's worker wrote its own: two cases of one template-literal title, in a loop, in a new file. */
export const ARP_CAPSULE_TESTS = 'packages/apply-release-plan/test/created-rollback.test.mjs';
export const ARP_CAPSULE_TEMPLATE = 'removes ${label} when a later change fails, with the original error as the cause';
export const ARP_CAPSULE_NAMES = ['removes a changelog it created when a later change fails, with the original error as the cause', 'removes a release note it created when a later change fails, with the original error as the cause'];
export const ARP_CAPSULE_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReleasePlan } from '../src/index.mjs';

for (const [label, created] of [
  ['a changelog it created', 'packages/b/CHANGELOG.md'],
  ['a release note it created', 'packages/b/RELEASE.md'],
]) {
  test(\`removes \${label} when a later change fails, with the original error as the cause\`, async () => {
    const files = new Map([['packages/b/package.json', '{"version":"1.0.0"}']]);
    const failure = new Error('formatter crashed');
    const plan = [{ path: created, content: '# b' }, { path: 'packages/b/package.json', content: '{"version":"1.1.0"}' }];
    const error = await applyReleasePlan(files, plan, { format: async (path) => { if (path === 'packages/b/package.json') throw failure; } }).then(() => null, (e) => e);
    assert.equal(error.cause, failure);
    assert.equal(files.has(created), false, 'the file it created is gone');
    assert.deepEqual([...files], [['packages/b/package.json', '{"version":"1.0.0"}']]);
  });
}
`;

/** AC-1's two clauses, traced to the looped test's own assertion lines. */
export function arpCapsuleClauses(source: string, testIds: string[]): ChallengeClause[] {
  const start = lineOf(source, 'test(`removes');
  const cause = lineOf(source, 'assert.equal(error.cause, failure);', start);
  const gone = lineOf(source, 'assert.equal(files.has(created), false', start);
  const exact = lineOf(source, "assert.deepEqual([...files], [['packages/b/package.json'", start);
  return testIds.flatMap((id) => [
    { clause: 'AC-1.1', test_id: id, assertions: [`file:changesets:${ARP_CAPSULE_TESTS}#L${gone}-L${exact}`], trace: 'the file the run created is gone and package.json holds its exact previous bytes after the injected formatter failure' },
    { clause: 'AC-1.2', test_id: id, assertions: [`file:changesets:${ARP_CAPSULE_TESTS}#L${cause}`], trace: 'the rejection cause is the injected formatter failure itself' },
  ]);
}

// ---- R005's AC-1 (r17's own): a changelog the run changed or created, restored when removing a changeset fails ----

export const AC1_R005_REFINED = {
  missing: 'no rollback test writes a changelog before the failure: a CHANGELOG.md the run changed or created is never shown restored',
  reproduction:
    'apply a plan that bumps packages/a/package.json, writes packages/a/CHANGELOG.md (case A: it existed; case B: the run creates it) and removes .changeset/one.md, with the removal failing; assert the rejection cause is the injected failure and every file, the changelog included, holds its exact previous bytes or absence',
};

/** R005's reproduction exactly as r17's worker wrote it: one template-literal title over the existing and the created changelog, in a loop. */
export const ARP_R005_TESTS = 'packages/apply-release-plan/test/changelog-rollback.test.mjs';
export const ARP_R005_NAMES = ['restores an existing CHANGELOG.md when removing the changeset fails', 'restores a CHANGELOG.md created by the run when removing the changeset fails'];
export const ARP_R005_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReleasePlan } from '../src/index.mjs';

for (const [label, changelog] of [
  ['an existing CHANGELOG.md', [['packages/a/CHANGELOG.md', '# a\\n\\n## 1.0.0\\n']]],
  ['a CHANGELOG.md created by the run', []],
]) {
  test(\`restores \${label} when removing the changeset fails\`, async () => {
    const initial = [['.changeset/one.md', 'one'], ['packages/a/package.json', '{"version":"1.0.0"}'], ...changelog];
    const files = new Map(initial);
    const failure = new Error('rm exploded');
    const plan = [{ path: 'packages/a/package.json', content: '{"version":"1.1.0"}' }, { path: 'packages/a/CHANGELOG.md', content: '# a\\n\\n## 1.1.0\\n' }, { path: '.changeset/one.md', content: null }];
    const error = await applyReleasePlan(files, plan, { format: async (path) => { if (path === '.changeset/one.md') throw failure; } }).then(() => null, (e) => e);
    assert.equal(error.cause, failure);
    assert.deepEqual([...files].sort(), [...initial].sort());
  });
}
`;

export function arpR005Clauses(source: string, testIds: string[]): ChallengeClause[] {
  const start = lineOf(source, 'test(`restores');
  const cause = lineOf(source, 'assert.equal(error.cause, failure);', start);
  const exact = lineOf(source, 'assert.deepEqual([...files].sort(), [...initial].sort());', start);
  return testIds.flatMap((id) => [
    { clause: 'AC-1.1', test_id: id, assertions: [`file:changesets:${ARP_R005_TESTS}#L${exact}`], trace: 'every file, the changelog it changed or created included, holds its exact previous bytes or absence after the removal failed' },
    { clause: 'AC-1.2', test_id: id, assertions: [`file:changesets:${ARP_R005_TESTS}#L${cause}`], trace: 'the rejection cause is the injected removal failure' },
  ]);
}

// ---- R004's AC-1, the other way: a changelog write that fails part-way (a real gap of the gappy code) ----

export const AC1_PARTIAL_REPRODUCTION =
  'write packages/a/package.json, then make the changelog writer fail part-way through packages/a/CHANGELOG.md (a partial write, as a full disk would); assert every file, the half-written changelog included, holds its exact previous bytes and error.cause is the writer failure';
export const GAP_AC1_PARTIAL: VerdictOverride = {
  gap: { missing: 'no test fails the changelog write part-way after the package version was written', reproduction: AC1_PARTIAL_REPRODUCTION, producer: { node_id: ARP } },
};

/** A weak first reproduction (a writer that fails cleanly, writing nothing): it passes on the gappy code, at another boundary than the gap's. */
export const ARP_WEAK_TESTS = 'packages/apply-release-plan/test/unwritable-changelog.test.mjs';
export const ARP_WEAK_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReleasePlan } from '../src/index.mjs';

for (const [label, at] of [['the changelog', 'packages/a/CHANGELOG.md']]) {
  test(\`restores every file when \${label} cannot be written after the package version was written\`, async () => {
    class Unwritable extends Map {
      set(path, content) {
        if (this.armed && path === at) {
          this.armed = false;
          throw new Error('EACCES: permission denied, open ' + path);
        }
        return super.set(path, content);
      }
    }
    const before = [['packages/a/CHANGELOG.md', '# a\\n\\n## 1.0.0\\n'], ['packages/a/package.json', '{"version":"1.0.0"}']];
    const files = new Unwritable(before);
    files.armed = true;
    const error = await applyReleasePlan(files, [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: at, content: '# a\\n\\n## 2.0.0\\n' }]).then(() => null, (e) => e);
    assert.match(String(error.cause?.message), /EACCES/);
    assert.deepEqual([...files].sort(), before);
  });
}
`;
export const ARP_WEAK_NAMES = ['restores every file when the changelog cannot be written after the package version was written'];

export function arpWeakClauses(source: string, testIds: string[]): ChallengeClause[] {
  const start = lineOf(source, 'test(`restores');
  const cause = lineOf(source, 'assert.match(String(error.cause?.message), /EACCES/);', start);
  const exact = lineOf(source, 'assert.deepEqual([...files].sort(), before);', start);
  return testIds.flatMap((id) => [
    { clause: 'AC-1.1', test_id: id, assertions: [`file:changesets:${ARP_WEAK_TESTS}#L${exact}`], trace: 'every file holds its exact previous bytes after the changelog write failed' },
    { clause: 'AC-1.2', test_id: id, assertions: [`file:changesets:${ARP_WEAK_TESTS}#L${cause}`], trace: 'the rejection cause is the writer failure' },
  ]);
}

/** The gap's exact reproduction, statically named, in a new file: it fails on the gappy code (the half-written changelog stays) — a RED. */
export const ARP_PARTIAL_TESTS = 'packages/apply-release-plan/test/partial-changelog.test.mjs';
export const ARP_PARTIAL_TEST = 'restores every file exactly when the changelog writer fails part-way after the package version was written';
export const ARP_PARTIAL_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReleasePlan } from '../src/index.mjs';

test('${ARP_PARTIAL_TEST}', async () => {
  class PartialChangelog extends Map {
    set(path, content) {
      if (this.armed && path.endsWith('CHANGELOG.md')) {
        this.armed = false;
        super.set(path, String(content).slice(0, 2));
        throw new Error('ENOSPC: no space left on device, write ' + path);
      }
      return super.set(path, content);
    }
  }
  const before = [['packages/a/CHANGELOG.md', '# a\\n\\n## 1.0.0\\n'], ['packages/a/package.json', '{"version":"1.0.0"}']];
  const files = new PartialChangelog(before);
  files.armed = true;
  const plan = [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: 'packages/a/CHANGELOG.md', content: '# a\\n\\n## 2.0.0\\n\\n## 1.0.0\\n' }];
  const error = await applyReleasePlan(files, plan).then(() => null, (e) => e);
  assert.ok(error instanceof Error, 'it rejects');
  assert.match(String(error.cause?.message), /ENOSPC/);
  assert.deepEqual([...files].sort(), before);
});
`;

// ---- R004's AC-3 on the cli: its code holds it; the cli challenges it with its focused test committed alone ----

export const CLI_CAPSULE_TESTS = 'packages/cli/test/recovery-order.test.mjs';
export const CLI_CAPSULE_NAMES = ['version restores an interrupted run before anything else with commit enabled'];
export const CLI_CAPSULE_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version } from '../src/index.mjs';

for (const [label, commit] of [['with commit enabled', true]]) {
  test(\`version restores an interrupted run before anything else \${label}\`, async () => {
    const journal = JSON.stringify({ before: [{ path: 'packages/a/package.json', content: '{"version":"1.0.0"}' }, { path: '.changeset/one.md', content: 'one' }] });
    const files = new Map([['packages/a/package.json', '{"version":"2.0.0"}'], ['.changeset/.version-journal.json', journal]]);
    const warnings = [];
    const calls = [];
    const code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }], config: { commit }, io: { log() {}, warn: (m) => warnings.push(m), error() {} }, git: { add: (paths) => calls.push(['add', paths]), commit: (message) => calls.push(['commit', message]) } });
    assert.equal(code, 0);
    assert.ok(warnings.some((w) => /interrupted/.test(w)), 'it warns that the last run was interrupted');
    assert.deepEqual([...files], [['packages/a/package.json', '{"version":"2.0.0"}']], 'the journal state restored, then versioned once');
    assert.deepEqual(calls, [['add', ['packages/a/package.json', '.changeset/one.md']], ['commit', 'Version Packages']], 'exactly one versioning committed');
  });
}
`;

export function cliCapsuleClauses(source: string, testIds: string[]): ChallengeClause[] {
  const start = lineOf(source, 'test(`version restores');
  const warned = lineOf(source, 'assert.ok(warnings.some((w) => /interrupted/.test(w))', start);
  const files = lineOf(source, "assert.deepEqual([...files], [['packages/a/package.json'", start);
  const calls = lineOf(source, "assert.deepEqual(calls, [['add'", start);
  return testIds.flatMap((id) => [
    { clause: 'AC-3.1', test_id: id, assertions: [`file:changesets:${CLI_CAPSULE_TESTS}#L${files}-L${calls}`], trace: 'the journal state is back before the run versions: one versioning of the restored files is committed' },
    { clause: 'AC-3.2', test_id: id, assertions: [`file:changesets:${CLI_CAPSULE_TESTS}#L${warned}-L${files}`], trace: 'a warning containing interrupted, the journal removed and the run versioned normally' },
  ]);
}

// ---- the worker's lines ----

/** The ticket's capsule line, as the brief offers it. */
export function capsuleLine(t: { prompt: string; node_id: string }): string {
  const line = briefLine(t, 'capsule');
  if (line === null) throw new Error(`the brief of ${t.node_id} offers no capsule line`);
  return line;
}

export interface CapsuleRun {
  code: number;
  out: Record<string, any>;
  raw: string;
}

/** `tdd capsule ... --criterion <AC>` from the brief, as the worker's Bash tool runs it, from `cwd`. */
export function registerCapsule(t: ShopTicket, cwd: string, criterion: string, extra: string[] = []): CapsuleRun {
  return runJsonLine(`${capsuleLine(t)} --criterion ${criterion}${extra.length > 0 ? ` ${extra.join(' ')}` : ''} --json`, cwd);
}

/** `tdd challenge` from the brief, with `--capsule` and any other flags, as JSON. */
export function challengeLineWith(t: ShopTicket, cwd: string, flags: string): CapsuleRun {
  const line = briefLine(t, 'challenge');
  if (line === null) throw new Error(`the brief of ${t.node_id} offers no challenge line`);
  return runJsonLine(`${line} ${flags} --json`, cwd);
}

/** The capsule's test ids by name, as its registration printed them. */
export function capsuleTestIds(run: CapsuleRun, names: readonly string[]): string[] {
  const tests = (run.out['tests'] ?? []) as { id: string; full_name: string; status: string }[];
  return names.map((n) => {
    const hit = tests.find((x) => x.full_name === n || x.full_name.endsWith(` > ${n}`));
    if (hit === undefined) throw new Error(`the capsule names no test ${n}: ${run.raw}`);
    return hit.id;
  });
}

/**
 * The worker's capsule challenge: the challenge line with --capsule, its gaps filled in from the capsule's own file
 * (the clauses traced to its assertion lines), written as outcome REVIEW_GAP_CHALLENGE (or, with `criteria`, in a
 * per-criterion answer) with commit_sha the worktree's head. Returns the skeleton and the result written.
 */
export function writeCapsuleChallenge(
  t: ShopTicket,
  cwd: string,
  capsules: { id: string; file: string; source: string; names: readonly string[]; clauses: (source: string, ids: string[]) => ChallengeClause[] }[],
  options: { criteria?: Record<string, unknown>[]; evidence?: Record<string, unknown>[]; mutate?: (challenge: Record<string, any>) => void } = {},
): { skeleton: Record<string, any>; result: Record<string, any> } {
  const skeleton = challengeLineWith(t, cwd, `--capsule ${capsules.map((c) => c.id).join(',')}`);
  if (skeleton.code !== 0) throw new Error(`the challenge line refused: ${skeleton.raw}`);
  const challenge = structuredClone(skeleton.out['challenge']) as Record<string, any>;
  for (const gap of challenge['gaps'] as Record<string, any>[]) {
    const c = capsules.find((x) => x.id === gap['capsule']?.['capsule_id']);
    if (c === undefined) throw new Error(`the skeleton's gap ${gap['criterion']} cites no capsule of the worker's: ${skeleton.raw}`);
    const tests = (skeleton.out['tests'] as { id: string; full_name: string }[]).filter((x) => c.names.some((n) => x.full_name === n || x.full_name.endsWith(` > ${n}`)));
    gap['tests'] = tests.map((x) => x.id);
    gap['clauses'] = c.clauses(c.source, tests.map((x) => x.id));
    gap['explanation'] = `The review's exact reproduction, sealed as capsule ${c.id} (${c.file}, kept out of the branch), passes on the unchanged base: the code already does what ${gap['criterion']} requires there.`;
  }
  options.mutate?.(challenge);
  const v2 = options.criteria !== undefined;
  const result = {
    schema_version: v2 ? 2 : 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: v2 ? 'CRITERIA' : 'REVIEW_GAP_CHALLENGE',
    commands: [{ command: ['mycelink', 'tdd', 'capsule'], exit_code: 0 }],
    commit_sha: git(t.worktree, ['rev-parse', 'HEAD']),
    changed_paths: [],
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    ...(v2 ? { criteria: options.criteria, criterion_evidence: options.evidence ?? [] } : {}),
    challenge,
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return { skeleton: skeleton.out, result };
}

/** r17's own last answer: BLOCKED, the reproduction passing but uncheckable, the branch back at its base, nothing committed. */
export function writeR17Blocked(t: ShopTicket): Record<string, unknown> {
  const result = {
    schema_version: 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: 'BLOCKED',
    commands: [{ command: ['mycelink', 'tdd', 'red'], exit_code: 1 }, { command: ['mycelink', 'tdd', 'check'], exit_code: 1 }],
    commit_sha: git(t.worktree, ['rev-parse', 'HEAD']),
    changed_paths: [],
    evidence_paths: [],
    failure_fingerprint:
      'REVIEW_REPRODUCTION_PASSES_BUT_REPROOF_UNCHECKABLE: both changelog rollback cases pass on unchanged code (red gate: RED evidence exited 0). tdd check answers CRITERION_TEST_UNKNOWN when the test is not in head, and NO_DECLARED_TESTS when it is committed; the challenge line answers REVIEW_CHALLENGE_GATE_UNKNOWN.',
    decision_request: null,
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return result;
}

/** Write a capsule's file into a worktree, uncommitted (as a capsule's reproduction is kept). */
export function writeReproduction(t: ShopTicket, file: string, body: string): void {
  writeFiles(t.worktree, { [file]: body });
}

/** The capsule's sealed archive directory, from its receipt path. */
export function capsuleDirOf(control: string, receiptPath: string): string {
  return dirname(join(control, ...receiptPath.split('/')));
}

/** The repository's worktrees, refs and index as a capsule must leave them: compared before and after a registration. */
export function productSnapshot(repo: string, worktree: string): Record<string, string> {
  return {
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    worktrees: git(repo, ['worktree', 'list', '--porcelain']),
    head: git(worktree, ['rev-parse', 'HEAD']),
    index: git(worktree, ['ls-files', '--stage']),
    status: git(worktree, ['status', '--porcelain', '--untracked-files=all']),
  };
}

/** The bytes of a sealed capsule file as archived. */
export function archivedSource(control: string, receipt: Record<string, any>, path: string): string {
  const f = (receipt['files'] as { path: string; archived: string }[]).find((x) => x.path === path);
  expect(f, `the capsule archives ${path}`).toBeDefined();
  return readFileSync(join(control, ...(f as { archived: string }).archived.split('/')), 'utf8');
}

/** Run a command line as a worker's Bash tool would, its exit code and output. */
export function runLine(line: string, cwd: string): { code: number; out: string } {
  try {
    return { code: 0, out: execSync(line, { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

export { ARP, CLI, VER_FEATURE };
