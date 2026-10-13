/**
 * After a plugin update the installed copy can move, leaving the control
 * repository's project hooks pointing at a launcher that no longer exists.
 * `doctor` must say so, and re-running `init` must repair it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli/cli.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { controllerArgv } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

async function run(argv: string[]) {
  const out: string[] = [];
  const code = await main(controllerArgv(argv), { out: (t) => out.push(t), err: () => undefined });
  return { code, out: out.join('\n') };
}

type Check = { name: string; ok: boolean; detail: string };

describe('doctor hook check', () => {
  it('passes right after init', async () => {
    const control = makeTmpDir('dh-');
    expect((await run(['init', control])).code).toBe(0);
    const r = await run(['doctor', '--control-root', control, '--json']);
    const hooks = (JSON.parse(r.out) as { checks: Check[] }).checks.find((c) => c.name === 'hooks');
    expect(hooks?.ok).toBe(true);
  });

  it('fails when the hooks point at a launcher that no longer exists, and init repairs it', async () => {
    const control = makeTmpDir('dh-');
    await run(['init', control]);
    const file = join(control, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    for (const matchers of Object.values(settings.hooks)) {
      for (const m of matchers) {
        for (const h of m.hooks) h.command = h.command.replace(/node "[^"]+mycelink\.mjs"/, 'node "/gone/old-version/bin/mycelink.mjs"');
      }
    }
    writeFileSync(file, JSON.stringify(settings, null, 2));

    const before = await run(['doctor', '--control-root', control, '--json']);
    const check = (JSON.parse(before.out) as { checks: Check[] }).checks.find((c) => c.name === 'hooks');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/mycelink init/);

    await run(['init', control]);
    const after = await run(['doctor', '--control-root', control, '--json']);
    expect((JSON.parse(after.out) as { checks: Check[] }).checks.find((c) => c.name === 'hooks')?.ok).toBe(true);
  });

  it('explains an empty repository manifest instead of printing a schema error', async () => {
    const control = makeTmpDir('dh-');
    await run(['init', control]);
    const r = await run(['doctor', '--control-root', control, '--json']);
    const check = (JSON.parse(r.out) as { checks: Check[] }).checks.find((c) => c.name === 'repositories.yaml');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/no repositories registered yet.*mycelink repo register/);
  });

  it('reports hooks as not installed when init ran with --no-hooks', async () => {
    const control = makeTmpDir('dh-');
    await run(['init', control, '--no-hooks']);
    const r = await run(['doctor', '--control-root', control, '--json']);
    const check = (JSON.parse(r.out) as { checks: Check[] }).checks.find((c) => c.name === 'hooks');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/not installed/);
  });
});
