/**
 * Treatment arms: one Claude Code run of one case, end to end.
 *
 *   orchestration  without | with    `--plugin-dir <sealed package>` only with
 *   condition      normal  | faults  an evaluator fault plan applied around
 *                                    the sessions (lib/faults.mjs)
 *
 * Every run gets a fresh workspace, built from the frozen source by the
 * same code as the case's scaffold, and a fresh HOME. Each session runs
 * inside the isolation boundary (lib/isolation.mjs): only the workspace and
 * the HOME writable, the toolchain (and in the with arm the sealed plugin;
 * the without arm's sandbox holds no trace of it) read-only, no
 * network but the model proxy's allowlist — proved by a preflight from
 * inside before the first session, the run refused when it fails — and
 * nothing a session starts may outlive it (survivors are killed and refuse
 * the run). The plugin is the
 * release package of this checkout (no eval suite), sealed beside the run
 * with its hashes in run.json; fault replays and the verdict run that same
 * artifact's CLI, checked before and after. The task prompt is the
 * generated case prompt, byte for byte, in every arm; the follow-up prompts
 * of the fault condition (resume, QA rework) are built from it the same way
 * in both orchestration arms. Sessions run `claude -p` with the prompt on
 * stdin, the case's tools in `dontAsk` permission mode, a wall-clock budget
 * (print mode has no turn cap) and an optional cost cap; the invocation
 * differs between orchestration arms only by `--plugin-dir`, and the
 * sandbox only by the plugin's bind. A run in which a plugin reaches the
 * without arm anyway, or any other than the sealed one the with arm, fails
 * (`plugin_exposure`).
 *
 * A run has phases (runPhase): the task, then — when a late defect broke a
 * hidden check — QA's rework. An evaluator interrupt in either is followed
 * by a fresh session of that phase on the phase's own budget, until one ends
 * on its own; nothing is verified while a reported defect awaits its rework.
 * Mid-session triggers (first-commit, commits, elapsed-seconds) are polled
 * while a session runs, from the run's start or, with a `phase`, from that
 * phase's start and only while it runs; commits are counted on every local
 * branch of the project repository, injected ones excluded. A fault fires
 * once, and never into a session already being stopped. session-end faults
 * run after the task phase, in plan order. In every phase the with arm's
 * session is the controller alone, run as a transaction over the workspace
 * (lib/controller-txn.mjs, GUARDED_PHASES): snapshotted before it, checked
 * while it runs, and after it every change neither Mycelink's core (its
 * provenance ledger), a module-worker nor the reviewer made is the
 * controller's own — a violation, rolled back (or the whole session, when
 * Mycelink may have read it), verified, and the dispatches it reached into
 * discarded; a corrective session then starts on the clean workspace, at
 * most two per phase, an identical repeat ending it (CSET-203 r9).
 * The run ends with the authoritative verifier; run.json records the
 * sessions (with their phase and the session each resumes), the phases
 * (with, in the with arm, Mycelink's state bound to the delivery branch as
 * each left it), the fault records and the verdict, never evaluator content.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createAdapter } from './adapters/index.mjs';
import { reviewRevisions, reviewRevisionTrustProblems } from './revisions.mjs';
import { ALLOWED_TOOLS, casePrompt } from './cases.mjs';
import { loadEvaluator } from './evaluator.mjs';
import {
  MYCELINK_ONLY,
  continuationPrompt,
  correctivePrompt,
  discardDispatch,
  featureNextAction,
  providerInterruptDispatch,
  reviewerAwaitDispatch,
  providerResumePrompt,
  taskCorrectivePrompt,
  defectFailures,
  injectConcurrentCommit,
  injectLateDefect,
  lateDefectPatch,
  lateDefectPrompt,
  recordedCommits,
  replaySettles,
  resumeInjectionSync,
  resumePrompt,
  settleCommandsFromTranscript,
} from './faults.mjs';
import { git, pathKey, revParse, safeGit } from './git.mjs';
import { trustedOverrides } from './harness.mjs';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { findPrd, loadSuite, suiteRoot as defaultSuiteRoot } from './manifests.mjs';
import { loadToolchains } from './toolchain.mjs';
import { PLUGIN_SOURCE, buildPluginPackage, sealPlugin } from './plugin.mjs';
import { runHiddenTests, verifyDelivery } from './verify.mjs';
import { deliveryProblems, readRegistry } from './orchestration.mjs';
import { candidateRepositories } from '../../evals-multimodule/tools/verify-workspace.mjs';
import { REVIEWER_TYPES, answerForm, editScanner, finalAnswer, forbiddenAccess, loadedPlugins, pluginInvocations, rootForms, subagentMeta, transcriptFiles } from './transcripts.mjs';
export { answerForm, finalAnswer } from './transcripts.mjs';
import { agentPreflight, agentToolchain, reapSurvivors, sealedCacheBinds, sessionSandbox, trackNamespace } from './isolation.mjs';
import { PROVENANCE_ENV, attestRollbacks, beginTransaction, lightCheck, noteHarnessChange, settleTransaction } from './controller-txn.mjs';
import { DEFAULT_ALLOW, proxySummary, startModelProxy } from './model-proxy.mjs';
import { isolationRecord, start as startConfined } from './sandbox.mjs';
import { pinRecord } from './suite-pin.mjs';
import { sessionFailure } from './provider.mjs';
import { buildWorkspace } from './workspace.mjs';

export const ARMS = ['without', 'with'];


const MID_SESSION = new Set(['first-commit', 'commits', 'elapsed-seconds']);

/**
 * A run's phases: the task (and its resumptions), then QA's rework of a
 * late defect (and its resumptions). A mid-session trigger with a `phase`
 * counts its seconds and commits from that phase's start and fires only
 * while it runs; without one, from the run's start, in any session.
 */
const PHASES = ['task', 'rework'];

/** Polls a landed injection's working-tree sync is retried for before it is recorded as failed. */
const MAX_SYNC_ATTEMPTS = 60;
/** Polls an injection whose compare-and-swap lost a race is retried for. */
const MAX_INJECTION_ATTEMPTS = 5;

/** Semantic problems of a (schema-valid) fault plan. */
export function planProblems(plan) {
  const problems = [];
  for (const [i, f] of (plan?.faults ?? []).entries()) {
    const at = `faults[${i}] ${f.kind}`;
    if ((f.kind === 'interrupt-restart' || f.kind === 'concurrent-commit') && !MID_SESSION.has(f.trigger.on)) problems.push(`${at}: needs a mid-session trigger, not ${f.trigger.on}`);
    if (f.kind === 'late-hidden-defect' && f.trigger.on !== 'session-end') problems.push(`${at}: QA reports after the delivery: the trigger must be session-end`);
    if (f.trigger.on === 'commits' && !(f.trigger.count >= 1)) problems.push(`${at}: a commits trigger needs a count`);
    if (f.trigger.on === 'elapsed-seconds' && !(f.trigger.seconds >= 1)) problems.push(`${at}: an elapsed-seconds trigger needs seconds`);
    if (f.trigger.phase !== undefined && !MID_SESSION.has(f.trigger.on)) problems.push(`${at}: a phase scopes mid-session triggers only`);
    else if (f.trigger.phase !== undefined && !PHASES.includes(f.trigger.phase)) problems.push(`${at}: no phase ${f.trigger.phase} (${PHASES.join(' or ')})`);
  }
  return problems;
}

/** The claude arguments of a session (the prompt goes to stdin). */
export function claudeArgs({ plugin, pluginDir = null, model = null, maxBudgetUsd = null }) {
  if (plugin && !pluginDir) throw new Error('the plugin arm needs the sealed plugin directory');
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
    '--allowedTools',
    ALLOWED_TOOLS.join(','),
    ...(model ? ['--model', model] : []),
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []),
    ...(plugin ? ['--plugin-dir', pluginDir] : []),
  ];
}

/** The plugin directories `args` load. */
const pluginDirs = (args) => args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : a.startsWith('--plugin-dir=') ? [a.slice('--plugin-dir='.length)] : []));

/** Is `path` at or inside `root`? */
const under = (path, root) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Does `text` name a path in one of its spellings `needles` (as itself, not as the prefix of a longer name)? */
function names(text, needles) {
  for (const needle of needles) {
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
      if (!/[A-Za-z0-9_.-]/.test(text[i + needle.length] ?? '')) return true;
    }
  }
  return false;
}

/**
 * How a run lets a plugin in where its arm says none may be (empty: it
 * does not) — the run record's check, behind the sandbox that keeps the
 * package out of the without arm (lib/isolation.mjs). The with arm loads
 * the sealed package at `dir` once and nothing else. The without arm's
 * claude arguments name no plugin, its sandbox binds nothing at, inside or
 * above the package, and its transcripts (`files`: the sessions' and the
 * workers', their stderr) neither name the package nor reach it with a
 * tool, no session's init reports a plugin loaded from a directory, and no
 * command passes `--plugin-dir` (help text, prose and payloads that only
 * mention the option load nothing).
 */
export function pluginExposure({ arm, dir, args = [], binds = [], files = [], cwd = null, home = null }) {
  const loaded = pluginDirs(args);
  if (arm === 'with') {
    if (loaded.length === 0) return ['the with arm does not load the plugin'];
    if (loaded.length > 1 || loaded[0] !== dir) return [`the with arm loads only the sealed plugin ${dir}, not ${loaded.join(', ')}`];
    return [];
  }
  const problems = [];
  if (loaded.length || args.some((a) => a.includes(dir))) problems.push(`the without arm's claude arguments name --plugin-dir or the plugin package: ${args.join(' ')}`);
  for (const p of new Set(binds.flatMap((b) => [b.path, b.dest ?? b.path]))) {
    if (under(p, dir) || under(dir, p)) problems.push(`the without arm's sandbox binds ${p}, at or around the plugin package`);
  }
  const needles = [...new Set([dir, JSON.stringify(dir).slice(1, -1), ...rootForms(dir)])];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [i, line] of text.split('\n').entries()) if (names(line, needles)) problems.push(`${file}:${i + 1} names the plugin package`);
  }
  for (const p of pluginInvocations({ files })) problems.push(`${p.file}:${p.line} passes --plugin-dir (${p.tool}: ${p.command})`);
  for (const p of loadedPlugins({ files })) problems.push(`${p.file}:${p.line} loaded the plugin ${p.path}`);
  for (const hit of forbiddenAccess({ files, roots: [dir], cwd, home }).hits) problems.push(`${hit.file}:${hit.line} names the plugin package (${hit.tool} ${hit.path})`);
  return [...new Set(problems)];
}

/**
 * Verifier sections whose failure says the run's evidence cannot be
 * trusted (the inputs the verdict rests on, proof of evaluator leakage),
 * as opposed to sections that judge what the model delivered.
 */
const TRUST_SECTIONS = ['identity', 'leakage', 'integrity'];
const DELIVERY_SECTIONS = ['hygiene', 'scope', 'harness', 'regression', 'acceptance', 'tdd', 'orchestration', 'faults'];

/**
 * Why a run whose controller changed the workspace itself cannot be trusted
 * (empty: it can, or none did). Every session with a violation — on its
 * session record or in the controller report — must have its rollback
 * verified and attested after the run (`record.controller_rollbacks`,
 * lib/controller-txn.mjs attestRollbacks) under the manifest the record
 * names; what the attestation found is named. A verified rollback recorded
 * but never attested is not trusted.
 */
function rollbackTrustProblems(record) {
  const recorded = new Map();
  for (const s of record.sessions ?? []) {
    if (s.violation || s.controller_txn?.violation) recorded.set(s.index, { verified: s.violation?.verified === true && s.controller_txn?.rollback?.verified !== false, manifest: s.violation?.manifest_sha256 ?? s.controller_txn?.rollback?.manifest_sha256 ?? null });
  }
  for (const v of record.controller?.violations ?? []) {
    const r = recorded.get(v.session);
    recorded.set(v.session, { verified: (r?.verified ?? true) && v.verified === true, manifest: r?.manifest ?? v.manifest_sha256 ?? null });
  }
  if (recorded.size === 0) return [];
  const problems = [];
  const att = record.controller_rollbacks ?? null;
  for (const [session, r] of [...recorded].sort((a, b) => a[0] - b[0])) {
    if (!r.verified) problems.push(`controller rollback: session ${session}'s rollback was not verified`);
    const attested = (att?.sessions ?? []).find((x) => x.session === session);
    if (!attested || !r.manifest || attested.manifest_sha256 !== r.manifest) problems.push(`controller rollback: session ${session}'s rollback was never attested under the manifest the run recorded`);
  }
  if (att && att.ok !== true) problems.push(...(att.problems ?? []).map((p) => `controller rollback: ${p}`), ...((att.problems ?? []).length ? [] : ['controller rollback: the attestation failed']));
  return [...new Set(problems)];
}

/**
 * Why a run's recoveries from model-provider failures cannot be trusted
 * (empty: they can, or there were none; CSET-203 r10). Each recorded
 * recovery's failure is read again from its session's own transcript and
 * must be exactly the transient failure recorded (class, request id); each
 * resumed one names the session that continued it; no phase recovered more
 * than MAX_PROVIDER_RECOVERIES times, no ticket was resumed past
 * Mycelink's own bound (two per ticket); and no session resumed another as
 * a provider recovery that the record does not account for.
 */
export function providerTrustProblems(record) {
  const problems = [];
  const sessions = record.sessions ?? [];
  const recoveries = record.provider_recoveries ?? [];
  const byPhase = {};
  for (const r of recoveries) {
    byPhase[r.phase] = (byPhase[r.phase] ?? 0) + 1;
    const s = sessions.find((x) => x.index === r.session);
    if (!s) {
      problems.push(`provider recovery: session ${r.session} is not on the record`);
      continue;
    }
    let seen = null;
    try {
      seen = sessionFailure(readFileSync(s.transcript, 'utf8'), s.exit_code);
    } catch {
      seen = null;
    }
    const recorded = s.provider_failure ?? null;
    if (!seen || seen.transient !== true || seen.class !== r.class || (seen.request_id ?? null) !== (r.request_id ?? null) || !recorded || recorded.transient !== true || recorded.class !== r.class) {
      problems.push(`provider recovery: session ${r.session}'s transcript does not record the transient ${r.class} failure the run recovered from`);
    }
    if (r.outcome === 'resumed') {
      for (const i of r.reconciled?.interrupted ?? []) {
        if ((i.count?.ticket ?? 0) > MAX_PROVIDER_INTERRUPTIONS_PER_TICKET) problems.push(`provider recovery: session ${r.session} was resumed past a ticket interrupted ${i.count.ticket} times (at most ${MAX_PROVIDER_INTERRUPTIONS_PER_TICKET})`);
      }
      const next = sessions.find((x) => x.index === r.resumed_by);
      if (!next || next.resumes !== r.session || next.provider_recovery !== true) problems.push(`provider recovery: session ${r.session}'s recovery names no resume session that continued it`);
    }
  }
  for (const [phase, n] of Object.entries(byPhase)) {
    if (n > MAX_PROVIDER_RECOVERIES) problems.push(`provider recovery: the ${phase} phase recovered from the model provider ${n} times, more than ${MAX_PROVIDER_RECOVERIES}`);
  }
  for (const s of sessions) {
    if (s.provider_recovery === true && !recoveries.some((r) => r.resumed_by === s.index && r.outcome === 'resumed')) problems.push(`provider recovery: session ${s.index} resumed session ${s.resumes} on no recorded provider failure`);
  }
  return [...new Set(problems)];
}

