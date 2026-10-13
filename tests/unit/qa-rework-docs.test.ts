/**
 * What the host does with a defect QA reports after the delivery.
 *
 * Fourth PCM-101 pilot, with-faults arm: QA's report reached a fresh
 * session, which reverted the defect and committed a test on main itself,
 * never called Mycelink, and exited 0 with C001 stale. Every host surface
 * now gives the same steps the benchmark's QA prompt names: the controller
 * never edits or commits product code; it finds the producer node of the
 * reported failure (`feature owners`), reworks it with QA's checks as the
 * reason, dispatches and settles the reopened nodes, cuts and delivers a new
 * candidate, and finishes only once `feature verify --delivered` passes.
 *
 * PCM-103 pilot: the same steps were followed, and `node rework` was refused
 * with REWORK_LIMIT for reworks made before the delivery (fixed in the core);
 * in other runs the model read a conditional paragraph and repaired main
 * itself. `/mycelink:rework` is the dedicated controller entry: the QA prompt
 * names it as the first action, and it attributes and reworks in one
 * deterministic step (`feature rework`) before any product file is read.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
// @ts-expect-error -- plain ESM module without type declarations
import { REWORK_INSTRUCTION } from '../../evals-public-projects/lib/faults.mjs';

const flat = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\*\*/g, '').replace(/\s+/g, ' ');
const read = (rel: string): string => flat(readFileSync(join(REPO_ROOT, rel), 'utf8'));

const HOST = ['commands/rework.md', 'commands/run.md', 'commands/resume.md', 'skills/host-dispatch/SKILL.md'];

/** The steps of a QA repair, as the plugin and the benchmark's prompt both state them. */
const STEPS: [string, RegExp][] = [
  ['never edits product code', /do not edit or commit product code in this session yourself/i],
  ['inspects the status', /feature status/],
  ['attributes to the producer node', /producer node/],
  ['reworks it', /node rework/],
  ['bounded reason', /2000 bytes/],
  ['dispatches to the module-worker', /module-worker/],
  ['settles', /settle/],
  ['cuts a new candidate', /candidate/],
  ['delivers', /deliver/],
  ['finishes on the delivered verify', /feature verify \S+ --delivered/],
];

describe('a defect QA reports after the delivery', () => {
  for (const rel of HOST) {
    it(`${rel}: the controller repairs it through the feature, never with its own edits`, () => {
      const text = read(rel);
      const section = /## A defect QA reports after the delivery(.*?)(## |$)/.exec(text)?.[1] ?? '';
      expect(section, rel).not.toBe('');
      for (const [what, step] of STEPS) expect(section, `${rel}: ${what}`).toMatch(step);
      // How it finds the producer: what moved since the delivery, the paths and the acceptance criteria the checks exercise.
      expect(section).toMatch(/feature owners \S+ (\[[^\]]*\] )*--since-delivery/);
      expect(section).toMatch(/--acceptance/);
      expect(section).toMatch(/never the candidate build/i);
      // A fresh session holds no key: it recovers it first.
      expect(section).toMatch(/controller open --recover/);
      // Product code is the module-worker's; a result the host writes into a ticket's slot is not product code.
      expect(section).toMatch(/result_slot/);
      expect(section).toMatch(/git commit/);
    });
  }

  it('the benchmark’s QA prompt names the same steps, so both arms read what the plugin says', () => {
    const prompt = flat(REWORK_INSTRUCTION);
    for (const [what, step] of STEPS) expect(prompt, what).toMatch(step);
  });

  it('/mycelink:rework is the controller-only entry: one deterministic attribution and rework, then the host loop to the delivery', () => {
    const raw = readFileSync(join(REPO_ROOT, 'commands', 'rework.md'), 'utf8').replace(/\r\n/g, '\n');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(raw)?.[1] ?? '';
    expect(front).toMatch(/^argument-hint: <feature-id> \[QA report\]$/m);
    // The controller dispatches workers; it has no file-writing tool of its own.
    const tools = (/^allowed-tools: (.*)$/m.exec(front)?.[1] ?? '').split(',').map((t) => t.trim());
    expect(tools).toEqual(expect.arrayContaining(['Bash', 'Agent', 'Skill']));
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    const text = flat(raw);
    // Before any product file: the controller-only rule, then the key.
    const rule = text.indexOf('do not edit or commit product code in this session yourself');
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(text.indexOf('controller open --recover'));
    expect(text).toMatch(/before you read or edit anything in a product repository/i);
    // The deterministic step, then the normal loop, in order.
    const order = [/controller open --recover/, /feature status \$0/, /feature rework \$0 --since-delivery (\[[^\]]*\] )*--reason "[^"]*" --json --authority <key>/, /dispatch \$0 --json --authority <key>/, /module-worker/, /settle \$0/, /deliver \$0 --json --authority <key>/, /feature verify \$0 --delivered/];
    let from = 0;
    for (const step of order) {
      const at = text.slice(from).search(step);
      expect(at, `${step} after offset ${from}`).toBeGreaterThanOrEqual(0);
      from += at + 1;
    }
    // What it does when attribution is not unique, and what it never works around.
    expect(text).toMatch(/REWORK_OWNER_AMBIGUOUS[^.]*feature owners/);
    expect(text).toMatch(/REWORK_LIMIT/);
    expect(text).toMatch(/never edit product code instead/i);
  });

  for (const rel of ['commands/run.md', 'commands/resume.md', 'skills/host-dispatch/SKILL.md']) {
    it(`${rel}: QA's report starts with /mycelink:rework and its one-step attribution`, () => {
      const section = /## A defect QA reports after the delivery(.*?)(## |$)/.exec(read(rel))?.[1] ?? '';
      expect(section).toMatch(/\/mycelink:rework/);
      expect(section).toMatch(/feature rework \S+ --since-delivery/);
    });
  }

  it('the QA prompt’s first action is the plugin’s rework command, before anything in the product repository', () => {
    const prompt = flat(REWORK_INSTRUCTION);
    expect(prompt.startsWith('First action, before you read or change anything in the product repository: if the Mycelink plugin is available, invoke its `/mycelink:rework` command with this QA report')).toBe(true);
    expect(prompt).toMatch(/Only if the Mycelink plugin and its commands are genuinely unavailable in this session, repair it directly on the delivery branch, test-first/);
    expect(prompt.indexOf('/mycelink:rework')).toBeLessThan(prompt.indexOf('repair it directly'));
  });
});
