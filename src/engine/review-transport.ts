/**
 * How an acceptance reviewer's verdict reaches the controller.
 *
 * CSET-203 r8: every product and verification node DONE; the first reviewer
 * of R001 wrote its verdict and was rightly sent back for AC-5's
 * compatibility trace; the corrective generations then answered the whole,
 * corrected verdict JSON as their final message — dispatch and inputs hashes
 * set to their own generation — and never called Write. Settle saw no verdict
 * (REVIEW_VERDICT_MISSING), twice, and blocked the feature REVIEW_INVALID.
 * Requiring a model both to produce the JSON and to invoke Write with it is
 * brittle, and the host already holds the subagent's complete final answer.
 *
 * So a reviewer's verdict reaches the controller one of two ways:
 *
 *  - `file`: it Writes the verdict file of its generation; the plugin's
 *    fence attests that Write (hooks/entrypoint.ts), as before;
 *  - `agent-result`: its final answer is exactly one JSON object — raw, or one
 *    ```json fence and nothing else. The controller takes it from Claude
 *    Code's own record of the Agent invocation it dispatched, never from the
 *    controller's prose: the plugin's fence records each launch of the
 *    reviewer subagent from the host session (the Agent call's tool_use id,
 *    the session and its transcript, the prompt's hash) in the open review
 *    generation's directory, where neither the controller nor a subagent may
 *    write; `review ingest` (and settle, which ingests first) finds that
 *    subagent's own transcript beside the session's, checks it is the
 *    reviewer that launch started (its meta, every entry's agent and
 *    session, the prompt), that the session's transcript records the launch
 *    and its completion, and takes its final answer — extracted strictly
 *    (extractReviewerResult) — as the generation's verdict: written to the
 *    designated verdict file only, exclusively and atomically, and attested
 *    like a Write, with the transcript's and the answer's hashes.
 *
 * Both ways judge the same verdict file the same way (settle). A reviewer
 * that Writes and also answers JSON must say the same verdict
 * (REVIEW_OUTPUT_CONFLICT otherwise). A final answer that is not exactly one
 * JSON object is refused for its form and corrected like any verdict; it is
 * never repaired or fished out of prose.
 *
 * CSET-203 r13: a launched reviewer has a lifecycle (reviewerLifecycle),
 * read from the same records, and a final answer is taken only once Claude
 * Code has made its completion durable. r13's refinement reviewers finished
 * in seconds while the host sat in `sleep 240`; Claude Code enqueued each
 * completion mid-turn (a `queue-operation`, then a `queued_command`
 * attachment once the turn absorbed it — never a user message), ingest knew
 * only the user message and answered "has not completed", and settle took
 * that for "no verdict" twice. Now: MISSING (no launch), RUNNING (no
 * completion yet: never a missing verdict, never a correction),
 * COMPLETED (its answer taken), COMPLETED_NO_OUTPUT (it completed with no
 * final answer: the only missing verdict), FAILED_PROVIDER (its last request
 * failed for the provider), LOST (its task ended without completing, or its
 * host session's process is gone) and TIMED_OUT (past the reviewer's
 * wall-clock from its launch). The subagent's own transcript is read only
 * once the completion is durable, so a line it is still writing is never
 * taken for a forgery.
 */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, readSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { openRegular, readRegular as readRegularFile } from '../security/paths.js';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { ATTESTATION_FILE, MAX_VERDICT_BYTES, REVIEWER_AGENT, VERDICT_FILE } from './acceptance-review.js';
import { transcriptFailure } from './provider-interrupt.js';
import { parseStrictJson } from '../security/strict-json.js';
import { stableStringify } from '../graph/validate.js';
import { createExclusive, writeTextAtomic } from '../state/atomic-json.js';
import { isProcessAlive, type ProcessIdentity } from '../util/process-identity.js';
import type { ProviderFailure } from '../sessions/provider-failure.js';

export { createExclusive };

/** A final answer's bytes: a verdict's bound, and room for one fence. */
export const MAX_RESULT_BYTES = MAX_VERDICT_BYTES + 4 * 1024;
/** Open objects and arrays at once in a final answer's JSON (a verdict nests five deep). */
export const MAX_RESULT_DEPTH = 32;

/** Why a final answer is not exactly one JSON object. */
export type ResultReason = 'empty' | 'too-large' | 'prose' | 'fence' | 'not-json' | 'trailing' | 'too-deep' | 'duplicate-key' | 'not-object';

export type ResultExtraction =
  | { ok: true; form: 'json' | 'fenced-json'; json: string; value: Record<string, unknown> }
  | { ok: false; code: 'REVIEW_RESULT_INVALID'; reason: ResultReason; detail: string; pointer: string };

const FENCE_OPEN = /^```json[ \t]*\r?\n/i;
const FENCE_CLOSE = /\r?\n[ \t]*```$/;
/** The rule a final answer is taken by, as reviewers, corrections and refusals state it. */
export const FINAL_ANSWER_RULE = 'Your final answer must be exactly one JSON object and nothing else: no text before or after it, no explanation, no summary, no heading, no second object (one ```json fence holding only that object is accepted too).';
const NO_PROSE = FINAL_ANSWER_RULE;

/** How a reviewer may return its verdict, as its brief and a correction's packet say it. */
export const REVIEWER_TRANSPORT = { accepted: ['agent-result', 'file'] as const, final_answer: FINAL_ANSWER_RULE, write: 'or Write the same verdict, whole, to the verdict file; both ways, it must be the same verdict' };

function refuse(reason: ResultReason, what: string, pointer = ''): ResultExtraction {
  return { ok: false, code: 'REVIEW_RESULT_INVALID', reason, detail: `the reviewer's final answer is not exactly one JSON object: ${what}. ${NO_PROSE}`, pointer };
}

/**
 * The verdict in a reviewer's final answer, when the whole answer (trimmed)
 * is exactly one JSON object, or one ```json fence holding only one: its
 * exact text and value. Anything else — prose before or after it, a
 * markdown explanation, a tool log, two objects, a truncated object, a
 * duplicate key, too many bytes or too deep — is refused, naming why and
 * never echoing the answer.
 */
