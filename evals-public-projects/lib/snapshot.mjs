/**
 * A workspace's file system and Git state at one instant, durable and
 * content-addressed: the before and after of a with-arm controller session
 * (lib/controller-txn.mjs), and what a rollback restores (lib/rollback.mjs).
 *
 * Every entry under the root is recorded under its name's bytes (any byte
 * string Linux allows, a newline or invalid UTF-8 included): its type (file,
 * directory, symlink, other), permission bits, size and SHA-256 (a file),
 * target (a symlink). A file's bytes go to the content store once per digest.
 * Nothing is followed: a symlink is recorded as one and a directory is never
 * entered through one; a file is read only while it is still the regular file
 * lstat saw (no-follow, the same inode), so a FIFO or a device is never
 * opened. A directory the walk cannot list, or a file it cannot read, is
 * recorded as unreadable.
 *
 * Git is read from its files, never by running git in a repository under
 * judgement: the object stores and reflogs are left out (append-only and
 * content-addressed), as are the scratch files git rewrites on its own
 * (ORIG_HEAD, FETCH_HEAD, COMMIT_EDITMSG, AUTO_MERGE, gc.log); each `.git`
 * directory's refs, loose and packed, are read as what they name, and each
 * index as what it stages — so a status that only refreshes stat data is no
 * change, and a ref packed by a gc is the same ref. A linked worktree's own
 * refs are named `worktrees/<name>/refs/...`. The one reflog read is the
 * stash's (`stash_log`, its bytes in the store): one line per stash entry,
 * it is the stash itself (CSET-203 r12).
 *
 * A previous snapshot of the same root is a stat cache: a file whose inode,
 * size, mtime, ctime and mode are unchanged keeps its digest unread (ctime
 * cannot be set back from user space) — unless it changed within RACY_MS
 * before that snapshot began: a write in the same clock tick as the read
 * leaves the times as they were (git's racy-index problem), so such a file
 * is read again.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256Hex } from './hash.mjs';

export const SNAPSHOT_SCHEMA = 'mycelink-bench/workspace-snapshot@1';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const SEP = Buffer.from('/');
/** How close to a snapshot's start a file's change must be for its cached digest to be distrusted (clock ticks: ~4 ms ext4, ~16 ms NTFS). */
export const RACY_MS = 100;

// ---- names ------------------------------------------------------------------

const B64 = '\0b64:';

/** A relative path's key: its text when its bytes are UTF-8 that round-trips, else `\0b64:` and the bytes. */
export function relKey(bytes) {
  const text = bytes.toString('utf8');
  return !text.startsWith('\0') && Buffer.from(text, 'utf8').equals(bytes) ? text : `${B64}${bytes.toString('base64')}`;
}

/** The bytes of a key. */
export function keyBytes(key) {
  return key.startsWith(B64) ? Buffer.from(key.slice(B64.length), 'base64') : Buffer.from(key, 'utf8');
}

/** The absolute path of a key under `root`, as bytes (Linux allows any byte but '/' and NUL in a name). */
export function absoluteBytes(root, key) {
  return key === '' ? Buffer.from(root) : Buffer.concat([Buffer.from(root), SEP, keyBytes(key)]);
}

/**
 * A key as a person may be shown it: control characters, backslashes and
 * bytes that are not UTF-8 escaped (`\n`, `\x1b`, `\xff`), never raw, and at
 * most `max` characters.
 */
