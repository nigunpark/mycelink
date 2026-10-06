/**
 * Phase commands return control instead of ending the run.
 *
 * In the informed real-model eval the host invoked /mycelink:init, then
 * /mycelink:prd, committed the PRD and stopped ("I stopped there, as
 * instructed") although the task asked for the complete feature: the PRD
 * command said "Stop when the PRD is written". A phase invoked on its own
 * may report and end there; invoked by /mycelink:run or for an end-to-end
 * request it must hand back and the run continues, stopping only for a real
 * unresolved decision. /mycelink:run names the whole chain, and repairs a
 * failed check inside the same feature (node rework), never under a new
 * feature id.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { runPhases } from '../helpers/run-phases.js';

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** Prose as one line, without emphasis markers, for phrase checks across wrapped lines. */
const prose = (text: string): string => text.replace(/\*\*/g, '').replace(/\s+/g, ' ');
const PHASES = ['commands/init.md', 'commands/prd.md', 'commands/plan.md'];

describe('phase commands do not end an end-to-end run', () => {
  for (const file of PHASES) {
    it(`${file} never tells the host to stop unconditionally`, () => {
      const text = read(file);
      expect(text).not.toMatch(/^Stop when the PRD is written/m);
      expect(text).not.toMatch(/^Do not plan or implement\.?$/m);
      expect(text).not.toMatch(/^Show the user the node list and the READY set\. Do not start implementing\.?$/m);
      // It says what happens when it is one phase of a larger request.
      expect(text).toMatch(/## When this is one phase of a run/);
      expect(text).toMatch(/\/mycelink:run/);
      expect(prose(text)).toMatch(/continue (immediately )?with/i);
      expect(prose(text)).toMatch(/do not stop/i);
    });
  }

  it('no command, skill or agent tells the host to stop after the PRD or the plan', () => {
    const files = [
      ...readdirSync(join(REPO_ROOT, 'commands')).map((f) => `commands/${f}`),
      ...readdirSync(join(REPO_ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`),
      ...readdirSync(join(REPO_ROOT, 'agents')).map((f) => `agents/${f}`),
    ];
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toMatch(/(?<!not )stop (here|there|when the (PRD|plan|graph))/i);
    }
  });

  it('/mycelink:run chains every phase, in order, and continues through them', () => {
    const run = read('commands/run.md');
    expect(runPhases(run)).toEqual(['init', 'prd', 'plan', 'dispatch', 'settle', 'candidate', 'deliver']);
    expect(prose(run)).toMatch(/do not stop between phases/i);
    expect(prose(run)).toMatch(/real unresolved (product )?decision/i);
  });

  it('/mycelink:run repairs inside the same feature with node rework, never a new feature id', () => {
    const run = read('commands/run.md');
    expect(run).toContain('node rework $0 <node-id> --reason');
    expect(prose(run)).toMatch(/never (create|invent|start) a new or follow-up feature/i);
    const skill = read('skills/host-dispatch/SKILL.md');
    expect(skill).toContain('node rework');
    const attribution = read('skills/integration-failure-attribution/SKILL.md');
    expect(attribution).toContain('node rework');
    expect(attribution).not.toMatch(/It also resets the attempt budget/);
  });
});