export function extractReviewerResult(text: string): ResultExtraction {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_RESULT_BYTES) return refuse('too-large', `it is ${bytes} bytes, over its bound of ${MAX_RESULT_BYTES}`);
  const t = text.trim();
  if (t === '') return refuse('empty', 'it is empty');
  let body: string;
  let form: 'json' | 'fenced-json';
  if (t.startsWith('{')) {
    body = t;
    form = 'json';
  } else if (FENCE_OPEN.test(t)) {
    const rest = t.slice((FENCE_OPEN.exec(t) as RegExpExecArray)[0].length);
    const close = FENCE_CLOSE.exec(rest);
    if (close === null) return refuse('fence', 'its ```json fence is not the whole answer (text follows it, or it is never closed)');
    const inner = rest.slice(0, close.index);
    if (inner.includes('```')) return refuse('fence', 'it holds more than one fence');
    body = inner.trim();
    form = 'fenced-json';
    if (!body.startsWith('{')) return refuse('not-object', 'its fence does not hold a JSON object');
  } else return refuse('prose', 'it starts with text, not with the JSON object');
  const parsed = parseStrictJson(body, { maxBytes: MAX_RESULT_BYTES, maxDepth: MAX_RESULT_DEPTH });
  if (!parsed.ok) {
    const reason: ResultReason = parsed.code === 'JSON_TOO_LARGE' ? 'too-large' : parsed.code === 'JSON_TOO_DEEP' ? 'too-deep' : parsed.code === 'JSON_DUPLICATE_KEY' ? 'duplicate-key' : parsed.code === 'JSON_TRAILING' ? 'trailing' : 'not-json';
    const what =
      reason === 'trailing'
        ? 'more follows the JSON object (text, or a second object)'
        : reason === 'duplicate-key'
          ? `${parsed.pointer} appears twice in one object`
          : reason === 'too-deep'
            ? `it nests deeper than ${MAX_RESULT_DEPTH}`
            : reason === 'too-large'
              ? parsed.detail
              : `it is not valid JSON (${parsed.detail.slice(0, 160)}): a truncated or malformed object`;
    return refuse(reason, what, parsed.pointer);
  }
  const value = parsed.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse('not-object', 'its JSON is not an object');
  return { ok: true, form, json: body, value: value as Record<string, unknown> };
}

// ---- the reviewer's launch, recorded by the plugin's fence ---------------------

export const REVIEW_LAUNCH_SCHEMA = 'mycelink-review-launch/1';
/** A launch record's name in its generation's directory: `launch-<the Agent call's tool_use id>.json`. */
export const LAUNCH_FILE = /^launch-([A-Za-z0-9_-]{1,128})\.json$/;
/** Launch records one generation's directory is read for. */
export const MAX_LAUNCHES = 16;
/** A subagent's transcript, read whole. */
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
/** The host session's transcript, scanned line by line for the launch's own lines. */
export const MAX_SESSION_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SUBAGENT_ENTRIES = 4096;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REVIEWER_TYPES: ReadonlySet<string> = new Set([REVIEWER_AGENT, 'acceptance-reviewer']);

/**
 * One launch of the reviewer subagent from the host session, as the plugin's
 * PreToolUse fence recorded it when the Agent call was made: the open review
 * generation it was made for (and the orchestration epoch then), the call's
 * tool_use id, the session and its transcript, and the prompt's hash.
 */
export interface ReviewerLaunch {
  schema: typeof REVIEW_LAUNCH_SCHEMA;
  feature_id: string;
  review_id: string;
  dispatch_id: string;
  epoch: number | null;
  tool_use_id: string;
  session_id: string;
  /** The host session's transcript, as Claude Code named it in the hook's input ('/'-separated). */
  transcript_path: string;
  cwd: string | null;
  subagent_type: string;
  description: string | null;
  prompt_sha256: string;
  prompt_bytes: number;
  /** The dispatch a `Dispatch: <id>` line of the prompt names (a ticket's own prompt does), else null. */
  prompt_dispatch: string | null;
  at: string;
  /**
   * The host session's Claude Code process, by identity (util/process-identity.ts sessionHolder), when the hook could
   * verify it: a background subagent runs inside it, so once it is gone a reviewer that never completed is LOST.
   * Null or absent: nothing can prove its end, and only the reviewer's wall-clock ends it.
   */
  holder?: ProcessIdentity | null;
}

/** What an open review generation is, for its transport. */
export interface OpenGeneration {
  review_id: string;
  dispatch_id: string;
  issued_at: string;
  epoch?: number | undefined;
  /** Its verdict file, relative to the control root, '/'-separated. */
  slot: string;
}

export type TransportCode =
  | 'REVIEW_AGENT_NOT_LAUNCHED'
  | 'REVIEW_AGENT_WRONG_DISPATCH'
  | 'REVIEW_AGENT_NOT_REVIEWER'
  | 'REVIEW_TRANSCRIPT_MISSING'
  | 'REVIEW_TRANSCRIPT_INVALID'
  | 'REVIEW_RESULT_MISSING'
  | 'REVIEW_RESULT_MISMATCH'
  | 'REVIEW_OUTPUT_CONFLICT';

/** What proves a final answer is the output of the reviewer launched for a generation. */
export interface AgentEvidence {
  agent_id: string;
  agent_type: string;
  session_id: string;
  /** The host's Agent call. */
  tool_use_id: string;
  launch: { path: string; sha256: string; at: string; epoch: number | null };
  /** The subagent's own transcript: where, its hash, and the model and stop reason of its final message. */
  transcript: { path: string; sha256: string; bytes: number; entries: number; model: string | null; stop_reason: string | null };
  /** The host session's transcript, and when it records the launch and the completion. */
  session_transcript: { path: string; launched_at: string | null; completed_at: string | null };
  completion: AgentCompletion;
  result_sha256: string;
  result_bytes: number;
}

/**
 * How the host session records a launched agent's completion: a background
 * agent's task notification delivered as a turn of its own
 * (`task-notification`), the same notification enqueued while the host was
 * mid-turn — a queue operation, and the queued command's attachment once
 * the turn absorbed it (`queued-notification`, CSET-203 r13) — or a
 * foreground call's own result (`tool-result`).
 */
export type AgentCompletion = 'task-notification' | 'queued-notification' | 'tool-result';

export type AgentOutput =
  /** No launch of a reviewer is recorded for the generation. */
  | { kind: 'none'; detail: string }
  /** A reviewer was launched for it and has not finished. */
  | { kind: 'pending'; detail: string; agent_id: string | null }
  /** A launch is recorded, but what it left proves nothing (or something else). */
  | { kind: 'rejected'; code: TransportCode; detail: string }
  | { kind: 'found'; text: string; extraction: ResultExtraction; evidence: AgentEvidence };

/** Where a launched reviewer stands (reviewerLifecycle). */
export type ReviewerLifecycleState = 'MISSING' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_NO_OUTPUT' | 'FAILED_PROVIDER' | 'LOST' | 'TIMED_OUT' | 'REJECTED';

