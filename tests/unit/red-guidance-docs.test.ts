/**
 * Every worker brief says what a valid RED is, in the gate's own words.
 *
 * CSET-202 r1: the errors worker statically used a class it had not written
 * yet; core accepted the RED, the replay rejected it as `missing-symbol`.
 * The rule a worker needs — the RED compiles and fails an assertion or the
 * expected domain behaviour; a new export is inspected dynamically or driven
 * through an existing entry point, never statically imported or called
 * before it exists; a refused RED is fixed in the test, not in production —
 * is in the host and print-mode prompts, the pack's rules, the agent and the
 * skill, and the red gate's refusal repeats it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { minimalPack } from '../helpers/context-pack.js';
import { buildHostWorkerPrompt, buildWorkerPrompt } from '../../src/sessions/worker-protocol.js';
import { WORKER_RULES } from '../../src/sessions/context-pack.js';
import { RED_RETRY_GUIDANCE } from '../../src/evidence/red-classify.js';

const gates = [{ gate: 'red' as const, line: 'node /p/bin/mycelink.mjs tdd red F N --capability abc' }];
const instructions = (prompt: string) => prompt.split('<mycelink-context-pack>')[0]!.replace(/\s+/g, ' ');
const doc = (...rel: string[]) => readFileSync(join(REPO_ROOT, ...rel), 'utf8').replace(/\s+/g, ' ');

const RULES = [/must compile and fail an assertion or the expected domain behaviour/i, /inspect the module dynamically/i, /never statically import or call a symbol that does not exist yet/i, /change the test, not production code/i];

describe('the RED rule reaches every worker', () => {
  it('in the host and print-mode prompts', () => {
    const host = instructions(buildHostWorkerPrompt({ pack: minimalPack(), worktree: '/w/wt', resultSlot: '/w/wt/.mycelink-worker/result-1.json', dispatchId: '00000000-0000-0000-0000-000000000001', gates }));
    const print = instructions(buildWorkerPrompt({ pack: minimalPack(), gates }));
    for (const rule of RULES) {
      expect(host).toMatch(rule);
      expect(print).toMatch(rule);
    }
    // The gate's refusal names its category; the brief says what each means.
    for (const prompt of [host, print]) expect(prompt).toMatch(/RED_INVALID:<category>/);
  });

  it('in the pack rules (bounded), the module-worker agent and the node-worker skill', () => {
    expect(WORKER_RULES.some((r) => /compile/.test(r) && /assertion/.test(r) && /never statically import/i.test(r))).toBe(true);
    for (const r of WORKER_RULES) expect(r.length).toBeLessThanOrEqual(300);
    for (const text of [doc('agents', 'module-worker.md'), doc('skills', 'node-worker', 'SKILL.md')]) {
      for (const rule of RULES) expect(text).toMatch(rule);
      expect(text).toMatch(/missing-symbol/);
    }
  });

  it('and the red gate repeats it when it refuses a RED', () => {
    for (const rule of RULES) expect(RED_RETRY_GUIDANCE).toMatch(rule);
  });
});
