/**
 * Delivery: move every repository's base branch to exactly the candidate.
 *
 * All checks run before anything moves: the feature must verify, the
 * candidate must still match every repository, and each base branch must be
 * an ancestor of the candidate's commit (a fast-forward) and, where it is
 * checked out, clean. Only then is a delivery manifest written and each base
 * branch fast-forwarded: a checked-out branch with `merge --ff-only` in its
 * own worktree, any other with a compare-and-swap `update-ref`. If a later
 * repository fails, the ones this run moved are put back. Nothing is ever
 * pushed, and nothing is ever forced.
 *
 * Final acceptance then runs each repository's test command on a clean
 * checkout of the delivered commit and is recorded in the manifest. A
 * repeated delivery of an accepted candidate is answered from the manifest;
 * an interrupted one resumes, treating bases already at the candidate as done.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featurePaths } from '../workspace/paths.js';
import { loadWorkspace, repositoryPath } from '../workspace/workspace.js';
import { loadState, mutateState } from '../state/feature-state.js';
import { loadCandidate, verifyCandidate } from '../git/candidate.js';
import { isAncestor, isWorktreeClean, listWorktrees, resolveRef, runGit } from '../git/git.js';
import { runVerification } from '../evidence/runner.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { appendEvent } from '../state/event-log.js';
import { assertCandidateId } from '../security/names.js';
import { featureVerifyProblems } from './feature-verify.js';
import { withLock } from '../state/process-lock.js';

export type DeliveryStatus = 'DELIVERING' | 'DELIVERED' | 'ROLLED_BACK' | 'ACCEPTED' | 'ACCEPTANCE_FAILED';
type Method = 'fast-forward-checkout' | 'update-ref' | 'already-delivered';

export interface DeliveredRepository {
  base_branch: string;
  before: string;
  target: string;
  after: string | null;
  method: Method;
  checkout: string | null;
}

export interface AcceptanceRecord {
  repository: string;
  sha: string;
  command: string[];
  exit_code: number;
  failure_fingerprint: string | null;
  output_path: string;
  output_sha256: string;
}

export interface DeliveryManifest {
  schema: 'mycelink-delivery/1';
  feature_id: string;
  candidate_id: string;
  status: DeliveryStatus;
  started_at: string;
  delivered_at: string | null;
  accepted_at: string | null;
  repositories: Record<string, DeliveredRepository>;
  acceptance: AcceptanceRecord[];
  error: string | null;
}

export type DeliveryResult = DeliveryManifest & { ok: boolean; idempotent: boolean };

export class DeliveryRefusedError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`DELIVERY_REFUSED: nothing was moved. ${problems.join('; ')}`);
    this.name = 'DeliveryRefusedError';
    this.problems = problems;
  }
}

export class DeliveryFailedError extends Error {
  constructor(detail: string) {
    super(`DELIVERY_FAILED: ${detail}`);
    this.name = 'DeliveryFailedError';
  }
}

function manifestFile(featureDir: string, candidateId: string): string {
  assertCandidateId(candidateId);
  return join(featureDir, 'deliveries', `${candidateId}.json`);
}

function readManifest(file: string): DeliveryManifest | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as DeliveryManifest;
}

function save(file: string, manifest: DeliveryManifest): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeTextAtomic(file, JSON.stringify(manifest, null, 2) + '\n');
}

export function deliverFeature(
  controlRoot: string,
  featureId: string,
  options: { candidateId?: string } = {},
): DeliveryResult {
  // One delivery per feature at a time: a concurrent run's rollback must
  // never undo another run's fast-forwards.
  const lockDir = join(featurePaths(controlRoot, featureId).featureDir, 'deliveries');
  mkdirSync(lockDir, { recursive: true });
  return withLock(join(lockDir, 'deliver.lock'), () => deliverLocked(controlRoot, featureId, options), {
    timeoutMs: 2_000,
    pollMs: 50,
    purpose: 'feature delivery',
  });
}

function deliverLocked(controlRoot: string, featureId: string, options: { candidateId?: string }): DeliveryResult {
  const workspace = loadWorkspace(controlRoot);
  const paths = featurePaths(controlRoot, featureId);
  const state = loadState(paths.featureDir)?.data;
  if (!state) throw new DeliveryRefusedError([`NO_STATE: ${featureId} has no STATE.json`]);
  const current = state.current_candidate;
  const candidateId = options.candidateId ?? current;
  if (!candidateId) throw new DeliveryRefusedError(['NO_CANDIDATE: no current candidate recorded']);
  if (candidateId !== current) {
    throw new DeliveryRefusedError([`CANDIDATE_NOT_CURRENT: ${candidateId} is not the current candidate ${current ?? '(none)'}`]);
  }
  const file = manifestFile(paths.featureDir, candidateId);
  const candidate = loadCandidate(paths.featureDir, candidateId);
  const names = Object.keys(candidate.repositories).sort();

  const existing = readManifest(file);
  if (
    existing?.status === 'ACCEPTED' &&
    names.every((n) => {
      const decl = workspace.repositories.repositories.find((r) => r.name === n);
      return decl !== undefined && resolveRef(repositoryPath(workspace, n), decl.base_branch) === candidate.repositories[n]?.sha;
    })
  ) {
    return { ...existing, ok: true, idempotent: true };
  }

  // ---- every check before anything moves ---------------------------------
  const problems: string[] = [];
  if (state.feature_state === 'CANCELLED') problems.push('FEATURE_CANCELLED');
  const unverified = featureVerifyProblems(controlRoot, featureId);
  if (unverified.length > 0) problems.push(`FEATURE_NOT_VERIFIED: ${unverified.join('; ')}`);

  const refs = names.map((name) => ({
    name,
    path: repositoryPath(workspace, name),
    branch: candidate.repositories[name]?.branch as string,
  }));
  const drift = verifyCandidate(candidate, { controlRepo: controlRoot, repositories: refs });
  if (!drift.ok) problems.push(`CANDIDATE_DRIFT: ${drift.problems.map((p) => `${p.code} ${p.detail}`).join('; ')}`);

  const plan: Record<string, DeliveredRepository> = {};
  for (const name of names) {
    const decl = workspace.repositories.repositories.find((r) => r.name === name);
    if (!decl) {
      problems.push(`UNKNOWN_REPOSITORY: ${name} is not in repositories.yaml`);
      continue;
    }
    const repo = repositoryPath(workspace, name);
    const base = decl.base_branch;
    const target = candidate.repositories[name]?.sha as string;
    const has = runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], { allowFail: true });
    if (has.exitCode !== 0) {
      problems.push(`BASE_MISSING: ${name} has no branch ${base}`);
      continue;
    }
    const before = has.stdout.trim();
    const checkout = listWorktrees(repo).find((w) => w.branch === base && !w.prunable)?.path ?? null;
    let method: Method;
    if (before === target) {
      method = 'already-delivered';
    } else if (!isAncestor(repo, before, target)) {
      problems.push(`NON_FAST_FORWARD: ${name} ${base} is at ${before.slice(0, 12)}, which is not an ancestor of the candidate ${target.slice(0, 12)}`);
      continue;
    } else {
      method = checkout ? 'fast-forward-checkout' : 'update-ref';
    }
    if (checkout && method !== 'already-delivered' && !isWorktreeClean(checkout)) {
      problems.push(`BASE_CHECKOUT_DIRTY: ${name} has uncommitted changes in ${checkout}`);
      continue;
    }
    plan[name] = { base_branch: base, before, target, after: null, method, checkout };
  }
  if (problems.length > 0) {
    appendEvent(paths.events, {
      idempotency_key: `delivery.refused:${candidateId}:${Date.now()}`,
      type: 'delivery.refused',
      actor: 'mycelink',
      feature_id: featureId,
      data: { candidate_id: candidateId, problems: problems.map((p) => p.slice(0, 300)).slice(0, 20) },
    });
    throw new DeliveryRefusedError(problems);
  }

  // ---- fast-forward, journaled, with rollback ------------------------------
  const manifest: DeliveryManifest = {
    schema: 'mycelink-delivery/1',
    feature_id: featureId,
    candidate_id: candidateId,
    status: 'DELIVERING',
    started_at: new Date().toISOString(),
    delivered_at: null,
    accepted_at: null,
    repositories: plan,
    acceptance: [],
    error: null,
  };
  save(file, manifest);

  const moved: string[] = [];
  try {
    for (const name of names) {
      const step = plan[name] as DeliveredRepository;
      const repo = repositoryPath(workspace, name);
      if (step.method === 'fast-forward-checkout') {
        // merge has no compare-and-swap: re-check the base right before it,
        // so a base that moved since the precheck is never overwritten.
        const now = resolveRef(repo, step.base_branch);
        if (now !== step.before) throw new Error(`${name} ${step.base_branch} moved to ${now} after the precheck`);
        runGit(step.checkout as string, ['merge', '--ff-only', '--quiet', step.target]);
        moved.push(name);
      } else if (step.method === 'update-ref') {
        // Compare-and-swap: refuses if the branch moved since it was checked.
        runGit(repo, ['update-ref', `refs/heads/${step.base_branch}`, step.target, step.before]);
        moved.push(name);
      }
      step.after = resolveRef(repo, step.base_branch);
      if (step.after !== step.target) {
        throw new Error(`${name} ${step.base_branch} ended at ${step.after}, not the candidate ${step.target}`);
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const rollback: string[] = [];
    for (const name of moved.reverse()) {
      const step = plan[name] as DeliveredRepository;
      const repo = repositoryPath(workspace, name);
      const r =
        step.method === 'fast-forward-checkout'
          ? runGit(step.checkout as string, ['reset', '--keep', step.before], { allowFail: true })
          : runGit(repo, ['update-ref', `refs/heads/${step.base_branch}`, step.before, step.target], { allowFail: true });
      step.after = resolveRef(repo, step.base_branch);
      rollback.push(r.exitCode === 0 && step.after === step.before ? `${name} restored` : `${name} NOT restored (at ${step.after})`);
    }
    manifest.status = 'ROLLED_BACK';
    manifest.error = `${detail.slice(0, 1000)} | rollback: ${rollback.join(', ') || 'nothing to undo'}`;
    save(file, manifest);
    throw new DeliveryFailedError(manifest.error);
  }
  manifest.status = 'DELIVERED';
  manifest.delivered_at = new Date().toISOString();
  save(file, manifest);
  appendEvent(paths.events, {
    idempotency_key: `delivery.delivered:${candidateId}`,
    type: 'delivery.delivered',
    actor: 'mycelink',
    feature_id: featureId,
    data: { candidate_id: candidateId, repositories: Object.fromEntries(names.map((n) => [n, plan[n]?.after ?? null])) },
  });

  // ---- final acceptance on exactly what was delivered -----------------------
  const evidenceDir = join(paths.evidenceDir, 'delivery', candidateId);
  manifest.acceptance = names.map((name) => acceptance(controlRoot, workspace, name, plan[name] as DeliveredRepository, candidateId, evidenceDir));
  const passed = manifest.acceptance.every((a) => a.failure_fingerprint === null);
  manifest.status = passed ? 'ACCEPTED' : 'ACCEPTANCE_FAILED';
  manifest.accepted_at = passed ? new Date().toISOString() : null;
  save(file, manifest);
  if (passed) {
    mutateState(paths.featureDir, (s) => {
      s.feature_state = 'COMPLETED';
      return s;
    });
  }
  return { ...manifest, ok: passed, idempotent: false };
}

function acceptance(
  controlRoot: string,
  workspace: ReturnType<typeof loadWorkspace>,
  name: string,
  step: DeliveredRepository,
  candidateId: string,
  evidenceDir: string,
): AcceptanceRecord {
  const decl = workspace.repositories.repositories.find((r) => r.name === name);
  const repo = repositoryPath(workspace, name);
  const command = decl?.commands.test ?? [];
  const dir = join(workspace.paths.workDir, 'acceptance', `${name}__${candidateId}`);
  runGit(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
  runGit(repo, ['worktree', 'prune'], { allowFail: true });
  mkdirSync(join(workspace.paths.workDir, 'acceptance'), { recursive: true });
  // A clean checkout of exactly the delivered base branch.
  runGit(repo, ['worktree', 'add', '--detach', dir, step.base_branch]);
  try {
    const sha = resolveRef(dir, 'HEAD');
    if (sha !== step.target) throw new Error(`${name} acceptance checkout is at ${sha}, not the candidate ${step.target}`);
    const record = runVerification({
      kind: 'regression',
      nodeId: `delivery.${candidateId}`,
      repository: name,
      command,
      cwd: dir,
      evidenceDir,
      label: `acceptance-${name}`,
      baselineFailures: decl?.baseline_failures ?? [],
      candidateId,
      pathBase: controlRoot,
    });
    return {
      repository: name,
      sha,
      command: record.command,
      exit_code: record.exit_code,
      failure_fingerprint: record.failure_fingerprint,
      output_path: record.output_path,
      output_sha256: record.output_sha256,
    };
  } finally {
    runGit(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
    runGit(repo, ['worktree', 'prune'], { allowFail: true });
  }
}
