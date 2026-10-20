import { describe, expect, it, vi } from 'vitest';
import { continueController } from '../../src/engine/codex-continuation.js';

describe('bounded Codex controller continuation', () => {
  it('keeps authority in the host across distinct invocations and emits no key', async () => {
    const opened = vi.fn(() => 'secret-key');
    const observed: string[] = [];
    const result = await continueController({ maxNodes: 2, open: opened, run: async (key) => {
      observed.push(key);
      return { outcome: 'DONE', node_id: `node-${observed.length}` };
    } });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(['secret-key', 'secret-key']);
    expect(result).toEqual({ stop_reason: 'BOUND_REACHED', nodes: ['node-1', 'node-2'] });
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });

  it('stops on a failed claim rather than advancing the dependent node', async () => {
    const run = vi.fn(async () => ({ outcome: 'RETRY', node_id: 'api' }));
    expect(await continueController({ maxNodes: 3, open: () => 'key', run })).toEqual({ stop_reason: 'NODE_NOT_DONE', nodes: ['api'] });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid bounds before opening authority', async () => {
    const open = vi.fn(() => 'key');
    await expect(continueController({ maxNodes: 0, open, run: async () => ({ outcome: 'DONE', node_id: 'api' }) })).rejects.toThrow(/max-nodes/);
    await expect(continueController({ maxNodes: 9, open, run: async () => ({ outcome: 'DONE', node_id: 'api' }) })).rejects.toThrow(/max-nodes/);
    expect(open).not.toHaveBeenCalled();
  });

  it('never retries a repeated or empty scheduled node', async () => {
    const run = vi.fn(async () => ({ outcome: 'DONE', node_id: 'api' }));
    expect(await continueController({ maxNodes: 3, open: () => 'key', run })).toEqual({ stop_reason: 'NO_PROGRESS', nodes: ['api'] });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
