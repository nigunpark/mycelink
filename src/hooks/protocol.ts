/** Host JSON is data, never an attestation of the caller's identity. */
import type { FenceInput, FenceDecision } from './fence.js';
import { normalizeClaudeHook } from './claude-protocol.js';
import { normalizeCodexHook, codexFenceOutput } from './codex-protocol.js';

export type HookProvider = 'claude' | 'codex';
export interface CanonicalHookCall { provider: HookProvider; call: FenceInput }

export function hookProvider(input: unknown): HookProvider {
  return input !== null && typeof input === 'object' && !Array.isArray(input) && 'turn_id' in input ? 'codex' : 'claude';
}

export function normalizeHookCall(input: unknown): CanonicalHookCall | null {
  if (hookProvider(input) === 'codex') {
    const call = normalizeCodexHook(input);
    return call === null ? null : { provider: 'codex', call };
  }
  const call = normalizeClaudeHook(input);
  return call === null ? null : { provider: 'claude', call };
}

/** Codex consumes a structured denial; Claude keeps its exit-2/stderr contract. */
export function codexDecisionOutput(decision: FenceDecision): string | null {
  return decision.ok ? null : codexFenceOutput(decision.reason);
}
