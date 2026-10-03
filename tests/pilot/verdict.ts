/**
 * The real-Claude pilot's pass/fail rule, as a pure function so it can be
 * tested without model usage.
 *
 * The pilot node is implementable, so the only acceptable endings are:
 *
 *  - DONE, backed by a structured worker result, a RED that failed because
 *    the behaviour was missing, and a passing GREEN on the same command; or
 *  - NEEDS_DECISION, backed by a structured result whose decision request
 *    has a real question and at least two options (a justified product
 *    decision, not a shrug).
 *
 * Anything else — RESULT_MISSING above all — is a failed pilot, however
 * cleanly the session exited.
 */

export interface PilotEvidence {
  exit_code: number;
  red_reason?: string;
  command?: string[];
}

export interface PilotWorkerResult {
  outcome: string;
  decision_request?: { question: string; options: string[] } | null;
}

export interface PilotObservation {
  final_state: string | undefined;
  /** The controller's report detail, e.g. RESULT_MISSING. */
  detail: string;
  /** The structured result the controller accepted, or null if none. */
  worker_result: PilotWorkerResult | null;
  red: PilotEvidence | null;
  green: PilotEvidence | null;
}

export interface PilotVerdict {
  ok: boolean;
  reasons: string[];
}

export function pilotVerdict(o: PilotObservation): PilotVerdict {
  const reasons: string[] = [];
  if (o.worker_result === null) {
    reasons.push(`no structured result from the worker (${o.detail || 'no detail'})`);
  }

  if (o.final_state === 'DONE') {
    if (o.red?.red_reason !== 'behaviour-missing' || o.red.exit_code === 0) {
      reasons.push('DONE without a behaviour-missing RED');
    }
    if (o.green?.exit_code !== 0) reasons.push('DONE without a passing GREEN');
    if (JSON.stringify(o.green?.command) !== JSON.stringify(o.red?.command)) {
      reasons.push('GREEN command differs from RED command');
    }
  } else if (o.final_state === 'NEEDS_DECISION') {
    const request = o.worker_result?.decision_request;
    const justified =
      o.worker_result?.outcome === 'NEEDS_DECISION' &&
      typeof request?.question === 'string' &&
      request.question.trim() !== '' &&
      Array.isArray(request.options) &&
      request.options.length >= 2;
    if (!justified) reasons.push('NEEDS_DECISION without a real question and at least two options');
  } else {
    reasons.push(`implementable node ended ${String(o.final_state)} (${o.detail || 'no detail'})`);
  }
  return { ok: reasons.length === 0, reasons };
}
