/**
 * The suite a run or a verdict rests on, pinned to a commit and sealed.
 *
 * `pinSuite` finds the Git checkout holding the suite directory and
 * records its commit, the suite directory's tree at that commit and every
 * uncommitted change under it (ignored files — caches pointers, results —
 * aside). run-arm and verify-run refuse a suite with uncommitted changes,
 * or at another commit than the one they are told to expect, and work on
 * `sealSuite`'s export of exactly the committed tree — manifests, locks,
 * baselines and qualifications as committed, never as the working tree
 * holds them while the run goes on.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { exportTree, revParse, safeGit } from './git.mjs';

/** `{ ok, problems, pin }`: pin = { root, checkout, commit, path, tree, dirty }. */
export function pinSuite(root, { expectCommit = null } = {}) {
  const suite = resolve(root);
  const top = safeGit(suite, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { ok: false, problems: [`the suite ${suite} is not in a Git checkout: it cannot be pinned to a commit`], pin: null };
  const checkout = resolve(top.stdout);
  const path = relative(checkout, suite).split('\\').join('/');
  const commit = revParse(checkout, 'HEAD');
  const tree = commit ? revParse(checkout, path ? `${commit}:${path}` : `${commit}^{tree}`) : null;
  const status = safeGit(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path || '.'], { encoding: 'buffer' });
  const dirty = status.code === 0 ? status.stdout.toString('utf8').split('\0').filter(Boolean).map((e) => e.slice(3)) : ['(git status failed)'];
  const pin = { root: suite, checkout, commit, path, tree, dirty };
  const problems = [];
  if (!commit || !tree) problems.push(`the suite ${suite} is not committed at HEAD`);
  if (dirty.length) problems.push(`the suite has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}): commit them or check out a clean tree`);
  if (expectCommit && commit !== expectCommit) problems.push(`the suite is at ${commit}, expected ${expectCommit}`);
  return { ok: problems.length === 0, problems, pin };
}

/** Export the pinned suite tree into a fresh directory (or `target`); returns its root. */
export function sealSuite(pin, target = join(mkdtempSync(join(tmpdir(), 'bench-suite-')), 'suite')) {
  exportTree(pin.checkout, pin.path ? `${pin.commit}:${pin.path}` : pin.commit, target);
  return target;
}

/** The record of a pin a run or verdict carries. */
export const pinRecord = (pin) => (pin ? { commit: pin.commit, path: pin.path, tree: pin.tree, clean: pin.dirty.length === 0 } : null);
