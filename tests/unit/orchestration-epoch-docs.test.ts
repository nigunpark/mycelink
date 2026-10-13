/**
 * What the host and the worker are told about dispatch leases and the
 * orchestration epoch (CSET-203 r7).
 *
 * r7: a review settled PASS while a node it judged was reopened, and a worker
 * dispatched past it settled into the reviewed state. The controller is now
 * told: a live lease (`await-worker`) is waited for, never reviewed or cut
 * past, and the session does not end on it; `reconcile` is acted on; a
 * `STALE_ORCHESTRATION_EPOCH` settle changed nothing and is not retried; a
 * `CHALLENGE_REQUIRED` settle is followed by the re-issued ticket, unchanged.
 * The worker names its ticket's orchestration epoch in its result, and a
 * challenge request is answered with the structured challenge, never BLOCKED.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';

const flat = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');

const HOST = ['commands/run.md', 'skills/host-dispatch/SKILL.md'];
const WORKER = ['agents/module-worker.md', 'skills/node-worker/SKILL.md'];

describe('the host: leases and the epoch', () => {
  for (const rel of HOST) {
    it(`${rel}: await-worker is waited for, never reviewed or cut past, and the session does not end on it or on reconcile`, () => {
      const text = flat(rel);
      expect(text).toMatch(/`await-worker`/);
      expect(text).toMatch(/await-worker[^.]*(wait|notification)/i);
      expect(text).toMatch(/never end the session while[^.]*`await-worker`[^.]*`reconcile`/i);
    });

    it(`${rel}: a STALE_ORCHESTRATION_EPOCH settle changed nothing and is not retried; CHALLENGE_REQUIRED is followed by the re-issued ticket`, () => {
      const text = flat(rel);
      expect(text).toMatch(/STALE_ORCHESTRATION_EPOCH[^.]*(nothing|no) (was )?changed/i);
      expect(text).toMatch(/STALE_ORCHESTRATION_EPOCH[^.]*never (retry|re-?dispatch|settle it again)/i);
      expect(text).toMatch(/CHALLENGE_REQUIRED[^.]*dispatch[^.]*unchanged/i);
    });
  }
});

describe('the worker: the epoch in its result, and a challenge request', () => {
  for (const rel of WORKER) {
    it(`${rel}: the result names the ticket's orchestration_epoch exactly`, () => {
      const text = flat(rel);
      expect(text).toMatch(/orchestration_epoch/);
    });

    it(`${rel}: a challenge request is answered with the structured challenge, never BLOCKED again`, () => {
      const text = flat(rel);
      expect(text).toMatch(/Challenge requested/);
      expect(text).toMatch(/Challenge requested[^.]*(REVIEW_GAP_CHALLENGE|structured challenge)/i);
    });
  }
});
