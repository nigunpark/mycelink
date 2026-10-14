/**
 * A with-arm controller session as a transaction over the workspace
 * (CSET-203 r9: a PreToolUse fence cannot know what a script writes, and the
 * harness must never leave a controller's direct change in the workspace,
 * nor ask the controller to clean it up).
 *
 * beginTransaction snapshots the workspace (lib/snapshot.mjs) before a
 * session and notes where Mycelink's provenance ledger stands (the plugin's
 * MYCELINK_PROVENANCE: what its core processes changed, before and after
 * each change). settleTransaction snapshots it again after the session and
 * attributes every change:
 *
 *   authoring    the controller's own documents in a control repository —
 *                a feature's directory, PRD, plan, graph and E2E scenarios,
 *                contracts and handoffs — and its control-repository Git
 *                state (commits, index, refs)
 *   core         what Mycelink's core left exactly as its ledger records it
 *                (a file's bytes, mode, target or absence; a ref, an index or
 *                a Git metadata file a core git command changed), or was
 *                changing when its process ended (an intent with no done)
 *   worker       a module-worker's worktree, its admin files and its branch
 *                (`.mycelink/worktrees/<name>`), unless the controller reached
 *                into it (`reached`: then it is contaminated, for the caller
 *                to discard through Mycelink)
 *   integration  Mycelink's own Git worktrees under `.mycelink/` (merges,
 *                builds), unless the controller reached into them
 *   housekeeping a Git lock file
 *   harness      what the harness itself changed while the session ran (a
 *                fault plan's teammate commit: noteHarnessChange), left as
 *                the harness left it — the environment's change, kept by
 *                every rollback, a whole-session one too
 *
 * and everything else is the controller's direct change — a violation:
 * `mycelink-state` (a Mycelink-managed file the core did not leave as it
 * is), `control-input` (the approved requirement, the registry, the
 * configuration, hook settings), `product` (a product repository's files),
 * `git` / `git-ref` (its Git state), `scratch` (a helper script or any other
 * file of the workspace; inert: nothing reads it) — rolled back to its state
 * before the session, or to the state the core last attested for it in the
 * session, leaving every authorised change as it is (lib/rollback.mjs).
 *
 * A repository's stash (`refs/stash` and its reflog, shared by every
 * worktree) is followed through the session's calls (lib/shared-git.mjs): a
 * module-worker's own entries, made in its own call, are `worker-git`,
 * authorised and on record (CSET-203 r12). Who ran each call is read from
 * the session's own stream (`stream`: the harness's capture of its stdout,
 * lib/causal.mjs), never from overlap alone: a host call that only waits,
 * prints or reads is no hand in the stash (CSET-202 final). An entry a
 * rollback takes out of the stash is archived under
 * `refs/mycelink/archive/`, never lost.
 *
 * When a core process read a non-inert violation after it changed (its
 * ledger records what each process read before a change: a write made after
 * a violation is not thereby made from it), the rollback is full: a
 * reconstruction of the workspace as it stood just before that process
 * (reconstruction), what Mycelink and its module-workers did before it and a
 * standing worker's worktree and entries kept. When even that cannot be told
 * apart — the ledger was cut or rewritten, an index both changed, the
 * controller ran a worker's gate — the whole session is rolled back to its
 * start instead.
 * Either way the rollback is verified against the expected state, journaled
 * and resumable (resumeTransaction), and recorded by its manifest's digest
 * and the paths it restored or removed — never by what the controller wrote.
 */
import * as fsSync from 'node:fs';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { safeGit } from './git.mjs';
import { readRegular } from './fsread.mjs';
import { RollbackConflict, applyRollback, planRollback, verifyRollback } from './rollback.mjs';
import { streamTree } from './causal.mjs';
import { attributeStash, callIndex, callsMark, causalContext, linesOf, sessionCalls, stashTarget } from './shared-git.mjs';
import { RACY_MS, captureSnapshot, diffSnapshots, indexSemantics, insideExcluded, isIndexFile, isRefFile, keyBytes, loadSnapshot, objectPath, putObject, readObject, relKey, saveSnapshot, semanticEntry, showKey, snapshotDigest, workspaceKey } from './snapshot.mjs';

export const TXN_SCHEMA = 'mycelink-bench/controller-txn@1';

/** The environment variable that turns on Mycelink's provenance ledger (src/state/provenance.ts) and names its directory. */
export const PROVENANCE_ENV = 'MYCELINK_PROVENANCE';

/** Lines of a violation's summary at most (the rest are counted). */
export const SUMMARY_LINES = 12;

const CATEGORY_TEXT = {
  'mycelink-state': 'a Mycelink-managed file',
  'control-input': "a control repository's approved input or configuration",
  product: "a product repository's file",
  git: "a product repository's Git state",
  'git-ref': "a product repository's ref",
  worktree: "a module-worker's worktree",
  integration: "one of Mycelink's own worktrees",
  scratch: 'a helper or scratch file in the workspace',
  derived: 'an ignored build output in a product repository',
  gate: "a module-worker's gate, run by the controller itself",
  ledger: "Mycelink's provenance ledger, written by the controller itself",
};

/** Files a feature's directory holds that only Mycelink's core writes. */
const MANAGED = new Set(['STATE.json', 'events.jsonl', 'RUNS.jsonl', 'leases.json', 'ACCEPTANCE.json', 'LOOPS.json', 'LOOPS.yaml', 'DECISIONS.md', 'CHANGES.md', 'evidence', 'sessions', 'candidates', 'deliveries', 'resources', 'reviews', 'checkpoints', 'context-packs', 'metrics', 'integration']);
/** A feature's documents the controller writes itself. */
const AUTHORED = new Set(['PRD.md', 'PLAN.md', 'PORTFOLIO-GRAPH.yaml', 'e2e']);
/** A control repository's inputs: what the controller never changes. */
const INPUTS = new Set(['requirements', 'repositories.yaml', 'mycelink.config.json', '.claude', 'CLAUDE.md', '.gitignore', 'README.md']);

// ---- paths -----------------------------------------------------------------------

/** A key (workspace-relative, '/'-separated) for an absolute path inside the workspace, however it is spelled; null outside it. */
const keyOf = workspaceKey;
const under = (key, root) => root === '' || key === root || key.startsWith(`${root}/`);
const parts = (key) => keyBytes(key).toString('utf8').split('/');

// ---- the ledger ---------------------------------------------------------------------

function ledgerFile(ledgerDir) {
  return join(ledgerDir, 'ledger.jsonl');
}

/** Where the ledger stands: its size and the digest of what it holds. */
function ledgerMark(ledgerDir) {
  let bytes = Buffer.alloc(0);
  try {
    bytes = readFileSync(ledgerFile(ledgerDir));
  } catch {
    // none yet
  }
  return { offset: bytes.length, prefix_sha256: sha256Hex(bytes) };
}

/**
 * The records the session appended to the ledger, trusted only while what
 * the ledger held before the session is still exactly there (`intact`). A
 * last line cut short (a process killed mid-write) is noted, not trusted.
 */
