import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from '../../src/sessions/provider-stream.js';
import { zeroObservationUsage } from '../../src/sessions/adapter.js';

describe('Claude JSONL parser', () => {
  it('counts assistant events and prefers terminal totals without double counting', () => {
    const parser = new ClaudeStreamParser();
    const progress = { turns: 0, usage: zeroObservationUsage() };
    parser.consume('not json', progress);
    parser.consume(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 2 } } }), progress);
    parser.consume(JSON.stringify({ type: 'result', num_turns: 3, usage: { input_tokens: 12, output_tokens: 7 } }), progress);
    expect(progress.turns).toBe(3);
    expect(progress.usage.input_tokens).toBe(12);
    expect(progress.usage.output_tokens).toBe(7);
  });
});