/** The Agent task a launch started, as the controller sees it: never its prompt or its answer. */
export interface ReviewerTask {
  tool_use_id: string;
  session_id: string;
  /** Claude Code's id of the subagent, once its records name it. */
  agent_id: string | null;
  /** When the plugin's fence recorded the launch: the wall-clock is counted from it. */
  launched_at: string;
  elapsed_ms: number;
  timeout_ms: number;
  remaining_ms: number;
  /** When Claude Code first recorded its completion (a notification, a foreground result), and how. */
  notified_at: string | null;
  notification: AgentCompletion | null;
  /** Whether the host session's process lives: null when nothing can tell. */
  holder_alive: boolean | null;
  launch: { path: string; sha256: string };
}

export type ReviewerLifecycle =
  | { state: 'MISSING'; detail: string }
  | { state: 'RUNNING'; detail: string; task: ReviewerTask }
  | { state: 'COMPLETED'; output: Extract<AgentOutput, { kind: 'found' }>; task: ReviewerTask }
  | { state: 'COMPLETED_NO_OUTPUT'; code: TransportCode; detail: string; task: ReviewerTask }
  | { state: 'FAILED_PROVIDER'; detail: string; task: ReviewerTask; failure: ProviderFailure | null }
  | { state: 'LOST'; reason: 'host-ended' | 'ended' | 'launch-failed'; status: string | null; detail: string; task: ReviewerTask }
  | { state: 'TIMED_OUT'; detail: string; task: ReviewerTask }
  | { state: 'REJECTED'; code: TransportCode; detail: string };

/** How long a launched reviewer may run, from its launch, before it is interrupted (acceptance_review.reviewer_timeout_seconds). */
export const DEFAULT_REVIEWER_TIMEOUT_MS = 20 * 60_000;

export interface LifecycleOptions {
  agentId?: string | undefined;
  hostText?: string | undefined;
  /** The reviewer's wall-clock (DEFAULT_REVIEWER_TIMEOUT_MS when absent). */
  timeoutMs?: number | undefined;
  /** Now, in ms since the epoch. */
  now?: number | undefined;
  /** Whether a recorded holder lives (util/process-identity.ts isProcessAlive): null when nothing can tell. */
  alive?: ((holder: ProcessIdentity) => boolean | null) | undefined;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const slash = (p: string): string => p.replace(/\\/g, '/');

/** The directory of a generation: its verdict file's. */
export function generationDir(controlRoot: string, open: Pick<OpenGeneration, 'slot'>): string {
  return join(controlRoot, ...dirname(open.slot).split('/'));
}

/** A small file read only when it is a regular file (never through a link), within its bound, through one descriptor. */
function readRegular(file: string, max: number): Buffer | null {
  return readRegularFile(file, max)?.bytes ?? null;
}

const isDirectoryNoLink = (dir: string): boolean => {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

/** Lines of a file holding any of `needles`, read in chunks within `max` bytes: `[lineNumber, text]`. */
function linesWith(file: string, needles: readonly string[], max: number): { lines: [number, string][]; tooLarge: boolean } | null {
  // One descriptor, opened without following a link: what is checked is what is read.
  const opened = openRegular(file);
  if (opened === null) return null;
  const { fd } = opened;
  if (opened.size > max) {
    closeSync(fd);
    return { lines: [], tooLarge: true };
  }
  const out: [number, string][] = [];
  try {
    const chunk = Buffer.alloc(1 << 20);
    let carry = Buffer.alloc(0);
    let line = 0;
    let read = 0;
    const take = (buf: Buffer): void => {
      line++;
      // Cheap test first: only lines naming the launch are decoded.
      if (needles.some((n) => buf.includes(n))) out.push([line, buf.toString('utf8')]);
    };
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      read += n;
      if (read > max) return { lines: [], tooLarge: true };
      let data = Buffer.concat([carry, chunk.subarray(0, n)]);
      let at = data.indexOf(0x0a);
      while (at >= 0) {
        take(data.subarray(0, at));
        data = data.subarray(at + 1);
        at = data.indexOf(0x0a);
      }
      carry = Buffer.from(data);
    }
    if (carry.length > 0) take(carry);
  } finally {
    closeSync(fd);
  }
  return { lines: out, tooLarge: false };
}

type Entry = Record<string, any>;
const parseLine = (text: string): Entry | null => {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Entry) : null;
  } catch {
    return null;
  }
};
/** A message's text: a string, or its text blocks. */
const messageText = (content: unknown): string | null =>
  typeof content === 'string'
    ? content
    : Array.isArray(content) && content.every((b) => b !== null && typeof b === 'object' && (b as Entry)['type'] === 'text' && typeof (b as Entry)['text'] === 'string')
      ? content.map((b) => (b as Entry)['text'] as string).join('\n')
      : null;
const contentOf = (e: Entry): Entry[] => (Array.isArray(e['message']?.['content']) ? (e['message']['content'] as Entry[]) : []);

/** A launch record, read and checked against the generation it is filed under. */
function launchOf(file: string, open: OpenGeneration): { ok: true; launch: ReviewerLaunch; sha256: string } | { ok: false; code: TransportCode; detail: string } {
  const bytes = readRegular(file, MAX_RECORD_BYTES);
  const parsed = bytes === null ? null : parseStrictJson(bytes.toString('utf8'), { maxBytes: MAX_RECORD_BYTES, maxDepth: 4 });
  const l = parsed !== null && parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? (parsed.value as Entry) : null;
  if (l === null || l['schema'] !== REVIEW_LAUNCH_SCHEMA) return { ok: false, code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `${basename(file)} is not a launch record the plugin's fence wrote` };
  for (const k of ['tool_use_id', 'session_id']) if (typeof l[k] !== 'string' || !ID.test(l[k] as string)) return { ok: false, code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `${basename(file)} names no valid ${k}` };
  const launch = l as unknown as ReviewerLaunch;
  if (launch.review_id !== open.review_id || launch.dispatch_id !== open.dispatch_id) {
    return { ok: false, code: 'REVIEW_AGENT_WRONG_DISPATCH', detail: `the reviewer launched by ${launch.tool_use_id} was launched for ${String(launch.review_id).slice(0, 40)} generation ${String(launch.dispatch_id).slice(0, 40)}, not ${open.review_id} generation ${open.dispatch_id}` };
  }
  if (launch.prompt_dispatch !== null && launch.prompt_dispatch !== open.dispatch_id) {
    return { ok: false, code: 'REVIEW_AGENT_WRONG_DISPATCH', detail: `the reviewer launched by ${launch.tool_use_id} was given the prompt of generation ${String(launch.prompt_dispatch).slice(0, 40)}, not ${open.dispatch_id}` };
  }
  if (typeof launch.at !== 'string' || !(launch.at >= open.issued_at)) {
    return { ok: false, code: 'REVIEW_AGENT_WRONG_DISPATCH', detail: `the reviewer launched by ${launch.tool_use_id} was launched before generation ${open.dispatch_id} was handed out` };
  }
  if (open.epoch !== undefined && launch.epoch !== null && launch.epoch !== open.epoch) {
    return { ok: false, code: 'REVIEW_AGENT_WRONG_DISPATCH', detail: `the reviewer launched by ${launch.tool_use_id} was launched at orchestration epoch ${String(launch.epoch)}, not ${open.epoch}` };
  }
  if (!REVIEWER_TYPES.has(String(launch.subagent_type))) return { ok: false, code: 'REVIEW_AGENT_NOT_REVIEWER', detail: `the Agent call ${launch.tool_use_id} launched ${String(launch.subagent_type).slice(0, 80)}, not ${REVIEWER_AGENT}` };
  if (typeof launch.transcript_path !== 'string' || !isAbsolute(launch.transcript_path) || basename(launch.transcript_path) !== `${launch.session_id}.jsonl` || typeof launch.prompt_sha256 !== 'string') {
    return { ok: false, code: 'REVIEW_TRANSCRIPT_INVALID', detail: `the launch ${launch.tool_use_id} names no transcript of its session ${launch.session_id}` };
  }
  return { ok: true, launch, sha256: sha256(bytes as Buffer) };
}

