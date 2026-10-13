/**
 * Planners select module verifiers, and workers know their gates are module-scoped.
 *
 * CSET-202 r1: the planner chose the whole suite for every per-package node.
 * The planner's brief now names the allowlist (`mycelink repo modules`), the
 * verifier to copy and what graph validation refuses; a worker whose pack
 * carries a module is told its red and green gates run that module's
 * command, its regression the full suite, and that a failure only a
 * dependent's module shows is deferred to that dependent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { minimalPack } from '../helpers/context-pack.js';
import { buildHostWorkerPrompt, buildWorkerPrompt } from '../../src/sessions/worker-protocol.js';

const doc = (...rel: string[]) => readFileSync(join(REPO_ROOT, ...rel), 'utf8').replace(/\s+/g, ' ');
const instructions = (prompt: string) => prompt.split('<mycelink-context-pack>')[0]!.replace(/\s+/g, ' ');
const gates = [{ gate: 'red' as const, line: 'node /p/bin/mycelink.mjs tdd red F N --capability abc' }];
const module = { id: 'errors', path: 'packages/errors', runtime_tests: true, sha256: 'a'.repeat(64), steps: [['pnpm', 'build']], test: ['pnpm', 'vitest', 'run', 'packages/errors/'], report: 'vitest-json', regression: ['pnpm', 'vitest', 'run'] };

describe('module-scoped verification in the briefs', () => {
  it('the planner selects each node verifier from `mycelink repo modules`', () => {
    for (const text of [doc('skills', 'graph-compilation', 'SKILL.md'), doc('agents', 'portfolio-planner.md'), doc('commands', 'plan.md')]) {
      expect(text).toMatch(/repo modules/);
      expect(text).toMatch(/module_sha256/);
    }
    const skill = doc('skills', 'graph-compilation', 'SKILL.md');
    for (const code of ['UNSCOPED_VERIFICATION', 'COMMAND_NOT_ALLOWLISTED', 'MODULE_VERIFIER_REQUIRED', 'MODULE_COMMAND_MISMATCH', 'MODULE_DRIFT', 'MODULE_SPAN', 'MODULE_NOT_OWNED', 'UNKNOWN_MODULE']) {
      expect(skill).toContain(code);
    }
    expect(skill).toMatch(/full suite/i);
  });

  it('a worker with a module in its pack is told what its gates run', () => {
    const pack = minimalPack({ module });
    for (const prompt of [
      instructions(buildHostWorkerPrompt({ pack, worktree: '/w/wt', resultSlot: '/w/wt/.mycelink-worker/result-1.json', dispatchId: '00000000-0000-0000-0000-000000000001', gates })),
      instructions(buildWorkerPrompt({ pack, gates })),
    ]) {
      expect(prompt).toMatch(/module errors \(packages\/errors\)/);
      expect(prompt).toMatch(/red and green gates run only this module's tests/i);
      expect(prompt).toMatch(/regression gate runs the repository's full suite/i);
      expect(prompt).toMatch(/deferred/i);
      expect(prompt).toMatch(/GATE_COMMAND_BOUND/);
    }
    // ... and a worker without one is not.
    expect(instructions(buildWorkerPrompt({ pack: minimalPack(), gates }))).not.toMatch(/GATE_COMMAND_BOUND/);
  });

  it('the module-worker agent and the node-worker skill say the same', () => {
    for (const text of [doc('agents', 'module-worker.md'), doc('skills', 'node-worker', 'SKILL.md')]) {
      expect(text).toMatch(/module-scoped/i);
      expect(text).toMatch(/full suite/i);
      expect(text).toMatch(/GATE_COMMAND_BOUND/);
      expect(text).toMatch(/deferred/i);
    }
  });
});