const REVIEWER_SUBAGENTS = new Set(['mycelink:acceptance-reviewer', 'acceptance-reviewer']);
const hashId = (id) => (typeof id === 'string' && id !== '' ? sha256Hex(id) : null);
const short = (h) => (typeof h === 'string' ? h.slice(0, 12) : 'unknown');
/** Slack between Claude Code's own end of a task and Mycelink's reading of its records. */
const LIFECYCLE_SLACK_MS = 5_000;

/** A reviewer's standing as a run record keeps it (feature status `next_action.reviewer`): by hash only, never its prompt or answer. */
export function reviewerBrief(v) {
  return v ? { review_id: v.review_id ?? null, dispatch_id: v.dispatch_id ?? null, state: v.state ?? null, task_sha256: v.task_sha256 ?? null, agent_id_sha256: v.agent_id_sha256 ?? null, elapsed_ms: v.elapsed_ms ?? null, remaining_ms: v.remaining_ms ?? null, timeout_ms: v.timeout_ms ?? null } : null;
}

/**
 * Every acceptance-reviewer Agent task the run's sessions started, as the
 * harness saw it in their own stream-json output — Claude Code's task
 * events, which no model writes: `task_started` (the Agent call, the
 * subagent type), `task_notification` and `task_updated` (its end, its
 * status, when) — beside what Mycelink recorded of each (its review events:
 * an answer ingested, a reviewer interrupted). By hash only: the task (the
 * Agent call's id) and the agent. `streamed`: the sessions' streams carry
 * task events at all (a Claude Code that emits them).
 */
export function reviewerLifecycle({ sessions, events }) {
  const tasks = [];
  const byAgent = new Map();
  let streamed = false;
  for (const s of sessions ?? []) {
    let text;
    try {
      text = readFileSync(s.transcript, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"task_')) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.type !== 'system' || typeof e.task_id !== 'string') continue;
      if (e.subtype === 'task_started' && REVIEWER_SUBAGENTS.has(String(e.subagent_type))) {
        streamed = true;
        const t = { session: s.index, task_sha256: hashId(e.tool_use_id), agent_id_sha256: hashId(e.task_id), status: null, ended_at: null };
        tasks.push(t);
        byAgent.set(e.task_id, t);
      } else if ((e.subtype === 'task_notification' || e.subtype === 'task_updated') && byAgent.has(e.task_id)) {
        const t = byAgent.get(e.task_id);
        const status = e.subtype === 'task_notification' ? e.status : e.patch?.status;
        if (typeof status === 'string') t.status = status;
        if (e.subtype === 'task_updated' && Number.isFinite(e.patch?.end_time)) t.ended_at = new Date(e.patch.end_time).toISOString();
      }
    }
  }
  const of = (type) => (events ?? []).filter((e) => e.type === type);
  return {
    streamed,
    tasks,
    ingested: of('review.ingested').map((e) => ({ review_id: e.data?.review_id ?? null, dispatch_id: e.data?.dispatch_id ?? null, outcome: e.data?.outcome ?? null, task_sha256: hashId(e.data?.tool_use_id), agent_id_sha256: hashId(e.data?.agent_id), at: e.ts ?? null })),
    interrupted: of('review.reviewer_interrupted').map((e) => ({ review_id: e.data?.review_id ?? null, dispatch_id: e.data?.dispatch_id ?? null, reason: e.data?.reason ?? null, status: e.data?.status ?? null, task_sha256: e.data?.task_sha256 ?? null, agent_id_sha256: e.data?.agent_id_sha256 ?? null, elapsed_ms: e.data?.elapsed_ms ?? null, timeout_ms: e.data?.timeout_ms ?? null, at: e.ts ?? null })),
  };
}

/**
 * Why the run's account of its acceptance reviewers' lifecycles cannot be
 * trusted (CSET-203 r13): Mycelink's record of each — an answer taken, a
 * reviewer interrupted — checked against Claude Code's own record of the
 * task in the session's stream, which no model writes. An answer taken from
 * a reviewer whose task never completed, or that no session launched; an
 * interruption for its wall-clock before its wall-clock, or of one that had
 * completed; a lost host whose session had not ended; an ended task whose
 * stream says otherwise — each is a forged or wrong lifecycle. Streams with
 * no task events (an older Claude Code) attest nothing and are not judged.
 */
export function reviewerLifecycleTrustProblems(record) {
  const l = record.reviewer_lifecycle;
  if (!l || l.streamed !== true) return [];
  const problems = [];
  const sessions = record.sessions ?? [];
  const taskOf = (x) => l.tasks.find((t) => (x.task_sha256 !== null && t.task_sha256 === x.task_sha256) || (x.agent_id_sha256 !== null && t.agent_id_sha256 === x.agent_id_sha256)) ?? null;
  const before = (a, b) => a !== null && b !== null && Date.parse(a) + LIFECYCLE_SLACK_MS < Date.parse(b);
  for (const i of l.ingested) {
    const t = taskOf(i);
    if (t === null) problems.push(`reviewer lifecycle: Mycelink took an answer of ${i.review_id} from a reviewer (agent ${short(i.agent_id_sha256)}) no session's stream launched`);
    else if (t.status !== 'completed') problems.push(`reviewer lifecycle: Mycelink took the answer of ${i.review_id}'s reviewer (agent ${short(i.agent_id_sha256)}), but session ${t.session}'s stream records no completion of it (${t.status ?? 'still running'})`);
  }
  for (const i of l.interrupted) {
    const t = taskOf(i);
    if (t === null) {
      problems.push(`reviewer lifecycle: Mycelink interrupted a reviewer of ${i.review_id} (task ${short(i.task_sha256)}) no session's stream launched`);
      continue;
    }
    if (i.reason === 'timeout' && !(Number(i.elapsed_ms) >= Number(i.timeout_ms))) problems.push(`reviewer lifecycle: ${i.review_id}'s reviewer (task ${short(i.task_sha256)}) was interrupted for its wall-clock after ${i.elapsed_ms} ms of ${i.timeout_ms}`);
    if ((i.reason === 'timeout' || i.reason === 'host-ended') && t.status === 'completed' && before(t.ended_at, i.at)) problems.push(`reviewer lifecycle: ${i.review_id}'s reviewer (task ${short(i.task_sha256)}) was interrupted (${i.reason}) after its session's stream records it completed`);
    if (i.reason === 'host-ended') {
      const s = sessions.find((x) => x.index === t.session);
      if (!s || typeof s.ended_at !== 'string' || before(i.at, s.ended_at)) problems.push(`reviewer lifecycle: ${i.review_id}'s reviewer (task ${short(i.task_sha256)}) was interrupted as lost with its host session ${t.session}, which had not ended`);
    }
    if (i.reason === 'ended' && t.status !== i.status) problems.push(`reviewer lifecycle: ${i.review_id}'s reviewer (task ${short(i.task_sha256)}) was interrupted as ended ${i.status}, but its session's stream says ${t.status ?? 'it never ended'}`);
  }
  return [...new Set(problems)];
}

/**
 * Whether a run is `ok`: the verifier's verdict, no evaluator access, no
 * plugin exposure, no survivor, every controller violation's rollback
 * verified and attested (rollbackTrustProblems), every recovery from a
 * model-provider failure attested and bounded (providerTrustProblems), and
 * every reviewer lifecycle attested by Claude Code's own records
 * (reviewerLifecycleTrustProblems), and every review revision and rebased
 * order proved by the control repository's own files (lib/revisions.mjs).
 */
export function runOk({ record, verification }) {
  const survivors = (record.sessions ?? []).flatMap((s) => s.survivors ?? []);
  return Boolean(verification?.ok) && (record.evaluator_access?.hits ?? []).length === 0 && (record.plugin_exposure ?? []).length === 0 && survivors.length === 0 && rollbackTrustProblems(record).length === 0 && providerTrustProblems(record).length === 0 && reviewerLifecycleTrustProblems(record).length === 0 && reviewRevisionTrustProblems(record).length === 0;
}

/**
 * A run's verdict, its evidence apart from its delivery: `{ verdict, trust:
 * { ok, problems }, delivery: { ok, failures } }`. Trust fails when a
 * session ran outside a proved boundary, left a survivor, reached
 * evaluator roots or the plugin where it may not, or when the verdict
 * itself cannot be relied on (not trusted, an error, a broken input, proof
 * of leakage). Delivery fails for what the model delivered — scope,
 * regression, acceptance, TDD, orchestration, faults, as the verdict
 * required them. `verdict` is 'untrusted', else 'verified' or
 * 'delivery-failed'. Warnings fail neither. Nothing here relaxes a gate:
 * the run's `ok` is still the verifier's verdict and the transcript checks.
 */
export function runVerdict({ record, verification }) {
  const problems = [];
  const isolation = record.isolation ?? {};
  if (isolation.kind !== 'bubblewrap' || isolation.enforced !== true) problems.push('sessions ran outside the isolation boundary');
  else if (isolation.preflight?.ok !== true) problems.push(`the isolation preflight failed: ${(isolation.preflight?.checks ?? []).filter((c) => !c.ok).map((c) => c.id).join(', ') || 'not run'}`);
  if ((record.sessions ?? []).some((s) => !s.confined)) problems.push('a session ran unconfined');
  if (record.arm === 'with' && record.controller_guard === false) problems.push('the with arm ran without its controller guard: what the controller changed itself was neither checked nor rolled back');
  problems.push(...rollbackTrustProblems(record));
  problems.push(...providerTrustProblems(record));
  problems.push(...reviewerLifecycleTrustProblems(record));
  problems.push(...reviewRevisionTrustProblems(record));
  const survivors = (record.sessions ?? []).flatMap((s) => s.survivors ?? []);
  if (survivors.length) problems.push(`a process outlived its session: ${survivors.map((s) => s.cmd ?? s.pid).slice(0, 3).join(', ')}`);
  const hits = record.evaluator_access?.hits ?? [];
  if (hits.length) problems.push(`evaluator access: ${hits.slice(0, 3).map((h) => `${h.file}:${h.line} (${h.tool} ${h.path})`).join('; ')}`);
  if ((record.plugin_exposure ?? []).length) problems.push(`plugin exposure: ${record.plugin_exposure.slice(0, 3).join('; ')}`);
  const failing = (name, s) => (s?.checks ?? []).filter((c) => !c.ok && c.severity !== 'warning').map((c) => `${name}:${c.id}${c.detail ? ` (${String(c.detail).slice(0, 160)})` : ''}`);
  const failures = [];
  if (!verification) problems.push('no verification');
  else {
    if ((verification.errors ?? []).length) problems.push(`the verifier failed: ${String(verification.errors[0]).split('\n')[0].slice(0, 200)}`);
    if (verification.trusted !== true) {
      const why = Object.entries(verification.trust ?? {}).filter(([, v]) => !v).map(([k]) => k);
      problems.push(`the verification is not trusted: ${why.join(', ') || 'no trust record'}`);
    }
    for (const name of TRUST_SECTIONS) {
      const s = verification.sections?.[name];
      if (s && s.ok !== true) problems.push(...(failing(name, s).length ? failing(name, s) : [`${name} failed`]));
    }
    for (const name of DELIVERY_SECTIONS) {
      const s = verification.sections?.[name];
      if (!s || s.ok === true) continue;
      if (name === 'tdd') {
        if (!s.required) continue;
        const verdicts = (s.units ?? []).filter((u) => !u.ok).map((u) => u.verdict);
        const injections = (s.injections ?? []).filter((x) => !x.ok).map((x) => `tdd:injection:${x.kind} (${String(x.detail ?? '').slice(0, 160)})`);
        if (verdicts.length || !injections.length) failures.push(`tdd:${verdicts.join(',') || 'no units'}`);
        failures.push(...injections);
      } else if (name === 'orchestration') {
        if (s.required) failures.push(...(failing(name, s).length ? failing(name, s) : ['orchestration: no evidence']));
      } else failures.push(...(failing(name, s).length ? failing(name, s) : [`${name} failed`]));
    }
  }
  // A feature never initialised after the harness rolled a controller's own changes back is said so (CSET-203 r9), not only counted.
  const rolled = (record.controller?.violations ?? []).map((v) => v.session);
  if (rolled.length > 0) {
    for (const [i, f] of failures.entries()) {
      const m = /^orchestration:feature-initialised \((.*)\)$/.exec(f);
      if (m) failures[i] = `orchestration:feature-initialised (${m[1]}; the controller’s own changes were rolled back in session ${rolled.join(', ')} and the feature was never initialised after them)`;
    }
  }
  // A with arm whose session exited 0 with the feature incomplete failed as a controller, whatever the verifier saw.
  failures.unshift(...(record.controller?.failures ?? []).map((x) => `controller:${x}`));
  // The model provider ended the run: an authentication or billing failure (never retried), or failures past their bounds.
  const provider = record.provider ?? null;
  if (provider?.unavailable) failures.unshift(`provider:unavailable: the model provider failed a phase past its bounds (${provider.recoveries} recover${provider.recoveries === 1 ? 'y' : 'ies'} made): PROVIDER_UNAVAILABLE`);
  if (provider?.permanent) failures.unshift(`provider:permanent: session ${provider.permanent.session} (${provider.permanent.purpose}) ended on ${provider.permanent.class}${provider.permanent.status !== null ? ` (status ${provider.permanent.status})` : ''}: an authentication or billing failure is not retried`);
  const trustOk = problems.length === 0;
  const deliveryOk = Boolean(verification?.ok) && failures.length === 0;
  // A violation a corrective session recovered is no failure, and is never dropped either.
  const recovered = record.controller?.recovered ?? [];
  return { verdict: !trustOk ? 'untrusted' : deliveryOk ? 'verified' : 'delivery-failed', trust: { ok: trustOk, problems }, delivery: { ok: deliveryOk, failures, ...(recovered.length ? { recovered } : {}) } };
}

/**
 * What each worker the run's sessions started did, from its transcript
 * (Claude Code keeps them under `subagents/`): its tool calls, the TDD
 * gates it ran, and the outcome of the node result it wrote, if any.
 */
export function workerSummaries(files, events = []) {
  // The last settle of each claim, from the feature's event log.
  const settled = new Map();
  for (const e of events) if (e?.type === 'node.settled' && typeof e.data?.claim_id === 'string') settled.set(e.data.claim_id, e.data.outcome ?? null);
  return files
    .filter((f) => /[\\/]subagents[\\/]/.test(f))
    .map((file) => {
      const summary = { transcript: file, node_id: null, claim_id: null, dispatch_id: null, settlement: null, tool_uses: 0, gates: { red: 0, green: 0, regression: 0 }, outcome: null };
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return summary;
      }
      for (const line of text.split('\n')) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        // The ticket prompt names the node, claim and dispatch the worker was given.
        const prompt = typeof event?.message?.content === 'string' ? event.message.content : event?.type === 'user' && Array.isArray(event.message?.content) ? event.message.content.map((p) => p?.text ?? '').join('\n') : '';
        if (summary.node_id === null && event?.type === 'user' && /^Node: \S+$/m.test(prompt)) {
          summary.node_id = /^Node: (\S+)$/m.exec(prompt)[1];
          summary.claim_id = /^Claim: (\S+)$/m.exec(prompt)?.[1] ?? null;
          summary.dispatch_id = /^Dispatch: (\S+)$/m.exec(prompt)?.[1] ?? null;
        }
        for (const part of Array.isArray(event?.message?.content) ? event.message.content : []) {
          if (part?.type !== 'tool_use') continue;
          summary.tool_uses += 1;
          const command = typeof part.input?.command === 'string' ? part.input.command : '';
          for (const m of command.matchAll(/\btdd (red|green|regression)\b/g)) summary.gates[m[1]] += 1;
          if (part.name === 'Write' && /\.mycelink-worker[\\/]result/.test(String(part.input?.file_path ?? ''))) {
            try {
              summary.outcome = JSON.parse(part.input.content).outcome ?? null;
            } catch {
              // not a result
            }
          }
        }
      }
      if (summary.claim_id !== null) summary.settlement = settled.get(summary.claim_id) ?? null;
      return summary;
    })
    // An acceptance reviewer's transcript is no worker's (reviewerSummaries): by its brief, its meta, or its messages' attribution.
    .filter((s) => s.node_id !== null || (reviewIdentity(firstUserText(s.transcript)) === null && !isReviewerTranscript(s.transcript)));
}

