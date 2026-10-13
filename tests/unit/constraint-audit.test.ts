/**
 * The constraint/freedom audit's record stays true of the repository
 * (scripts/constraint-audit.mjs): its anchors and tests exist, its generated
 * sections (case coupling, counts) are current, plugin core code names no
 * public case, model-facing text narrates none, and neither the record nor
 * docs/CONSTRAINT_FREEDOM_AUDIT.md holds an absolute path, an id or a
 * credential.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';

describe('the constraint/freedom audit record', () => {
  it('passes its own check', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'constraint-audit.mjs'), '--check'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
    expect(`${r.status}\n${r.stderr}`).toBe('0\n');
    expect(r.stdout).toMatch(/0 case-specific core code tokens/);
  });
});