const fileKind = (f: string): 'file' | 'missing' | 'other' => {
  try {
    return lstatSync(f).isFile() ? 'file' : 'other';
  } catch {
    return 'missing';
  }
};

/** One completion notification as the host session recorded it: whose, of which Agent call, its status, when, and in which form. */
interface Notification {
  task_id: string;
  tool_use_id: string | null;
  status: string;
  at: string | null;
  form: 'task-notification' | 'queued-notification';
}

const NOTIFICATION_OPEN = '<task-notification>';

/**
 * A task notification's own header — its task id, Agent call and status —
 * when `text` is exactly one notification (it opens with the tag). Only what
 * precedes the agent's `<summary>` and `<result>` is read: an answer quoting a
 * notification of another agent (a worker's, a reviewer's) never names it.
 */
function notificationHeader(text: string): { task_id: string; tool_use_id: string | null; status: string } | null {
  const t = text.trimStart();
  if (!t.startsWith(NOTIFICATION_OPEN)) return null;
  const cut = [t.indexOf('<summary>'), t.indexOf('<result>'), t.indexOf('</task-notification>')].filter((i) => i > 0);
  const head = t.slice(0, cut.length > 0 ? Math.min(...cut) : Math.min(t.length, 4096));
  const task = /^<task-notification>\s*<task-id>([A-Za-z0-9_-]{1,64})<\/task-id>/.exec(head)?.[1];
  const status = /<status>([a-z_-]{1,32})<\/status>/.exec(head)?.[1];
  if (task === undefined || status === undefined) return null;
  return { task_id: task, tool_use_id: /<tool-use-id>([A-Za-z0-9_-]{1,128})<\/tool-use-id>/.exec(head)?.[1] ?? null, status };
}

/**
 * Every completion notification the host session's own entries record: a
 * user turn of its own (a notification delivered while the host was idle),
 * a queue operation (one enqueued while it was mid-turn, CSET-203 r13; its
 * removal once absorbed), or the queued command's attachment. Never a tool
 * result, an assistant's text or a subagent's entry.
 */
function notificationsIn(entries: readonly Entry[]): Notification[] {
  const out: Notification[] = [];
  for (const e of entries) {
    let text: string | null = null;
    let form: Notification['form'] = 'task-notification';
    if (e['type'] === 'user') {
      text = messageText(e['message']?.['content']);
    } else if (e['type'] === 'queue-operation' && (e['operation'] === 'enqueue' || e['operation'] === 'remove' || e['operation'] === 'dequeue') && typeof e['content'] === 'string') {
      text = e['content'] as string;
      form = 'queued-notification';
    } else if (e['type'] === 'attachment' && e['attachment']?.['type'] === 'queued_command' && typeof e['attachment']?.['prompt'] === 'string') {
      text = e['attachment']['prompt'] as string;
      form = 'queued-notification';
    }
    if (text === null) continue;
    const h = notificationHeader(text);
    if (h === null) continue;
    out.push({ ...h, at: typeof e['timestamp'] === 'string' ? (e['timestamp'] as string) : null, form });
  }
  return out;
}

/** The host's Agent call and what the session records of it, read once per launch. */
interface SessionRecord {
  launched: Entry | undefined;
  use: Entry | undefined;
  resulted: Entry | undefined;
  toolResult: Entry;
  resultText: string;
  resultError: boolean;
  /** The agent the session names for the call (its launch result), else null. */
  named: string | null;
  notifications: Notification[];
}

function sessionRecord(sessionFile: string, U: string, S: string): SessionRecord | { code: TransportCode; detail: string } {
  const scanned = linesWith(sessionFile, [U, NOTIFICATION_OPEN], MAX_SESSION_TRANSCRIPT_BYTES);
  if (scanned === null) return { code: 'REVIEW_TRANSCRIPT_MISSING', detail: `the host session's transcript ${slash(sessionFile)} is not a regular file` };
  if (scanned.tooLarge) return { code: 'REVIEW_TRANSCRIPT_INVALID', detail: `the host session's transcript is over ${MAX_SESSION_TRANSCRIPT_BYTES} bytes` };
  const entries = scanned.lines.map(([, t]) => parseLine(t)).filter((e): e is Entry => e !== null && e['isSidechain'] !== true && (e['sessionId'] === undefined || e['sessionId'] === S));
  const launched = entries.find((e) => e['type'] === 'assistant' && contentOf(e).some((b) => b['type'] === 'tool_use' && b['id'] === U));
  const use = launched === undefined ? undefined : contentOf(launched).find((b) => b['type'] === 'tool_use' && b['id'] === U);
  const resulted = entries.find((e) => e['type'] === 'user' && contentOf(e).some((b) => b['type'] === 'tool_result' && b['tool_use_id'] === U));
  const blocks = resulted === undefined ? [] : contentOf(resulted).filter((b) => b['type'] === 'tool_result' && b['tool_use_id'] === U);
  const toolResult = (resulted?.['toolUseResult'] ?? resulted?.['tool_use_result'] ?? {}) as Entry;
  const resultText = blocks.map((b) => messageText(b['content']) ?? (typeof b['content'] === 'string' ? (b['content'] as string) : '')).join('\n');
  const named = typeof toolResult['agentId'] === 'string' ? (toolResult['agentId'] as string) : (/\bagentId: ([A-Za-z0-9_-]{1,64})\b/.exec(resultText)?.[1] ?? null);
  return { launched, use, resulted, toolResult, resultText, resultError: blocks.some((b) => b['is_error'] === true), named, notifications: notificationsIn(entries) };
}

