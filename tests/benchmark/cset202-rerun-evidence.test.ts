/**
 * The CSET-202 rerun's own state, repaired on a copy (engine/evidence-integrity.ts).
 *
 * MYCELINK_CSET202_RERUN names the preserved run directory (WSL:
 * ~/mycelink-pilot-results/CSET-202-rerun/with-normal). Nothing there is
 * written: the parts the repair reads are copied to a temporary workspace —
 * the control repository without its worktrees, the product repository
 * without its node_modules and its worktree registrations — and every file of
 * the original that is read is fingerprinted before and after. Run it under a
 * read-only bind of the original (bubblewrap) for a guarantee the fingerprint
 * only checks.
 *
 *  1. The state as the run left it (after the harness's wrongful product
 *     rework): the stale pointers it holds — generation 1's kept RED, named
 *     on a canonical log the second red gate overwrote; generation 0's
 *     completions' judged history, named on a canonical file generation 1
 *     overwrote; generation 0's restorable records — are each restored from
 *     an exact archive their own records attest (a dry run first, writing
 *     nothing), once, nothing about the product changed; the cli stays where
 *     the wrongful rework left it, a person's decision.
 *  2. The state at the moment delivery refused C001, rebuilt exactly from the
 *     run's provenance store (every file a run process wrote after the
 *     refusal restored to its bytes then): the refusal reproduced, then
 *     deliver itself repairs the pointers and delivers C001 — accepted by
 *     the repository's full suite on a clean checkout set up offline from
 *     the run's own store — under the same candidate, R002 still binding it,
 *     nothing reopened.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { referenceProblems, repairEvidence } from '../../src/engine/evidence-integrity.js';
import { featureDeliveryProblems, featureVerifyProblems } from '../../src/engine/feature-verify.js';
import { deliverFeature } from '../../src/engine/deliver.js';
import { reviewGateProblems } from '../../src/engine/acceptance-review.js';
import { loadCandidate } from '../../src/git/candidate.js';
import { loadState } from '../../src/state/feature-state.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { readRegular } from '../../src/security/paths.js';

afterAll(() => cleanupTmpRoots());

const RUN = process.env.MYCELINK_CSET202_RERUN ?? '';
const F = 'CSET-202';
const CLI = 'CSET-202.changesets.cli.impl';
const EVIDENCE = `features/${F}/evidence/${CLI}`;
/** STATE.json when delivery refused C001 (the run's provenance store keeps every version). */
const STATE_AT_REFUSAL = '3057be57f651688966f22965a1de1086702fa1872edf696353b3edef8b8062a0';
const REFUSED_AT = '2026-10-11T15:25:11.100Z';

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The parts of the run the repair reads: control repository (no worktrees), product repository (no node_modules, no worktree registrations). */
const SKIP = [/^workspace\/platform\/\.mycelink\/(worktrees|integration)(\/|$)/, /(^|\/)node_modules(\/|$)/, /^workspace\/repos\/changesets\/\.git\/worktrees(\/|$)/];
const skipped = (rel: string): boolean => SKIP.some((rx) => rx.test(rel));

function* files(root: string, dir = root): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = relative(root, p).replace(/\\/g, '/');
    if (skipped(rel)) continue;
    const st = lstatSync(p);
    if (st.isDirectory()) yield* files(root, p);
    else yield p;
  }
}

/** Every file of the original the test reads, by path, size, time and bytes. */
function fingerprint(run: string): string {
  const h = createHash('sha256');
  for (const part of ['workspace/platform', 'workspace/repos/changesets/.git', 'home/.mycelink-provenance/ledger.jsonl']) {
    const at = join(run, part);
    if (!existsSync(at)) continue;
    const list = lstatSync(at).isDirectory() ? [...files(run, at)] : [at];
    for (const f of list) {
      const st = lstatSync(f);
      // A file's bytes through one descriptor (src/security/paths.ts): what was looked at is what is hashed.
      h.update(`${relative(run, f)}\u0000${st.size}\u0000${st.mtimeMs}\u0000${st.isFile() ? sha256(readRegular(f)?.bytes ?? Buffer.from('changed')) : 'link'}\n`);
    }
  }
  return h.digest('hex');
}

