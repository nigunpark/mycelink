import type { FenceInput } from './fence.js';

/** Codex 0.163.0 documents Bash, apply_patch, spawn_agent and mcp__* tool names.
 * `shell` is an explicitly configured alias, not the documented canonical name.
 * Never accept unverified per-call agent_id/agent_type as a worker attestation.
 */
export function normalizeCodexHook(raw: unknown): FenceInput | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input['turn_id'] !== 'string' || typeof input['tool_name'] !== 'string' || input['tool_name'] === '' ||
      input['hook_event_name'] !== 'PreToolUse' || typeof input['cwd'] !== 'string' || input['cwd'] === '' ||
      input['tool_input'] === null || typeof input['tool_input'] !== 'object' || Array.isArray(input['tool_input'])) return null;
  if (['Bash', 'shell', 'apply_patch'].includes(input['tool_name']) &&
      typeof (input['tool_input'] as Record<string, unknown>)['command'] !== 'string') return null;
  return {
    provider: 'codex',
    tool_name: input['tool_name'] === 'shell' ? 'Bash' : input['tool_name'],
    tool_input: input['tool_input'] as Record<string, unknown>,
    cwd: input['cwd'],
    ...(typeof input['session_id'] === 'string' ? { session_id: input['session_id'] } : {}),
    ...(typeof input['tool_use_id'] === 'string' ? { tool_use_id: input['tool_use_id'] } : {}),
    ...(typeof input['transcript_path'] === 'string' ? { transcript_path: input['transcript_path'] } : {}),
  };
}

/** Exit 0 with JSON: an explicit supported denial, not Codex's fail-open error path. */
export function codexFenceOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
  } });
}
