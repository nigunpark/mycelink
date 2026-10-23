import { describe, expect, it } from 'vitest';
import { CodexTranscriptReader } from '../../src/sessions/codex-transcript.js';
import { CodexStreamParser } from '../../src/sessions/codex-cli-adapter.js';
import { zeroUsage } from '../../src/state/feature-state.js';
import { capacityLines, capacityMessage, rejectedCapacityStreams } from '../helpers/codex-capacity.js';

function observe(lines: string[]) {
  const reader = new CodexTranscriptReader();
  const parser = new CodexStreamParser();
  const progress = { turns: 0, usage: zeroUsage() };
  for (const line of lines) { reader.consume(line); parser.consume(line, progress); }
  expect(parser.evidence()).toEqual(reader.finish());
  expect(JSON.stringify({ evidence: reader.finish(), progress })).not.toContain(capacityMessage);
  expect(JSON.stringify({ evidence: reader.finish(), progress })).not.toContain('TOKEN-private-4839');
  return { evidence: reader.finish(), progress };
}

describe('Codex capacity admission evidence', () => {
  it('recognizes only the exact no-output terminal admission refusal', () => {
    const { evidence, progress } = observe(capacityLines);
    expect(evidence).toMatchObject({ terminal: 'failed', turns: 0, final: null, role_attested: false, failure: { transient: true } });
    expect(progress).toMatchObject({ turns: 0, usage: zeroUsage() });
  });
  it.each(rejectedCapacityStreams)('fails closed for %s', (_name, lines) => {
    expect(observe(lines).evidence.failure?.transient ?? false).toBe(false);
  });
});
