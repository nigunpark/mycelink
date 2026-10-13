/**
 * Roll chosen workspace deltas back to a target state — the bytes, absence,
 * mode or symlink target each had before a controller session (or the state
 * Mycelink's core last attested for it) — durably, idempotently and
 * verifiably (lib/controller-txn.mjs decides which deltas).
 *
 * A plan (planRollback) is computed from the snapshot the session left and
 * the targets, and closed under what a file system requires: everything
 * inside a directory that must go goes with it, and every ancestor of an
 * entry that must exist exists. It is written to `<txnDir>/plan.json` under
 * its own digest before anything changes, and each step that changes
 * something is journaled after it did (applied.jsonl).
 *
 * Every step compares the path's current state with the state the plan was
 * made from and with its target: already at the target, it is skipped (a
 * crash in the middle is finished by running the same plan again); at
 * neither, nothing is touched and the rollback stops with RollbackConflict
 * (the path changed after the snapshot: the caller snapshots again and
 * plans anew). Nothing is followed through a symlink: each step first checks
 * that every ancestor below the root is a real directory, a file is written
 * to a fresh temporary name beside its target, fsynced and renamed over it,
 * and a symlink is replaced by rename too. Directories are created owner-only
 * and get their final modes last, deepest first; a directory made
 * inaccessible is opened up for the restore and closed again.
 *
 * Refs are restored through git (`update-ref --stdin -z`, hardened: no hook
 * or helper runs), as one transaction per repository, each update
 * conditional on the value the snapshot saw. The stash's reflog — the stash
 * itself (CSET-203 r12) — is written back to its exact bytes after its ref
 * (update-ref appends a line of its own), or removed.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { absoluteBytes, captureSnapshot, excludedKey, indexSemantics, isIndexFile, isRefFile, keyBytes, readObject, relKey, showKey } from './snapshot.mjs';
import { safeGit } from './git.mjs';

export const PLAN_SCHEMA = 'mycelink-bench/rollback-plan@1';

/** A path changed after the snapshot a plan was made from: nothing of it was touched. */
export class RollbackConflict extends Error {
  constructor(key, detail) {
    super(`rollback conflict at ${showKey(key)}: ${detail}`);
    this.name = 'RollbackConflict';
    this.key = key;
  }
}

const parentKey = (key) => {
  const bytes = keyBytes(key);
  const i = bytes.lastIndexOf(0x2f);
  return i < 0 ? null : relKey(bytes.subarray(0, i));
};
const depth = (key) => keyBytes(key).filter((b) => b === 0x2f).length;
const isUnder = (key, dir) => {
  const k = keyBytes(key);
  const d = keyBytes(dir);
  return k.length > d.length && k[d.length] === 0x2f && k.subarray(0, d.length).equals(d);
};
const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const byDepthThen = (asc) => (a, b) => (depth(a) - depth(b)) * (asc ? 1 : -1) || Buffer.compare(keyBytes(a), keyBytes(b)) * (asc ? 1 : -1);

/** A target entry as a plan keeps it: what it must be (type, mode, content digest or symlink target). */
function targetOf(entry) {
  if (!entry) return null;
  const t = { t: entry.t, mode: entry.mode };
  if (entry.t === 'f') t.sha256 = entry.sha256 ?? null;
  if (entry.t === 'l') t.target = entry.target ?? null;
  if (entry.t === 'o') t.kind = entry.kind ?? null;
  return t;
}

/** What a post-snapshot entry is, as a plan checks it before touching the path. */
function fromOf(entry) {
  if (!entry) return null;
  const f = { t: entry.t, mode: entry.mode };
  if (entry.t === 'f') f.sha256 = entry.sha256 ?? null;
  if (entry.t === 'l') f.target = entry.target ?? null;
  if (entry.unreadable) f.unreadable = true;
  return f;
}

/**
 * Plan the rollback of `entries` (keys: each back to its state in `pre`)
 * and of any `targets` (`{ <key>: entry | null }`: each to the given state,
 * whose bytes the store holds), from the state in `post`, and of `refs`
 * (`[{ git, ref, pre, post }]`: each back to `pre`, or to `to` when given),
 * and of `reflogs` (`[{ git, ref: 'refs/stash', from, to }]`: the stash
 * reflog's digest now and the digest to restore, null for none). `dirs`:
 * directories a target may need that neither `pre` nor `post` holds (`{
 * <key>: mode }`). Returns the plan (not yet written).
 */
