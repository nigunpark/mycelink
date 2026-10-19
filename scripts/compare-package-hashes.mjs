#!/usr/bin/env node
/** Fail closed unless independent Linux, Windows and macOS packages have identical ZIP/SBOM bytes. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const zip = `mycelink-${version}.zip`;
const out = process.argv[2];
if (process.argv.length !== 3 || !out) {
  process.stderr.write('usage: node scripts/compare-package-hashes.mjs <download-directory>\n');
  process.exit(2);
}
const digest = (data) => createHash('sha256').update(data).digest('hex');
try {
  const hashes = ['ubuntu-latest', 'windows-latest', 'macos-latest'].map((os) => {
    const dir = join(resolve(out), `mycelink-package-${os}`);
    const archive = digest(readFileSync(join(dir, zip)));
    const checksum = readFileSync(join(dir, `${zip}.sha256`), 'utf8');
    if (checksum !== `${archive}  ${zip}\n`) throw new Error(`${os}: ZIP checksum file does not match actual bytes`);
    return { os, archive, sbom: digest(readFileSync(join(dir, 'SBOM.spdx.json'))) };
  });
  for (const entry of hashes.slice(1)) {
    if (entry.archive !== hashes[0].archive || entry.sbom !== hashes[0].sbom) {
      throw new Error(`${entry.os}: release artifacts differ from ${hashes[0].os}`);
    }
  }
  process.stdout.write(`cross-platform package SHA256 ${hashes[0].archive}; SBOM SHA256 ${hashes[0].sbom}\n`);
} catch (error) {
  process.stderr.write(`cross-platform package comparison FAILED: ${error.message}\n`);
  process.exitCode = 1;
}
