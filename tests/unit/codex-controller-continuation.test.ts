import { describe, expect, it, vi } from 'vitest';
import { continueController, continueReviewedController } from '../../src/engine/codex-continuation.js';

describe('Codex controller continuation', () => {
  it('prepares an imported fresh feature under the single held key before dispatch', async () => {
    const calls: string[] = [];
    const result = await continueController({ maxNodes: 1,
      open: () => { calls.push('open'); return 'secret-key'; },
      prepare: async (key) => { expect(key).toBe('secret-key'); calls.push('init-and-import'); },
      run: async (key) => { expect(key).toBe('secret-key'); calls.push('dispatch'); return { outcome: 'DONE', node_id: 'remaining' }; },
    });
    expect(calls).toEqual(['open', 'init-and-import', 'dispatch']);
    expect(result).toEqual({ stop_reason: 'BOUND_REACHED', nodes: ['remaining'] });
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
  it('refuses dispatch if fresh-state import validation fails after opening', async () => {
    const run = vi.fn();
    await expect(continueController({ maxNodes: 1, open: () => 'secret-key',
      prepare: async () => { throw new Error('IMPORT_SOURCE_HASH'); }, run,
    })).rejects.toThrow('IMPORT_SOURCE_HASH');
    expect(run).not.toHaveBeenCalled();
  });
  it('holds one authority through GAP, bounded producer rework and fresh review without leaking the key', async () => {
    let opens = 0;
    const steps = ['api', 'web', null, 'api', null];
    const reviews = ['GAPS', 'PASS'];
    const result = await continueReviewedController({ maxNodes: 3, maxReviews: 2,
      open: () => { opens++; return 'secret'; },
      run: async (key) => { expect(key).toBe('secret'); return { outcome: 'DONE', node_id: steps.shift() ?? undefined }; },
      review: async (key) => { expect(key).toBe('secret'); return { outcome: reviews.shift()! }; },
    });
    expect(opens).toBe(1);
    expect(result).toEqual({ stop_reason: 'REVIEW_PASS', nodes: ['api', 'web', 'api'], reviews: ['GAPS', 'PASS'] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('never reports PASS when a gap has no remaining worker or reviewer budget', async () => {
    let reviewed = 0;
    let calls = 0;
    const result = await continueReviewedController({ maxNodes: 2, maxReviews: 1, open: () => 'key',
      run: async () => ({ outcome: 'DONE', node_id: calls++ === 0 ? 'api' : undefined }),
      review: async () => { reviewed++; return { outcome: 'GAPS' }; },
    });
    expect(result.stop_reason).toBe('REVIEW_GAPS_UNRESOLVED');
    expect(reviewed).toBe(1);
  });
  it('does not launch a reviewer after a failed worker or an unrotated duplicate', async () => {
    let reviewed = 0;
    const review = async () => { reviewed++; return { outcome: 'PASS' }; };
    const failure = await continueReviewedController({ maxNodes: 3, maxReviews: 2, open: () => 'key',
      run: async () => ({ outcome: 'RETRY', node_id: 'api' }), review });
    expect(failure.stop_reason).toBe('NODE_NOT_DONE');
    const duplicate = await continueReviewedController({ maxNodes: 3, maxReviews: 2, open: () => 'key',
      run: async () => ({ outcome: 'DONE', node_id: 'api' }), review });
    expect(duplicate.stop_reason).toBe('NO_PROGRESS');
    expect(reviewed).toBe(0);
  });
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
