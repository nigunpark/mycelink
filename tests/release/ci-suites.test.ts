/**
 * No required suite silently disappears from CI.
 *
 * `npm test`, CI and the release workflow run the suites through one runner
 * (scripts/test-suites.mjs), bounded and sharded. Every file Vitest collects
 * belongs to exactly one suite and one shard; every suite and shard is run by
 * exactly one CI group; both workflows run every group, on every OS and Node
 * version CI claims; nothing in them runs an unbounded `vitest run` or
 * `npm test` any more (CI 38347201692).
 */
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import YAML from 'yaml';
// @ts-expect-error -- plain ESM script without type declarations
import { CI_GROUPS, PROVIDER_GROUPS, PROVIDER_FILES, DEFAULT_WEIGHT, SUITES, collectedFiles, descendants, describeProcesses, etimeMs, processTable, selection, shardsOf } from '../../scripts/test-suites.mjs';

const ROOT = resolve(process.cwd());
const workflow = (f: string) => YAML.parse(readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8')) as { jobs: Record<string, any> };
type Group = { id: string; runs: string[] };
const suites = Object.keys(SUITES) as string[];

/** What Vitest itself collects with the repository's config. */
function vitestCollects(): string[] {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
  const list = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--filesOnly', '--json'], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  expect(list.status, list.stderr).toBe(0);
  return (JSON.parse(list.stdout) as { file: string }[]).map((f) => relative(ROOT, f.file).replace(/\\/g, '/')).sort();
}

describe('the suites', () => {
  it('are exactly what Vitest collects: every file in one suite, none twice, none left out', () => {
    const collected = vitestCollects();
    expect(collectedFiles()).toEqual(collected);
    const bySuite = suites.flatMap((s) => selection(s).files as string[]);
    expect([...bySuite].sort()).toEqual(collected);
    expect(new Set(bySuite).size).toBe(bySuite.length);
    for (const s of ['unit', 'integration', 'security', 'fixtures', 'release', 'provider-claude', 'provider-codex', 'benchmark']) expect(selection(s).files.length, s).toBeGreaterThan(0);
  });

  it('cut each suite into shards that partition it, and bound how many files run at once', () => {
    for (const s of suites) {
      const shards = shardsOf(s) as { files: string[] }[];
      expect(shards.length, s).toBe(SUITES[s].shards);
      const all = shards.flatMap((x) => x.files);
      expect([...all].sort(), s).toEqual(selection(s).files);
      expect(new Set(all).size, s).toBe(all.length);
      for (const x of shards) expect(x.files.length, s).toBeGreaterThan(0);
      expect(SUITES[s].maxWorkers, s).toBeGreaterThanOrEqual(1);
      expect(SUITES[s].maxWorkers, s).toBeLessThanOrEqual(3);
      // A bound on every test: the config's 120 s, or at most 300 s for the workflow suites.
      expect(SUITES[s].timeoutMs ?? 120_000, s).toBeLessThanOrEqual(300_000);
    }
    expect(Object.keys(SUITES).filter((s) => SUITES[s].timeoutMs !== undefined).sort()).toEqual(['benchmark', 'fixtures', 'integration', 'provider-claude', 'provider-codex']);
  });

  it('weigh only files that exist', () => {
    const weights = JSON.parse(readFileSync(join(ROOT, 'scripts', 'test-weights.json'), 'utf8')) as Record<string, number>;
    const collected = new Set(collectedFiles());
    expect(Object.keys(weights).filter((f) => !collected.has(f))).toEqual([]);
  });

  it('isolates provider adapters, hooks and plugins from neutral suites without losing Codex fences', () => {
    const claude = selection('provider-claude').files as string[];
    const codex = selection('provider-codex').files as string[];
    expect(claude).toEqual([...PROVIDER_FILES.claude].sort());
    expect(codex).toEqual([...PROVIDER_FILES.codex].sort());
    expect(claude).toContain('tests/plugin-e2e/isolated-plugin.test.ts');
    expect(codex).toContain('tests/plugin-e2e/codex-release-zip-lifecycle.test.ts');
    expect(codex).toContain('tests/integration/codex-session-adapter.test.ts');
    expect(codex).toContain('tests/security/codex-host-fence.test.ts');
    const namedCodex = collectedFiles().filter((f: string) => /codex.*\.test\.ts$/.test(f) && !f.startsWith('tests/benchmark/'));
    expect(codex).toEqual(expect.arrayContaining(namedCodex));
    const neutral = Object.keys(SUITES).filter((s) => !s.startsWith('provider-')).flatMap((s) => selection(s).files as string[]);
    expect(neutral.filter((f) => [...claude, ...codex].includes(f))).toEqual([]);
  });

  // CI 38443874383: one benchmark file held a third of its suite, and the shard it filled ran into the 60-minute job
  // bound on Windows. However many shards a suite has, none can be shorter than its heaviest file.
  it('balance each sharded suite: every benchmark file weighed, none heavier than an even share, no shard far above one', () => {
    const weights = JSON.parse(readFileSync(join(ROOT, 'scripts', 'test-weights.json'), 'utf8')) as Record<string, number>;
    expect(selection('benchmark').files.filter((f: string) => weights[f] === undefined)).toEqual([]);
    for (const s of suites.filter((x) => SUITES[x].shards > 1)) {
      const shards = shardsOf(s) as { files: string[]; weight: number }[];
      const share = shards.reduce((n, x) => n + x.weight, 0) / shards.length;
      const heaviest = Math.max(...shards.flatMap((x) => x.files.map((f) => weights[f] ?? DEFAULT_WEIGHT)));
      expect(heaviest, s).toBeLessThanOrEqual(share);
      expect(Math.max(...shards.map((x) => x.weight)), s).toBeLessThanOrEqual(share * 1.25);
    }
  });
});

describe('the CI groups', () => {
  it('run every suite, and every shard of it, exactly once', () => {
    const runs = ([...CI_GROUPS, ...PROVIDER_GROUPS] as Group[]).flatMap((g) => g.runs);
    const expected = suites.flatMap((s) => (SUITES[s].shards === 1 ? [s] : Array.from({ length: SUITES[s].shards }, (_, i) => `${s}:${i + 1}/${SUITES[s].shards}`)));
    expect([...runs].sort()).toEqual([...expected].sort());
  });

  it.each(['ci.yml', 'release.yml'])('are all run by %s, by the runner, and nothing runs the suites unbounded', (f) => {
    const wf = workflow(f);
    const test = wf.jobs['test'];
    const expected = f === 'ci.yml' ? CI_GROUPS : [...CI_GROUPS, ...PROVIDER_GROUPS];
    expect(test.strategy.matrix.group).toEqual((expected as Group[]).map((g) => g.id));
    const runs = (test.steps as { run?: string; name?: string }[]).filter((s) => s.run !== undefined);
    expect(runs.map((s) => s.run)).toContain('node scripts/test-suites.mjs ci ${{ matrix.group }}');
    expect(runs.find((s) => s.run!.includes('test-suites.mjs'))!.name).toBe('Test ${{ matrix.group }}');
    expect(String(test.name)).toContain('${{ matrix.group }}');
    expect(test['timeout-minutes']).toBeLessThanOrEqual(60);
    const text = readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8');
    expect(text).not.toMatch(/\bnpm test\b|\bnpx vitest\b|vitest run(?! --config vitest\.pilot)/);
  });

  it('gate the release package on every group', () => {
    expect(workflow('release.yml').jobs['verify'].needs).toBe('test');
    expect(workflow('release.yml').jobs['publish'].needs).toBe('verify');
  });

  it('gates a dedicated provider matrix on three OSes and two Node versions with no model credentials', () => {
    const provider = workflow('ci.yml').jobs['provider'];
    expect(provider.strategy.matrix).toMatchObject({ os: ['ubuntu-latest', 'windows-latest', 'macos-latest'], node: ['22.12.0', '24'], provider: ['claude', 'codex'] });
    expect(provider.steps.some((s: { run?: string }) => s.run === 'node scripts/test-suites.mjs ci provider-${{ matrix.provider }}')).toBe(true);
    expect(provider.steps.find((s: { run?: string }) => s.run?.includes('claude-code@'))?.if).toBe("matrix.provider == 'claude'");
    expect(provider.steps.find((s: { run?: string }) => s.run === 'claude --version')?.if).toBe("matrix.provider == 'claude'");
    expect(provider.steps.find((s: { run?: string }) => s.run?.includes('test-suites.mjs'))?.env).toMatchObject({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_API_KEY: '', MYCELINK_LIVE_CODEX_PLUGIN: '0' });
    const blocked = readFileSync(join(ROOT, 'tests/plugin-e2e/codex-release-zip-lifecycle.test.ts'), 'utf8');
    expect(blocked).toContain("it.skip('SKIP CODEX_RUNTIME_DENIED:");
    expect(blocked).toContain('production dispatch');
  });

  it('are what npm test and the suite scripts run', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['test']).toBe('node scripts/test-suites.mjs all');
    for (const [script, suite] of [['test:unit', 'unit'], ['test:integration', 'integration'], ['test:security', 'security'], ['test:fixture', 'fixtures'], ['test:release', 'release'], ['test:benchmark', 'benchmark']]) {
      expect(scripts[script!], script).toBe(`node scripts/test-suites.mjs run ${suite}`);
    }
    expect(scripts['test:plugin']).toBe('node scripts/test-suites.mjs run provider-claude provider-codex');
  });
});

