/**
 * What a with arm's run record says about Mycelink itself.
 *
 * Second PCM-101 pilot: with-normal failed only because a node's history was
 * test-after, and with-faults' resume session exited 0 with a node at
 * REGRESSION_VERIFIED, no candidate and no delivery. Both were found only
 * by the verifier, later, as generic delivery failures. The run record now
 * names, from the control repository: refused histories, settlements a
 * later session resumed, recovered controller keys, and whether the feature
 * was complete when the last session ended. A with-arm session that exited
 * 0 with the feature incomplete is an explicit controller failure, and each
 * worker summary names its node and how its submission was settled.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { controllerFailures, controllerReport, mycelinkSummary, runVerdict, workerSummaries } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const F = 'PCM-101';
const GW = `${F}.petclinic.gateway-vetname.impl`;
const VISITS = `${F}.petclinic.visits-vet.impl`;

function control(state: Record<string, unknown>, events: Record<string, unknown>[], authority: Record<string, unknown> | null = null): string {
  const root = makeTmpDir('obs-control-');
  writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
  const dir = join(root, 'features', F);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'STATE.json'), JSON.stringify({ revision: 1, data: state }));
  writeFileSync(join(dir, 'events.jsonl'), events.map((e, i) => JSON.stringify({ seq: i + 1, ...e })).join('\n') + '\n');
  if (authority !== null) {
    mkdirSync(join(root, '.mycelink'), { recursive: true });
    writeFileSync(join(root, '.mycelink', 'controller-authority.json'), JSON.stringify(authority));
  }
  return root;
}

const incomplete = {
  feature_state: 'RUNNING',
  current_candidate: null,
  nodes: { [VISITS]: { state: 'DONE' }, [GW]: { state: 'REGRESSION_VERIFIED' } },
};
const complete = {
  feature_state: 'COMPLETED',
  current_candidate: `${F}-C001`,
  accepted_deliveries: { [`${F}-C001`]: 'a'.repeat(64) },
  nodes: { [VISITS]: { state: 'DONE' }, [GW]: { state: 'DONE' } },
};

describe('the Mycelink summary of a with arm', () => {
  it('names refused histories, resumed settlements and recovered keys, and whether the feature is complete', () => {
    const root = control(complete, [
      { type: 'node.tdd_rejected', node_id: GW, data: { code: 'TEST_AFTER', commit: 'b'.repeat(40), head_sha: 'b'.repeat(40), archived_ref: 'refs/x' } },
      { type: 'settlement.resumed', node_id: GW, data: { from_state: 'REGRESSION_VERIFIED', by: 'resume', sealed: false } },
      { type: 'node.settled', node_id: GW, data: { claim_id: 'c2', outcome: 'DONE', state: 'DONE' } },
    ], { recovered: true });
    expect(mycelinkSummary({ control: root, featureId: F })).toEqual({
      feature_id: F,
      initialised: true,
      complete: true,
      candidate: `${F}-C001`,
      incomplete: [],
      tdd_rejections: [{ node_id: GW, code: 'TEST_AFTER', commit: 'b'.repeat(40) }],
      resumed_settlements: [{ node_id: GW, from_state: 'REGRESSION_VERIFIED', by: 'resume' }],
      authority_recovered: true,
    });
  });

  it('lists why a feature is incomplete; no control repository is not a Mycelink run', () => {
    const s = mycelinkSummary({ control: control(incomplete, []), featureId: F });
    expect(s.complete).toBe(false);
    expect(s.incomplete).toEqual([`node ${GW} is REGRESSION_VERIFIED`, 'no current candidate', 'no accepted delivery']);
    expect(mycelinkSummary({ control: join(makeTmpDir('obs-none-'), 'platform'), featureId: F })).toBeNull();
  });

  it('a control repository whose feature was never initialised says so, and whether a key was recovered (CSET-203 r9)', () => {
    const root = makeTmpDir('obs-uninit-');
    writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
    mkdirSync(join(root, '.mycelink'), { recursive: true });
    writeFileSync(join(root, '.mycelink', 'controller-authority.json'), JSON.stringify({ recovered: true }));
    expect(mycelinkSummary({ control: root, featureId: F })).toEqual({
      feature_id: F,
      initialised: false,
      complete: false,
      candidate: null,
      incomplete: ['the feature was never initialised: no STATE.json'],
      tdd_rejections: [],
      resumed_settlements: [],
      authority_recovered: true,
    });
  });
});

describe('a with arm that exits 0 incomplete is a controller failure', () => {
  const resumeExit0 = [
    { index: 1, purpose: 'task', ended_by: 'interrupt', exit_code: null },
    { index: 2, purpose: 'resume', ended_by: 'exit', exit_code: 0 },
  ];
  const summary = mycelinkSummary({ control: control(incomplete, []), featureId: F });

  it('names the session and what was missing', () => {
    expect(controllerFailures({ arm: 'with', phases: [{ phase: 'task', sessions: resumeExit0, mycelink: summary }] })).toEqual([
      `exited-incomplete: session 2 (resume) exited 0 with ${F} incomplete: node ${GW} is REGRESSION_VERIFIED; no current candidate; no accepted delivery`,
    ]);
  });

  it('is not raised for a complete feature, a session ended by the harness, or the without arm', () => {
    const done = mycelinkSummary({ control: control(complete, []), featureId: F });
    expect(controllerFailures({ arm: 'with', phases: [{ phase: 'task', sessions: resumeExit0, mycelink: done }] })).toEqual([]);
    expect(controllerFailures({ arm: 'with', phases: [{ phase: 'task', sessions: [{ index: 1, purpose: 'task', ended_by: 'budget', exit_code: null }], mycelink: summary }] })).toEqual([]);
    expect(controllerFailures({ arm: 'without', phases: [{ phase: 'task', sessions: resumeExit0, mycelink: null }] })).toEqual([]);
  });

  it('a with arm that never set up Mycelink and exited 0 is a controller failure too', () => {
    expect(controllerFailures({ arm: 'with', phases: [{ phase: 'task', sessions: resumeExit0, mycelink: null }] })).toEqual(['exited-incomplete: session 2 (resume) exited 0 with no Mycelink feature state']);
  });

  it('judges each phase by how it left the feature: a task that delivered C001 is no failure, a rework that exits 0 with C001 stale is', () => {
    const delivered = { ...mycelinkSummary({ control: control(complete, []), featureId: F }), complete: true };
    // The third pilot's with-faults arm: the late defect moved main past C001, and a rework that ended on its own never cut C002.
    const stale = { ...delivered, complete: false, incomplete: [`candidate ${F}-C001 binds spring-petclinic-microservices at e7ddf4907bb8, main is at aa476dadabe0`] };
    const phases = [
      { phase: 'task', sessions: [{ index: 1, purpose: 'task', ended_by: 'exit', exit_code: 0 }], mycelink: delivered },
      {
        phase: 'rework',
        sessions: [
          { index: 2, purpose: 'rework', ended_by: 'interrupt', exit_code: null },
          { index: 3, purpose: 'rework-resume', ended_by: 'exit', exit_code: 0 },
        ],
        mycelink: stale,
      },
    ];
    expect(controllerFailures({ arm: 'with', phases })).toEqual([
      `exited-incomplete: session 3 (rework-resume) exited 0 with ${F} incomplete: candidate ${F}-C001 binds spring-petclinic-microservices at e7ddf4907bb8, main is at aa476dadabe0`,
    ]);
    // A rework the harness ended (its budget) is not the controller's choice.
    const ended = [phases[0], { ...phases[1], sessions: [phases[1]!.sessions[0], { index: 3, purpose: 'rework-resume', ended_by: 'budget', exit_code: null }] }];
    expect(controllerFailures({ arm: 'with', phases: ended })).toEqual([]);
  });

  it('the run verdict puts it first among the delivery failures, even when the verifier missed it', () => {
    const confined = { kind: 'bubblewrap', enforced: true, preflight: { ok: true, checks: [] } };
    const record = { isolation: confined, sessions: [{ confined: true, survivors: [] }], evaluator_access: { hits: [], probes: [] }, plugin_exposure: [], controller: { ok: false, failures: ['exited-incomplete: session 2 (resume) exited 0'] } };
    const verification = { ok: true, trusted: true, trust: { isolation: true }, errors: [], sections: {} };
    expect(runVerdict({ record, verification })).toMatchObject({ verdict: 'delivery-failed', trust: { ok: true }, delivery: { ok: false, failures: ['controller:exited-incomplete: session 2 (resume) exited 0'] } });
  });
});

/**
 * A with-arm controller that changes the workspace itself (CSET-203 r9, the
 * fourth pilot): the violation is what the session left that no one
 * authorised, rolled back by the harness (lib/controller-txn.mjs). The
 * record names it by path and kind, how it was rolled back and verified,
 * the session that recovered it — a corrective session that completed the
 * feature through Mycelink — or why the phase ended.
 */
