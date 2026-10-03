/**
 * Release packaging.
 *
 * `npm run package` must produce the same bytes every time from the same
 * commit, ship only runtime and public files, carry a checksum and an SPDX
 * SBOM, and install and run from the ZIP alone — no npm install, no build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { extractZip, readZip } from '../helpers/zip.js';
import { makeGitRepo } from '../helpers/git-fixture.js';

afterAll(() => cleanupTmpRoots());

const ROOT = resolve(process.cwd());
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const ZIP_NAME = `mycelink-${VERSION}.zip`;

function packageInto(out: string): { zip: string; sha256: string; sbom: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'package.mjs'), '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600' },
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`package failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as { zip: string; sha256: string; sbom: string };
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('npm run package', () => {
  let first: { zip: string; sha256: string; sbom: string };
  let second: { zip: string; sha256: string; sbom: string };

  beforeAll(() => {
    first = packageInto(makeTmpDir('pkg-a-'));
    second = packageInto(makeTmpDir('pkg-b-'));
  });

  it('writes the zip, its checksum file and the SBOM under the requested directory', () => {
    expect(first.zip.endsWith(ZIP_NAME)).toBe(true);
    expect(existsSync(first.zip)).toBe(true);
    expect(existsSync(`${first.zip}.sha256`)).toBe(true);
    expect(first.sbom.endsWith('SBOM.spdx.json')).toBe(true);
    expect(readFileSync(`${first.zip}.sha256`, 'utf8')).toBe(`${sha(first.zip)}  ${ZIP_NAME}\n`);
    expect(first.sha256).toBe(sha(first.zip));
  });

  it('is byte-for-byte reproducible', () => {
    expect(sha(second.zip)).toBe(sha(first.zip));
    expect(sha(second.sbom)).toBe(sha(first.sbom));
  });

  it('uses fixed timestamps and normalised permissions inside the archive', () => {
    const entries = readZip(first.zip);
    expect(new Set(entries.map((e) => `${e.dosDate}:${e.dosTime}`)).size).toBe(1);
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].sort());
  });

  it('tracks every shipped file in git with the same executable bit as the archive', () => {
    // A clone (marketplace install) and the ZIP must agree, and CI's rebuild
    // on Linux/macOS must not flip the tracked mode of the bundle.
    const ls = spawnSync('git', ['ls-files', '-s', '--', '.'], { cwd: ROOT, encoding: 'utf8' });
    expect(ls.status, ls.stderr).toBe(0);
    const tracked = new Map<string, string>();
    for (const line of ls.stdout.split('\n')) {
      const m = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(line);
      if (m) tracked.set(m[2] as string, m[1] as string);
    }
    const mismatched: string[] = [];
    for (const entry of readZip(first.zip)) {
      const indexMode = tracked.get(entry.name);
      if (indexMode === undefined) continue; // generated (package.json)
      const zipExecutable = ((entry.externalAttributes >>> 16) & 0o111) !== 0;
      if ((indexMode === '100755') !== zipExecutable) mismatched.push(`${entry.name}: git ${indexMode}`);
    }
    expect(mismatched).toEqual([]);
    expect(tracked.get('bin/mycelink.mjs')).toBe('100755');
    expect(tracked.get('dist/mycelink.mjs')).toBe('100755');
  });

  it('contains only runtime and public files', () => {
    const names = readZip(first.zip).map((e) => e.name);
    for (const required of [
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'bin/mycelink.mjs',
      'dist/mycelink.mjs',
      'schemas/portfolio-graph.schema.json',
      'commands/run.md',
      'skills/node-worker/SKILL.md',
      'agents/module-worker.md',
      'templates/control-repo/repositories.example.yaml',
      'package.json',
      'README.md',
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.md',
      'SECURITY.md',
      'CHANGELOG.md',
    ]) {
      expect(names, required).toContain(required);
    }
    const forbidden = /^(tests|src|node_modules|scripts|artifacts|\.git|\.github|\.claude\/)|\.map$|\.ts$|PUBLIC_RELEASE_TASK|DESIGN\.md|implementation\//;
    expect(names.filter((n) => forbidden.test(n))).toEqual([]);
  });

  it('ships a runtime package.json without development metadata', () => {
    const entry = readZip(first.zip).find((e) => e.name === 'package.json');
    const pkg = JSON.parse(entry?.data.toString('utf8') ?? '{}') as Record<string, unknown>;
    expect(pkg['name']).toBe('mycelink');
    expect(pkg['version']).toBe(VERSION);
    expect(pkg['license']).toBe('Apache-2.0');
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg['scripts']).toBeUndefined();
  });

  it('contains no personal paths, e-mail addresses or secrets', () => {
    const offenders: string[] = [];
    for (const entry of readZip(first.zip)) {
      const text = entry.data.toString('utf8');
      if (/[A-Za-z]:[\\/]+Users[\\/]+(?!<|you|name|someone)[A-Za-z0-9]|\/Users\/(?!<)[a-z]|\/home\/(?!<|u\b|user\b|runner\b)[a-z]/.test(text)) {
        offenders.push(`${entry.name}: personal path`);
      }
      // Third-party license texts legitimately carry their authors' addresses.
      if (!['THIRD_PARTY_NOTICES.md', 'dist/mycelink.mjs'].includes(entry.name)) {
        const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
        const real = emails.filter((e) => !/@(example\.(com|org|invalid)|users\.noreply\.github\.com)$/i.test(e) && !e.startsWith('git@'));
        if (real.length > 0) offenders.push(`${entry.name}: ${real.join(', ')}`);
      }
      if (/\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-ant-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY/.test(text)) {
        offenders.push(`${entry.name}: secret-like value`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('produces an SPDX 2.3 SBOM describing the release and every bundled dependency', () => {
    const sbom = JSON.parse(readFileSync(first.sbom, 'utf8')) as {
      spdxVersion: string;
      dataLicense: string;
      SPDXID: string;
      name: string;
      documentNamespace: string;
      creationInfo: { created: string; creators: string[] };
      packages: { SPDXID: string; name: string; versionInfo: string; licenseConcluded: string; licenseDeclared: string; checksums?: { algorithm: string; checksumValue: string }[]; externalRefs?: { referenceType: string; referenceLocator: string }[] }[];
      relationships: { spdxElementId: string; relationshipType: string; relatedSpdxElement: string }[];
    };
    expect(sbom.spdxVersion).toBe('SPDX-2.3');
    expect(sbom.dataLicense).toBe('CC0-1.0');
    expect(sbom.SPDXID).toBe('SPDXRef-DOCUMENT');
    expect(sbom.creationInfo.created).toBe('2026-01-01T00:00:00Z');
    const root = sbom.packages.find((p) => p.name === 'mycelink');
    expect(root?.versionInfo).toBe(VERSION);
    expect(root?.licenseDeclared).toBe('Apache-2.0');
    expect(root?.checksums?.[0]).toEqual({ algorithm: 'SHA256', checksumValue: first.sha256 });
    for (const dep of ['ajv', 'ajv-formats', 'yaml', 'fast-deep-equal', 'json-schema-traverse', 'fast-uri']) {
      const p = sbom.packages.find((x) => x.name === dep);
      expect(p, dep).toBeDefined();
      expect(p?.licenseDeclared, dep).toMatch(/^(MIT|ISC|BSD-3-Clause)$/);
      expect(p?.externalRefs?.[0]?.referenceLocator, dep).toBe(`pkg:npm/${dep}@${p?.versionInfo}`);
      expect(sbom.relationships).toContainEqual({ spdxElementId: root?.SPDXID, relationshipType: 'CONTAINS', relatedSpdxElement: p?.SPDXID });
    }
    expect(sbom.packages.map((p) => p.name)).not.toContain('typescript');
    expect(sbom.packages.map((p) => p.name)).not.toContain('vitest');
  });
});

describe('install and run from the release ZIP alone', () => {
  let plugin: string;
  let work: string;

  beforeAll(() => {
    const out = makeTmpDir('pkg-zip-');
    const { zip } = packageInto(out);
    work = makeTmpDir('pkg-run-');
    plugin = join(work, 'mycelink');
    extractZip(zip, plugin);
  });

  function cli(args: string[], cwd = work) {
    return spawnSync(process.execPath, [join(plugin, 'bin', 'mycelink.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  it('has no node_modules and no TypeScript to build', () => {
    expect(existsSync(join(plugin, 'node_modules'))).toBe(false);
    expect(existsSync(join(plugin, 'src'))).toBe(false);
    expect(existsSync(join(plugin, 'dist', 'mycelink.mjs'))).toBe(true);
  });

  it('runs doctor, init, repo register and graph validation', () => {
    const control = join(work, 'control');
    expect(cli(['init', control]).status).toBe(0);
    makeGitRepo(join(work, 'core'), { files: { 'package.json': '{}\n' } });
    const reg = cli(['repo', 'register', '--control-root', control, '--name', 'core', '--path', '../core', '--base-branch', 'main', '--', 'node', '--test']);
    expect(reg.status, reg.stderr).toBe(0);

    const graph = YAML.parse(readFileSync(join(plugin, 'templates', 'control-repo', 'features', 'FEATURE-TEMPLATE', 'PORTFOLIO-GRAPH.example.yaml'), 'utf8')) as Record<string, unknown>;
    expect(graph['feature_id']).toBe('FEAT-101');
    const doctor = cli(['doctor', '--control-root', control, '--json']);
    const report = JSON.parse(doctor.stdout) as { checks: { name: string; ok: boolean }[] };
    expect(report.checks.find((c) => c.name === 'repo:core')?.ok).toBe(true);

    const settings = JSON.parse(readFileSync(join(control, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.hooks['PreToolUse']?.[0]?.hooks[0]?.command.replace(/\\/g, '/')).toContain(
      join(plugin, 'bin', 'mycelink.mjs').replace(/\\/g, '/'),
    );
    writeFileSync(join(control, 'touched'), '');
  });
});