export function showKey(key, max = 160) {
  const bytes = keyBytes(key);
  let out = '';
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes)) {
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0) || c === 0x2028 || c === 0x2029) out += `\\x${c.toString(16).padStart(2, '0')}`;
      else out += ch;
    }
  } else {
    for (const b of bytes) out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// ---- what is left out, what is read as Git ---------------------------------

/** A `.git` directory (a repository's, a submodule's under modules/, a worktree's under worktrees/) and what follows it. */
const GIT_PART = /(?:^|\/)\.git(?:\/modules\/(?:[^/]+\/)*?[^/]+)?(?:\/worktrees\/[^/]+)?\//;
/** Git's object stores and reflogs: append-only, never restored. */
const EXCLUDED_DIR = /(?:^|\/)\.git(?:\/modules\/(?:[^/]+\/)*?[^/]+)?(?:\/worktrees\/[^/]+)?\/(?:objects|logs)$/;
/** Scratch files git rewrites by itself on ordinary commands; nothing reads them to decide anything. */
const EXCLUDED_FILE = /(?:^|\/)\.git(?:\/modules\/(?:[^/]+\/)*?[^/]+)?(?:\/worktrees\/[^/]+)?\/(?:ORIG_HEAD|FETCH_HEAD|COMMIT_EDITMSG|AUTO_MERGE|gc\.log)$/;
/** A ref file (loose, packed): read as the refs it names, not compared as bytes. A `.lock` beside one (left by a git killed with its session) is no ref — no ref name ends so — but a file. */
const REF_FILE = /^(.*?\.git)(?:\/worktrees\/([^/]+))?\/(refs\/.+|packed-refs)(?<!\.lock)$/;
/** An index file: read as what it stages. */
const INDEX_FILE = /(?:^|\/)\.git(?:\/worktrees\/[^/]+)?\/index$/;

const latin = (key) => keyBytes(key).toString('latin1');

/** Is this key left out of every snapshot (and so never restored)? */
export function excludedKey(key, isDir) {
  const k = latin(key);
  return isDir ? EXCLUDED_DIR.test(k) : EXCLUDED_FILE.test(k);
}

/** Is this key inside some `.git` directory? */
export function inGitDir(key) {
  return GIT_PART.test(latin(key));
}

/** Is this key inside a directory every snapshot leaves out (a Git object store, a reflog directory)? */
export function insideExcluded(key) {
  return /(?:^|\/)\.git(?:\/modules\/(?:[^/]+\/)*?[^/]+)?(?:\/worktrees\/[^/]+)?\/(?:objects|logs)(?:\/|$)/.test(latin(key));
}

// ---- the content store -------------------------------------------------------

/** Where the store keeps the bytes of `sha256`. */
export function objectPath(store, sha256) {
  return join(store, 'objects', sha256.slice(0, 2), sha256);
}

/** Put bytes into the store (once per digest); returns the digest. */
export function putObject(store, bytes) {
  const sha = sha256Hex(bytes);
  const path = objectPath(store, sha);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, bytes, { flag: 'wx' });
    renameSync(tmp, path);
  }
  return sha;
}

/** The bytes the store holds for `sha256`, checked against it; null when missing or corrupt. */
export function readObject(store, sha256) {
  try {
    const bytes = readFileSync(objectPath(store, sha256));
    return sha256Hex(bytes) === sha256 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Read a regular file that lstat saw — no-follow, and only while it is the
 * same inode — hashing it and copying it into the store as it goes.
 * Returns `{ sha256, size }`, or null when it is no longer that file or
 * cannot be read.
 */
function hashIntoStore(store, path, seen) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return null;
  }
  const tmpDir = join(store, 'tmp');
  let tmp = null;
  let out = null;
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || (seen && (st.ino !== seen.ino || st.dev !== seen.dev))) return null;
    mkdirSync(tmpDir, { recursive: true });
    tmp = join(tmpDir, `${process.pid}.${randomBytes(6).toString('hex')}`);
    out = openSync(tmp, 'wx');
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(1 << 16);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      writeSync(out, buf, 0, n);
      size += n;
    }
    closeSync(out);
    out = null;
    const sha = hash.digest('hex');
    const dest = objectPath(store, sha);
    if (existsSync(dest)) unlinkSync(tmp);
    else {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(tmp, dest);
    }
    tmp = null;
    return { sha256: sha, size };
  } catch {
    return null;
  } finally {
    if (out !== null) closeSync(out);
    if (tmp !== null) rmSync(tmp, { force: true });
    closeSync(fd);
  }
}

// ---- Git, from its files -------------------------------------------------------

/**
 * What an index stages: SHA-256 over each entry's mode, object id, stage,
 * extended flags and path, in index order — stat data and extensions (the
 * tree and untracked caches a status refreshes) left out. Versions 2, 3 and
 * 4 (path compression); null for anything it cannot read whole (a split
 * index's shared part, a truncated file), which is then compared as bytes.
 */
