/**
 * Loading and semantic validation of the committed benchmark manifests.
 *
 * Schema validation proves each file is well formed; the rules here prove
 * the suite is a benchmark: every public project has exactly one PRD per
 * archetype, every PRD genuinely spans at least two modules that its
 * project's adapter defines, its requirement names them, and every frozen
 * source identity recomputes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSha256 } from './hash.mjs';
import { validateFile } from './schema.mjs';

export const ARCHETYPES = ['additive-vertical-slice', 'backward-compatible-behavioral-change', 'failure-concurrency-recovery'];

export function suiteRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The identity a source lock must carry: the remote and the content —
 * commit, tree, the SHA-256 content digest, the history and the licenses —
 * never the transport bundle's bytes (lib/source.mjs).
 */
export function sourceIdentity(lock) {
  return canonicalSha256({
    remote: lock.remote,
    commit: lock.commit,
    tree: lock.tree,
    object_format: lock.object_format,
    content: lock.content,
    history: lock.history,
    license: lock.license,
  });
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Load one project directory (adapter, source lock, PRDs). Problems are collected, never thrown. */
export function loadProject(root, id) {
  const dir = join(root, 'projects', id);
  const schemas = join(root, 'schemas');
  const problems = [];
  const adapterFile = validateFile('project-adapter', join(dir, 'adapter.json'), schemas);
  problems.push(...adapterFile.problems);
  const adapter = adapterFile.doc;
  if (adapter && adapter.id !== id) problems.push(`${id}: adapter id ${adapter.id} does not match its directory`);
  const lockFile = validateFile('source-lock', join(dir, adapter?.source_lock ?? 'source.lock.json'), schemas);
  problems.push(...lockFile.problems);
  const lock = lockFile.doc;
  if (lock && lockFile.problems.length === 0) {
    if (lock.project !== id) problems.push(`${id}: source lock is for ${lock.project}`);
    if (sourceIdentity(lock) !== lock.identity_sha256) problems.push(`${id}: identity_sha256 does not match remote/commit/tree/content/history/license`);
    if (!lock.bundle.refs.some((r) => r.sha === lock.commit)) problems.push(`${id}: no bundle ref points at the locked commit`);
    if (lock.history.kind === 'shallow' && lock.history.shallow_boundary.length === 0) problems.push(`${id}: a shallow history needs its boundary commits`);
    if (lock.history.kind === 'complete' && lock.history.shallow_boundary.length > 0) problems.push(`${id}: a complete history has no shallow boundary`);
  }

  const moduleIds = new Set((adapter?.modules ?? []).map((m) => m.id));
  const modulePath = new Map((adapter?.modules ?? []).map((m) => [m.id, m.path]));
  if (adapter) {
    if (moduleIds.size !== adapter.modules.length) problems.push(`${id}: duplicate module ids`);
    const paths = adapter.modules.map((m) => m.path);
    for (const a of paths) {
      for (const b of paths) if (a !== b && (b.startsWith(`${a}/`) || a === b)) problems.push(`${id}: module paths ${a} and ${b} overlap`);
    }
  }

  const prds = [];
  const prdRoot = join(dir, 'prds');
  for (const prdId of isDir(prdRoot) ? readdirSync(prdRoot).sort() : []) {
    const prdDir = join(prdRoot, prdId);
    if (!isDir(prdDir)) continue;
    const caseFile = validateFile('prd-case', join(prdDir, 'case.json'), schemas);
    problems.push(...caseFile.problems);
    const manifest = caseFile.doc;
    if (!manifest || caseFile.problems.length > 0) continue;
    const tag = manifest.id;
    if (manifest.id !== prdId) problems.push(`${tag}: id does not match its directory ${prdId}`);
    if (manifest.project !== id) problems.push(`${tag}: belongs to ${manifest.project}, filed under ${id}`);
    const { required, allowed } = manifest.modules;
    if (required.length < 2) problems.push(`${tag}: a PRD must require at least two modules`);
    for (const m of new Set([...required, ...allowed])) if (!moduleIds.has(m)) problems.push(`${tag}: unknown module ${m}`);
    for (const m of required) if (!allowed.includes(m)) problems.push(`${tag}: required module ${m} is not allowed`);
    // New tests are required in every required module that can have them (scope.mjs testedModules).
    if (adapter && required.every((m) => adapter.modules.find((x) => x.id === m)?.runtime_tests === false)) {
      problems.push(`${tag}: every required module is declarations only; a PRD needs one with runtime tests`);
    }
    for (const ac of manifest.acceptance_criteria) {
      for (const m of ac.modules) if (!allowed.includes(m)) problems.push(`${tag}: ${ac.id} is owned by ${m}, which is not an allowed module`);
    }
    const owned = new Set(manifest.acceptance_criteria.flatMap((ac) => ac.modules));
    for (const m of required) if (!owned.has(m)) problems.push(`${tag}: no acceptance criterion is owned by required module ${m}`);
    const acIds = manifest.acceptance_criteria.map((ac) => ac.id);
    if (new Set(acIds).size !== acIds.length) problems.push(`${tag}: duplicate acceptance criterion ids`);
    const requirementPath = join(prdDir, manifest.requirement);
    if (!existsSync(requirementPath)) {
      problems.push(`${tag}: requirement.md is missing`);
    } else {
      const text = readFileSync(requirementPath, 'utf8');
      if (!text.startsWith(`# ${manifest.id} — `)) problems.push(`${tag}: requirement.md must start with "# ${manifest.id} — <title>"`);
      for (const m of required) {
        if (modulePath.has(m) && !text.includes(modulePath.get(m))) problems.push(`${tag}: requirement.md never names module ${m} (${modulePath.get(m)})`);
      }
      for (const ac of acIds) if (!text.includes(`**${ac} `)) problems.push(`${tag}: requirement.md does not define ${ac}`);
    }
    prds.push({ dir: prdDir, manifest, requirementPath });
  }
  const archetypes = prds.map((p) => p.manifest.archetype).sort();
  if (JSON.stringify(archetypes) !== JSON.stringify([...ARCHETYPES].sort())) {
    problems.push(`${id}: archetypes ${JSON.stringify(archetypes)} must be exactly one of each of ${ARCHETYPES.join(', ')}`);
  }
  return { id, dir, adapter, lock, prds, problems };
}

export function listProjects(root) {
  const dir = join(root, 'projects');
  return isDir(dir) ? readdirSync(dir).filter((d) => isDir(join(dir, d))).sort() : [];
}

/** Load the whole suite. `problems` is empty only when every rule holds. */
export function loadSuite(root = suiteRoot()) {
  const projects = listProjects(root).map((id) => loadProject(root, id));
  const problems = projects.flatMap((p) => p.problems);
  if (projects.length === 0) problems.push('no projects');
  const names = new Map();
  for (const p of projects) {
    for (const prd of p.prds) {
      const name = prd.manifest.case;
      if (names.has(name)) problems.push(`duplicate case name ${name} (${names.get(name)} and ${prd.manifest.id})`);
      names.set(name, prd.manifest.id);
    }
  }
  return { root, projects, problems };
}

/** Find one PRD by id or case name. */
export function findPrd(suite, key) {
  for (const project of suite.projects) {
    for (const prd of project.prds) if (prd.manifest.id === key || prd.manifest.case === key) return { project, prd };
  }
  return null;
}
