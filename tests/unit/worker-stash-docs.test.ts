/**
 * Every worker is told the stash is shared, and to leave nothing in it
 * (CSET-203 r12).
 *
 * r12's red gate refused a RED over production edits and told the worker to
 * move them aside with `git stash --include-untracked`; worktrees share one
 * stash, so the worker's entries landed in the repository's common Git
 * directory. A worker may still set edits aside there, but the brief — the
 * host and print-mode prompts, the module-worker agent, the node-worker
 * skill — and the red gate's refusal now say the same: the stash is shared
 * by every worktree and the user; take back only your own entry (by name
 * when the newest is not yours) before you finish; an entry left behind is
 * archived and dropped at settle and never part of the work.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { minimalPack } from '../helpers/context-pack.js';
import { buildHostWorkerPrompt, buildWorkerPrompt } from '../../src/sessions/worker-protocol.js';
import { RED_NOT_TEST_ONLY_GUIDANCE } from '../../src/cli/cli.js';

const gates = [{ gate: 'red' as const, line: 'node /p/bin/mycelink.mjs tdd red F N --capability abc' }];
const instructions = (prompt: string) => prompt.split('<mycelink-context-pack>')[0]!.replace(/\s+/g, ' ');
const doc = (...rel: string[]) => readFileSync(join(REPO_ROOT, ...rel), 'utf8').replace(/\s+/g, ' ');

const RULES = [/stash is shared by every worktree/i, /only your own entry/i, /stash@\{N\}/, /before you finish/i, /settle archives and drops any entry your worktree leaves/i];

describe('the shared stash, in every worker brief', () => {
  it('the host and print-mode prompts', () => {
    const host = instructions(buildHostWorkerPrompt({ pack: minimalPack(), worktree: '/w/wt', resultSlot: '/w/wt/.mycelink-worker/result-1.json', dispatchId: '00000000-0000-0000-0000-000000000001', gates }));
    const print = instructions(buildWorkerPrompt({ pack: minimalPack(), gates }));
    for (const rule of RULES) {
      expect(host).toMatch(rule);
      expect(print).toMatch(rule);
    }
  });

  it('the module-worker agent and the node-worker skill', () => {
    for (const text of [doc('agents', 'module-worker.md'), doc('skills', 'node-worker', 'SKILL.md')]) for (const rule of RULES) expect(text).toMatch(rule);
  });

  it('the red gate’s refusal over production edits: set them aside and take them back, or remove them — never a stash left behind', () => {
    expect(RED_NOT_TEST_ONLY_GUIDANCE).toMatch(/stash is shared by every worktree/i);
    expect(RED_NOT_TEST_ONLY_GUIDANCE).toMatch(/take back only your own entry/i);
    expect(RED_NOT_TEST_ONLY_GUIDANCE).toMatch(/leave none behind/i);
    expect(RED_NOT_TEST_ONLY_GUIDANCE).not.toMatch(/\(git stash --include-untracked, or remove them\)/);
  });
});
