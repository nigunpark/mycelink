/**
 * Changed scope of a delivery, judged against the adapter's topology and the
 * PRD's allowed and required modules.
 *
 * - every changed path lies in an allowed module or matches the PRD's
 *   allowed shared paths (a recorded build mutation committed with exactly
 *   its recorded bytes is tolerated as a warning);
 * - every required module has a production (non-test) change: a PRD that
 *   spans two modules must be delivered in both;
 * - no upstream test file is deleted.
 *
 * What the evaluator's fault injections changed is not the delivery's, and
 * only that: a path is left out while the delivered tree holds exactly the
 * content an injection bound to its commit gave it (`injected`, from
 * faults.mjs injectedEffects) — a teammate's note a merge brought in, say.
 * An edit of it, or an injected commit dropped or rewritten, is the
 * delivery's again. Every other commit is the delivery's, and what each one
 * changed itself (a merge: what it changed against every parent) must stay
 * in scope too, even where the delivered tree no longer shows it.
 */
import { judgeGit, makeSection } from './hygiene.mjs';

/** A '/'-separated glob (`**`, `*`, `?`) as an anchored regular expression. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      re += '(?:/.*)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else if (glob[i] === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (globs, path) => globs.some((g) => globToRegExp(g).test(path));

/** The module owning a repository path (longest module path wins), or null. */
export function moduleOf(adapter, path) {
  let best = null;
  for (const m of adapter.modules) {
    if ((path === m.path || path.startsWith(`${m.path}/`)) && (best === null || m.path.length > best.path.length)) best = m;
  }
  return best ? best.id : null;
}

export function isTestPath(adapter, path) {
  return matchesAny(adapter.test_paths, path);
}

/** The modules of `ids` that can gain runtime tests (not declarations only). */
export function testedModules(adapter, ids) {
  return ids.filter((id) => adapter.modules.find((m) => m.id === id)?.runtime_tests !== false);
}

/** `git diff --name-status --no-renames` between two commits. */
export function changedPaths(repo, from, to) {
  const r = judgeGit(repo, ['diff', '--name-status', '-z', '--no-renames', from, to]);
  if (r.code !== 0) throw new Error(`git diff ${from}..${to} failed: ${r.stderr}`);
  const parts = r.stdout.split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === '') break;
    out.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return out;
}

/** The paths one commit changed itself: against its parent, or for a merge against every parent. */
function ownChanges(repo, commit) {
  const r = judgeGit(repo, ['diff-tree', '-r', '-c', '-z', '--no-renames', '--no-commit-id', '--name-only', commit]);
  if (r.code !== 0) throw new Error(`git diff-tree ${commit} failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

const NONE = { commits: new Set(), changes: [] };

export function inspectScope({ repo, start, head, adapter, prd, injected = NONE }) {
  const { checks, check } = makeSection();
  const blobAt = (rev, path) => {
    const r = judgeGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}:${path}`]);
    return r.code === 0 ? r.stdout : null;
  };
  // The delivered product: every changed path but those still exactly as an injection left them.
  const faultOwned = [];
  const changed = changedPaths(repo, start, head).filter((c) => {
    const blob = c.status === 'D' ? null : blobAt(head, c.path);
    const effect = injected.changes.findLast((e) => e.path === c.path && e.blob === blob);
    if (!effect) return true;
    faultOwned.push(`${c.path} (${effect.kind} ${effect.commit.slice(0, 12)})`);
    check(`fault-owned:${c.path}`, true, `exactly as the ${effect.kind} injection ${effect.commit.slice(0, 12)} left it: not the delivery's`, { severity: 'warning' });
    return false;
  });
  const tolerated = new Map((adapter.tolerated_build_mutations ?? []).map((m) => [m.path, m]));
  /** Why a path the delivery changed is out of scope, or null. */
  const outOfScope = (path) => {
    const mod = moduleOf(adapter, path);
    if (mod !== null) return prd.modules.allowed.includes(mod) ? null : `module ${mod}`;
    return matchesAny(prd.allowed_shared_paths, path) ? null : 'outside every module';
  };
  const byModule = {};
  const shared = [];
  const outside = new Map();
  for (const c of changed) {
    const rule = tolerated.get(c.path);
    if (rule && c.status === 'M' && blobAt(head, c.path) === rule.built_blob) {
      check(`tolerated-build-mutation:${c.path}`, true, `committed with exactly the upstream build's rewrite: ${rule.evidence}`, { severity: 'warning' });
      continue;
    }
    const mod = moduleOf(adapter, c.path);
    if (mod !== null) (byModule[mod] ??= []).push(c);
    else shared.push(c);
    const why = outOfScope(c.path);
    if (why) outside.set(c.path, `${c.path} (${why})`);
  }
  // The delivery's own commits: what each changed itself stays in scope as well.
  const own = judgeGit(repo, ['rev-list', '--reverse', `${start}..${head}`]).stdout.split(/\r?\n/).filter((c) => c && !injected.commits.has(c));
  for (const commit of own) {
    for (const path of ownChanges(repo, commit)) {
      if (outside.has(path)) continue;
      const rule = tolerated.get(path);
      if (rule && blobAt(commit, path) === rule.built_blob) continue;
      const why = outOfScope(path);
      if (why) outside.set(path, `${path} (${why}, in commit ${commit.slice(0, 12)})`);
    }
  }
  check('scope-allowed', outside.size === 0, outside.size ? `changes outside the PRD's scope: ${[...outside.values()].slice(0, 10).join(', ')}` : `${changed.length} changed path(s) and ${own.length} commit(s), all in scope`);
  for (const m of prd.modules.required) {
    const production = (byModule[m] ?? []).filter((c) => !isTestPath(adapter, c.path));
    check(`scope-required:${m}`, production.length > 0, `${production.length} production change(s) in required module ${m}`);
  }
  const deletedTests = changed.filter((c) => c.status === 'D' && isTestPath(adapter, c.path)).map((c) => c.path);
  check('existing-tests-kept', deletedTests.length === 0, deletedTests.length ? `upstream tests deleted: ${deletedTests.join(', ')}` : 'no upstream test deleted');
  return {
    checks,
    facts: {
      changed: changed.map((c) => `${c.status} ${c.path}`),
      by_module: Object.fromEntries(Object.entries(byModule).map(([m, list]) => [m, list.map((c) => `${c.status} ${c.path}`)])),
      shared: shared.map((c) => `${c.status} ${c.path}`),
      fault_owned: faultOwned,
    },
  };
}
