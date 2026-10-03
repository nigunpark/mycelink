/**
 * The shipped runtime is one self-contained ESM bundle.
 *
 * A marketplace install from GitHub copies the repository as-is: there is no
 * `npm install` and no TypeScript build. These tests prove the committed
 * runtime needs neither.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

afterAll(() => cleanupTmpRoots());

const ROOT = resolve(process.cwd());
const BUNDLE = join(ROOT, 'dist', 'mycelink.mjs');

describe('runtime bundle', () => {
  it('exists as a single file with no source maps', () => {
    expect(existsSync(BUNDLE)).toBe(true);
    expect(readdirSync(join(ROOT, 'dist')).sort()).toEqual(['mycelink.mjs']);
    expect(readFileSync(BUNDLE, 'utf8')).not.toMatch(/sourceMappingURL/);
  });

  it('imports nothing but Node built-ins', () => {
    // ajv's code generator holds `require("ajv/...")` inside template literals
    // that are only emitted for standalone code, never executed here.
    const text = readFileSync(BUNDLE, 'utf8')
      .replace(/_\)`[^`]*`/g, '')
      .replace(/\.code = '[^']*'/g, '');
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\s[^;'"`]*?\bfrom\s*["']([@\w./:-]+)["']/gm),
      ...text.matchAll(/^\s*import\s*["']([@\w./:-]+)["']/gm),
      ...text.matchAll(/\bimport\s*\(\s*["']([@\w./:-]+)["']\s*\)/g),
      ...text.matchAll(/\brequire\(\s*["']([@\w./:-]+)["']\s*\)/g),
    ].map((m) => m[1] as string);
    const external = specifiers.filter((s) => !s.startsWith('node:') && !builtinModules.includes(s));
    expect(external).toEqual([]);
  });

  it('does not embed absolute paths from the build machine', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    expect(text).not.toContain(ROOT);
    expect(text).not.toContain(ROOT.replace(/\\/g, '/'));
    expect(text).not.toMatch(/[A-Za-z]:\\\\Users\\\\|\/Users\/[a-z]|\/home\/[a-z]/);
  });

  it('runs from a copy that has no node_modules and no TypeScript sources', () => {
    const dir = makeTmpDir('bundle-');
    const copy = join(dir, 'plugin');
    mkdirSync(copy, { recursive: true });
    for (const part of ['bin', 'dist', 'schemas', 'package.json']) {
      cpSync(join(ROOT, part), join(copy, part), { recursive: true });
    }
    const control = join(dir, 'control');
    const init = spawnSync(process.execPath, [join(copy, 'bin', 'mycelink.mjs'), 'init', control, '--json'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(init.status, init.stderr).toBe(0);
    expect(existsSync(join(control, 'mycelink.config.json'))).toBe(true);

    const version = spawnSync(process.execPath, [join(copy, 'bin', 'mycelink.mjs'), '--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  });

  it.skipIf(process.platform === 'win32')('is rebuilt with the executable bit git tracks for it', () => {
    // Windows has no executable bit to compare; Linux and macOS do, and CI's
    // `git diff --exit-code -- dist` fails on a mode flip alone.
    const dir = makeTmpDir('bundle-mode-');
    const outfile = join(dir, 'mycelink.mjs');
    const build = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'build.mjs'), '--outfile', outfile, '--notices', join(dir, 'NOTICES.md')],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(build.status, build.stderr).toBe(0);
    const ls = spawnSync('git', ['ls-files', '-s', '--', 'dist/mycelink.mjs'], { cwd: ROOT, encoding: 'utf8' });
    const trackedExecutable = ls.stdout.startsWith('100755 ');
    expect((statSync(outfile).mode & 0o111) !== 0).toBe(trackedExecutable);
    expect(statSync(outfile).mode & 0o777).toBe(0o755);
  });

  it('the launcher explains a missing bundle instead of crashing', () => {
    const dir = makeTmpDir('bundle-');
    cpSync(join(ROOT, 'bin'), join(dir, 'bin'), { recursive: true });
    const r = spawnSync(process.execPath, [join(dir, 'bin', 'mycelink.mjs'), 'doctor'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/runtime bundle is missing/i);
  });
});

describe('third-party notices', () => {
  it('names every bundled package with its version and license text', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; license?: string; dev?: boolean }>;
    };
    for (const name of ['ajv', 'ajv-formats', 'yaml', 'fast-deep-equal', 'json-schema-traverse', 'fast-uri']) {
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, name).toBeDefined();
      expect(notices, name).toContain(`## ${name}@${entry?.version}`);
    }
    expect(notices).toMatch(/MIT/);
    expect(notices).toMatch(/ISC/);
    expect(notices).not.toMatch(/## (typescript|vitest|vite|esbuild)@/);
  });
});
