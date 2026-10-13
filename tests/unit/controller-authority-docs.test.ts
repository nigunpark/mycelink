/**
 * The plugin's instructions carry controller authority to the host, and
 * only to the host.
 *
 * Every controller-only command a host-facing command or skill tells the
 * model to run must pass `--authority`, after the host opened it with
 * `mycelink controller open`. Nothing the module-worker reads (its agent
 * definition, the node-worker skill, the ticket prompt builder) may mention
 * how to obtain or pass it, beyond saying it is not the worker's.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { CONTROLLER_ONLY } from '../../src/cli/cli.js';

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** `M <group> [<sub>]` or `mycelink.mjs" <group> [<sub>]` invocations in a line. */
function controllerInvocations(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/(?:\bM|mycelink\.mjs"?)\s+([a-z]+)(?:\s+([a-z]+))?/g)) {
    const group = m[1] as string;
    // `init` of a new directory is the one bootstrap that needs no key.
    if (group === 'init') continue;
    const only = CONTROLLER_ONLY[group];
    if (only === '*' || (only !== undefined && only.has(m[2] ?? ''))) out.push(`${group} ${m[2] ?? ''}`.trim());
  }
  return out;
}

const HOST_DOCS = [
  ...readdirSync(join(REPO_ROOT, 'commands')).map((f) => `commands/${f}`),
  'skills/host-dispatch/SKILL.md',
];

describe('controller authority in the plugin docs', () => {
  for (const rel of HOST_DOCS) {
    it(`${rel}: every controller-only command passes --authority`, () => {
      const missing = read(rel)
        .split('\n')
        .filter((l) => controllerInvocations(l).length > 0 && !l.includes('--authority'));
      expect(missing).toEqual([]);
    });
  }

  it('commands that run controller-only work open the key first', () => {
    for (const rel of HOST_DOCS) {
      const text = read(rel);
      if (!text.split('\n').some((l) => controllerInvocations(l).length > 0)) continue;
      expect(`${rel}: ${/controller open/.test(text)}`).toBe(`${rel}: true`);
    }
  });

  it('/mycelink:run never hands the key to the Agent tool', () => {
    expect(read('commands/run.md')).toMatch(/never (put|pass|give|include)[^.]*(key|authority)[^.]*(prompt|Agent|subagent)/i);
  });

  it('nothing the worker reads tells it how to obtain or pass controller authority', () => {
    for (const rel of ['agents/module-worker.md', 'skills/node-worker/SKILL.md', 'src/sessions/worker-protocol.ts']) {
      const text = read(rel);
      expect(`${rel}: ${/--authority|controller open/.test(text)}`).toBe(`${rel}: false`);
    }
  });
});
