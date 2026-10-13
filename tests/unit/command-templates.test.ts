/**
 * Slash-command argument templates.
 *
 * Current Claude Code numbers positional arguments from zero: `$0` (shorthand
 * for `$ARGUMENTS[0]`) is the first argument. A template that uses `$1` for
 * the feature id silently receives the second argument (or nothing) instead.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';

const COMMANDS_DIR = join(REPO_ROOT, 'commands');

interface Template {
  file: string;
  hint: string[];
  body: string;
}

function templates(): Template[] {
  return readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const text = readFileSync(join(COMMANDS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
      const hintLine = /^argument-hint:\s*(.*)$/m.exec(front?.[1] ?? '')?.[1] ?? '';
      const hint = hintLine.match(/<[^>]+>|\[[^\]]+\]/g) ?? [];
      return { file, hint, body: text.slice(front?.[0].length ?? 0) };
    });
}

/** Positional placeholders used in a body, ignoring `${...}` shell expansions. */
function positionalIndices(body: string): number[] {
  const out = new Set<number>();
  for (const m of body.matchAll(/(?<![\\{\w])\$(\d+)(?!\w)/g)) out.add(Number(m[1]));
  for (const m of body.matchAll(/\$ARGUMENTS\[(\d+)\]/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

describe('command argument templates', () => {
  const all = templates();

  it('finds the plugin commands', () => {
    expect(all.length).toBeGreaterThanOrEqual(9);
  });

  for (const t of all) {
    it(`${t.file} numbers its positional arguments from $0`, () => {
      const used = positionalIndices(t.body);
      if (t.hint.length === 0) {
        expect(used).toEqual([]);
        return;
      }
      // Every hinted argument that is referenced positionally uses its
      // zero-based index, and nothing refers past the last hinted argument.
      expect(used.length).toBeGreaterThan(0);
      expect(used[0]).toBe(0);
      expect(Math.max(...used)).toBeLessThan(t.hint.length);
    });
  }

  it('the feature id of run.md is $0, not the second argument', () => {
    const run = all.find((t) => t.file === 'run.md');
    expect(run?.body).toMatch(/Feature: `\$0`/);
    expect(run?.body).not.toMatch(/\$1\b/);
  });
});
