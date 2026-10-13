/**
 * Evaluator fault injection for the fault-injected arms.
 *
 * A fault plan (schemas/fault-plan.schema.json, fault-plans/) lists faults
 * and their triggers; lib/arms.mjs applies them around the agent's sessions
 * and hands the resulting records to the verifier. Every injection here is
 * deterministic and model-free:
 *
 *   interrupt-restart   the running session — task or QA rework — is killed
 *                       at the trigger and a fresh session of the same phase
 *                       resumes it (resumePrompt: the same header in both
 *                       orchestration arms, then that phase's prompt), on
 *                       the phase's own budget; the record names both
 *   concurrent-commit   a teammate's commit lands on the delivery branch;
 *                       the agent's own working-tree changes are kept
 *   late-hidden-defect  after the delivery, a commit reverting the delivered
 *                       production change of one required module lands and
 *                       QA reports the hidden checks that now fail
 *                       (lateDefectPrompt); a fresh session repairs it —
 *                       through Mycelink's node rework when the plugin is
 *                       there, directly test-first when not (one prompt,
 *                       REWORK_INSTRUCTION, for both arms)
 *   duplicate-result    a settle the host already ran is replayed with its
 *   stale-result        spent capability (the last / the first seen in the
 *                       transcripts); Mycelink must answer with its stored
 *                       receipt (a JSON report, idempotent: true) or an
 *                       explicit spent-capability refusal code, never settle
 *                       again; a crash, timeout, signal, non-JSON answer or
 *                       unreadable state is a failure, not a refusal
 *
 * A fault whose trigger never fired, or that does not apply (the Mycelink-
 * only faults without the plugin), is recorded with `applied: false` and
 * reported as a warning. The verifier checks the applied ones
 * (inspectFaults): injected commits must stay in the delivered history,
 * replays must have had no second effect (no re-run, no change to the
 * feature's state), and an interrupt must name the session it interrupted
 * and the fresh session of that phase that resumed it.
 *
 * An injected commit is journaled the moment its compare-and-swap lands —
 * before the agent's working tree and index follow — so a failed sync (the
 * agent's git holding the index) is retried on its own and never lands a
 * second commit. Its record is bound to exactly that commit (parent, tree,
 * changes, identity, binding hash); only commits a record binds are left
 * out of the TDD replay (the late defect also ends the cycles before it; an
 * injection amended, replaced or dropped fails the replay), and only their
 * effects, while the delivered tree still holds them exactly, out of the
 * delivered scope.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJson, canonicalSha256, sha256Hex } from './hash.mjs';
import { catFileBatch, git, gitOk, mycelinkEnv, neutralDir, revParse, safeGit } from './git.mjs';
import { runSync } from './sandbox.mjs';
import { makeSection } from './hygiene.mjs';
import { artifactBin, verifyPluginArtifact } from './plugin.mjs';
import { changedPaths, isTestPath, moduleOf, testedModules } from './scope.mjs';
import { validateFile } from './schema.mjs';

export const FAULT_KINDS = ['interrupt-restart', 'stale-result', 'duplicate-result', 'concurrent-commit', 'late-hidden-defect'];

/** Faults that only exist for Mycelink's protocol; recorded as not applicable without it. */
export const MYCELINK_ONLY = new Set(['stale-result', 'duplicate-result']);

/** The header of a resumed session's prompt; identical in both orchestration arms. */
export const RESUME_PROMPT =
  'Your previous session on this request was interrupted before it finished. Continue from the current state of this workspace: check what is already done, do not start over, and keep the same delivery rules. Other changes may have landed on the delivery branch in the meantime; deliver on top of them.';

const ORIGINAL = 'The original request follows.';

/** A fresh session's prompt after an interruption: the header, then the original prompt. */
export function resumePrompt(original) {
  return [RESUME_PROMPT, '', ORIGINAL, '', original].join('\n');
}

/**
 * What every corrective session is told first (CSET-203 r9: the corrective
 * session saw the earlier session's file, took it for contamination to clean
 * up, and its `rm` was the second violation): the change was the evaluator's
 * to undo, it is undone and verified, and nothing of it is the controller's
 * to touch.
 */
const UNDONE = [
  'The evaluator has already undone every one of those changes and verified the workspace against how it was before them. There is nothing left to clean up. Do not inspect, recreate, delete or repair anything that session did: touching it again is another violation.',
];

/** The controller's standing rules, as a corrective session must keep them. */
const CONTROLLER_ONLY =
  "You read, run Mycelink's CLI, write your own documents (the feature's PRD, plan and graph) and commit the control repository; you write nothing else in the workspace — a helper or scratch file goes under $TMPDIR, outside it — and you never write, edit, commit or run a gate in a product repository, a worktree, a result slot or the evidence yourself: module-workers change product code, and Mycelink writes its own files.";

/** What the evaluator undid, as the prompt names it: how far, what it discarded, and each change by path and kind only. */
function undoneLines(violation) {
  const r = violation.reconstruction ?? null;
  const how =
    violation.mode !== 'full'
      ? 'only the session’s own changes were undone; what Mycelink and its module-workers did meanwhile is kept'
      : r
        ? `Mycelink’s records were taken back to just before its first step that read those changes (${r.cut_at}): every step Mycelink and its module-workers made before then is kept, and so is every module-worker’s worktree that stood then${(r.removed_zones ?? []).length ? `; worktrees made after it were removed, their branches archived (${r.removed_zones.join(', ')})` : ''} — continue from where Mycelink stands`
        : 'the whole session was rolled back to how it began, Mycelink’s records included, because Mycelink may have read the changes';
  const discarded = (violation.discarded ?? []).map((n) => `the dispatch of ${n} was discarded through Mycelink (handed back unspent, its worktree removed, its branch archived)`);
  return [`What the evaluator undid (${[how, ...discarded].join('; ')}):`, ...(violation.summary ?? []).map((l) => `- ${l}`)];
}

/**
 * The header of a corrective session in a with-arm QA rework, after the
 * harness rolled back what its controller changed itself (lib/arms.mjs).
 */
