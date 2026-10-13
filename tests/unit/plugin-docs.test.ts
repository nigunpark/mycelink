/**
 * The plugin's own instructions must drive the host-native path.
 *
 * In the forced-activation eval the run command told the top-level agent to
 * call `orchestrate run`, which spawns a nested `claude` that could not start
 * in the sandbox. The commands, skill and agent now describe the loop the
 * controller actually supports from inside Claude Code: dispatch a ticket,
 * fulfil it with the Agent tool and the module-worker subagent, settle it,
 * and finally deliver.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** Lines that tell the reader to run something (numbered steps or code spans with the launcher). */
const steps = (text: string): string[] => text.split('\n').filter((l) => /mycelink\.mjs"? /.test(l));

describe('plugin docs drive host-native dispatch', () => {
  it('/mycelink:run loops dispatch -> Agent(module-worker) -> settle, bounded, then delivers', () => {
    const run = read('commands/run.md');
    expect(run).toMatch(/allowed-tools:.*\bAgent\b/);
    expect(run).toContain('dispatch $0 --json');
    expect(run).toMatch(/Agent tool/);
    expect(run).toContain('module-worker');
    expect(run).toMatch(/result_slot/);
    expect(run).toMatch(/settle \$0 <node-id> --capability <capability> --json|settle_command/);
    expect(run).toContain('deliver $0');
    expect(run).toMatch(/at most \d+|no more than \d+/i);
    for (const status of ['ALL_SETTLED', 'WAITING', 'BLOCKED', 'NEEDS_DECISION', 'BUDGET_EXHAUSTED', 'NO_PROGRESS', 'INFRASTRUCTURE_FAILURE']) {
      expect(run, status).toContain(status);
    }
    // The nested CLI worker is never a step of the plugin's primary path.
    expect(steps(run).filter((l) => /orchestrate (run|once)|session spawn/.test(l))).toEqual([]);
    // Nor may the host do a worker's job or hand-progress nodes.
    expect(run).toMatch(/do not (implement|write) .*yourself/i);
  });

  it('/mycelink:resume reconciles and resumes tickets instead of running a nested worker', () => {
    const resume = read('commands/resume.md');
    expect(resume).toContain('session reconcile $0');
    expect(resume).toContain('dispatch $0 --resume');
    expect(steps(resume).filter((l) => /orchestrate (run|once)/.test(l))).toEqual([]);
  });

  it('/mycelink:cancel abandons outstanding tickets', () => {
    expect(read('commands/cancel.md')).toContain('session reconcile $0 --abandon-dispatches');
  });

  it('/mycelink:deliver exists and only delivers after verification', () => {
    expect(existsSync(join(REPO_ROOT, 'commands', 'deliver.md'))).toBe(true);
    const deliver = read('commands/deliver.md');
    expect(deliver).toContain('feature verify $0');
    expect(deliver).toContain('deliver $0 --json');
    expect(deliver).toMatch(/never push|does not push/i);
  });

  it('the host-dispatch skill documents the loop and its recovery', () => {
    const skill = read('skills/host-dispatch/SKILL.md');
    expect(skill).toMatch(/^---\nname: host-dispatch\ndescription: /);
    for (const needle of ['dispatch', 'settle', '--resume', 'session reconcile', 'deliver', 'result_slot', 'capability']) {
      expect(skill, needle).toContain(needle);
    }
    expect(skill).toMatch(/never (run|call) .*orchestrate run/i);
  });

  it('the module-worker agent writes the absolute result file and never settles itself', () => {
    const agent = read('agents/module-worker.md');
    expect(agent).toMatch(/absolute/i);
    expect(agent).toMatch(/Result file:/);
    expect(agent).toMatch(/never run .*settle/i);
    expect(agent).not.toMatch(/relative to your worktree\)/);
  });
});