export function planRollback({ root, pre, post, entries = [], targets = {}, refs = [], reflogs = [], dirs = {} }) {
  const want = new Map();
  for (const key of entries) want.set(key, targetOf(pre.entries[key]));
  for (const [key, entry] of Object.entries(targets)) want.set(key, targetOf(entry));
  // What must go takes everything inside it along.
  for (const [key, target] of [...want]) {
    if (target?.t === 'd') continue;
    if (post.entries[key]?.t !== 'd') continue;
    for (const k of Object.keys(post.entries)) if (isUnder(k, key) && !want.has(k)) want.set(k, null);
  }
  // What must exist needs its ancestors, as directories.
  for (const [key, target] of [...want]) {
    if (target === null) continue;
    for (let p = parentKey(key); p !== null; p = parentKey(p)) {
      if (want.has(p)) {
        if (want.get(p)?.t !== 'd') throw new Error(`unplannable: ${showKey(key)} needs ${showKey(p)} to be a directory`);
        continue;
      }
      if (post.entries[p]?.t === 'd') continue;
      const before = pre.entries[p];
      if (before?.t !== 'd' && dirs[p] === undefined) throw new Error(`unplannable: ${showKey(key)} needs ${showKey(p)}, which was no directory before either`);
      want.set(p, before?.t === 'd' ? targetOf(before) : { t: 'd', mode: dirs[p] });
    }
  }
  const steps = [];
  const add = (step) => steps.push({ id: steps.length + 1, ...step });
  const keys = [...want.keys()];
  // 1. remove what is there and must not be, deepest first.
  for (const key of [...keys].sort(byDepthThen(false))) {
    const now = post.entries[key];
    const target = want.get(key);
    if (!now) continue;
    if (target === null || target.t !== now.t) add({ op: 'remove', key, from: fromOf(now) });
  }
  // 2. make the directories that must exist, shallowest first.
  for (const key of [...keys].sort(byDepthThen(true))) {
    const target = want.get(key);
    if (target?.t !== 'd') continue;
    const now = post.entries[key];
    if (now?.t !== 'd') add({ op: 'mkdir', key, mode: target.mode });
  }
  // 3. write files and symlinks.
  for (const key of [...keys].sort(byDepthThen(true))) {
    const target = want.get(key);
    if (target === null || target.t === 'd') continue;
    const now = post.entries[key];
    const from = now && now.t === target.t ? fromOf(now) : null;
    if (target.t === 'f') {
      if (!target.sha256) throw new Error(`unplannable: no content for ${showKey(key)}`);
      if (from && from.sha256 === target.sha256 && !from.unreadable) continue;
      add({ op: 'write', key, sha256: target.sha256, mode: target.mode, from });
    } else if (target.t === 'l') {
      if (from && from.target === target.target) continue;
      add({ op: 'symlink', key, target: target.target, from });
    } else {
      throw new Error(`unplannable: ${showKey(key)} was a ${target.kind ?? 'special file'}, which a rollback does not recreate`);
    }
  }
  // 4. final modes, deepest first (a directory closes after what is inside it is restored).
  for (const key of [...keys].sort(byDepthThen(false))) {
    const target = want.get(key);
    if (target === null || target.t === 'l') continue;
    add({ op: 'chmod', key, mode: target.mode, t: target.t });
  }
  const refPlan = [];
  const byGit = new Map();
  for (const r of refs) {
    const to = r.to === undefined ? r.pre : r.to;
    if ((to ?? null) === (r.post ?? null)) continue;
    if ((to ?? '').startsWith('ref: ') || (r.post ?? '').startsWith('ref: ')) throw new Error(`unplannable: the symbolic ref ${r.ref} in ${showKey(r.git)}`);
    if (!byGit.has(r.git)) byGit.set(r.git, []);
    byGit.get(r.git).push({ ref: r.ref, from: r.post ?? null, to: to ?? null });
  }
  for (const [git, updates] of byGit) refPlan.push({ git, updates: updates.sort((a, b) => (a.ref < b.ref ? -1 : 1)) });
  const targetsOut = {};
  for (const key of [...keys].sort()) targetsOut[key] = want.get(key);
  const reflogPlan = reflogs.filter((r) => (r.from ?? null) !== (r.to ?? null)).map((r) => ({ git: r.git, ref: r.ref, from: r.from ?? null, to: r.to ?? null })).sort((a, b) => (a.git < b.git ? -1 : a.git > b.git ? 1 : 0));
  const plan = { schema: PLAN_SCHEMA, root, post_digest: post.digest, targets: targetsOut, steps, refs: refPlan, ...(reflogPlan.length > 0 ? { reflogs: reflogPlan } : {}) };
  plan.sha256 = sha256Hex(canonicalJson(plan));
  return plan;
}