export const CORRECTIVE_PROMPT = [
  'Your previous session on this QA report was stopped by the evaluator: as the Mycelink controller it changed the workspace itself instead of through Mycelink, which is recorded against this run as a controller violation.',
  ...UNDONE,
  '',
  `This is a fresh corrective session, and it is the Mycelink controller only. Your first action is to invoke \`/mycelink:rework\` with QA's report below. ${CONTROLLER_ONLY} The repair is made by the module-workers Mycelink dispatches, and it is delivered only as a new candidate.`,
].join('\n');

/** A corrective rework session's prompt: the header, what the evaluator undid, then QA's report as the phase sent it. */
export function correctivePrompt(original, violation) {
  return [CORRECTIVE_PROMPT, '', ...undoneLines(violation), '', "QA's report follows.", '', original].join('\n');
}

/**
 * The header of a corrective session in a with-arm task (CSET-202 r2,
 * CSET-203 r9), after the harness rolled back what its controller changed
 * itself.
 */
export const TASK_CORRECTIVE_PROMPT = [
  'Your previous session on this request was stopped by the evaluator: as the Mycelink controller it changed the workspace itself instead of through Mycelink, which is recorded against this run as a controller violation.',
  ...UNDONE,
  '',
  `This is a fresh corrective session, and it is the Mycelink controller only. ${CONTROLLER_ONLY} When settle holds a node for its criterion evidence (EVIDENCE_CORRECTION_REQUIRED, or \`session reconcile\` lists it with settlement "correction"), run \`dispatch --resume <node>\` and give the correction ticket, unchanged, to a module-worker: a genuine worker corrects it; never write or correct its result yourself.`,
].join('\n');

/** A corrective task session's prompt: the header, its first action, what the evaluator undid, then the request. */
export function taskCorrectivePrompt(original, violation, featureId) {
  return [
    TASK_CORRECTIVE_PROMPT,
    '',
    `Your first action is to invoke \`/mycelink:run ${featureId}\` and follow it from where Mycelink stands: recover the controller key when it says to (\`controller open --recover\`), then set up, plan, dispatch, settle and deliver through Mycelink — a discarded node is READY and goes to a fresh module-worker.`,
    '',
    ...undoneLines(violation),
    '',
    ORIGINAL,
    '',
    original,
  ].join('\n');
}

/**
 * The header of a with-arm session that continues a controller which exited
 * 0 while Mycelink recorded its feature as incomplete and resumable
 * (lib/arms.mjs runPhase; CSET-203 r4's corrective controller exited with
 * the cli READY in its rework generation, one attempt left).
 */
export const CONTINUATION_PROMPT = [
  'Your previous session on this request exited before the feature was complete. Mycelink records it as incomplete but resumable: nothing done is lost, and this fresh session continues it.',
  '',
  'You are the Mycelink controller. Your first action is to invoke `/mycelink:run` for the feature: recover the controller key (`controller open --recover`), reconcile, then dispatch, give each ticket to its module-worker unchanged, settle it, and deliver, until `feature verify --delivered` passes. You never write, edit, commit or run a gate in a product repository, a worktree, a result slot or the evidence yourself: a module-worker changes product code, and the first such call of yours stops this session.',
].join('\n');

/** A continuation's prompt: the header, what Mycelink says comes next and why the feature is incomplete, then the request. */
export function continuationPrompt(original, { feature_id, incomplete = [], next_action = null }) {
  return [
    CONTINUATION_PROMPT,
    '',
    next_action ? `What Mycelink says comes next for ${feature_id} (feature status): ${next_action.kind}${next_action.resumable ? ' (resumable)' : ''}: ${next_action.detail}` : `Mycelink's next step for ${feature_id}: run \`feature status ${feature_id}\`.`,
    ...(incomplete.length ? ['', 'Why it is incomplete:', ...incomplete.map((x) => `- ${x}`)] : []),
    '',
    ORIGINAL,
    '',
    original,
  ].join('\n');
}

/**
 * The header of a session that continues one the model provider ended
 * (CSET-203 r10: the controller's reply was refused by a provider safeguard
 * right after it dispatched the cli's rework, and the session exited 1).
 * Mycelink has reconciled what it had in flight from Claude Code's own
 * records before this session starts (`session provider-interrupt`).
 */
export const PROVIDER_RESUME_PROMPT = [
  'Your previous session on this request was ended by the model provider: a transient failure of the model service, not of the work and not a mistake of yours. Mycelink has already reconciled what it had in flight: nothing done is lost, nothing was charged, and what the old session handed out no longer counts.',
  '',
  'You are the Mycelink controller. Your first action is to invoke `/mycelink:run` for the feature: recover the controller key (`controller open --recover`), reconcile, then dispatch, give each ticket to its module-worker unchanged, settle it, and deliver, until `feature verify --delivered` passes. You never write, edit, commit or run a gate in a product repository, a worktree, a result slot or the evidence yourself: a module-worker changes product code, and the first such call of yours stops this session.',
].join('\n');

/** What Mycelink did with one lease the provider interrupted, as the resume prompt names it (ids only, never content). */
function interruptedLine(i) {
  if (i.kind === 'review') return `- acceptance review ${i.review_id} (generation ${i.dispatch_id}): revoked; dispatch hands a fresh reviewer generation out, no correction or round spent`;
  if (i.action === 'resumable') return `- ${i.node_id} (its worker's lease, dispatch ${i.dispatch_id}): kept with the worker's commits and gates, its capability rotated; dispatch hands the same generation to a module-worker, from where it stands`;
  return `- ${i.node_id} (its worker's lease, dispatch ${i.dispatch_id}): released to READY, its attempt refunded; dispatch hands it to a fresh module-worker`;
}

/**
 * A provider-resume session's prompt: the header, what the provider
 * interrupted and what Mycelink did with it, what Mycelink says comes next,
 * then the request. The failure is named by its class only.
 */
export function providerResumePrompt(original, { feature_id, failure, reconciled = null, next_action = null }) {
  const interrupted = reconciled?.interrupted ?? [];
  return [
    PROVIDER_RESUME_PROMPT,
    '',
    interrupted.length > 0
      ? [`What the model provider interrupted (${failure?.class ?? 'a transient failure'}), as Mycelink reconciled it for ${feature_id}:`, ...interrupted.map(interruptedLine)].join('\n')
      : `The model provider failed the session (${failure?.class ?? 'a transient failure'}); nothing of Mycelink's was in flight for ${feature_id} at that moment.`,
    '',
    next_action ? `What Mycelink says comes next for ${feature_id} (feature status): ${next_action.kind}${next_action.resumable ? ' (resumable)' : ''}: ${next_action.detail}` : `Mycelink's next step for ${feature_id}: run \`feature status ${feature_id}\`.`,
    '',
    ORIGINAL,
    '',
    original,
  ].join('\n');
}

