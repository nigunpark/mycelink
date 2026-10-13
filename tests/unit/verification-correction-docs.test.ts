/**
 * What the plugin tells its planner, host and workers after CSET-203 r1.
 *
 * with-faults: the planner gave the compatibility criterion AC-5 a
 * `regression` worker node with no allowed paths; the worker could only
 * submit nothing and the node BLOCKED. Planners now prove pure
 * compatibility with a `verification` node the controller runs, never a
 * worker's no-op commit.
 *
 * with-normal: the cli worker mapped AC-4 (a new behaviour) to a GREEN
 * test; its correction could neither name a RED nor add one, gave up with
 * CRITERION_UNPROVEN:AC-4 and was charged twice. A correction now names the
 * criterion, kind and gate first, may add one RED cycle, and an answer that
 * changes nothing charges no attempt; every worker brief opens with its
 * criteria and the check line; a corrective controller resumes a held
 * correction through a genuine worker.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
// @ts-expect-error -- plain ESM module without type declarations
import { TASK_CORRECTIVE_PROMPT } from '../../evals-public-projects/lib/faults.mjs';

const flat = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ');
const read = (rel: string): string => flat(readFileSync(join(REPO_ROOT, rel), 'utf8'));

describe('planning: compatibility proof is a verification node, never a worker no-op', () => {
  it('graph-compilation: the node type, what it may be, and the codes that hold it to that', () => {
    const text = read('skills/graph-compilation/SKILL.md');
    expect(text).toMatch(/node_type is one of: [^.]*verification/);
    const section = /## Verification nodes(.*?)## /.exec(text)?.[1] ?? '';
    expect(section).not.toBe('');
    expect(section).toMatch(/the controller runs it itself/i);
    expect(section).toMatch(/allowed_paths: \[\]/);
    expect(section).toMatch(/required_evidence: \[regression\]/);
    expect(section).toMatch(/fresh[^.]*checkout of the repository's integrated head/i);
    expect(section).toMatch(/depends on every producer node of its repository/i);
    expect(section).toMatch(/candidate build depends on it/i);
    expect(section).toMatch(/compatibility criterion/i);
    expect(section).toMatch(/never a worker[^.]*(no-op|nothing)/i);
    for (const code of ['WORKER_NODE_CHANGES_NOTHING', 'VERIFICATION_NODE_WRITES', 'VERIFICATION_NEEDS_REPOSITORY', 'VERIFICATION_EVIDENCE', 'VERIFICATION_DEPENDENCY_MISSING', 'VERIFICATION_NOT_BEFORE_CANDIDATE', 'VERIFICATION_CRITERION_UNOWNED']) {
      expect(text, code).toMatch(new RegExp(`\\| ${code} \\|`));
    }
  });

  it.each(['skills/portfolio-decomposition/SKILL.md', 'agents/portfolio-planner.md', 'commands/plan.md'])('%s: a criterion proved only by existing tests gets a verification node', (rel) => {
    const text = read(rel);
    expect(text).toMatch(/verification node/i);
    expect(text).toMatch(/(no-op|nothing to commit|changes nothing)/i);
  });
});

describe('the host loop: verification nodes run inside dispatch; held corrections resume through a genuine worker', () => {
  it.each(['skills/host-dispatch/SKILL.md', 'commands/run.md'])('%s', (rel) => {
    const text = read(rel);
    expect(text).toMatch(/verification node/i);
    expect(text).toMatch(/EVIDENCE_CORRECTION_REQUIRED/);
    expect(text).toMatch(/dispatch [^ ]+ --resume <node(-id)?>/);
    expect(text).toMatch(/new RED cycle/i);
    expect(text).toMatch(/CRITERION_UNPROVEN[^.]*(no attempt|charges no|not charged)/i);
    expect(text).toMatch(/never (write|correct) (the result|it) yourself/i);
  });

  it('resume: a held correction and an interrupted controller run are named, and handled', () => {
    const text = read('commands/resume.md');
    expect(text).toMatch(/settlement: "correction"/);
    expect(text).toMatch(/interrupted_controller_runs/);
    expect(text).toMatch(/module-worker/);
  });

  it("the benchmark's corrective controller resumes a held correction with dispatch --resume and a genuine module-worker", () => {
    const text = flat(TASK_CORRECTIVE_PROMPT);
    expect(text).toMatch(/EVIDENCE_CORRECTION_REQUIRED/);
    expect(text).toMatch(/dispatch --resume <node>/);
    expect(text).toMatch(/module-worker/);
    expect(text).toMatch(/never (write|correct)[^.]*yourself/i);
  });
});

describe('the worker: criteria first, checked before SUBMITTED; a correction may add a RED cycle', () => {
  it.each(['agents/module-worker.md', 'skills/node-worker/SKILL.md'])('%s', (rel) => {
    const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const text = flat(raw);
    // The criteria rule comes before the TDD history rules, not after them.
    expect(text.search(/Acceptance criteria first/i)).toBeGreaterThan(0);
    expect(text.search(/Acceptance criteria first/i)).toBeLessThan(text.search(/RED must fail/i));
    expect(text).toMatch(/tdd check/);
    expect(text).toMatch(/new-behavior criterion[^.]*test a red gate printed "failed"/i);
    expect(text).toMatch(/compatibility criterion[^.]*green or regression gate printed "passed"/i);
    expect(text).toMatch(/Evidence correction[^.]*new RED cycle/i);
    expect(text).toMatch(/CRITERION_UNPROVEN[^.]*no attempt/i);
  });
});