/** Write the plan durably, unless the same plan is already there. */
function persistPlan(txnDir, plan) {
  mkdirSync(txnDir, { recursive: true });
  const file = join(txnDir, 'plan.json');
  if (existsSync(file)) {
    const old = loadPlan(txnDir);
    if (old.sha256 !== plan.sha256) throw new Error(`${file} holds another plan (${old.sha256.slice(0, 12)})`);
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(plan, null, 1)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** The plan in `txnDir`, checked against its own digest. */
export function loadPlan(txnDir) {
  const plan = JSON.parse(readFileSync(join(txnDir, 'plan.json'), 'utf8'));
  const { sha256, ...rest } = plan;
  if (plan?.schema !== PLAN_SCHEMA || sha256Hex(canonicalJson(rest)) !== sha256) throw new Error(`${join(txnDir, 'plan.json')} does not match its digest`);
  return plan;
}

/** The state of one path now, as a plan compares it (a file by its content's digest). */
function stateNow(root, key) {
  const abs = absoluteBytes(root, key);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  const t = st.isFile() ? 'f' : st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'o';
  const out = { t, mode: st.mode & 0o7777 };
  if (t === 'f') {
    try {
      out.sha256 = sha256Hex(readFileSync(abs));
    } catch {
      out.sha256 = null;
      out.unreadable = true;
    }
  }
  if (t === 'l') out.target = relKey(readlinkSync(abs, { encoding: 'buffer' }));
  return out;
}

const matches = (now, want) => {
  if (want === null) return now === null;
  if (now === null || now.t !== want.t) return false;
  if (want.t === 'f') return now.sha256 === want.sha256 && !now.unreadable;
  if (want.t === 'l') return now.target === want.target;
  return true;
};

/**
 * Every ancestor of `key` below the root, shallowest first, must be a real
 * directory (never a symlink); one the owner cannot search or write is
 * opened up on the way (`onOpen(key, mode)` is told), so nothing inside it
 * is out of reach.
 */
function realAncestors(root, key, onOpen) {
  const chain = [];
  for (let p = parentKey(key); p !== null; p = parentKey(p)) chain.unshift(p);
  for (const p of chain) {
    const abs = absoluteBytes(root, p);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      throw new RollbackConflict(key, `${showKey(p)} does not exist`);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new RollbackConflict(key, `${showKey(p)} is not a directory`);
    const mode = st.mode & 0o7777;
    if (process.platform !== 'win32' && (mode & 0o700) !== 0o700) {
      onOpen(p, mode);
      chmodSync(abs, mode | 0o700);
    }
  }
  return chain;
}

/**
 * What every snapshot leaves out inside a directory that must go — a Git
 * directory's objects and reflogs, git's own scratch files (the admin
 * directory of a worktree made in the session keeps its reflog) — goes with
 * it. Anything else still inside is left alone: false.
 */
function clearExcluded(root, key) {
  const children = readdirSync(absoluteBytes(root, key), { encoding: 'buffer' }).map((name) => relKey(Buffer.concat([keyBytes(key), Buffer.from('/'), name])));
  if (!children.every((child) => excludedKey(child, lstatSync(absoluteBytes(root, child)).isDirectory()))) return false;
  for (const child of children) rmSync(absoluteBytes(root, child), { recursive: true, force: true });
  return true;
}

/**
 * Apply a plan (writing it to `<txnDir>/plan.json` first). Returns
 * `{ applied, skipped, refs }`. `faults.crashAfterSteps` throws after that
 * many applied steps (tests: a crash in the middle). Throws RollbackConflict
 * when a path is neither as planned from nor at its target.
 */
export function applyRollback({ root, store, plan, txnDir, faults = {} }) {
  persistPlan(txnDir, plan);
  const journal = join(txnDir, 'applied.jsonl');
  let applied = 0;
  let skipped = 0;
  // Directories opened up to restore what is inside them: closed again at the end.
  const opened = new Map();
  const open = (key) => realAncestors(root, key, (p, mode) => {
    if (!opened.has(p)) opened.set(p, mode);
  });
  const done = (step) => {
    appendFileSync(journal, `${JSON.stringify({ id: step.id, op: step.op, key: step.key, at: new Date().toISOString() })}\n`);
    applied += 1;
    if (faults.crashAfterSteps !== undefined && applied >= faults.crashAfterSteps) throw new Error(`injected crash after ${applied} step(s)`);
  };
  const scratchBeside = (key) => Buffer.concat([absoluteBytes(root, parentKey(key) ?? ''), Buffer.from(`/.mycelink-restore-${randomBytes(6).toString('hex')}`)]);
  for (const step of plan.steps) {
    open(step.key);
    const abs = absoluteBytes(root, step.key);
    if (step.op === 'chmod') {
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        throw new RollbackConflict(step.key, 'gone before its mode was restored');
      }
      opened.delete(step.key);
      if ((st.mode & 0o7777) === step.mode) {
        skipped += 1;
        continue;
      }
      chmodSync(abs, step.mode);
      done(step);
      continue;
    }
    const want = step.op === 'remove' ? null : step.op === 'mkdir' ? { t: 'd' } : step.op === 'write' ? { t: 'f', sha256: step.sha256 } : { t: 'l', target: step.target };
    const now = stateNow(root, step.key);
    if (matches(now, want)) {
      skipped += 1;
      continue;
    }
    const from = step.from ?? null;
    if (!matches(now, from)) throw new RollbackConflict(step.key, `found ${JSON.stringify(now)}, planned from ${JSON.stringify(from)}`);
    if (step.op === 'remove') {
      if (now.t === 'd') {
        if (process.platform !== 'win32') chmodSync(abs, now.mode | 0o700);
        try {
          rmdirSync(abs);
        } catch (error) {
          // What the snapshot could not see inside it (it was unreadable) shows in the next snapshot.
          if (!(['ENOTEMPTY', 'EEXIST'].includes(error.code) && clearExcluded(root, step.key))) throw new RollbackConflict(step.key, `the directory still holds something (${error.code})`);
          rmdirSync(abs);
        }
      } else unlinkSync(abs);
    } else if (step.op === 'mkdir') {
      mkdirSync(abs, { mode: 0o700 });
    } else if (step.op === 'write') {
      if (now?.t === 'd') throw new RollbackConflict(step.key, 'a directory stands where the file goes');
      const bytes = readObject(store, step.sha256);
      if (bytes === null) throw new Error(`the store has no intact object ${step.sha256} for ${showKey(step.key)}`);
      const tmp = scratchBeside(step.key);
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, step.mode);
      renameSync(tmp, abs);
    } else if (step.op === 'symlink') {
      if (now?.t === 'd') throw new RollbackConflict(step.key, 'a directory stands where the symlink goes');
      const tmp = scratchBeside(step.key);
      symlinkSync(keyBytes(step.target), tmp);
      renameSync(tmp, abs);
    }
    done(step);
  }
  // Directories opened along the way and given no mode of their own: as they were.
  for (const [key, mode] of [...opened].sort((a, b) => byDepthThen(false)(a[0], b[0]))) {
    try {
      chmodSync(absoluteBytes(root, key), mode);
    } catch {
      // removed since
    }
  }
  let refUpdates = 0;
  for (const r of plan.refs ?? []) {
    const gitDir = Buffer.from(absoluteBytes(root, r.git)).toString();
    const zero = '0'.repeat(40);
    const lines = [];
    for (const u of r.updates) {
      const current = refValue(gitDir, u.ref);
      if ((current ?? null) === (u.to ?? null)) continue;
      if ((current ?? null) !== (u.from ?? null)) throw new RollbackConflict(r.git, `${u.ref} is at ${current ?? 'nothing'}, planned from ${u.from ?? 'nothing'}`);
      if (u.to === null) lines.push(`delete ${u.ref}\0${u.from}\0`);
      else lines.push(`update ${u.ref}\0${u.to}\0${u.from ?? zero}\0`);
    }
    if (lines.length === 0) continue;
    const res = safeGit(dirname(gitDir), ['--git-dir', gitDir, 'update-ref', '--stdin', '-z'], { input: lines.join('') });
    if (res.code !== 0) throw new RollbackConflict(r.git, `git update-ref refused: ${res.stderr.split('\n')[0]}`);
    appendFileSync(journal, `${JSON.stringify({ op: 'refs', git: r.git, updates: lines.length, at: new Date().toISOString() })}\n`);
    refUpdates += lines.length;
    applied += 1;
  }
  // The stash's reflog, after its ref: update-ref appended a line of its own to it, which the exact bytes replace.
  const moving = new Set((plan.refs ?? []).flatMap((r) => r.updates.map((u) => `${r.git}\0${u.ref}`)));
  for (const r of plan.reflogs ?? []) {
    const file = Buffer.concat([absoluteBytes(root, r.git), Buffer.from(`/logs/${r.ref}`)]);
    const now = fileDigest(file);
    if (now === (r.to ?? null)) {
      skipped += 1;
      continue;
    }
    if (!moving.has(`${r.git}\0${r.ref}`) && now !== (r.from ?? null)) throw new RollbackConflict(r.git, `the reflog of ${r.ref} is at ${now ?? 'nothing'}, planned from ${r.from ?? 'nothing'}`);
    if (r.to === null) {
      if (now !== null) unlinkSync(file);
    } else {
      const bytes = readObject(store, r.to);
      if (bytes === null) throw new Error(`the store has no intact object ${r.to} for the reflog of ${r.ref} in ${showKey(r.git)}`);
      mkdirSync(dirname(file.toString()), { recursive: true });
      const tmp = Buffer.concat([file, Buffer.from(`.mycelink-restore-${randomBytes(6).toString('hex')}`)]);
      const fd = openSync(tmp, 'wx', 0o644);
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    }
    appendFileSync(journal, `${JSON.stringify({ op: 'reflog', git: r.git, ref: r.ref, to: r.to, at: new Date().toISOString() })}\n`);
    applied += 1;
  }
  return { applied, skipped, refs: refUpdates };
}