/**
 * Where a host's Agent call stands in its own session's transcript, whatever
 * the agent's type (a module-worker's launch: engine/worker-lifecycle.ts),
 * read as a reviewer's is: whether the session records the call, and whether
 * it finished — a notification of it (the last one speaks, whatever its
 * status), a foreground call's result, or an error answering the call. Null
 * when the transcript cannot be read.
 */
export function agentCallStanding(sessionFile: string, U: string, S: string): { recorded: boolean; finished: boolean; status: string | null; agent: string | null } | null {
  const record = sessionRecord(sessionFile, U, S);
  if (!('notifications' in record)) return null;
  const agent = record.named;
  const mine = record.notifications.filter((n) => n.tool_use_id === U || (n.tool_use_id === null && agent !== null && n.task_id === agent));
  const last = mine[mine.length - 1];
  const foreground = record.toolResult['status'] === 'completed';
  return {
    recorded: record.use !== undefined,
    finished: last !== undefined || record.resultError || foreground,
    status: last?.status ?? (record.resultError ? 'error' : foreground ? 'completed' : null),
    agent,
  };
}

/** The plugin's record of the agent an Agent call started (hooks/agent-task.ts), beside its launch: its agent id, else null. */
function boundAgent(file: string, U: string): string | null {
  const bytes = readRegular(join(dirname(file), `agent-${U}.json`), MAX_RECORD_BYTES);
  if (bytes === null) return null;
  const r = parseLine(bytes.toString('utf8'));
  return r !== null && r['tool_use_id'] === U && typeof r['agent_id'] === 'string' && AGENT_ID.test(r['agent_id'] as string) ? (r['agent_id'] as string) : null;
}

/** The subagent whose meta names the call, beside the session's transcript, never through a link: its id, null when none yet. */
function metaOwner(subagents: string, U: string): { agent: string | null } | { code: TransportCode; detail: string } {
  if (!isDirectoryNoLink(subagents)) return { agent: null };
  const metas = readdirSync(subagents)
    .filter((n) => /^agent-[A-Za-z0-9_-]{1,64}\.meta\.json$/.test(n))
    .slice(0, MAX_SUBAGENT_ENTRIES);
  const owners = metas.filter((n) => {
    const b = readRegular(join(subagents, n), MAX_RECORD_BYTES);
    return b !== null && parseLine(b.toString('utf8'))?.['toolUseId'] === U;
  });
  if (owners.length > 1) return { code: 'REVIEW_TRANSCRIPT_INVALID', detail: `${owners.length} subagents name the call ${U}` };
  return { agent: owners.length === 0 ? null : (owners[0] as string).slice('agent-'.length, -'.meta.json'.length) };
}

