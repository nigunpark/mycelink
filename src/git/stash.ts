/**
 * The shared stash, as a module-worker's worktree uses it (CSET-203 r12).
 *
 * Every worktree of a repository shares its `refs/stash` and that ref's
 * reflog (`<common dir>/logs/refs/stash`): each reflog line is one stash
 * entry, the newest last (`stash@{0}`). An entry belongs to the worktree
 * that made it by what Git wrote into the entry's commit: its message is
 * `WIP on <branch>: ...` or `On <branch>: ...`, and its first parent is the
 * commit that branch's worktree had checked out — an ancestor of (or) the
 * branch's head. Nothing else (a reflog message, a time) is taken as proof.
 *
 * quarantineStash archives each entry a worktree's branch made under an
 * archive ref (evidence, never integrated) and drops it from the stash,
 * leaving every other entry's reflog line exactly as it was — byte for byte —
 * and `refs/stash` at the newest remaining entry (or gone, with its reflog,
 * when none remains). Git commands run hardened through runGit; the reflog
 * is rewritten atomically.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runGit } from './git.js';

/** One stash entry: its reflog line (exact bytes), the commit it names and that commit's subject. */
export interface StashEntry {
  /** 0 is the newest (`stash@{0}`). */
  index: number;
  /** The reflog line as Git wrote it, without its newline. */
  line: Buffer;
  sha: string;
  subject: string;
}

export interface StashQuarantine {
  /** The entries archived and dropped, newest first. */
  quarantined: { sha: string; ref: string; message: string }[];
  /** Entries left in the stash: never this worktree's. */
  remaining: number;
}

/** A repository's common Git directory (where its stash lives), read from files; null when it is not one. */
export function commonDirOf(repoPath: string): string | null {
  const dotGit = join(resolve(repoPath), '.git');
  try {
    if (existsSync(join(dotGit, 'HEAD'))) return dotGit;
    const text = readFileSync(dotGit, 'utf8');
    const m = /^gitdir: (.+)$/m.exec(text);
    if (!m) return null;
    const gitdir = resolve(repoPath, (m[1] as string).trim());
    const common = existsSync(join(gitdir, 'commondir')) ? resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()) : gitdir;
    return common;
  } catch {
    return null;
  }
}

/** The stash's reflog lines (exact bytes), oldest first. */
function stashLines(commonDir: string): Buffer[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(commonDir, 'logs', 'refs', 'stash'));
  } catch {
    return [];
  }
  const lines: Buffer[] = [];
  let at = 0;
  while (at < bytes.length) {
    const nl = bytes.indexOf(0x0a, at);
    const end = nl < 0 ? bytes.length : nl;
    if (end > at) lines.push(bytes.subarray(at, end));
    at = end + 1;
  }
  return lines;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Every entry of the stash, newest first, with each commit's subject. */
export function stashEntries(repoPath: string): StashEntry[] {
  const common = commonDirOf(repoPath);
  if (common === null) return [];
  const lines = stashLines(common);
  const out: StashEntry[] = [];
  for (const [i, line] of [...lines].reverse().entries()) {
    const fields = line.toString('latin1').split(' ');
    const sha = fields[1] ?? '';
    if (!OID.test(sha)) continue;
    const r = runGit(repoPath, ['log', '-1', '--format=%s', sha], { allowFail: true });
    out.push({ index: i, line, sha, subject: r.exitCode === 0 ? r.stdout.trim() : '' });
  }
  return out;
}

/** Whether a stash commit was made on `branch`'s worktree: its message names the branch, its first parent is on it. */
export function madeOnBranch(repoPath: string, entry: Pick<StashEntry, 'sha' | 'subject'>, branch: string): boolean {
  const m = /^(?:WIP on|On) (.+?): /.exec(entry.subject);
  if (m === null || m[1] !== branch) return false;
  const parent = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${entry.sha}^1`], { allowFail: true });
  if (parent.exitCode !== 0) return false;
  const exists = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
  if (exists.exitCode !== 0) return false;
  return runGit(repoPath, ['merge-base', '--is-ancestor', parent.stdout.trim(), `refs/heads/${branch}`], { allowFail: true }).exitCode === 0;
}

/**
 * Archive and drop every stash entry made on `branch` (under
 * `<archivePrefix>/<sha>`), leaving every other entry's reflog line as it
 * was. Null when the worktree left nothing in the stash. Throws when the
 * stash keeps moving under it (another hand is using it).
 */
export function quarantineStash(repoPath: string, branch: string, archivePrefix: string): StashQuarantine | null {
  const common = commonDirOf(repoPath);
  if (common === null) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const entries = stashEntries(repoPath);
    const owned = entries.filter((e) => madeOnBranch(repoPath, e, branch));
    if (owned.length === 0) return null;
    for (const e of owned) runGit(repoPath, ['update-ref', `${archivePrefix}/${e.sha}`, e.sha]);
    const ownedLines = new Set(owned.map((e) => e.line.toString('latin1')));
    const lines = stashLines(common);
    const remaining = lines.filter((l) => !ownedLines.has(l.toString('latin1')));
    const current = runGit(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/stash'], { allowFail: true });
    const was = current.exitCode === 0 ? current.stdout.trim() : null;
    const top = remaining.length > 0 ? ((remaining.at(-1) as Buffer).toString('latin1').split(' ')[1] ?? null) : null;
    // Only from the value just read: a stash that moved meanwhile is read again.
    const moved =
      top === was
        ? null
        : top === null
          ? runGit(repoPath, ['update-ref', '-d', 'refs/stash', was as string], { allowFail: true })
          : runGit(repoPath, ['update-ref', 'refs/stash', top, was ?? '0'.repeat(top.length)], { allowFail: true });
    if (moved !== null && moved.exitCode !== 0) continue;
    const log = join(common, 'logs', 'refs', 'stash');
    if (remaining.length === 0) {
      if (existsSync(log)) unlinkSync(log);
    } else {
      // update-ref appended its own line: the reflog goes back to the remaining entries' lines exactly.
      const tmp = `${log}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, Buffer.concat(remaining.flatMap((l) => [l, Buffer.from('\n')])));
      renameSync(tmp, log);
    }
    return { quarantined: owned.map((e) => ({ sha: e.sha, ref: `${archivePrefix}/${e.sha}`, message: e.subject.slice(0, 200) })), remaining: remaining.length };
  }
  throw new Error(`STASH_MOVING: the stash of ${repoPath} kept changing while ${branch}'s entries were being quarantined`);
}
