/**
 * Immutable cross-repository candidate manifest.
 *
 * Several independent git repositories cannot be merged into one commit, so a
 * "candidate" is the closest honest equivalent: one exact SHA per repository
 * plus artifact and contract hashes, frozen under a single id. Changing any
 * bound SHA requires a new candidate id — never an edit in place.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { dirtyPaths, isWorktreeClean, resolveRef, runGit } from './git.js';
import { DirtyWorktreeError } from './integrate.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { stableStringify } from '../graph/validate.js';
import { validateAgainstSchema } from '../schema/registry.js';
import type { Problem } from '../model/types.js';
import { assertCandidateId } from '../security/names.js';

export interface CandidateRepoRef {
  name: string;
  path: string;
  branch: string;
}

export interface CandidateManifest {
  schema_version: 1;
  candidate_id: string;
  feature_id: string;
  created_at: string;
  control_commit: string;
  repositories: Record<string, { sha: string; branch: string; clean: boolean }>;
  artifacts?: { name: string; path: string; sha256: string }[];
  contracts: { path: string; sha256: string }[];
  database_migrations?: string[];
  created_from_clean_worktrees: true;
  superseded_by?: string | null;
  manifest_sha256: string;
}

export class CandidateImmutableError extends Error {
  constructor(id: string, file: string) {
    super(
      `Candidate "${id}" already exists at ${file}. Candidates are immutable; allocate a new id instead.`,
    );
    this.name = 'CandidateImmutableError';
  }
}

export class CandidateSchemaError extends Error {
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super('Candidate manifest failed schema validation: ' + problems.map((p) => p.detail).join('; '));
    this.name = 'CandidateSchemaError';
    this.problems = problems;
  }
}

function candidatesDir(featureDir: string): string {
  return join(featureDir, 'candidates');
}

export function candidateFile(featureDir: string, id: string): string {
  assertCandidateId(id);
  return join(candidatesDir(featureDir), `${id}.yaml`);
}

export function listCandidates(featureDir: string): string[] {
  const dir = candidatesDir(featureDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

/** Next free `FEAT-x-Cnnn` id for this feature. */
export function nextCandidateId(featureDir: string, featureId: string): string {
  const prefix = `${featureId}-C`;
  let max = 0;
  for (const id of listCandidates(featureDir)) {
    if (!id.startsWith(prefix)) continue;
    const n = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Dirty paths in `repo`, excluding anything under `exemptDir`.
 *
 * Used so controller-managed feature state does not make the control
 * repository look dirty to its own candidate creation.
 */
export function dirtyPathsOutside(repo: string, exemptDir: string): string[] {
  const root = resolve(repo);
  const exempt = resolve(exemptDir);
  const rel = relative(root, exempt).replace(/\\/g, '/');
  const isUnderRepo = rel !== '' && !rel.startsWith('..');
  return dirtyPaths(root).filter((p) => {
    if (!isUnderRepo) return true;
    const norm = p.replace(/\\/g, '/');
    return norm !== rel && !norm.startsWith(rel + '/');
  });
}

/** Hash of the manifest content excluding the hash field itself. */
export function computeManifestHash(manifest: Omit<CandidateManifest, 'manifest_sha256'>): string {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex');
}

export interface CreateCandidateArgs {
  controlRepo: string;
  featureDir: string;
  featureId: string;
  repositories: CandidateRepoRef[];
  contracts: string[];
  artifacts?: { name: string; path: string }[];
  databaseMigrations?: string[];
  candidateId?: string;
  now?: string;
}

/**
 * Freeze the current state of every repository into a new candidate.
 *
 * Refuses when any worktree is dirty, a branch is missing, or a declared
 * contract file is absent: a candidate that does not correspond to a real,
 * reproducible checkout is worse than none.
 */
export function createCandidate(args: CreateCandidateArgs): CandidateManifest {
  const control = resolve(args.controlRepo);

  // Immutability first: a duplicate id must be reported as such, not masked by
  // the dirt that the previous candidate's own file created.
  const presetId = args.candidateId;
  if (presetId !== undefined && existsSync(candidateFile(args.featureDir, presetId))) {
    throw new CandidateImmutableError(presetId, candidateFile(args.featureDir, presetId));
  }

  // The control repo must be clean apart from this feature's own generated
  // state (STATE.json, events, leases, evidence, previously cut candidates).
  // Those are controller outputs written by this very workflow; product and
  // contract files are what must be frozen.
  const controlDirt = dirtyPathsOutside(control, args.featureDir);
  if (controlDirt.length > 0) {
    throw new DirtyWorktreeError(control, controlDirt);
  }

  const repositories: CandidateManifest['repositories'] = {};
  for (const repo of args.repositories) {
    const path = resolve(repo.path);
    if (!isWorktreeClean(path)) {
      throw new DirtyWorktreeError(path, dirtyPaths(path));
    }
    const branchCheck = runGit(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${repo.branch}`], {
      allowFail: true,
    });
    if (branchCheck.exitCode !== 0) {
      throw new Error(`Repository "${repo.name}" has no branch "${repo.branch}".`);
    }
    repositories[repo.name] = {
      sha: resolveRef(path, repo.branch),
      branch: repo.branch,
      clean: true,
    };
  }

  const contracts = args.contracts.map((rel) => {
    const full = join(control, rel);
    if (!existsSync(full)) {
      throw new Error(`Contract "${rel}" does not exist in the control repository.`);
    }
    return { path: rel.replace(/\\/g, '/'), sha256: sha256File(full) };
  });

  const artifacts = (args.artifacts ?? []).map((a) => {
    if (!existsSync(a.path)) {
      throw new Error(`Artifact "${a.name}" is missing at ${a.path}.`);
    }
    return { name: a.name, path: a.path.replace(/\\/g, '/'), sha256: sha256File(a.path) };
  });

  const id = args.candidateId ?? nextCandidateId(args.featureDir, args.featureId);
  const file = candidateFile(args.featureDir, id);
  if (existsSync(file)) throw new CandidateImmutableError(id, file);

  const body: Omit<CandidateManifest, 'manifest_sha256'> = {
    schema_version: 1,
    candidate_id: id,
    feature_id: args.featureId,
    created_at: args.now ?? new Date().toISOString(),
    control_commit: resolveRef(control, 'HEAD'),
    repositories,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    contracts,
    ...(args.databaseMigrations ? { database_migrations: args.databaseMigrations } : {}),
    created_from_clean_worktrees: true,
    superseded_by: null,
  };

  const manifest: CandidateManifest = { ...body, manifest_sha256: computeManifestHash(body) };

  const problems = validateAgainstSchema('candidate', manifest);
  if (problems.length > 0) throw new CandidateSchemaError(problems);

  mkdirSync(candidatesDir(args.featureDir), { recursive: true });
  writeTextAtomic(file, YAML.stringify(manifest, { lineWidth: 0 }));
  return manifest;
}

export function loadCandidate(featureDir: string, id: string): CandidateManifest {
  const file = candidateFile(featureDir, id);
  if (!existsSync(file)) throw new Error(`Candidate "${id}" not found at ${file}.`);
  const manifest = YAML.parse(readFileSync(file, 'utf8')) as CandidateManifest;
  const problems = validateAgainstSchema('candidate', manifest);
  if (problems.length > 0) throw new CandidateSchemaError(problems);
  // A manifest is only valid where it was written: copying it under another
  // id, or into another feature, must not let it vouch for that one.
  if (manifest.candidate_id !== id) {
    throw new Error(
      `CANDIDATE_ID_MISMATCH: ${file} records candidate "${manifest.candidate_id}", not "${id}".`,
    );
  }
  const featureId = basename(resolve(featureDir));
  if (manifest.feature_id !== featureId || !id.startsWith(`${featureId}-C`)) {
    throw new Error(
      `CANDIDATE_FEATURE_MISMATCH: ${file} belongs to feature "${manifest.feature_id}", not "${featureId}".`,
    );
  }
  return manifest;
}

export interface VerifyCandidateContext {
  controlRepo: string;
  repositories: CandidateRepoRef[];
}

export interface VerifyCandidateResult {
  ok: boolean;
  problems: Problem[];
}

/**
 * Check that the world still matches the frozen candidate.
 *
 * Any drift — a repository that moved on, an edited contract, or a tampered
 * manifest — invalidates the candidate. The fix is a new candidate, never an
 * amended one.
 */
export function verifyCandidate(
  manifest: CandidateManifest,
  context: VerifyCandidateContext,
): VerifyCandidateResult {
  const problems: Problem[] = [];

  const { manifest_sha256, ...body } = manifest;
  const recomputed = computeManifestHash(body as Omit<CandidateManifest, 'manifest_sha256'>);
  if (recomputed !== manifest_sha256) {
    problems.push({
      code: 'MANIFEST_HASH_MISMATCH',
      path: '/manifest_sha256',
      detail: `Manifest content hash is ${recomputed} but the manifest records ${manifest_sha256}; it was edited after creation.`,
    });
  }

  const control = resolve(context.controlRepo);
  const controlHead = resolveRef(control, 'HEAD');
  if (controlHead !== manifest.control_commit) {
    problems.push({
      code: 'CONTROL_SHA_DRIFT',
      path: '/control_commit',
      detail: `Control repository is at ${controlHead}, candidate bound ${manifest.control_commit}.`,
    });
  }

  const byName = new Map(context.repositories.map((r) => [r.name, r]));
  for (const [name, bound] of Object.entries(manifest.repositories)) {
    const ref = byName.get(name);
    if (!ref) {
      problems.push({
        code: 'REPOSITORY_MISSING',
        path: `/repositories/${name}`,
        detail: `Candidate binds repository "${name}" which was not supplied for verification.`,
      });
      continue;
    }
    const path = resolve(ref.path);
    const actual = runGit(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${bound.branch}`], {
      allowFail: true,
    });
    if (actual.exitCode !== 0) {
      problems.push({
        code: 'REPOSITORY_BRANCH_MISSING',
        path: `/repositories/${name}/branch`,
        detail: `Repository "${name}" no longer has branch "${bound.branch}".`,
      });
      continue;
    }
    const sha = actual.stdout.trim();
    if (sha !== bound.sha) {
      problems.push({
        code: 'REPOSITORY_SHA_DRIFT',
        path: `/repositories/${name}/sha`,
        detail: `Repository "${name}" branch "${bound.branch}" is at ${sha}, candidate bound ${bound.sha}. Create a new candidate.`,
      });
    }
    if (!isWorktreeClean(path)) {
      problems.push({
        code: 'REPOSITORY_DIRTY',
        path: `/repositories/${name}`,
        detail: `Repository "${name}" worktree is dirty: ${dirtyPaths(path).slice(0, 5).join(', ')}.`,
      });
    }
  }

  for (const contract of manifest.contracts) {
    const full = join(control, contract.path);
    if (!existsSync(full)) {
      problems.push({
        code: 'CONTRACT_MISSING',
        path: `/contracts`,
        detail: `Contract "${contract.path}" no longer exists in the control repository.`,
      });
      continue;
    }
    const sha = sha256File(full);
    if (sha !== contract.sha256) {
      problems.push({
        code: 'CONTRACT_HASH_DRIFT',
        path: `/contracts`,
        detail: `Contract "${contract.path}" hashes to ${sha}, candidate bound ${contract.sha256}.`,
      });
    }
  }

  for (const artifact of manifest.artifacts ?? []) {
    if (!existsSync(artifact.path)) {
      problems.push({
        code: 'ARTIFACT_MISSING',
        path: '/artifacts',
        detail: `Artifact "${artifact.name}" is missing at ${artifact.path}.`,
      });
      continue;
    }
    if (sha256File(artifact.path) !== artifact.sha256) {
      problems.push({
        code: 'ARTIFACT_HASH_DRIFT',
        path: '/artifacts',
        detail: `Artifact "${artifact.name}" hash changed since the candidate was created.`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}
