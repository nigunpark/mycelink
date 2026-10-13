/**
 * What the host is told to do in a fresh session after an interruption.
 *
 * Second PCM-101 pilot, with-faults arm: the resumed `claude -p` session
 * followed /mycelink:resume, which said a new session must ask the user to
 * run `controller open --takeover` and hand over the key. Nobody was there;
 * the session reported the state and exited 0 with a node at
 * REGRESSION_VERIFIED, no candidate and no delivery.
 *
 * Every host surface now says: recover the key with `controller open
 * --recover` (ask the operator only when it is refused), let `dispatch` (or
 * `dispatch --resume`) finish an interrupted settlement, continue through
 * the candidate and delivery, and never report success unless
 * `feature verify --delivered` passes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';

const flat = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');

const HOST = ['commands/run.md', 'commands/resume.md', 'skills/host-dispatch/SKILL.md'];

describe('fresh-session recovery in the host instructions', () => {
  for (const rel of HOST) {
    it(`${rel}: a session without the key recovers it, and asks the operator only if recovery is refused`, () => {
      const text = flat(rel);
      expect(text).toMatch(/controller open --recover --json/);
      expect(text).toMatch(/CONTROLLER_BUSY[^.]*(operator|user)[^.]*--takeover/i);
      // Never the old dead end: a new session asking for the key first.
      expect(text).not.toMatch(/A new session does not have it: ask the user/);
    });

    it(`${rel}: an interrupted settlement is finished by dispatch, and SETTLED continues the loop`, () => {
      const text = flat(rel);
      expect(text).toMatch(/SETTLED/);
      expect(text).toMatch(/dispatch (\S+ )?--resume/);
      expect(text).toMatch(/interrupted settle/i);
    });

    it(`${rel}: success is reported only when feature verify --delivered passes`, () => {
      const text = flat(rel);
      expect(text).toMatch(/complete only when `M feature verify \S+ --delivered --json` exits 0/);
      expect(text).toMatch(/never report success/i);
    });
  }

  it('/mycelink:resume continues through the candidate and delivery, not just a status report', () => {
    const text = flat('commands/resume.md');
    expect(text).toMatch(/through[^.]*deliver/i);
    expect(text).not.toMatch(/7\. Continue with the `\/mycelink:run` loop from `M dispatch \$0 --json --authority <key>`\.$/);
  });
});