/** A copy of the run's workspace to repair. */
function copyRun(run: string): { root: string; control: string } {
  const root = makeTmpDir('cset202-rerun-');
  cpSync(join(run, 'workspace'), join(root, 'workspace'), { recursive: true, verbatimSymlinks: true, filter: (src) => !skipped(`workspace/${relative(join(run, 'workspace'), src).replace(/\\/g, '/')}`.replace(/\/$/, '')) });
  return { root, control: join(root, 'workspace', 'platform') };
}

/**
 * Put every file a run process wrote after `at` back to what it held then — from the run's provenance store, which
 * keeps every version — and remove what did not exist yet. Only the copy is written.
 */
function rollBack(run: string, copy: string, at: string): string[] {
  const ledger = readFileSync(join(run, 'home', '.mycelink-provenance', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; t: string; states?: { path: string; state: { t: string; sha256?: string } }[] });
  const T = BigInt(Date.parse(at)) * 1_000_000n;
  const base = join(run, 'workspace').replace(/\\/g, '/');
  const before = new Map<string, { t: string; sha256?: string }>();
  const after = new Set<string>();
  for (const e of ledger) {
    if (e.kind !== 'done') continue;
    for (const s of e.states ?? []) {
      if (!s.path.startsWith(`${base}/`)) continue;
      const rel = `workspace/${s.path.slice(base.length + 1)}`;
      if (skipped(rel) || /\.tmp-|\.lock$|\.tmp$/.test(rel)) continue;
      if (BigInt(e.t) <= T) before.set(rel, s.state);
      else after.add(rel);
    }
  }
  const restored: string[] = [];
  for (const rel of [...after].sort()) {
    const was = before.get(rel);
    const target = join(copy, ...rel.split('/'));
    if (was === undefined || was.t === 'absent') {
      if (existsSync(target) && lstatSync(target).isFile()) rmSync(target, { force: true });
      continue;
    }
    if (was.t !== 'f' || was.sha256 === undefined) continue;
    const object = join(run, 'home', '.mycelink-provenance', 'objects', was.sha256.slice(0, 2), was.sha256);
    expect(existsSync(object), `${rel} at ${at} is not kept in the run's provenance store`).toBe(true);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(object));
    restored.push(rel);
  }
  // Directories created after the moment and left empty (the replaced generation the wrongful rework archived).
  rmSync(join(copy, 'workspace', 'platform', ...`${EVIDENCE}/replaced/g2`.split('/')), { recursive: true, force: true });
  return restored;
}

/**
 * A home for the acceptance's offline setup: the run's pnpm content store (its files read-only, linked, as the run
 * bound them), its store index, corepack cache and pnpm configuration copied — nothing of the run written.
 */
function homeLike(run: string): string {
  const from = join(run, 'home');
  const home = makeTmpDir('cset202-rerun-home-');
  const store = join(home, '.local', 'share', 'pnpm', 'store', 'v11');
  mkdirSync(store, { recursive: true });
  symlinkSync(join(from, '.local', 'share', 'pnpm', 'store', 'v11', 'files'), join(store, 'files'), 'dir');
  for (const name of ['index.db', 'projects']) cpSync(join(from, '.local', 'share', 'pnpm', 'store', 'v11', name), join(store, name), { recursive: true });
  cpSync(join(from, '.cache', 'node', 'corepack'), join(home, '.cache', 'node', 'corepack'), { recursive: true });
  cpSync(join(from, '.config'), join(home, '.config'), { recursive: true });
  return home;
}

function product(control: string): Record<string, unknown> {
  const s = loadState(featurePaths(control, F).featureDir)!.data;
  return {
    nodes: Object.fromEntries(Object.entries(s.nodes).map(([id, rt]) => [id, { state: rt.state, attempts: rt.attempts, failure_counts: rt.failure_counts, integrated: rt.integrated_sha, ledger: rt.criterion_ledger ?? null, brief: rt.rework_brief ?? null }])),
    decisions: s.pending_decisions,
    reworks: s.reworks ?? [],
    epoch: s.orchestration?.epoch ?? null,
    candidate: s.current_candidate,
    reviews: (s.acceptance_review?.reviews ?? []).map((r) => [r.review_id, r.overall, r.epoch]),
  };
}

