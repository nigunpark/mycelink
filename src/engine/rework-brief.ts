/**
 * The rework brief: what a controller-authorized `node rework --reason`
 * hands the next worker of the reopened node.
 *
 * A reworked node's own suite passed when its work was found wrong, so
 * without the reason a worker has nothing to write a failing test from. The
 * brief carries the reason (bounded, free of control characters, redacted of
 * credential shapes, never the controller key), the acceptance criteria and
 * evidence it refers to, the rework generation and limit, and what it
 * replaced. It is stored with the node in STATE.json under the controller's
 * rework, bound to the rework's history entry and record by the reason's
 * hash, and re-checked before it is handed to a worker. A worker receives it
 * only inside the context pack, as data.
 */
import { createHash } from 'node:crypto';
import type { FeatureState_, NodeRuntime, PortfolioGraph, ReworkBrief } from '../model/types.js';
import { redactText } from '../security/redact.js';
import { holdsControllerKey } from './authority.js';

/** Largest reason, in UTF-8 bytes, a rework may carry to a worker. */
export const MAX_REWORK_REASON_BYTES = 2000;
/** Most evidence references one rework may name. */
export const MAX_REWORK_REFERENCES = 8;

/**
 * C0/C1 controls (newline and tab are allowed), line and paragraph
 * separators, and bidirectional overrides: none belongs in a failure report,
 * and each can change how the text reads to a model or a terminal.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** A workspace- or repository-relative evidence reference: no absolute path, no `..`, no shell metacharacters. */
const EVIDENCE_REF = /^[A-Za-z0-9_][A-Za-z0-9_.@#/-]{0,199}$/;

export type ReworkBriefCode = 'REWORK_REASON_TOO_LONG' | 'REWORK_REASON_INVALID' | 'REWORK_REASON_UNSAFE' | 'REWORK_REFERENCE_INVALID' | 'REWORK_BRIEF_INVALID';

export class ReworkBriefError extends Error {
  readonly code: ReworkBriefCode;
  constructor(code: ReworkBriefCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ReworkBriefError';
    this.code = code;
  }
}

export function reasonSha256(reason: string): string {
  return createHash('sha256').update(reason, 'utf8').digest('hex');
}

/**
 * The reason exactly as it will be stored and shown: trimmed, bounded, and
 * redacted. Refused, not cleaned, when it carries control characters or the
 * controller's key: such a reason is a mistake or an attack, and a silently
 * altered one would not be what the controller authorized.
 */
export function admitReworkReason(raw: string, controlRoot: string): string {
  const reason = raw.trim();
  const bytes = Buffer.byteLength(reason, 'utf8');
  if (bytes > MAX_REWORK_REASON_BYTES) {
    throw new ReworkBriefError(
      'REWORK_REASON_TOO_LONG',
      `the reason is ${bytes} bytes; keep it to ${MAX_REWORK_REASON_BYTES} (state the failing check and point at its evidence with --evidence).`,
    );
  }
  if (UNSAFE_CHARS.test(reason)) {
    throw new ReworkBriefError('REWORK_REASON_INVALID', 'the reason contains control, separator or bidirectional-override characters.');
  }
  if (holdsControllerKey(controlRoot, reason)) {
    throw new ReworkBriefError('REWORK_REASON_UNSAFE', 'the reason contains the controller key; it is handed to a worker and must never carry authority.');
  }
  return redactText(reason);
}

/** The acceptance criteria a rework names: those passed explicitly, and those the reason mentions. */
export function reworkAcceptance(graph: PortfolioGraph, reason: string, explicit: readonly string[]): string[] {
  const known = graph.acceptance_criteria.map((a) => a.id);
  const unknown = explicit.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new ReworkBriefError('REWORK_REFERENCE_INVALID', `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not acceptance criteria of this feature.`);
  }
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return known.filter((id) => explicit.includes(id) || new RegExp(`(^|[^A-Za-z0-9-])${escape(id)}([^A-Za-z0-9-]|$)`).test(reason));
}

export function reworkEvidence(refs: readonly string[]): string[] {
  if (refs.length > MAX_REWORK_REFERENCES) {
    throw new ReworkBriefError('REWORK_REFERENCE_INVALID', `at most ${MAX_REWORK_REFERENCES} evidence references.`);
  }
  for (const ref of refs) {
    if (!EVIDENCE_REF.test(ref) || ref.split('/').includes('..')) {
      throw new ReworkBriefError('REWORK_REFERENCE_INVALID', `${JSON.stringify(ref.slice(0, 80))} is not a relative evidence path.`);
    }
  }
  return [...new Set(refs)];
}

/**
 * The brief, re-checked against the rework that recorded it. Null when the
 * node is not in a rework. A brief that does not match its own hash, its
 * history entry or the feature's rework record is never handed to a worker.
 */
export function verifiedReworkBrief(state: FeatureState_, nodeId: string): ReworkBrief | null {
  const runtime = state.nodes[nodeId] as NodeRuntime | undefined;
  const brief = runtime?.rework_brief ?? null;
  if (brief === null || runtime === undefined) return null;
  const fail = (detail: string): never => {
    throw new ReworkBriefError('REWORK_BRIEF_INVALID', `${nodeId}: ${detail}; re-run node rework, or record a decision.`);
  };
  if (reasonSha256(brief.reason) !== brief.reason_sha256) fail('the rework brief does not match its recorded hash');
  const history = runtime.rework_history ?? [];
  const entry = history[brief.generation - 1];
  if (brief.generation !== history.length || entry === undefined || entry.reason !== brief.reason || entry.at !== brief.at) {
    fail('the rework brief does not match the rework history');
  }
  const recorded = (state.reworks ?? []).some((r) => r.node_id === nodeId && r.at === brief.at && r.reason === brief.reason);
  if (!recorded) fail('the rework brief has no matching rework record');
  if (Buffer.byteLength(brief.reason, 'utf8') > MAX_REWORK_REASON_BYTES || brief.evidence.length > MAX_REWORK_REFERENCES) {
    fail('the rework brief is over its bounds');
  }
  return brief;
}
