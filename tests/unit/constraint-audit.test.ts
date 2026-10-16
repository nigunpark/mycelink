/**
 * The constraint/freedom audit's record stays true of the repository
 * (scripts/constraint-audit.mjs): its anchors and tests exist, its generated
 * sections (case coupling, counts) are current, plugin core code names no
 * public case, model-facing text narrates none, and neither the record nor
 * docs/CONSTRAINT_FREEDOM_AUDIT.md holds an absolute path, an id or a
 * credential.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { tokenMentions } from '../../scripts/constraint-audit.mjs';

afterAll(() => cleanupTmpRoots());

describe('the constraint/freedom audit record', () => {
  it('passes its own check', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'constraint-audit.mjs'), '--check'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
    expect(`${r.status}\n${r.stderr}`).toBe('0\n');
    expect(r.stdout).toMatch(/0 case-specific core code tokens/);
  });
});

describe("the audit's token reader", () => {
  it('tells a case named in code (identifier, string, template, regular expression) from one named in a comment, wherever a slash or a brace could mislead it', () => {
    const file = join(makeTmpDir('audit-tokens-'), 'source.ts');
    writeFileSync(
      file,
      [
        '#!/usr/bin/env node',
        '// PCM-901 in a line comment',
        '/* CSET-901 in a block comment */',
        'const ratio = total / count / 2; // changesets',
        'const t = x.type / 2; // petclinic',
        'const re = /^CSET-903$/;',
        "const s = 'PCM-902';",
        "const tpl = `a ${ { k: `PCM-903 ${1}` }.k } b /* not a comment */ ${'x'} petclinic`;",
        'function changeset() { return /\\/\\/ pcm-9/.test(s); }',
        'if (ok) { } // CSET-902 after a block',
        'const after = `${a}` / 2; // pcm-7',
        'const f = (v: number): RegExp => /pcm-8/;',
        'const n = list[0]! / 2; // pcm-6',
      ].join('\n'),
    );
    // What TypeScript 5's parser made of it (the reader before TypeScript 7 dropped that API).
    expect(tokenMentions(file)).toEqual({ all: 14, code: [6, 7, 8, 8, 9, 9, 12] });
  });

  it('fails, never spins, where it reads a regular expression as code: a statement opening with one after a block', () => {
    const file = join(makeTmpDir('audit-tokens-'), 'source.ts');
    // After a `}` it cannot tell a block from an object literal, so takes the `/` for a division; TypeScript 7's scanner then stops advancing at `#\`.
    writeFileSync(file, ['if (ok) { }', '/#\\s/.test(s); // pcm-5'].join('\n'));
    expect(() => tokenMentions(file)).toThrow(/source\.ts:2: the token reader lost its place/);
  });
});