/**
 * Have the pinned Mycelink reconcile what a session the model provider ended
 * had in flight (`session provider-interrupt`), inside the boundary, with the
 * session HOME readable: Mycelink reads the failure from Claude Code's own
 * records there, never from the harness. Returns the report, its failures
 * sanitized (class, request id, category), or null when it cannot say (no
 * feature yet, an error).
 */
export function providerInterruptDispatch({ control, mycelink, featureId, phase, workspace = null, home = null, timeoutMs = REPLAY_TIMEOUT_MS, isolation = null }) {
  const sealed = verifyPluginArtifact(mycelink);
  if (!sealed.ok) return null;
  if (!isolation || !['bubblewrap', 'none'].includes(isolation.kind)) throw new Error('no isolation given: a provider reconcile runs only inside the boundary');
  const root = workspace ?? control;
  const binds = [{ path: root, rw: true }, { path: mycelink.dir }, { path: dirname(process.execPath) }, { path: neutralDir() }, ...(home ? [{ path: home }] : [])];
  const argv = [process.execPath, artifactBin(mycelink), 'session', 'provider-interrupt', featureId, '--phase', phase, '--control-root', control, '--json'];
  const r = runSync(isolation, { argv, env: mycelinkEnv(), cwd: root, binds }, { encoding: 'utf8', timeout: timeoutMs });
  if (r.status !== 0) return null;
  try {
    const out = JSON.parse(String(r.stdout));
    return {
      outcome: out.outcome,
      interrupted: (out.interrupted ?? []).map((i) => ({ lease_id: i.lease_id, kind: i.kind, node_id: i.node_id, review_id: i.review_id, dispatch_id: i.dispatch_id, action: i.action, class: i.failure?.class ?? null, request_id: i.failure?.request_id ?? null, source: i.failure?.source ?? null, ticket: i.ticket, count: i.count })),
      kept: (out.kept ?? []).length,
      unavailable: out.provider?.unavailable ?? null,
      next_action: out.next_action ? { kind: out.next_action.kind, resumable: out.next_action.resumable === true, detail: String(out.next_action.detail ?? '').slice(0, 2000) } : null,
    };
  } catch {
    return null;
  }
}

/**
 * What the pinned Mycelink says comes next for a feature (`feature status
 * --json`: `next_action`, `resumable`), read inside the run's boundary; null
 * when it cannot say. With the session HOME (read-only) Mycelink reads where
 * a reviewer its controller launched stands from Claude Code's own records
 * there (CSET-203 r13: `await-reviewer`, by hash only).
 */
export function featureNextAction({ control, mycelink, featureId, workspace = null, home = null, timeoutMs = REPLAY_TIMEOUT_MS, isolation = null }) {
  const sealed = verifyPluginArtifact(mycelink);
  if (!sealed.ok) return null;
  if (!isolation || !['bubblewrap', 'none'].includes(isolation.kind)) throw new Error('no isolation given: a status read runs only inside the boundary');
  const root = workspace ?? control;
  const binds = [{ path: root, rw: true }, { path: mycelink.dir }, { path: dirname(process.execPath) }, { path: neutralDir() }, ...(home ? [{ path: home }] : [])];
  const argv = [process.execPath, artifactBin(mycelink), 'feature', 'status', featureId, '--control-root', control, '--json'];
  const r = runSync(isolation, { argv, env: mycelinkEnv(), cwd: root, binds }, { encoding: 'utf8', timeout: timeoutMs });
  if (r.status !== 0) return null;
  try {
    const out = JSON.parse(String(r.stdout));
    return out.next_action ? { next_action: out.next_action, resumable: out.resumable === true } : null;
  } catch {
    return null;
  }
}

/**
 * Have the pinned Mycelink look at the reviewer its controller launched for
 * the open review generation, once that controller's session ended
 * (`review await --wait-seconds 0`, CSET-203 r13), inside the boundary with
 * the session HOME readable: a reviewer whose session's process is gone
 * before it completed, or past its wall-clock, is interrupted there from
 * Claude Code's own records — its generation re-issued by the next
 * dispatch, nothing spent — and one that completed is left for the next
 * dispatch to settle. Returns the report by hash only (its state, what comes
 * next, the reviewer's task and agent hashes and its wall-clock), or null
 * when it cannot say.
 */
export function reviewerAwaitDispatch({ control, mycelink, featureId, workspace = null, home = null, timeoutMs = REPLAY_TIMEOUT_MS, isolation = null }) {
  const sealed = verifyPluginArtifact(mycelink);
  if (!sealed.ok) return null;
  if (!isolation || !['bubblewrap', 'none'].includes(isolation.kind)) throw new Error('no isolation given: a reviewer reconcile runs only inside the boundary');
  const root = workspace ?? control;
  const binds = [{ path: root, rw: true }, { path: mycelink.dir }, { path: dirname(process.execPath) }, { path: neutralDir() }, ...(home ? [{ path: home }] : [])];
  const argv = [process.execPath, artifactBin(mycelink), 'review', 'await', featureId, '--wait-seconds', '0', '--control-root', control, '--json'];
  const r = runSync(isolation, { argv, env: mycelinkEnv(), cwd: root, binds }, { encoding: 'utf8', timeout: timeoutMs });
  if (r.status !== 0) return null;
  try {
    const out = JSON.parse(String(r.stdout));
    const v = out.reviewer ?? null;
    return {
      review_id: out.review_id ?? null,
      dispatch_id: out.dispatch_id ?? null,
      state: out.state,
      next: out.next,
      reviewer: v === null ? null : { state: v.state, task_sha256: v.task_sha256 ?? null, agent_id_sha256: v.agent_id_sha256 ?? null, launched_at: v.launched_at ?? null, elapsed_ms: v.elapsed_ms ?? null, remaining_ms: v.remaining_ms ?? null, timeout_ms: v.timeout_ms ?? null },
    };
  } catch {
    return null;
  }
}

/**
 * The hidden checks a late defect broke: those that passed on the delivery
 * before it and do not after. Checks the delivery already failed are never
 * disclosed — only their count is recorded.
 */