/** The SHA-256 of a file's bytes, or null when there is none. */
function fileDigest(path) {
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return null;
  }
}

/** What a ref names now (git, hardened), or null. */
function refValue(gitDir, ref) {
  const r = safeGit(dirname(gitDir), ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${ref}^{object}`]);
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(r.stdout) ? r.stdout : null;
}

/**
 * Check a rollback: a fresh snapshot (the post snapshot its stat cache) must
 * hold every target of the plan and leave every other entry as the session
 * left it (an index compared by what it stages when both sides can be read),
 * and every repository's refs must be the plan's. Returns `{ ok,
 * mismatches, digest, snapshot }`.
 */
export function verifyRollback({ root, store, post, plan }) {
  const now = captureSnapshot({ root, store, previous: post });
  const mismatches = [];
  const keys = new Set([...Object.keys(post.entries), ...Object.keys(now.entries), ...Object.keys(plan.targets)]);
  const view = (entry, staged) => {
    const v = entry && { ...entry };
    if (v?.t === 'f' && staged) {
      delete v.sha256;
      v.staged = staged;
    }
    return v ?? null;
  };
  for (const key of keys) {
    if (isRefFile(key)) continue;
    const planned = key in plan.targets;
    const expected = planned ? plan.targets[key] : targetOf(post.entries[key]);
    const actual = targetOf(now.entries[key]);
    let wantStaged = null;
    if (isIndexFile(key) && expected?.t === 'f') {
      const bytes = planned ? readObject(store, expected.sha256) : null;
      wantStaged = planned ? (bytes === null ? null : indexSemantics(bytes)) : (post.indexes?.[key] ?? null);
    }
    const haveStaged = now.indexes?.[key] ?? null;
    const bySemantics = wantStaged !== null && haveStaged !== null;
    const e = view(expected, bySemantics ? wantStaged : null);
    const a = view(actual, bySemantics ? haveStaged : null);
    if (!same(e, a)) mismatches.push({ key: showKey(key), expected: e, actual: a });
  }
  const refsWant = {};
  for (const [g, v] of Object.entries(post.git ?? {})) refsWant[g] = { ...v.refs };
  for (const r of plan.refs ?? []) {
    refsWant[r.git] ??= {};
    for (const u of r.updates) {
      if (u.to === null) delete refsWant[r.git][u.ref];
      else refsWant[r.git][u.ref] = u.to;
    }
  }
  for (const g of new Set([...Object.keys(refsWant), ...Object.keys(now.git ?? {})])) {
    const want = refsWant[g] ?? {};
    const have = now.git?.[g]?.refs ?? {};
    for (const ref of new Set([...Object.keys(want), ...Object.keys(have)])) {
      if ((want[ref] ?? null) !== (have[ref] ?? null)) mismatches.push({ key: `${showKey(g)}:${ref}`, expected: want[ref] ?? null, actual: have[ref] ?? null });
    }
  }
  // The stash's reflog: the plan's bytes, or as the session left it.
  const logsWant = {};
  for (const [g, v] of Object.entries(post.git ?? {})) logsWant[g] = v.stash_log?.sha256 ?? null;
  for (const r of plan.reflogs ?? []) logsWant[r.git] = r.to ?? null;
  for (const g of new Set([...Object.keys(logsWant), ...Object.keys(now.git ?? {})])) {
    const have = now.git?.[g]?.stash_log?.sha256 ?? null;
    if ((logsWant[g] ?? null) !== have) mismatches.push({ key: `${showKey(g)}:logs/refs/stash`, expected: logsWant[g] ?? null, actual: have });
  }
  return { ok: mismatches.length === 0, mismatches, digest: now.digest, snapshot: now };
}
