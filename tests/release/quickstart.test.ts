/**
 * The public quickstart (examples/quickstart) keeps working and keeps saying
 * what it does: its own model-free verifier passes every check — separate
 * repositories, the published baseline SHAs, baselines that pass their tests
 * and do not hold the feature, a graph that validates and initialises with
 * the API node alone READY, an acceptance manifest equal to what Mycelink
 * cuts from the PRD, setup's refusals, and documented commands that exist.
 * The root README's Quickstart gives the same commands and says the sample
 * output is scripted. It lives in the repository only: the release ZIP never
 * carries it.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const QUICKSTART = join(ROOT, 'examples', 'quickstart');

describe('examples/quickstart', () => {
  it('verify-demo.mjs passes every check', () => {
    const r = spawnSync(process.execPath, [join(QUICKSTART, 'verify-demo.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 240_000 });
    let report: { ok: boolean; results: { name: string; ok: boolean; detail?: string }[] };
    try {
      report = JSON.parse(r.stdout) as typeof report;
    } catch {
      throw new Error(`verify-demo printed no report (exit ${r.status}):\n${r.stdout}${r.stderr}`);
    }
    expect(report.results.filter((x) => !x.ok)).toEqual([]);
    expect(report.results.length).toBeGreaterThanOrEqual(20);
    expect(r.status).toBe(0);
  }, 300_000);

  it('starts every process through one argv-only spawn, never a shell', () => {
    const scripts = ['setup.mjs', 'walkthrough.mjs', 'verify-demo.mjs', 'lib/quickstart.mjs', 'acceptance/probe.mjs'];
    const spawning = scripts.filter((file) => readFileSync(join(QUICKSTART, file), 'utf8').includes('node:child_process'));
    expect(spawning).toEqual(['lib/quickstart.mjs']);
    const lib = readFileSync(join(QUICKSTART, 'lib', 'quickstart.mjs'), 'utf8');
    expect(lib).toMatch(/^import \{ spawnSync \} from 'node:child_process';$/m);
    expect(lib).toMatch(/shell: false/);
    expect(lib).not.toMatch(/shell:\s*true/);
  });

  it("the root README's Quickstart gives the demo's own commands and labels the sample as scripted", () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const section = /^## Quickstart\n([\s\S]*?)^---$/m.exec(readme)?.[1] ?? '';
    const walkthrough = readFileSync(join(QUICKSTART, 'README.md'), 'utf8');
    for (const text of [section, walkthrough]) {
      expect(text).toContain('node examples/quickstart/setup.mjs --out ../mycelink-quickstart');
      expect(text).toContain('/mycelink:run ORD-101');
    }
    const scripts = [...section.matchAll(/node examples\/quickstart\/([\w/.-]+\.mjs)/g)].map((m) => m[1]);
    expect(new Set(scripts)).toEqual(new Set(['setup.mjs', 'verify-demo.mjs', 'walkthrough.mjs']));
    const setupHelp = spawnSync(process.execPath, [join(QUICKSTART, 'setup.mjs'), '--help'], { encoding: 'utf8', windowsHide: true }).stdout;
    const flags = [...section.matchAll(/setup\.mjs[^\n]*/g)].flatMap((m) => m[0].match(/--[a-z]+/g) ?? []);
    for (const flag of new Set(flags)) expect(setupHelp, flag).toContain(flag);
    expect(section).toMatch(/SAMPLE-OUTPUT\.md\)\s+is a deterministic scripted walkthrough, \*\*not a model run\*\*/);
    expect(section).not.toMatch(/FEAT-101|pricing|storefront|mycelink-demo/);
  });

  it('is not part of the release ZIP', () => {
    const pkg = readFileSync(join(ROOT, 'scripts', 'package.mjs'), 'utf8');
    const dirs = /const INCLUDE_DIRS = \[([^\]]*)\]/.exec(pkg)?.[1] ?? '';
    expect(dirs).not.toContain('examples');
  });
});
