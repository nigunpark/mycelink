import { describe, expect, it } from 'vitest';
import { normalizeHookCall, hookProvider, codexDecisionOutput } from '../../src/hooks/protocol.js';

describe('host hook protocol fixtures', () => {
  const base = { session_id: 'session-1', cwd: 'C:/project', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } };
  it('normalizes equivalent Claude and Codex shell calls without assigning Codex an agent role', () => {
    const claude = normalizeHookCall({ ...base, agent_id: 'agent-1', agent_type: 'module-worker' });
    const codex = normalizeHookCall({ ...base, turn_id: 'turn-1', agent_id: 'agent-1', agent_type: 'module-worker' });
    expect(claude?.call.tool_input).toEqual(codex?.call.tool_input);
    expect(claude?.call.tool_name).toBe(codex?.call.tool_name);
    expect(codex).toMatchObject({ provider: 'codex', call: { session_id: 'session-1', tool_name: 'Bash', provider: 'codex' } });
    expect(codex?.call.agent_id).toBeUndefined();
  });
  it('maps a configured shell alias but not an unknown mutating tool', () => {
    expect(normalizeHookCall({ ...base, turn_id: 'turn-1', tool_name: 'shell' })?.call.tool_name).toBe('Bash');
    expect(normalizeHookCall({ ...base, turn_id: 'turn-1', tool_name: 'mcp__write' })?.call.tool_name).toBe('mcp__write');
  });
  it('rejects malformed Codex tool input instead of erasing a command', () => {
    expect(normalizeHookCall({ ...base, turn_id: 'turn-1', tool_input: 'pwd' })).toBeNull();
    expect(normalizeHookCall({ ...base, turn_id: 'turn-1', tool_input: {} })).toBeNull();
    expect(hookProvider({ ...base, turn_id: null })).toBe('codex');
  });
  it('emits only supported Codex PreToolUse fields and no unsupported continue flag', () => {
    expect(JSON.parse(codexDecisionOutput({ ok: false, reason: 'Blocked: test' })!)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked: test' } });
    expect(codexDecisionOutput({ ok: true })).toBeNull();
  });
});
