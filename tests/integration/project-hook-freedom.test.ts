/**
 * The project-scoped PreToolUse hook (`mycelink init` writes it into a
 * control repository's .claude/settings.json) refuses what its invariants
 * need and nothing more.
 *
 * The constraint/freedom audit (docs/CONSTRAINT_FREEDOM_AUDIT.md) found three
 * of its rules refusing legitimate work their invariants do not cover:
 *
 *  - the controller-bypass guard matched raw command text, so a commit
 *    message, a grep pattern or an echo naming `git merge` or `playwright`
 *    was refused, and a module-worker could not reorder its own commits
 *    (`git rebase`, `git cherry-pick`) in its own worktree — the very thing
 *    settle's test-first history asks of it — although nothing of that is an
 *    integration. Commands are now read as the shell runs them;
 *  - the edit-time RED gate told tests from production by a regex of its own,
 *    not the repository's TDD policy settle judges by, and asked for a RED
 *    where the generation needs none (a compatibility-only rework);
 *  - a feature's graph could not be written before `feature init`, though
 *    /mycelink:plan's step is to write it; once initialised, its STATE.json
 *    binds the graph's hash, and the graph stays refused;
 *  - with exactly one node claimed, every session's edit was taken for that
 *    worker's — the controller's PRD or graph of another feature included —
 *    and refused as outside its worktree. Only a worker's call is a worker's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { mutateState } from '../../src/state/feature-state.js';
import { asController } from '../helpers/authority.js';
import { runWithInput } from '../../src/util/child-stdin.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = resolve(process.cwd(), 'bin', 'mycelink.mjs');

function hook(p: Portfolio, payload: Record<string, unknown>, env: Record<string, string> = {}): { code: number; stderr: string } {
  const r = runWithInput(process.execPath, [LAUNCHER, 'hook', 'pre-tool-use', '--control-root', p.control], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, MYCELINK_CONTROL_ROOT: p.control, ...env },
    windowsHide: true,
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
}

const bash = (p: Portfolio, command: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => hook(p, { tool_name: 'Bash', tool_input: { command }, ...extra }, env);

describe('the project hook', () => {
  let p: Portfolio;
  const node = `${FEATURE_ID}.core.publish.impl`;
  let worktree: string;

  beforeAll(async () => {
    p = createPortfolio();
    writePrd(p);
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }), 'utf8');
    mkdirSync(join(p.featureDir, 'e2e'), { recursive: true });
    commitControl(p, 'scaffold');
    const io: CliIo = { out: () => {}, err: () => {} };
    expect(await main([...asController(['feature', 'init', FEATURE_ID], p.control), '--control-root', p.control], io)).toBe(0);
    expect(await main([...asController(['node', 'claim', FEATURE_ID, node], p.control), '--control-root', p.control], io)).toBe(0);
    worktree = join(p.control, '.mycelink', 'worktrees', `core__${node.replace(/[^\w.-]/g, '_')}`);
  });

  describe('controller bypass: commands as the shell runs them, never their text', () => {
    it('lets through text that only names a guarded command', () => {
      for (const command of [
        'git commit -m "explain why git merge is not used here"',
        "grep -rn 'git rebase' docs",
        'rg playwright package.json',
        'echo "docker compose up is the runtime lease\'s"',
        "cat <<'EOF' > /tmp/notes.md\nnever git push by hand\nEOF",
      ]) {
        const r = bash(p, command);
        expect(`${command}:${r.code}`, r.stderr).toBe(`${command}:0`);
      }
    });

    it('still refuses the guarded commands themselves, however they are spelled', () => {
      for (const command of [
        'git push origin main',
        'git -C . push origin main',
        'git merge feature/other',
        'cd /tmp && git worktree add ../x feature/y',
        "bash -c 'git push origin main'",
        'npx playwright test tests/e2e',
        'pnpm exec playwright test',
        'docker compose up -d',
        'git rebase main',
        'git cherry-pick abc123',
      ]) {
        const r = bash(p, command);
        expect(`${command}:${r.code}`).toBe(`${command}:2`);
        expect(r.stderr).toMatch(/mycelink/);
      }
    });

    it("lets a module-worker reorder its own commits in its own worktree, never another's history", () => {
      const own = { MYCELINK_NODE_ID: node };
      expect(bash(p, `git -C '${worktree}' rebase --onto HEAD~2 HEAD~1`, { cwd: worktree }, own).code).toBe(0);
      expect(bash(p, 'git cherry-pick abc123', { cwd: worktree }, own).code).toBe(0);
      // Its merges stay refused (settle refuses a merge in a node's history), and so does a rebase anywhere else.
      expect(bash(p, 'git merge main', { cwd: worktree }, own).code).toBe(2);
      expect(bash(p, `git -C '${p.core}' rebase main`, { cwd: worktree }, own).code).toBe(2);
      // The controller reorders nothing.
      expect(bash(p, `git -C '${worktree}' rebase HEAD~1`, { cwd: p.control }).code).toBe(2);
    });
  });

  describe("the RED gate: the repository's TDD policy, and only where the generation needs a RED", () => {
    const write = (rel: string) => hook(p, { tool_name: 'Write', tool_input: { file_path: join(worktree, rel) }, cwd: worktree }, { MYCELINK_NODE_ID: node });

    it('lets test-side files the policy names through before RED, and still refuses production', () => {
      // Allowed paths of the node: src/** and tests/** (portfolio fixture), all test-side by the default policy.
      for (const rel of ['tests/__mocks__/registry.js', 'tests/fixtures/data.json', 'tests/publish.test.js']) {
        const r = write(rel);
        expect(`${rel}:${r.code}`, r.stderr).toBe(`${rel}:0`);
      }
      for (const rel of ['src/__fixtures__/sample.js', 'src/publish.spec.js', 'src/testdata/case.json']) {
        const r = write(rel);
        expect(`${rel}:${r.code}`, r.stderr).toBe(`${rel}:0`);
      }
      expect(write('src/publish.js').code).toBe(2);
    });

    it('asks no RED of a generation that needs none (a compatibility-only rework)', () => {
      mutateState(p.featureDir, (s) => {
        const rt = s.nodes[node];
        if (rt) rt.rework_brief = { generation: 1, limit: 2, at: new Date().toISOString(), reason: 'compatibility only', reason_sha256: 'a'.repeat(64), decision_id: null, acceptance_criteria: [], evidence: [], replaced: { integrated_sha: null, candidate_id: null, archived_ref: null }, attempt_base: rt.attempts, red_required: false };
        return s;
      });
      try {
        expect(write('src/publish.js').code).toBe(0);
      } finally {
        mutateState(p.featureDir, (s) => {
          const rt = s.nodes[node];
          if (rt) rt.rework_brief = null;
          return s;
        });
      }
      expect(write('src/publish.js').code).toBe(2);
    });
  });

  describe("a feature's graph", () => {
    it('is the controller\'s to write before feature init (/mycelink:plan), and refused once STATE.json binds it', () => {
      const fresh = join(p.control, 'features', 'FEAT-902');
      mkdirSync(fresh, { recursive: true });
      writeFileSync(join(fresh, 'PRD.md'), '# FEAT-902\n');
      // One node of another feature is claimed: the controller's documents are still its own, never that worker's edits.
      expect(hook(p, { tool_name: 'Write', tool_input: { file_path: join(fresh, 'PRD.md') }, cwd: p.control }).code).toBe(0);
      const before = hook(p, { tool_name: 'Write', tool_input: { file_path: join(fresh, 'PORTFOLIO-GRAPH.yaml') } });
      expect(before.code, before.stderr).toBe(0);
      expect(hook(p, { tool_name: 'Edit', tool_input: { file_path: join(fresh, 'PORTFOLIO-GRAPH.yaml') } }).code).toBe(0);
      const bound = hook(p, { tool_name: 'Write', tool_input: { file_path: join(p.featureDir, 'PORTFOLIO-GRAPH.yaml') } });
      expect(bound.code).toBe(2);
      expect(bound.stderr).toMatch(/controller-owned/);
    });
  });
});