/** The final answer of a reviewer whose completion is durable, read from its own files: found, no output, or why it proves nothing. */
function finalAnswer(
  controlRoot: string,
  open: OpenGeneration,
  file: string,
  checked: { launch: ReviewerLaunch; sha256: string },
  record: SessionRecord,
  agent: string,
  completion: { form: AgentCompletion; at: string | null },
  options: LifecycleOptions,
): { kind: 'found'; output: Extract<AgentOutput, { kind: 'found' }> } | { kind: 'no-output'; code: TransportCode; detail: string } | { kind: 'provider'; detail: string; failure: ProviderFailure } | { kind: 'rejected'; code: TransportCode; detail: string } {
  const L = checked.launch;
  const U = L.tool_use_id;
  const S = L.session_id;
  const sessionDir = join(dirname(L.transcript_path), S);
  const subagents = join(sessionDir, 'subagents');
  if (!isDirectoryNoLink(sessionDir) || !isDirectoryNoLink(subagents)) return { kind: 'rejected', code: 'REVIEW_TRANSCRIPT_MISSING', detail: `the session ${S} keeps no subagent transcripts beside its own` };
  const metaFile = join(subagents, `agent-${agent}.meta.json`);
  const txFile = join(subagents, `agent-${agent}.jsonl`);
  if (fileKind(metaFile) !== 'file' || fileKind(txFile) !== 'file') return { kind: 'rejected', code: fileKind(metaFile) === 'missing' || fileKind(txFile) === 'missing' ? 'REVIEW_TRANSCRIPT_MISSING' : 'REVIEW_TRANSCRIPT_INVALID', detail: `agent ${agent} completed, but its transcript or meta is not a regular file of its session` };
  const meta = parseLine((readRegular(metaFile, MAX_RECORD_BYTES) ?? Buffer.from('')).toString('utf8'));
  if (meta === null) return { kind: 'rejected', code: 'REVIEW_TRANSCRIPT_INVALID', detail: `the meta of agent ${agent} is unreadable` };
  if (!REVIEWER_TYPES.has(String(meta['agentType']))) return { kind: 'rejected', code: 'REVIEW_AGENT_NOT_REVIEWER', detail: `agent ${agent} is ${String(meta['agentType']).slice(0, 80)}, not ${REVIEWER_AGENT}` };
  if (meta['toolUseId'] !== U) return { kind: 'rejected', code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `agent ${agent} was launched by another call than ${U}` };

  const bytes = readRegular(txFile, MAX_TRANSCRIPT_BYTES);
  if (bytes === null) return { kind: 'rejected', code: 'REVIEW_TRANSCRIPT_INVALID', detail: `the transcript of agent ${agent} is over ${MAX_TRANSCRIPT_BYTES} bytes or unreadable` };
  const tx: Entry[] = [];
  for (const l of bytes.toString('utf8').split('\n')) {
    if (l.trim() === '') continue;
    const e = parseLine(l);
    if (e === null) return { kind: 'rejected', code: 'REVIEW_TRANSCRIPT_INVALID', detail: `the transcript of agent ${agent} holds a line that is not a JSON object` };
    tx.push(e);
  }
  for (const e of tx) {
    const foreign = (e['agentId'] !== undefined && e['agentId'] !== agent) || (e['sessionId'] !== undefined && e['sessionId'] !== S);
    const unbound = (e['type'] === 'user' || e['type'] === 'assistant') && (e['isSidechain'] !== true || e['agentId'] !== agent);
    if (foreign || unbound) return { kind: 'rejected', code: 'REVIEW_TRANSCRIPT_INVALID', detail: `the transcript of agent ${agent} holds an entry of another agent, session or thread` };
    if (e['type'] === 'assistant' && e['attributionAgent'] !== undefined && !REVIEWER_TYPES.has(String(e['attributionAgent']))) {
      return { kind: 'rejected', code: 'REVIEW_AGENT_NOT_REVIEWER', detail: `a message of agent ${agent} is attributed to ${String(e['attributionAgent']).slice(0, 80)}` };
    }
  }
  const messages = tx.filter((e) => e['type'] === 'user' || e['type'] === 'assistant');
  const first = messages[0];
  if (first === undefined || first['type'] !== 'user' || sha256(messageText(first['message']?.['content']) ?? '') !== L.prompt_sha256) {
    return { kind: 'rejected', code: 'REVIEW_TRANSCRIPT_INVALID', detail: `the transcript of agent ${agent} does not open with the prompt the host launched it with` };
  }
  // The subagent itself started once the generation was handed out.
  if (typeof first['timestamp'] === 'string' && first['timestamp'] < open.issued_at) {
    return { kind: 'rejected', code: 'REVIEW_AGENT_WRONG_DISPATCH', detail: `agent ${agent} started before generation ${open.dispatch_id} was handed out` };
  }

  // Its final answer: the text of its last message, which calls no tool.
  const last = messages[messages.length - 1] as Entry;
  if (last['type'] !== 'assistant') return { kind: 'no-output', code: 'REVIEW_RESULT_MISSING', detail: `agent ${agent} completed without a final answer` };
  // Claude Code's own record of a failed request (CSET-203 r10: a provider refusal) is no answer of the reviewer's.
  if ((last['isApiErrorMessage'] === true || last['is_api_error_message'] === true) && last['message']?.['model'] === '<synthetic>') {
    const failure = transcriptFailure(txFile, L.at);
    if (failure !== null) return { kind: 'provider', detail: `agent ${agent}'s last request failed for the model provider (${failure.class}): it left no final answer`, failure };
    return { kind: 'no-output', code: 'REVIEW_RESULT_MISSING', detail: `agent ${agent}'s last request failed (Claude Code recorded an API error, not an answer): it left no final answer` };
  }
  const id = last['message']?.['id'];
  const final: Entry[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const e = messages[i] as Entry;
    if (e['type'] !== 'assistant' || (id !== undefined && e['message']?.['id'] !== id)) break;
    final.unshift(e);
    if (id === undefined) break;
  }
  const blocks = final.flatMap((e) => contentOf(e));
  if (blocks.some((b) => b['type'] === 'tool_use')) return { kind: 'no-output', code: 'REVIEW_RESULT_MISSING', detail: `agent ${agent}'s last message calls a tool: it left no final answer` };
  const texts = blocks.filter((b) => b['type'] === 'text' && typeof b['text'] === 'string').map((b) => b['text'] as string);
  const text = texts.join('\n');
  if (text.trim() === '') return { kind: 'no-output', code: 'REVIEW_RESULT_MISSING', detail: `agent ${agent}'s last message holds no text: it left no final answer` };
  const extraction = extractReviewerResult(text);

  // A host's copy of the answer is only ever the transcript's own.
  if (options.hostText !== undefined && options.hostText.trim() !== text.trim()) {
    const copy = extractReviewerResult(options.hostText);
    const same = copy.ok && extraction.ok && stableStringify(copy.value) === stableStringify(extraction.value);
    if (!same) return { kind: 'rejected', code: 'REVIEW_RESULT_MISMATCH', detail: `the result given is not agent ${agent}'s final answer as its transcript records it` };
  }
  const stops = final.map((e) => e['message']?.['stop_reason']).filter((s): s is string => typeof s === 'string');
  const model = final.map((e) => e['message']?.['model']).find((m): m is string => typeof m === 'string') ?? null;
  return {
    kind: 'found',
    output: {
      kind: 'found',
      text,
      extraction,
      evidence: {
        agent_id: agent,
        agent_type: String(meta['agentType']),
        session_id: S,
        tool_use_id: U,
        launch: { path: slash(file.slice(controlRoot.length + 1)), sha256: checked.sha256, at: L.at, epoch: L.epoch },
        transcript: { path: slash(txFile), sha256: sha256(bytes), bytes: bytes.length, entries: tx.length, model, stop_reason: stops[stops.length - 1] ?? null },
        session_transcript: { path: slash(L.transcript_path), launched_at: typeof record.launched?.['timestamp'] === 'string' ? (record.launched['timestamp'] as string) : null, completed_at: completion.at },
        completion: completion.form,
        result_sha256: sha256(text),
        result_bytes: Buffer.byteLength(text, 'utf8'),
      },
    },
  };
}

const defaultAlive = (holder: ProcessIdentity): boolean | null => {
  try {
    return isProcessAlive(holder);
  } catch {
    return null;
  }
};

/** A launch record's holder, when it is a well-formed process identity. */
function holderOf(l: ReviewerLaunch): ProcessIdentity | null {
  const h = l.holder;
  if (h === null || h === undefined || typeof h !== 'object') return null;
  if (!Number.isInteger(h.pid) || h.pid <= 0 || typeof h.start !== 'string' || typeof h.host !== 'string' || typeof h.platform !== 'string' || (h.boot !== null && typeof h.boot !== 'string')) return null;
  return h;
}

/**
 * Where the reviewer one launch record names stands, from Claude Code's own
 * records (and the plugin's, which only it writes): the host session's
 * transcript holds that Agent call (the reviewer type, the prompt the fence
 * hashed) and its result; the session records its completion — a
 * notification of that agent and that call, in any of the forms Claude Code
 * keeps (notificationsIn), or a foreground call's result. Only then is the
 * subagent's meta and transcript read (finalAnswer): its meta names the
 * reviewer type and the call; its transcript is the subagent's alone and
 * opens with that prompt; its last message is a final answer. Not completed:
 * its last request failed for the provider (FAILED_PROVIDER), its task
 * ended otherwise or its launch failed (LOST), its host's process is gone
 * (LOST), it is past its wall-clock (TIMED_OUT), else RUNNING. Nothing is
 * followed through a link, and nothing outside the session's own directory
 * is read.
 */
