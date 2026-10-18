import type { UsageTotals } from '../model/types.js';

/** Provider-owned interpretation of JSONL; the process runtime owns framing. */
export interface StreamProgress {
  turns: number;
  usage: UsageTotals;
  /** Fatal terminal provider event, independent of process exit or result slot. */
  providerFailure?: string | null;
}

export interface ProviderStreamParser {
  consume(line: string, progress: StreamProgress): void;
}

export class ClaudeStreamParser implements ProviderStreamParser {
  consume(line: string, progress: StreamProgress): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Non-JSON output is logged but not counted.
    }
    const type = event['type'];
    if (type === 'assistant') {
      progress.turns += 1;
      const message = event['message'] as { usage?: Record<string, number> } | undefined;
      const usage = message?.usage;
      if (usage) {
        progress.usage.input_tokens += usage['input_tokens'] ?? 0;
        progress.usage.output_tokens += usage['output_tokens'] ?? 0;
      }
    } else if (type === 'result') {
      const turns = event['num_turns'];
      if (typeof turns === 'number') progress.turns = turns;
      const usage = event['usage'] as Record<string, number> | undefined;
      if (usage) {
        progress.usage.input_tokens = usage['input_tokens'] ?? progress.usage.input_tokens;
        progress.usage.output_tokens = usage['output_tokens'] ?? progress.usage.output_tokens;
      }
    }
  }
}