describe.skipIf(RUN === '' || !existsSync(join(RUN, 'workspace', 'platform', 'features', F, 'STATE.json')))('the CSET-202 rerun, repaired on a copy', () => {
  it('the state as the run left it: every stale pointer restored from an exact archive its records attest, once; nothing about the product changed; the original untouched', () => {
    const original = fingerprint(RUN);
    const copy = copyRun(RUN);
    const featureDir = featurePaths(copy.control, F).featureDir;
    const pristine = [...files(copy.root)].map((f) => `${relative(copy.root, f)} ${sha256(readFileSync(f))}`).join('\n');

    const plan = repairEvidence(copy.control, F, { dryRun: true });
    // A dry run writes nothing at all.
    expect([...files(copy.root)].map((f) => `${relative(copy.root, f)} ${sha256(readFileSync(f))}`).join('\n')).toBe(pristine);
    // Generation 1's kept RED (the first of its two red gates): on the canonical log the second run overwrote, restored
    // from the red gate's own snapshot of that run, attested by generation 1's binding.
    const red = plan.planned.find((p) => p.refs.includes(`node:${CLI}:rework:1:evidence:red`));
    expect(red, JSON.stringify(plan.planned, null, 1)).toMatchObject({
      from_path: `${EVIDENCE}/${CLI}.red.log`,
      sha256: '1c1b66fdd76c802a48b399fcf3370e7e36fe0cdbdc29a28b7e623c4a34ffdc7d',
      source: { kind: 'challenge-snapshot', path: `${EVIDENCE}/challenge-red/1c1b66fdd76c802a/gate/red.log` },
    });
    // Generation 0's completions name its judged history on the canonical file generation 1 overwrote: restored from the
    // copy generation 1's rework archived, attested by that rework (sealed records: the repair stands for their path).
    const history = plan.planned.find((p) => p.refs.some((k) => k === `node:${CLI}:ledger:CC-f964069dd28e75f2:history`));
    expect(history).toMatchObject({
      from_path: `${EVIDENCE}/${CLI}.tdd-history.json`,
      sha256: '99b6a7f79d3ca8dd3534e5ad9157d9ae44bbfc6b24b5858030455ac809fd29b0',
      source: { kind: 'replaced-generation', path: `${EVIDENCE}/replaced/g1/${CLI}.tdd-history.json` },
    });
    expect(history!.refs).toEqual(expect.arrayContaining([`node:${CLI}:ledger:CC-f32eb1e695d85906:history`]));
    // Nothing the delivered state would stand on is beyond repair.
    expect(plan.unrepairable.filter((u) => u.live)).toEqual([]);

    const before = product(copy.control);
    const done = repairEvidence(copy.control, F, { mark: true });
    expect(done.repaired.map((r) => r.repair_id).sort()).toEqual(plan.planned.map((p) => p.repair_id).sort());
    expect(done.required).toBe(false);
    const state = loadState(featureDir)!.data;
    expect(referenceProblems(copy.control, F, state).filter((p) => p.repairable)).toEqual([]);
    expect(state.nodes[CLI]!.rework_history![1]!.evidence.red).toMatchObject({ output_sha256: '1c1b66fdd76c802a48b399fcf3370e7e36fe0cdbdc29a28b7e623c4a34ffdc7d', output_path: expect.stringMatching(/\/repaired\//) });
    // Once: a second run binds nothing new.
    expect(repairEvidence(copy.control, F, { mark: true }).repaired).toEqual([]);
    // Nothing about the product: every node, attempt, failure, completion, brief, decision, rework, the epoch, the reviews.
    expect(product(copy.control)).toEqual(before);
    expect(state.nodes[CLI]!.state).toBe('NEEDS_DECISION');
    expect(fingerprint(RUN)).toBe(original);
  });

  it('the state at the refusal, rebuilt from the provenance store: the refusal reproduced, then deliver repairs C001 itself and delivers it, accepted, under the same candidate, R002 still binding it, nothing reopened', () => {
    const original = fingerprint(RUN);
    const copy = copyRun(RUN);
    const featureDir = featurePaths(copy.control, F).featureDir;
    const restored = rollBack(RUN, copy.root, REFUSED_AT);
    expect(restored).toContain(`workspace/platform/features/${F}/STATE.json`);
    expect(sha256(readFileSync(join(featureDir, 'STATE.json')))).toBe(STATE_AT_REFUSAL);
    // The bytes the canonical names held then: the second red gate's.
    expect(sha256(readFileSync(join(copy.control, ...`${EVIDENCE}/${CLI}.red.log`.split('/'))))).toBe('9648854194e95de42e51ddff4ba9153abafaee8b3fdb0d08f076f6b2d5e9446e');

    const refused = featureVerifyProblems(copy.control, F);
    expect(refused).toContain(`OUTPUT_HASH_MISMATCH: ${CLI} red ${EVIDENCE}/${CLI}.red.log hashes to 9648854194e9, record says 1c1b66fdd76c`);
    const state0 = loadState(featureDir)!.data;
    expect(state0.current_candidate).toBe('CSET-202-C001');
    const before = product(copy.control);

    // A dry run says what delivery will restore, writing nothing.
    const plan = repairEvidence(copy.control, F, { dryRun: true });
    expect(plan.unrepairable.filter((u) => u.live)).toEqual([]);
    const red = plan.planned.find((r) => r.from_path === `${EVIDENCE}/${CLI}.red.log` && r.sha256.startsWith('1c1b66fdd76c'));
    expect(red).toMatchObject({ source: { kind: 'challenge-snapshot', path: `${EVIDENCE}/challenge-red/1c1b66fdd76c802a/gate/red.log` } });
    const results = plan.planned.find((r) => r.from_path === `${EVIDENCE}/${CLI}.red.results.json`);
    expect(results).toMatchObject({ source: { kind: 'challenge-snapshot', path: `${EVIDENCE}/challenge-red/1c1b66fdd76c802a/gate/red.results.json` } });

    // C001 delivered by deliver itself: the repair first, then every check, the fast-forward and the final acceptance —
    // the repository's full suite on a clean checkout set up offline from the run's own pnpm store (read-only, as in the run).
    const candidate = loadCandidate(featureDir, 'CSET-202-C001');
    const home = homeLike(RUN);
    // The run's sessions had the benchmark's git identity (lib/arms.mjs sessionEnv): the suite's own git fixtures commit and tag.
    const identity = { GIT_AUTHOR_NAME: 'Benchmark Agent', GIT_AUTHOR_EMAIL: 'agent@benchmark.invalid', GIT_COMMITTER_NAME: 'Benchmark Agent', GIT_COMMITTER_EMAIL: 'agent@benchmark.invalid' };
    const saved: Record<string, string | undefined> = Object.fromEntries(['HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', ...Object.keys(identity)].map((k) => [k, process.env[k]]));
    process.env['HOME'] = home;
    Object.assign(process.env, identity);
    for (const k of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']) delete process.env[k];
    let delivered;
    try {
      delivered = deliverFeature(copy.control, F);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const log = (a: { output_path: string }): string => readFileSync(join(copy.control, ...a.output_path.split('/')), 'utf8').slice(-4000);
    expect(delivered.acceptance.map((a) => [a.repository, a.exit_code]), delivered.acceptance.map(log).join('\n')).toEqual([['changesets', 0]]);
    expect(delivered).toMatchObject({ ok: true, status: 'ACCEPTED', candidate_id: 'CSET-202-C001' });
    const after = loadState(featureDir)!.data;
    expect((after.evidence_repairs ?? []).map((r) => r.repair_id).sort()).toEqual(plan.planned.map((p) => p.repair_id).sort());
    expect(after.feature_state).toBe('COMPLETED');
    // The same candidate, its repositories as cut, R002 the PASS that binds them; nothing reopened, rerun or charged.
    expect(featureVerifyProblems(copy.control, F)).toEqual([]);
    expect(featureDeliveryProblems(copy.control, F)).toEqual([]);
    const targets = Object.fromEntries(Object.entries(candidate.repositories).map(([n, r]) => [n, r.sha]));
    expect(reviewGateProblems(copy.control, F, { candidateRepositories: targets })).toEqual([]);
    expect(product(copy.control)).toEqual(before);
    expect(fingerprint(RUN)).toBe(original);
  }, 590_000);
});
