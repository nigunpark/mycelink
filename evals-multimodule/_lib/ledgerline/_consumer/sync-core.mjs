#!/usr/bin/env node
/**
 * Vendor a ledger-core checkout into this repository.
 *
 *   node scripts/sync-core.mjs <path-to-ledger-core-checkout>
 *
 * Copies <core>/src/ to vendor/ledger-core/ and rewrites
 * vendor/ledger-core.lock.json. Services import core only from vendor/, so
 * this repository builds and tests on its own; the lock pins exactly which
 * core it was built against.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** sha256 over "path\0sha256(content)\n" lines; CRLF is normalised to LF. */
export function treeSha256(dir) {
  const h = createHash('sha256');
  for (const rel of listFiles(dir)) {
    const text = readFileSync(join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${rel}\0${createHash('sha256').update(text).digest('hex')}\n`);
  }
  return h.digest('hex');
}

function main() {
  const core = process.argv[2];
  if (!core) {
    console.error('usage: node scripts/sync-core.mjs <path-to-ledger-core>');
    process.exit(2);
  }
  const src = resolve(core, 'src');
  if (!existsSync(join(src, 'index.mjs'))) {
    console.error(`not a ledger-core checkout: ${src}/index.mjs is missing`);
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync(resolve(core, 'package.json'), 'utf8'));
  const target = join(repoRoot, 'vendor', 'ledger-core');
  rmSync(target, { recursive: true, force: true });
  cpSync(src, target, { recursive: true });
  const lock = { package: pkg.name, version: pkg.version, tree_sha256: treeSha256(target) };
  writeFileSync(join(repoRoot, 'vendor', 'ledger-core.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  console.log(JSON.stringify(lock));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