function launchLifecycle(controlRoot: string, open: OpenGeneration, file: string, options: LifecycleOptions): ReviewerLifecycle {
  const checked = launchOf(file, open);
  if (!checked.ok) return { state: 'REJECTED', code: checked.code, detail: checked.detail };
  const L = checked.launch;
  const U = L.tool_use_id;
  const S = L.session_id;
  const now = options.now ?? Date.now();
  const timeout = options.timeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  const launchedAt = Date.parse(L.at);
  const elapsed = Number.isFinite(launchedAt) ? Math.max(0, now - launchedAt) : 0;

  const record = sessionRecord(L.transcript_path, U, S);
  if (!('notifications' in record)) return { state: 'REJECTED', code: record.code, detail: record.detail };
  if (record.use === undefined) return { state: 'REJECTED', code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `the host session's transcript records no Agent call ${U}` };
  const input = (record.use['input'] ?? {}) as Entry;
  if (!['Agent', 'Task'].includes(String(record.use['name'])) || !REVIEWER_TYPES.has(String(input['subagent_type'])) || typeof input['prompt'] !== 'string' || sha256(input['prompt'] as string) !== L.prompt_sha256) {
    return { state: 'REJECTED', code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `the host session's call ${U} is not the reviewer launch the fence recorded (its tool, subagent type or prompt differ)` };
  }
  if (record.named !== null && options.agentId !== undefined && record.named !== options.agentId) {
    return { state: 'REJECTED', code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `the call ${U} launched agent ${record.named}, not ${options.agentId.slice(0, 64)}` };
  }
  // The agent: as the session's record of the call names it, else the plugin's record of it, else the subagent whose meta names the call.
  const bound = boundAgent(file, U);
  if (record.named !== null && bound !== null && bound !== record.named) {
    return { state: 'REJECTED', code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `the plugin's record of the call ${U} names another agent than the session's` };
  }
  let agent = record.named ?? bound ?? options.agentId ?? null;
  const ofCall = record.notifications.filter((n) => n.tool_use_id === U || (n.tool_use_id === null && agent !== null && n.task_id === agent));
  if (agent === null && ofCall.length > 0) agent = (ofCall[0] as Notification).task_id;
  if (agent === null) {
    const owner = metaOwner(join(dirname(L.transcript_path), S, 'subagents'), U);
    if ('code' in owner) return { state: 'REJECTED', code: owner.code, detail: owner.detail };
    agent = owner.agent;
  }
  if (agent !== null && !AGENT_ID.test(agent)) return { state: 'REJECTED', code: 'REVIEW_TRANSCRIPT_INVALID', detail: 'the agent id is not one Claude Code makes' };
  const mine = agent === null ? [] : ofCall.filter((n) => n.task_id === agent);
  if (ofCall.some((n) => n.task_id !== agent)) return { state: 'REJECTED', code: 'REVIEW_AGENT_NOT_LAUNCHED', detail: `the session records the completion of the call ${U} for another agent than ${String(agent)}` };

  // Completion, as the session records it: the last notification's status (a resumed agent notifies again), a foreground call's result.
  const lastNote = mine[mine.length - 1];
  const completedNotes = mine.filter((n) => n.status === 'completed');
  const foreground = record.toolResult['status'] === 'completed' && !record.resultError;
  const completed = (lastNote !== undefined && lastNote.status === 'completed') || (lastNote === undefined && foreground);
  const firstAt = (list: Notification[]): string | null => list.map((n) => n.at).filter((t): t is string => t !== null).sort()[0] ?? null;
  const notifiedAt = completed ? (lastNote !== undefined ? firstAt(completedNotes) : typeof record.resulted?.['timestamp'] === 'string' ? (record.resulted['timestamp'] as string) : null) : null;
  const form: AgentCompletion | null = completed ? (lastNote !== undefined ? ((completedNotes.find((n) => n.at === notifiedAt) ?? lastNote).form) : 'tool-result') : null;
  const holder = holderOf(L);
  const alive = completed || holder === null ? null : (options.alive ?? defaultAlive)(holder);
  const task: ReviewerTask = {
    tool_use_id: U,
    session_id: S,
    agent_id: agent,
    launched_at: L.at,
    elapsed_ms: elapsed,
    timeout_ms: timeout,
    remaining_ms: Math.max(0, timeout - elapsed),
    notified_at: notifiedAt,
    notification: form,
    holder_alive: alive,
    launch: { path: slash(file.slice(controlRoot.length + 1)), sha256: checked.sha256 },
  };
  const subagentTx = agent === null ? null : join(dirname(L.transcript_path), S, 'subagents', `agent-${agent}.jsonl`);
  const providerFailure = (): ProviderFailure | null => (subagentTx !== null && fileKind(subagentTx) === 'file' ? transcriptFailure(subagentTx, L.at) : null);

  if (!completed) {
    if (record.resultError && lastNote === undefined) return { state: 'LOST', reason: 'launch-failed', status: null, detail: `the Agent call ${U} answered an error: no reviewer was started`, task };
    if (lastNote !== undefined) {
      const failure = providerFailure();
      if (failure !== null) return { state: 'FAILED_PROVIDER', detail: `agent ${String(agent)} ended ${lastNote.status}: its last request failed for the model provider (${failure.class})`, task, failure };
      return { state: 'LOST', reason: 'ended', status: lastNote.status, detail: `agent ${String(agent)} ended ${lastNote.status} without completing`, task };
    }
    const failure = providerFailure();
    if (failure !== null) return { state: 'FAILED_PROVIDER', detail: `agent ${String(agent)}'s last request failed for the model provider (${failure.class})`, task, failure };
    if (alive === false) return { state: 'LOST', reason: 'host-ended', status: null, detail: `the host session that launched agent ${String(agent)} (call ${U}) ended before it completed`, task };
    if (elapsed > timeout) return { state: 'TIMED_OUT', detail: `agent ${String(agent)} has run ${Math.round(elapsed / 1000)} s since its launch, past the reviewer's wall-clock of ${Math.round(timeout / 1000)} s`, task };
    return { state: 'RUNNING', detail: agent === null ? `the reviewer launched by ${U} has not completed` : `agent ${agent} has not completed`, task };
  }
  if (agent === null) return { state: 'REJECTED', code: 'REVIEW_TRANSCRIPT_MISSING', detail: `the call ${U} completed, but nothing names the agent it started` };
  const answered = finalAnswer(controlRoot, open, file, checked, record, agent, { form: form as AgentCompletion, at: notifiedAt }, options);
  if (answered.kind === 'rejected') return { state: 'REJECTED', code: answered.code, detail: answered.detail };
  if (answered.kind === 'provider') return { state: 'FAILED_PROVIDER', detail: answered.detail, task, failure: answered.failure };
  if (answered.kind === 'no-output') return { state: 'COMPLETED_NO_OUTPUT', code: answered.code, detail: answered.detail, task };
  return { state: 'COMPLETED', output: answered.output, task };
}

