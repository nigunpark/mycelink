#!/usr/bin/env node
/**
 * Create the release artifacts, deterministically:
 *
 *   artifacts/mycelink-<version>.zip          runtime + public files only
 *   artifacts/mycelink-<version>.zip.sha256   "<sha256>  <file name>\n"
 *   artifacts/SBOM.spdx.json                  SPDX 2.3, release + bundled deps
 *
 * Reproducibility: entries are sorted, stored uncompressed (no zlib-version
 * drift between Node releases), stamped with a fixed 1980-01-01 time and
 * normalised permissions, and text files are normalised to LF. The SBOM
 * creation time comes from SOURCE_DATE_EPOCH, else the HEAD commit time.
 * Packaging the same commit twice yields identical bytes.
 *
 * The archive is built from an explicit allowlist, so tests, sources,
 * development tooling and anything untracked can never leak into it.
 *
 * Usage: node scripts/package.mjs [--out <dir>]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledPackages } from './lib/notices.mjs';
import { buildZip } from './lib/zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const outDir = outIndex === -1 ? join(root, 'artifacts') : resolve(process.argv[outIndex + 1]);

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const zipName = `mycelink-${version}.zip`;

/** Directories shipped whole, and individual files. Nothing else is included. */
const INCLUDE_DIRS = ['agents', 'commands', 'skills', 'templates', 'schemas', 'docs'];
const INCLUDE_FILES = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'bin/mycelink.mjs',
  'dist/mycelink.mjs',
  'README.md',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
];
const REQUIRED = ['.claude-plugin/plugin.json', 'bin/mycelink.mjs', 'dist/mycelink.mjs', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];
const EXECUTABLE = new Set(['bin/mycelink.mjs', 'dist/mycelink.mjs']);
const TEXT = /\.(md|json|ya?ml|mjs|js|txt)$|(^|\/)(LICENSE|NOTICE)$/;

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(relative(root, full).replace(/\\/g, '/'));
  }
  return out;
}

for (const req of REQUIRED) {
  if (!existsSync(join(root, req))) {
    process.stderr.write(`Missing required release file: ${req}. Run "npm run build" first.\n`);
    process.exit(1);
  }
}

const files = new Set();
for (const dir of INCLUDE_DIRS) if (existsSync(join(root, dir))) walk(join(root, dir), []).forEach((f) => files.add(f));
for (const file of INCLUDE_FILES) if (existsSync(join(root, file))) files.add(file);

const entries = [...files].sort().map((name) => {
  let data = readFileSync(join(root, name));
  if (TEXT.test(name)) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return { name, data, mode: EXECUTABLE.has(name) ? 0o755 : 0o644 };
});

// The shipped package.json carries identity and the launcher only: no
// scripts, no dependency lists (everything runtime is in the bundle).
const runtimePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  bugs: pkg.bugs,
  private: true,
  type: pkg.type,
  engines: pkg.engines,
  bin: pkg.bin,
};
entries.push({ name: 'package.json', data: Buffer.from(JSON.stringify(runtimePkg, null, 2) + '\n', 'utf8'), mode: 0o644 });
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const zip = buildZip(entries);
const sha256 = createHash('sha256').update(zip).digest('hex');

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, zipName);
writeFileSync(zipPath, zip);
writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`, 'utf8');

// ---- SBOM -----------------------------------------------------------------

function creationTime() {
  const fromEnv = process.env['SOURCE_DATE_EPOCH'];
  let seconds = fromEnv && /^\d+$/.test(fromEnv) ? Number(fromEnv) : NaN;
  if (Number.isNaN(seconds)) {
    const r = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' });
    seconds = r.status === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : 315532800;
  }
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const spdxId = (s) => s.replace(/[^A-Za-z0-9.-]/g, '-');
const rootId = 'SPDXRef-Package-mycelink';

const depPackages = bundledPackages(root).map(({ name, version: v }) => {
  const entry = lock.packages?.[`node_modules/${name}`] ?? {};
  const license = entry.license ?? 'NOASSERTION';
  const checksums = [];
  if (typeof entry.integrity === 'string' && entry.integrity.startsWith('sha512-')) {
    checksums.push({ algorithm: 'SHA512', checksumValue: Buffer.from(entry.integrity.slice(7), 'base64').toString('hex') });
  }
  const base = name.includes('/') ? name.split('/')[1] : name;
  return {
    SPDXID: `SPDXRef-Package-npm-${spdxId(name)}-${spdxId(v)}`,
    name,
    versionInfo: v,
    downloadLocation: entry.resolved ?? `https://registry.npmjs.org/${name}/-/${base}-${v}.tgz`,
    filesAnalyzed: false,
    licenseConcluded: license,
    licenseDeclared: license,
    copyrightText: 'NOASSERTION',
    ...(checksums.length > 0 ? { checksums } : {}),
    externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:npm/${name}@${v}` }],
  };
});

const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `mycelink-${version}`,
  documentNamespace: `https://spdx.org/spdxdocs/mycelink-${version}-${sha256}`,
  creationInfo: {
    created: creationTime(),
    creators: ['Organization: Mycelink Contributors', 'Tool: mycelink-scripts-package'],
  },
  packages: [
    {
      SPDXID: rootId,
      name: 'mycelink',
      versionInfo: version,
      packageFileName: zipName,
      supplier: 'Organization: Mycelink Contributors',
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'Apache-2.0',
      licenseDeclared: 'Apache-2.0',
      copyrightText: 'Copyright 2026 Mycelink Contributors',
      checksums: [{ algorithm: 'SHA256', checksumValue: sha256 }],
    },
    ...depPackages,
  ],
  relationships: [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootId },
    ...depPackages.map((p) => ({ spdxElementId: rootId, relationshipType: 'CONTAINS', relatedSpdxElement: p.SPDXID })),
  ],
};

const sbomPath = join(outDir, 'SBOM.spdx.json');
writeFileSync(sbomPath, JSON.stringify(sbom, null, 2) + '\n', 'utf8');

process.stdout.write(JSON.stringify({ zip: zipPath, sha256, sbom: sbomPath, files: entries.length }, null, 2) + '\n');
