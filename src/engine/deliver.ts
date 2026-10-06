/**
 * Delivery: move every repository's base branch to exactly the candidate.
 *
 * All checks run before anything moves: the feature must verify, the
 * candidate must still match every repository, and each base branch must be
 * an ancestor of the candidate's commit (a fast-forward) and, where it is
 * checked out, clean. Only then is a delivery manifest written and each base
 * branch fast-forwarded: a checked-out branch with `merge --ff-only` in its
 * own worktree, any other with a compare-and-swap `update-ref`. If a later
 * repository fails, the ones this run moved are put back, again by
 * compare-and-swap: a base is restored only while it is still exactly at the
 * candidate this run installed. One that moved since (someone committed on
 * it) is never reset; the delivery is reported PARTIAL_DELIVERY and names it
 * for manual recovery. Nothing is ever pushed, and nothing is ever forced.
 *
 * Final acceptance then runs each repository's test command on a clean
 * checkout of the delivered commit and is recorded in the manifest. A
 * repeated delivery of an accepted candidate is answered from the manifest
 * only after the manifest is re-checked (shape, binding to the candidate,
 * every acceptance output present and hashing to what it records); a
 * manifest that does not check out re-runs acceptance. An interrupted
 * delivery resumes, treating bases already at the candidate as done.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import { checkEvidenceOutput } from '../evidence/paths.js';
import { withLock } from '../state/process-lock.js';

export type DeliveryStatus =
  | 'DELIVERING'
  | 'DELIVERED'
  | 'ROLLED_BACK'
  | 'PARTIAL_DELIVERY'
  | 'ACCEPTED'
  | 'ACCEPTANCE_FAILED';
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

function readManifest(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Why an ACCEPTED manifest cannot be trusted to answer a repeated delivery
 * of `candidate`, or null when it can: its shape, its binding to this
 * feature, candidate and every repository's candidate commit, one passing
 * acceptance record per repository at exactly that commit, and each
 * record's output still present inside the feature and hashing to what it
 * says.
 */