export function defectFailures({ before, after }) {
  const key = (t) => `${t.file}\0${t.name}`;
  const passedBefore = new Set(before.filter((t) => t.status === 'passed').map(key));
  return { broken: after.filter((t) => t.status !== 'passed' && passedBefore.has(key(t))), already_failing: before.filter((t) => t.status !== 'passed').length };
}

/**
 * What QA asks after its report, identical in both orchestration arms and
 * conditional on the plugin, as the request's own instruction is — but
 * front-loaded: the first action is the plugin's controller-only rework
 * command (`/mycelink:rework`), named before any product file is read, so
 * the route does not hang on a model noticing a conditional paragraph (the
 * PCM-101 r4 controller repaired main itself). Without the plugin, the
 * session repairs directly, test-first.
 */
export const REWORK_INSTRUCTION = [
  'First action, before you read or change anything in the product repository: if the Mycelink plugin is available, invoke its `/mycelink:rework` command with this QA report (or `/mycelink:run` with it, if `/mycelink:rework` is missing). In that mode this session is the Mycelink controller: do not edit or commit product code in this session yourself. It inspects the feature\'s status (`feature status`), attributes the failing checks to the producer node that owns the failing behaviour and reopens it (`feature rework`; or `feature owners`, then Mycelink\'s `node rework`) with these failing checks as its reason (at most 2000 bytes), dispatches the reopened nodes to module-worker subagents and settles each, cuts a new candidate, runs its acceptance and delivers it. You are done only when `feature verify <feature> --delivered` passes.',
  '',
  'Only if the Mycelink plugin and its commands are genuinely unavailable in this session, repair it directly on the delivery branch, test-first: commit a failing regression test before the fix, and leave the repository checked out on the delivery branch at the commit you deliver.',
  '',
  'Either way, repair it as part of the same request, on top of the delivered history and without rewriting it, keeping every existing test passing. End with the same short summary.',
].join('\n');

/**
 * QA's report of a late defect: the failing checks by name, the public
 * module and repository the defect is in (`affected`, from the bound
 * injection record: `{ module, path, repository }`, the adapter's module and
 * the workspace's repository directory, both in the case's README; left out
 * when there is none), what to do about it, then the original prompt.
 */
export function lateDefectPrompt({ commit, failures, affected = null, original = null }) {
  const lines = [
    `QA ran its end-to-end checks on the delivered commit ${commit.slice(0, 12)} and found a defect:`,
    '',
    ...failures.map((f) => `- ${f.name}: ${String(f.message ?? '').split('\n')[0] || f.status || 'failed'}`),
    '',
    ...(affected ? [`QA traced the failing checks to the module \`${affected.module}\` (\`${affected.path}/\`) of the repository \`${affected.repository}/\`.`, ''] : []),
    REWORK_INSTRUCTION,
  ];
  if (original !== null) lines.push('', ORIGINAL, '', original);
  return lines.join('\n');
}

export function loadFaultPlan(file) {
  const { doc, problems } = validateFile('fault-plan', file);
  if (problems.length) throw new Error(`invalid fault plan: ${problems.join('; ')}`);
  return doc;
}

const TEAMMATE = {
  GIT_AUTHOR_NAME: 'Platform Teammate',
  GIT_AUTHOR_EMAIL: 'teammate@workspace.invalid',
  GIT_COMMITTER_NAME: 'Platform Teammate',
  GIT_COMMITTER_EMAIL: 'teammate@workspace.invalid',
};

