/**
 * The plugin under test as a pinned, packaged artifact: the release
 * package (no eval suite, tests or sources), unpacked into a sealed
 * directory whose content digest the verifier checks before and after it
 * runs the CLI.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { artifactDigest, buildPluginPackage, readZip, sealPlugin, verifyPluginArtifact } from '../../evals-public-projects/lib/plugin.mjs';

afterAll(() => cleanupTmpRoots());

const pkg = buildPluginPackage({ outDir: makeTmpDir('bench-plugin-pkg-') });
const seal = () => sealPlugin({ zip: pkg.zip, sha256: pkg.sha256, dir: join(makeTmpDir('bench-plugin-'), 'plugin') });

describe('the packaged plugin artifact', () => {
  it('holds the plugin as it ships, and nothing of the eval suite, tests or sources', () => {
    const names = readZip(readFileSync(pkg.zip)).map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(['.claude-plugin/plugin.json', 'bin/mycelink.mjs', 'dist/mycelink.mjs', 'package.json']));
    expect(names.filter((n: string) => /^(evals-|tests\/|src\/|scripts\/|node_modules\/)/.test(n) || n.includes('evals-public-projects'))).toEqual([]);
    const a = seal();
    expect(a).toMatchObject({ zip_sha256: pkg.sha256, tree_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), files: names.length });
    expect(verifyPluginArtifact(a)).toEqual({ ok: true, problems: [] });
    // Deterministic: the same checkout seals to the same tree.
    expect(seal().tree_sha256).toBe(a.tree_sha256);
  });

  it('refuses a package that is not the pinned one', () => {
    expect(() => sealPlugin({ zip: pkg.zip, sha256: 'f'.repeat(64), dir: join(makeTmpDir('bench-plugin-'), 'plugin') })).toThrow(/pinned/);
  });

  it('detects a changed, added or replaced file in the sealed tree', () => {
    const changed = seal();
    const bin = join(changed.dir, 'bin', 'mycelink.mjs');
    chmodSync(bin, 0o755);
    writeFileSync(bin, `${readFileSync(bin, 'utf8')}\n// tampered\n`);
    expect(verifyPluginArtifact(changed).ok).toBe(false);

    const added = seal();
    writeFileSync(join(added.dir, 'bin', 'extra.mjs'), 'export {};\n');
    expect(verifyPluginArtifact(added).ok).toBe(false);

    const linked = seal();
    const target = join(linked.dir, 'bin', 'mycelink.mjs');
    chmodSync(target, 0o755);
    unlinkSync(target);
    let made = true;
    try {
      symlinkSync(join(linked.dir, 'dist', 'mycelink.mjs'), target);
    } catch {
      made = false; // no symlink privilege on this host
    }
    if (made) {
      expect(artifactDigest(linked.dir).problems).toEqual(['bin/mycelink.mjs is not a regular, singly linked file']);
      expect(verifyPluginArtifact(linked).ok).toBe(false);
    }
    expect(verifyPluginArtifact({ dir: changed.dir, tree_sha256: 'nope' }).ok).toBe(false);
  });
});
