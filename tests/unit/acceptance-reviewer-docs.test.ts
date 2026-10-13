/**
 * The acceptance reviewer's instructions, and the run loop that launches it.
 *
 * CSET-203 r2's workers wrote happy-path tests that a criterion's test id
 * pointed at, and AC-1's partial-write boundary went untested. The bundled
 * reviewer is told to distrust exactly that: a test count, a green suite, a
 * test id named for a criterion; to split every criterion into its material
 * clauses and the state, failure, concurrency, order and partial-write
 * boundaries its text implies, and to trace each to an assertion and the
 * failure injection that reaches it — read-only, never implementing. The
 * run loop launches it before any candidate, and a module-worker reworked
 * on its gap writes the focused RED for exactly that gap first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { runPhases } from '../helpers/run-phases.js';
import { buildHostWorkerPrompt } from '../../src/sessions/worker-protocol.js';
import type { ContextPack } from '../../src/sessions/context-pack.js';
import { MAX_FORMAT_CORRECTIONS, MAX_REVIEW_ATTEMPTS, TRUNCATION_MARK } from '../../src/engine/acceptance-review.js';

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const frontmatter = (text: string): Record<string, string> => Object.fromEntries((/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));

describe('agents/acceptance-reviewer.md', () => {
  const agent = read('agents/acceptance-reviewer.md');
  const meta = frontmatter(agent);

  it('is a read-only subagent: it reads, and writes only its verdict', () => {
    expect(meta['name']).toBe('acceptance-reviewer');
    expect(meta['tools']?.split(/,\s*/).sort()).toEqual(['Glob', 'Grep', 'Read', 'Write']);
    expect(meta['description']).toMatch(/acceptance.review/i);
    expect(agent).toMatch(/only write is (the|your|one) (JSON )?verdict/i);
    expect(agent).toMatch(/never (write|change|edit|fix|implement)[^.]*(product|code|test)/i);
    expect(agent).toMatch(/no (subagents|nested delegation)|never spawn/i);
    expect(agent).toMatch(/no shell|no Bash|never run/i);
  });

  it('distrusts happy-path test counts and a test id named for a criterion', () => {
    expect(agent).toMatch(/happy.path/i);
    expect(agent).toMatch(/test count|number of tests|how many tests/i);
    expect(agent).toMatch(/test id (alone|exists|existing)|a test_id .* is not|because a test (id )?exists/i);
    expect(agent).toMatch(/green suite|passing suite/i);
  });

  it('hunts for untested material clauses and the boundaries the text implies', () => {
    expect(agent).toMatch(/material clause/i);
    for (const boundary of ['state', 'failure', 'concurrency', 'order', 'partial-write']) expect(agent, boundary).toContain(boundary);
    expect(agent).toMatch(/failure injection|inject/i);
    expect(agent).toMatch(/assertion/i);
    expect(agent).toMatch(/compatibility[^.]*regression/i);
  });

  it('a format correction mends the refused verdict it names, keeping its judgements; a latitude clause needs no test; bounds are in the prompt (CSET-203 r5)', () => {
    expect(agent).toMatch(/Format correction/);
    expect(agent).toMatch(/Refused verdict/);
    expect(agent).toMatch(/keep every judgement/i);
    expect(agent).toMatch(/dispatch_id/);
    expect(agent).toMatch(/"latitude": true/);
    expect(agent).toMatch(/Bounds/);
    expect(agent).toContain(TRUNCATION_MARK);
  });

  it('answers in the strict verdict format, a GAP with a public reproduction and its producer', () => {
    for (const field of ['"criterion"', '"verdict"', '"PASS"', '"GAP"', '"clauses"', '"boundaries"', '"evidence"', '"gap"', '"reproduction"', '"producer"', '"confidence"', '"overall"', '"GAPS"', '"inputs_sha256"', '"dispatch_id"', '"model"']) {
      expect(agent, field).toContain(field);
    }
    expect(agent).toMatch(/public/i);
    expect(agent).toMatch(/hidden|evaluator/i);
  });
});