/** Build a commit on `parent` from a scratch index edited by `edit(env)`; nothing else is touched. */
function commitOnScratchIndex(repo, parent, message, edit) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-fault-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index'), ...TEAMMATE };
    git(repo, ['read-tree', parent], { env });
    edit(env);
    const tree = git(repo, ['write-tree'], { env });
    return git(repo, ['commit-tree', tree, '-p', parent, '-m', message], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function onBranch(repo, branch) {
  const sym = safeGit(repo, ['symbolic-ref', '--quiet', 'HEAD']);
  return sym.code === 0 && sym.stdout === `refs/heads/${branch}`;
}

/** Move `branch` from `old` to `commit` only if nobody moved it meanwhile. */
function advance(repo, branch, commit, old) {
  git(repo, ['update-ref', `refs/heads/${branch}`, commit, old]);
}

/** Faults that land a commit of the evaluator's on the delivery branch. */
export const COMMIT_FAULTS = new Set(['concurrent-commit', 'late-hidden-defect']);

const ZERO = '0'.repeat(40);

/** Exactly what `commit` changes against `parent`: `[{ path, mode, blob }]` by path (blob null: deleted). */
function commitChanges(repo, parent, commit) {
  const out = git(repo, ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', parent, commit]);
  const parts = out.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === '') break;
    const m = /^:\d{6} (\d{6}) [0-9a-f]{40} ([0-9a-f]{40}) [A-Z]\d*$/.exec(parts[i]);
    if (!m) throw new Error(`unexpected diff-tree output: ${parts[i]}`);
    changes.push({ path: parts[i + 1], mode: m[2] === ZERO ? null : m[1], blob: m[2] === ZERO ? null : m[2] });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function parentsOfCommit(repo, commit) {
  return git(repo, ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);
}

const authorOf = (repo, commit) => git(repo, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', commit]);

/** The hash binding an injection record to exactly one commit's parent, tree, changes and identity. */
function bindingOf(r) {
  return canonicalSha256({ kind: r.kind, commit: r.commit, parent: r.parent, tree: r.tree, changes: r.changes, identity: r.identity });
}

/** The record of a commit that just landed, bound to it by content. */
function boundRecord(repo, fields) {
  const record = {
    ...fields,
    tree: git(repo, ['rev-parse', `${fields.commit}^{tree}`]),
    changes: commitChanges(repo, fields.parent, fields.commit).map(({ path, blob }) => ({ path, blob })),
    identity: authorOf(repo, fields.commit),
  };
  return { ...record, binding_sha256: bindingOf(record) };
}

/** Why `record` does not bind its commit (empty: it does). */
export function injectionProblems(repo, r) {
  if (typeof r.commit !== 'string' || !/^[0-9a-f]{40}$/.test(r.commit)) return ['the record names no commit'];
  if (!gitOk(repo, ['cat-file', '-e', `${r.commit}^{commit}`])) return [`commit ${r.commit.slice(0, 12)} is not in the repository`];
  const problems = [];
  const parents = parentsOfCommit(repo, r.commit);
  if (parents.length !== 1 || parents[0] !== r.parent) problems.push(`its parents are ${parents.map((p) => p.slice(0, 12)).join(', ') || 'none'}, the record says ${String(r.parent).slice(0, 12)}`);
  if (git(repo, ['rev-parse', `${r.commit}^{tree}`]) !== r.tree) problems.push('its tree is not the recorded one');
  if (parents.length === 1 && canonicalJson(commitChanges(repo, parents[0], r.commit).map(({ path, blob }) => ({ path, blob }))) !== canonicalJson(r.changes ?? null)) problems.push('it changes other paths or content than recorded');
  if (authorOf(repo, r.commit) !== r.identity) problems.push('its author or committer is not the recorded one');
  if (r.binding_sha256 !== bindingOf(r)) problems.push('the record was edited after it was bound');
  return problems;
}

/** Injections that land between phases: the late defect, after the delivery and before QA's rework. */
const BETWEEN_PHASES = new Set(['late-hidden-defect']);

/**
 * The evaluator's injected commits, trusted only where the record binds the
 * commit exactly (parent, tree, changes, identity, binding hash): those, and
 * only those, are left out of the TDD replay (the delivered scope leaves out
 * only their effects still present: injectedEffects), whatever later commits
 * do to their content. `boundaries` are the bound ones that land between
 * phases (the late defect): the cycles before them end there.
 */
export function boundInjections({ repo, records = [] }) {
  const commits = new Set();
  const boundaries = new Set();
  const problems = new Map();
  for (const r of records) {
    if (r.applied === false || !COMMIT_FAULTS.has(r.kind)) continue;
    const p = injectionProblems(repo, r);
    if (p.length === 0) {
      commits.add(r.commit);
      if (BETWEEN_PHASES.has(r.kind)) boundaries.add(r.commit);
    } else problems.set(r, p);
  }
  return { commits, boundaries, problems };
}

/**
 * What the TDD replay may rest on, per applied injection: `[{ kind, commit,
 * ok, detail }]`, ok only while its record binds its commit exactly and the
 * delivered history (`head`) still holds that commit. An injection amended,
 * replaced or dropped, or a record that no longer binds, fails the replay:
 * a commit that only looks like one (author, message, paths) is the
 * delivery's.
 */
export function injectionHistory({ repo, head, records = [] }) {
  return records
    .filter((r) => r.applied !== false && COMMIT_FAULTS.has(r.kind))
    .map((r) => {
      const at = `${r.kind} ${String(r.commit).slice(0, 12)}`;
      const problems = injectionProblems(repo, r);
      if (problems.length) return { kind: r.kind, commit: r.commit ?? null, ok: false, detail: `${at}: the record does not bind its commit (${problems.join('; ')})` };
      if (!gitOk(repo, ['merge-base', '--is-ancestor', r.commit, head])) return { kind: r.kind, commit: r.commit, ok: false, detail: `${at}: not in the delivered history (amended, replaced or dropped)` };
      return { kind: r.kind, commit: r.commit, ok: true, detail: `${at}: bound and in the delivered history; in no unit${BETWEEN_PHASES.has(r.kind) ? ', and the cycles before it end there' : ''}` };
    });
}

/**
 * What the evaluator's injected commits changed, where the delivered
 * history still holds them: every record that binds its commit exactly
 * (injectionProblems) and whose commit is an ancestor of `head` gives its
 * commit and its recorded changes `{ path, blob, kind, commit }` (blob null:
 * deleted). Scope (lib/scope.mjs) leaves a path out only while the
 * delivered tree holds exactly the content such a change gave it.
 */
export function injectedEffects({ repo, head, records = [] }) {
  const commits = new Set();
  const changes = [];
  for (const r of records) {
    if (r.applied === false || !COMMIT_FAULTS.has(r.kind) || injectionProblems(repo, r).length > 0) continue;
    if (!gitOk(repo, ['merge-base', '--is-ancestor', r.commit, head])) continue;
    commits.add(r.commit);
    for (const c of r.changes) changes.push({ path: c.path, blob: c.blob, kind: r.kind, commit: r.commit });
  }
  return { commits, changes };
}

/** The injected commit landed, but the agent's working tree and index could not follow yet. */
export class InjectionSyncError extends Error {
  constructor(record, cause) {
    super(`injected commit ${record.commit.slice(0, 12)} landed, but the working tree could not follow (the index is probably locked): ${String(cause?.message ?? cause).split('\n')[0]}`);
    this.name = 'InjectionSyncError';
    this.record = record;
  }
}

/**
 * Bring the working tree and index of `repo` to an injected commit's
 * changes (only those paths: the agent's other work stays as it was), when
 * the delivery branch is checked out. Idempotent: the index is updated
 * first, in one locked write, then the files. Returns the record with
 * `sync` 'done' or 'not-needed'; throws InjectionSyncError (the record still
 * 'pending') when the index cannot be written.
 */
export function resumeInjectionSync({ repo, record }) {
  if (record.sync === 'done' || record.sync === 'not-needed') return record;
  record.sync_attempts = (record.sync_attempts ?? 0) + 1;
  if (!onBranch(repo, record.branch) || !gitOk(repo, ['merge-base', '--is-ancestor', record.commit, 'HEAD'])) {
    record.sync = 'not-needed';
    return record;
  }
  const added = record.changes.filter((c) => c.blob !== null).flatMap((c) => ['--cacheinfo', `${modeAt(repo, record.commit, c.path)},${c.blob},${c.path}`]);
  const removed = record.changes.filter((c) => c.blob === null).map((c) => c.path);
  try {
    git(repo, ['update-index', '--add', ...added, ...(removed.length ? ['--force-remove', '--', ...removed] : [])]);
  } catch (error) {
    throw new InjectionSyncError(record, error);
  }
  const contents = catFileBatch(repo, record.changes.filter((c) => c.blob !== null).map((c) => c.blob));
  for (const c of record.changes) {
    const file = join(repo, ...c.path.split('/'));
    if (c.blob === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents.get(c.blob));
    }
  }
  record.sync = 'done';
  return record;
}

function modeAt(repo, commit, path) {
  return git(repo, ['ls-tree', commit, '--', path]).split(/\s/)[0] || '100644';
}

/**
 * Land `commit` (already built on `old`) by compare-and-swap, journal its
 * bound record at once — before anything else can fail — and bring the
 * working tree along. A failed sync leaves the journaled record 'pending'
 * for resumeInjectionSync; it never lands a second commit.
 */
function land({ repo, branch, commit, old, fields, journal }) {
  advance(repo, branch, commit, old);
  const record = boundRecord(repo, { ...fields, applied: true, branch, commit, parent: old, sync: 'pending', sync_attempts: 0 });
  journal(record);
  return resumeInjectionSync({ repo, record });
}

export function injectConcurrentCommit({ repo, branch, path, content, message, journal = () => {} }) {
  const old = revParse(repo, `refs/heads/${branch}`);
  if (!old) throw new Error(`branch ${branch} does not exist`);
  const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: content });
  const commit = commitOnScratchIndex(repo, old, message, (env) => git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env }));
  return land({ repo, branch, commit, old, fields: { kind: 'concurrent-commit', path }, journal });
}

