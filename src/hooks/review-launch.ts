/**
 * The launch of the acceptance reviewer, recorded where only Mycelink writes.
 *
 * When the host session calls the Agent tool for `mycelink:acceptance-reviewer`
 * the plugin's PreToolUse fence (hooks/fence.ts) lets the call through and
 * this records it in the directory of the review generation it was made
 * for (`.mycelink/reviews/<feature>/<review>/<dispatch>/launch-<tool_use
 * id>.json`): the call's tool_use id, the session and its transcript as
 * Claude Code named them to the hook, the prompt's hash, the generation and
 * the orchestration epoch then, and (CSET-203 r13) the host session's Claude
 * Code process by identity, when the hook can verify it: a background
 * reviewer runs inside that process, so once it is gone a reviewer that
 * never completed is lost. A reviewer's final answer is later taken as its
 * verdict only through such a record (engine/review-transport.ts): the
 * controller cannot write there, nor can a subagent.
 *
 * The generation is the open one whose dispatch the prompt's `Dispatch:`
 * line names (a ticket's own prompt), else the one open generation the
 * prompt mentions, else the only open review generation near the session. A
 * prompt naming a generation that is not open is recorded against the open
 * one with that name kept (`prompt_dispatch`), and never counts for it. A
 * call nothing can place is not recorded; the reviewer may still Write its
 * verdict. Recording never blocks the call.
 *
 * One reviewer per generation (CSET-203 r13): a launch for a generation
 * whose reviewer is still running, or has answered, is refused by the fence
 * (duplicateReviewerLaunch) — the host waits for the one it launched.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadState } from '../state/feature-state.js';
import { currentEpoch } from '../state/orchestration.js';
import { isSafeFeatureId } from '../security/names.js';
import { DEFAULT_REVIEWER_TIMEOUT_MS, REVIEW_LAUNCH_SCHEMA, createExclusive, reviewerLifecycle, safeGenerationDir, type ReviewerLaunch } from '../engine/review-transport.js';
import { VERDICT_FILE } from '../engine/acceptance-review.js';
import { controlRoots, type ReviewerLaunchCall } from './fence.js';
import { sessionHolder, type ProcessIdentity } from '../util/process-identity.js';
import type { OpenReview } from '../model/types.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DISPATCH_LINE = /^Dispatch: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m;

/** The open review generation a reviewer launch is for. */
interface Placed {
  root: string;
  featureId: string;
  open: OpenReview;
  epoch: number;
  timeoutMs: number;
  /** The dispatch the prompt's `Dispatch:` line names, else null. */
  named: string | null;
}

/** The open generation a host's reviewer Agent call is for (see above), or null when nothing places it. */
function placeLaunch(call: ReviewerLaunchCall, env: NodeJS.ProcessEnv): Placed | null {
  if (!ID.test(call.tool_use_id) || !ID.test(call.session_id) || !isAbsolute(call.transcript_path) || basename(call.transcript_path) !== `${call.session_id}.jsonl`) return null;
  const open: Omit<Placed, 'named'>[] = [];
  for (const root of controlRoots([call.cwd, env['CLAUDE_PROJECT_DIR'], env['MYCELINK_CONTROL_ROOT']], [])) {
    let features: string[] = [];
    try {
      features = readdirSync(join(root, 'features')).filter(isSafeFeatureId);
    } catch {
      continue;
    }
    for (const featureId of features) {
      try {
        const state = loadState(join(root, 'features', featureId))?.data;
        const o = state?.acceptance_review?.open ?? null;
        const t = state?.acceptance_review?.reviewer_timeout_ms;
        if (state && o !== null) open.push({ root, featureId, open: o, epoch: currentEpoch(state), timeoutMs: typeof t === 'number' && t > 0 ? t : DEFAULT_REVIEWER_TIMEOUT_MS });
      } catch {
        continue;
      }
    }
  }
  const named = DISPATCH_LINE.exec(call.prompt)?.[1] ?? null;
  const mentioned = open.filter((c) => call.prompt.includes(c.open.dispatch_id));
  const chosen = (named !== null ? open.find((c) => c.open.dispatch_id === named) : undefined) ?? (mentioned.length === 1 ? mentioned[0] : undefined) ?? (open.length === 1 ? open[0] : undefined);
  return chosen === undefined ? null : { ...chosen, named };
}