export function sessionLedger({ ledgerDir, mark }) {
  let bytes = Buffer.alloc(0);
  try {
    bytes = readFileSync(ledgerFile(ledgerDir));
  } catch {
    bytes = Buffer.alloc(0);
  }
  const intact = bytes.length >= mark.offset && sha256Hex(bytes.subarray(0, mark.offset)) === mark.prefix_sha256;
  const records = [];
  const problems = [];
  if (!intact) problems.push('the ledger no longer holds what it held before the session');
  else {
    const lines = bytes.subarray(mark.offset).toString('utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      if (line === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        problems.push(i === lines.length - 1 ? 'a last line cut short' : `line ${i + 1} of the session's records is not a record`);
      }
    }
  }
  return { intact, records, problems };
}

/**
 * What the session's ledger attests, by path: last states, open intents,
 * recursive removals, git changes, when the core wrote, and when it last
 * touched each path and Git directory; and what each core process read
 * before a change (CSET-203 r12: what a change may rest on) — the paths and
 * their last read, the git commands that changed nothing and those that did,
 * each process's first and last record.
 */
function ledgerIndex(records, workspace) {
  const files = new Map();
  const touched = new Map();
  const touch = (key, at) => {
    if (key !== null && (touched.get(key) ?? -1n) < at) touched.set(key, at);
  };
  const open = new Map();
  const recursive = [];
  const git = [];
  const gitOpen = new Map();
  const writes = [];
  /** Where the core ran a git command that can change a work tree (a merge in a checkout, say). */
  const worktreeOps = [];
  /** What each process read before its next change: `{ pid, t, paths: Map(key -> last read), git: [...], truncated }`. */
  const reads = [];
  /** Every git command that could change something: `{ pid, t, git (its common directory's key), cwd, all_refs, stash }`. */
  const gitOps = [];
  /** Each process: `{ first, last, group, sub }` (ns). */
  const procs = new Map();
  const t = (r) => BigInt(r.t ?? '0');
  for (const r of records) {
    if (Number.isInteger(r.pid)) {
      const p = procs.get(r.pid) ?? { first: t(r), last: t(r), group: null, sub: null };
      if (t(r) < p.first) p.first = t(r);
      if (t(r) > p.last) p.last = t(r);
      if (r.kind === 'proc') Object.assign(p, { group: r.group ?? null, sub: r.sub ?? null });
      procs.set(r.pid, p);
    }
    if (r.kind === 'reads') {
      const paths = new Map();
      for (const [p, at] of Array.isArray(r.paths) ? r.paths : []) {
        const key = typeof p === 'string' ? keyOf(workspace, resolve(p)) : null;
        if (key !== null) paths.set(key, BigInt(at ?? r.t ?? '0'));
      }
      const gitReads = (Array.isArray(r.git) ? r.git : []).map((g) => ({ cwd: typeof g.cwd === 'string' ? keyOf(workspace, resolve(g.cwd)) : null, t: BigInt(g.t ?? r.t ?? '0'), all_refs: g.all_refs !== false, stash: g.stash === true, sub: g.sub ?? null }));
      reads.push({ pid: r.pid, t: t(r), paths, git: gitReads, truncated: r.truncated === true });
      continue;
    }
    if (r.kind === 'git-intent') gitOps.push({ pid: r.pid, t: t(r), git: r.common_dir ? keyOf(workspace, resolve(r.common_dir)) : null, cwd: r.cwd ? keyOf(workspace, resolve(r.cwd)) : null, all_refs: r.all_refs !== false, stash: r.stash === true || r.all_refs === undefined, sub: r.sub ?? null });
    if (r.kind === 'intent') {
      for (const p of r.paths ?? []) {
        open.set(`${r.pid}:${r.seq}:${p}`, p);
        touch(keyOf(workspace, p), t(r));
      }
    } else if (r.kind === 'done') {
      for (const s of r.states ?? []) touch(keyOf(workspace, s.path), t(r));
      for (const s of r.states ?? []) {
        open.delete(`${r.pid}:${r.seq}:${s.path}`);
        const key = keyOf(workspace, s.path);
        if (key === null) continue;
        if (!files.has(key)) files.set(key, []);
        files.get(key).push({ t: t(r), state: s.state });
        if (s.state?.t === 'absent' && s.state.recursive) recursive.push({ key, t: t(r) });
      }
      // A write inside the workspace (a lock aside): what may have read a violation before it.
      if ((r.states ?? []).some((s) => !/\.lock$/.test(s.path) && keyOf(workspace, s.path) !== null)) writes.push(t(r));
    } else if (r.kind === 'git-intent') {
      gitOpen.set(`${r.pid}:${r.seq}`, r.common_dir);
      if (r.common_dir) touch(keyOf(workspace, r.common_dir), t(r));
      if (r.cwd) worktreeOps.push(keyOf(workspace, r.cwd));
    } else if (r.kind === 'git-done') {
      gitOpen.delete(`${r.pid}:${r.seq}`);
      const common = r.common_dir ? keyOf(workspace, r.common_dir) : null;
      touch(common, t(r));
      git.push({ t: t(r), common, changed: r.changed ?? { refs: {}, files: {}, indexes: {} } });
      const c = r.changed ?? {};
      if (Object.keys(c.refs ?? {}).length || Object.keys(c.files ?? {}).length || Object.keys(c.indexes ?? {}).length) writes.push(t(r));
    }
  }
  const pending = new Set([...open.values()].map((p) => keyOf(workspace, p)).filter((k) => k !== null));
  const gitPending = new Set([...gitOpen.values()].filter(Boolean).map((p) => keyOf(workspace, p)).filter((k) => k !== null));
  return { files, pending, recursive, git, gitPending, writes, touched, worktreeOps: worktreeOps.filter((k) => k !== null), reads, gitOps, procs };
}

/** Paths of a product checkout that differ from its HEAD and index, as Git sees them (nothing run but status, hardened). */
function dirtyKeys(workspace, repoKey) {
  const repo = join(workspace, keyBytes(repoKey).toString('utf8'));
  const r = safeGit(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no', '--no-renames'], { encoding: 'buffer' });
  if (r.code !== 0) return null;
  const out = new Set();
  for (const item of r.stdout.toString('utf8').split('\0')) if (item.length > 3) out.add(`${repoKey}/${item.slice(3)}`);
  return out;
}

// ---- zones -----------------------------------------------------------------------

/** The control repositories, product repositories and worktrees of the workspace, before and after. */
function zonesOf({ workspace, pre, post, store, controls = [], repos = [], worktrees = [], ledger = null }) {
  const all = { ...pre.entries, ...post.entries };
  const controlKeys = new Set(controls.map((c) => keyOf(workspace, c)).filter((k) => k !== null));
  // A control repository: its configuration, or (before `init`) a registry beside its own Git directory.
  for (const key of Object.keys(all)) {
    const m = /^(?:(.*)\/)?(mycelink\.config\.json|repositories\.yaml)$/.exec(key);
    if (!m || all[key].t !== 'f' || parts(key).length > 4) continue;
    const dir = m[1] ?? '';
    if (m[2] === 'mycelink.config.json' || all[dir === '' ? '.git' : `${dir}/.git`]?.t === 'd') controlKeys.add(dir);
  }
  const repoKeys = new Set(repos.map((r) => keyOf(workspace, r)).filter((k) => k !== null));
  for (const c of controlKeys) {
    for (const snap of [pre, post]) {
      const e = snap.entries[c === '' ? 'repositories.yaml' : `${c}/repositories.yaml`];
      const bytes = e?.t === 'f' && e.sha256 ? readObject(store, e.sha256) : null;
      if (bytes === null) continue;
      try {
        const doc = YAML.parse(bytes.toString('utf8'));
        for (const r of Array.isArray(doc?.repositories) ? doc.repositories : []) {
          if (typeof r?.path !== 'string') continue;
          const k = keyOf(workspace, resolve(workspace, ...(c === '' ? [] : [c]), r.path));
          if (k !== null && k !== '') repoKeys.add(k);
        }
      } catch {
        // an unreadable registry names nothing
      }
    }
  }
  const worker = new Set(worktrees.map((w) => keyOf(workspace, w)).filter((k) => k !== null));
  const own = new Set();
  for (const c of controlKeys) {
    const prefix = c === '' ? '.mycelink/' : `${c}/.mycelink/`;
    for (const key of Object.keys(all)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length).split('/');
      if (rest[0] === 'worktrees' && rest.length >= 2 && all[`${prefix}worktrees/${rest[1]}`]?.t === 'd') worker.add(`${prefix}worktrees/${rest[1]}`);
      else if (rest[rest.length - 1] === '.git' && all[key].t === 'f') own.add(key.slice(0, -'/.git'.length));
    }
  }
  // Each Git worktree's admin directory, by the worktree its gitdir file names.
  const admin = new Map();
  for (const [key, e] of Object.entries(all)) {
    const m = /^(.*\/\.git\/worktrees\/[^/]+)\/gitdir$/.exec(key);
    if (!m || e.t !== 'f' || !e.sha256) continue;
    const bytes = readObject(store, e.sha256);
    if (bytes === null) continue;
    const wt = keyOf(workspace, dirname(resolve(bytes.toString('utf8').trim())));
    if (wt !== null) admin.set(m[1], wt);
  }
  // The branches a worktree has checked out (before or after), by its admin HEAD.
  const branches = new Map();
  const checkedOut = (adminKey, wt, headBytes) => {
    const m = headBytes === null ? null : /^ref: (\S+)/.exec(headBytes.toString('utf8'));
    if (!m || wt === null) return;
    const gitKey = adminKey.replace(/\/worktrees\/[^/]+$/, '');
    if (!branches.has(gitKey)) branches.set(gitKey, new Map());
    branches.get(gitKey).set(m[1], wt);
  };
  for (const [adminKey, wt] of admin) {
    for (const snap of [pre, post]) {
      const e = snap.entries[`${adminKey}/HEAD`];
      checkedOut(adminKey, wt, e?.t === 'f' && e.sha256 ? readObject(store, e.sha256) : null);
    }
  }
  // And a worktree the core made and removed within the session (a claim's, settled): its admin files as the ledger kept them.
  if (ledger !== null) {
    const kept = (state) => (state?.t === 'f' && state.kept && state.sha256 ? readKept(ledger.dir, state.sha256) : null);
    const admins = new Map();
    for (const g of ledger.index.git) {
      for (const [abs, pair] of Object.entries(g.changed.files ?? {})) {
        const key = keyOf(workspace, abs);
        const m = key === null ? null : /^(.*\/\.git\/worktrees\/[^/]+)\/(HEAD|gitdir)$/.exec(key);
        if (!m) continue;
        if (!admins.has(m[1])) admins.set(m[1], { heads: [], gitdir: null });
        const a = admins.get(m[1]);
        for (const state of pair) {
          const bytes = kept(state);
          if (bytes === null) continue;
          if (m[2] === 'HEAD') a.heads.push(bytes);
          else a.gitdir = keyOf(workspace, dirname(resolve(bytes.toString('utf8').trim())));
        }
      }
    }
    for (const [adminKey, a] of admins) {
      const wt = a.gitdir ?? admin.get(adminKey) ?? null;
      if (wt === null) continue;
      if (!admin.has(adminKey)) admin.set(adminKey, wt);
      // Where the core made it: a worker's worktree, or one of Mycelink's own.
      for (const c of controlKeys) {
        const prefix = c === '' ? '.mycelink/' : `${c}/.mycelink/`;
        if (!wt.startsWith(prefix)) continue;
        if (wt.slice(prefix.length).startsWith('worktrees/')) worker.add(wt);
        else own.add(wt);
      }
      for (const head of a.heads) checkedOut(adminKey, wt, head);
    }
  }
  return { controls: [...controlKeys], repos: [...repoKeys], worker: [...worker], own: [...own], admin, branches };
}

/** The session's stream-json text from the file the transaction names; null when there is none to read. */
function readStream(file) {
  if (typeof file !== 'string' || file === '') return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Bytes the ledger kept, checked against their digest; null when missing or corrupt. */
function readKept(ledgerDir, sha) {
  try {
    const bytes = readFileSync(join(ledgerDir, 'objects', sha.slice(0, 2), sha));
    return sha256Hex(bytes) === sha ? bytes : null;
  } catch {
    return null;
  }
}

// ---- attribution ------------------------------------------------------------------

/** Is a ledger state the post-session entry? */
function sameAs(state, entry) {
  if (!state) return false;
  if (state.t === 'absent') return entry === null || entry === undefined;
  if (!entry) return false;
  if (state.t !== entry.t) return false;
  if (state.t === 'f') return state.sha256 === entry.sha256 && state.mode === entry.mode;
  if (state.t === 'd') return state.mode === entry.mode;
  if (state.t === 'l') return relKey(Buffer.from(state.target, 'utf8')) === entry.target;
  return true;
}

/**
 * When a deletion may have happened at the earliest (ns, as a string): a
 * deletion leaves no time, but the checks while the session ran walked the
 * workspace — it happened after the last check that did not see it gone.
 * The session's start ('0') when no check saw the workspace without it.
 */
function deletedSince(checks = [], key) {
  let since = '0';
  for (const c of checks) {
    if (c.keys.includes(key)) return since;
    since = (BigInt(c.started_ms) * 1_000_000n).toString();
  }
  return since;
}

/** When an entry last changed (its ctime; for one gone, its nearest surviving ancestor's). */
function changedAt(post, key) {
  for (let k = key; ; ) {
    const e = post.entries[k];
    if (e) return BigInt(e.ctime_ns);
    const i = k.lastIndexOf('/');
    if (i < 0) return 0n;
    k = k.slice(0, i);
  }
}

/** Keys of a product repository's work tree that Git ignores (its own ignore rules; nothing run). */
function ignoredKeys(workspace, repoKey, keys) {
  if (keys.length === 0) return new Set();
  const repo = join(workspace, keyBytes(repoKey).toString('utf8'));
  const rels = keys.map((k) => keyBytes(k).toString('utf8').slice(keyBytes(repoKey).toString('utf8').length + 1));
  const r = safeGit(repo, ['check-ignore', '--no-index', '-z', '--stdin'], { input: rels.join('\0') + '\0' });
  const out = new Set();
  if (r.code !== 0 && r.code !== 1) return out;
  for (const rel of String(r.stdout).split('\0').filter(Boolean)) out.add(`${repoKey}/${rel}`);
  return out;
}

/**
 * Attribute every change of a session: `{ deltas, authorized,
 * unauthorized, housekeeping, contaminated, ambiguous, ledger }`. Each delta
 * is `{ path (shown), key, kind ('entry' | 'ref'), change, verdict, by,
 * category, inert, at, target }`; `target` is the state it goes back to
 * (`{ entry }` or `{ ref }`). `reached`: absolute paths the controller's own
 * tool calls wrote (lib/transcripts.mjs) — a worktree holding one is
 * contaminated. `controls`, `repos`, `worktrees`: absolute roots the caller
 * knows beyond those the workspace names. `asOf` (ns; a check while the
 * session runs): the ledger is read after `post` was taken, so a path or Git
 * directory the core touched from then on is no evidence either way —
 * authorised as `core-concurrent`, for the settlement to decide. `stream`:
 * the session's stream-json text as far as it goes (default: the file the
 * transaction names, `txn.stream`) — whose call each one is (lib/causal.mjs).
 * `stashReached`: the paths whose writing by the controller's own calls
 * makes a repository's stash its own (default `reached`).
 */
export function classifyTransaction({ txn, post, reached = [], controls = [], repos = [], worktrees = [], asOf = null, stream = null, stashReached = reached }) {
  const { workspace, store } = txn;
  const pre = txn.pre;
  const diff = diffSnapshots(pre, post);
  const led = sessionLedger({ ledgerDir: txn.ledgerDir, mark: txn.ledger });
  const L = ledgerIndex(led.records, workspace);
  // Every Bash call of the session, the hooks' record (lib/shared-git.mjs): whose call a shared Git change happened in.
  const callsLed = sessionCalls({ ledgerDir: txn.ledgerDir, mark: txn.calls });
  const CI = callIndex(callsLed.intact ? callsLed.records : [], workspace);
  // Where each call ran in the session's causal tree, read from the session's own stream (CSET-202 final); none without one.
  const streamText = stream ?? readStream(txn.stream);
  const causal = causalContext({ tree: streamText === null ? null : streamTree(streamText), index: CI, home: txn.home ?? null, mycelink: txn.plugin ? [join(txn.plugin, 'bin', 'mycelink.mjs')] : [] });
  const z = zonesOf({ workspace, pre, post, store, controls: [...controls, ...(txn.controls ?? [])], repos: [...repos, ...(txn.repos ?? [])], worktrees: [...worktrees, ...(txn.worktrees ?? [])], ledger: { dir: txn.ledgerDir, index: L } });
  const reachedKeys = reached.map((p) => keyOf(workspace, resolve(p))).filter((k) => k !== null);
  const contaminatedRoots = new Set([...z.worker, ...z.own].filter((w) => reachedKeys.some((k) => under(k, w))));
  const controlOf = (key) => z.controls.filter((c) => under(key, c)).sort((a, b) => b.length - a.length)[0] ?? null;
  const repoOf = (key) => z.repos.filter((r) => under(key, r)).sort((a, b) => b.length - a.length)[0] ?? null;
  const workerOf = (key) => z.worker.find((w) => under(key, w)) ?? null;
  const ownOf = (key) => z.own.find((w) => under(key, w)) ?? null;
  const adminOf = (key) => [...z.admin.keys()].find((a) => under(key, a)) ?? null;
  const out = [];
  const deltas = [];
  const coreState = (key) => L.files.get(key)?.at(-1)?.state ?? null;
  const notes = txn.harness ?? [];
  /** The harness's last note of a path: `{ at, state }`, or null. */
  const harnessOf = (key) => {
    let last = null;
    for (const n of notes) if (key in n.entries) last = { at: BigInt(n.at), state: n.entries[key] };
    return last;
  };
  /** The harness's last note of a ref: `{ at, value }`, or null. */
  const harnessRef = (git, ref) => {
    let last = null;
    for (const n of notes) for (const r of n.refs) if (r.git === git && r.ref === ref) last = { at: BigInt(n.at), value: r.value };
    return last;
  };
  const harnessEntry = (state) => (state.t === 'absent' ? null : { t: state.t, mode: state.mode, ...(state.t === 'f' ? { sha256: state.sha256 } : {}), ...(state.t === 'l' ? { target: relKey(Buffer.from(state.target, 'utf8')) } : {}) });
  const concurrent = (key) => asOf !== null && (L.touched.get(key) ?? -1n) >= asOf;
  // By workspace key, never by path text: the ledger names the real place (macOS /private/var, Windows' long form of an
  // 8.3 name), the harness the workspace as it was handed over.
  const sameKey = (abs, key) => key !== null && keyOf(workspace, resolve(abs)) === key;
  const coreGitFile = (abs) => {
    const key = keyOf(workspace, abs);
    let last = null;
    for (const g of L.git) for (const [p, pair] of Object.entries(g.changed.files ?? {})) if (sameKey(p, key)) last = pair[1];
    return last;
  };
  const coreIndex = (abs) => {
    const key = keyOf(workspace, abs);
    let last;
    for (const g of L.git) for (const [p, pair] of Object.entries(g.changed.indexes ?? {})) if (sameKey(p, key)) last = pair[1];
    return last;
  };
  const absOf = (key) => resolve(workspace, keyBytes(key).toString('utf8'));
  const attested = (key, entry) => {
    const abs = absOf(key);
    const s = coreState(key);
    if (s && sameAs(s, entry)) return 'core';
    if (!entry && L.recursive.some((r) => under(key, r.key))) return 'core';
    if (L.pending.has(key)) return 'core-interrupted';
    if (concurrent(key)) return 'core-concurrent';
    const gf = coreGitFile(abs);
    if (gf && sameAs(gf, entry)) return 'core';
    if (entry?.t === 'f' && /\/index$/.test(key)) {
      const staged = coreIndex(abs);
      if (staged !== undefined && staged === (post.indexes?.[key] ?? null)) return 'core';
    }
    // What the harness itself changed (a teammate commit's files and the index it synced), as it left it.
    const h = harnessOf(key);
    if (h && (sameAs(h.state, entry) || (entry?.t === 'f' && h.state.staged && h.state.staged === (post.indexes?.[key] ?? null)))) return 'harness';
    return null;
  };

  const reviewerVerdict = (key, entry) => {
    if (entry?.t !== 'f' || !entry.sha256 || !/\/\.mycelink\/reviews\/[^/]+\/[^/]+\/[0-9a-f-]{36}\/verdict\.json$/.test(`/${key}`)) return false;
    const attestKey = `${key.slice(0, -'verdict.json'.length)}verdict.attest.json`;
    const attest = post.entries[attestKey];
    if (attest?.t !== 'f' || !attest.sha256) return false;
    // The attestation is the core's (the hook's) as it left it, or it was there before the session.
    const attestedByCore = sameAs(coreState(attestKey), attest) || same(pre.entries[attestKey]?.sha256 ?? null, attest.sha256);
    if (!attestedByCore) return false;
    const a = readObject(store, attest.sha256);
    const v = readObject(store, entry.sha256);
    if (a === null || v === null) return false;
    let canonical;
    try {
      canonical = sha256Hex(canonicalJson(JSON.parse(v.toString('utf8'))));
    } catch {
      canonical = sha256Hex(v);
    }
    try {
      return JSON.parse(a.toString('utf8')).content_sha256 === canonical;
    } catch {
      return false;
    }
  };

  // Ignored build output in a product repository: restored, never a violation.
  const productKeys = new Map();
  for (const e of diff.entries) {
    const r = repoOf(e.key);
    if (r === null || under(e.key, `${r}/.git`)) continue;
    if (!productKeys.has(r)) productKeys.set(r, []);
    productKeys.get(r).push(e.key);
  }
  const ignored = new Set();
  for (const [r, keys] of productKeys) for (const k of ignoredKeys(workspace, r, keys)) ignored.add(k);
  // A product checkout the core moved (a delivery's fast-forward): what now matches its HEAD is the checkout's.
  const checkedOut = new Map();
  for (const r of productKeys.keys()) {
    if (L.worktreeOps.some((k) => under(k, r) && !under(k, `${r}/.git`))) checkedOut.set(r, dirtyKeys(workspace, r));
  }
  const gitDirOf = (key) => /^(.*?\.git)(?:\/|$)/.exec(key)?.[1] ?? null;

  // What the core made in the session and someone then changed back or away (a file it created that the controller
  // deleted is absent before and after): where the core's last attested state is not what the session left.
  const entryDeltas = [...diff.entries];
  const listed = new Set(diff.entries.map((e) => e.key));
  for (const [key, records] of L.files) {
    if (listed.has(key) || key === '' || L.pending.has(key) || concurrent(key) || isRefFile(key) || insideExcluded(key) || /\/index$/.test(key)) continue;
    if (workerOf(key) !== null || ownOf(key) !== null || adminOf(key) !== null) continue;
    const last = records.at(-1).state;
    const now = post.entries[key] ?? null;
    if (sameAs(last, now)) continue;
    if (harnessOf(key) !== null && sameAs(harnessOf(key).state, now)) continue;
    if (last.t === 'absent' && !now && L.recursive.some((r) => under(key, r.key))) continue;
    entryDeltas.push({ key, change: now === null ? 'deleted' : last.t === 'absent' ? 'created' : last.t !== now.t ? 'type' : 'modified', diverged: true });
  }

  for (const e of entryDeltas) {
    const key = e.key;
    const post_ = post.entries[key] ?? null;
    // When it changed: its ctime; a deletion's moment is unknown, so it counts as the session's start.
    const d = { path: showKey(key), key, kind: 'entry', change: e.change, verdict: 'unauthorized', by: 'controller', category: 'scratch', inert: false, at: e.change === 'deleted' ? deletedSince(txn.checks, key) : changedAt(post, key).toString() };
    const control = controlOf(key);
    const rel = control === null ? null : control === '' ? key : key.slice(control.length + 1);
    const p = rel === null ? [] : rel.split('/');
    const worker = workerOf(key);
    const own = ownOf(key);
    const adm = adminOf(key);
    const repo = repoOf(key);
    // A lock, or what git derives for itself: `info/refs`, update-server-info's list of the refs, which a repack or an
    // automatic gc in any git command rewrites (CI 38489750013: a task session stopped for it). Neither is a ref,
    // an object or a file anything is built from.
    const gitLock = /(?:^|\/)\.git\/(?:.*\/)?[^/]*\.lock$/.test(key) || /(?:^|\/)\.git\/info\/refs$/.test(key);
    const by = attested(key, post_);
    const dirty = repo !== null ? checkedOut.get(repo) : undefined;
    const h = harnessOf(key);
    if (h) Object.assign(d, { harness_entry: harnessEntry(h.state), harness_at: h.at.toString() });
    if (gitLock) Object.assign(d, { verdict: 'housekeeping', by: 'git', category: 'git', inert: true });
    // Claude Code's own project files beside the workspace's repositories (never a control repository's hook settings).
    else if (control !== '' && (key === '.claude' || key.startsWith('.claude/'))) Object.assign(d, { verdict: 'housekeeping', by: 'host', category: 'host', inert: true });
    else if (control !== null && (p[0] === '.git' || rel === '.git')) Object.assign(d, { verdict: 'authorized', by: 'control-git' });
    else if (control !== null && ((p[0] === 'features' && (p.length <= 2 || AUTHORED.has(p[2]))) || p[0] === 'contracts' || p[0] === 'handoffs')) Object.assign(d, { verdict: 'authorized', by: 'authoring' });
    else if (by !== null) Object.assign(d, { verdict: 'authorized', by });
    // An acceptance reviewer's verdict: its own Write, attested beside it by the plugin's hook (core) with its canonical hash.
    else if (reviewerVerdict(key, post_)) Object.assign(d, { verdict: 'authorized', by: 'reviewer' });
    else if (gitDirOf(key) !== null && L.gitPending.has(gitDirOf(key))) Object.assign(d, { verdict: 'authorized', by: 'core-interrupted' });
    else if (repo !== null && dirty instanceof Set && !under(key, `${repo}/.git`) && !dirty.has(key) && !ignored.has(key)) Object.assign(d, { verdict: 'authorized', by: 'core-checkout' });
    else if (worker !== null || (adm !== null && z.worker.includes(z.admin.get(adm)))) {
      const root = worker ?? z.admin.get(adm);
      if (contaminatedRoots.has(root)) Object.assign(d, { category: 'worktree', worktree: root });
      else Object.assign(d, { verdict: 'authorized', by: 'worker' });
    } else if (own !== null || (adm !== null && z.own.includes(z.admin.get(adm)))) {
      const root = own ?? z.admin.get(adm);
      if (contaminatedRoots.has(root)) Object.assign(d, { category: 'integration', worktree: root });
      else Object.assign(d, { verdict: 'authorized', by: 'integration' });
    } else if (control !== null) {
      if (p[0] === '.mycelink' || (p[0] === 'features' && p.length >= 3 && MANAGED.has(p[2]))) d.category = 'mycelink-state';
      else if (INPUTS.has(p[0])) d.category = 'control-input';
      else Object.assign(d, { category: 'scratch', inert: true });
    } else {
      if (repo !== null && under(key, `${repo}/.git`)) d.category = 'git';
      else if (repo !== null && ignored.has(key)) Object.assign(d, { verdict: 'housekeeping', category: 'derived', inert: true });
      else if (repo !== null) d.category = 'product';
      else Object.assign(d, { category: 'scratch', inert: true });
    }
    deltas.push(d);
  }

  // A ref the core set in the session that is not where it left it, though it is where the session found it.
  // The stash (refs/stash and its reflog, every worktree's) is followed apart, through the session's calls, below.
  const refDeltas = diff.refs.filter((r) => r.ref !== 'refs/stash');
  const listedRefs = new Set(diff.refs.map((r) => `${r.git}:${r.ref}`));
  const lastRef = new Map();
  for (const g of L.git) for (const [ref, pair] of Object.entries(g.changed.refs ?? {})) if (g.common !== null) lastRef.set(`${g.common}:${ref}`, { git: g.common, ref, value: pair[1] });
  for (const [k, { git, ref, value }] of lastRef) {
    if (ref === 'refs/stash' || listedRefs.has(k) || L.gitPending.has(git) || concurrent(git)) continue;
    const now = post.git?.[git]?.refs?.[ref] ?? null;
    if ((value ?? null) === now) continue;
    if (harnessRef(git, ref) !== null && (harnessRef(git, ref).value ?? null) === now) continue;
    if (z.branches.get(git)?.has(ref)) continue;
    refDeltas.push({ git, ref, pre: pre.git?.[git]?.refs?.[ref] ?? null, post: now });
  }

  for (const r of refDeltas) {
    const key = `${r.git}:${r.ref}`;
    const d = { path: `${showKey(r.git)}:${r.ref}`, key, git: r.git, ref: r.ref, kind: 'ref', change: 'ref', pre: r.pre, post: r.post, verdict: 'unauthorized', by: 'controller', category: 'git-ref', inert: false, at: refChangedAt(post, r).toString() };
    const control = controlOf(r.git);
    const isControlGit = control !== null && r.git === (control === '' ? '.git' : `${control}/.git`);
    let core = false;
    let last;
    let lastAt = -1n;
    for (const g of L.git) {
      if (g.common === r.git && g.changed.refs && r.ref in g.changed.refs) {
        last = g.changed.refs[r.ref][1];
        lastAt = g.t;
      }
    }
    if (last !== undefined && (last ?? null) === (r.post ?? null)) core = true;
    const hr = harnessRef(r.git, r.ref);
    if (hr) Object.assign(d, { harness_ref: hr.value ?? null, harness_at: hr.at.toString() });
    const wt = z.branches.get(r.git)?.get(r.ref) ?? null;
    if (isControlGit) Object.assign(d, { verdict: 'authorized', by: 'control-git' });
    else if (core) Object.assign(d, { verdict: 'authorized', by: 'core' });
    else if (hr && (hr.value ?? null) === (r.post ?? null)) Object.assign(d, { verdict: 'authorized', by: 'harness' });
    else if (L.gitPending.has(r.git)) Object.assign(d, { verdict: 'authorized', by: 'core-interrupted' });
    else if (concurrent(r.git)) Object.assign(d, { verdict: 'authorized', by: 'core-concurrent' });
    else if (wt !== null && z.worker.includes(wt) && !contaminatedRoots.has(wt)) Object.assign(d, { verdict: 'authorized', by: 'worker' });
    else if (wt !== null && z.own.includes(wt) && !contaminatedRoots.has(wt)) Object.assign(d, { verdict: 'authorized', by: 'integration' });
    else if (wt !== null && contaminatedRoots.has(wt)) Object.assign(d, { category: 'worktree', worktree: wt });
    d.core_value = last;
    d.core_at = lastAt.toString();
    deltas.push(d);
  }

  // Each repository's stash (CSET-203 r12): every worktree's, followed through the session's calls and the core's records.
  const stashCaches = { commits: new Map() };
  const stashReachedKeys = stashReached.map((p) => keyOf(workspace, resolve(p))).filter((k) => k !== null);
  for (const g of [...new Set([...Object.keys(pre.git ?? {}), ...Object.keys(post.git ?? {})])].sort()) {
    const st = attributeStash({ workspace, store, git: g, pre, post, ledger: { dir: txn.ledgerDir, records: led.records }, index: CI, asOf, corroborate: asOf === null, caches: stashCaches, causal, reached: stashReachedKeys });
    if (st === null) continue;
    const control = controlOf(g);
    const d = { path: `${showKey(g)}:refs/stash`, key: `${g}:refs/stash`, git: g, ref: 'refs/stash', kind: 'stash', change: 'ref', pre: st.pre, post: st.post, pre_log: st.pre_log, post_log: st.post_log, verdict: 'unauthorized', by: 'controller', category: 'git-ref', inert: false, at: st.at, transitions: st.transitions, reasons: st.reasons, workers: st.workers, target: { ref: st.target.ref, log: st.target.log }, chain: st.chain, ...(st.unsettled ? { unsettled: st.unsettled } : {}) };
    if (control !== null && g === (control === '' ? '.git' : `${control}/.git`)) Object.assign(d, { verdict: 'authorized', by: 'control-git' });
    else if (st.verdict === 'authorized') Object.assign(d, { verdict: 'authorized', by: st.by === 'worker' ? 'worker-git' : 'core' });
    else if (st.verdict === 'concurrent') Object.assign(d, { verdict: 'authorized', by: 'core-concurrent' });
    // While the session runs: not attributed yet, and nothing that points at the controller's own hand — the settlement decides.
    else if (st.verdict === 'pending') Object.assign(d, { verdict: 'pending', by: 'pending' });
    else if (!callsLed.intact) d.reasons = [...d.reasons, 'the call ledger was cut or rewritten during the session: it attests no call'];
    deltas.push(d);
  }

  // A directory made or removed only as the container of authorised changes (git's `.git/worktrees`, say) is theirs.
  for (const d of deltas) {
    if (d.verdict !== 'unauthorized' || d.kind !== 'entry' || (d.change !== 'created' && d.change !== 'deleted')) continue;
    const was = d.change === 'created' ? post.entries[d.key] : pre.entries[d.key];
    if (was?.t !== 'd') continue;
    const inside = deltas.filter((x) => x.kind === 'entry' && x.key !== d.key && under(x.key, d.key));
    // A lock git left beside them (on Windows, when another handle holds it as git deletes it) is housekeeping: it
    // decides nothing about the container (CI 38496139927, a session's `.git/worktrees`).
    const held = inside.filter((x) => x.verdict !== 'housekeeping');
    if (held.length > 0 && held.every((x) => x.verdict === 'authorized')) Object.assign(d, { verdict: 'authorized', by: held[0].by, container: true });
    // ... and the container of a contaminated worktree's files goes with them, through Mycelink.
    else if (held.length > 0 && held.every((x) => x.verdict === 'authorized' || x.worktree)) {
      const w = held.find((x) => x.worktree);
      Object.assign(d, { category: w.category, worktree: w.worktree, container: true });
    }
    // ... and one in a `.git` holding git's housekeeping only, or left empty where the core ran git: git removes
    // `worktrees` with the last worktree, but on Windows that rmdir fails while another handle holds the directory, and
    // git leaves it (CI 38489750013).
    else if (gitDirOf(d.key) !== null && ((inside.length > 0 && held.length === 0) || (d.change === 'created' && inside.length === 0 && L.git.some((g) => g.common === gitDirOf(d.key)) && !Object.keys(post.entries).some((k) => under(k, d.key) && k !== d.key)))) {
      Object.assign(d, { verdict: 'housekeeping', by: 'git', category: 'git', inert: true, container: true });
    }
  }
  // Targets: the state the core last attested in the session, else the state before it.
  // What no reconstruction can tell apart (`whole`): the session goes back to how it began.
  const ambiguous = [];
  if (!led.intact) ambiguous.push('the provenance ledger was cut or rewritten during the session: it attests nothing');
  for (const d of deltas) {
    if (d.verdict === 'authorized' || d.kind === 'stash') continue;
    if (d.kind === 'ref') {
      d.target = { ref: d.harness_ref !== undefined && (d.core_value === undefined || BigInt(d.harness_at) > BigInt(d.core_at)) ? d.harness_ref : d.core_value !== undefined ? d.core_value : d.pre };
      continue;
    }
    const abs = absOf(d.key);
    const s = coreState(d.key) ?? coreGitFile(abs);
    if (d.harness_entry !== undefined && (!s || BigInt(d.harness_at) > (L.files.get(d.key)?.at(-1)?.t ?? -1n))) {
      d.target = { entry: d.harness_entry, from: 'harness' };
      continue;
    }
    if (s && s.t !== 'absent' && !(s.t === 'f' && s.kept)) {
      if (s.t === 'f') ambiguous.push(`no content to restore ${d.path} to as the core left it`);
    }
    if (!d.worktree && /\/index$/.test(d.key) && coreIndex(abs) !== undefined) ambiguous.push(`${d.path} was changed by the core and by someone else`);
    if (s && (s.t !== 'f' || s.kept)) d.target = { entry: s.t === 'absent' ? null : { t: s.t, mode: s.mode, ...(s.t === 'f' ? { sha256: s.sha256 } : {}), ...(s.t === 'l' ? { target: relKey(Buffer.from(s.target, 'utf8')) } : {}) }, from: 'core' };
    else d.target = { entry: pre.entries[d.key] ?? null, from: 'pre' };
  }
  const whole = [...new Set(ambiguous)];
  // A non-inert violation a core process read after it changed: what it then did may rest on it (CSET-203 r12 — a
  // change made after another is not thereby made from it; only a recorded read says so). A contaminated worktree goes
  // back through Mycelink (its dispatch discarded), not by the session.
  const gitOfCwd = (cwd) => {
    if (cwd === null) return null;
    const wt = [...z.worker, ...z.own].find((w) => under(cwd, w));
    if (wt !== undefined) for (const [adminKey, w] of z.admin) if (w === wt) return adminKey.replace(/\/worktrees\/[^/]+$/, '');
    const repo = repoOf(cwd);
    if (repo !== null) return `${repo}/.git`;
    const control = controlOf(cwd);
    return control === null ? null : control === '' ? '.git' : `${control}/.git`;
  };
  const dependencies = [];
  for (const d of deltas) {
    if (d.verdict !== 'unauthorized' || d.inert || d.worktree) continue;
    const dep = dependencyOf(d, L, gitOfCwd);
    if (dep === null) continue;
    const p = L.procs.get(dep.pid);
    dependencies.push({ key: d.key, path: d.path, pid: dep.pid, at: dep.t.toString(), process: p ? `${p.group ?? ''} ${p.sub ?? ''}`.trim() || 'mycelink' : 'mycelink' });
  }
  const unauthorized = deltas.filter((d) => d.verdict === 'unauthorized');
  const workerGit = deltas.filter((d) => d.kind === 'stash' && d.by === 'worker-git').map((d) => ({ path: d.path, workers: d.workers.map((w) => ({ node_id: w.node_id, claim_id: w.claim_id, dispatch_id: w.dispatch_id })), transitions: d.transitions.filter((t) => t.by === 'worker').map((t) => ({ added: t.added, removed: t.removed, node_id: t.worker.node_id, calls: t.calls })) }));
  const internal = { L, z, CI, gitOfCwd };
  return {
    deltas,
    authorized: deltas.filter((d) => d.verdict === 'authorized').map(({ path, key, kind, change, by }) => ({ path, key, kind, change, by })),
    unauthorized,
    housekeeping: deltas.filter((d) => d.verdict === 'housekeeping'),
    contaminated: [...contaminatedRoots].filter((w) => deltas.some((d) => d.worktree === w)).sort(),
    ambiguous: [...whole, ...dependencies.map((x) => `the core read ${x.path} after it changed (mycelink ${x.process}, pid ${x.pid}): what it did may rest on it`)],
    whole,
    dependencies,
    worker_git: workerGit,
    ledger: { intact: led.intact, records: led.records.length, problems: led.problems },
    calls: { intact: callsLed.intact, records: callsLed.records.length, problems: callsLed.problems },
    zones: { controls: z.controls, repos: z.repos, worker: z.worker, own: z.own },
    // Not kept on record (maps of the session's ledgers): what a reconstruction needs.
    get internal() {
      return internal;
    },
  };
}

/**
 * The first moment a core process may have read a violation after it
 * changed (`{ pid, t }`), or null: a recorded read of its path — or, for an
 * entry made, removed or retyped, of its directory's listing; for a ref, a
 * git command in its repository (for the stash, one that could read every
 * ref or names the stash). A process whose reads were too many to record
 * may have read anything.
 */
function dependencyOf(d, L, gitOfCwd) {
  const at = BigInt(d.at ?? '0');
  let best = null;
  const consider = (pid, t) => {
    if (t >= at && (best === null || t < best.t)) best = { pid, t };
  };
  for (const r of L.reads) if (r.truncated) consider(r.pid, r.t);
  if (d.kind === 'entry') {
    const structural = ['created', 'deleted', 'type'].includes(d.change);
    const parent = d.key.includes('/') ? d.key.slice(0, d.key.lastIndexOf('/')) : '';
    for (const r of L.reads) {
      const tk = r.paths.get(d.key);
      if (tk !== undefined) consider(r.pid, tk);
      if (structural) {
        const tp = r.paths.get(parent);
        if (tp !== undefined) consider(r.pid, tp);
      }
    }
  } else if (d.kind === 'ref' || d.kind === 'stash') {
    const stash = d.ref === 'refs/stash';
    for (const o of L.gitOps) if (o.git === d.git && (!stash || o.all_refs || o.stash)) consider(o.pid, o.t);
    for (const r of L.reads) for (const g of r.git) if (gitOfCwd(g.cwd) === d.git && (!stash || g.all_refs || g.stash)) consider(r.pid, g.t);
  }
  return best;
}

/** When a ref last changed: its loose file's ctime, else the packed refs'. */
function refChangedAt(post, r) {
  const loose = post.entries[`${r.git}/${r.ref}`];
  if (loose) return BigInt(loose.ctime_ns);
  const packed = post.entries[`${r.git}/packed-refs`];
  if (packed) return BigInt(packed.ctime_ns);
  return changedAt(post, `${r.git}/refs`);
}

// ---- the transaction ----------------------------------------------------------------

/**
 * Before a controller session: snapshot the workspace and mark the ledger.
 * `previous` (the last snapshot of the workspace) is the stat cache.
 * `stream`: the file the harness writes the session's stream-json output to
 * (whose call each one is, lib/causal.mjs); `plugin`: the sealed plugin's
 * directory (its CLI's changes are Mycelink's ledger's to record); `home`:
 * the session's HOME.
 */
export function beginTransaction({ workspace, txnDir, store, ledgerDir, index, previous = null, controls = [], repos = [], worktrees = [], stream = null, plugin = null, home = null }) {
  mkdirSync(txnDir, { recursive: true });
  const pre = captureSnapshot({ root: workspace, store, previous });
  const preFile = join(txnDir, 'pre.json');
  const pre_sha256 = saveSnapshot(pre, preFile);
  const begin = { schema: TXN_SCHEMA, index, workspace, store, ledger_dir: ledgerDir, ledger: ledgerMark(ledgerDir), calls: callsMark(ledgerDir), pre: { file: preFile, sha256: pre_sha256, digest: pre.digest }, controls, repos, worktrees, stream, plugin, home, at: new Date().toISOString() };
  writeFileSync(join(txnDir, 'begin.json'), `${JSON.stringify(begin, null, 1)}\n`);
  return { index, workspace, txnDir, store, ledgerDir, ledger: begin.ledger, calls: begin.calls, pre, controls, repos, worktrees, stream, plugin, home, harness: [], checks: [] };
}

/**
 * While a session runs, the harness itself changed the workspace (a fault
 * plan's teammate commit, landed on the delivery branch and synced into its
 * checkout): note the paths' and refs' states as it left them, measured now,
 * their bytes in the store and kept in `<txnDir>/harness.jsonl`. The
 * settlement attributes them to the harness while the session leaves them so,
 * and every rollback keeps them. `paths`: absolute; `refs`: `[{ gitDir, ref,
 * value }]`.
 */
export function noteHarnessChange({ txn, paths = [], refs = [] }) {
  const entries = {};
  for (const p of paths) {
    const key = keyOf(txn.workspace, resolve(p));
    if (key !== null && key !== '') entries[key] = harnessState(txn, key);
  }
  const noted = refs.map((r) => ({ git: keyOf(txn.workspace, resolve(r.gitDir)), ref: r.ref, value: r.value ?? null })).filter((r) => r.git !== null);
  const note = { at: (BigInt(Date.now()) * 1_000_000n).toString(), entries, refs: noted };
  txn.harness.push(note);
  appendFileSync(join(txn.txnDir, 'harness.jsonl'), `${JSON.stringify(note)}\n`);
  return note;
}

/** One path as the harness left it, in the ledger's form (a file's bytes put into the store; an index with what it stages). */
function harnessState(txn, key) {
  const abs = resolve(txn.workspace, keyBytes(key).toString('utf8'));
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { t: 'absent' };
  }
  const mode = st.mode & 0o7777;
  if (st.isFile()) {
    // Read through one descriptor: a file swapped since the look is something else, never what it was swapped for.
    const read = readRegular(abs);
    if (read === null) return { t: 'o' };
    const bytes = read.bytes;
    return { t: 'f', sha256: putObject(txn.store, bytes), mode, ...(/(?:^|\/)\.git\/index$/.test(key) ? { staged: indexSemantics(bytes) } : {}) };
  }
  if (st.isDirectory()) return { t: 'd', mode };
  if (st.isSymbolicLink()) return { t: 'l', target: readlinkSync(abs, 'utf8') };
  return { t: 'o' };
}

/** The order a violation's changes are shown in: what matters most first (a ref moved before the index that followed it). */
const SHOWN_FIRST = ['gate', 'git-ref', 'product', 'mycelink-state', 'control-input', 'worktree', 'integration', 'git', 'derived', 'scratch'];

/**
 * The lines a violation is shown in (paths escaped, no content), at most
 * SUMMARY_LINES and a count: what the controller's own calls wrote
 * (`reachedKeys`) first, then by SHOWN_FIRST, then by path.
 */
function summaryOf(unauthorized, reachedKeys = new Set()) {
  const rank = (d) => (SHOWN_FIRST.includes(d.category) ? SHOWN_FIRST.indexOf(d.category) : SHOWN_FIRST.length);
  const ordered = [...unauthorized].sort((a, b) => Number(reachedKeys.has(b.key)) - Number(reachedKeys.has(a.key)) || rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const lines = ordered.map((d) => `${d.path} (${d.change === 'ref' ? movedText(d) : d.change}; ${CATEGORY_TEXT[d.category] ?? d.category})`);
  return lines.length > SUMMARY_LINES ? [...lines.slice(0, SUMMARY_LINES), `and ${lines.length - SUMMARY_LINES} more`] : lines;
}

/**
 * How a ref moved: from where to where — and, for a stash, through every
 * state its transitions left (CSET-202 final: an entry pushed and popped
 * moved it "from nothing through <entry> to nothing", never "from nothing
 * to nothing").
 */
function movedText(d) {
  const short = (x) => (x ? x.slice(0, 12) : 'nothing');
  const states = [d.pre ?? null];
  if (d.kind === 'stash') for (const t of d.transitions ?? []) if ((t.top ?? null) !== states.at(-1)) states.push(t.top ?? null);
  if (states.at(-1) !== (d.post ?? null)) states.push(d.post ?? null);
  if (states.length <= 2) return `moved from ${short(d.pre)} to ${short(d.post)}`;
  return `moved from ${short(states[0])} through ${states.slice(1, -1).map(short).join(', ')} to ${short(states.at(-1))}`;
}

/** A violation's identity: what it changed and how, never its content (an identical repeat is terminal). */
export function violationFingerprint(unauthorized) {
  return sha256Hex(canonicalJson(unauthorized.filter((d) => d.verdict === 'unauthorized').map((d) => [d.category, d.key, d.change]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))));
}

/** Copy the core's kept bytes for every target that needs them into the harness's store; false when one is missing. */
function stageCoreContent(txn, deltas) {
  for (const d of deltas) {
    const sha = d.target?.from === 'core' && d.target.entry?.t === 'f' ? d.target.entry.sha256 : null;
    if (!sha || existsSync(objectPath(txn.store, sha))) continue;
    const kept = join(txn.ledgerDir, 'objects', sha.slice(0, 2), sha);
    try {
      const bytes = readFileSync(kept);
      if (sha256Hex(bytes) !== sha) return false;
      mkdirSync(dirname(objectPath(txn.store, sha)), { recursive: true });
      copyFileSync(kept, objectPath(txn.store, sha));
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The plan inputs of a mode: selective — each unauthorized or housekeeping
 * delta to its target; full — the reconstruction (`recon`, when one could be
 * made), else every delta to its state before the session, or as the
 * harness last left it.
 */
function targetsFor(mode, cls, txn, now, recon = null) {
  const pre = txn.pre;
  if (mode === 'full' && recon?.ok) return { entries: recon.entries, refs: recon.refs, reflogs: recon.reflogs, dirs: recon.dirs };
  const entries = {};
  const refs = [];
  const reflogs = [];
  const chosen = mode === 'full' ? cls.deltas : cls.deltas.filter((d) => d.verdict !== 'authorized' && d.category !== 'worktree' && d.category !== 'integration');
  for (const d of chosen) {
    if (d.kind === 'stash') {
      // The stash: its ref, then its reflog's exact bytes; an entry it takes out is archived, never lost.
      const to = mode === 'full' ? { ref: d.pre, log: d.pre_log } : d.target;
      refs.push({ git: d.git, ref: 'refs/stash', pre: d.pre, post: d.post, to: to.ref });
      reflogs.push({ git: d.git, ref: 'refs/stash', from: d.post_log, to: to.log });
      refs.push(...stashArchives(txn, d, to.log, now, 'rolled-back'));
    } else if (d.kind === 'ref') refs.push({ git: d.git, ref: d.ref, pre: d.pre, post: d.post, to: mode === 'full' ? (d.harness_ref !== undefined ? d.harness_ref : d.pre) : d.target.ref });
    else entries[d.key] = mode === 'full' ? (d.harness_entry !== undefined ? d.harness_entry : (pre.entries[d.key] ?? null)) : d.target.entry;
  }
  return { entries, refs, reflogs, dirs: {} };
}

/**
 * Archive refs for the entries a rollback takes out of a stash (`d`: from
 * its reflog as `now` has it to `toLog`): `refs/mycelink/archive/<label>/
 * <session>/stash/<entry>`. Nothing set aside is lost — a worker's draft
 * whose attribution could not be established stays recoverable; the
 * controller's own entry stays as evidence (quarantined, never integrated).
 */
function stashArchives(txn, d, toLog, now, label) {
  const entries = (sha) => (sha ? linesOf(readObject(txn.store, sha) ?? Buffer.alloc(0)).map((l) => l.split(' ')[1] ?? '').filter((x) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(x)) : []);
  const kept = new Set(entries(toLog));
  return [...new Set(entries(d.post_log))]
    .filter((sha) => !kept.has(sha))
    .map((sha) => {
      const ref = `refs/mycelink/archive/${label}/${txn.index}/stash/${sha}`;
      return { git: d.git, ref, pre: null, post: now.git?.[d.git]?.refs?.[ref] ?? null, to: sha };
    });
}

/** A target entry as a plan keeps it, from a snapshot entry. */
function asTarget(e) {
  if (!e) return null;
  return { t: e.t, mode: e.mode, ...(e.t === 'f' ? { sha256: e.sha256 ?? null } : {}), ...(e.t === 'l' ? { target: e.target ?? null } : {}) };
}
/** A target entry from a ledger state (a file's bytes kept by the core). */
function stateTarget(s) {
  if (!s || s.t === 'absent') return null;
  return { t: s.t, mode: s.mode, ...(s.t === 'f' ? { sha256: s.sha256 } : {}), ...(s.t === 'l' ? { target: relKey(Buffer.from(s.target, 'utf8')) } : {}) };
}

/**
 * Where a reconstruction cuts the session (CSET-203 r12): the start of the
 * first core process that read a violation after it changed — and of every
 * core process still running then, so the cut never falls inside one. Null
 * when nothing rests on the violation by a recorded read, or when something
 * no reconstruction can tell apart (`whole`) is in the session.
 */
export function reconstructionCut(cls) {
  const { L } = cls.internal ?? {};
  if (!L || cls.whole.length > 0 || cls.dependencies.length === 0) return null;
  let cut = null;
  for (const d of cls.dependencies) {
    const p = L.procs.get(d.pid);
    const t = p ? p.first : BigInt(d.at);
    if (cut === null || t < cut) cut = t;
  }
  for (let moved = true; moved; ) {
    moved = false;
    for (const p of L.procs.values()) {
      if (p.first < cut && p.last >= cut) {
        cut = p.first;
        moved = true;
      }
    }
  }
  return cut;
}

/**
 * A full rollback as a reconstruction (CSET-203 r12: r12's went back to
 * before the feature began, and with it every step Mycelink and its worker
 * had made): the workspace as it stood at the cut (reconstructionCut), with
 * every authorised step that does not rest on the violation kept.
 *
 *  - Mycelink's core files, refs and Git metadata: as the core's ledger
 *    records them just before the cut (or as they were before the session);
 *    what it made later goes, a commit a reverted ref held archived under
 *    `refs/mycelink/archive/reconstructed/<session>/`;
 *  - a worktree the core made at or after the cut goes with its admin
 *    directory (its branch archived): the claim that made it is gone too;
 *    one of Mycelink's own (an integration checkout) it changed after the
 *    cut goes, for Mycelink to make again from its branch;
 *  - a module-worker's worktree that stood at the cut stays exactly as the
 *    worker left it, and so do its stash entries; the controller's own
 *    documents, its control-repository commits and the harness's changes
 *    stay;
 *  - every violation goes back as a selective rollback would.
 *
 * `{ ok: false, reason }` when it cannot be made (a core write whose bytes
 * were not kept, an index or a product checkout the core changed after the
 * cut, a worktree the controller reached into): then the whole session goes
 * back. Else `{ ok: true, cut, entries, refs, reflogs, dirs, removed_zones,
 * kept_zones, archived, reverted }`.
 */
function reconstruction({ txn, cls, post, cut }) {
  const { L, z } = cls.internal;
  const { workspace } = txn;
  const pre = txn.pre;
  const problems = [];
  const entries = {};
  const refs = [];
  const reflogs = [];
  const dirs = {};
  const archived = [];
  const keyAbs = (abs) => keyOf(workspace, resolve(abs));
  const harnessKeys = new Set((txn.harness ?? []).flatMap((n) => Object.keys(n.entries)));
  const harnessRefs = new Set((txn.harness ?? []).flatMap((n) => n.refs.map((r) => `${r.git}:${r.ref}`)));
  const sameTarget = (a, b) => same(a ?? null, asTarget(b) ?? null);
  if (cls.contaminated.length > 0) problems.push(`a worktree the controller reached into (${cls.contaminated.map((w) => showKey(w)).join(', ')}) goes back through Mycelink, not by a reconstruction`);

  // Worktrees: made by the core at or after the cut (their admin gitdir appeared then), or Mycelink's own changed then.
  const createdAt = new Map();
  for (const g of L.git) {
    for (const [abs, pair] of Object.entries(g.changed.files ?? {})) {
      const k = keyAbs(abs);
      const m = k === null ? null : /^(.*\/\.git\/worktrees\/[^/]+)\/gitdir$/.exec(k);
      if (m && pair[0]?.t === 'absent' && pair[1]?.t === 'f' && !createdAt.has(m[1])) createdAt.set(m[1], g.t);
    }
  }
  const touchedAfter = (wt, adminKey) =>
    L.gitOps.some((o) => o.t >= cut && o.cwd !== null && under(o.cwd, wt)) ||
    L.git.some((g) => g.t >= cut && [...Object.keys(g.changed.files ?? {}), ...Object.keys(g.changed.indexes ?? {})].some((abs) => {
      const k = keyAbs(abs);
      return k !== null && under(k, adminKey);
    })) ||
    [...L.files.entries()].some(([k, recs]) => under(k, wt) && recs.some((r) => r.t >= cut));
  const removedZones = [];
  const keptZones = [];
  for (const [adminKey, wt] of z.admin) {
    const created = createdAt.get(adminKey);
    const worker = z.worker.includes(wt);
    if ((created !== undefined && created >= cut) || (!worker && z.own.includes(wt) && touchedAfter(wt, adminKey))) removedZones.push({ wt, admin: adminKey });
    else if (worker) keptZones.push({ wt, admin: adminKey });
  }
  const inRemoved = (key) => removedZones.some((r) => under(key, r.wt) || under(key, r.admin));
  const inKept = (key) => keptZones.some((r) => under(key, r.wt) || under(key, r.admin));
  for (const r of removedZones) {
    for (const key of Object.keys(post.entries)) if ((under(key, r.wt) || under(key, r.admin)) && !isRefFile(key)) entries[key] = null;
    const git = r.admin.replace(/\/worktrees\/[^/]+$/, '');
    const own = `worktrees/${r.admin.slice(git.length + '/worktrees/'.length)}/`;
    for (const ref of Object.keys(post.git?.[git]?.refs ?? {})) if (ref.startsWith(own)) refs.push({ git, ref, pre: null, post: post.git[git].refs[ref], to: null });
  }

  // The core's own files: as it left each just before the cut, else as it was before the session.
  const stateAt = (key) => {
    let last = null;
    for (const r of L.files.get(key) ?? []) if (r.t < cut) last = r;
    return last;
  };
  const asOfCut = (key) => {
    const last = stateAt(key);
    if (last === null) return { entry: asTarget(pre.entries[key]), from: 'pre' };
    if (last.state.t === 'f' && !last.state.kept) return { problem: `no content to restore ${showKey(key)} to as the core left it before the cut` };
    return { entry: stateTarget(last.state), from: 'core' };
  };
  let reverted = 0;
  for (const [key, recs] of L.files) {
    if (key === '' || !recs.some((r) => r.t >= cut) || inRemoved(key) || inKept(key) || harnessKeys.has(key) || isRefFile(key) || isIndexFile(key) || insideExcluded(key)) continue;
    const a = asOfCut(key);
    if (a.problem) {
      problems.push(a.problem);
      continue;
    }
    if (!sameTarget(a.entry, post.entries[key])) {
      entries[key] = a.entry;
      reverted += 1;
    }
  }
  // Git metadata files a core git command changed at or after the cut: as they were just before its first such change.
  const metaBefore = new Map();
  for (const g of L.git) {
    if (g.t < cut) continue;
    for (const [abs, pair] of Object.entries(g.changed.files ?? {})) {
      const k = keyAbs(abs);
      if (k !== null && !metaBefore.has(k)) metaBefore.set(k, pair[0]);
    }
    for (const abs of Object.keys(g.changed.indexes ?? {})) {
      const k = keyAbs(abs);
      if (k !== null && !inRemoved(k) && !inKept(k)) problems.push(`the core changed the index ${showKey(k)} after the cut, and an index's bytes are never kept`);
    }
  }
  for (const [k, before] of metaBefore) {
    if (inRemoved(k) || inKept(k) || harnessKeys.has(k) || insideExcluded(k)) continue;
    // Bytes git's ledger did not keep are still the session's own start, when that is what they were.
    if (before?.t === 'f' && !before.kept && pre.entries[k]?.sha256 === before.sha256 && readObject(txn.store, before.sha256) !== null) before.kept = true;
    if (before?.t === 'f' && !before.kept) {
      problems.push(`no content to restore ${showKey(k)} to as git left it before the cut`);
      continue;
    }
    const target = stateTarget(before);
    if (!sameTarget(target, post.entries[k])) {
      entries[k] = target;
      reverted += 1;
    }
  }
  // A product checkout the core changed after the cut (a delivery) cannot be rebuilt from what was recorded.
  for (const o of L.gitOps) {
    // Only a command that rewrites the work tree it runs in (a worktree add or a ref update run from it does not).
    if (o.t < cut || o.cwd === null || !CHECKOUT_WRITERS.has(o.sub ?? '')) continue;
    const repo = z.repos.find((r) => under(o.cwd, r) && !under(o.cwd, `${r}/.git`));
    if (repo !== undefined && !inRemoved(o.cwd) && !inKept(o.cwd)) problems.push(`the core changed the checkout ${showKey(repo)} after the cut (git ${o.sub ?? ''})`);
  }
  // Refs the core moved at or after the cut: back to where its first such change found them; a commit they then held is archived.
  const refBefore = new Map();
  for (const g of L.git) {
    if (g.t < cut || g.common === null) continue;
    for (const [ref, pair] of Object.entries(g.changed.refs ?? {})) {
      const k = `${g.common}:${ref}`;
      if (ref !== 'refs/stash' && !refBefore.has(k)) refBefore.set(k, { git: g.common, ref, value: pair[0] ?? null });
    }
  }
  const unauthorizedRefs = new Set(cls.deltas.filter((d) => d.verdict !== 'authorized' && d.kind === 'ref').map((d) => d.key));
  for (const [k, { git, ref, value }] of refBefore) {
    if (harnessRefs.has(k) || unauthorizedRefs.has(k) || ref.startsWith('worktrees/')) continue;
    const now = post.git?.[git]?.refs?.[ref] ?? null;
    if (value === now) continue;
    if (now !== null && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(now)) {
      const archive = `refs/mycelink/archive/reconstructed/${txn.index}/${ref.replace(/^refs\//, '')}`;
      refs.push({ git, ref: archive, pre: null, post: post.git?.[git]?.refs?.[archive] ?? null, to: now });
      archived.push({ git: showKey(git), ref: archive, commit: now });
    }
    refs.push({ git, ref, pre: value, post: now, to: value });
  }
  // Each stash: the transitions of workers whose worktree stands, and the core's before the cut; nothing else.
  const keptClaims = new Set();
  for (const d of cls.deltas.filter((x) => x.kind === 'stash')) {
    for (const t of d.chain?.transitions ?? []) {
      for (const w of t.by === 'worker' ? (t.workers ?? [t.worker]) : []) {
        const wt = w?.worktree ? keyAbs(w.worktree) : null;
        if (wt !== null && keptZones.some((r) => r.wt === wt)) keptClaims.add(w.claim_id);
      }
    }
    const keep = (t, line) => (t.by === 'core' ? BigInt(t.at) < cut : t.by === 'worker' ? keptClaims.has(line?.claim_id ?? t.worker.claim_id) : false);
    const target = stashTarget({ store: txn.store, before: { lines: d.chain?.before ?? [] }, transitions: d.chain?.transitions ?? [], keep });
    if (target.ref !== d.post) refs.push({ git: d.git, ref: 'refs/stash', pre: d.pre, post: d.post, to: target.ref });
    if (target.log !== d.post_log) reflogs.push({ git: d.git, ref: 'refs/stash', from: d.post_log, to: target.log });
    // An entry a worker made whose worktree goes, and any other the reconstruction takes out of the stash: archived, never lost.
    const archives = new Set();
    for (const t of d.chain?.transitions ?? []) {
      if (t.by !== 'worker') continue;
      for (const sha of t.added) {
        if (sha === null || keep(t, t.lines?.find((x) => x.entry === sha) ?? null)) continue;
        const archive = `refs/mycelink/archive/reconstructed/${txn.index}/stash/${sha}`;
        if (archives.has(archive)) continue;
        archives.add(archive);
        refs.push({ git: d.git, ref: archive, pre: null, post: post.git?.[d.git]?.refs?.[archive] ?? null, to: sha });
        archived.push({ git: showKey(d.git), ref: archive, commit: sha });
      }
    }
    for (const a of stashArchives(txn, d, target.log, post, 'reconstructed')) {
      if (archives.has(a.ref)) continue;
      archives.add(a.ref);
      refs.push(a);
      archived.push({ git: showKey(d.git), ref: a.ref, commit: a.to });
    }
  }
  // The session's violations, as a selective rollback takes them back — to the core's state as of the cut where the core wrote them.
  for (const d of cls.deltas) {
    if (d.verdict === 'authorized' || d.kind === 'stash' || d.category === 'worktree' || d.category === 'integration' || inRemoved(d.key)) continue;
    if (d.kind === 'ref') {
      const to = refBefore.has(d.key) ? refBefore.get(d.key).value : d.target.ref;
      refs.push({ git: d.git, ref: d.ref, pre: d.pre, post: d.post, to });
      continue;
    }
    if (d.target?.from === 'core' && (L.files.get(d.key) ?? []).some((r) => r.t >= cut)) {
      const a = asOfCut(d.key);
      if (a.problem) problems.push(a.problem);
      else entries[d.key] = a.entry;
    } else entries[d.key] = d.target?.entry ?? asTarget(pre.entries[d.key]);
  }
  // A directory a target needs that neither side of the session holds: as the core made it before the cut.
  for (const [key, target] of Object.entries(entries)) {
    if (target === null) continue;
    for (let p = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : null; p !== null && p !== ''; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null) {
      if (post.entries[p] || pre.entries[p] || entries[p] !== undefined) break;
      const s = stateAt(p);
      if (s?.state?.t === 'd') dirs[p] = s.state.mode;
    }
  }
  // The core's kept bytes for every file it goes back to.
  for (const target of Object.values(entries)) {
    if (target?.t === 'f' && target.sha256 && !stageObject(txn, target.sha256)) problems.push(`the core’s kept bytes ${target.sha256.slice(0, 12)} are missing or corrupt`);
  }
  if (problems.length > 0) return { ok: false, reason: problems[0], problems };
  return { ok: true, cut, entries, refs, reflogs, dirs, removed_zones: removedZones.map((r) => showKey(r.wt)), kept_zones: keptZones.map((r) => showKey(r.wt)), archived, reverted };
}

/** Git subcommands that rewrite the files of the work tree they run in. */
const CHECKOUT_WRITERS = new Set(['checkout', 'switch', 'restore', 'merge', 'reset', 'pull', 'rebase', 'cherry-pick', 'revert', 'stash', 'apply', 'am', 'read-tree', 'clean', 'rm', 'mv', 'checkout-index', 'sparse-checkout']);

/** Bytes for `sha` in the harness's store: there already, or copied from the core's ledger; false when neither holds them intact. */
function stageObject(txn, sha) {
  if (existsSync(objectPath(txn.store, sha))) return true;
  const kept = join(txn.ledgerDir, 'objects', sha.slice(0, 2), sha);
  try {
    const bytes = readFileSync(kept);
    if (sha256Hex(bytes) !== sha) return false;
    mkdirSync(dirname(objectPath(txn.store, sha)), { recursive: true });
    copyFileSync(kept, objectPath(txn.store, sha));
    return true;
  } catch {
    return false;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
}

/**
 * After a controller session: attribute every change and roll back the
 * controller's own, verified (see the module comment). `reached`: absolute
 * paths the controller's own tool calls wrote; `discard(worktreeAbs)` takes a
 * contaminated worktree's dispatch back through Mycelink (`{ discarded,
 * detail }`) — one that cannot be discarded makes the rollback full.
 * `faults` (tests): `crashAfterSteps`, `beforeApply()`.
 *
 * Returns `{ violation, mode ('none' | 'selective' | 'full'), unauthorized,
 * authorized, housekeeping, contaminated, discarded, ambiguous, summary,
 * fingerprint, ledger, rollback, snapshot }`, also kept as
 * `<txnDir>/result.json` (without the snapshot).
 */
export function settleTransaction({ txn, reached = [], controls = [], repos = [], worktrees = [], discard = null, forced = [], faults = {}, maxRounds = 4, stream = null }) {
  const post = captureSnapshot({ root: txn.workspace, store: txn.store, previous: txn.pre });
  const postFile = join(txn.txnDir, 'post.json');
  saveSnapshot(post, postFile);
  const cls = classifyTransaction({ txn, post, reached, controls, repos, worktrees, stream });
  // What the controller did through Mycelink's own commands as if it were a worker (a gate it ran itself):
  // the core attests the effects, but they are not the controller's to cause — the whole session goes back.
  for (const f of forced) {
    cls.unauthorized.push({ path: f.path ?? '(a gate)', key: `forced:${f.kind}:${f.path ?? ''}`, kind: 'forced', change: f.kind, verdict: 'unauthorized', category: f.kind, inert: false, detail: f.detail ?? null });
    cls.ambiguous.push(`${f.detail ?? f.kind}: its effects are the core's, caused by the controller`);
    cls.whole.push(`${f.detail ?? f.kind}: its effects are the core's, caused by the controller`);
  }
  const unauthorized = cls.unauthorized;
  let mode = unauthorized.length === 0 && cls.housekeeping.length === 0 ? 'none' : cls.ambiguous.length > 0 ? 'full' : 'selective';
  const record = {
    schema: TXN_SCHEMA,
    index: txn.index,
    violation: unauthorized.length > 0,
    mode,
    unauthorized: unauthorized.map(({ path, key, kind, change, category, inert, worktree, target, reasons }) => ({ path, key, kind, change, category, inert, ...(worktree ? { worktree } : {}), restore_to: target?.from ?? (kind === 'ref' || kind === 'stash' ? 'ref' : null), ...(kind === 'stash' ? { reasons } : {}) })),
    authorized: cls.authorized,
    housekeeping: cls.housekeeping.map(({ path, change, category }) => ({ path, change, category })),
    contaminated: cls.contaminated,
    discarded: [],
    ambiguous: cls.ambiguous,
    dependencies: cls.dependencies,
    // What module-workers changed in a repository's shared Git state, by whose call (CSET-203 r12): authorised, on record.
    worker_git: cls.worker_git,
    summary: summaryOf(unauthorized, new Set(reached.map((p) => keyOf(txn.workspace, resolve(p))).filter((k) => k !== null))),
    fingerprint: unauthorized.length ? violationFingerprint(unauthorized) : null,
    ledger: cls.ledger,
    calls: cls.calls,
    pre: { digest: txn.pre.digest },
    post: { file: postFile, digest: post.digest },
  };
  // Where a full rollback would cut the session (reconstructionCut), kept with the classification: a resumed rollback cuts there too.
  const initialCut = reconstructionCut(cls);
  writeJson(join(txn.txnDir, 'classification.json'), { ...record, reconstruction_cut: initialCut === null ? null : initialCut.toString(), deltas: cls.deltas.map(({ chain, ...d }) => d) });
  if (mode === 'none') {
    record.rollback = null;
    writeJson(join(txn.txnDir, 'result.json'), record);
    return { ...record, snapshot: post };
  }
  if (mode === 'selective' && !stageCoreContent(txn, cls.deltas.filter((d) => d.verdict !== 'authorized'))) {
    record.ambiguous.push('the core’s kept bytes for a target are missing or corrupt');
    cls.whole.push('the core’s kept bytes for a target are missing or corrupt');
    mode = 'full';
  }
  // A full rollback reconstructs the workspace as it stood just before the first core step that read a violation (CSET-203 r12).
  const cut = cls.whole.length > 0 ? null : initialCut;
  let rollback = rollBack({ txn, cls, mode, post, faults, maxRounds, reached, controls, repos, worktrees, cut, stream });
  // A contaminated worktree goes back through Mycelink; one that cannot is rolled back with the whole session.
  if (rollback.verified && mode === 'selective' && cls.contaminated.length > 0) {
    for (const w of cls.contaminated) {
      const abs = resolve(txn.workspace, keyBytes(w).toString('utf8'));
      const res = discard ? discard(abs) : { discarded: false, detail: 'no discard given' };
      record.discarded.push({ worktree: w, ...res });
    }
    if (record.discarded.some((x) => !x.discarded)) {
      record.ambiguous.push(`a contaminated worktree could not be discarded through Mycelink: ${record.discarded.filter((x) => !x.discarded).map((x) => showKey(x.worktree)).join(', ')}`);
      mode = 'full';
      rollback = rollBack({ txn, cls, mode, post: rollback.snapshot ?? post, faults: {}, maxRounds, reached, controls, repos, worktrees, cut: null, stream });
    } else {
      // The discard changed the workspace through Mycelink: what follows starts from there.
      rollback.snapshot = captureSnapshot({ root: txn.workspace, store: txn.store, previous: rollback.snapshot });
    }
  }
  // The mode the rollback ran in (a selective plan that could not be made goes back whole).
  mode = rollback.mode;
  record.mode = mode;
  record.rollback = { ...rollback, snapshot: undefined, mode };
  record.rollback.manifest_sha256 = rollbackManifestDigest(record);
  writeJson(join(txn.txnDir, 'result.json'), record);
  return { ...record, snapshot: rollback.snapshot ?? post };
}

/**
 * Roll back toward the targets of `mode`, re-snapshotting and re-planning
 * when a path changed after the snapshot (TOCTOU), up to `maxRounds`.
 */
function rollBack({ txn, cls, mode, post, faults, maxRounds, reached, controls, repos, worktrees, cut = null, stream = null }) {
  let current = post;
  let currentCls = cls;
  const restored = new Set();
  const removed = new Set();
  const refs = [];
  const reflogs = [];
  let plan = null;
  let verified = null;
  let rounds = 0;
  let lastError = null;
  /** The reconstruction a full rollback ran as, or why it went back whole. */
  let recon = null;
  let whole = null;
  // Each attempt (a resume after a crash is another) journals its rounds apart.
  let n = 1;
  while (existsSync(join(txn.txnDir, `attempt-${n}`))) n += 1;
  const attempt = join(txn.txnDir, `attempt-${n}`);
  mkdirSync(attempt, { recursive: true });
  for (rounds = 1; rounds <= maxRounds; rounds++) {
    recon = null;
    if (mode === 'full') {
      const at = cut ?? (whole === null ? reconstructionCut(currentCls) : null);
      recon = at === null ? { ok: false, reason: currentCls.whole[0] ?? 'nothing rests on the violation by a recorded read' } : reconstruction({ txn, cls: currentCls, post: current, cut: at });
      if (recon.ok) cut = at;
      else whole = recon.reason;
    }
    const { entries, refs: refTargets, reflogs: reflogTargets, dirs } = targetsFor(mode, currentCls, txn, current, recon);
    try {
      plan = planRollback({ root: txn.workspace, pre: txn.pre, post: current, targets: entries, refs: refTargets, reflogs: reflogTargets, dirs });
    } catch (error) {
      lastError = String(error?.message ?? error);
      if (mode === 'selective') {
        mode = 'full';
        continue;
      }
      if (recon?.ok) {
        // A reconstruction that cannot be planned goes back whole.
        whole = `the reconstruction could not be planned: ${lastError}`;
        cut = null;
        rounds -= 1;
        continue;
      }
      break;
    }
    if (rounds === 1) faults.beforeApply?.();
    try {
      applyRollback({ root: txn.workspace, store: txn.store, plan, txnDir: join(attempt, `round-${rounds}`), faults: rounds === 1 ? { crashAfterSteps: faults.crashAfterSteps } : {} });
    } catch (error) {
      if (!(error instanceof RollbackConflict)) throw error;
      lastError = error.message;
      current = captureSnapshot({ root: txn.workspace, store: txn.store, previous: current });
      currentCls = classifyTransaction({ txn, post: current, reached, controls, repos, worktrees, stream });
      continue;
    }
    for (const [key, target] of Object.entries(plan.targets)) (target === null ? removed : restored).add(showKey(key));
    for (const r of plan.refs) for (const u of r.updates) refs.push({ git: showKey(r.git), ref: u.ref, from: u.from, to: u.to });
    for (const r of plan.reflogs ?? []) reflogs.push({ git: showKey(r.git), ref: r.ref, from: r.from, to: r.to });
    verified = verifyRollback({ root: txn.workspace, store: txn.store, post: current, plan });
    if (verified.ok) break;
    lastError = `verification: ${verified.mismatches.slice(0, 3).map((m) => m.key).join(', ')}`;
    current = verified.snapshot;
    currentCls = classifyTransaction({ txn, post: current, reached, controls, repos, worktrees, stream });
  }
  const ok = Boolean(verified?.ok);
  // What the verification saw is kept beside the manifest: the state an attestation compares the run's end with.
  if (ok) saveSnapshot(verified.snapshot, join(txn.txnDir, 'after.json'));
  const cutAt = recon?.ok ? recon.cut : null;
  return {
    mode,
    verified: ok,
    rounds: Math.min(rounds, maxRounds),
    plan_sha256: plan?.sha256 ?? null,
    digest: verified?.digest ?? null,
    restored: [...restored].sort(),
    removed: [...removed].sort(),
    refs,
    ...(reflogs.length > 0 ? { reflogs } : {}),
    // A full rollback: the reconstruction it ran as (where it cut the session, what it took away and archived), or why it went back whole.
    ...(mode === 'full'
      ? cutAt !== null
        ? { reconstruction: { cut: cutAt.toString(), cut_at: new Date(Number(cutAt / 1_000_000n)).toISOString(), removed_zones: recon.removed_zones, kept_zones: recon.kept_zones, archived: recon.archived, reverted: recon.reverted } }
        : { reconstruction: null, whole: whole ?? 'the whole session' }
      : {}),
    ...(ok ? {} : { error: lastError }),
    snapshot: verified?.snapshot ?? null,
  };
}

/**
 * Finish a transaction a crash interrupted (or confirm one already done):
 * the session's classification is kept as it was recorded; the rollback is
 * planned again from the workspace as it is now and verified. A transaction
 * already settled and verified, whose workspace is still as verified, is
 * returned as recorded.
 */
export function resumeTransaction({ txnDir, store }) {
  const begin = JSON.parse(readFileSync(join(txnDir, 'begin.json'), 'utf8'));
  const pre = loadSnapshot(begin.pre.file);
  const notes = existsSync(join(txnDir, 'harness.jsonl')) ? readFileSync(join(txnDir, 'harness.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const checks = existsSync(join(txnDir, 'checks.jsonl')) ? readFileSync(join(txnDir, 'checks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const txn = { index: begin.index, workspace: begin.workspace, txnDir, store: store ?? begin.store, ledgerDir: begin.ledger_dir, ledger: begin.ledger, calls: begin.calls, pre, controls: begin.controls ?? [], repos: begin.repos ?? [], worktrees: begin.worktrees ?? [], stream: begin.stream ?? null, plugin: begin.plugin ?? null, home: begin.home ?? null, harness: notes, checks };
  const resultFile = join(txnDir, 'result.json');
  if (existsSync(resultFile)) {
    const done = JSON.parse(readFileSync(resultFile, 'utf8'));
    const now = captureSnapshot({ root: txn.workspace, store: txn.store, previous: pre });
    if (done.rollback?.verified && done.rollback.digest === now.digest) return { ...done, snapshot: now };
  }
  const recorded = JSON.parse(readFileSync(join(txnDir, 'classification.json'), 'utf8'));
  const post = loadSnapshot(join(txnDir, 'post.json'));
  const current = captureSnapshot({ root: txn.workspace, store: txn.store, previous: post });
  const cls = classifyTransaction({ txn, post: current });
  const mode = recorded.mode === 'full' || cls.ambiguous.length > 0 ? 'full' : 'selective';
  const cut = typeof recorded.reconstruction_cut === 'string' ? BigInt(recorded.reconstruction_cut) : null;
  const rollback = rollBack({ txn, cls, mode, post: current, faults: {}, maxRounds: 4, reached: [], controls: [], repos: [], worktrees: [], cut });
  const { deltas, reconstruction_cut: recordedCut, ...record } = recorded;
  void deltas;
  void recordedCut;
  record.mode = rollback.mode;
  record.rollback = { ...rollback, snapshot: undefined, resumed: true };
  record.rollback.manifest_sha256 = rollbackManifestDigest(record);
  writeJson(resultFile, record);
  return { ...record, snapshot: rollback.snapshot ?? current };
}

/**
 * A settled transaction's manifest digest: the session's violation (what
 * changed, how, and what it went back to), the snapshots it rests on, the
 * mode, what the rollback restored, removed and moved back, the dispatches
 * discarded, whether it was verified and the digest it verified. The same
 * for settleTransaction and resumeTransaction, and recomputed by
 * attestRollbacks from `result.json`.
 */
export function rollbackManifestDigest(record) {
  const r = record.rollback ?? {};
  return sha256Hex(
    canonicalJson({
      pre: record.pre?.digest ?? null,
      post: record.post?.digest ?? null,
      mode: r.mode ?? null,
      unauthorized: (record.unauthorized ?? []).map((d) => [d.key, d.change, d.restore_to ?? null]),
      discarded: (record.discarded ?? []).map((d) => [d.worktree, d.discarded === true]),
      restored: r.restored ?? [],
      removed: r.removed ?? [],
      refs: r.refs ?? [],
      verified: r.verified === true,
      digest: r.digest ?? null,
      // The stash's reflog restored, and where a reconstruction cut the session (CSET-203 r12): attested like the rest.
      ...(r.reflogs?.length ? { reflogs: r.reflogs } : {}),
      ...(r.reconstruction ? { reconstruction: { cut: r.reconstruction.cut, removed_zones: r.reconstruction.removed_zones ?? [], archived: r.reconstruction.archived ?? [] } } : {}),
      ...(r.whole ? { whole: r.whole } : {}),
    }),
  );
}

/** Commits a ref delta's controller value holds that the workspace had nowhere before the session (newest first, capped), or null when git cannot tell. */
function introducedCommits(gitAbs, d, pre) {
  const exclude = [...new Set([...Object.values(pre.git?.[d.git]?.refs ?? {}), d.pre, d.target?.ref].filter((x) => typeof x === 'string' && x !== ''))];
  if (safeGit(dirname(gitAbs), ['--git-dir', gitAbs, 'cat-file', '-e', `${d.post}^{commit}`]).code !== 0) return [];
  const r = safeGit(dirname(gitAbs), ['--git-dir', gitAbs, 'rev-list', '--max-count=200', '--ignore-missing', '--stdin'], { input: `${[d.post, ...exclude.map((x) => `^${x}`)].join('\n')}\n` });
  if (r.code !== 0) return null;
  return r.stdout.split('\n').filter((l) => /^[0-9a-f]{40,64}$/.test(l));
}

/** Mycelink's archive of a discarded or reopened dispatch's branch: kept as evidence, never integrated or delivered. */
const QUARANTINE_REF = /^refs\/mycelink\/archive\//;

/**
 * What of a repository reaches `commit`: `{ ref }`, the first ref (or a
 * detached HEAD) outside Mycelink's archive, or null; `quarantined`, the
 * archive refs that hold it.
 */
function reachingRef(gitAbs, commit) {
  const r = safeGit(dirname(gitAbs), ['--git-dir', gitAbs, 'for-each-ref', '--contains', commit, '--format=%(refname)']);
  const refs = r.stdout.split('\n').filter(Boolean);
  const quarantined = refs.filter((x) => QUARANTINE_REF.test(x));
  const live = refs.find((x) => !QUARANTINE_REF.test(x)) ?? (safeGit(dirname(gitAbs), ['--git-dir', gitAbs, 'merge-base', '--is-ancestor', commit, 'HEAD']).code === 0 ? 'HEAD' : null);
  return { ref: live, quarantined };
}

/**
 * Attest every controller violation's rollback again, after the run and
 * apart from how the session recorded it (CSET-203 r10: a verified rollback
 * is trusted, never taken at its word). `sessions`: the run record's, each
 * guarded one with its `controller_txn` (`dir`, its rollback's manifest
 * digest) and, when it violated, its `violation`.
 *
 * For each violating session: its transaction's `result.json` must be
 * there, hash to its manifest digest (rollbackManifestDigest) and be the
 * manifest the run recorded; its rollback verified, in a definite mode; its
 * pre, post and rolled-back snapshots (`pre.json`, `post.json`,
 * `after.json`) the ones the manifest names; its classification the one
 * the manifest lists. Then the workspace as the run left it (`previous`: a
 * snapshot to use as the stat cache): no path the controller changed may
 * still be as the controller left it — unless a later session's
 * transaction authorised that very state — and no commit it made may be
 * reachable from a ref — Mycelink's archive of a discarded dispatch aside,
 * which keeps it as evidence and is listed (`quarantined`).
 *
 * Returns `{ ok, problems, sessions: [{ session, ok, mode, manifest_sha256,
 * checked, quarantined }] }`; problems name paths and commit ids, never
 * content.
 */
export function attestRollbacks({ sessions = [], workspace, store, previous = null }) {
  const violated = sessions.filter((s) => s.violation || s.controller_txn?.violation);
  const problems = [];
  const out = [];
  if (violated.length === 0) return { ok: true, problems, sessions: out };
  const now = captureSnapshot({ root: workspace, store, previous });
  const read = (file, as = 'json') => {
    try {
      return as === 'snapshot' ? loadSnapshot(file) : JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  // What later sessions' transactions authorised, by path: the state each left it in.
  const laterCache = new Map();
  const later = (s) => {
    if (laterCache.has(s.index)) return laterCache.get(s.index);
    const dir = s.controller_txn?.dir;
    const cls = dir ? read(join(dir, 'classification.json')) : null;
    const post = dir ? read(join(dir, 'post.json'), 'snapshot') : null;
    const ok = cls !== null && post !== null && snapshotDigest(post) === cls.post?.digest;
    const v = ok ? { authorized: new Set((cls.deltas ?? []).filter((d) => d.verdict === 'authorized').map((d) => d.key)), post } : null;
    laterCache.set(s.index, v);
    return v;
  };
  const authorisedLater = (index, key, state) =>
    sessions.some((s) => {
      if (s.index <= index) return false;
      const t = later(s);
      return t !== null && t.authorized.has(key) && same(semanticEntry(t.post, key), state);
    });
  for (const s of violated) {
    const p = [];
    const say = (m) => p.push(`session ${s.index}: ${m}`);
    const entry = { session: s.index, ok: false, mode: null, manifest_sha256: null, checked: 0, quarantined: [] };
    out.push(entry);
    const attest = () => {
      const dir = s.controller_txn?.dir;
      if (!dir) return say('its violation has no transaction record');
      const result = read(join(dir, 'result.json'));
      if (result === null) return say(`its rollback manifest is missing (${join(dir, 'result.json')})`);
      const digest = rollbackManifestDigest(result);
      if (digest !== result.rollback?.manifest_sha256) return say('its rollback manifest does not hash to its digest: it was edited');
      const recorded = s.violation?.manifest_sha256 ?? s.controller_txn?.rollback?.manifest_sha256 ?? null;
      const recordedTxn = s.controller_txn?.rollback?.manifest_sha256 ?? recorded;
      if (recorded !== digest || recordedTxn !== digest) return say(`its rollback manifest ${digest.slice(0, 12)} is not the one the run recorded (${String(recorded).slice(0, 12)})`);
      entry.manifest_sha256 = digest;
      entry.mode = result.rollback.mode ?? null;
      if (result.violation !== true) return say('its rollback manifest records no violation');
      if (result.rollback.verified !== true || s.violation?.verified === false || s.controller_txn?.rollback?.verified === false) return say('its rollback was not verified');
      if (!['selective', 'full'].includes(result.rollback.mode) || result.mode !== result.rollback.mode || result.rollback.error) return say(`its rollback is ambiguous (mode ${result.mode}/${result.rollback.mode})`);
      // A discard names its worktree by key or, as Mycelink reported it, by its absolute path.
      const discardedKey = (x) => (typeof x.worktree === 'string' && isAbsolute(x.worktree) ? keyOf(workspace, resolve(x.worktree)) : x.worktree);
      const undiscarded = (result.contaminated ?? []).filter((w) => result.rollback.mode === 'selective' && !(result.discarded ?? []).some((x) => discardedKey(x) === w && x.discarded === true));
      if (undiscarded.length) return say(`a worktree it reached into was neither discarded nor rolled back: ${undiscarded.map((w) => showKey(w)).join(', ')}`);
      const begin = read(join(dir, 'begin.json'));
      let preBytes = null;
      try {
        preBytes = readFileSync(join(dir, 'pre.json'));
      } catch {
        // missing: below
      }
      const pre = read(join(dir, 'pre.json'), 'snapshot');
      if (begin === null || preBytes === null || pre === null || sha256Hex(preBytes) !== begin.pre?.sha256 || snapshotDigest(pre) !== result.pre?.digest) return say('its pre snapshot is not the one its manifest names');
      const post = read(join(dir, 'post.json'), 'snapshot');
      if (post === null || snapshotDigest(post) !== result.post?.digest) return say('its post snapshot is not the one its manifest names');
      const after = read(join(dir, 'after.json'), 'snapshot');
      if (after === null || snapshotDigest(after) !== result.rollback.digest) return say('its rolled-back snapshot is not the one its manifest names');
      const cls = read(join(dir, 'classification.json'));
      const listed = (result.unauthorized ?? []).filter((d) => d.kind !== 'forced').map((d) => d.key).sort();
      const deltas = (cls?.deltas ?? []).filter((d) => d.verdict === 'unauthorized');
      if (cls === null || canonicalJson(deltas.map((d) => d.key).sort()) !== canonicalJson(listed)) return say('its classification is not the one its manifest lists');
      // The run's end: nothing the controller wrote is left, no commit it made is reachable.
      const commits = new Set();
      for (const d of deltas) {
        entry.checked += 1;
        if (d.kind === 'ref') {
          if (!d.post || d.post === (d.target?.ref ?? null)) continue;
          const gitAbs = resolve(workspace, keyBytes(d.git).toString('utf8'));
          const introduced = introducedCommits(gitAbs, d, pre);
          if (introduced === null) {
            say(`whether a commit it made on ${d.path} is reachable cannot be told`);
            continue;
          }
          // The oldest first: any of them a ref reaches, it reaches through one of these.
          for (const c of [...introduced].reverse()) {
            if (commits.has(c)) break;
            const { ref, quarantined } = reachingRef(gitAbs, c);
            for (const q of quarantined) entry.quarantined.push(`${c.slice(0, 12)} in ${q}`);
            if (ref === null) continue;
            commits.add(c);
            say(`commit ${c.slice(0, 12)} the controller made is reachable from ${ref} (${showKey(d.git)})`);
            break;
          }
          continue;
        }
        const was = semanticEntry(post, d.key);
        const is = semanticEntry(now, d.key);
        // What the rollback did not change (a worktree's, for Mycelink to discard) counts as rolled back only when discarded.
        const changed = d.worktree ? true : !same(was, semanticEntry(after, d.key));
        if (changed && same(is, was) && !authorisedLater(s.index, d.key, is)) say(`${d.path} is still as the controller left it (${d.change}; ${d.category})`);
      }
    };
    attest();
    entry.quarantined = [...new Set(entry.quarantined)];
    entry.ok = p.length === 0;
    problems.push(...p);
  }
  return { ok: problems.length === 0, problems, sessions: out };
}

/**
 * A check while the session runs: a light snapshot (workers' and
 * Mycelink's own worktrees and every node_modules taken as `previous` had
 * them), its changes attributed as settleTransaction would. Returns `{
 * snapshot, unauthorized, contaminated }`: unauthorized changes (keys and
 * their post state, for the caller to see them persist) and the worktrees
 * the controller's own calls (`reached`) changed. `stream`: the session's
 * stream-json text so far (default: the file the transaction names). A stash
 * change not attributed yet, with nothing that points at the controller's
 * own hand — a call the stream does not show yet, a worker's stash its
 * commands do not establish — is no unauthorised change here: the
 * settlement decides.
 */
export function lightCheck({ txn, previous = null, reached = [], stream = null }) {
  const base = previous ?? txn.pre;
  const z = zonesOf({ workspace: txn.workspace, pre: txn.pre, post: base, store: txn.store, controls: txn.controls ?? [], repos: txn.repos ?? [], worktrees: txn.worktrees ?? [] });
  const roots = new Set([...z.worker, ...z.own]);
  const skip = (key) => roots.has(key) || /(?:^|\/)node_modules$/.test(key);
  const snapshot = captureSnapshot({ root: txn.workspace, store: txn.store, previous: base, skip });
  // The core goes on while the workspace is walked: what it touched from just before the walk on is the settlement's to judge.
  const cls = classifyTransaction({ txn, post: snapshot, asOf: BigInt(snapshot.started_ms - RACY_MS) * 1_000_000n, stream, stashReached: reached });
  // What this check saw, kept: a deletion it first saw happened after the check before it (deletedSince).
  const check = { started_ms: snapshot.started_ms, keys: cls.unauthorized.map((d) => d.key) };
  (txn.checks ??= []).push(check);
  try {
    appendFileSync(join(txn.txnDir, 'checks.jsonl'), `${JSON.stringify(check)}\n`);
  } catch {
    // the record is a refinement: without it a deletion counts from the session's start
  }
  const contaminated = new Set();
  for (const p of reached) {
    const key = keyOf(txn.workspace, resolve(p));
    if (key === null) continue;
    const root = [...roots].find((w) => under(key, w));
    if (!root) continue;
    const before = txn.pre.entries[key];
    const was = before ? { t: before.t, mode: before.mode, ...(before.sha256 ? { sha256: before.sha256 } : {}), ...(before.target ? { target: before.target } : {}) } : null;
    if (!same(stateNowOf(txn.workspace, key), was)) contaminated.add(root);
  }
  return {
    snapshot,
    unauthorized: cls.unauthorized.map((d) => ({ path: d.path, key: d.key, change: d.change, category: d.category, state: d.kind === 'ref' ? d.post : canonicalJson(snapshot.entries[d.key] ? { t: snapshot.entries[d.key].t, sha256: snapshot.entries[d.key].sha256 ?? null, target: snapshot.entries[d.key].target ?? null, mode: snapshot.entries[d.key].mode } : null) })),
    contaminated: [...contaminated].sort(),
  };
}

const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** One path now, as an entry is compared: type, mode, content digest or target. */
function stateNowOf(workspace, key) {
  const abs = Buffer.concat([Buffer.from(workspace), Buffer.from('/'), keyBytes(key)]);
  let st;
  try {
    st = statLike(abs);
  } catch {
    return null;
  }
  return st;
}

function statLike(abs) {
  const { lstatSync, readlinkSync } = fsSync;
  const st = lstatSync(abs);
  const t = st.isFile() ? 'f' : st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'o';
  const out = { t, mode: st.mode & 0o7777 };
  if (t === 'f') {
    // Read through one descriptor: a file swapped since the look is no state to compare.
    const bytes = readRegular(abs)?.bytes;
    if (bytes === undefined) throw new Error('changed while it was read');
    out.sha256 = sha256Hex(bytes);
  }
  if (t === 'l') out.target = relKey(readlinkSync(abs, { encoding: 'buffer' }));
  return { t: out.t, mode: out.mode, ...(out.sha256 ? { sha256: out.sha256 } : {}), ...(out.target ? { target: out.target } : {}) };
}

/** How long ago the file at `path` changed (tests, diagnostics). */
export function ctimeNs(path) {
  return statSync(path, { bigint: true }).ctimeNs;
}