/** A reviewer brief's identity lines: `Acceptance review: <id>`, `Dispatch: <id>`, and `Format correction <n> of <m>` for a corrective generation. */
function reviewIdentity(text) {
  const review = /^Acceptance review: (\S+)$/m.exec(text ?? '')?.[1] ?? null;
  if (review === null) return null;
  const correction = /^Format correction (\d+) of \d+/m.exec(text)?.[1];
  const refinement = /^Refinement round (\d+) of \d+/m.exec(text)?.[1];
  return { review_id: review, dispatch_id: /^Dispatch: (\S+)$/m.exec(text)?.[1] ?? null, correction: correction === undefined ? null : Number(correction), refinement: refinement === undefined ? null : Number(refinement) };
}

const messageText = (event) => (typeof event?.message?.content === 'string' ? event.message.content : Array.isArray(event?.message?.content) ? event.message.content.map((p) => p?.text ?? (typeof p?.content === 'string' ? p.content : '')).join('\n') : '');

const VERDICT_PATH = /\.mycelink[\\/]reviews[\\/][^\\/]+[\\/]([^\\/]+)[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]verdict\.json$/;

/**
 * What each acceptance-reviewer subagent did, apart from the workers (the
 * plugin's treatment in the with arm): which review and generation it was
 * given, its tool calls and the ones the fence refused, the verdict it
 * wrote (overall and per criterion), the model and token usage of its own
 * messages, how its verdict reached the controller and how the controller
 * settled it (the feature's events). From the subagents' own transcripts —
 * a reviewer's by its brief, its meta's agent type, or the attribution of
 * its messages (a host that gave it a pointer to its brief, as r8's did) —
 * and, for a reviewer with no transcript of its own, from the host stream
 * (an Agent call for `mycelink:acceptance-reviewer` and the messages that
 * carry its id); never both for one reviewer. The verdict's hash as the
 * transcript wrote it sits beside the original and canonical hashes settle
 * recorded and the prose it cut (CSET-203 r5); a refusal says whether a
 * correction mends it, and a corrective generation which one it is. Its
 * final answer's form (`json`, `fenced-json`, `prose`) and hash, its
 * transcript's hash, and the transport: settle's account of it (`file`,
 * `agent-result`, `both`), else what the transcript shows (CSET-203 r8).
 */
export function reviewerSummaries(files, events = []) {
  const settled = new Map();
  /** agent id -> the generation the controller took its verdict for (ingest, settle, refusal). */
  const agents = new Map();
  for (const e of events) {
    const d = e?.data ?? {};
    if (['review.ingested', 'review.settled', 'review.refused'].includes(e?.type) && typeof d.agent_id === 'string' && typeof d.dispatch_id === 'string') agents.set(d.agent_id, { review_id: d.review_id ?? null, dispatch_id: d.dispatch_id });
    const transport = d.transport !== undefined ? { transport: d.transport ?? null, ...(d.result_sha256 !== undefined ? { result_sha256: d.result_sha256 ?? null, transcript_sha256: d.transcript_sha256 ?? null } : {}) } : {};
    if (e?.type === 'review.settled' && typeof d.dispatch_id === 'string') {
      settled.set(d.dispatch_id, {
        outcome: d.outcome ?? null,
        overall: d.overall ?? null,
        code: null,
        receipt_path: d.receipt_path ?? null,
        ...(d.verdict_sha256 !== undefined ? { verdict_sha256: d.verdict_sha256, canonical_verdict_sha256: d.canonical_verdict_sha256 ?? null, normalized: Array.isArray(d.normalized) ? d.normalized : [] } : {}),
        ...(d.refinement ? { refinement: { round: d.refinement.round ?? null, decisions: (d.refinement.decisions ?? []).map((x) => ({ challenge_id: x.challenge_id, criterion: x.criterion, decision: x.decision })) } } : {}),
        ...transport,
      });
    }
    if (e?.type === 'review.refused' && typeof d.dispatch_id === 'string') {
      settled.set(d.dispatch_id, {
        outcome: 'REVIEW_INVALID',
        overall: null,
        code: d.code ?? null,
        receipt_path: null,
        ...(d.kind !== undefined ? { kind: d.kind, corrections_used: d.corrections_used ?? null, problems: (d.problems ?? []).map((p) => p?.pointer).filter((p) => typeof p === 'string'), verdict_sha256: d.verdict_sha256 ?? null } : {}),
        ...transport,
      });
    }
  }
  const summaries = new Map();
  const summaryOf = (key, identity, transcript) => {
    if (!summaries.has(key)) {
      summaries.set(key, {
        transcript,
        review_id: identity.review_id,
        dispatch_id: identity.dispatch_id,
        correction: identity.correction ?? null,
        refinement: identity.refinement ?? null,
        agent_id: identity.agent_id ?? null,
        models: [],
        tool_uses: 0,
        blocked: 0,
        verdict: null,
        written_verdict_sha256: null,
        answer: null,
        result_sha256: null,
        transcript_sha256: null,
        transport: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        cost_usd: null,
        settlement: null,
      });
    }
    return summaries.get(key);
  };
  const take = (s, event) => {
    const message = event?.message;
    if (event?.type === 'assistant' && message) {
      if (typeof message.model === 'string' && !s.models.includes(message.model)) s.models.push(message.model);
      for (const k of Object.keys(s.usage)) if (Number.isFinite(message.usage?.[k])) s.usage[k] += message.usage[k];
    }
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === 'tool_use') {
        s.tool_uses += 1;
        if (part.name === 'Write' && /verdict\.json$/.test(String(part.input?.file_path ?? ''))) {
          try {
            const v = JSON.parse(part.input.content);
            // As the fence attests it and settle records it: the canonical JSON of what was written.
            s.written_verdict_sha256 = sha256Hex(canonicalJson(v));
            s.verdict = verdictOf(v);
          } catch {
            // not a verdict
          }
        }
      }
      if (part?.type === 'tool_result' && part.is_error === true && /Blocked/.test(typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? ''))) s.blocked += 1;
    }
  };
  /** The final answer, as a verdict when it is one, beside what the transcript wrote. */
  const answered = (s, text) => {
    s.answer = answerForm(text);
    s.result_sha256 = text === null ? null : sha256Hex(text);
    if (s.verdict === null && (s.answer === 'json' || s.answer === 'fenced-json')) {
      try {
        const t = text.trim();
        s.verdict = verdictOf(JSON.parse(t.startsWith('{') ? t : t.replace(/^```json[ \t]*\r?\n/i, '').replace(/\r?\n[ \t]*```$/, '')));
      } catch {
        // not a verdict
      }
    }
  };
  const read = (file) => {
    try {
      const bytes = readFileSync(file);
      const parsed = bytes
        .toString('utf8')
        .split('\n')
        .flatMap((l) => {
          try {
            return l.trim() ? [JSON.parse(l)] : [];
          } catch {
            return [];
          }
        });
      return { bytes, parsed };
    } catch {
      return null;
    }
  };

  // A subagent's own transcript first: a reviewer's by its brief, its meta, or its messages' attribution.
  const covered = new Set();
  /** Each summary's start: its own transcript's first timestamp. */
  const started = new Map();
  for (const file of files.filter((f) => /[\\/]subagents[\\/]/.test(f))) {
    const t = read(file);
    if (t === null) continue;
    const { bytes, parsed } = t;
    const meta = subagentMeta(file);
    const brief = reviewIdentity(messageText(parsed.find((e) => e?.type === 'user')));
    const reviewer = brief !== null || REVIEWER_TYPES.has(meta?.agentType) || parsed.some((e) => e?.type === 'assistant' && REVIEWER_TYPES.has(e.attributionAgent));
    if (!reviewer) continue;
    const agentId = parsed.find((e) => typeof e?.agentId === 'string')?.agentId ?? /agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(file)?.[1] ?? null;
    // A brief it was only pointed at: the generation the controller took its verdict for, the verdict file it wrote, or the brief it read.
    const read_ = parsed.flatMap((e) => (Array.isArray(e?.message?.content) ? e.message.content : [])).filter((p) => p?.type === 'tool_result').map((p) => (typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? '')));
    const wrote = parsed.flatMap((e) => (Array.isArray(e?.message?.content) ? e.message.content : [])).map((p) => (p?.type === 'tool_use' && p.name === 'Write' ? VERDICT_PATH.exec(String(p.input?.file_path ?? '')) : null)).find((m) => m !== null);
    const readBrief = read_.map((text) => reviewIdentity(text.replace(/^\s*\d+\t/gm, ''))).find((x) => x !== null);
    const fromEvents = agentId !== null ? agents.get(agentId) : undefined;
    const identity = brief ?? (fromEvents ? { review_id: fromEvents.review_id, dispatch_id: fromEvents.dispatch_id, ...(readBrief ? { correction: readBrief.correction, refinement: readBrief.refinement } : {}) } : wrote ? { review_id: wrote[1], dispatch_id: wrote[2] } : readBrief ?? { review_id: null, dispatch_id: null });
    const s = summaryOf(identity.dispatch_id ?? file, { ...identity, agent_id: agentId }, file);
    for (const e of parsed) take(s, e);
    answered(s, finalAnswer(parsed));
    s.transcript_sha256 = sha256Hex(bytes);
    started.set(s, parsed.find((e) => typeof e?.timestamp === 'string')?.timestamp ?? null);
    if (identity.dispatch_id) covered.add(identity.dispatch_id);
  }
  // The host stream: the reviewer's Agent call, and every message carrying its id — for a reviewer with no transcript of its own.
  for (const file of files.filter((f) => !/[\\/]subagents[\\/]/.test(f))) {
    const t = read(file);
    if (t === null) continue;
    const reviewers = new Map();
    const streamed = new Map();
    for (const e of t.parsed) {
      for (const part of Array.isArray(e?.message?.content) ? e.message.content : []) {
        if (part?.type === 'tool_use' && part.name === 'Agent' && /acceptance-reviewer$/.test(String(part.input?.subagent_type ?? ''))) {
          const identity = reviewIdentity(part.input?.prompt);
          if (identity !== null && !(identity.dispatch_id && covered.has(identity.dispatch_id))) reviewers.set(part.id, identity);
        }
      }
      const id = e?.parent_tool_use_id;
      if (typeof id === 'string' && reviewers.has(id)) {
        const identity = reviewers.get(id);
        take(summaryOf(identity.dispatch_id ?? id, identity, file), e);
        streamed.set(id, [...(streamed.get(id) ?? []), e]);
      }
    }
    for (const [id, identity] of reviewers) {
      const s = summaryOf(identity.dispatch_id ?? id, identity, file);
      if (streamed.has(id)) answered(s, finalAnswer(streamed.get(id)));
    }
  }
  // In the order they ran (each transcript's first entry), when every reviewer's own transcript says; else as found.
  const all = [...summaries.values()];
  const ordered = all.every((s) => typeof started.get(s) === 'string') ? [...all].sort((a, b) => (started.get(a) < started.get(b) ? -1 : started.get(a) > started.get(b) ? 1 : 0)) : all;
  return ordered.map((s) => {
    const settlement = s.dispatch_id ? (settled.get(s.dispatch_id) ?? null) : null;
    const shown = s.written_verdict_sha256 !== null ? (s.answer === 'json' || s.answer === 'fenced-json' ? 'both' : 'file') : s.answer === 'json' || s.answer === 'fenced-json' ? 'agent-result' : null;
    return { ...s, transport: settlement?.transport ?? shown, settlement };
  });
}

/** A verdict's summary: overall, and per criterion its verdict, confidence and reproduction (a refinement: its decisions). */
function verdictOf(v) {
  return {
    overall: v.overall ?? null,
    criteria: (v.criteria ?? []).map((c) => ({ criterion: c.criterion, verdict: c.verdict, confidence: c.confidence ?? null, reproduction: c.gap?.reproduction ?? null })),
    ...(Array.isArray(v.decisions) ? { decisions: v.decisions.map((d) => ({ challenge_id: d.challenge_id ?? null, criterion: d.criterion ?? null, decision: d.decision ?? null, reproduction: d.gap?.reproduction ?? null })) } : {}),
  };
}