export function indexSemantics(bytes, hashLength = 20) {
  try {
    if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'DIRC') return null;
    const version = bytes.readUInt32BE(4);
    if (version < 2 || version > 4) return null;
    const count = bytes.readUInt32BE(8);
    const hash = createHash('sha256');
    let at = 12;
    let previous = Buffer.alloc(0);
    for (let i = 0; i < count; i++) {
      const start = at;
      const mode = bytes.readUInt32BE(at + 24);
      const oid = bytes.toString('hex', at + 40, at + 40 + hashLength);
      at += 40 + hashLength;
      const flags = bytes.readUInt16BE(at);
      at += 2;
      let extended = 0;
      if (version >= 3 && flags & 0x4000) {
        extended = bytes.readUInt16BE(at);
        at += 2;
      }
      let path;
      if (version === 4) {
        let strip = 0;
        let b = bytes[at++];
        strip = b & 0x7f;
        while (b & 0x80) {
          b = bytes[at++];
          strip = ((strip + 1) << 7) | (b & 0x7f);
        }
        const end = bytes.indexOf(0, at);
        if (end < 0 || strip > previous.length) return null;
        path = Buffer.concat([previous.subarray(0, previous.length - strip), bytes.subarray(at, end)]);
        at = end + 1;
      } else {
        const end = bytes.indexOf(0, at);
        if (end < 0) return null;
        path = bytes.subarray(at, end);
        // Entries are padded with 1 to 8 NULs to a multiple of 8 bytes.
        at = start + Math.ceil((end - start + 1) / 8) * 8;
      }
      if (at > bytes.length) return null;
      previous = path;
      hash.update(`${mode.toString(8)} ${oid} ${(flags >> 12) & 3} ${extended & 0x6000}\t`);
      hash.update(path);
      hash.update('\0');
    }
    // A split index stages part of its entries in a shared file: not read whole here.
    for (let x = at; x + 8 <= bytes.length - hashLength; ) {
      const sig = bytes.toString('latin1', x, x + 4);
      if (sig === 'link') return null;
      x += 8 + bytes.readUInt32BE(x + 4);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/** The refs one `.git` directory's ref files name: packed refs overlaid by loose ones; a symbolic ref as `ref: <target>`. */
function refsOf(entries, store, gitKey) {
  const refs = {};
  const problems = [];
  const value = (bytes) => {
    const text = bytes.toString('utf8').trim();
    if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text)) return text;
    if (/^ref: \S+$/.test(text)) return text;
    return null;
  };
  const packed = entries[`${gitKey}/packed-refs`];
  if (packed?.t === 'f' && packed.sha256) {
    const bytes = readObject(store, packed.sha256);
    if (bytes === null) problems.push('packed-refs unreadable');
    else {
      for (const line of bytes.toString('utf8').split('\n')) {
        if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
        const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\S+)$/.exec(line);
        if (m) refs[m[2]] = m[1];
        else problems.push(`packed-refs line ${JSON.stringify(line.slice(0, 80))}`);
      }
    }
  }
  const prefix = `${gitKey}/refs/`;
  // A linked worktree's own refs (refs/bisect, refs/worktree, ...): named as git names them, `worktrees/<name>/refs/...`.
  const own = new RegExp(`^${gitKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/worktrees/[^/]+/refs/`);
  for (const [key, e] of Object.entries(entries)) {
    if ((!key.startsWith(prefix) && !own.test(key)) || e.t !== 'f' || !isRefFile(key)) continue;
    const bytes = e.sha256 ? readObject(store, e.sha256) : null;
    const v = bytes === null ? null : value(bytes);
    if (v === null) problems.push(`${showKey(key)} is not a ref`);
    else refs[key.slice(gitKey.length + 1)] = v;
  }
  return { refs, problems };
}

/**
 * The stash's reflog (CSET-203 r12): one line per stash entry, so the stash
 * itself — unlike every other reflog, append-only and left out. Read from
 * the `.git` directory directly, its bytes put into the store; null when
 * there is none.
 */
