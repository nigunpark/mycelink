/**
 * The quickstart's scripted walkthrough, end to end, model-free: two real Git
 * repositories, the real controller (dispatch, worktrees, red/green/regression
 * gates, settle, an acceptance review GAP and its rework, the candidate,
 * delivery) with a scripted worker and reviewer. Its output must be exactly
 * the documented SAMPLE-OUTPUT.md — every commit it makes has a fixed
 * identity and date, so the SHAs are the same on every machine. A change in
 * what the controller prints or does shows up here; regenerate the sample
 * with `node examples/quickstart/walkthrough.mjs --write-sample` and review
 * the diff.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const QUICKSTART = join(ROOT, 'examples', 'quickstart');

function sampleLines(): string[] {
  const sample = readFileSync(join(QUICKSTART, 'SAMPLE-OUTPUT.md'), 'utf8').replace(/\r\n/g, '\n');
  const block = /```text\n([\s\S]*?)\n```/.exec(sample)?.[1];
  if (block === undefined) throw new Error('SAMPLE-OUTPUT.md has no text block');
  return block.split('\n');
}

describe('examples/quickstart walkthrough', () => {
  it('runs the feature to two delivered SHAs and prints exactly SAMPLE-OUTPUT.md', () => {
    const r = spawnSync(process.execPath, [join(QUICKSTART, 'walkthrough.mjs')], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 280_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const lines = r.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    expect(lines).toEqual(sampleLines());
    expect(r.stdout).toMatch(/\[review\] +ORD-101-R001: GAP AC-4/);
    expect(r.stdout).toMatch(/\[deliver\] +ACCEPTED ORD-101-C001/);
    expect(r.stdout).toMatch(/acceptance probe on the delivered commits: 4\/4/);
  }, 300_000);
});
