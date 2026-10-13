/**
 * Delivery hygiene: what the verifier demands of a delivered repository
 * before it runs a single line of the delivered code.
 *
 * - inert local git configuration (checked first; nothing else runs if not);
 * - `.git` is this repository's own directory, not a pointer elsewhere;
 * - no grafts, no replace refs, and the shallow boundary is exactly the
 *   frozen one, so ancestry cannot be forged; every git call also runs with
 *   GIT_NO_REPLACE_OBJECTS=1;
 * - HEAD is the delivery branch, the frozen commit is in the history and
 *   there is at least one delivered commit;
 * - no committed symlinks or submodules beyond what the frozen tree had;
 * - a clean working tree, except a recorded upstream build mutation holding
 *   exactly its recorded bytes (reported as a warning);
 * - every tracked file is a regular file with a single link.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitBlobSha } from './hash.mjs';
import { lsTree, pathKey, readEntry, safeGit, unsafeGitConfig } from './git.mjs';

/** git for judging: hardened, and blind to replace refs. */
export const judgeGit = safeGit;

export function makeSection() {
  const checks = [];
  const check = (id, ok, detail, extra = {}) => {
    checks.push({ id, ok: Boolean(ok), detail, ...extra });
    return Boolean(ok);
  };
  return { checks, check };
}

/** Parse `git status --porcelain=v1 -z` output into `{ x, y, path, from }` entries. */
export function parseStatus(text) {
  const out = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (record === '') continue;
    const entry = { x: record[0], y: record[1], path: record.slice(3) };
    if (entry.x === 'R' || entry.x === 'C') entry.from = parts[++i];
    out.push(entry);
  }
  return out;
}

