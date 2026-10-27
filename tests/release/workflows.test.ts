/**
 * GitHub Actions hardening.
 *
 * Least-privilege tokens, third-party actions pinned to full commit SHAs, no
 * pull_request_target, no untrusted expressions interpolated into scripts,
 * and a CI matrix that backs every platform claim in the README.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(process.cwd());
const DIR = join(ROOT, '.github', 'workflows');

interface Step {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  permissions?: Record<string, string> | string;
  'runs-on'?: string;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown> | string[] | string;
  permissions?: Record<string, string> | string;
  jobs: Record<string, Job>;
}

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.yml')) : [];
const load = (f: string): Workflow => YAML.parse(readFileSync(join(DIR, f), 'utf8')) as Workflow;

describe('workflows', () => {
  it('exist for CI, CodeQL, Scorecard and release', () => {
    expect(files.sort()).toEqual(['ci.yml', 'codeql.yml', 'release.yml', 'scorecard.yml']);
  });

  it.each(files)('%s pins every third-party action to a full commit SHA', (f) => {
    for (const job of Object.values(load(f).jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        expect(step.uses, `${f}: ${step.uses}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
    // Keep a human-readable version next to each pin.
    const text = readFileSync(join(DIR, f), 'utf8');
    for (const line of text.split('\n').filter((l) => /uses:\s*\S+@[0-9a-f]{40}/.test(l))) {
      expect(line, `${f}: missing version comment`).toMatch(/#\s*v\d/);
    }
  });

  it.each(files)('%s never uses pull_request_target', (f) => {
    expect(readFileSync(join(DIR, f), 'utf8')).not.toMatch(/pull_request_target/);
  });

  it.each(files)('%s declares least-privilege permissions at the top level', (f) => {
    const wf = load(f);
    expect(wf.permissions, f).toBeDefined();
    if (typeof wf.permissions === 'string') {
      expect(wf.permissions).toBe('read-all');
    } else {
      for (const value of Object.values(wf.permissions ?? {})) expect(value, f).not.toBe('write');
    }
  });

  it.each(files)('%s never interpolates event data directly into a script', (f) => {
    for (const job of Object.values(load(f).jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? '', f).not.toMatch(/\$\{\{\s*github\.(event|head_ref|ref_name)/);
      }
    }
  });

  it.each(files)('%s checks out without persisting credentials', (f) => {
    for (const job of Object.values(load(f).jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/checkout@')) {
          expect(step.with?.['persist-credentials'], f).toBe(false);
        }
      }
    }
  });
});

describe('ci.yml', () => {
  const ci = existsSync(join(DIR, 'ci.yml')) ? load('ci.yml') : ({ on: {}, jobs: {} } as Workflow);

  it('runs on pull requests and pushes with read-only jobs', () => {
    expect(Object.keys(ci.on as Record<string, unknown>)).toEqual(expect.arrayContaining(['push', 'pull_request']));
    for (const job of Object.values(ci.jobs)) {
      const perms = job.permissions;
      if (perms && typeof perms !== 'string') for (const v of Object.values(perms)) expect(v).not.toBe('write');
    }
  });

  it('covers Windows, Linux and macOS on Node 22.12 and 24, for the checks and every test group', () => {
    for (const job of ['checks', 'test']) {
      const matrix = ci.jobs[job]?.strategy?.matrix as { os: string[]; node: string[] };
      expect([...matrix.os].sort(), job).toEqual(['macos-latest', 'ubuntu-latest', 'windows-latest']);
      expect(matrix.node, job).toEqual(['22.12.0', '24']);
    }
  });

  it('runs every required gate', () => {
    const runs = (ci.jobs['checks']?.steps ?? []).map((s) => s.run ?? '').join('\n');
    for (const gate of ['npm ci', 'npm audit', 'npm run typecheck', 'npm run build', 'git diff --exit-code', 'claude plugin validate --strict .', 'npm run package']) {
      expect(runs, gate).toContain(gate);
    }
    const tests = (ci.jobs['test']?.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(tests).toContain('node scripts/test-suites.mjs ci ${{ matrix.group }}');
  });

  it('compares independently built OS artifacts after all package matrix legs finish', () => {
    const uploads = ci.jobs['checks'].steps?.filter((s) => s.uses?.startsWith('actions/upload-artifact@')) ?? [];
    expect(uploads).toHaveLength(1);
    expect(uploads[0].with?.['name']).toBe('mycelink-package-${{ matrix.os }}');
    expect(uploads[0].if).toBe("matrix.node == '24'");
    const compare = ci.jobs['compare-package'] as Job & { needs: string };
    expect(compare.needs).toBe('checks');
    expect(compare.steps?.find((s) => s.uses?.startsWith('actions/download-artifact@'))?.with?.['pattern']).toBe('mycelink-package-*');
    expect(compare.steps?.some((s) => s.run === 'node scripts/compare-package-hashes.mjs artifacts')).toBe(true);
  });
});

describe('release artifact hash comparison', () => {
  it('checks actual ZIP and SBOM bytes across three independent outputs, rejects mismatches and missing artifacts', () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mycelink-artifact-hashes-'));
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
    const zip = `mycelink-${version}.zip`;
    const dirs = ['ubuntu-latest', 'windows-latest', 'macos-latest'];
    const call = () => spawnSync(process.execPath, [join(ROOT, 'scripts/compare-package-hashes.mjs'), root], { encoding: 'utf8' });
    try {
      for (const name of dirs) {
        const dir = join(root, `mycelink-package-${name}`);
        mkdirSync(dir);
        writeFileSync(join(dir, zip), 'zip bytes');
        writeFileSync(join(dir, `${zip}.sha256`), `${createHash('sha256').update('zip bytes').digest('hex')}  ${zip}\n`);
        writeFileSync(join(dir, 'SBOM.spdx.json'), '{"spdxVersion":"SPDX-2.3"}\n');
      }
      expect(call().status).toBe(0);
      writeFileSync(join(root, 'mycelink-package-windows-latest', zip), 'tampered zip');
      expect(call().status).not.toBe(0);
      writeFileSync(join(root, 'mycelink-package-windows-latest', zip), 'zip bytes');
      rmSync(join(root, 'mycelink-package-macos-latest', 'SBOM.spdx.json'));
      expect(call().status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release.yml', () => {
  const rel = existsSync(join(DIR, 'release.yml')) ? load('release.yml') : ({ on: {}, jobs: {} } as Workflow);

  it('is tag-driven', () => {
    const on = rel.on as { push?: { tags?: string[] } };
    expect(on.push?.tags).toEqual(['v*']);
  });

  it('grants contents: write only to the publishing job', () => {
    const writers = Object.entries(rel.jobs).filter(([, j]) => typeof j.permissions === 'object' && j.permissions['contents'] === 'write');
    expect(writers.map(([name]) => name)).toEqual(['publish']);
  });

  it('verifies, packages reproducibly and uploads zip, checksum and SBOM', () => {
    const text = readFileSync(join(DIR, 'release.yml'), 'utf8');
    for (const needle of ['node scripts/test-suites.mjs ci', 'claude plugin validate --strict .', 'npm run package', 'SOURCE_DATE_EPOCH', '.zip.sha256', 'SBOM.spdx.json', 'gh release create']) {
      expect(text, needle).toContain(needle);
    }
  });
});

describe('codeql.yml', () => {
  const ql = existsSync(join(DIR, 'codeql.yml')) ? load('codeql.yml') : ({ on: {}, jobs: {} } as Workflow);
  const init = Object.values(ql.jobs).flatMap((j) => j.steps ?? []).find((s) => s.uses?.startsWith('github/codeql-action/init@'));

  it('runs on pull requests, pushes to main and a schedule, with the security-extended queries', () => {
    expect(Object.keys(ql.on as Record<string, unknown>)).toEqual(expect.arrayContaining(['push', 'pull_request', 'schedule']));
    expect(init?.with?.['languages']).toBe('javascript-typescript');
    expect(init?.with?.['queries']).toBe('security-extended');
  });

  it('scans the shipped runtime sources, hooks, scripts and the executable eval tooling: only the generated bundle and the fake Claude are left out', () => {
    const config = YAML.parse(String(init?.with?.['config'] ?? '')) as { 'paths-ignore'?: string[]; paths?: string[] } | null;
    // dist/ is generated from src/ (scanned) by scripts/build.mjs; tests/fake-claude is a test stand-in that never ships.
    expect(config?.['paths-ignore'] ?? []).toEqual(['dist', 'tests/fake-claude']);
    expect(config?.paths).toBeUndefined();
    const ignored = config?.['paths-ignore'] ?? [];
    for (const scanned of ['src', 'bin', 'hooks', 'scripts', 'evals-public-projects/lib', 'evals-public-projects/tools', 'evals-multimodule']) {
      expect(ignored.filter((p) => scanned === p || scanned.startsWith(`${p}/`) || p === '**' || p === '*'), scanned).toEqual([]);
    }
  });
});

describe('dependabot.yml', () => {
  interface Update {
    'package-ecosystem': string;
    directory: string;
    schedule?: { interval?: string };
    'open-pull-requests-limit'?: number;
    groups?: Record<string, { 'dependency-type'?: string; patterns?: string[] }>;
    'commit-message'?: { prefix?: string };
    labels?: string[];
  }
  const path = join(ROOT, '.github', 'dependabot.yml');
  const config = existsSync(path) ? (YAML.parse(readFileSync(path, 'utf8')) as { version: number; updates: Update[] }) : { version: 0, updates: [] };
  const update = (ecosystem: string): Update | undefined => config.updates.find((u) => u['package-ecosystem'] === ecosystem);

  it('updates npm and GitHub Actions weekly from the repository root', () => {
    expect(config.version).toBe(2);
    expect(config.updates.map((u) => u['package-ecosystem']).sort()).toEqual(['github-actions', 'npm']);
    for (const u of config.updates) {
      expect(u.directory, u['package-ecosystem']).toBe('/');
      expect(u.schedule?.interval, u['package-ecosystem']).toBe('weekly');
      expect(u['open-pull-requests-limit'], u['package-ecosystem']).toBe(5);
    }
  });

  it('groups npm devDependencies into one pull request', () => {
    const npm = update('npm');
    expect(npm?.groups).toEqual({ 'dev-dependencies': { 'dependency-type': 'development' } });
    expect(npm?.['commit-message']?.prefix).toBe('chore(deps)');
    expect(npm?.labels).toEqual(['dependencies']);
  });

  it('groups every GitHub Actions update into one pull request, so a week of action bumps runs the CI matrix once', () => {
    const actions = update('github-actions');
    expect(actions?.groups).toEqual({ 'github-actions': { patterns: ['*'] } });
    expect(actions?.['commit-message']?.prefix).toBe('chore(ci)');
    expect(actions?.labels).toEqual(['dependencies', 'ci']);
  });
});
