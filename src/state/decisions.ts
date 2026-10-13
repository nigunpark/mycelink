/**
 * Recorded product decisions.
 *
 * A decision counts as recorded only when `mycelink decision record` wrote
 * its event to the controller-owned audit log. DECISIONS.md is prose a model
 * can edit; events.jsonl is protected by the project hooks.
 */
import { appendEvent, readEvents } from './event-log.js';

export class DecisionNotRecordedError extends Error {
  constructor(decisionId: string) {
    super(
      `DECISION_NOT_RECORDED: decision "${decisionId}" has no recorded answer; ` +
        'record it with "mycelink decision record <feature> <decision-id> --answer ..." first.',
    );
    this.name = 'DecisionNotRecordedError';
  }
}

export class DecisionAlreadyAppliedError extends Error {
  constructor(decisionId: string) {
    super(
      `DECISION_ALREADY_APPLIED: decision "${decisionId}" was already used to unblock work; record a new decision for a new problem.`,
    );
    this.name = 'DecisionAlreadyAppliedError';
  }
}

export function isDecisionApplied(eventsLog: string, decisionId: string): boolean {
  return readEvents(eventsLog, { includeRotated: true, type: 'decision.applied' }).some(
    (e) => (e.data as { decision_id?: unknown } | undefined)?.decision_id === decisionId,
  );
}

/**
 * A recorded decision unblocks once. Replaying an old answer against a node
 * that blocked again later, for whatever reason, is refused.
 */
export function assertDecisionUsable(eventsLog: string, decisionId: string): void {
  assertDecisionRecorded(eventsLog, decisionId);
  if (isDecisionApplied(eventsLog, decisionId)) throw new DecisionAlreadyAppliedError(decisionId);
}

/** Mark a decision as used, in the protected audit log. */
export function markDecisionApplied(eventsLog: string, featureId: string, decisionId: string, use: string): void {
  appendEvent(eventsLog, {
    idempotency_key: `decision.applied:${decisionId}`,
    type: 'decision.applied',
    actor: 'mycelink',
    feature_id: featureId,
    data: { decision_id: decisionId, use },
  });
}

export function isDecisionRecorded(eventsLog: string, decisionId: string): boolean {
  return readEvents(eventsLog, { includeRotated: true, type: 'decision.recorded' }).some(
    (e) => (e.data as { decision_id?: unknown } | undefined)?.decision_id === decisionId,
  );
}

export function assertDecisionRecorded(eventsLog: string, decisionId: string): void {
  if (!isDecisionRecorded(eventsLog, decisionId)) throw new DecisionNotRecordedError(decisionId);
}
