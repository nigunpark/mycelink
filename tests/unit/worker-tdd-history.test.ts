/**
 * The worker's commit history is evidence: an independent verifier replays
 * it test-first, unit by unit. In the PCM-101 pilot real module-workers
 * wrote their tests first, but after a RED gate refused for an environment
 * failure they implemented anyway and committed tests and production in
 * one commit — history no replay can credit, produced after a gate that
 * proved nothing.
 *
 * Every surface a worker reads — the host ticket, the print-mode prompt,
 * the module-worker agent, the node-worker skill and the pack's rules —
 * now states one contract: a valid RED first, then exactly the test-side
 * delta committed alone before any production edit, then production
 * committed alone after GREEN; never both in one commit; after a setup or
 * environment failure no production edit or commit, only a test-only
 * commit when the RED really was a missing behaviour, else a clean
 * rollback and BLOCKED with the evidence; the same in rework cycles.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { minimalPack } from '../helpers/context-pack.js';
import { buildHostWorkerPrompt, buildWorkerPrompt } from '../../src/sessions/worker-protocol.js';
import { WORKER_RULES } from '../../src/sessions/context-pack.js';

const flat = (text: string) => text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
const read = (rel: string) => flat(readFileSync(join(REPO_ROOT, rel), 'utf8'));
const gates = [
  { gate: 'red' as const, line: 'node /p/bin/mycelink.mjs tdd red F N --capability abc' },
  { gate: 'green' as const, line: 'node /p/bin/mycelink.mjs tdd green F N --capability abc' },
  { gate: 'regression' as const, line: 'node /p/bin/mycelink.mjs tdd regression F N --capability abc' },
];
const rework = { generation: 2, limit: 3, reason: 'QA: zero vet ids are accepted', acceptance_criteria: ['AC-2'], evidence: [], sha256: 'a'.repeat(64) };

const surfaces: Record<string, () => string> = {
  'host ticket': () => flat(buildHostWorkerPrompt({ pack: minimalPack(), worktree: '/w/wt', resultSlot: '/w/wt/.mycelink-worker/result-1.json', dispatchId: '00000000-0000-0000-0000-000000000001', gates })),
  'print-mode prompt': () => flat(buildWorkerPrompt({ pack: minimalPack(), gates })),
  'module-worker agent': () => read('agents/module-worker.md'),
  'node-worker skill': () => read('skills/node-worker/SKILL.md'),
};

/** The clauses of the contract, each a phrase every surface must carry. */
const CONTRACT: [string, RegExp][] = [
  ['RED first, through the gate', /write the failing tests? and run the red gate/i],
  ['the test-side delta committed alone, before production', /when (the red gate|it) accepts the red(?: \(a missing behaviour\))?, commit exactly the test changes, test files only, before you edit any production file/i],
  ['production committed alone, after GREEN', /when the green gate passes, commit the production changes, production files only/i],
  ['no mixed commit', /never commit tests and production code together/i],
  ['the staged paths checked', /diff --cached --name-only/i],
  ['no production after a setup or environment failure', /setup or environment failure[^.]*\. [^.]*write no production code and make no production commit/i],
  ['a test-only commit only for a genuine RED', /commit the test changes alone only (if|when) the red gate's (own )?output shows the tests failing for the missing behaviour/i],
  ['otherwise a clean rollback and BLOCKED with evidence', /otherwise restore the worktree to the commit you started from[^.]*and return blocked with the gate's failure fingerprint/i],
  ['production only after a passing GREEN', /a production commit only ever follows a green gate that passed/i],
  ['the same in rework', /rework[^.]*same (commit )?order/i],
  // The second pilot's gateway worker kept every clause above and still added a test-only commit
  // after production; settle now refuses that history, and every surface says so.
  ['settle checks the history mechanically', /settle checks (this|the) history mechanically/i],
  ['no test-only commit after production', /no test-only commit after production/i],
  ['no coverage cleanup after GREEN', /no "?coverage cleanup"? after green/i],
  ['an extra test needs a new complete RED cycle, or is left out', /extra test needs a new complete red cycle[^.]*otherwise leave it out/i],
  ['the red gate refuses to run over production edits', /red gate refuses to run while production files are changed/i],
  ['the red gate binds the exact test files it ran', /binds the exact test files it ran/i],
];

describe('the worker TDD history contract', () => {
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const [clause, re] of CONTRACT) {
      it(`${surface}: ${clause}`, () => expect(text()).toMatch(re));
    }
    it(`${surface}: no longer tells the worker to commit its work in one piece`, () => {
      expect(text()).not.toMatch(/Commit your work on the (worktree|current) branch before finishing/i);
      expect(text()).not.toMatch(/Commit your work on the worktree branch\. Then/i);
    });
  }

  it('a rework ticket repeats the order for the regression test', () => {
    const prompt = flat(buildHostWorkerPrompt({ pack: minimalPack({ rework } as never), worktree: '/w/wt', resultSlot: '/w/wt/.mycelink-worker/result-1.json', gates }));
    expect(prompt).toMatch(/commit the regression test alone once the red gate accepts it, and the fix alone once green passes/i);
  });

  it('the pack carries the rule to every worker', () => {
    expect(WORKER_RULES.some((r) => /tests? alone/i.test(r) && /production/i.test(r) && /never both in one commit/i.test(r))).toBe(true);
    expect(WORKER_RULES.some((r) => /setup or environment failure/i.test(r) && /no production/i.test(r))).toBe(true);
  });
});
