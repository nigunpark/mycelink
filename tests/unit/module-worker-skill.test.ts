/**
 * A host-dispatched module-worker is a subagent of the host session, and
 * Claude Code gives subagents no Skill tool. In the third PCM-101 pilot
 * every worker's first call was `Skill node-worker`, refused with "No such
 * tool available: Skill", because the agent definition and the host ticket
 * both told it to load the skill — while the agent body and the ticket
 * already carry every rule the skill has. Neither asks for a skill now.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { minimalPack } from '../helpers/context-pack.js';
import { buildHostWorkerPrompt, buildWorkerPrompt } from '../../src/sessions/worker-protocol.js';

const gates = [{ gate: 'red' as const, line: 'node /p/bin/mycelink.mjs tdd red F N --capability abc' }];
const agent = readFileSync(join(REPO_ROOT, 'agents', 'module-worker.md'), 'utf8').replace(/\r\n/g, '\n');
const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(agent) ?? [];
/** The fixed instructions of a prompt, before the controller's data-only context pack. */
const instructions = (prompt: string) => prompt.split('<mycelink-context-pack>')[0]!;

describe('a host-dispatched worker is never told to load a skill', () => {
  it('the module-worker agent has no Skill tool and asks for no skill', () => {
    expect(frontmatter).toMatch(/^tools: /m);
    expect(/^tools: (.*)$/m.exec(frontmatter!)![1]!.split(/,\s*/)).not.toContain('Skill');
    expect(body).not.toMatch(/\bskill\b/i);
  });

  it('the host ticket asks for no skill, and says it is complete', () => {
    const prompt = buildHostWorkerPrompt({ pack: minimalPack(), worktree: '/w/wt', resultSlot: '/w/wt/.mycelink-worker/result-1.json', dispatchId: '00000000-0000-0000-0000-000000000001', gates });
    expect(instructions(prompt)).not.toMatch(/\bskill\b/i);
    expect(instructions(prompt)).toMatch(/everything you need is in this prompt/i);
  });

  it('nor does the print-mode prompt', () => {
    expect(instructions(buildWorkerPrompt({ pack: minimalPack(), gates }))).not.toMatch(/\bskill\b/i);
  });
});