export function inspectRepository({ repo, lock, adapter }) {
  const { checks, check } = makeSection();
  const facts = { head: null, branch: null, commits_since_start: null, dirty: [], tolerated: [] };
  const done = () => ({ checks, facts });

  const unsafe = existsSync(repo) ? unsafeGitConfig(repo) : ['<missing repository>'];
  if (!check('git-config-safe', unsafe.length === 0, unsafe.length ? `refusing to run git: ${unsafe.join(', ')}` : 'local git configuration is inert')) return done();
  const dotGit = readEntry(join(repo, '.git'));
  if (!check('git-dir-local', dotGit.kind === 'directory', dotGit.kind === 'directory' ? '.git is a directory' : `.git is ${dotGit.kind === 'file' ? 'a pointer to another git directory' : dotGit.kind}`)) {
    return done();
  }
  const top = judgeGit(repo, ['rev-parse', '--show-toplevel']);
  if (!check('repo-root', top.code === 0 && pathKey(top.stdout) === pathKey(repo), `top level ${top.stdout || top.stderr}`)) return done();

  check('no-grafts', !existsSync(join(repo, '.git', 'info', 'grafts')), '.git/info/grafts absent');
  const replace = judgeGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/replace/']);
  check('no-replace-refs', replace.code === 0 && replace.stdout === '', replace.stdout ? `replace refs: ${replace.stdout.split('\n').join(', ')}` : 'no replace refs');
  const shallowFile = readEntry(join(repo, '.git', 'shallow'));
  const actualBoundary = shallowFile.kind === 'file' ? shallowFile.text.split('\n').filter(Boolean).sort() : [];
  const expectedBoundary = [...lock.history.shallow_boundary].sort();
  check(
    'shallow-boundary',
    (shallowFile.kind === 'file' || shallowFile.kind === 'missing') && JSON.stringify(actualBoundary) === JSON.stringify(expectedBoundary),
    `shallow boundary ${actualBoundary.join(',') || '(none)'}, frozen ${expectedBoundary.join(',') || '(none)'}`,
  );

  const branch = adapter.workspace.branch;
  const sym = judgeGit(repo, ['symbolic-ref', '--quiet', 'HEAD']);
  facts.branch = sym.code === 0 ? sym.stdout.replace(/^refs\/heads\//, '') : null;
  check('on-branch', sym.code === 0 && sym.stdout === `refs/heads/${branch}`, `HEAD is ${sym.code === 0 ? sym.stdout : 'detached'}, expected refs/heads/${branch}`);
  const head = judgeGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!check('has-head', head.code === 0, 'HEAD names a commit')) return done();
  facts.head = head.stdout;
  const start = lock.commit;
  if (!check('start-present', judgeGit(repo, ['cat-file', '-e', `${start}^{commit}`]).code === 0, `frozen commit ${start} is in the repository`)) return done();
  const ancestor = judgeGit(repo, ['merge-base', '--is-ancestor', start, facts.head]).code === 0;
  check('history-preserved', ancestor, `frozen commit ${start.slice(0, 12)} ${ancestor ? 'is' : 'is not'} an ancestor of HEAD (replace refs ignored)`);
  const count = ancestor ? Number(judgeGit(repo, ['rev-list', '--count', `${start}..${facts.head}`]).stdout) : null;
  facts.commits_since_start = count;
  check('delivered', (count ?? 0) > 0, `${count ?? 0} commit(s) on top of the frozen commit`);

  // Committed symlinks and submodules can point a build outside the tree.
  const startLinks = new Map(lsTree(repo, start).filter((e) => e.mode === '120000' || e.mode === '160000').map((e) => [e.path, `${e.mode} ${e.sha}`]));
  const badEntries = lsTree(repo, facts.head)
    .filter((e) => (e.mode === '120000' || e.mode === '160000') && startLinks.get(e.path) !== `${e.mode} ${e.sha}`)
    .map((e) => `${e.path} (${e.mode === '120000' ? 'symlink' : 'submodule'})`);
  check('tree-entries', badEntries.length === 0, badEntries.length ? `new symlinks/submodules: ${badEntries.join(', ')}` : 'no new symlinks or submodules');

  const status = judgeGit(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], { encoding: 'buffer' });
  const tolerated = new Map((adapter.tolerated_build_mutations ?? []).map((m) => [m.path, m]));
  for (const entry of status.code === 0 ? parseStatus(status.stdout.toString('utf8')) : [{ x: '?', y: '?', path: `<git status failed: ${status.stderr}>` }]) {
    const rule = tolerated.get(entry.path);
    if (rule && entry.x === ' ' && entry.y === 'M') {
      const headBlob = judgeGit(repo, ['rev-parse', `${facts.head}:${entry.path}`]).stdout;
      let worktreeBlob = null;
      try {
        worktreeBlob = gitBlobSha(readFileSync(join(repo, ...entry.path.split('/'))));
      } catch {
        worktreeBlob = null;
      }
      if (headBlob === rule.baseline_blob && worktreeBlob === rule.built_blob) {
        facts.tolerated.push(entry.path);
        check(`tolerated-build-mutation:${entry.path}`, true, `uncommitted, holds exactly the upstream build's rewrite: ${rule.evidence}`, { severity: 'warning' });
        continue;
      }
    }
    facts.dirty.push(`${entry.x}${entry.y} ${entry.path}`);
  }
  check('clean-worktree', facts.dirty.length === 0, facts.dirty.length ? `uncommitted: ${facts.dirty.slice(0, 10).join(' | ')}` : 'working tree clean');

  const files = judgeGit(repo, ['ls-files', '-z', '-s']);
  const irregular = [];
  for (const record of files.stdout.split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]{40}) \d\t(.+)$/s.exec(record);
    if (!m) continue;
    const [, mode, , path] = m;
    if (mode === '160000') continue;
    let st;
    try {
      st = lstatSync(join(repo, ...path.split('/')));
    } catch {
      continue; // a missing file already shows in git status
    }
    if (mode === '120000') {
      if (!st.isSymbolicLink()) irregular.push(`${path} (not the committed symlink)`);
    } else if (st.isSymbolicLink()) irregular.push(`${path} (symlink)`);
    else if (!st.isFile()) irregular.push(`${path} (not a regular file)`);
    else if (st.nlink > 1) irregular.push(`${path} (${st.nlink} hard links)`);
  }
  check('tracked-files-regular', irregular.length === 0, irregular.length ? irregular.slice(0, 10).join(', ') : 'every tracked file is a regular, singly linked file');
  return done();
}
