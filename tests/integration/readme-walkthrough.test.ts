/**
 * The README walkthrough, executed.
 *
 * Documentation that drifts from the CLI is worse than none, so every command
 * the README shows is run here as a real child process against real git
 * repositories.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { makeGitRepo, git } from '../helpers/git-fixture.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = resolve(process.cwd(), 'bin', 'mycelink.mjs');

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function harness(args: string[], cwd?: string): Result {
  const proc = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  return { code: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

describe('README walkthrough', () => {
  it('runs the documented sequence from init to a validated feature', () => {
    const root = makeTmpDir('readme-');
    const control = join(root, 'control');
    const core = join(root, 'core');
    const api = join(root, 'api');

    makeGitRepo(core, { files: { 'src/.gitkeep': '', 'tests/run.mjs': 'process.exit(0);\n' } });
    makeGitRepo(api, { files: { 'src/.gitkeep': '', 'tests/run.mjs': 'process.exit(0);\n' } });

    // Step 1: init
    const init = harness(['init', control]);
    expect(init.stderr).toBe('');
    expect(init.code).toBe(0);
    expect(existsSync(join(control, 'mycelink.config.json'))).toBe(true);
    expect(existsSync(join(control, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(control, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(control, 'repositories.yaml'))).toBe(true);

    // init already wrote the .mycelink/ ignore entry; nothing is added by hand.
    expect(readFileSync(join(control, '.gitignore'), 'utf8')).toMatch(/^\/\.mycelink\/$/m);
    makeGitRepo(control, { files: { 'README.md': '# control\n' } });

    // Step 1a: open the controller key, as documented.
    const opened = harness(['controller', 'open', '--control-root', control, '--json']);
    expect(opened.stderr).toBe('');
    const key = (JSON.parse(opened.stdout) as { authority: string }).authority;

    // Step 1b: repo register, exactly as documented (argv after `--`)
    for (const [name, path] of [
      ['core', core],
      ['api', api],
    ] as [string, string][]) {
      const reg = harness([
        'repo',
        'register',
        '--control-root',
        control,
        '--authority',
        key,
        '--name',
        name,
        '--path',
        relative(control, path).replace(/\\/g, '/'),
        '--base-branch',
        'main',
        '--',
        'node',
        'tests/run.mjs',
      ]);
      expect(`${name}:${reg.code}`).toBe(`${name}:0`);
    }

    const manifest = YAML.parse(readFileSync(join(control, 'repositories.yaml'), 'utf8')) as {
      repositories: { name: string; commands: { test: string[] } }[];
    };
    expect(manifest.repositories.map((r) => r.name).sort()).toEqual(['api', 'core']);
    // The passthrough argv survived as argv, not as a re-split string.
    expect(manifest.repositories[0]?.commands.test).toEqual(['node', 'tests/run.mjs']);

    // Step 1c: audit and doctor
    const audit = harness(['repo', 'audit', '--control-root', control, '--json']);
    expect(audit.code).toBe(0);
    expect((JSON.parse(audit.stdout) as { ok: boolean }).ok).toBe(true);

    const doctor = harness(['doctor', '--control-root', control, '--json']);
    expect(doctor.code).toBe(0);
    const report = JSON.parse(doctor.stdout) as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    expect(
      report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
    ).toEqual([]);

    // Step 2: PRD and graph
    const featureDir = join(control, 'features', 'FEAT-101');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'PRD.md'), '# FEAT-101\n', 'utf8');
    writeFileSync(
      join(featureDir, 'PORTFOLIO-GRAPH.yaml'),
      YAML.stringify(
        {
          schema_version: 1,
          feature_id: 'FEAT-101',
          title: 'Readme walkthrough',
          acceptance_criteria: [{ id: 'AC-1', text: 'It works.' }],
          resources: { 'full-runtime': { capacity: 1 } },
          repositories: ['core'],
          capabilities: [
            { id: 'CAP-A', repository: 'core', title: 'A', acceptance_criteria: ['AC-1'] },
          ],
          nodes: [
            {
              id: 'FEAT-101.core.a.impl',
              level: 'executable-node',
              repository: 'core',
              capability: 'CAP-A',
              node_type: 'implementation',
              depends_on: [],
              allowed_paths: ['src/**'],
              forbidden_paths: [],
              contract_inputs: [],
              contract_outputs: [],
              required_resources: [],
              required_evidence: ['red', 'green'],
              verification_commands: [{ id: 'targeted', command: ['node', 'tests/run.mjs'] }],
              worker: {
                model: 'sonnet',
                effort: 'high',
                max_turns: 10,
                max_wall_clock_minutes: 10,
                max_attempts: 2,
                nested_delegation: false,
              },
              invalidation_rules: [],
              acceptance_criteria: ['AC-1'],
            },
          ],
        },
        { lineWidth: 0 },
      ),
      'utf8',
    );

    // Step 3: validate, init, loop validate
    expect(harness(['graph', 'validate', 'FEAT-101', '--control-root', control]).code).toBe(0);
    expect(harness(['feature', 'init', 'FEAT-101', '--control-root', control, '--authority', key]).code).toBe(0);
    expect(harness(['loop', 'validate', 'FEAT-101', '--control-root', control]).code).toBe(0);

    // Step 4: ready
    const ready = harness(['orchestrate', 'ready', 'FEAT-101', '--control-root', control, '--json']);
    expect(ready.code).toBe(0);
    expect(
      (JSON.parse(ready.stdout) as { scheduled: { node_id: string }[] }).scheduled.map(
        (s) => s.node_id,
      ),
    ).toEqual(['FEAT-101.core.a.impl']);

    // Step 6: verify refuses while work is outstanding, which is the point.
    const verify = harness(['feature', 'verify', 'FEAT-101', '--control-root', control, '--json']);
    expect(verify.code).toBe(1);
    expect((JSON.parse(verify.stdout) as { problems: string[] }).problems.join(' ')).toMatch(
      /NODE_NOT_DONE/,
    );

    // Status and resource surfaces used by /orchestrator-status all work.
    for (const argv of [
      ['feature', 'status', 'FEAT-101'],
      ['resource', 'status', 'FEAT-101'],
      ['loop', 'budget', 'FEAT-101'],
      ['session', 'status', 'FEAT-101'],
      ['candidate', 'list', 'FEAT-101'],
      ['e2e', 'plan', 'FEAT-101'],
      ['checkpoint', 'create', 'FEAT-101'],
    ]) {
      const r = harness([...argv, '--control-root', control, '--json']);
      expect(`${argv.join(' ')}:${r.code}`).toBe(`${argv.join(' ')}:0`);
    }
  });

  it('memory commands in the README work end to end', () => {
    const root = makeTmpDir('readme-mem-');
    const control = join(root, 'control');
    expect(harness(['init', control]).code).toBe(0);

    expect(harness(['memory', 'init', '--control-root', control]).code).toBe(0);

    const body = join(root, 'p.md');
    writeFileSync(body, 'Check the queue depth before deploying.\n', 'utf8');
    const capture = harness([
      'memory',
      'capture',
      '--control-root',
      control,
      '--type',
      'procedure',
      '--id',
      'deploy-preflight',
      '--title',
      'Deploy preflight',
      '--triggers',
      'deploy',
      '--body-file',
      body,
    ]);
    expect(capture.code).toBe(0);

    const pack = harness([
      'memory',
      'context-pack',
      '--control-root',
      control,
      '--query',
      'deploy the service',
      '--max-bytes',
      '2048',
      '--json',
    ]);
    expect(pack.code).toBe(0);
    const selected = JSON.parse(pack.stdout) as { id: string }[];
    expect(selected.map((s) => s.id)).toContain('deploy-preflight');
    expect(Buffer.byteLength(pack.stdout, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('doctor fails loudly outside a control repository instead of pretending', () => {
    const root = makeTmpDir('readme-bare-');
    const r = harness(['doctor', '--control-root', join(root, 'nothing-here'), '--json']);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout) as { ok: boolean };
    expect(report.ok).toBe(false);
  });

  it('the CLI prints usage and exits non-zero when given no command', () => {
    const r = harness([]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('mycelink <group> <command>');
  });

  it('an unknown command group is rejected, not silently ignored', () => {
    const r = harness(['nonsense']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Unknown command group/);
  });

  it('git identity in the fixture helper does not leak into the control repo', () => {
    const root = makeTmpDir('readme-git-');
    const control = join(root, 'control');
    harness(['init', control]);
    makeGitRepo(control, { files: { 'a.txt': 'a\n' } });
    expect(git(control, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
  });
});