describe('the run loop launches the reviewer before any candidate', () => {
  it('/mycelink:run has a review phase between settle and candidate', () => {
    const run = read('commands/run.md');
    expect(runPhases(run)).toEqual(['init', 'prd', 'plan', 'dispatch', 'settle', 'review', 'candidate', 'deliver']);
    expect(run).toContain('acceptance-review');
    expect(run).toContain('mycelink:acceptance-reviewer');
    expect(run).toMatch(/settle_command/);
    expect(run).toMatch(/GAPS?[^.]*rework/);
    expect(run).toContain('REVIEW_GAPS');
    expect(run).toContain('REVIEW_INVALID');
    expect(run).toMatch(/never (write|edit|change)[^.]*verdict/i);
    // A verdict refused for its form goes to a corrective generation of the same review, bounded apart from reviewer attempts.
    for (const doc of [run, read('skills/host-dispatch/SKILL.md')]) {
      expect(doc).toMatch(/ticket\.correction/);
      expect(doc).toContain(`${MAX_FORMAT_CORRECTIONS} format corrections`);
      expect(doc).toMatch(new RegExp(`${MAX_REVIEW_ATTEMPTS === 2 ? 'twice|two' : String(MAX_REVIEW_ATTEMPTS)}`));
    }
  });

  it('/mycelink:resume and /mycelink:rework continue an interrupted review', () => {
    const resume = read('commands/resume.md');
    expect(resume).toContain('pending_review');
    expect(resume).toMatch(/dispatch \$0 --resume <review[-_]id>/);
    expect(read('commands/rework.md')).toContain('acceptance-reviewer');
    expect(read('skills/host-dispatch/SKILL.md')).toContain('acceptance-review');
  });

  it('the module-worker writes the focused RED for a review gap first, and challenges a gap its exact reproduction contradicts (CSET-203 r6)', () => {
    for (const doc of [read('agents/module-worker.md'), read('skills/node-worker/SKILL.md')]) {
      expect(doc).toMatch(/acceptance review/i);
      expect(doc).toMatch(/REVIEW_GAP_CHALLENGE/);
      expect(doc).toMatch(/tdd challenge/);
      expect(doc).toMatch(/never (make|fake)[^.]*fail/i);
      expect(doc).not.toMatch(/write\s+(outcome\s+)?`?BLOCKED`?\s+with\s+`?failure_fingerprint`?\s+`?REVIEW_GAP_NOT_REPRODUCED/);
    }
    expect(read('agents/module-worker.md')).toMatch(/carried_criteria/);
  });

  it('each criterion has its own budget; the reviewer reads every earlier finding and never reports one again (CSET-203 r11)', () => {
    const agent = read('agents/acceptance-reviewer.md');
    expect(agent).toContain('review_memory');
    expect(agent).toMatch(/Never report again a reproduction/);
    expect(agent).toMatch(/normalized fingerprint/);
    expect(agent).toMatch(/own budget/);
    expect(agent).toMatch(/withdrawn hypothesis spends nothing/);
    expect(agent).toContain('REVIEW_NONCONVERGENT');
    for (const doc of [read('commands/run.md'), read('skills/host-dispatch/SKILL.md')]) {
      expect(doc).toContain('REPEATED');
      expect(doc).toContain('REVIEW_NONCONVERGENT');
      expect(doc).toMatch(/per\s+criterion/);
    }
    expect(read('commands/run.md')).toContain('REVIEW_LINEAGE_INVALID');
    // The budget is never a cap (CSET-201 final): past it, verified producer progress; the emergency ceiling is a person's.
    expect(agent).toMatch(/The budget is not a cap/);
    expect(agent).toMatch(/emergency ceiling/);
    expect(read('commands/run.md')).toMatch(/criterion_ceiling/);
  });

  it('the reviewer refines a challenged gap: WITHDRAW, REFINE or UPHOLD, never the same reproduction again', () => {
    const agent = read('agents/acceptance-reviewer.md');
    for (const word of ['WITHDRAW', 'REFINE', 'UPHOLD', 'mycelink-acceptance-refinement/1', 'challenge', '"decisions"', '"rebuttal"', '"challenge_sha256"']) expect(agent, word).toContain(word);
    expect(agent).toMatch(/materially different/i);
    expect(agent).toMatch(/unchanged|preserved|kept as/i);
  });

  it("the reviewer's final answer is its verdict: exactly one JSON object, nothing else; written too, the same verdict (CSET-203 r8)", () => {
    const agent = read('agents/acceptance-reviewer.md');
    expect(agent).toMatch(/final answer/i);
    expect(agent).toMatch(/exactly one JSON object/);
    expect(agent).toMatch(/no text before or after it/);
    expect(agent).toContain('REVIEW_OUTPUT_CONFLICT');
    expect(agent).toMatch(/```json/);
  });

  it('/mycelink:run and host-dispatch ingest every reviewer Agent return before its settle — a review, a correction, a refinement — and never answer for it (CSET-203 r8)', () => {
    for (const doc of [read('commands/run.md'), read('skills/host-dispatch/SKILL.md')]) {
      expect(doc).toContain('ingest_command');
      expect(doc).toMatch(/ingest_command[^.]*then[^.]*(ticket.)?settle_command/i);
      expect(doc).toMatch(/correction[^.]*refinement|refinement[^.]*correction/i);
      expect(doc).toContain('REVIEWER_RUNNING');
      expect(doc).toMatch(/never (write|paste|copy)[^.]*(answer|verdict)/i);
      expect(doc).toContain('REVIEW_OUTPUT_CONFLICT');
      expect(doc).toContain('REVIEW_RESULT_INVALID');
    }
  });

  it('/mycelink:run and host-dispatch await a launched reviewer and never settle, correct or relaunch it while it runs (CSET-203 r13)', () => {
    for (const doc of [read('commands/run.md'), read('skills/host-dispatch/SKILL.md')]) {
      expect(doc).toContain('await_command');
      expect(doc).toMatch(/await_command[\s\S]{0,200}?ingest_command[\s\S]{0,120}?settle_command/);
      expect(doc).toContain('REVIEWER_RUNNING');
      expect(doc).toContain('await-reviewer');
      expect(doc).toMatch(/never settle, correct or relaunch/i);
      expect(doc).toContain('REVIEWER_INTERRUPTED');
      expect(doc).toContain('REVIEWER_NOT_LAUNCHED');
      expect(doc).toMatch(/wall-clock/);
      expect(doc).not.toContain('PENDING');
    }
    for (const doc of [read('commands/status.md'), read('commands/resume.md')]) expect(doc).toContain('await-reviewer');
  });

  it('/mycelink:run and host-dispatch carry a refinement like a review, and say what REVIEW_CHALLENGED and REVIEW_DISPUTE mean', () => {
    for (const doc of [read('commands/run.md'), read('skills/host-dispatch/SKILL.md')]) {
      expect(doc).toContain('REVIEW_CHALLENGED');
      expect(doc).toContain('review-refine');
      expect(doc).toContain('REVIEW_DISPUTE');
      expect(doc).toMatch(/ticket\.refinement/);
    }
    expect(read('commands/status.md')).toContain('review-refine');
    expect(read('commands/resume.md')).toContain('review-refine');
  });

  it("a reworked worker's prompt names the review's gap and asks for a focused RED, keeping the criteria it does not name", () => {
    const pack = {
      schema_version: 1,
      feature_id: 'CSET-203',
      node_id: 'CSET-203.changesets.arp',
      claim_id: 'c1',
      generated_at: '2026-10-09T00:00:00.000Z',
      repository: 'changesets',
      worktree: '/w',
      branch: 'wip/CSET-203/arp',
      node_contract: { node_type: 'implementation', capability: null, acceptance_criteria: ['AC-1', 'AC-2'] },
      acceptance_criteria: [],
      allowed_paths: ['packages/apply-release-plan/**'],
      forbidden_paths: [],
      contracts: [],
      last_checkpoint_sha: null,
      latest_evidence: [],
      last_failure_fingerprint: null,
      verification_commands: [],
      next_required_gate: 'RED_VERIFIED',
      rework: {
        generation: 1,
        limit: 2,
        reason: 'Acceptance review CSET-203-R001 found AC-1 not proved. Reproduce: inject changelog writer failure after package/version writes and assert exact rollback.',
        reason_sha256: '0'.repeat(64),
        acceptance_criteria: ['AC-1'],
        evidence: ['features/CSET-203/reviews/CSET-203-R001.json'],
        replaced: { integrated_sha: null, candidate_id: null },
        scope: { node_id: 'CSET-203.changesets.arp', repository: 'changesets' },
        origin: { kind: 'acceptance-review', review_id: 'CSET-203-R001', review: 1 },
        carried_criteria: [{ criterion: 'AC-2', test_id: '2222222222222222', output_sha256: '1'.repeat(64), test: { path: 'packages/apply-release-plan/test/apply.test.mjs', name: 'keeps a journal' } }],
      },
      budget: { max_turns: 10, max_wall_clock_minutes: 10, max_attempts: 2, attempt: 1 },
      byte_budget: 24576,
      rules: [],
    } as unknown as ContextPack;
    const prompt = buildHostWorkerPrompt({ pack, worktree: '/w', resultSlot: '/w/.mycelink-worker/result.json', gates: [] });
    expect(prompt).toMatch(/independent acceptance review/i);
    expect(prompt).toMatch(/focused failing (regression )?test/i);
    expect(prompt).toMatch(/carried_criteria/);
    // A focused test of the exact reproduction that passes on the unchanged head is a challenge, never a BLOCKED node (CSET-203 r6).
    expect(prompt).toContain('REVIEW_GAP_CHALLENGE');
    expect(prompt).not.toMatch(/write outcome BLOCKED with\s+failure_fingerprint "REVIEW_GAP_NOT_REPRODUCED/);
    expect(prompt).toMatch(/never (make|fake)[^.]*fail/i);
    expect(prompt).toMatch(/setup/i);
  });

  it("a reworked worker's prompt offers the challenge line beside the gates", () => {
    const pack = {
      schema_version: 1, feature_id: 'CSET-203', node_id: 'CSET-203.changesets.arp', claim_id: 'c1', generated_at: '2026-10-09T00:00:00.000Z', repository: 'changesets', worktree: '/w', branch: 'wip/CSET-203/arp',
      node_contract: { node_type: 'implementation', capability: null, acceptance_criteria: ['AC-1'] }, acceptance_criteria: [], allowed_paths: ['packages/apply-release-plan/**'], forbidden_paths: [], contracts: [], last_checkpoint_sha: null, latest_evidence: [], last_failure_fingerprint: null, verification_commands: [], next_required_gate: 'RED_VERIFIED',
      rework: { generation: 1, limit: 2, reason: 'Acceptance review CSET-203-R001 found AC-1 not proved.', reason_sha256: '0'.repeat(64), acceptance_criteria: ['AC-1'], evidence: ['features/CSET-203/reviews/CSET-203-R001.json'], replaced: { integrated_sha: null, candidate_id: null }, scope: { node_id: 'CSET-203.changesets.arp', repository: 'changesets' }, origin: { kind: 'acceptance-review', review_id: 'CSET-203-R001', review: 1 }, review_gaps: [{ criterion: 'AC-1', reproduction_sha256: '1'.repeat(64) }] },
      budget: { max_turns: 10, max_wall_clock_minutes: 10, max_attempts: 2, attempt: 1 }, byte_budget: 24576, rules: [],
    } as unknown as ContextPack;
    const prompt = buildHostWorkerPrompt({ pack, worktree: '/w', resultSlot: '/w/.mycelink-worker/result.json', gates: [{ gate: 'red', line: 'node m.mjs tdd red F N --capability k' }], challengeLine: 'node m.mjs tdd challenge F N --capability k' });
    expect(prompt).toMatch(/^- challenge \([^)]*\): node m\.mjs tdd challenge F N --capability k$/m);
    expect(prompt).toContain('REVIEW_GAP_CHALLENGE');
  });
});
