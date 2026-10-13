#!/usr/bin/env node
/**
 * Frozen sources: re-make a transport bundle from the project's remote,
 * verify the cached bundles, or (re)derive a lock's content fields.
 *
 *   node evals-public-projects/tools/source.mjs prepare --project <id> [--from <https URL | local clone>]
 *        [--online] [--replace] [--cache-root <dir>]
 *   node evals-public-projects/tools/source.mjs verify [--project <id>]... [--cache-root <dir>]
 *   node evals-public-projects/tools/source.mjs relock --project <id> [--from <local clone>] [--cache-root <dir>]
 *
 * prepare fetches exactly the locked commit (complete history, or depth 1
 * for a lock that is shallow at the commit) from the lock's remote — the
 * network is used only with --online — or from a local clone, checks the
 * commit, tree, SHA-256 content digest, history and license blobs against
 * the committed lock, and only then writes <cache>/sources/<bundle file>.
 * The identity is the content: a re-made bundle whose bytes differ from the
 * recorded (advisory) transport hash is reported, never refused for it.
 *
 * relock rewrites projects/<id>/source.lock.json for the commit it already
 * pins (never another one): it derives the content digest, the history
 * digest and the transport record from the cached bundle (or a local
 * clone), and refuses when the tree, the history's commit count or a
 * license blob differs from the committed lock.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { git, revParse } from '../lib/git.mjs';
import { sha256Hex } from '../lib/hash.mjs';
import { listProjects, loadSuite, sourceIdentity, suiteRoot } from '../lib/manifests.mjs';
import { loadSchema, validate } from '../lib/schema.mjs';
import { describeCommit, prepareSourceBundle, sourceTransport, verifySourceBundle } from '../lib/source.mjs';
import { resolveCacheRoot } from '../lib/toolchain.mjs';

const USAGE = 'usage: source.mjs prepare --project <id> [--from <url|clone>] [--online] [--replace] | verify [--project <id>]... | relock --project <id> [--from <clone>]';

function lockFile(id) {
  return join(suiteRoot(), 'projects', id, 'source.lock.json');
}

async function prepare(flags, cacheRoot) {
  const suite = loadSuite();
  const project = suite.projects.find((p) => p.id === flags.project?.[0]);
  if (!project || flags.project.length !== 1) return { ok: false, exit: 2, errors: [`${USAGE} (one known --project)`] };
  if (project.problems.length) return { ok: false, exit: 2, errors: project.problems };
  const from = flags.from ?? project.lock.remote;
  let transport;
  try {
    transport = sourceTransport(from);
  } catch (error) {
    return { ok: false, exit: 2, errors: [error.message] };
  }
  if (transport === 'https' && !flags.online) return { ok: false, exit: 2, errors: [`fetching ${from} uses the network: pass --online (or --from a local clone)`] };
  const target = join(cacheRoot, 'sources', project.lock.bundle.file);
  const r = await prepareSourceBundle({ lock: project.lock, from: transport === 'file' && !from.startsWith('file://') ? resolve(from) : from, target, replace: Boolean(flags.replace) });
  return { command: 'prepare', project: project.id, from, ...r };
}

async function verify(flags, cacheRoot) {
  const suite = loadSuite();
  if (suite.problems.length) return { ok: false, exit: 2, errors: suite.problems };
  const projects = flags.project ? suite.projects.filter((p) => flags.project.includes(p.id)) : suite.projects;
  if (flags.project && projects.length !== flags.project.length) return { ok: false, exit: 2, errors: [`unknown project in ${flags.project.join(', ')}`] };
  const results = [];
  for (const project of projects) {
    const v = await verifySourceBundle({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file) });
    results.push({ project: project.id, ok: v.ok, facts: v.facts, failed: v.checks.filter((c) => !c.ok && c.severity !== 'warning'), warnings: v.checks.filter((c) => !c.ok && c.severity === 'warning') });
  }
  return { ok: results.every((r) => r.ok), command: 'verify', results };
}

async function relock(flags, cacheRoot) {
  const id = flags.project?.[0];
  if (!id || flags.project.length !== 1 || !listProjects(suiteRoot()).includes(id)) return { ok: false, exit: 2, errors: [`${USAGE} (one known --project)`] };
  const file = lockFile(id);
  const old = JSON.parse(readFileSync(file, 'utf8'));
  const bundlePath = join(cacheRoot, 'sources', old.bundle.file);
  const scratch = mkdtempSync(join(tmpdir(), 'bench-relock-'));
  try {
    let repo;
    if (flags.from) {
      repo = resolve(flags.from);
    } else {
      repo = join(scratch, 'repo');
      git(scratch, ['init', '-q', '--bare', repo]);
      git(repo, ['bundle', 'unbundle', bundlePath]);
      if (old.history.kind === 'shallow') writeFileSync(join(repo, 'shallow'), old.history.shallow_boundary.join('\n') + '\n');
    }
    if (revParse(repo, `${old.commit}^{commit}`) !== old.commit) return { ok: false, exit: 1, errors: [`${repo} does not hold the pinned commit ${old.commit}`] };
    const d = describeCommit({ repo, commit: old.commit });
    const problems = [];
    if (d.tree !== old.tree) problems.push(`tree ${d.tree}, locked ${old.tree}`);
    if (d.history.commits !== old.history.commits) problems.push(`${d.history.commits} commit(s), locked ${old.history.commits}`);
    for (const { path, blob } of old.license.files) if (revParse(repo, `${old.commit}:${path}`) !== blob) problems.push(`license ${path} differs`);
    if (problems.length) return { ok: false, exit: 1, errors: problems };
    const bytes = existsSync(bundlePath) ? readFileSync(bundlePath) : null;
    const lock = {
      schema: 'mycelink-bench/source-lock@2',
      project: old.project,
      remote: old.remote,
      commit: old.commit,
      tree: old.tree,
      object_format: old.object_format,
      content: d.content,
      history: { kind: old.history.kind, commits: old.history.commits, shallow_boundary: old.history.shallow_boundary, digest_sha256: d.history.digest_sha256 },
      bundle: {
        file: old.bundle.file,
        version: old.bundle.version,
        refs: old.bundle.refs,
        prerequisites: old.bundle.prerequisites,
        transport: bytes ? { sha256: sha256Hex(bytes), size: statSync(bundlePath).size } : old.bundle.transport,
      },
      license: old.license,
      identity_sha256: null,
      ...(old.notes ? { notes: old.notes } : {}),
    };
    if (!lock.bundle.transport) return { ok: false, exit: 1, errors: [`no bundle at ${bundlePath} to record the transport of`] };
    lock.identity_sha256 = sourceIdentity(lock);
    const schemaProblems = validate(loadSchema('source-lock'), lock);
    if (schemaProblems.length) return { ok: false, exit: 1, errors: schemaProblems };
    writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
    return { ok: true, command: 'relock', project: id, file, identity_sha256: lock.identity_sha256, content: lock.content, history: lock.history };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export async function main(argv) {
  let positionals;
  let flags;
  try {
    ({ positionals, flags } = parseArgs(argv, { valued: ['from', 'cache-root', 'out'], repeated: ['project'], booleans: ['online', 'replace'] }));
  } catch (error) {
    return { ok: false, exit: 2, errors: [`usage: ${error.message}`] };
  }
  const cacheRoot = resolveCacheRoot({ explicit: flags['cache-root'] });
  const [command] = positionals;
  let result;
  if (command === 'prepare') result = await prepare(flags, cacheRoot);
  else if (command === 'verify') result = await verify(flags, cacheRoot);
  else if (command === 'relock') result = await relock(flags, cacheRoot);
  else return { ok: false, exit: 2, errors: [USAGE] };
  if (flags.out) result.out = flags.out;
  return result;
}

runTool(import.meta.url, main);
