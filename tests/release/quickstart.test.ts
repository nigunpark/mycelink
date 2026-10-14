/**
 * The README's quickstart works as far as it can without a model.
 *
 * examples/quickstart/setup.mjs creates the demo workspace; everything the
 * controller does before the first worker (init, the controller key,
 * registering both repositories, audit, doctor, the acceptance manifest cut
 * from the requirement) runs here against the committed runtime. The
 * model-driven run is not part of this check.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';

afterAll(() => cleanupTmpRoots());

const ROOT = resolve(process.cwd());
const EXAMPLE = join(ROOT, 'examples', 'quickstart');
const LAUNCHER = join(ROOT, 'bin', 'mycelink.mjs');

function run(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const mycelink = (cwd: string, ...args: string[]) => run(cwd, [LAUNCHER, ...args]);

describe('examples/quickstart', () => {
  const demo = join(makeTmpDir('qs-'), 'demo');

  it('setup.mjs creates three repositories with one commit on main, and refuses an existing directory', () => {
    const setup = run(ROOT, [join(EXAMPLE, 'setup.mjs'), demo]);
    expect(setup.stderr).toBe('');
    expect(setup.status).toBe(0);
    for (const repo of ['pricing', 'storefront', 'control']) {
      const dir = join(demo, repo);
      expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
      expect(git(dir, ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect(git(dir, ['status', '--porcelain'])).toBe('');
    }
    expect(existsSync(join(demo, 'control', 'requirements', 'FEAT-101.md'))).toBe(true);
    expect(run(ROOT, [join(EXAMPLE, 'setup.mjs'), demo]).status).toBe(2);
  });

  it('both demo repositories pass their own tests before the feature', () => {
    for (const repo of ['pricing', 'storefront']) {
      const r = run(join(demo, repo), ['--test']);
      expect(r.status, `${repo}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('the controller sets up the control repository, registers both repositories and cuts AC-1..AC-4', () => {
    const control = join(demo, 'control');
    expect(mycelink(demo, 'init', 'control').status).toBe(0);
    const opened = mycelink(demo, 'controller', 'open', '--control-root', 'control', '--json');
    expect(opened.status).toBe(0);
    const key = (JSON.parse(opened.stdout) as { authority: string }).authority;
    for (const name of ['pricing', 'storefront']) {
      const reg = mycelink(demo, 'repo', 'register', '--control-root', 'control', '--authority', key, '--name', name, '--path', `../${name}`, '--base-branch', 'main', '--', 'node', '--test');
      expect(reg.status, reg.stderr).toBe(0);
    }
    expect(mycelink(demo, 'repo', 'audit', '--control-root', 'control').status).toBe(0);
    git(control, ['add', '-A']);
    git(control, ['commit', '-q', '-m', 'mycelink control plane']);

    const doctor = mycelink(demo, 'doctor', '--control-root', 'control', '--json');
    const report = JSON.parse(doctor.stdout) as { ok: boolean; checks: { name: string; ok: boolean }[] };
    const check = (name: string) => report.checks.find((c) => c.name === name)?.ok;
    expect(check('repo:pricing')).toBe(true);
    expect(check('repo:storefront')).toBe(true);
    expect(check('control repo is a git repository')).toBe(true);
    expect(report.ok, doctor.stdout).toBe(true);

    const acceptance = mycelink(control, 'feature', 'acceptance', 'FEAT-101', '--source', 'requirements/FEAT-101.md', '--kind', 'AC-4=compatibility', '--json', '--authority', key);
    expect(acceptance.status, acceptance.stderr).toBe(0);
    const criteria = (JSON.parse(acceptance.stdout) as { criteria: { id: string; kind: string }[] }).criteria;
    expect(criteria.map((c) => `${c.id}:${c.kind}`)).toEqual(['AC-1:new-behavior', 'AC-2:new-behavior', 'AC-3:new-behavior', 'AC-4:compatibility']);
  });

  it('the README and the walkthrough give the commands this test runs', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const walkthrough = readFileSync(join(EXAMPLE, 'README.md'), 'utf8');
    for (const text of [readme, walkthrough]) {
      expect(text).toContain('node mycelink/examples/quickstart/setup.mjs mycelink-demo');
      expect(text).toContain('/mycelink:run FEAT-101');
    }
    expect(walkthrough).toContain('control/requirements/FEAT-101.md');
  });
});
