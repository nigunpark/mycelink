/**
 * What the plugin tells its controllers and workers after CSET-203 r4.
 *
 * The host: a session that exits with the feature incomplete leaves it
 * resumable — `feature status` says so (`next_action`, `resumable`) — and the
 * next host invocation continues it with `/mycelink:run`. The worker: every
 * new-behaviour RED test before the code, RED-bound test files byte-identical
 * after it, a compatibility test after the code in a new test file, `tdd
 * cycle` for a new RED in a bound file; carried proofs are re-run by settle.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';

const flat = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');

describe('an incomplete exit is resumable, and the next host invocation continues it', () => {
  for (const rel of ['commands/run.md', 'commands/resume.md', 'skills/host-dispatch/SKILL.md']) {
    it(`${rel}`, () => {
      const text = flat(rel);
      expect(text).toMatch(/next_action/);
      expect(text).toMatch(/resumable/);
      expect(text).toMatch(/incomplete[^.]*resumable|resumable[^.]*incomplete/i);
      expect(text).toMatch(/next host invocation[^.]*continue|continue[^.]*next host invocation/i);
    });
  }

  it('commands/status.md reads next_action and resumable', () => {
    const text = flat('commands/status.md');
    expect(text).toMatch(/next_action/);
    expect(text).toMatch(/resumable/);
  });
});

describe('the worker contract for a rework that names a new behaviour and a compatibility criterion', () => {
  for (const rel of ['agents/module-worker.md', 'skills/node-worker/SKILL.md']) {
    it(`${rel}`, () => {
      const text = flat(rel);
      expect(text).toMatch(/RED-bound/);
      expect(text).toMatch(/byte-identical/);
      expect(text).toMatch(/new test file/);
      expect(text).toMatch(/tdd cycle/);
      expect(text).toMatch(/carried[^.]*re-run|re-run[^.]*carried/i);
    });
  }
});