/** The host session's Claude Code process, when the hook can verify it (util/process-identity.ts); null otherwise. */
function holderOf(env: NodeJS.ProcessEnv): ProcessIdentity | null {
  try {
    return sessionHolder(env);
  } catch {
    return null;
  }
}

/** Record one reviewer launch; the record's path, or null when nothing could place it. */
export function recordReviewerLaunch(call: ReviewerLaunchCall, env: NodeJS.ProcessEnv): string | null {
  const chosen = placeLaunch(call, env);
  if (chosen === null) return null;
  const safe = safeGenerationDir(chosen.root, chosen.open);
  if (!safe.ok) return null;
  const record: ReviewerLaunch = {
    schema: REVIEW_LAUNCH_SCHEMA,
    feature_id: chosen.featureId,
    review_id: chosen.open.review_id,
    dispatch_id: chosen.open.dispatch_id,
    epoch: chosen.epoch,
    tool_use_id: call.tool_use_id,
    session_id: call.session_id,
    transcript_path: call.transcript_path.replace(/\\/g, '/'),
    cwd: call.cwd.replace(/\\/g, '/'),
    subagent_type: call.subagent_type,
    description: call.description === null ? null : call.description.slice(0, 200),
    prompt_sha256: createHash('sha256').update(call.prompt).digest('hex'),
    prompt_bytes: Buffer.byteLength(call.prompt, 'utf8'),
    prompt_dispatch: chosen.named,
    at: new Date().toISOString(),
    holder: holderOf(env),
  };
  const file = join(safe.dir, `launch-${call.tool_use_id}.json`);
  createExclusive(file, JSON.stringify(record, null, 2) + '\n');
  return file;
}

/**
 * Why a host's reviewer launch is refused (CSET-203 r13: one reviewer per
 * generation, never a second while the first runs): the generation it is
 * for already has a reviewer running, or one that answered (or a verdict
 * written); null when it may be launched — no reviewer yet, or each earlier
 * one was lost, timed out or never started. Never throws: a launch nothing
 * can judge goes through, and the launch records still decide what counts.
 */
export function duplicateReviewerLaunch(call: ReviewerLaunchCall, env: NodeJS.ProcessEnv): string | null {
  try {
    const chosen = placeLaunch(call, env);
    if (chosen === null || (chosen.named !== null && chosen.named !== chosen.open.dispatch_id)) return null;
    const safe = safeGenerationDir(chosen.root, chosen.open);
    if (!safe.ok) return null;
    const { review_id: review, dispatch_id: dispatch } = chosen.open;
    const awaitLine = `review await ${chosen.featureId} --review ${review}`;
    if (existsSync(join(safe.dir, VERDICT_FILE))) return `Blocked: the reviewer of ${review} generation ${dispatch} already answered (its verdict file is written): run its ticket's ingest and settle lines; never launch a second reviewer for one generation.`;
    const life = reviewerLifecycle(chosen.root, chosen.open, { timeoutMs: chosen.timeoutMs });
    if (life.state === 'RUNNING') {
      return `Blocked: a reviewer of ${review} generation ${dispatch} is already running (launched at ${life.task.launched_at}, ${Math.round(life.task.elapsed_ms / 1000)} s of its ${Math.round(life.task.timeout_ms / 1000)} s wall-clock): wait for it — run its ticket's await line (${awaitLine}) until it completes, then its ingest and settle lines. Never launch a second reviewer for one generation.`;
    }
    if (life.state === 'COMPLETED' || life.state === 'COMPLETED_NO_OUTPUT') {
      return `Blocked: the reviewer of ${review} generation ${dispatch} already answered (it completed): run its ticket's ingest and settle lines; dispatch hands out a fresh generation when one is needed. Never launch a second reviewer for one generation.`;
    }
    return null;
  } catch {
    return null;
  }
}