describe('a with-arm controller that changes the workspace itself is a controller failure, unless a corrective session recovers it', () => {
  const delivered = { feature_id: F, initialised: true, complete: true, candidate: `${F}-C001`, incomplete: [], authority_recovered: false };
  const stale = { feature_id: F, initialised: true, complete: false, candidate: `${F}-C001`, incomplete: [`candidate ${F}-C001 binds x at 035c1fc8a067, main is at b72b5e404a49`], authority_recovered: false };
  const task = { phase: 'task', sessions: [{ index: 1, purpose: 'task', ended_by: 'exit', exit_code: 0 }], mycelink: delivered };
  const violation = (summary: string[], extra: Record<string, unknown> = {}) => ({ fingerprint: 'f'.repeat(64), summary, mode: 'selective', verified: true, manifest_sha256: 'm'.repeat(64), discarded: [], ...extra });
  const REVERT = ['repos/x/.git:refs/heads/main (moved from 035c1fc8a067 to 9f1e2d3c4b5a; a product repository’s ref)', 'repos/x/src/T.java (modified; a product repository’s file)'];

  it('names what it changed, that it was stopped, how it was rolled back, and the failure', () => {
    const rework = { index: 2, purpose: 'rework', ended_by: 'controller-violation', exit_code: null, violation: violation(REVERT), terminal: 'identical-violation' };
    const report = controllerReport({ arm: 'with', phases: [task, { phase: 'rework', sessions: [rework], mycelink: stale }] });
    expect(report.failures).toEqual([
      `controller-violation: session 2 (rework) changed the workspace itself: ${REVERT[0]}, and 1 more; stopped there; rolled back (selective, verified). The phase ended: the same violation as before. With Mycelink the controller reworks the producer node and a module-worker repairs it`,
    ]);
    expect(report.violations).toEqual([{ session: 2, purpose: 'rework', fingerprint: 'f'.repeat(64), summary: REVERT, mode: 'selective', verified: true, manifest_sha256: 'm'.repeat(64), discarded: [], recovered_by: null, terminal: 'identical-violation' }]);
  });

  it('one the session left when it ended on its own is the failure too, before the incomplete feature it left', () => {
    const rework = { index: 2, purpose: 'rework', ended_by: 'exit', exit_code: 0, violation: violation([REVERT[1] as string], { mode: 'full' }) };
    expect(controllerFailures({ arm: 'with', phases: [task, { phase: 'rework', sessions: [rework], mycelink: stale }] })).toEqual([
      `controller-violation: session 2 (rework) changed the workspace itself: ${REVERT[1]}; the session had ended; rolled back (full, verified). With Mycelink the controller reworks the producer node and a module-worker repairs it`,
      `exited-incomplete: session 2 (rework) exited 0 with ${F} incomplete: candidate ${F}-C001 binds x at 035c1fc8a067, main is at b72b5e404a49`,
    ]);
    // The control arm's sessions change product code by design.
    expect(controllerFailures({ arm: 'without', phases: [{ phase: 'rework', sessions: [rework], mycelink: null }] })).toEqual([]);
  });

  it('a violation a corrective session recovered — through Mycelink, to a complete feature — stays on the record, not a failure', () => {
    const violating = { index: 2, purpose: 'rework', ended_by: 'controller-violation', exit_code: null, violation: violation(REVERT) };
    const corrective = { index: 3, purpose: 'rework-corrective', corrects: 2, ended_by: 'exit', exit_code: 0, violation: null };
    const c002 = { feature_id: F, initialised: true, complete: true, candidate: `${F}-C002`, incomplete: [], authority_recovered: true };
    const phases = [task, { phase: 'rework', sessions: [violating, corrective], mycelink: c002 }];
    const report = controllerReport({ arm: 'with', phases });
    expect(report).toMatchObject({
      ok: true,
      failures: [],
      recovered: [`controller-violation: session 2 (rework) changed the workspace itself: ${REVERT[0]}, and 1 more; stopped there; rolled back (selective, verified). Recovered by session 3 (rework-corrective), which completed it through Mycelink to ${F}-C002`],
      authority_recovered: true,
    });
    expect(report.violations[0].recovered_by).toBe(3);
    // A corrective session that violates again recovers nothing: both fail the run.
    const again = { ...corrective, ended_by: 'controller-violation', exit_code: null, violation: violation(['repos/x/src/U.java (created; a product repository’s file)'], { fingerprint: 'e'.repeat(64) }), terminal: 'corrective-limit' };
    const failed = controllerReport({ arm: 'with', phases: [task, { phase: 'rework', sessions: [violating, again], mycelink: stale }] });
    expect(failed.ok).toBe(false);
    expect(failed.recovered).toEqual([]);
    expect(failed.failures).toEqual([
      expect.stringMatching(/^controller-violation: session 2 \(rework\) changed the workspace itself: /),
      expect.stringMatching(/^controller-violation: session 3 \(rework-corrective\) changed the workspace itself: repos\/x\/src\/U\.java .*; stopped there; rolled back \(selective, verified\)\. The phase ended: no corrective session is left\./),
    ]);
    // One that exits 0 without C002 recovers nothing either.
    const incomplete = controllerReport({ arm: 'with', phases: [task, { phase: 'rework', sessions: [violating, corrective], mycelink: stale }] });
    expect(incomplete.recovered).toEqual([]);
    expect(incomplete.failures).toEqual([expect.stringMatching(/^controller-violation: session 2 \(rework\)/), expect.stringMatching(/^exited-incomplete: session 3 \(rework-corrective\) exited 0/)]);
    // A rollback that could not be verified is never recovered.
    const unverified = controllerReport({ arm: 'with', phases: [task, { phase: 'rework', sessions: [{ ...violating, violation: violation(REVERT, { verified: false }), terminal: 'rollback-unverified' }], mycelink: stale }] });
    expect(unverified.failures[0]).toMatch(/rolled back \(selective, not verified\)\. The phase ended: the rollback could not be verified, so no session started on it\./);
    // The verdict: the recovered violation is no delivery failure; the record keeps it.
    const confined = { kind: 'bubblewrap', enforced: true, preflight: { ok: true, checks: [] } };
    // Its rollback attested afterwards (lib/controller-txn.mjs attestRollbacks): the manifest it names, nothing left.
    const controller_rollbacks = { ok: true, problems: [], sessions: [{ session: 2, ok: true, mode: 'selective', manifest_sha256: 'm'.repeat(64), checked: 2 }] };
    const record = { isolation: confined, sessions: [{ confined: true, survivors: [] }], evaluator_access: { hits: [], probes: [] }, plugin_exposure: [], controller: report, controller_rollbacks };
    const verification = { ok: true, trusted: true, trust: { isolation: true }, errors: [], sections: {} };
    expect(runVerdict({ record, verification })).toMatchObject({ verdict: 'verified', delivery: { ok: true, failures: [], recovered: report.recovered } });
    // Unattested, the same record is untrusted.
    expect(runVerdict({ record: { ...record, controller_rollbacks: undefined }, verification })).toMatchObject({ verdict: 'untrusted', trust: { problems: [expect.stringMatching(/^controller rollback: session 2's rollback was never attested/)] } });
  });

  it('a feature never initialised is named so, with the violation and its rollback first — never only the verifier’s count (CSET-203 r9)', () => {
    const none = { feature_id: F, initialised: false, complete: false, candidate: null, incomplete: ['the feature was never initialised: no STATE.json'], authority_recovered: true };
    const sessions = [
      { index: 1, purpose: 'task', ended_by: 'controller-violation', exit_code: null, violation: violation(['platform/features/F/ACCEPTANCE.json (created; a Mycelink-managed file)']) },
      { index: 2, purpose: 'corrective', corrects: 1, ended_by: 'exit', exit_code: 0, violation: null },
    ];
    const report = controllerReport({ arm: 'with', phases: [{ phase: 'task', sessions, mycelink: none }] });
    expect(report.failures).toEqual([
      expect.stringMatching(/^controller-violation: session 1 \(task\) changed the workspace itself: platform\/features\/F\/ACCEPTANCE\.json .*rolled back \(selective, verified\)\./),
      `exited-incomplete: session 2 (corrective) exited 0 with ${F} never initialised (no STATE.json)`,
    ]);
    const confined = { kind: 'bubblewrap', enforced: true, preflight: { ok: true, checks: [] } };
    const record = { isolation: confined, sessions: [{ confined: true, survivors: [] }], evaluator_access: { hits: [], probes: [] }, plugin_exposure: [], controller: report };
    const verification = { ok: false, trusted: true, trust: { isolation: true }, errors: [], sections: { orchestration: { ok: false, required: true, checks: [{ id: 'feature-initialised', ok: false, detail: '0 feature(s) with STATE.json' }] } } };
    const verdict = runVerdict({ record, verification });
    expect(verdict.delivery.failures[0]).toMatch(/^controller:controller-violation: session 1/);
    expect(verdict.delivery.failures).toContain('orchestration:feature-initialised (0 feature(s) with STATE.json; the controller’s own changes were rolled back in session 1 and the feature was never initialised after them)');
  });
});

describe('worker summaries name their node and its settlement', () => {
  it('reads the node, claim and dispatch from the ticket prompt and the settle outcome from the events', () => {
    const dir = makeTmpDir('obs-workers-');
    const file = join(dir, 'subagents', 'agent-1.jsonl');
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    const prompt = `You are the Mycelink module-worker...\n\nNode: ${GW}\nFeature: ${F}\nClaim: c1\nDispatch: d1\n`;
    writeFileSync(file, [JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node m.mjs tdd red PCM-101 x' } }] } })].join('\n'));
    const events = [{ type: 'node.settled', node_id: GW, data: { claim_id: 'c1', outcome: 'TDD_HISTORY_INVALID', state: 'READY' } }];
    expect(workerSummaries([file], events)).toEqual([
      expect.objectContaining({ node_id: GW, claim_id: 'c1', dispatch_id: 'd1', settlement: 'TDD_HISTORY_INVALID', gates: { red: 1, green: 0, regression: 0 } }),
    ]);
    // Without events (or a transcript with no ticket), nothing is guessed.
    expect(workerSummaries([file])[0]).toMatchObject({ node_id: GW, settlement: null });
  });
});