export function injectLateDefect({ repo, branch, patch, message, journal = () => {} }) {
  const old = revParse(repo, `refs/heads/${branch}`);
  if (!old) throw new Error(`branch ${branch} does not exist`);
  const dir = mkdtempSync(join(tmpdir(), 'bench-defect-'));
  let commit;
  try {
    const patchFile = join(dir, 'defect.patch');
    writeFileSync(patchFile, patch);
    commit = commitOnScratchIndex(repo, old, message, (env) => git(repo, ['apply', '--cached', '--whitespace=nowarn', patchFile], { env }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const paths = changedPaths(repo, old, commit).map((c) => c.path);
  return land({ repo, branch, commit, old, fields: { kind: 'late-hidden-defect', paths }, journal });
}

/**
 * The late defect for a delivery, independent of how it was implemented:
 * the delivered production change of the first required module (manifest
 * order) that has one and runtime tests, reverted (reverting declarations
 * would change no behaviour). `{ module, paths, patch }`, or null when no
 * required module has a production change.
 */
export function lateDefectPatch({ repo, start, head, adapter, prd }) {
  const changed = changedPaths(repo, start, head);
  for (const m of testedModules(adapter, prd.modules.required)) {
    const paths = changed.filter((c) => moduleOf(adapter, c.path) === m && !isTestPath(adapter, c.path)).map((c) => c.path);
    if (paths.length === 0) continue;
    const r = safeGit(repo, ['diff', '--binary', '--no-renames', '--no-ext-diff', head, start, '--', ...paths], { encoding: 'buffer' });
    if (r.code !== 0) throw new Error(`git diff for the late defect failed: ${String(r.stderr)}`);
    return { module: m, paths, patch: r.stdout };
  }
  return null;
}

const CAPABILITY = '[0-9a-f]{64}';
const SETTLE_LINE = new RegExp(`\\bsettle\\s+["']?([A-Za-z0-9._-]+)["']?\\s+["']?([A-Za-z0-9._-]+)["']?([^\\n]*?)--capability[=\\s]+["']?(${CAPABILITY})`, 'g');
const CONTROL_ROOT = /--control-root[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/;
const TICKET = new RegExp(`"feature_id"\\s*:\\s*"([^"]+)"\\s*,\\s*"node_id"\\s*:\\s*"([^"]+)"[\\s\\S]{0,600}?"capability"\\s*:\\s*"(${CAPABILITY})"`, 'g');

function textsOf(event) {
  const out = [];
  for (const part of event?.message?.content ?? []) {
    if (part?.type === 'tool_use' && part.name === 'Bash') out.push(String(part.input?.command ?? ''));
    else if (part?.type === 'tool_result') {
      if (typeof part.content === 'string') out.push(part.content);
      else for (const c of part.content ?? []) if (c?.type === 'text') out.push(String(c.text ?? ''));
    }
  }
  return out;
}

/**
 * Every settle a host could have run, from stream-json transcripts, in
 * order of first appearance: `mycelink settle <feature> <node> ...
 * --capability <cap>` lines (the host's commands, and the settle_command
 * rendered in dispatch tickets) and the tickets' JSON. A ticket shown in a
 * tool result counts even when the host ran its settle through a script.
 */
export function settleCommandsFromTranscript(jsonl) {
  const out = [];
  const seen = new Set();
  const add = (feature, node, capability, control = null) => {
    const key = `${feature}\0${node}\0${capability}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ feature, node, capability, ...(control ? { control } : {}) });
  };
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const text of textsOf(event)) {
      for (const m of text.matchAll(SETTLE_LINE)) {
        const root = CONTROL_ROOT.exec(m[3]);
        add(m[1], m[2], m[4], root ? root[1] ?? root[2] ?? root[3] : null);
      }
      for (const m of text.matchAll(TICKET)) add(m[1], m[2], m[3]);
    }
  }
  return out;
}

function readState(control, feature) {
  const file = join(control, 'features', feature, 'STATE.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')).data ?? null;
  } catch {
    return null;
  }
}

/**
 * The feature's state as Mycelink means it: STATE.json's data without the
 * bookkeeping every locked write bumps (the document revision, updated_at).
 */
function stateDigest(control, feature) {
  const data = readState(control, feature);
  if (data === null) return null;
  const { updated_at: _updated, ...rest } = data;
  return sha256Hex(canonicalJson(rest));
}

/** Inside `root` (or `root` itself)? */
function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The refusals that mean "this capability is spent or stale" — besides a
 * stored receipt, the only answers to a replayed settle that show it had
 * no second effect. Mycelink prints them as `<CODE>: <detail>` on stderr
 * and exits 1.
 */
export const SPENT_CAPABILITY_REFUSALS = new Set(['NOT_CLAIMED', 'CAPABILITY_INVALID']);

const REPLAY_TIMEOUT_MS = 600_000;
const tail = (text, n = 4000) => {
  const s = String(text ?? '');
  return s.length > n ? s.slice(-n) : s;
};

/**
 * What one replayed settle answered, from its raw process result, failing
 * closed: only a parsed settle report (`receipt` when idempotent, else
 * `reran`) or an explicit known refusal code (`refused`) is an answer;
 * a spawn error, a signal, a timeout, a non-JSON report, an unknown error
 * or an unexpected exit is `error`. stderr is kept.
 */
export function classifySettleReplay(r) {
  const stderr = String(r.stderr ?? '');
  const base = {
    exit: r.status ?? null,
    signal: r.signal ?? null,
    timed_out: r.error?.code === 'ETIMEDOUT',
    stderr: tail(stderr),
    response: 'none',
    outcome: null,
    idempotent: null,
    refusal_code: null,
  };
  const error = (detail) => ({ ...base, effect: 'error', detail });
  if (base.timed_out) return error('the replayed settle timed out');
  if (r.error) return error(`the CLI could not run: ${r.error.message}`);
  if (r.signal) return error(`the CLI was killed by ${r.signal}`);
  const text = String(r.stdout ?? '').trim();
  if (text !== '') {
    let report;
    try {
      report = JSON.parse(text);
    } catch {
      return error(`exit ${base.exit}: stdout is not a JSON settle report`);
    }
    if (report === null || typeof report !== 'object' || Array.isArray(report) || typeof report.outcome !== 'string' || typeof report.idempotent !== 'boolean') {
      return error(`exit ${base.exit}: stdout is not a JSON settle report`);
    }
    if (base.exit !== 0 && base.exit !== 1) return error(`exit ${base.exit} with a settle report`);
    const answered = { ...base, response: 'json', outcome: report.outcome, idempotent: report.idempotent };
    // A dispatch that no longer counts is answered stale (CSET-203 r7): nothing settled, its late result archived at most.
    if (report.outcome === 'STALE_ORCHESTRATION_EPOCH') return { ...answered, effect: 'stale' };
    return report.idempotent ? { ...answered, effect: 'receipt' } : { ...answered, effect: 'reran', detail: `reran: the spent capability settled again (${report.outcome})` };
  }
  if (base.exit === 0) return error('exit 0: not a JSON settle report (no output)');
  if (base.exit !== 1) return error(`exit ${base.exit}: no settle report and no refusal`);
  const last = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  const code = /^([A-Z][A-Z0-9_]+): /.exec(last)?.[1] ?? null;
  if (!code || !SPENT_CAPABILITY_REFUSALS.has(code)) return error(`no structured response: stderr ends ${JSON.stringify(last.slice(0, 200))}`);
  return { ...base, response: 'refusal', refusal_code: code, effect: 'refused' };
}

/**
 * Replay harvested settles and record what each answered (see
 * classifySettleReplay) and the feature's state digest before and after.
 * Only spent capabilities are replayed — never one that still holds a live
 * claim, whose replay would be the first settle. duplicate-result replays
 * the most recently settled one, stale-result the first one seen. A control
 * root named in the transcript is used only inside `workspace`.
 */
export function replaySettles({ control, mycelink, commands, kinds, workspace = null, timeoutMs = REPLAY_TIMEOUT_MS, isolation = null }) {
  const candidates = commands
    .map((c) => ({ ...c, control: c.control && workspace && within(workspace, resolve(workspace, c.control)) ? resolve(workspace, c.control) : control }))
    .map((c) => ({ ...c, runtime: readState(c.control, c.feature)?.nodes?.[c.node] ?? null, hash: sha256Hex(c.capability) }))
    .filter((c) => c.runtime !== null && c.runtime.claim?.capability_sha256 !== c.hash);
  const settled = candidates.filter((c) => c.runtime.last_settlement?.capability_sha256 === c.hash);
  const latest = [...settled].sort((a, b) => String(a.runtime.last_settlement.settled_at).localeCompare(String(b.runtime.last_settlement.settled_at))).at(-1);
  const pick = { 'duplicate-result': latest, 'stale-result': candidates[0] };
  return kinds.map((kind) => {
    const c = pick[kind];
    if (!c) return { kind, applied: false, effect: null, state_changed: false, detail: commands.length ? 'no spent capability among the settles in the transcript' : 'no settle in the transcript' };
    // Only the pinned, packaged Mycelink replays, and only while its sealed tree is exactly the pinned one.
    const sealed = verifyPluginArtifact(mycelink);
    if (!sealed.ok) return { kind, applied: true, node: c.node, effect: 'error', response: 'none', state_changed: true, detail: `the pinned Mycelink artifact does not verify: ${sealed.problems.join('; ')}` };
    const before = stateDigest(c.control, c.feature);
    // A replay can run agent-defined gate commands: only inside the boundary, with the workspace, the artifact, Node and the neutral git configuration.
    if (!isolation || !['bubblewrap', 'none'].includes(isolation.kind)) throw new Error('no isolation given: a settle replay runs only inside the boundary');
    const root = workspace ?? c.control;
    const binds = [{ path: root, rw: true }, { path: mycelink.dir }, { path: dirname(process.execPath) }, { path: neutralDir() }];
    const r = runSync(isolation, { argv: [process.execPath, artifactBin(mycelink), 'settle', c.feature, c.node, '--capability', c.capability, '--control-root', c.control, '--json'], env: mycelinkEnv(), cwd: root, binds }, { encoding: 'utf8', timeout: timeoutMs });
    const after = stateDigest(c.control, c.feature);
    const answer = classifySettleReplay(r);
    const resealed = verifyPluginArtifact(mycelink);
    if (!resealed.ok) return { kind, applied: true, node: c.node, ...answer, effect: 'error', state_before: before, state_after: after, state_changed: true, detail: `the Mycelink artifact changed during the replay: ${resealed.problems.join('; ')}` };
    const record = { kind, applied: true, node: c.node, ...answer, state_before: before, state_after: after, state_changed: before === null || after === null || before !== after };
    if (before === null || after === null) return { ...record, effect: 'error', detail: `the feature state is unreadable ${before === null ? 'before' : 'after'} the replay${answer.detail ? `; ${answer.detail}` : ''}` };
    return record;
  });
}

/**
 * Discard a dispatch a stopped controller reached into, through the pinned
 * Mycelink artifact (`node discard`, presented with the claim's current
 * capability as the run's own transcripts show it), inside the boundary.
 * Returns `{ node_id, discarded, claim_id?, archived_ref?, worktree?, detail? }`.
 */
export function discardDispatch({ control, mycelink, featureId, nodeId, capability, reason, workspace = null, timeoutMs = REPLAY_TIMEOUT_MS, isolation = null }) {
  const sealed = verifyPluginArtifact(mycelink);
  if (!sealed.ok) return { node_id: nodeId, discarded: false, detail: `the pinned Mycelink artifact does not verify: ${sealed.problems.join('; ')}` };
  if (!isolation || !['bubblewrap', 'none'].includes(isolation.kind)) throw new Error('no isolation given: a discard runs only inside the boundary');
  const root = workspace ?? control;
  const binds = [{ path: root, rw: true }, { path: mycelink.dir }, { path: dirname(process.execPath) }, { path: neutralDir() }];
  const argv = [process.execPath, artifactBin(mycelink), 'node', 'discard', featureId, nodeId, '--capability', capability, '--reason', reason.slice(0, 500), '--control-root', control, '--json'];
  const r = runSync(isolation, { argv, env: mycelinkEnv(), cwd: root, binds }, { encoding: 'utf8', timeout: timeoutMs });
  const resealed = verifyPluginArtifact(mycelink);
  if (!resealed.ok) return { node_id: nodeId, discarded: false, detail: `the Mycelink artifact changed during the discard: ${resealed.problems.join('; ')}` };
  if (r.status !== 0) return { node_id: nodeId, discarded: false, detail: String(r.stderr ?? '').trim().split('\n')[0].slice(0, 300) || `exit ${r.status}` };
  try {
    const out = JSON.parse(String(r.stdout));
    return { node_id: nodeId, discarded: out.discarded === true, claim_id: out.claim_id ?? null, archived_ref: out.archived_ref ?? null, worktree: out.worktree ?? null };
  } catch {
    return { node_id: nodeId, discarded: false, detail: 'the discard answered no JSON' };
  }
}

/** A replay record that proves no second effect: an explicit answer, and the state readable and unchanged. */
function noSecondEffect(r) {
  const answered =
    (r.effect === 'receipt' && r.response === 'json' && r.idempotent === true) ||
    (r.effect === 'stale' && r.response === 'json' && r.outcome === 'STALE_ORCHESTRATION_EPOCH') ||
    (r.effect === 'refused' && r.response === 'refusal' && SPENT_CAPABILITY_REFUSALS.has(r.refusal_code));
  const unchanged = typeof r.state_before === 'string' && /^[0-9a-f]{64}$/.test(r.state_before) && r.state_after === r.state_before && r.state_changed === false;
  return answered && unchanged;
}

/** Verifier checks for the fault records of a run. */
export function inspectFaults({ repo, head, records }) {
  const { checks, check } = makeSection();
  for (const r of records) {
    const id =
      COMMIT_FAULTS.has(r.kind)
        ? `fault:${r.kind}:kept`
        : MYCELINK_ONLY.has(r.kind)
          ? `fault:${r.kind}:no-second-effect`
          : r.kind === 'interrupt-restart'
            ? 'fault:interrupt-restart:resumed'
            : `fault:${r.kind}`;
    if (!FAULT_KINDS.includes(r.kind)) {
      check(id, false, 'unknown fault kind');
    } else if (r.applied === false) {
      check(id, true, `not applied: ${r.detail ?? 'the trigger never fired'}`, { severity: 'warning' });
    } else if (COMMIT_FAULTS.has(r.kind)) {
      const problems = injectionProblems(repo, r);
      check(`fault:${r.kind}:bound`, problems.length === 0, problems.length ? `the record does not bind commit ${String(r.commit).slice(0, 12)}: ${problems.join('; ')}` : `commit ${r.commit.slice(0, 12)} is exactly the recorded injection (${r.changes.length} change(s))`);
      const kept = typeof r.commit === 'string' && /^[0-9a-f]{40}$/.test(r.commit) && gitOk(repo, ['merge-base', '--is-ancestor', r.commit, head]);
      check(id, kept, kept ? `injected commit ${r.commit.slice(0, 12)} is in the delivered history` : `injected commit ${String(r.commit).slice(0, 12)} was dropped from the delivered history (lost update)`);
    } else if (MYCELINK_ONLY.has(r.kind)) {
      const how = `${r.effect}${r.refusal_code ? ` ${r.refusal_code}` : ''} (exit ${r.exit}${r.signal ? `, ${r.signal}` : ''}${r.timed_out ? ', timed out' : ''}, outcome ${r.outcome ?? 'none'})`;
      const state = typeof r.state_before !== 'string' || typeof r.state_after !== 'string' ? 'unreadable' : r.state_changed === false && r.state_after === r.state_before ? 'unchanged' : 'changed';
      check(id, noSecondEffect(r), `replayed settle of ${r.node}: ${how}, state ${state}${r.detail ? `: ${r.detail}` : ''}`);
    } else {
      // A restart happened only where the record names the session the interrupt hit and the very next session,
      // of the same phase, started to resume it.
      const i = r.interrupted_session;
      const s = r.successor_session;
      const named = Number.isInteger(i?.index) && typeof i?.phase === 'string';
      const resumed = r.resumed === true && named && Number.isInteger(s?.index) && s.index === i.index + 1 && s.phase === i.phase;
      check(
        id,
        resumed,
        !named
          ? `the record names no interrupted session (${r.sessions ?? 0} session(s))`
          : resumed
            ? `session ${i.index} (${i.purpose}) was interrupted at ${r.at_seconds} s; session ${s.index} (${s.purpose}) resumed it and ended by ${s.ended_by}`
            : `session ${i.index} (${i.purpose}) was interrupted at ${r.at_seconds} s and no fresh ${i.phase} session resumed it${s ? ` (session ${s.index} is ${s.phase === i.phase ? 'not the next session' : `a ${s.phase} session`})` : ''}`,
      );
    }
  }
  return { checks };
}

/** The fault records of a run: its run.json (tools/run-arm.mjs) or a bare list. */
export function readFaultRecords(file) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const records = Array.isArray(doc) ? doc : doc?.faults;
  if (!Array.isArray(records)) throw new Error(`${file} holds no fault records`);
  return records;
}

/**
 * Commits a run's own records name as injected: for counting the agent's
 * commits while the run is in progress (the verdict uses boundInjections).
 */
export function recordedCommits(records = []) {
  return new Set(records.filter((r) => r.applied !== false && typeof r.commit === 'string').map((r) => r.commit));
}