describe('a suite that does not end', () => {
  // CI 38635817750: a Vitest worker blocked in a synchronous child times out nothing of its own; the runner says what runs.
  it('is described by what runs below its Vitest: each process under its parent, with its age and command', async () => {
    const holder = spawn(process.execPath, ['-e', "require('node:child_process').spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000) /* the stuck child */'], { stdio: 'ignore' })"], { stdio: 'ignore', windowsHide: true });
    try {
      let listed: string | null = null;
      for (let i = 0; i < 100 && !(listed ?? '').includes('the stuck child'); i++) {
        await new Promise((r) => setTimeout(r, 200));
        listed = describeProcesses(processTable(), holder.pid, 0);
      }
      expect(listed, 'no stuck child listed').toMatch(/^ {2}pid \d+ \(parent \d+\), \d+ s: .*setInterval\(\(\) => \{\}, 1000\) \/\* the stuck child \*\//m);
      // Only what has run at least as long as asked.
      expect(describeProcesses(processTable(), holder.pid, 24 * 3600_000)).toBeNull();
    } finally {
      const table = processTable();
      for (const p of descendants(table, holder.pid)) {
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
      holder.kill('SIGKILL');
    }
  }, 60_000);

  it("reads ps's elapsed times", () => {
    expect([etimeMs('00:07'), etimeMs('12:34'), etimeMs('01:02:03'), etimeMs('2-00:00:01'), etimeMs('nonsense')]).toEqual([7000, 754_000, 3_723_000, 172_801_000, 0]);
  });
});
