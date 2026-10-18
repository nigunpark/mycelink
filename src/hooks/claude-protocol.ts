import type { FenceInput } from './fence.js';

/** Claude hook input is kept byte-for-byte compatible for the existing fence. */
export function normalizeClaudeHook(raw: unknown): FenceInput | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input['tool_name'] !== 'string' || input['tool_name'] === '') return null;
  return input as FenceInput;
}