function stashLogOf(root, store, gitKey) {
  const abs = Buffer.concat([Buffer.from(root), SEP, keyBytes(gitKey), Buffer.from('/logs/refs/stash')]);
  let st;
  try {
    st = lstatSync(abs, { bigint: true });
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const read = hashIntoStore(store, abs, st);
  return read === null ? null : { sha256: read.sha256, size: read.size };
}

/** Is this repository's object format SHA-256 (its config says so)? */
function hashLengthOf(entries, store, gitKey) {
  const config = entries[`${gitKey}/config`];
  const bytes = config?.t === 'f' && config.sha256 ? readObject(store, config.sha256) : null;
  return bytes !== null && /^\s*objectformat\s*=\s*sha256\s*$/im.test(bytes.toString('utf8')) ? 32 : 20;
}

// ---- the snapshot ----------------------------------------------------------------

const typeOf = (st) => (st.isFile() ? 'f' : st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'o');
const otherKind = (st) => (st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : st.isCharacterDevice() ? 'char' : st.isBlockDevice() ? 'block' : 'unknown');

/**
 * Capture `root` into a snapshot, its file contents into `store`.
 * `previous` (a snapshot of the same root) is the stat cache. Returns
 * `{ schema, root, taken_at, entries: { <key>: entry }, git: { <.git key>:
 * { refs, problems } }, indexes: { <key>: semantic digest | null }, digest,
 * stats }`; an entry is `{ t, mode, size?, sha256?, target?, kind?,
 * unreadable?, ino, dev, mtime_ns, ctime_ns }`. `skip(key)` names
 * directories not to walk (their entries are copied from `previous`).
 */
export function captureSnapshot({ root, store, previous = null, racyMs = RACY_MS, skip = null }) {
  const started = Date.now();
  const entries = {};
  const stats = { entries: 0, hashed: 0, reused: 0, bytes_hashed: 0, unreadable: 0, skipped: 0, ms: 0 };
  const rootBuf = Buffer.from(root);
  const cache = previous?.root === root ? previous.entries : null;
  // A file changed this close to the previous snapshot's start may have changed again in the same clock tick.
  const settled = previous?.started_ms === undefined ? null : BigInt(previous.started_ms - racyMs) * 1_000_000n;
  const trusted = (old) => settled !== null && BigInt(old.ctime_ns) < settled && BigInt(old.mtime_ns) < settled;
  const stack = [Buffer.alloc(0)];
  while (stack.length > 0) {
    const dirRel = stack.pop();
    const dirAbs = dirRel.length === 0 ? rootBuf : Buffer.concat([rootBuf, SEP, dirRel]);
    let names;
    try {
      names = readdirSync(dirAbs, { encoding: 'buffer' });
    } catch {
      if (dirRel.length > 0) {
        entries[relKey(dirRel)].unreadable = true;
        stats.unreadable += 1;
      }
      continue;
    }
    names.sort(Buffer.compare);
    for (const name of names) {
      const rel = dirRel.length === 0 ? Buffer.from(name) : Buffer.concat([dirRel, SEP, name]);
      const key = relKey(rel);
      const abs = Buffer.concat([rootBuf, SEP, rel]);
      let st;
      try {
        st = lstatSync(abs, { bigint: true });
      } catch {
        continue; // gone meanwhile
      }
      const t = typeOf(st);
      if (excludedKey(key, t === 'd')) continue;
      const entry = { t, mode: Number(st.mode & 0o7777n), ino: String(st.ino), dev: String(st.dev), mtime_ns: String(st.mtimeNs), ctime_ns: String(st.ctimeNs) };
      if (t === 'f') {
        entry.size = Number(st.size);
        const old = cache?.[key];
        if (old && old.t === 'f' && old.sha256 && old.ino === entry.ino && old.dev === entry.dev && old.size === entry.size && old.mtime_ns === entry.mtime_ns && old.ctime_ns === entry.ctime_ns && old.mode === entry.mode && trusted(old) && existsSync(objectPath(store, old.sha256))) {
          entry.sha256 = old.sha256;
          stats.reused += 1;
        } else {
          const read = hashIntoStore(store, abs, st);
          if (read === null) {
            entry.unreadable = true;
            stats.unreadable += 1;
          } else {
            entry.sha256 = read.sha256;
            entry.size = read.size;
            stats.hashed += 1;
            stats.bytes_hashed += read.size;
          }
        }
      } else if (t === 'l') {
        try {
          entry.target = relKey(readlinkSync(abs, { encoding: 'buffer' }));
        } catch {
          entry.unreadable = true;
        }
      } else if (t === 'o') {
        entry.kind = otherKind(st);
      }
      entries[key] = entry;
      stats.entries += 1;
      if (t !== 'd') continue;
      // A light snapshot skips subtrees (a worktree, node_modules): what is inside is taken as `previous` had it.
      if (skip !== null && skip(key)) {
        const prefix = `${key}/`;
        for (const [k, e] of Object.entries(previous?.entries ?? {})) {
          if (!k.startsWith(prefix)) continue;
          entries[k] = e;
          stats.skipped += 1;
        }
        continue;
      }
      stack.push(rel);
    }
  }
  // Git, from its files: each `.git` directory's refs, each index's staged entries.
  const git = {};
  const indexes = {};
  for (const [key, e] of Object.entries(entries)) {
    if (e.t !== 'd' || !/(?:^|\/)\.git$/.test(key)) continue;
    git[key] = refsOf(entries, store, key);
    const stash = stashLogOf(root, store, key);
    if (stash !== null) git[key].stash_log = stash;
  }
  for (const [key, e] of Object.entries(entries)) {
    if (e.t !== 'f' || !INDEX_FILE.test(latin(key))) continue;
    const gitKey = /^(.*?\.git)(?:\/worktrees\/[^/]+)?\/index$/.exec(key)?.[1] ?? null;
    const bytes = e.sha256 ? readObject(store, e.sha256) : null;
    indexes[key] = bytes === null ? null : indexSemantics(bytes, gitKey ? hashLengthOf(entries, store, gitKey) : 20);
  }
  stats.ms = Date.now() - started;
  const snapshot = { schema: SNAPSHOT_SCHEMA, root, taken_at: new Date().toISOString(), started_ms: started, entries, git, indexes, stats };
  snapshot.digest = snapshotDigest(snapshot);
  return snapshot;
}

/** Is this key a ref file (read as refs, never compared as bytes)? */
export function isRefFile(key) {
  return REF_FILE.test(latin(key));
}

/** Is this key an index file (compared by what it stages)? */
export function isIndexFile(key) {
  return INDEX_FILE.test(latin(key));
}

/** What an entry is, for comparison: type, mode, content or target, kind; an index by what it stages when that can be read. */
export function semanticEntry(snapshot, key) {
  const e = snapshot.entries[key];
  if (!e) return null;
  const out = { t: e.t, mode: e.mode };
  if (e.t === 'f') {
    const staged = isIndexFile(key) ? snapshot.indexes?.[key] : null;
    if (staged) out.staged = staged;
    else out.sha256 = e.sha256 ?? null;
  }
  if (e.t === 'l') out.target = e.target ?? null;
  if (e.t === 'o') out.kind = e.kind ?? null;
  if (e.unreadable) out.unreadable = true;
  return out;
}

/** The snapshot's digest: every entry by what it is (ref files as the refs they name), every repository's refs and stash reflog. */
export function snapshotDigest(snapshot) {
  const entries = {};
  for (const key of Object.keys(snapshot.entries).sort()) if (!isRefFile(key)) entries[key] = semanticEntry(snapshot, key);
  const refs = {};
  const stashes = {};
  for (const [k, g] of Object.entries(snapshot.git ?? {})) {
    refs[k] = g.refs;
    if (g.stash_log) stashes[k] = g.stash_log.sha256;
  }
  return sha256Hex(canonicalJson(Object.keys(stashes).length > 0 ? { entries, refs, stashes } : { entries, refs }));
}

const same = (a, b) => canonicalJson(a) === canonicalJson(b);

/**
 * What changed from `pre` to `post`: `{ entries: [{ key, change, pre, post }],
 * refs: [{ git, ref, pre, post }] }` — an entry `created`, `deleted`,
 * `modified` (content), `type`, `mode` or `target` (a symlink), its pre and
 * post entries; a ref by the `.git` directory it is in and the values it
 * named (null: absent). Ref files are compared as refs, indexes by what
 * they stage.
 */
export function diffSnapshots(pre, post) {
  const out = { entries: [], refs: [], reflogs: [] };
  const keys = new Set([...Object.keys(pre.entries), ...Object.keys(post.entries)]);
  for (const key of [...keys].sort()) {
    if (isRefFile(key)) continue;
    const a = semanticEntry(pre, key);
    const b = semanticEntry(post, key);
    if (same(a, b)) continue;
    let change;
    if (a === null) change = 'created';
    else if (b === null) change = 'deleted';
    else if (a.t !== b.t) change = 'type';
    else if (a.t === 'l' && a.target !== b.target) change = 'target';
    else if (a.t === 'f' && (a.sha256 !== b.sha256 || a.staged !== b.staged || a.unreadable !== b.unreadable)) change = 'modified';
    else if (a.mode !== b.mode) change = 'mode';
    else change = 'modified';
    out.entries.push({ key, change, pre: pre.entries[key] ?? null, post: post.entries[key] ?? null });
  }
  const gits = new Set([...Object.keys(pre.git ?? {}), ...Object.keys(post.git ?? {})]);
  for (const g of [...gits].sort()) {
    const a = pre.git?.[g]?.refs ?? {};
    const b = post.git?.[g]?.refs ?? {};
    for (const ref of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if ((a[ref] ?? null) !== (b[ref] ?? null)) out.refs.push({ git: g, ref, pre: a[ref] ?? null, post: b[ref] ?? null });
    }
    const sa = pre.git?.[g]?.stash_log ?? null;
    const sb = post.git?.[g]?.stash_log ?? null;
    if ((sa?.sha256 ?? null) !== (sb?.sha256 ?? null)) out.reflogs.push({ git: g, ref: 'refs/stash', pre: sa, post: sb });
  }
  return out;
}

/** Write a snapshot durably (its JSON, fsynced, then renamed into place); returns its file's SHA-256. */
export function saveSnapshot(snapshot, file) {
  mkdirSync(dirname(file), { recursive: true });
  const text = `${JSON.stringify(snapshot)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return sha256Hex(text);
}

export function loadSnapshot(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  if (s?.schema !== SNAPSHOT_SCHEMA) throw new Error(`${file} is not a workspace snapshot`);
  return s;
}