/** A subagent transcript of the acceptance reviewer, by its meta's agent type or its messages' attribution (Claude Code 2.1.290). */
function isReviewerTranscript(file) {
  if (REVIEWER_TYPES.has(subagentMeta(file)?.agentType)) return true;
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .some((l) => {
        try {
          const e = JSON.parse(l);
          return e?.type === 'assistant' && REVIEWER_TYPES.has(e.attributionAgent);
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/** The first user message of a transcript file. */
function firstUserText(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      try {
        const e = JSON.parse(line);
        if (e?.type === 'user') return messageText(e);
      } catch {
        // not JSON
      }
    }
  } catch {
    // unreadable
  }
  return '';
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
}

/**
 * What Mycelink recorded for a with arm's feature: whether it was complete
 * (every node DONE, a current candidate, its accepted delivery), why not,
 * the histories settle refused, the settlements a later session finished,
 * and whether a controller key was recovered. Null without a feature state.
 * Given the project repository and its delivery branch, complete also means
 * that the candidate binds exactly the branch's head and that its accepted
 * delivery delivered exactly that commit (orchestration.mjs
 * deliveryProblems): a candidate the branch has moved past — a late defect
 * landed on it after the delivery — is stale, whatever STATE.json says.
 */
export function mycelinkSummary({ control, featureId, repo = null, branch = null }) {
  const featureDir = join(control, 'features', featureId);
  const authorityRecovered = () => {
    try {
      return JSON.parse(readFileSync(join(control, '.mycelink', 'controller-authority.json'), 'utf8')).recovered === true;
    } catch {
      return false;
    }
  };
  let state;
  try {
    state = JSON.parse(readFileSync(join(featureDir, 'STATE.json'), 'utf8')).data;
  } catch {
    // A control repository whose feature was never initialised (CSET-203 r9) says so; no control repository is no Mycelink run.
    if (!existsSync(join(control, 'mycelink.config.json'))) return null;
    return { feature_id: featureId, initialised: false, complete: false, candidate: null, incomplete: ['the feature was never initialised: no STATE.json'], tdd_rejections: [], resumed_settlements: [], authority_recovered: authorityRecovered() };
  }
  if (!state || typeof state !== 'object') return null;
  const incomplete = [];
  for (const [id, rt] of Object.entries(state.nodes ?? {})) if (rt?.state !== 'DONE' && rt?.state !== 'EXCLUDED') incomplete.push(`node ${id} is ${rt?.state}`);
  const candidate = state.current_candidate ?? null;
  if (candidate === null) incomplete.push('no current candidate');
  if (candidate === null || !state.accepted_deliveries?.[candidate] || state.feature_state !== 'COMPLETED') incomplete.push('no accepted delivery');
  let bound = null;
  if (repo !== null && branch !== null) {
    const head = revParse(repo, `refs/heads/${branch}`);
    const name = readRegistry(control).repos.find((r) => pathKey(r.path) === pathKey(repo))?.name ?? null;
    const file = candidate === null ? null : join(featureDir, 'candidates', `${candidate}.yaml`);
    const sha = name !== null && file !== null && existsSync(file) ? (candidateRepositories(readFileSync(file, 'utf8'))[name]?.sha ?? null) : null;
    bound = { candidate_sha: sha, branch_head: head };
    const short = (x) => (x ? x.slice(0, 12) : 'nothing');
    if (name === null) incomplete.push(`the project repository is not registered in ${control}`);
    else if (candidate !== null && sha !== head) incomplete.push(`candidate ${candidate} binds ${name} at ${short(sha)}, ${branch} is at ${short(head)}`);
    else if (candidate !== null) for (const p of deliveryProblems({ root: control, featureId, state, repository: name, candidateSha: sha, deliveredHead: head })) incomplete.push(`delivery of ${candidate}: ${p}`);
  }
  const events = readJsonl(join(featureDir, 'events.jsonl'));
  const recovered = authorityRecovered();
  return {
    feature_id: featureId,
    initialised: true,
    complete: incomplete.length === 0,
    candidate,
    ...(bound ?? {}),
    incomplete,
    tdd_rejections: events.filter((e) => e.type === 'node.tdd_rejected').map((e) => ({ node_id: e.node_id ?? null, code: e.data?.code ?? null, commit: e.data?.commit ?? null })),
    resumed_settlements: events.filter((e) => e.type === 'settlement.resumed').map((e) => ({ node_id: e.node_id ?? null, from_state: e.data?.from_state ?? null, by: e.data?.by ?? null })),
    authority_recovered: recovered,
  };
}

/**
 * What a continuation must move for its session to count as progress: each
 * node's state, attempts, claim, integration and gate outputs, the
 * feature's state, candidate, reviews and deliveries, and the delivery
 * branch's head. Timestamps and the controller key are left out: a session
 * that only recovered the key and read the status changed nothing.
 */
export function progressDigest(control, featureId, repo = null, branch = null) {
  let state = null;
  try {
    state = JSON.parse(readFileSync(join(control, 'features', featureId, 'STATE.json'), 'utf8')).data;
  } catch {
    state = null;
  }
  const nodes = Object.entries(state?.nodes ?? {}).map(([id, rt]) => [
    id,
    rt?.state ?? null,
    rt?.attempts ?? null,
    rt?.claim?.claim_id ?? null,
    rt?.claim?.dispatch_id ?? null,
    rt?.integrated_sha ?? null,
    Object.entries(rt?.evidence ?? {}).map(([k, e]) => [k, e?.output_sha256 ?? null]),
    (rt?.rework_history ?? []).length,
  ]);
  const head = repo !== null && branch !== null ? revParse(repo, `refs/heads/${branch}`) : null;
  return sha256Hex(
    JSON.stringify({
      feature_state: state?.feature_state ?? null,
      candidate: state?.current_candidate ?? null,
      deliveries: Object.keys(state?.accepted_deliveries ?? {}),
      reviews: (state?.acceptance_review?.reviews ?? []).length,
      open_review: state?.acceptance_review?.open?.review_id ?? null,
      nodes,
      head,
    }),
  );
}

/** The feature's event log, for the worker summaries. */
export function mycelinkEvents({ control, featureId }) {
  return readJsonl(join(control, 'features', featureId, 'events.jsonl'));
}

/**
 * Phases whose with-arm sessions run as transactions over the workspace
 * (lib/controller-txn.mjs): every phase. The fourth PCM-101 pilot's
 * controller repaired main by hand in QA's rework; CSET-202 r2's rewrote
 * module-workers' results in the task; CSET-203 r9's wrote through a script.
 */
export const GUARDED_PHASES = new Set(['task', 'rework']);

/** A controller's product edit as the record names it: the action, its path relative to `workspace`, and the transcript line. */
export function describeEdit(e, workspace, session) {
  const slash = (p) => String(p).replace(/\\/g, '/');
  const w = workspace === null ? null : slash(workspace).replace(/\/+$/, '');
  const rel = w !== null && slash(e.path).toLowerCase().startsWith(`${w.toLowerCase()}/`) ? slash(e.path).slice(w.length + 1) : slash(e.path);
  const what = e.action.startsWith('git ') ? `${e.action} in ${rel}` : `${e.action} ${rel}`;
  return `${what} (${basename(slash(session.transcript ?? ''))}:${e.line})`;
}

/**
 * A with arm's controller failures: a session that changed the workspace
 * itself (its `violation`, rolled back by the harness: lib/controller-txn.mjs),
 * and a phase whose last session exited 0 (the session ended the phase
 * itself) while the feature was not complete as that phase left it — the
 * task's before any session-end fault, QA's rework after it. `phases` is
 * `[{ phase, sessions: [session records], mycelink: summary at the phase's
 * end }]`. A session the harness ended (interrupt, deadline) did not choose
 * to end incomplete.
 */
export function controllerFailures({ arm, phases = [], workspace = null }) {
  return controllerReport({ arm, phases, workspace }).failures;
}

/** Why a phase ended at a violation, as the record says it. */
const TERMINAL_TEXT = {
  'identical-violation': 'the same violation as before',
  'corrective-limit': 'no corrective session is left',
  'rollback-unverified': 'the rollback could not be verified, so no session started on it',
  budget: 'its deadline had passed',
};

/**
 * A with arm's controller record: `{ ok, failures, recovered, violations,
 * authority_recovered }`. A session's violation — what it changed in the
 * workspace that neither Mycelink nor a module-worker did, rolled back by
 * the harness — is a failure, unless a corrective session the harness
 * started for it (`corrects`) and every later session of its phase changed
 * nothing themselves, the rollback was verified, the phase's last session
 * exited 0 and the phase left the feature complete through Mycelink. Then it
 * is `recovered`: kept on the record, named with the session that recovered
 * it, and no failure. Each violation is listed by its paths and kinds (never
 * content), how it was rolled back, and why the phase ended there if it did;
 * `authority_recovered` says whether a later session recovered the
 * controller key (Mycelink's own record).
 */
export function controllerReport({ arm, phases = [], workspace = null }) {
  void workspace;
  if (arm !== 'with') return { ok: true, failures: [], recovered: [], violations: [], authority_recovered: false };
  const failures = [];
  const recovered = [];
  const violations = [];
  for (const p of phases) {
    const last = p.sessions.at(-1);
    const finished = Boolean(last && last.ended_by === 'exit' && last.exit_code === 0 && p.mycelink?.complete);
    for (const [i, s] of p.sessions.entries()) {
      const v = s.violation;
      if (!v) continue;
      const summary = v.summary ?? [];
      const more = summary.length > 1 ? `, and ${summary.length - 1} more` : '';
      const discarded = (v.discarded ?? []).filter((d) => d.discarded).map((d) => d.node_id ?? d.worktree);
      const text =
        `controller-violation: session ${s.index} (${s.purpose}) changed the workspace itself: ${summary[0] ?? 'nothing named'}${more}; ${s.ended_by === 'controller-violation' ? 'stopped there' : 'the session had ended'}; rolled back (${v.mode}, ${v.verified ? 'verified' : 'not verified'})` +
        (discarded.length ? `; the dispatch of ${discarded.join(', ')} discarded through Mycelink` : '') +
        '.';
      // The phase's last corrective session recovers every violation before it (two independent ones get two), when it and all after it changed nothing themselves.
      const corrective = p.sessions.filter((x) => x.corrects !== undefined && x.index > s.index).at(-1);
      const clean = corrective && p.sessions.slice(p.sessions.indexOf(corrective)).every((x) => !x.violation);
      const ok = Boolean(corrective && clean && finished && v.verified && i < p.sessions.indexOf(corrective));
      violations.push({ session: s.index, purpose: s.purpose, fingerprint: v.fingerprint ?? null, summary, mode: v.mode ?? null, verified: v.verified === true, manifest_sha256: v.manifest_sha256 ?? null, discarded: v.discarded ?? [], recovered_by: ok ? corrective.index : null, terminal: s.terminal ?? null });
      if (ok) recovered.push(`${text} Recovered by session ${corrective.index} (${corrective.purpose}), which completed it through Mycelink to ${p.mycelink.candidate}`);
      else {
        const why = s.terminal ? ` The phase ended: ${TERMINAL_TEXT[s.terminal] ?? s.terminal}.` : '';
        const hint = p.phase === 'rework' ? 'With Mycelink the controller reworks the producer node and a module-worker repairs it' : 'With Mycelink, Mycelink and its module-workers make every change; the controller writes only its own documents';
        failures.push(`${text}${why} ${hint}`);
      }
    }
    // A session the model provider ended, continued by a fresh session: the provider's failure, recovered — never the controller's.
    for (const s of p.sessions) {
      const next = p.sessions.find((x) => x.provider_recovery === true && x.resumes === s.index);
      if (!next || s.provider_failure?.transient !== true) continue;
      recovered.push(`provider-interrupted: session ${s.index} (${s.purpose}) was ended by a transient model-provider failure (${s.provider_failure.class}); resumed by session ${next.index} (${next.purpose})${finished ? `; the phase completed through Mycelink to ${p.mycelink.candidate}` : ''}`);
    }
    // An incomplete exit a fresh session continued (a with arm's continuation) is recovered when the phase completed.
    for (const s of p.sessions) {
      const next = p.sessions.find((x) => x.continuation === true && x.resumes === s.index);
      if (!next || s.ended_by !== 'exit' || s.exit_code !== 0 || !finished) continue;
      const by = next === last ? `, which completed it through Mycelink to ${p.mycelink.candidate}` : `; the phase completed it through Mycelink to ${p.mycelink.candidate}`;
      recovered.push(`exited-incomplete: session ${s.index} (${s.purpose}) exited 0 with the feature incomplete; continued by session ${next.index} (${next.purpose})${by}`);
    }
    if (!last || last.ended_by !== 'exit' || last.exit_code !== 0) continue;
    const where = `session ${last.index} (${last.purpose}) exited 0`;
    if (p.mycelink === null) failures.push(`exited-incomplete: ${where} with no Mycelink feature state`);
    else if (p.mycelink.initialised === false) failures.push(`exited-incomplete: ${where} with ${p.mycelink.feature_id} never initialised (no STATE.json)`);
    else if (!p.mycelink.complete) failures.push(`exited-incomplete: ${where} with ${p.mycelink.feature_id} incomplete: ${p.mycelink.incomplete.join('; ')}`);
  }
  const authority_recovered = phases.at(-1)?.mycelink?.authority_recovered === true;
  return { ok: failures.length === 0, failures, recovered, violations, authority_recovered };
}

/** What a fresh session after an evaluator interrupt is called, by phase. */
const RESUMED_PURPOSE = { task: 'resume', rework: 'rework-resume' };
/** What a corrective session after a controller violation is called (guarded phases only). */
const CORRECTIVE_PURPOSE = { task: 'corrective', rework: 'rework-corrective' };

/**
 * Corrective sessions a with-arm phase gets at most, one per independent
 * violation (CSET-203 r9). An identical repeat ends the phase at once.
 */
export const MAX_CORRECTIVES = 2;

/**
 * One phase of a run — the task, or QA's rework of a late defect. A session
 * the evaluator interrupted is followed by a fresh session of the same
 * phase (the resume header, then the phase's prompt) on the phase's own
 * deadline, until a session ends on its own (whatever its exit code: the
 * agent gets no second attempt), the deadline passes, or a session cannot
 * start. `start({ purpose, phase, text, deadline, resumes, corrects? })`
 * runs one session and resolves to its record (`index`, `ended_by`, and in a
 * with arm's guarded phase its `violation`: what it changed itself, already
 * rolled back by the harness, `{ fingerprint, verified, ... }`).
 * With `corrective(session)` (a with arm's guarded phase), a session that
 * left a violation — stopped for it, or ended on its own or by an interrupt
 * — is followed by a fresh corrective session whose prompt `corrective`
 * returns; it becomes the phase's prompt for any later resume (an
 * interrupted session's corrective one resumes it too). At most
 * MAX_CORRECTIVES of them, one per independent violation: the phase ends
 * (`terminal`, also set on the session) at a violation identical to an
 * earlier one, one past the limit, one whose rollback was not verified (no
 * session starts on a workspace not known clean), or one past the
 * deadline. With `continuation(session, { consecutive, bounded,
 * budget })` (a with arm), a session that exits on its own is asked about:
 * `consecutive` counts the exits since the phase began or was last
 * interrupted (this one included), `bounded` says MAX_CONTINUATIONS
 * continuations were already made of them, `budget` that the deadline has
 * not passed. Unless bounded or out of budget, `{ text }` starts a fresh
 * `resume` session of the phase with that prompt (`continuation: true`,
 * resuming the session that exited), on the same deadline; null ends the
 * phase there. Resolves to `{ phase, sessions, ended_by, terminal? }`.
 */
export async function runPhase({ phase, prompt, deadline, start, corrective = null, continuation = null, providerRecovery = null, now = Date.now }) {
  const sessions = [];
  let text = prompt;
  let corrections = 0;
  const seen = new Set();
  let consecutive = 0;
  let recoveries = 0;
  let s = await start({ purpose: phase, phase, text, deadline, resumes: null });
  sessions.push(s);
  for (;;) {
    if (s.violation && corrective && CORRECTIVE_PURPOSE[phase]) {
      // What it changed itself is already rolled back; a fresh session corrects it, boundedly.
      const terminal = !s.violation.verified ? 'rollback-unverified' : seen.has(s.violation.fingerprint) ? 'identical-violation' : corrections >= MAX_CORRECTIVES ? 'corrective-limit' : now() >= deadline ? 'budget' : null;
      if (terminal !== null) {
        s.terminal = terminal;
        return { phase, sessions, ended_by: 'controller-violation', terminal };
      }
      seen.add(s.violation.fingerprint);
      corrections += 1;
      consecutive = 0;
      text = await corrective(s);
      s = await start({ purpose: CORRECTIVE_PURPOSE[phase], phase, text, deadline, resumes: s.ended_by === 'interrupt' ? s.index : null, corrects: s.index });
    } else if (s.ended_by === 'interrupt' || (s.ended_by === 'controller-violation' && !s.violation)) {
      // An evaluator interrupt — or a stop whose change the session's settlement found gone again: nothing to correct, it resumes.
      consecutive = 0;
      if (now() >= deadline) return { phase, sessions, ended_by: 'budget' };
      s = await start({ purpose: RESUMED_PURPOSE[phase], phase, text: resumePrompt(text), deadline, resumes: s.index });
    } else if (s.violation) {
      // A violation with no correction to give (no callback, or a phase without one): the phase ends there.
      return { phase, sessions, ended_by: 'controller-violation' };
    } else if (s.ended_by === 'exit' && providerRecovery && RESUMED_PURPOSE[phase] && s.provider_failure?.class === 'auth') {
      // An authentication or billing failure: no fresh session gets past it.
      s.terminal = 'provider-permanent';
      return { phase, sessions, ended_by: 'provider-permanent', terminal: 'provider-permanent' };
    } else if (s.ended_by === 'exit' && providerRecovery && RESUMED_PURPOSE[phase] && s.provider_failure?.transient === true) {
      // The model provider ended it (CSET-203 r10), whatever its exit code: Mycelink reconciles, a fresh session resumes, boundedly.
      recoveries += 1;
      consecutive = 0;
      if (recoveries > MAX_PROVIDER_RECOVERIES) {
        s.terminal = 'provider-unavailable';
        return { phase, sessions, ended_by: 'provider-unavailable', terminal: 'provider-unavailable' };
      }
      if (now() >= deadline) return { phase, sessions, ended_by: 'budget' };
      const next = await providerRecovery(s, { count: recoveries });
      if (!next) {
        s.terminal = 'provider-unavailable';
        return { phase, sessions, ended_by: 'provider-unavailable', terminal: 'provider-unavailable' };
      }
      s = await start({ purpose: RESUMED_PURPOSE[phase], phase, text: next.text, deadline, resumes: s.index, provider_recovery: true });
    } else if (s.ended_by === 'exit' && continuation && RESUMED_PURPOSE[phase]) {
      // An exit on its own: the with arm continues a feature it left incomplete and resumable, boundedly.
      consecutive += 1;
      const bounded = consecutive > MAX_CONTINUATIONS;
      const budget = now() < deadline;
      const next = await continuation(s, { consecutive, bounded, budget });
      if (!next || bounded || !budget) return { phase, sessions, ended_by: s.ended_by };
      s = await start({ purpose: RESUMED_PURPOSE[phase], phase, text: next.text, deadline, resumes: s.index, continuation: true });
    } else {
      return { phase, sessions, ended_by: s.ended_by };
    }
    sessions.push(s);
  }
}

/**
 * Consecutive incomplete exits of a with-arm phase a fresh session continues
 * (CSET-203 r4: the corrective controller exited 0 with the cli READY in its
 * rework generation and the run ended failed). The phase's own deadline
 * bounds them too.
 */
export const MAX_CONTINUATIONS = 2;

/**
 * Recoveries from a transient model-provider failure a phase gets at most
 * (CSET-203 r10); Mycelink bounds each ticket to two itself
 * (MAX_PROVIDER_INTERRUPTIONS_PER_TICKET, PROVIDER_UNAVAILABLE). The phase's
 * own deadline bounds them too.
 */
export const MAX_PROVIDER_RECOVERIES = 4;
export const MAX_PROVIDER_INTERRUPTIONS_PER_TICKET = 2;

/**
 * How a with-arm phase waits, without a model session, when its controller
 * exited while Mycelink says `await-worker` (CSET-203 r7: a worker or
 * reviewer holds a live dispatch lease): `feature status` is read every
 * `pollMs`, at most `maxMs` (and never past the phase's deadline).
 */
export const AWAIT_WORKER_POLL_MS = 15_000;
export const AWAIT_WORKER_MAX_MS = 120_000;

/**
 * How a with-arm phase waits, with no model session, on an acceptance
 * reviewer its controller launched that still runs once the controller
 * exited (CSET-203 r13: `await-reviewer`, RUNNING): within the reviewer's own
 * wall-clock — what `feature status` says is left of it, and a grace — at
 * most AWAIT_REVIEWER_MAX_MS, never past the phase's deadline. Waiting
 * spends no model budget; the phase's wall-clock pays for it.
 */
export const AWAIT_REVIEWER_MAX_MS = 25 * 60_000;
export const AWAIT_REVIEWER_GRACE_MS = 30_000;

/** What feature status says is to be waited for: a worker's live lease, or a reviewer still running. */
const awaiting = (status) => status?.next_action?.kind === 'await-worker' || (status?.next_action?.kind === 'await-reviewer' && status.next_action.reviewer?.state === 'RUNNING');

/**
 * How often a with-arm controller session's workspace is checked while it
 * runs (lib/controller-txn.mjs lightCheck), besides at once after a call of
 * its own that wrote: a helper process writes with no call to show it.
 */
export const LIGHT_CHECK_MS = 10_000;

/** Entries of a transaction's lists a run record keeps (the transaction's own files keep everything). */
const TXN_LIST = 200;

/**
 * A settled controller transaction as the run record keeps it: whether it
 * was a violation, every unauthorised change by path and kind (capped,
 * counted), what was authorised by whom (counted), housekeeping, the
 * rollback (mode, verified, plan and manifest digests, the paths it
 * restored or removed, the refs it moved back), the dispatches discarded,
 * why a whole session went back, the ledger's integrity — never content —
 * and where its files are. CSET-203 r12: what module-workers changed in a
 * repository's shared Git state (a stash entry) by whose call, authorised,
 * apart from everything else (`worker_git`); the call ledger's integrity;
 * what a Mycelink step read of a violation (`dependencies`); and a full
 * rollback's reconstruction — where it cut the session, the worktrees it
 * took away or kept, what it archived — or why it went back whole.
 */
function txnRecord(settled, txnRoot) {
  const cap = (list) => (list.length > TXN_LIST ? [...list.slice(0, TXN_LIST), `and ${list.length - TXN_LIST} more`] : list);
  const by = {};
  for (const a of settled.authorized ?? []) by[a.by] = (by[a.by] ?? 0) + 1;
  const r = settled.rollback;
  const rollback = r
    ? {
        mode: r.mode,
        verified: r.verified,
        rounds: r.rounds,
        plan_sha256: r.plan_sha256,
        manifest_sha256: r.manifest_sha256 ?? null,
        digest: r.digest,
        restored: cap(r.restored ?? []),
        removed: cap(r.removed ?? []),
        refs: r.refs ?? [],
        ...(r.reflogs ? { reflogs: r.reflogs } : {}),
        ...(r.mode === 'full' ? { reconstruction: r.reconstruction ? { ...r.reconstruction, archived: cap(r.reconstruction.archived ?? []) } : null, ...(r.whole ? { whole: r.whole } : {}) } : {}),
        ...(r.error ? { error: r.error } : {}),
      }
    : null;
  return {
    dir: join(txnRoot, `session-${settled.index}`),
    violation: settled.violation,
    mode: settled.mode,
    fingerprint: settled.fingerprint,
    unauthorized: cap(settled.unauthorized.map((d) => `${d.path} (${d.change}; ${d.category})`)),
    unauthorized_count: settled.unauthorized.length,
    authorized: by,
    worker_git: settled.worker_git ?? [],
    housekeeping: cap(settled.housekeeping.map((d) => `${d.path} (${d.change}; ${d.category})`)),
    contaminated: settled.contaminated,
    discarded: settled.discarded,
    ambiguous: settled.ambiguous,
    dependencies: settled.dependencies ?? [],
    ledger: settled.ledger,
    calls: settled.calls ?? null,
    pre_digest: settled.pre?.digest ?? null,
    post_digest: settled.post?.digest ?? null,
    rollback,
  };
}

/**
 * Wait boundedly while the feature's next action is `await-worker`, or
 * `await-reviewer` with its reviewer still running (CSET-203 r13): no model
 * session runs while a live lease may still settle or a launched reviewer
 * may still answer. Resolves to the last status read, the polls made, the
 * time waited, and why it stopped: `changed` (the next action is something
 * else), `progress` (the state moved) or `bounded` (still waiting: its
 * holder went with the session that exited, and a fresh controller
 * reconciles and re-issues it).
 */
export async function awaitLiveLease({ read, digest, pollMs = AWAIT_WORKER_POLL_MS, maxMs = AWAIT_WORKER_MAX_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const start = now();
  const first = digest();
  let polls = 0;
  for (;;) {
    const status = read();
    polls += 1;
    const waited = now() - start;
    if (!awaiting(status)) return { status, polls, waited_ms: waited, until: 'changed' };
    if (digest() !== first) return { status, polls, waited_ms: waited, until: 'progress' };
    if (waited + pollMs > maxMs) return { status, polls, waited_ms: waited, until: 'bounded' };
    await sleep(pollMs);
  }
}

/**
 * The record of an interrupt-restart fault: the session it interrupted and
 * the fresh session of that phase that resumed it — the very next session,
 * started for it — or why none did.
 */
export function interruptRecord(fault, sessions) {
  if (!fault.fired) return { kind: fault.kind, applied: false, sessions: sessions.length, detail: 'the run ended before the trigger' };
  const brief = (s) => (s ? { index: s.index, purpose: s.purpose, phase: s.phase, ended_by: s.ended_by } : null);
  const interrupted = sessions.find((s) => s.index === fault.interrupted?.index) ?? null;
  const next = interrupted ? sessions.find((s) => s.index === interrupted.index + 1) : null;
  const successor = next && next.phase === interrupted.phase && next.resumes === interrupted.index ? next : null;
  return {
    kind: fault.kind,
    applied: true,
    at_seconds: fault.at,
    interrupted_session: brief(interrupted),
    successor_session: brief(successor),
    resumed: successor !== null,
    sessions: sessions.length,
    ...(successor ? {} : { detail: 'no fresh session resumed it: the phase had no budget left' }),
  };
}

/** What a session inherits: the toolchain PATH, model access and the Git identity; nothing else. */
export const PASSED_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
  'JAVA_HOME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'AWS_REGION',
  'AWS_PROFILE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

export function sessionEnv({ home, base = process.env, extra = {} }) {
  const env = {};
  for (const k of PASSED_ENV) if (base[k] !== undefined) env[k] = base[k];
  env.HOME = home;
  if (process.platform === 'win32') env.USERPROFILE = home;
  env.TMPDIR = join(home, '.tmp');
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.GIT_AUTHOR_NAME ??= 'Benchmark Agent';
  env.GIT_AUTHOR_EMAIL ??= 'agent@benchmark.invalid';
  env.GIT_COMMITTER_NAME ??= env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL ??= env.GIT_AUTHOR_EMAIL;
  return { ...env, ...extra };
}

/** Kill a session and everything it started (its process group; the tree on Windows). */
function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * One session. `poll()` runs every `pollMs` while it lives and may return
 * 'interrupt' or 'controller-violation', which stop it so; the deadline
 * ends it as 'budget'. Resolves when the session and its output are done
 * (a straggler holding the pipes is cut off).
 */
function runSession({ isolation, spec, prompt, transcriptPath, stderrPath, infoPath, deadline, pollMs, poll, onText }) {
  return new Promise((done) => {
    const started = Date.now();
    const out = createWriteStream(transcriptPath);
    const err = createWriteStream(stderrPath);
    const confined = isolation?.kind === 'bubblewrap';
    let child;
    let tracker = null;
    try {
      child = startConfined(isolation, { ...spec, ...(confined ? { infoPath } : {}) }, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      if (confined) tracker = trackNamespace(infoPath);
    } catch (error) {
      out.end();
      err.end();
      done({ exit_code: null, signal: null, ended_by: 'spawn-error', duration_ms: 0, result: null, confined, survivors: [], error: String(error?.message ?? error) });
      return;
    }
    let endedBy = null;
    let result = null;
    let spawnError = null;
    let pending = '';
    let finished = false;
    child.stdout.on('data', (chunk) => {
      out.write(chunk);
      pending += chunk.toString('utf8');
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        onText(`${line}\n`);
        try {
          const event = JSON.parse(line);
          if (event?.type === 'result') result = event;
        } catch {
          // not an event
        }
      }
    });
    child.stderr.on('data', (chunk) => err.write(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const stop = (why) => {
      if (endedBy !== null) return;
      endedBy = why;
      killTree(child);
    };
    const timer = setInterval(() => {
      // A session already being stopped is never polled again: no fault fires into it.
      if (endedBy !== null) return;
      if (Date.now() >= deadline) return stop('budget');
      const action = poll();
      if (action === 'interrupt' || action === 'controller-violation') stop(action);
    }, pollMs);
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (pending) onText(pending);
      out.end();
      err.end();
      // Nothing a session started may outlive it: what did (in its PID namespace, or its process group) is killed and named.
      const survivors = reapSurvivors(confined ? { ns: tracker?.stop() ?? null } : { pgid: child.pid });
      killTree(child);
      done({
        exit_code: code,
        signal: signal ?? null,
        ended_by: endedBy ?? (spawnError ? 'spawn-error' : 'exit'),
        duration_ms: Date.now() - started,
        confined,
        survivors,
        result: result && {
          subtype: result.subtype ?? null,
          is_error: result.is_error ?? null,
          stop_reason: typeof result.stop_reason === 'string' ? result.stop_reason : null,
          terminal_reason: typeof result.terminal_reason === 'string' ? result.terminal_reason : null,
          api_error_status: Number.isInteger(result.api_error_status) ? result.api_error_status : null,
          num_turns: result.num_turns ?? null,
          total_cost_usd: result.total_cost_usd ?? null,
          duration_ms: result.duration_ms ?? null,
          usage: result.usage ?? null,
        },
        ...(spawnError ? { error: spawnError } : {}),
      });
    };
    child.on('error', (error) => {
      spawnError = String(error?.message ?? error);
      finish(null, null);
    });
    child.on('close', finish);
    child.on('exit', (code, signal) => {
      const t = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, 5000);
      t.unref();
    });
  });
}

/**
 * Roots no transcript of a run may name (defense in depth; see
 * lib/transcripts.mjs): the suite, the caches with the evaluator store, and
 * the development checkout the plugin is packaged from (a session gets the
 * sealed package), and any evaluator authoring clones.
 */
export function forbiddenRunRoots({ suiteRoot, cacheRoot, source = PLUGIN_SOURCE, authoring = [] }) {
  return [suiteRoot, cacheRoot, join(cacheRoot, 'evaluator'), source, ...authoring].map((p) => resolve(p));
}

function statIsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The nearest existing ancestor of `path`, resolved through symlinks, with the rest appended. */
function realish(path) {
  let head = resolve(path);
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  const real = existsSync(head) ? realpathSync.native(head) : head;
  return join(real, ...tail);
}

/**
 * Why `outDir` may not hold a run (null when it may): a run directory —
 * the agent's workspace and HOME among it — never lies inside the suite,
 * the development checkout, the cache with the evaluator store, a
 * toolchain or an evaluator authoring clone.
 */
export function outDirProblem(outDir, { suiteRoot, cacheRoot, authoring = [], toolchains = [], source = PLUGIN_SOURCE }) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const target = fold(realish(outDir));
  for (const [what, root] of [['the suite', suiteRoot], ['the development checkout', source], ['the cache and evaluator store', cacheRoot], ...authoring.map((r) => ['an evaluator authoring clone', r]), ...toolchains.map((r) => ['a toolchain', r])]) {
    if (!root) continue;
    const r = fold(realish(root));
    const rel = relative(r, target);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return `out-dir ${outDir} is inside ${what} (${root}): put runs elsewhere, e.g. the OS temp dir (the default)`;
  }
  return null;
}

const TEAMMATE_NOTE = {
  path: 'TEAM-NOTES.md',
  content: '# Team notes\n\n- The nightly build now runs at 02:00 UTC.\n',
  message: 'docs: team notes',
};

/**
 * Run one arm of one case into `outDir` (created; must not exist or be
 * empty). Returns the run record (also written as run.json, the verdict as
 * verification.json).
 */
export async function runArm({
  suiteRoot = defaultSuiteRoot(),
  caseKey,
  arm,
  faultPlan = null,
  outDir = null,
  cacheRoot,
  claude = ['claude'],
  model = null,
  maxBudgetUsd = null,
  budgetSeconds = null,
  reworkBudgetSeconds = null,
  pollMs = 2000,
  env: extraEnv = {},
  requireMycelink = false,
  requireTdd = false,
  plugin = null,
  authoringRoots = [],
  isolation = null,
  proxyAllow = DEFAULT_ALLOW,
  suitePin = null,
  preflightProxy = null,
  sessionBinds = [],
  awaitWorker = { pollMs: AWAIT_WORKER_POLL_MS, maxMs: AWAIT_WORKER_MAX_MS },
  awaitReviewer = { pollMs: AWAIT_WORKER_POLL_MS, maxMs: AWAIT_REVIEWER_MAX_MS, graceMs: AWAIT_REVIEWER_GRACE_MS },
  lightCheckMs = LIGHT_CHECK_MS,
  controllerGuard = true,
  log = () => {},
}) {
  if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm} (expected ${ARMS.join(' or ')})`);
  const problems = planProblems(faultPlan);
  if (problems.length) throw new Error(`fault plan: ${problems.join('; ')}`);
  const suite = loadSuite(suiteRoot);
  const found = findPrd(suite, caseKey);
  if (!found) throw Object.assign(new Error(`unknown case ${caseKey}`), { usage: true });
  const { project, prd } = found;
  const runDir = resolve(outDir ?? join(mkdtempSync(join(tmpdir(), `bench-run-${prd.manifest.id}-${arm}-`)), 'run'));
  let toolchainRoots = [];
  try {
    const t = loadToolchains(cacheRoot);
    toolchainRoots = [t.java?.home, t.node?.bin ? dirname(t.node.bin) : null].filter(Boolean);
  } catch {
    toolchainRoots = [];
  }
  const misplaced = outDirProblem(runDir, { suiteRoot, cacheRoot, authoring: [...authoringRoots, ...(suitePin ? [suitePin.root] : [])], toolchains: toolchainRoots });
  if (misplaced) throw Object.assign(new Error(misplaced), { usage: true });
  if (existsSync(runDir) && readdirSync(runDir).length > 0) throw Object.assign(new Error(`${runDir} is not empty`), { usage: true });
  const ws = join(runDir, 'workspace');
  const home = join(runDir, 'home');
  const sessionsDir = join(runDir, 'sessions');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, '.tmp'), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  // The plugin as it ships (the release package: no eval suite), sealed beside the run, outside every
  // path a session can write: the with arm loads it, fault replays and the verdict run its CLI.
  log('sealing the plugin package');
  const artifact = sealPlugin({ ...(plugin ?? buildPluginPackage()), dir: join(runDir, 'plugin') });

  log('building the workspace');
  await buildWorkspace({ project, prd, target: ws, home, cacheRoot });
  const repo = join(ws, ...project.adapter.workspace.repo_dir.split('/'));
  const branch = project.adapter.workspace.branch;
  const start = project.lock.commit;
  const prompt = casePrompt({ project, prd });
  const args = claudeArgs({ plugin: arm === 'with', pluginDir: artifact.dir, model, maxBudgetUsd });
  // Mycelink's own account of what its processes change (the plugin's provenance ledger), in the session HOME; in both arms alike.
  const ledgerDir = join(home, '.mycelink-provenance');
  const sessionEnvironment = sessionEnv({ home, extra: { [PROVENANCE_ENV]: ledgerDir, ...extraEnv } });
  const confined = isolation?.kind === 'bubblewrap';
  const toolchains = project.adapter.toolchain.cache.kind === 'none' ? null : loadToolchains(cacheRoot);
  const budgetMs = (budgetSeconds ?? prd.manifest.budget.timeout_seconds) * 1000;
  const reworkMs = (reworkBudgetSeconds ?? Math.floor((budgetSeconds ?? prd.manifest.budget.timeout_seconds) / 2)) * 1000;

  const record = {
    schema: 'mycelink-bench/arm-run@1',
    case: prd.manifest.case,
    prd: prd.manifest.id,
    project: project.id,
    arm,
    condition: faultPlan ? 'faults' : 'normal',
    fault_plan: faultPlan ? faultPlan.id : null,
    prompt_sha256: sha256Hex(prompt),
    claude: { command: claude, args },
    plugin: { version: artifact.version, zip_sha256: artifact.zip_sha256, tree_sha256: artifact.tree_sha256, files: artifact.files, dir: artifact.dir },
    model,
    budget_seconds: budgetMs / 1000,
    rework_budget_seconds: reworkMs / 1000,
    max_budget_usd: maxBudgetUsd,
    workspace: ws,
    home,
    started_at: new Date().toISOString(),
    suite: pinRecord(suitePin),
    isolation: { ...isolationRecord(isolation), preflight: null, proxy: null },
    // A with arm runs its controller sessions as transactions (lib/controller-txn.mjs); off only in tests whose stand-in is no Mycelink host, and then untrusted.
    controller_guard: arm === 'with' ? controllerGuard : null,
    // Its violations' rollbacks, attested after the run (attestRollbacks): what trusts them.
    controller_rollbacks: null,
    sessions: [],
    phases: [],
    continuations: [],
    provider_recoveries: [],
    provider: null,
    faults: [],
    network: null,
    evaluator_access: null,
    plugin_exposure: null,
    verification: join(runDir, 'verification.json'),
    workers: null,
    reviewers: null,
    verdict: null,
    trust: null,
    delivery: null,
    ok: false,
    trusted: false,
  };
  const writeRecord = () => writeFileSync(join(runDir, 'run.json'), JSON.stringify(record, null, 2) + '\n');

  // ---- the boundary every session runs in, proved from inside before the first one.
  let profile = null;
  let proxy = null;
  if (confined) {
    const toolchain = agentToolchain({ adapter: project.adapter, toolchains });
    // The sealed caches' private copies in the HOME are read-only inside: an install copies from them, nothing changes them.
    const sealed = sealedCacheBinds({ adapter: project.adapter, home });
    profile = sessionSandbox({ workspace: ws, home, artifactDir: artifact.dir, loadPlugin: arm === 'with', claude, args, toolchain, env: sessionEnvironment, extraBinds: [...sealed, ...sessionBinds] });
    const newProxy = (name) => {
      const file = join(runDir, name);
      writeFileSync(file, '');
      return startModelProxy({ socket: join(mkdtempSync(join(tmpdir(), 'bench-proxy-')), 'proxy.sock'), log: file, allow: proxyAllow });
    };
    record.isolation.profile = { binds: profile.binds.map((b) => ({ path: b.path, dest: b.dest ?? b.path, rw: Boolean(b.rw) })), path: profile.env.PATH, jvm_options: profile.jvmOptions };
    log('isolation preflight');
    // The preflight gets a proxy (and log) of its own: the sessions' log holds only the sessions' traffic.
    const preflightProxyServer = await newProxy('proxy-preflight.jsonl');
    const pinnedRoots = suitePin ? [suitePin.root, join(suitePin.root, '.local')] : [];
    // Without the plugin, the sealed package is one more root the probe must not find; with a JDK, the operator's ~/.m2.
    const forbidden = [...new Set([...forbiddenRunRoots({ suiteRoot, cacheRoot, authoring: authoringRoots }), join(suiteRoot, '.local'), ...pinnedRoots, '/mnt/c', '/mnt/wsl', ...(arm === 'with' ? [] : [artifact.dir]), ...(profile.jvmOptions ? [join(homedir(), '.m2')] : [])])];
    try {
      record.isolation.preflight = await agentPreflight({
        isolation,
        profile,
        proxySocket: preflightProxyServer.socket,
        forbidden,
        readonly: [...(arm === 'with' ? [artifact.dir] : []), ...profile.binds.filter((b) => !b.rw && b.path !== artifact.dir && existsSync(b.path) && !b.dest).map((b) => b.path).filter((p) => statIsDir(p))],
        writable: [ws, home],
        proxy: preflightProxy ?? { allowed: proxyAllow[0], denied: 'example.com:443' },
      });
    } finally {
      await preflightProxyServer.stop();
    }
    if (record.isolation.preflight.ok) {
      proxy = await newProxy('proxy.jsonl');
      record.isolation.proxy = { allow: proxyAllow, log: proxy.log };
    } else {
      record.verification = null;
      record.errors = [`the isolation preflight failed: ${record.isolation.preflight.checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.detail})`).join('; ')}`];
      Object.assign(record, runVerdict({ record, verification: null }), { workers: [], reviewers: [] });
      record.finished_at = new Date().toISOString();
      writeRecord();
      return record;
    }
  }
  const transcripts = [];
  const faults = (faultPlan?.faults ?? []).map((f) => ({ ...f, fired: false }));
  const runStart = Date.now();
  const pollErrors = new Set();

  const agentCommits = () => {
    const injected = recordedCommits(record.faults);
    return git(repo, ['rev-list', '--branches', '--not', start]).split('\n').filter((c) => c && !injected.has(c)).length;
  };
  const replay = (kind) => {
    if (arm !== 'with') return { kind, applied: false, detail: 'a Mycelink-only fault: not applicable without the plugin' };
    const commands = settleCommandsFromTranscript(transcripts.map((t) => t.text).join(''));
    return replaySettles({ control: join(ws, 'platform'), mycelink: artifact, commands, kinds: [kind], workspace: ws, isolation })[0];
  };
  // An injected commit is journaled the moment it lands; only its working-tree sync is ever
  // retried (the agent's git may hold the index), so a retry never lands a second commit.
  const pendingSyncs = [];
  /**
   * An injected commit landed (and its checkout synced) while a with-arm
   * controller session runs as a transaction: the branch, the index and the
   * paths are the harness's change, not the controller's (lib/controller-txn.mjs).
   */
  const noteInjection = (r) => {
    const txn = running?.txn;
    if (!txn || !r?.applied) return;
    try {
      noteHarnessChange({ txn, paths: [join(repo, '.git', 'index'), ...(r.changes ?? []).map((c) => join(repo, ...c.path.split('/')))], refs: [{ gitDir: join(repo, '.git'), ref: `refs/heads/${r.branch}`, value: r.commit }] });
    } catch (error) {
      pollErrors.add(`noting an injection: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  };
  const retrySyncs = (final = false) => {
    for (const r of [...pendingSyncs]) {
      try {
        resumeInjectionSync({ repo, record: r });
        noteInjection(r);
        pendingSyncs.splice(pendingSyncs.indexOf(r), 1);
      } catch (error) {
        if (final || r.sync_attempts >= MAX_SYNC_ATTEMPTS) {
          r.sync = 'failed';
          r.sync_error = String(error?.message ?? error).split('\n')[0];
          pendingSyncs.splice(pendingSyncs.indexOf(r), 1);
        }
      }
    }
  };
  const injectJournaled = (inject) => {
    let journaled = null;
    try {
      return inject((r) => {
        journaled = r;
        record.faults.push(r);
      });
    } catch (error) {
      if (!journaled) throw error;
      pendingSyncs.push(journaled);
      return journaled;
    }
  };
  // The registered repositories and their worktrees: product code only a module-worker changes in the with arm.
  const control = join(ws, 'platform');
  const productRoots = () => {
    const roots = new Set([repo, ...readRegistry(control).repos.map((r) => r.path)]);
    for (const root of [...roots]) {
      const r = safeGit(root, ['worktree', 'list', '--porcelain']);
      if (r.code === 0) for (const l of r.stdout.split('\n')) if (l.startsWith('worktree ')) roots.add(l.slice('worktree '.length));
    }
    // Mycelink's scratch area (worktrees and result slots) and every feature's evidence, sessions and state.
    roots.add(join(control, '.mycelink'));
    // Mycelink's provenance ledger: what its hooks and core record of every call and change, no session's to write.
    roots.add(ledgerDir);
    const features = join(control, 'features');
    if (existsSync(features)) {
      for (const f of readdirSync(features)) {
        for (const x of ['evidence', 'sessions', 'candidates', 'deliveries', 'STATE.json', 'ACCEPTANCE.json', 'events.jsonl', 'RUNS.jsonl']) roots.add(join(features, f, x));
      }
    }
    return [...roots];
  };
  // The session running now and where each phase started (time, agent commits), for the triggers polled in it.
  let running = null;
  const phaseStarts = {};
  const poll = () => {
    // A with-arm controller that changed product code itself is stopped at once; no fault fires into it.
    if (running?.guard?.()) return 'controller-violation';
    retrySyncs();
    let commits;
    try {
      commits = agentCommits();
    } catch (error) {
      pollErrors.add(String(error?.message ?? error).split('\n')[0]);
      return null;
    }
    const elapsed = (Date.now() - runStart) / 1000;
    for (const f of faults) {
      if (f.fired || !MID_SESSION.has(f.trigger.on)) continue;
      const scope = f.trigger.phase ?? null;
      if (scope !== null && running?.phase !== scope) continue;
      const from = scope === null ? { at: runStart, commits: 0 } : phaseStarts[scope];
      const since = commits - from.commits;
      const due = f.trigger.on === 'first-commit' ? since >= 1 : f.trigger.on === 'commits' ? since >= f.trigger.count : (Date.now() - from.at) / 1000 >= f.trigger.seconds;
      if (!due) continue;
      f.fired = true;
      if (f.kind === 'concurrent-commit') {
        const p = { ...TEAMMATE_NOTE, ...(f.params ?? {}) };
        try {
          const r = injectJournaled((journal) => injectConcurrentCommit({ repo, branch, path: p.path, content: p.content, message: p.message, journal }));
          r.at_seconds = Math.round(elapsed);
          noteInjection(r);
          log(`fault: concurrent-commit at ${r.at_seconds} s (${r.sync})`);
        } catch (error) {
          // Nothing landed (the branch moved under the compare-and-swap): try again at the next poll.
          f.failures = (f.failures ?? 0) + 1;
          if (f.failures < MAX_INJECTION_ATTEMPTS) f.fired = false;
          else record.faults.push({ kind: f.kind, applied: false, detail: `injection failed: ${String(error?.message ?? error).split('\n')[0]}` });
        }
      } else if (MYCELINK_ONLY.has(f.kind)) {
        record.faults.push({ ...replay(f.kind), at_seconds: Math.round(elapsed) });
      } else if (f.kind === 'interrupt-restart') {
        f.at = Math.round(elapsed);
        f.interrupted = running;
        log(`fault: interrupt at ${f.at} s, session ${running?.index} (${running?.purpose})`);
        return 'interrupt';
      }
    }
    return null;
  };

  // ---- a with-arm controller session as a transaction over the workspace (lib/controller-txn.mjs).
  const txnRoot = join(runDir, 'controller-txn');
  const txnStore = join(txnRoot, 'objects');
  /** The workspace as the last transaction left it: the next one's stat cache. */
  let lastSnapshot = null;
  /** A script a session runs, read where the harness sees the same file (the workspace, the session HOME) — never the host's own /tmp. */
  const readScript = (p) => {
    const abs = resolve(p);
    if (!under(abs, ws) && !under(abs, home)) return null;
    try {
      const st = lstatSync(abs);
      return st.isFile() && st.size <= 256 * 1024 ? readFileSync(abs, 'utf8') : null;
    } catch {
      return null;
    }
  };
  const session = async ({ purpose, phase, text, deadline, resumes, corrects, continuation, provider_recovery }) => {
    const n = record.sessions.length + 1;
    const transcriptPath = join(sessionsDir, `${n}-${purpose}.jsonl`);
    const entry = { text: '' };
    transcripts.push(entry);
    log(`session ${n} (${purpose})`);
    // In a guarded phase the with arm's session is the controller alone, run as a transaction: the workspace is
    // snapshotted before it, checked while it runs, and what it changed itself is rolled back after it.
    const guarded = controllerGuard && arm === 'with' && GUARDED_PHASES.has(phase);
    const txn = guarded ? beginTransaction({ workspace: ws, txnDir: join(txnRoot, `session-${n}`), store: txnStore, ledgerDir, index: n, previous: lastSnapshot, controls: [control], repos: [repo], stream: transcriptPath, plugin: artifact.dir, home }) : null;
    const scanner = guarded ? editScanner({ cwd: ws, home, exists: statIsDir, readFile: readScript }) : null;
    const edits = [];
    /** What its own calls wrote (a worktree it reached into is contaminated), and the worker gates it ran itself. */
    const reached = new Set();
    const forced = [];
    let scanned = 0;
    let lastLight = Date.now();
    let lightPrev = null;
    let lightSeen = new Map();
    /** What the check that stopped it saw (paths and kinds, never content). */
    let stoppedFor = null;
    const take = (found) => {
      edits.push(...found);
      for (const e of found) {
        if (e.gate) forced.push({ kind: 'gate', path: e.path, detail: `the controller ran ${e.action} for ${e.path} itself` });
        else if (!e.unknown && under(resolve(e.path), ledgerDir)) forced.push({ kind: 'ledger', path: e.path, detail: `the controller wrote Mycelink's provenance ledger itself (${e.action})` });
        else if (!e.unknown) reached.add(e.path);
      }
    };
    /**
     * While it runs: a worker gate the controller ran itself stops it; a
     * call it made that wrote (or may have written) is checked against the
     * workspace at once, and the workspace every lightCheckMs anyway (a
     * helper process writes with no call to show it). An unauthorised change
     * the call named, or one seen in two checks running, stops it (a path
     * the core touched while the check walked is left to the settlement);
     * a call the plugin's fence refused changed nothing and stops nothing.
     * What the stopping check saw is kept (`controller_txn.stopped_for`).
     */
    const guard = () => {
      const fresh = scanner.feed(entry.text.slice(scanned), productRoots());
      scanned = entry.text.length;
      take(fresh);
      if (forced.length > 0) {
        stoppedFor = { at: new Date().toISOString(), forced: forced.map((f) => f.detail) };
        return true;
      }
      const urgent = fresh.length > 0;
      if (!urgent && Date.now() - lastLight < lightCheckMs) return false;
      lastLight = Date.now();
      let check;
      try {
        check = lightCheck({ txn, previous: lightPrev, reached: [...reached], stream: entry.text });
      } catch (error) {
        pollErrors.add(`light check: ${String(error?.message ?? error).split('\n')[0]}`);
        return false;
      }
      lightPrev = check.snapshot;
      const seen = new Map(check.unauthorized.map((u) => [u.key, u.state]));
      const persisted = [...seen].some(([k, state]) => lightSeen.get(k) === state);
      lightSeen = seen;
      const stop = check.contaminated.length > 0 || (check.unauthorized.length > 0 && (urgent || persisted));
      if (stop) stoppedFor = { at: new Date().toISOString(), contaminated: check.contaminated, unauthorized: check.unauthorized.slice(0, TXN_LIST).map((u) => `${u.path} (${u.change}; ${u.category})`), urgent };
      return stop;
    };
    running = { index: n, purpose, phase, guard: scanner && guard, txn };
    const startedAt = new Date().toISOString();
    const s = await runSession({
      isolation,
      spec: profile ? { argv: profile.argv, env: profile.env, cwd: profile.cwd, binds: profile.binds, proxySocket: proxy.socket, init: profile.init } : { argv: [...claude, ...args], env: sessionEnvironment, cwd: ws },
      prompt: text,
      transcriptPath,
      stderrPath: join(sessionsDir, `${n}-${purpose}.stderr.log`),
      infoPath: join(sessionsDir, `${n}-${purpose}.bwrap.json`),
      deadline,
      pollMs,
      poll,
      onText: (t) => {
        entry.text += t;
      },
    });
    running = null;
    const done = { index: n, purpose, phase, resumes, ...(corrects !== undefined ? { corrects } : {}), ...(continuation ? { continuation: true } : {}), ...(provider_recovery ? { provider_recovery: true } : {}), prompt_sha256: sha256Hex(text), transcript: transcriptPath, started_at: startedAt, ended_at: new Date().toISOString(), ...s };
    // How it failed, from Claude Code's own records in its stream (lib/provider.mjs): only a session that ended by itself.
    done.provider_failure = s.ended_by === 'exit' ? sessionFailure(entry.text, s.exit_code) : null;
    if (txn) {
      // What it did between the last poll and its end counts too; then the session is settled (it and everything it started are gone).
      take(scanner.feed(entry.text.slice(scanned), productRoots()));
      take(scanner.end(productRoots()));
      done.controller_edits = edits;
      done.fence_blocks = scanner.blocked.length;
      const settled = settleTransaction({ txn, reached: [...reached], controls: [control], repos: [repo], forced, discard: (worktree) => discardWorktree(worktree, n), stream: entry.text });
      lastSnapshot = settled.snapshot;
      done.controller_txn = txnRecord(settled, txnRoot);
      if (stoppedFor !== null) done.controller_txn.stopped_for = stoppedFor;
      if (settled.violation) {
        done.violation = { fingerprint: settled.fingerprint, summary: settled.summary, mode: settled.mode, verified: settled.rollback?.verified === true, manifest_sha256: settled.rollback?.manifest_sha256 ?? null, discarded: settled.discarded ?? [], ...(settled.mode === 'full' ? { reconstruction: settled.rollback?.reconstruction ? { cut_at: settled.rollback.reconstruction.cut_at, removed_zones: settled.rollback.reconstruction.removed_zones, kept_zones: settled.rollback.reconstruction.kept_zones } : null } : {}) };
        log(`controller violation in session ${n} (${purpose}): ${settled.summary[0] ?? 'a forced violation'}; rolled back (${settled.mode}, ${done.violation.verified ? 'verified' : 'NOT verified'})`);
      }
    }
    record.sessions.push(done);
    return done;
  };
  // The agent is gone: a sync still pending gets a few last tries, then is recorded as failed.
  const settleSyncs = async () => {
    for (let i = 0; i < 5 && pendingSyncs.length > 0; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500));
      retrySyncs(i === 4);
    }
  };
  // What Mycelink recorded, bound to the delivery branch: at the end of each phase, and of the run.
  const mycelinkRef = { control: join(ws, 'platform'), featureId: prd.manifest.id, repo, branch };
  /**
   * A worktree the controller reached into, taken back through the pinned
   * Mycelink (`node discard`) with its claim's capability as the run's
   * transcripts show it: handed back unspent, worktree removed, branch
   * archived, nothing it held trusted. One that cannot be (no claim holds
   * it, already integrated, no capability found) is not discarded — and the
   * session is then rolled back whole (lib/controller-txn.mjs).
   */
  const discardWorktree = (worktree, n) => {
    const featureId = prd.manifest.id;
    let state;
    try {
      state = JSON.parse(readFileSync(join(control, 'features', featureId, 'STATE.json'), 'utf8')).data;
    } catch {
      return { discarded: false, detail: 'no feature state' };
    }
    const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const held = Object.entries(state.nodes ?? {}).find(([, rt]) => rt.claim?.worktree && norm(rt.claim.worktree) === norm(worktree));
    if (!held) return { discarded: false, detail: 'no claim holds this worktree' };
    const [id, rt] = held;
    if (rt.state === 'INTEGRATED' || rt.state === 'DONE') return { node_id: id, discarded: false, integrated: true, detail: `its claim had already settled ${rt.state}` };
    // Every capability the run's transcripts show, by its hash.
    const files = transcriptFiles({ streams: [], dirs: [join(home, '.claude', 'projects'), sessionsDir] });
    const byHash = new Map();
    for (const f of files) {
      let text = '';
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(/[0-9a-f]{64}/g)) byHash.set(sha256Hex(m[0]), m[0]);
    }
    const capability = byHash.get(rt.claim.capability_sha256);
    if (!capability) return { node_id: id, discarded: false, detail: 'its claim capability is in no transcript of the run' };
    return discardDispatch({ control, mycelink: artifact, featureId, nodeId: id, capability, reason: `controller violation in session ${n}: the controller wrote into this worktree itself`, workspace: ws, isolation });
  };
  const phase = async (name, text, phaseDeadline) => {
    let commits = 0;
    try {
      commits = agentCommits();
    } catch (error) {
      pollErrors.add(String(error?.message ?? error).split('\n')[0]);
    }
    phaseStarts[name] = { at: Date.now(), commits, head: revParse(repo, `refs/heads/${branch}`) };
    // A with arm's guarded phase: a corrective session after a violation the harness already rolled back and verified.
    const corrective =
      arm === 'with' && GUARDED_PHASES.has(name)
        ? async (stopped) => {
            const v = stopped.violation;
            const discarded = (v.discarded ?? []).filter((d) => d.discarded).map((d) => d.node_id);
            log(`session ${stopped.index}'s own changes rolled back (${v.mode}, verified); a corrective session follows`);
            const undone = { summary: v.summary, mode: v.mode, discarded, reconstruction: v.reconstruction ?? null };
            return name === 'task' ? taskCorrectivePrompt(text, undone, prd.manifest.id) : correctivePrompt(text, undone);
          }
        : null;
    // A with arm's session that exits 0 with the feature incomplete and resumable is continued by a fresh session, on
    // this phase's budget, at most MAX_CONTINUATIONS times in a row; a continuation that changed nothing ends it.
    let before = null;
    const continuation =
      arm === 'with'
        ? async (s, { bounded, budget }) => {
            if (s.exit_code !== 0) return null;
            const summary = mycelinkSummary(mycelinkRef);
            if (summary === null || summary.complete) return null;
            const read = () => featureNextAction({ control, mycelink: artifact, featureId: prd.manifest.id, workspace: ws, home, isolation });
            let status = read();
            // A live lease (await-worker), or a reviewer the session launched that still runs (await-reviewer, CSET-203 r13): wait for
            // it boundedly, with no model session, before a fresh one continues — a reviewer within what is left of its own wall-clock.
            let awaited = null;
            if (awaiting(status) && budget) {
              const reviewer = status.next_action.kind === 'await-reviewer' ? status.next_action.reviewer : null;
              const cap = reviewer !== null ? Math.min(awaitReviewer.maxMs, Math.max(0, (reviewer.remaining_ms ?? 0) + awaitReviewer.graceMs)) : awaitWorker.maxMs;
              const r = await awaitLiveLease({ read, digest: () => progressDigest(control, prd.manifest.id, repo, branch), pollMs: reviewer !== null ? awaitReviewer.pollMs : awaitWorker.pollMs, maxMs: Math.max(0, Math.min(cap, phaseDeadline - Date.now())) });
              awaited = { kind: reviewer !== null ? 'reviewer' : 'worker', polls: r.polls, waited_ms: r.waited_ms, until: r.until, ...(reviewer !== null ? { reviewer: reviewerBrief(reviewer) } : {}) };
              status = r.status ?? status;
              log(`session ${s.index} exited 0 with ${reviewer !== null ? 'its acceptance reviewer running (await-reviewer)' : 'a live dispatch lease (await-worker)'}: waited ${r.waited_ms} ms over ${r.polls} status read(s), ${r.until}`);
            }
            // A reviewer that did not complete before its session ended, or past its wall-clock (CSET-203 r13): Mycelink interrupts it
            // from Claude Code's own records, model-free, before a fresh session continues — its generation re-issued, nothing spent.
            let reviewerReconciled = null;
            const left = status?.next_action?.reviewer ?? null;
            if (left !== null && (left.state === 'LOST' || left.state === 'TIMED_OUT')) {
              try {
                reviewerReconciled = reviewerAwaitDispatch({ control, mycelink: artifact, featureId: prd.manifest.id, workspace: ws, home, isolation });
              } catch (error) {
                pollErrors.add(`reviewer reconcile: ${String(error?.message ?? error).split('\n')[0]}`);
              }
              if (reviewerReconciled !== null) {
                status = read() ?? status;
                log(`session ${s.index} left its acceptance reviewer ${left.state}: Mycelink interrupted it (${reviewerReconciled.state}, next ${reviewerReconciled.next})`);
              }
            }
            const now = progressDigest(control, prd.manifest.id, repo, branch);
            const entry = { phase: name, after_session: s.index, session: null, next_action: status?.next_action ?? null, ...(awaited !== null ? { awaited } : {}), ...(reviewerReconciled !== null ? { reviewer_reconciled: reviewerReconciled } : {}) };
            const outcome =
              s.continuation === true && before !== null && now === before
                ? 'no-progress'
                : bounded
                  ? 'bounded'
                  : !budget
                    ? 'budget'
                    : status === null || status.resumable !== true
                      ? 'not-resumable'
                      : 'resumed';
            if (outcome !== 'resumed') {
              record.continuations.push({ ...entry, outcome });
              log(`session ${s.index} exited 0 with ${prd.manifest.id} incomplete: not continued (${outcome})`);
              return null;
            }
            before = now;
            record.continuations.push({ ...entry, session: record.sessions.length + 1, outcome });
            log(`session ${s.index} exited 0 with ${prd.manifest.id} incomplete and resumable (${status.next_action.kind}): a fresh session continues it`);
            return { text: continuationPrompt(text, { feature_id: prd.manifest.id, incomplete: summary.incomplete, next_action: status.next_action }) };
          }
        : null;
    // A session the model provider ended (CSET-203 r10): Mycelink reconciles what it had in flight from Claude Code's records,
    // then a fresh session resumes on this phase's same deadline, told what was interrupted. No fault is injected again.
    const providerRecovery = async (s, { count }) => {
      const failure = s.provider_failure;
      const entry = { phase: name, session: s.index, class: failure.class, request_id: failure.request_id ?? null, category: failure.category ?? null, status: failure.status ?? null, count, remaining_ms: Math.max(0, phaseDeadline - Date.now()), reconciled: null, resumed_by: null, outcome: null };
      if (arm === 'with') {
        try {
          entry.reconciled = providerInterruptDispatch({ control, mycelink: artifact, featureId: prd.manifest.id, phase: name, workspace: ws, home, isolation });
        } catch (error) {
          pollErrors.add(`provider reconcile: ${String(error?.message ?? error).split('\n')[0]}`);
        }
        if (entry.reconciled?.outcome === 'PROVIDER_UNAVAILABLE') {
          entry.outcome = 'provider-unavailable';
          record.provider_recoveries.push(entry);
          log(`session ${s.index} ended by the model provider (${failure.class}): Mycelink stops PROVIDER_UNAVAILABLE`);
          return null;
        }
      }
      entry.outcome = 'resumed';
      entry.resumed_by = record.sessions.length + 1;
      record.provider_recoveries.push(entry);
      log(`session ${s.index} ended by the model provider (${failure.class}, exit ${s.exit_code}): ${entry.reconciled ? `Mycelink reconciled ${entry.reconciled.interrupted.length} lease(s); ` : ''}a fresh session resumes it (${count} of ${MAX_PROVIDER_RECOVERIES})`);
      const resumeText = arm === 'with' ? providerResumePrompt(text, { feature_id: prd.manifest.id, failure, reconciled: entry.reconciled, next_action: entry.reconciled?.next_action ?? null }) : resumePrompt(text);
      return { text: resumeText };
    };
    const p = await runPhase({ phase: name, prompt: text, deadline: phaseDeadline, start: session, corrective, continuation, providerRecovery });
    await settleSyncs();
    record.phases.push({ phase: name, sessions: p.sessions.map((x) => x.index), ended_by: p.ended_by, mycelink: arm === 'with' ? mycelinkSummary(mycelinkRef) : null });
    return p;
  };

  // ---- the task, and a fresh session after each evaluator interrupt while its budget lasts.
  await phase('task', prompt, runStart + budgetMs);

  // ---- session-end faults, in plan order.
  for (const f of faults.filter((x) => x.trigger.on === 'session-end')) {
    f.fired = true;
    if (MYCELINK_ONLY.has(f.kind)) {
      record.faults.push(replay(f.kind));
    } else if (f.kind === 'late-hidden-defect') {
      const head = revParse(repo, `refs/heads/${branch}`);
      const defect = head ? lateDefectPatch({ repo, start, head, adapter: project.adapter, prd: prd.manifest }) : null;
      if (!defect) {
        record.faults.push({ kind: f.kind, applied: false, detail: 'the delivery has no production change in a required module to break' });
        continue;
      }
      let injected;
      try {
        injected = injectJournaled((journal) => injectLateDefect({ repo, branch, patch: defect.patch, message: 'chore: sync platform changes', journal }));
      } catch (error) {
        record.faults.push({ kind: f.kind, applied: false, detail: `injection failed: ${String(error?.message ?? error).split('\n')[0]}` });
        continue;
      }
      injected.module = defect.module;
      // The public module (the case README's) and repository QA's report names, the same in both arms.
      const modulePath = project.adapter.modules.find((m) => m.id === defect.module)?.path ?? null;
      injected.affected = modulePath === null ? null : { module: defect.module, path: modulePath, repository: project.adapter.workspace.repo_dir };
      await settleSyncs();
      const evaluator = loadEvaluator({ cacheRoot, project, prdId: prd.manifest.id });
      const adapter = createAdapter(project.adapter);
      const ctx = { cacheRoot, toolchains: project.adapter.toolchain.cache.kind === 'none' ? null : loadToolchains(cacheRoot), isolation };
      // QA's runs happen outside the run directory and are removed again. QA compares the delivery
      // before and after the defect and reports only what the defect broke.
      const qaRoot = mkdtempSync(join(tmpdir(), 'bench-qa-'));
      let before;
      let qa;
      try {
        // QA judges each side on its trusted tree: the frozen tests and configuration, that side's production code.
        const trusted = (head) => trustedOverrides({ repo, start, head, adapter: project.adapter }).overrides;
        before = await runHiddenTests({ repo, head: injected.parent, evaluator, adapter, ctx, workRoot: join(qaRoot, 'before'), overrides: trusted(injected.parent) });
        qa = await runHiddenTests({ repo, head: injected.commit, evaluator, adapter, ctx, workRoot: join(qaRoot, 'after'), overrides: trusted(injected.commit) });
      } finally {
        rmSync(qaRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      const { broken, already_failing: alreadyFailing } = defectFailures({ before: before.summary, after: qa.summary });
      const failures = broken.map((t) => {
        const report = qa.out.results.find((r) => adapter.matches(r, t) && r.status === 'failed');
        return { name: t.name, status: t.status === 'not-run' ? `did not run (${qa.out.run.category})` : t.status, message: report?.message ?? null };
      });
      injected.reported = failures.map((x) => x.name);
      injected.already_failing = alreadyFailing;
      if (failures.length === 0) injected.detail = 'the defect broke no hidden check that passed before it: no QA report';
      log(`fault: late defect in ${defect.module}, ${failures.length} failing check(s)`);
      // QA's rework, resumed like the task: nothing is verified while the defect it reports awaits its repair.
      if (failures.length > 0) await phase('rework', lateDefectPrompt({ commit: injected.commit, failures, affected: injected.affected, original: prompt }), Date.now() + reworkMs);
    }
  }
  for (const f of faults) {
    if (f.kind === 'interrupt-restart') record.faults.push(interruptRecord(f, record.sessions));
    else if (!f.fired) record.faults.push({ kind: f.kind, applied: false, detail: 'the trigger never fired' });
  }
  // The model provider's part in the run: its recoveries, a stop past their bounds, a permanent failure, and each session's lineage.
  const permanent = record.sessions.find((s) => s.terminal === 'provider-permanent') ?? null;
  const byPhase = {};
  for (const r of record.provider_recoveries) if (r.outcome === 'resumed') byPhase[r.phase] = (byPhase[r.phase] ?? 0) + 1;
  record.provider = {
    recoveries: record.provider_recoveries.filter((r) => r.outcome === 'resumed').length,
    by_phase: byPhase,
    unavailable: record.phases.some((p) => p.ended_by === 'provider-unavailable'),
    permanent: permanent === null ? null : { session: permanent.index, purpose: permanent.purpose, class: permanent.provider_failure?.class ?? null, status: permanent.provider_failure?.status ?? null },
    lineage: record.sessions.map((s) => ({ session: s.index, resumes: s.resumes ?? null, provider_recovery: s.provider_recovery === true })),
  };
  record.poll_errors = [...pollErrors];
  // Every controller violation's rollback, attested again against the workspace as the run left it, before anything else reads it.
  if (arm === 'with' && controllerGuard) {
    try {
      record.controller_rollbacks = attestRollbacks({ sessions: record.sessions, workspace: ws, store: txnStore, previous: lastSnapshot });
    } catch (error) {
      record.controller_rollbacks = { ok: false, problems: [`the attestation failed: ${String(error?.message ?? error).split('\n')[0]}`], sessions: [] };
    }
  }
  if (proxy) {
    await proxy.stop();
    record.network = proxySummary(readFileSync(record.isolation.proxy.log, 'utf8').split('\n'));
  }
  // Every transcript the run left: each session's stream and every transcript under the session HOME (the workers' too).
  const transcriptSet = transcriptFiles({ streams: record.sessions.map((x) => x.transcript), dirs: [join(home, '.claude', 'projects')] });
  record.evaluator_access = { ...forbiddenAccess({ files: transcriptSet, roots: forbiddenRunRoots({ suiteRoot, cacheRoot, authoring: [...authoringRoots, ...(suitePin ? [suitePin.root] : [])] }), cwd: ws, home }), transcripts: transcriptSet.length };
  // The control arm saw no plugin, and the with arm loaded the sealed one only — or the run fails.
  const stderrLogs = record.sessions.map((x) => x.transcript.replace(/\.jsonl$/, '.stderr.log'));
  record.plugin_exposure = pluginExposure({ arm, dir: artifact.dir, args, binds: profile?.binds ?? [], files: [...transcriptSet, ...stderrLogs], cwd: ws, home });

  // ---- the verdict.
  log('verifying');
  const workRoot = mkdtempSync(join(tmpdir(), 'bench-arm-verify-'));
  let verification;
  try {
    // The session HOME is scanned for evaluator content too; transcript hits corroborate reference convergence.
    verification = await verifyDelivery({ suiteRoot, suitePin, caseKey, workspace: ws, cacheRoot, workRoot, faults: record.faults, requireMycelink: requireMycelink && arm === 'with', requireTdd, mycelink: artifact, isolation, scanRoots: [home], access: record.evaluator_access.hits });
  } finally {
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  writeFileSync(record.verification, JSON.stringify(verification, null, 2) + '\n');
  record.verified = verification.ok;
  record.mycelink = arm === 'with' ? mycelinkSummary(mycelinkRef) : null;
  record.controller = controllerReport({ arm, workspace: ws, phases: record.phases.map((p) => ({ ...p, sessions: p.sessions.map((i) => record.sessions[i - 1]) })) });
  record.workers = workerSummaries(transcriptSet, arm === 'with' ? mycelinkEvents(mycelinkRef) : []);
  // The plugin's acceptance reviewer, apart from the workers: its sessions, findings and usage (the with arm's treatment).
  record.reviewers = arm === 'with' ? reviewerSummaries(transcriptSet, mycelinkEvents(mycelinkRef)) : [];
  // Each reviewer's lifecycle as the sessions' own streams record it, beside Mycelink's account of it (CSET-203 r13).
  record.reviewer_lifecycle = arm === 'with' ? reviewerLifecycle({ sessions: record.sessions, events: mycelinkEvents(mycelinkRef) }) : null;
  // The review's revisions and every order rebased between them, proved from the control repository's own files (CSET-203 r14).
  record.review_revisions = arm === 'with' ? reviewRevisions(mycelinkRef) : null;
  record.ok = runOk({ record, verification });
  // The evidence apart from the delivery: trusted when every session ran inside the proved boundary, nothing
  // reached the evaluator or (in the without arm) the plugin, and the verdict itself can be relied on — whether
  // or not the model delivered. `ok` still needs both.
  const { verdict, trust, delivery } = runVerdict({ record, verification });
  record.verdict = verdict;
  record.trust = trust;
  record.delivery = delivery;
  record.trusted = trust.ok;
  record.finished_at = new Date().toISOString();
  writeRecord();
  return record;
}


/** The arms of the matrix, in the order they run: both orchestration arms, normal, then under the fault plan. */
export const MATRIX = [
  { arm: 'without', condition: 'normal' },
  { arm: 'with', condition: 'normal' },
  { arm: 'without', condition: 'faults' },
  { arm: 'with', condition: 'faults' },
];

/**
 * Why four run records do not form a matched comparison (empty: they do):
 * the same case, prompt, claude invocation (but for --plugin-dir in the with
 * arms), model and caps, plugin artifact, suite pin and isolation, the same
 * sandbox but for the plugin's bind in the with arms, and no plugin
 * exposure in any; the fault arms under the same plan, the normal arms
 * under none.
 */
export function matrixProblems(records) {
  const problems = [];
  if (records.length !== MATRIX.length) return [`${records.length} run(s), a matrix has ${MATRIX.length}`];
  for (const [i, want] of MATRIX.entries()) {
    if (records[i].arm !== want.arm || records[i].condition !== want.condition) problems.push(`run ${i + 1} is ${records[i].arm}/${records[i].condition}, expected ${want.arm}/${want.condition}`);
  }
  const strip = (args) => {
    const i = args.indexOf('--plugin-dir');
    return i < 0 ? args : [...args.slice(0, i), ...args.slice(i + 2)];
  };
  const same = (name, value) => {
    const values = records.map(value).map((v) => JSON.stringify(v ?? null));
    if (new Set(values).size > 1) problems.push(`${name} differs between arms: ${values.join(' / ')}`);
  };
  same('case', (r) => r.case);
  same('prompt_sha256', (r) => r.prompt_sha256);
  same('claude command', (r) => r.claude?.command);
  same('claude args (but --plugin-dir)', (r) => strip(r.claude?.args ?? []));
  same('model', (r) => r.model);
  same('budget_seconds', (r) => r.budget_seconds);
  same('rework_budget_seconds', (r) => r.rework_budget_seconds);
  same('max_budget_usd', (r) => r.max_budget_usd);
  same('plugin', (r) => r.plugin && { zip: r.plugin.zip_sha256, tree: r.plugin.tree_sha256 });
  same('suite pin', (r) => r.suite);
  same('isolation', (r) => r.isolation && { kind: r.isolation.kind, enforced: r.isolation.enforced, allow: r.isolation.proxy?.allow ?? null });
  // The sandboxes differ by the plugin's bind in the with arms and by nothing else (run-directory paths aside).
  same('sandbox (but the plugin)', (r) => {
    const p = r.isolation?.profile;
    if (!p) return null;
    const runDir = dirname(r.workspace ?? '');
    const place = (x) => (under(x, runDir) ? `<run>/${relative(runDir, x).split(/[\\/]/).join('/')}` : x);
    const binds = p.binds.filter((b) => !(r.arm === 'with' && b.path === r.plugin?.dir));
    const jvm = p.jvm_options ? p.jvm_options.replace(/^-Duser\.home=(.*)$/, (m, home) => `-Duser.home=${place(home)}`) : null;
    return { binds: binds.map((b) => ({ path: place(b.path), dest: place(b.dest ?? b.path), rw: Boolean(b.rw) })), path: p.path, jvm_options: jvm };
  });
  for (const r of records) {
    if ((r.arm === 'with') !== (r.claude?.args ?? []).includes('--plugin-dir')) problems.push(`the ${r.arm} arm ${r.arm === 'with' ? 'does not load' : 'loads'} the plugin`);
    if (!Array.isArray(r.plugin_exposure)) problems.push(`the ${r.arm} arm's record has no plugin exposure check`);
    else if (r.plugin_exposure.length) problems.push(`the ${r.arm} arm's record reports plugin exposure: ${r.plugin_exposure.slice(0, 3).join('; ')}`);
    const binds = r.isolation?.profile?.binds;
    const dir = r.plugin?.dir;
    if (!binds || !dir) continue;
    if (r.arm === 'with' && !binds.some((b) => b.path === dir && (b.dest ?? b.path) === dir && !b.rw)) problems.push("the with arm's sandbox does not bind the plugin read-only");
    const exposing = binds.flatMap((b) => [b.path, b.dest ?? b.path]).filter((x) => under(x, dir) || under(dir, x));
    if (r.arm !== 'with' && exposing.length) problems.push(`the without arm's sandbox binds the plugin: ${[...new Set(exposing)].join(', ')}`);
  }
  const plans = records.map((r) => r.fault_plan);
  if (plans[0] !== null || plans[1] !== null) problems.push('a normal arm ran under a fault plan');
  if (!plans[2] || plans[2] !== plans[3]) problems.push(`the fault arms ran under ${plans[2]} and ${plans[3]}`);
  return problems;
}

/**
 * One run of a matrix, as matrix.json keeps it: its verdict, trust problems
 * and delivery failures apart, its sessions (a with arm's continuation
 * sessions marked, and counted apart as `extra_sessions`), its
 * continuations, phases, controller record and worker summaries.
 */
export function matrixRunEntry(r, root) {
  const sessions = r.sessions ?? [];
  return {
    arm: r.arm,
    condition: r.condition,
    verdict: r.verdict,
    verified: r.verified ?? false,
    ok: r.ok,
    trusted: r.trusted,
    trust_problems: r.trust?.problems ?? [],
    delivery_failures: r.delivery?.failures ?? [],
    sessions: sessions.map((s) => ({ index: s.index, purpose: s.purpose, phase: s.phase ?? null, resumes: s.resumes ?? null, continuation: s.continuation === true, ended_by: s.ended_by, exit_code: s.exit_code, duration_ms: s.duration_ms, num_turns: s.result?.num_turns ?? null, cost_usd: s.result?.total_cost_usd ?? null, confined: s.confined, survivors: (s.survivors ?? []).length })),
    continuations: r.continuations ?? [],
    extra_sessions: sessions.filter((s) => s.continuation === true).length,
    provider_recoveries: (r.provider_recoveries ?? []).filter((x) => x.outcome === 'resumed').length,
    phases: (r.phases ?? []).map((p) => ({ phase: p.phase, sessions: p.sessions, ended_by: p.ended_by, mycelink: p.mycelink && { complete: p.mycelink.complete, candidate: p.mycelink.candidate, incomplete: p.mycelink.incomplete } })),
    controller: r.controller ?? null,
    mycelink: r.mycelink ?? null,
    workers: r.workers ?? [],
    reviewers: r.reviewers ?? [],
    run: join(root, `${r.arm}-${r.condition}`, 'run.json'),
  };
}

/**
 * Run the four arms of one case (MATRIX order) into `outDir`/<arm>-<condition>
 * with identical caps — every option but `faultPlan` and `outDir` goes to
 * every runArm unchanged — then check that they match. Writes matrix.json
 * and returns `{ matched, problems, verdicts, runs, trusted, records }`.
 * Each run entry keeps its verdict (verified, delivery-failed: the model's
 * delivery failed a gate, untrusted: the run's evidence does not hold), its
 * trust problems and delivery failures apart, and its sessions' and
 * workers' summaries. The matrix is trusted when it matched and every run's
 * evidence holds; a delivery failure is a result, not a broken comparison.
 */
export async function runMatrix({ faultPlan, outDir = null, ...common }) {
  if (!faultPlan) throw new Error('a matrix needs a fault plan for its fault arms');
  const root = resolve(outDir ?? join(mkdtempSync(join(tmpdir(), `bench-matrix-${common.caseKey}-`)), 'matrix'));
  mkdirSync(root, { recursive: true });
  const records = [];
  for (const { arm, condition } of MATRIX) {
    common.log?.(`matrix: ${arm} / ${condition}`);
    records.push(await runArm({ ...common, arm, faultPlan: condition === 'faults' ? faultPlan : null, outDir: join(root, `${arm}-${condition}`) }));
  }
  const problems = matrixProblems(records);
  const runs = records.map((r) => matrixRunEntry(r, root));
  // Trusted: the four runs match and every run's evidence holds — the comparison stands, whatever each arm delivered.
  const matrix = {
    schema: 'mycelink-bench/matrix@1',
    case: records[0]?.case ?? null,
    fault_plan: faultPlan.id,
    matched: problems.length === 0,
    problems,
    verdicts: Object.fromEntries(records.map((r) => [`${r.arm}-${r.condition}`, r.verdict])),
    runs,
    trusted: problems.length === 0 && records.every((r) => r.trusted),
  };
  writeFileSync(join(root, 'matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
  return { ...matrix, records };
}
