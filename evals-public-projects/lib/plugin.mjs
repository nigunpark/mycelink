/**
 * The Mycelink plugin as a pinned, packaged artifact.
 *
 * Agent sessions load, and the verifier executes, the plugin exactly as it
 * ships: the release package `scripts/package.mjs` builds (an allowlist of
 * runtime and public files — no eval suite, tests or sources), unpacked
 * into a sealed directory outside every agent-writable path. The artifact
 * is identified by the package's SHA-256 and by a digest of the unpacked
 * tree; the verifier checks the tree digest before it runs the CLI and
 * again after, and refuses a tree that differs.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../../scripts/lib/zip.mjs';
import { assertSafeTreePath, canonicalSha256, sha256Hex } from './hash.mjs';
import { hardenedGitEnv } from './git.mjs';
import { readRegular } from './fsread.mjs';

/** The checkout the plugin is packaged from. */
export const PLUGIN_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Entries of a STORE-only zip as scripts/lib/zip.mjs writes it: `[{ name, data, mode }]`, CRCs checked. */
export function readZip(buffer) {
  const end = buffer.length - 22;
  if (end < 0 || buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('not a package zip (no end-of-central-directory record)');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const skip = buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const mode = (buffer.readUInt32LE(at + 38) >>> 16) & 0o777;
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (method !== 0) throw new Error(`${name}: compressed entries are not expected in a package`);
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: corrupt local header`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    entries.push({ name, data, mode });
    at += 46 + nameLength + skip;
  }
  return entries;
}

/** The content digest of an unpacked plugin: every regular file's path, SHA-256 and size; anything else is a problem. */
export function artifactDigest(dir) {
  const files = [];
  const problems = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = lstatSync(full);
      const rel = relative(dir, full).split('\\').join('/');
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.nlink === 1) {
        // Read through one descriptor: a file swapped since the look is a problem, never sealed.
        const body = readRegular(full)?.bytes;
        if (body === undefined) {
          problems.push(`${rel} changed while it was read`);
          continue;
        }
        files.push({ path: rel, sha256: sha256Hex(body), size: body.length });
      } else problems.push(`${rel} is not a regular, singly linked file`);
    }
  };
  walk(dir);
  return { tree_sha256: canonicalSha256({ files, problems }), files: files.length, problems };
}

/**
 * Build the release package of `source` into a fresh directory with
 * scripts/package.mjs (deterministic: the same commit gives the same
 * bytes). Returns `{ zip, sha256 }`.
 */
export function buildPluginPackage({ source = PLUGIN_SOURCE, outDir = mkdtempSync(join(tmpdir(), 'bench-plugin-')) } = {}) {
  const r = spawnSync(process.execPath, [join(source, 'scripts', 'package.mjs'), '--out', outDir], { cwd: source, encoding: 'utf8', windowsHide: true, env: hardenedGitEnv({ PATH: process.env.PATH ?? '' }) });
  if (r.status !== 0) throw new Error(`packaging the plugin failed (exit ${r.status}): ${String(r.stderr).trim().slice(0, 400)}`);
  const out = JSON.parse(r.stdout);
  return { zip: out.zip, sha256: out.sha256 };
}

/**
 * Unpack a package into `dir` (which must not exist), after checking its
 * SHA-256 when `sha256` is given, and seal it read-only. Returns the
 * artifact record `{ dir, zip_sha256, tree_sha256, files, version }`.
 */
export function sealPlugin({ zip, sha256 = null, dir }) {
  const bytes = readFileSync(zip);
  const zipSha = sha256Hex(bytes);
  if (sha256 !== null && zipSha !== sha256) throw new Error(`plugin package ${zip} has SHA-256 ${zipSha}, pinned ${sha256}`);
  const entries = readZip(bytes);
  mkdirSync(dir, { recursive: false });
  for (const e of entries) {
    const file = join(dir, ...assertSafeTreePath(e.name));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, e.data, { flag: 'wx' });
    // Read-only files; inside a sandbox the whole artifact is bound read-only, and its digest is the seal.
    chmodSync(file, e.mode & 0o111 ? 0o555 : 0o444);
  }
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  return { dir, zip_sha256: zipSha, ...pick(artifactDigest(dir)), version };
}

const pick = ({ tree_sha256, files }) => ({ tree_sha256, files });

/** `{ ok, problems }`: is `artifact.dir` still exactly the sealed tree? */
export function verifyPluginArtifact(artifact) {
  if (!artifact?.dir || !/^[0-9a-f]{64}$/.test(artifact?.tree_sha256 ?? '')) return { ok: false, problems: ['no pinned Mycelink artifact (directory and tree digest)'] };
  let digest;
  try {
    digest = artifactDigest(artifact.dir);
  } catch (error) {
    return { ok: false, problems: [`cannot read the Mycelink artifact: ${error.message}`] };
  }
  const problems = [...digest.problems];
  if (digest.tree_sha256 !== artifact.tree_sha256) problems.push(`the artifact tree hashes ${digest.tree_sha256.slice(0, 12)}, pinned ${artifact.tree_sha256.slice(0, 12)}`);
  return { ok: problems.length === 0, problems };
}

/** The CLI launcher inside an artifact. */
export const artifactBin = (artifact) => join(artifact.dir, 'bin', 'mycelink.mjs');

let built = null;
/**
 * A sealed artifact of this checkout's plugin, built once per process
 * (for verifications given no pinned artifact; the verdict records its
 * hashes).
 */
export function checkoutPluginArtifact() {
  if (built === null) {
    const pkg = buildPluginPackage();
    built = sealPlugin({ zip: pkg.zip, sha256: pkg.sha256, dir: join(mkdtempSync(join(tmpdir(), 'bench-plugin-sealed-')), 'plugin') });
  }
  return built;
}
