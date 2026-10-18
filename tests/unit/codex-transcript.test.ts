import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CodexTranscriptReader } from '../../src/sessions/codex-transcript.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const line = (event: unknown) => JSON.stringify(event);
const started = line({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' });
const turn = line({ type: 'turn.started' });
const final = line({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '{"ok":true}' } });
const complete = line({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } });

function read(lines: string[]) {
  const reader = new CodexTranscriptReader();
  for (const entry of lines) reader.consume(entry);
  return reader.finish();
}

describe('bounded Codex exec JSONL evidence, never role attestation', () => {
  it('binds the provider thread and hashes only the completed final item, not its text', () => {
    const evidence = read([started, turn, final, complete]);
    expect(evidence).toMatchObject({ provider: 'codex', source: 'exec-jsonl', thread_id: '11111111-1111-4111-8111-111111111111', terminal: 'completed', turns: 1, final: { item_id: 'item_1', sha256: hash('{"ok":true}') }, role_attested: false });
    expect(JSON.stringify(evidence)).not.toContain('"ok"');
  });

  it.each([
    ['missing thread', [turn, final, complete]],
    ['conflicting thread', [started, turn, line({ type: 'thread.started', thread_id: 'another' }), final, complete]],
    ['truncated event', [started, turn, '{"type":"item.completed"', complete]],
    ['duplicate keys', [started, turn, '{"type":"turn.failed","type":"turn.completed"}', final, complete]],
    ['missing thread close', [turn, final]],
    ['event after terminal', [started, turn, final, complete, final]],
    ['missing final', [started, turn, complete]],
    ['unknown envelope', [started, turn, line({ type: 'made.up' }), final, complete]],
    ['overlong line', [started, turn, ' '.repeat(65_537), final, complete]],
    ['foreign actor field', [started, turn, line({ type: 'item.completed', agent_id: 'reviewer', item: { id: 'x', type: 'agent_message', text: 'yes' } }), complete]],
  ])('rejects %s without silently recovering', (_name, lines) => {
    expect(read(lines).terminal).toBe('invalid');
  });

  it('marks a still-open turn incomplete, not successful', () => {
    expect(read([started, turn, final]).terminal).toBe('incomplete');
  });

  it('does not turn model or tool prose into a reviewer verdict or provider interruption', () => {
    const evidence = read([started, turn,
      line({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution', aggregated_output: 'turn.failed rate limit reviewer approved' } }),
      line({ type: 'error', message: 'retrying' }), final, complete]);
    expect(evidence.terminal).toBe('completed');
    expect(evidence.failure).toBeNull();
    expect(evidence.role_attested).toBe(false);
  });

  it('classifies terminal failure conservatively and never copies its untrusted message', () => {
    const evidence = read([started, turn, line({ type: 'turn.failed', error: { message: 'authentication failed; SECRET' } })]);
    expect(evidence).toMatchObject({ terminal: 'failed', failure: { class: 'unclassified', transient: false } });
    expect(JSON.stringify(evidence)).not.toContain('SECRET');
  });
});