/** Launch records of an open generation, in name order. */
function launchNames(controlRoot: string, open: Pick<OpenGeneration, 'slot'>): string[] {
  const dir = generationDir(controlRoot, open);
  try {
    return isDirectoryNoLink(dir) ? readdirSync(dir).filter((n) => LAUNCH_FILE.test(n)).sort() : [];
  } catch {
    return [];
  }
}

/** Which of several launches' standings speaks for the generation, first to last. */
const PRECEDENCE: ReviewerLifecycleState[] = ['COMPLETED', 'RUNNING', 'COMPLETED_NO_OUTPUT', 'FAILED_PROVIDER', 'TIMED_OUT', 'LOST', 'REJECTED'];

/**
 * Where the reviewer launched for an open generation stands
 * (launchLifecycle), from every launch recorded in the generation's
 * directory: a completed final answer (several only when they are the same
 * verdict: REVIEW_OUTPUT_CONFLICT otherwise); else a reviewer still running;
 * else one that completed with no answer; else one the provider ended, one
 * past its wall-clock, one lost; else why none counts. No launch: MISSING.
 * `agentId` takes only that agent's answer; `hostText` is a copy the host
 * holds, which must be the transcript's.
 */
export function reviewerLifecycle(controlRoot: string, open: OpenGeneration, options: LifecycleOptions = {}): ReviewerLifecycle {
  const names = launchNames(controlRoot, open);
  if (names.length === 0) return { state: 'MISSING', detail: `no launch of ${REVIEWER_AGENT} from the host session is recorded for ${open.review_id} generation ${open.dispatch_id}` };
  const dir = generationDir(controlRoot, open);
  const outcomes = names.slice(0, MAX_LAUNCHES).map((n) => launchLifecycle(controlRoot, open, join(dir, n), options));
  const found = outcomes.filter((o): o is Extract<ReviewerLifecycle, { state: 'COMPLETED' }> => o.state === 'COMPLETED' && (options.agentId === undefined || o.output.evidence.agent_id === options.agentId));
  if (found.length > 0) {
    const verdicts = new Set(found.map((f) => (f.output.extraction.ok ? `json:${stableStringify(f.output.extraction.value)}` : `text:${f.output.text.trim()}`)));
    if (verdicts.size > 1) {
      return { state: 'REJECTED', code: 'REVIEW_OUTPUT_CONFLICT', detail: `${found.length} reviewers launched for ${open.review_id} generation ${open.dispatch_id} answered ${verdicts.size} different verdicts (${found.map((f) => f.output.evidence.agent_id).join(', ')})` };
    }
    return found[0] as ReviewerLifecycle;
  }
  for (const state of PRECEDENCE.slice(1)) {
    const o = outcomes.find((x) => x.state === state);
    if (o !== undefined) return o;
  }
  return outcomes[0] as ReviewerLifecycle;
}

/**
 * The final answer of the reviewer launched for an open generation, with
 * what proves it, as the transport takes it (reviewerLifecycle): `found`
 * once its completion is durable; `pending` while it runs; `none` with no
 * launch; `rejected` for anything else (it ended without an answer, it
 * proves nothing, or something else).
 */
export function reviewerOutput(controlRoot: string, open: OpenGeneration, options: LifecycleOptions = {}): AgentOutput {
  const l = reviewerLifecycle(controlRoot, open, options);
  switch (l.state) {
    case 'COMPLETED':
      return l.output;
    case 'MISSING':
      return { kind: 'none', detail: l.detail };
    case 'RUNNING':
      return { kind: 'pending', detail: l.detail, agent_id: l.task.agent_id };
    case 'REJECTED':
    case 'COMPLETED_NO_OUTPUT':
      return { kind: 'rejected', code: l.code, detail: l.detail };
    default:
      return { kind: 'rejected', code: 'REVIEW_RESULT_MISSING', detail: l.detail };
  }
}

// ---- the ingested verdict, written --------------------------------------------

/**
 * A generation's directory, when it is exactly the generation's under the
 * control root's review area, with no link anywhere on the way; else why not.
 */
export function safeGenerationDir(controlRoot: string, open: Pick<OpenGeneration, 'slot'>): { ok: true; dir: string } | { ok: false; detail: string } {
  const dir = generationDir(controlRoot, open);
  const fold = (p: string): string => (process.platform === 'win32' ? slash(p).toLowerCase() : slash(p));
  if (!/^\.mycelink\/reviews\/[^/]+\/[^/]+\/[0-9a-f-]{36}\/verdict\.json$/.test(open.slot)) return { ok: false, detail: `${open.slot} is not a verdict file of the control root's review area` };
  try {
    const real = realpathSync.native(dir);
    const expected = join(realpathSync.native(controlRoot), ...dirname(open.slot).split('/'));
    if (!isDirectoryNoLink(dir) || fold(real) !== fold(expected)) return { ok: false, detail: `the generation's directory ${dirname(open.slot)} is not a plain directory of the control root's review area` };
  } catch {
    return { ok: false, detail: `the generation's directory ${dirname(open.slot)} does not exist` };
  }
  return { ok: true, dir };
}

/**
 * Write an ingested verdict into its generation's directory, and nowhere
 * else (safeGenerationDir): the verdict file is created exclusively and
 * atomically (createExclusive) — never over a file a reviewer wrote — and
 * only then attested (the attestation replaced atomically), so a lost race
 * leaves the reviewer's own write and attestation as they were. `exists`: a
 * verdict file is already there.
 */
export function writeIngestedVerdict(args: { controlRoot: string; open: Pick<OpenGeneration, 'slot'>; content: string; attestation: Record<string, unknown> }): { written: true } | { written: false; reason: 'exists' } | { written: false; reason: 'unsafe'; detail: string } {
  const safe = safeGenerationDir(args.controlRoot, args.open);
  if (!safe.ok) return { written: false, reason: 'unsafe', detail: safe.detail };
  const verdict = join(safe.dir, VERDICT_FILE);
  if (fileKind(verdict) !== 'missing') return { written: false, reason: 'exists' };
  if (createExclusive(verdict, args.content) === 'exists') return { written: false, reason: 'exists' };
  writeTextAtomic(join(safe.dir, ATTESTATION_FILE), JSON.stringify(args.attestation, null, 2) + '\n');
  return { written: true };
}

/** Attest a verdict file already ingested (an ingest that died between its two writes), in its generation's directory only. */
export function writeIngestAttestation(controlRoot: string, open: Pick<OpenGeneration, 'slot'>, attestation: Record<string, unknown>): boolean {
  const safe = safeGenerationDir(controlRoot, open);
  if (!safe.ok) return false;
  writeTextAtomic(join(safe.dir, ATTESTATION_FILE), JSON.stringify(attestation, null, 2) + '\n');
  return true;
}
