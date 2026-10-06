/**
 * Recorded product decisions.
 *
 * A decision counts as recorded only when `mycelink decision record` wrote
 * its event to the controller-owned audit log. DECISIONS.md is prose a model
 * can edit; events.jsonl is protected by the project hooks.
 */
import { readEvents } from './event-log.js';

export class DecisionNotRecordedError extends Error {
  constructor(decisionId: string) {
    super(
      `DECISION_NOT_RECORDED: decision "${decisionId}" has no recorded answer; ` +
        'record it with "mycelink decision record <feature> <decision-id> --answer ..." first.',
    );
    this.name = 'DecisionNotRecordedError';
  }
}

export function isDecisionRecorded(eventsLog: string, decisionId: string): boolean {
  return readEvents(eventsLog, { includeRotated: true, type: 'decision.recorded' }).some(
    (e) => (e.data as { decision_id?: unknown } | undefined)?.decision_id === decisionId,
  );
}

export function assertDecisionRecorded(eventsLog: string, decisionId: string): void {
  if (!isDecisionRecorded(eventsLog, decisionId)) throw new DecisionNotRecordedError(decisionId);
}