function untrustedManifest(
  controlRoot: string,
  featureId: string,
  candidateId: string,
  targets: Record<string, string>,
  raw: unknown,
): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'not a JSON object';
  const m = raw as Partial<DeliveryManifest>;
  if (m.schema !== 'mycelink-delivery/1') return 'wrong schema';
  if (m.status !== 'ACCEPTED') return `status ${String(m.status)}`;
  if (m.feature_id !== featureId || m.candidate_id !== candidateId) return 'names another feature or candidate';
  if (typeof m.accepted_at !== 'string' || typeof m.delivered_at !== 'string') return 'missing timestamps';
  if (m.repositories === null || typeof m.repositories !== 'object' || Array.isArray(m.repositories)) return 'no repositories';
  const names = Object.keys(targets).sort();
  if (Object.keys(m.repositories).sort().join('\u0000') !== names.join('\u0000')) return 'repositories differ from the candidate';
  for (const name of names) {
    const r = (m.repositories as Record<string, Partial<DeliveredRepository>>)[name];
    if (!r || r.target !== targets[name] || r.after !== targets[name]) return `${name} is not recorded at the candidate commit`;
  }
  if (!Array.isArray(m.acceptance) || m.acceptance.length !== names.length) return 'acceptance records do not cover every repository';
  const seen = new Set<string>();
  for (const a of m.acceptance as Partial<AcceptanceRecord>[]) {
    if (a === null || typeof a !== 'object' || typeof a.repository !== 'string' || !(a.repository in targets)) return 'malformed acceptance record';
    if (seen.has(a.repository)) return `duplicate acceptance for ${a.repository}`;
    seen.add(a.repository);
    if (typeof a.sha !== 'string' || !SHA.test(a.sha) || a.sha !== targets[a.repository]) return `${a.repository} acceptance ran on another commit`;
    if (a.exit_code !== 0 || a.failure_fingerprint !== null) return `${a.repository} acceptance did not pass`;
    if (!Array.isArray(a.command) || typeof a.output_path !== 'string' || typeof a.output_sha256 !== 'string') {
      return `${a.repository} acceptance record is incomplete`;
    }
    const problem = checkEvidenceOutput(controlRoot, featureId, { output_path: a.output_path, output_sha256: a.output_sha256 });
    if (problem !== null) return `${a.repository} acceptance output: ${problem}`;
  }
  return null;
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
  const targets = Object.fromEntries(names.map((n) => [n, candidate.repositories[n]?.sha as string]));
  if (
    (existing as Partial<DeliveryManifest> | null)?.status === 'ACCEPTED' &&
    names.every((n) => {
      const decl = workspace.repositories.repositories.find((r) => r.name === n);
      return decl !== undefined && resolveRef(repositoryPath(workspace, n), decl.base_branch) === targets[n];
    })
  ) {
    // The manifest must be byte-for-byte the one whose acceptance this
    // controller saw pass (its hash is in STATE.json), and must still check
    // out on its own: a relabelled failed delivery is neither.
    const recorded = state.accepted_deliveries?.[candidateId];
    const bytes = createHash('sha256').update(readFileSync(file)).digest('hex');
    const why =
      recorded !== bytes
        ? 'manifest does not match the accepted delivery recorded in STATE.json'
        : untrustedManifest(controlRoot, featureId, candidateId, targets, existing);
    if (why === null) return { ...(existing as DeliveryManifest), ok: true, idempotent: true };
    // Never trusted on its word: re-verify by running acceptance again.
    appendEvent(paths.events, {
      idempotency_key: `delivery.manifest_untrusted:${candidateId}:${Date.now()}`,
      type: 'delivery.manifest_untrusted',
      actor: 'mycelink',
      feature_id: featureId,
      data: { candidate_id: candidateId, reason: why.slice(0, 300) },
    });
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
  const drift = verifyCandidate(candidate, {
    controlRepo: controlRoot,
    repositories: refs,
    requiredRepositories: workspace.repositories.repositories.map((r) => r.name),
  });
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
    const stranded: string[] = [];
    for (const name of moved.reverse()) {
      const step = plan[name] as DeliveredRepository;
      const repo = repositoryPath(workspace, name);
      const outcome = restoreBase(repo, step);
      step.after = resolveRef(repo, step.base_branch);
      if (outcome === null) {
        rollback.push(`${name} restored`);
      } else {
        stranded.push(name);
        rollback.push(`${name} NOT restored (${outcome}; at ${step.after}) - manual recovery needed`);
      }
    }
    manifest.status = stranded.length > 0 ? 'PARTIAL_DELIVERY' : 'ROLLED_BACK';
    manifest.error =
      (stranded.length > 0 ? `PARTIAL_DELIVERY: ${stranded.join(', ')} left as found for manual recovery. ` : '') +
      `${detail.slice(0, 1000)} | rollback: ${rollback.join(', ') || 'nothing to undo'}`;
    save(file, manifest);
    appendEvent(paths.events, {
      idempotency_key: `delivery.${manifest.status === 'PARTIAL_DELIVERY' ? 'partial' : 'rolled_back'}:${candidateId}:${Date.now()}`,
      type: manifest.status === 'PARTIAL_DELIVERY' ? 'delivery.partial' : 'delivery.rolled_back',
      actor: 'mycelink',
      feature_id: featureId,
      data: { candidate_id: candidateId, stranded, error: manifest.error.slice(0, 500) },
    });
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
  const manifestSha = createHash('sha256').update(readFileSync(file)).digest('hex');
  mutateState(paths.featureDir, (s) => {
    const accepted = { ...(s.accepted_deliveries ?? {}) };
    if (passed) accepted[candidateId] = manifestSha;
    else delete accepted[candidateId];
    s.accepted_deliveries = accepted;
    // Only while this candidate is still the feature's current one.
    if (passed && s.current_candidate === candidateId && typeof s.superseded_by !== 'string') s.feature_state = 'COMPLETED';
    return s;
  });
  return { ...manifest, ok: passed, idempotent: false };
}

/**
 * Put one base back where this delivery found it, by compare-and-swap:
 * only while it is still exactly at the candidate this delivery installed.
 * Returns null when restored, otherwise why it was left alone.
 */
function restoreBase(repo: string, step: DeliveredRepository): string | null {
  const ref = `refs/heads/${step.base_branch}`;
  const now = resolveRef(repo, step.base_branch);
  if (now !== step.target) return `${step.base_branch} moved to ${String(now).slice(0, 12)} after this delivery`;
  if (step.method === 'update-ref') {
    const r = runGit(repo, ['update-ref', ref, step.before, step.target], { allowFail: true });
    return r.exitCode === 0 ? null : `compare-and-swap refused: ${r.stderr.trim().slice(0, 200)}`;
  }
  const checkout = step.checkout as string;
  // The checkout must still be exactly what this delivery left: clean, at
  // the candidate. Then the ref moves by compare-and-swap, and only then are
  // the index and files carried back (a two-tree merge that refuses rather
  // than overwrite anything changed in between).
  if (!isWorktreeClean(checkout)) return `${checkout} has uncommitted changes`;
  const cas = runGit(repo, ['update-ref', ref, step.before, step.target], { allowFail: true });
  if (cas.exitCode !== 0) return `compare-and-swap refused: ${cas.stderr.trim().slice(0, 200)}`;
  const files = runGit(checkout, ['read-tree', '-m', '-u', step.target, step.before], { allowFail: true });
  if (files.exitCode !== 0) {
    return `ref restored but the checkout's files were not (${files.stderr.trim().slice(0, 200)}); run git -C "${checkout}" checkout -- . after checking it`;
  }
  return null;
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
