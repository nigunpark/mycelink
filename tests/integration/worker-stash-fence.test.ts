/**
 * A module-worker's stash entries are its own (CSET-203 r12).
 *
 * Every worktree of a repository shares one stash. A worker may set its
 * edits aside (`git stash`, `git stash push`) and read the stash, in its own
 * worktree; it may pop, apply or drop only an entry its own worktree made —
 * by what Git wrote into it: on its claim's branch, from a commit of that
 * branch — so two workers of the same repository never take each other's
 * work, nor the user's. A bare `git stash pop` is fine while the newest
 * entry is its own; otherwise it names its own entry (`stash@{N}`). `git
 * stash clear`, `store` and `branch` are never a worker's: they drop every
 * worktree's entries, put an arbitrary commit into the shared stash, or make
 * a branch. A worker the fence cannot bind to its claim (no subagent meta,
 * no launch record) may still stash, but pops nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { ERRORS, READ, SHOP_FEATURE, createShop, moduleVerifier, shopCli, shopGraph, type Shop } from '../helpers/shop-fixture.js';
import type { ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = resolve(process.cwd(), 'bin', 'mycelink.mjs');
const WORKER = 'mycelink:module-worker';
const SESSION = '00000000-0000-4000-8000-000000005c02';
const AGENT = 'a0000000000000c02';
const LAUNCH = 'toolu_worker_stash_launch';

let s: Shop;
let t: ShopTicket;
let transcript: string;

beforeAll(async () => {
  s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
  t = (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
  const home = makeTmpDir('stash-fence-home-');
  const project = join(home, '.claude', 'projects', 'p');
  transcript = join(project, `${SESSION}.jsonl`);
  mkdirSync(join(project, SESSION, 'subagents'), { recursive: true });
  writeFileSync(transcript, '');
  writeFileSync(join(project, SESSION, 'subagents', `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: WORKER, description: ERRORS, toolUseId: LAUNCH }));
  // The host's Agent call for the ticket: the fence records its launch, which binds the subagent to the claim.
  expect(fence('Agent', { subagent_type: WORKER, description: ERRORS, prompt: t.prompt }, {}, LAUNCH).code).toBe(0);
});

function fence(tool: string, input: Record<string, unknown>, who: Record<string, string> = {}, id = 'toolu_x'): { code: number; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: s.root };
  delete env['MYCELINK_CONTROL_ROOT'];
  delete env['MYCELINK_NODE_ID'];
  delete env['MYCELINK_PROVENANCE'];
  const payload = { session_id: SESSION, transcript_path: transcript, cwd: s.root, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id, ...who };
  const r = spawnSync(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], { input: JSON.stringify(payload), encoding: 'utf8', env: env as NodeJS.ProcessEnv, cwd: s.root, windowsHide: true });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
}
const worker = { agent_id: AGENT, agent_type: WORKER };
const q = (p: string) => `'${p.replace(/\\/g, '/')}'`;
const asWorker = (command: string) => fence('Bash', { command }, worker);
const SRC = 'packages/errors/src/index.mjs';

/** A stash entry made in the worker's worktree. */
function workerEntry(text: string): string {
  writeFileSync(join(t.worktree, SRC), text);
  git(t.worktree, ['stash', 'push', '-q', '-m', text.trim()]);
  return git(t.worktree, ['rev-parse', 'refs/stash']);
}

describe('a module-worker’s stash', () => {
  it('sets its edits aside and reads the stash, in its own worktree', () => {
    for (const command of [`git -C ${q(t.worktree)} stash`, `git -C ${q(t.worktree)} stash -q`, `git -C ${q(t.worktree)} stash push --include-untracked -m "draft"`, `cd ${q(t.worktree)} && git stash list`, `git -C ${q(t.worktree)} stash show -p`]) {
      const r = asWorker(command);
      expect(r.code, `${command}: ${r.stderr}`).toBe(0);
    }
  });

  it('pops, applies and drops its own newest entry', () => {
    workerEntry('export const draft = 1;\n');
    for (const command of [`git -C ${q(t.worktree)} stash pop -q`, `git -C ${q(t.worktree)} stash apply`, `git -C ${q(t.worktree)} stash drop stash@{0}`]) {
      const r = asWorker(command);
      expect(r.code, `${command}: ${r.stderr}`).toBe(0);
    }
    git(t.worktree, ['stash', 'drop', '-q']);
  });

  it('never takes an entry another worktree or the user made, even the newest; it names its own instead', () => {
    workerEntry('export const draft = 2;\n');
    // The user's stash in the repository's own checkout, newer than the worker's.
    writeFileSync(join(s.repo, 'README.md'), '# shop\nuser wip\n');
    git(s.repo, ['stash', 'push', '-q', '-m', 'user wip']);
    const pop = asWorker(`git -C ${q(t.worktree)} stash pop`);
    expect(pop.code).toBe(2);
    expect(pop.stderr).toMatch(/^Blocked: stash@\{0\} .*is not an entry your worktree made/);
    expect(pop.stderr).toMatch(/stash@\{N\}/);
    expect(asWorker(`git -C ${q(t.worktree)} stash drop stash@{0}`).code).toBe(2);
    expect(asWorker(`git -C ${q(t.worktree)} stash apply 0`).code).toBe(2);
    const own = asWorker(`git -C ${q(t.worktree)} stash pop stash@{1}`);
    expect(own.code, own.stderr).toBe(0);
    git(s.repo, ['stash', 'drop', '-q', 'stash@{0}']);
    git(s.repo, ['stash', 'drop', '-q', 'stash@{0}']);
  });

  it('never clears the stash, stores a commit in it or branches from it', () => {
    workerEntry('export const draft = 3;\n');
    for (const command of [`git -C ${q(t.worktree)} stash clear`, `git -C ${q(t.worktree)} stash store -m x HEAD`, `git -C ${q(t.worktree)} stash branch side`]) {
      const r = asWorker(command);
      expect(r.code, command).toBe(2);
      expect(r.stderr).toMatch(/^Blocked: a module-worker never runs git stash (clear|store|branch)/);
    }
    git(t.worktree, ['stash', 'drop', '-q']);
  });

  it('pops nothing outside its own worktree: another worker’s, or the repository’s checkout', async () => {
    workerEntry('export const draft = 4;\n');
    const other = join(s.root, 'control', '.mycelink', 'worktrees', `shop__${READ}`);
    expect(asWorker(`git -C ${q(other)} stash pop`).code).toBe(2);
    expect(asWorker(`git -C ${q(s.repo)} stash pop`).code).toBe(2);
    git(t.worktree, ['stash', 'drop', '-q']);
  });

  it('a worker the fence cannot bind to a claim may stash, but pops nothing', () => {
    const stranger = { agent_id: 'a0000000000000bad', agent_type: WORKER };
    expect(fence('Bash', { command: `git -C ${q(t.worktree)} stash push -m draft` }, stranger).code).toBe(0);
    workerEntry('export const draft = 5;\n');
    const r = fence('Bash', { command: `git -C ${q(t.worktree)} stash pop` }, stranger);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot tell which worktree is this worker's/);
    git(t.worktree, ['stash', 'drop', '-q']);
  });

  it('the controller stashes nowhere in a registered repository or a worktree', () => {
    expect(fence('Bash', { command: `git -C ${q(s.repo)} stash` }).code).toBe(2);
    expect(fence('Bash', { command: `git -C ${q(t.worktree)} stash` }).code).toBe(2);
  });
});
