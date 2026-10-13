# Mycelink public-project benchmark: final 12-arm matrix

Date: 2026-10-12
Branch: `eval/public-project-benchmark`
Final suite HEAD: `d2963b225b6ab1cfd28bc26ac04ad1c48034e990`. Every suite commit below is an
ancestor of it. The commit that adds this report is documentation only.
Status: clean working tree. No upstream is configured and no remote branch holds the commits.
Nothing was pushed or published.

This report reads only the run records and the independent verifier records. They live on the
WSL evaluation host under one results root, whose location on that host is not published:

```text
RESULTS=/path/to/mycelink-pilot-results
```

All paths below are relative to `$RESULTS`. No model pilot was run while preparing this report,
and no product, core or test file was changed.

## Verdict: GO, with the limitations below

All 12 cells of the matrix (6 PRDs × normal/fault, Mycelink `with` arm) have a delivery that is:

- **verified and trusted** by the run's own record (`run.json`: `verdict: verified`, `ok`,
  `trusted`, `verified`). The one exception is CSET-203 normal, whose run record is empty
  (see [the CSET-203 r16 caveat](#the-cset-203-r16-normal-caveat));
- **independently verified** by `tools/verify-run.mjs`, with `ok: true`, `trusted: true` and
  `errors: []`. TDD and orchestration are `required: true` in every record, as
  `--require-tdd --require-mycelink` set them, and each fault arm's record has a `faults` section
  from `--faults`. Every verifier section passed: identity, hygiene, scope, leakage, harness,
  regression, acceptance (hidden tests), TDD replay, orchestration, integrity, and faults where
  applicable. The trust flags `isolation`, `suite_pinned` and `qualification_filesystems` are all
  true, and the suite checkout was clean;
- **bound to Mycelink's accepted candidate**. The verifier's `candidate-equals-delivery` and
  `delivery-accepted` checks pass, and the delivered HEAD equals the expected SHA in every cell.

The verdict is GO for "the public-project matrix is complete and every cell is independently
verified". It is not a claim that one build delivered all 12 cells. Only 6 of the 12 arms ran
on the final suite HEAD (see [Suite commits](#suite-commits-used-by-the-arms)).

## The matrix

`suite` is the commit both the run and its independent verifier were pinned to. For CSET-203
normal, only the verifier's pin is recorded; see the caveat. Tests are the
verifier's counts: the trusted full regression suite, the hidden acceptance tests, the delivery's
own tests, and the red-green units the TDD replay credited.

| PRD | Cond. | Run directory | Verifier record | Suite | Candidate | Delivered SHA | Regr. / hidden / own tests, TDD units |
|---|---|---|---|---|---|---|---|
| CSET-201 | normal | `CSET-201-rerun/with-normal` | `CSET-201-rerun-verify.json` | `f4b020c` | CSET-201-C001 | `6a932254d1562adf6797fc9544f9b6042f1c0008` | 818 / 18 / 22, 7 |
| CSET-201 | fault | `CSET-201-final/with-fault` | `CSET-201-final-fault-verify.json` | `f4b020c` | CSET-201-C002 | `e0c0bf20cb120e4f70d7a3cb0cb3afe261fe2fc0` | 818 / 18 / 22, 8 |
| CSET-202 | normal | `CSET-202-rerun2/with-normal` | `CSET-202-rerun2-verify.json` | `80c6e17` | CSET-202-C001 | `57cc3e8cd3712e6e0b93e6138edccdfe5e789f6c` | 818 / 19 / 16, 4 |
| CSET-202 | fault | `CSET-202-final/with-fault` | `CSET-202-final-fault-verify.json` | `80c6e17` | CSET-202-C002 | `9d826a786fc7d1a49a62ed0315727749eb458bbb` | 818 / 19 / 11, 5 |
| CSET-203 | normal | `CSET-203-r16/with-normal` | `CSET-203-r16-verify.json` | `90d6279` | CSET-203-C001 | `e1eab51c2afc19a76a0c9c7cafd2c649f6e57716` | 818 / 15 / 22, 7 |
| CSET-203 | fault | `CSET-203-r18/with-fault` | `CSET-203-r18-verify.json` | `a67b6cb` | CSET-203-C002 | `5ff0fad113d1b78df3ebc42f53f0c4c40c89c8d4` | 818 / 15 / 11, 5 |
| PCM-101 | normal | `PCM-101-rerun/with-normal` | `PCM-101-rerun-verify.json` | `d2963b2` | PCM-101-C001 | `8994997a66f5a9e24a175109bb16c3feee345404` | 15 / 19 / 8, 3 |
| PCM-101 | fault | `PCM-101-final/with-fault` | `PCM-101-final-fault-verify.json` | `d2963b2` | PCM-101-C002 | `65ab5048bab4e1484bd181dd1282b6eef7017cfd` | 15 / 19 / 25, 7 |
| PCM-102 | normal | `PCM-102-final/with-normal` | `PCM-102-final-normal-verify.json` | `d2963b2` | PCM-102-C001 | `09018d1553be2793f7775995bc98135dbc146192` | 15 / 15 / 9, 3 |
| PCM-102 | fault | `PCM-102-final/with-fault` | `PCM-102-final-fault-verify.json` | `d2963b2` | PCM-102-C002 | `59d777c940110ec9afdade3a5ff4b0086d28fdac` | 15 / 15 / 13, 4 |
| PCM-103 | normal | `PCM-103-final/with-normal` | `PCM-103-final-normal-verify.json` | `d2963b2` | PCM-103-C001 | `5d645fb3c939693bb75880674bc50286607afdae` | 15 / 20 / 9, 3 |
| PCM-103 | fault | `PCM-103-final/with-fault` | `PCM-103-final-fault-verify.json` | `d2963b2` | PCM-103-C002 | `45deebe4b09012ec7c7b4ad9afca21def77ab831` | 15 / 20 / 13, 3 |

Each delivered SHA was cross-checked against the expected value in three places: the verifier's
`evidence.head`, the run's `mycelink.candidate_sha`, and its `mycelink.branch_head`. For CSET-203
normal, the delivery record's `after` and the product repository's `main` stand in for the
missing run record. All of them agree in all 12 cells. Every fault arm delivers its C002
candidate: the late-hidden-defect repair cuts a second candidate after C001.

Other facts that hold in every cell where a run record exists:

- `controller.ok`, no `controller.failures`, and `controller_rollbacks.ok` with no problems;
- `provider.recoveries: 0`, no continuations, and `provider.unavailable: false`;
- `evaluator_access.hits: []` and `plugin_exposure: []`. The proxy allowed only
  `api.anthropic.com:443`. The only denials were blackholed `registry.npmjs.org:443` lookups in the
  Changesets arms;
- the Mycelink artifact was unchanged before and after every CLI call (verifier
  `mycelink_artifact.before/after: true`).

## Suite commits used by the arms

The arms did **not** all run on the final suite HEAD. Each cell's accepted arm is the
verified run that followed the fix for that cell's last failure. Later fixes were not rerun
against cells that had already passed.

| Suite commit | Arms | Plugin package (`zip_sha256`, first 12) |
|---|---|---|
| `90d627994efdce96c095edf50044cccfd01b3532` | CSET-203 normal | `e43bfff20bf2` |
| `a67b6cbf4b1bc36c94390902a94c6f2d9217b630` | CSET-203 fault | `62d32ccbff17` |
| `80c6e17a26d9a3388534f61300aa70e216d6498d` | CSET-202 normal, CSET-202 fault | `302d66a8ddb3` |
| `f4b020cf3c2c50ad47ff86e3268aa27359b437e0` | CSET-201 normal, CSET-201 fault | `e38d3efbf2f0` |
| `d2963b225b6ab1cfd28bc26ac04ad1c48034e990` | PCM-101, PCM-102, PCM-103 (normal and fault) | `abf335fe6f05` |

All five packages report version `0.2.0-beta.1`. The version string does not identify the build;
the package hash does. Each independent verifier ran pinned to the same suite commit as its run.
The exception is CSET-203 normal, whose run record is empty: the r16 fault arm, on the same
commit, records the same package.

## Fault arms: application and recovery

All six fault arms used `fault-plans/default.json`. The verifier's `faults` section is `ok` in
each.

| PRD | concurrent-commit (kept) | duplicate-result | stale-result | late-hidden-defect (kept) | interrupt-restart |
|---|---|---|---|---|---|
| CSET-201 | `9fbaa5b52b63` at 160 s | `CSET-201.types.impl`: STALE_ORCHESTRATION_EPOCH, state unchanged | same node, stale, unchanged | `3379186ff5be` (7 changes) | task (1) killed at 602 s, resume (2) ended by exit |
| CSET-202 | `3408ab9c1611` at 182 s | `changesets.cli.impl`: stale, unchanged | `changesets.errors.impl`: stale, unchanged | `6249853a6584` (1 change) | corrective (2) killed at 602 s, resume (3) ended by exit |
| CSET-203 | `8c143f13fe5f` at 190 s | `cli.recover.impl`: stale, unchanged | `apply.journal.impl`: stale, unchanged | `7510e32e0ce1` (1 change) | task (1) killed at 602 s, resume (2) ended by exit |
| PCM-101 | `3ba8174c7086` at 196 s | **not applied**: "no spent capability among the settles in the transcript" | `visits.vet-id.impl`: stale, unchanged | `3e912815229a` (7 changes) | task (1) killed at 600 s, resume (2) ended by exit |
| PCM-102 | `e10781eb6382` at 352 s | `customers-service.not-found.impl`: stale, unchanged | same node, stale, unchanged | `aebe6b65b877` (2 changes) | corrective (2) killed at 600 s, resume (3) ended by exit |
| PCM-103 | `7b0e50a751ea` at 260 s | `api-gateway.visit-key.impl`: stale, unchanged | `visits-service.idempotency.impl`: stale, unchanged | `0acfad90a2c0` (7 changes) | task (1) killed at 600 s, resume (2) ended by exit |

For each replayed settle, the verifier records `state_before == state_after` and
`state_changed: false`. Each injected commit is bound exactly (parent, tree, changes, identity,
binding hash) and is kept in the delivered history. After each late defect, a `rework` session
ended by exit 0. Acceptance passes again on the C002 candidate.

The PCM-101 fault arm therefore exercised four of the five faults. The duplicate-result fault had
no target: the harness never replays a capability that still holds a live claim, and the
transcript had no spent one. The verifier records this check as passed ("not applied"), not as
evidence of an idempotent second settle.

## Controller recovery

Three arms stopped a session because the controller changed the workspace itself. In each case the
change was rolled back selectively, the rollback was verified, and a corrective session finished
the work through Mycelink:

| Arm | Session 1 change (as recorded) | Recovery |
|---|---|---|
| CSET-202 fault | created `.pnpm-store` (a helper or scratch file in the workspace) and 12 more | rolled back (selective, verified); session 2 (corrective) completed it to CSET-202-C001 |
| PCM-101 normal | created `repos/spring-petclinic-microservices/.git/.probe-<uuid>` (product Git state) and 1 more | rolled back (selective, verified); session 2 (corrective) completed it to PCM-101-C001 |
| PCM-102 fault | created `repos/spring-petclinic-microservices/.git/.probe-<uuid>` | rolled back (selective, verified); session 2 (corrective) completed it to PCM-102-C001 |

In those three arms, and in every fault arm, `controller.authority_recovered` is `true`. In the
four fault arms with no violation (CSET-201, CSET-203, PCM-101 and PCM-103), it reflects the
resume session taking over after the injected interrupt. No arm has a controller failure or an
unverified rollback. In CSET-203 normal, both sessions' controller transactions
(`controller-txn/session-{1,2}/result.json`) record `violation: false`, mode `none`, and no
unauthorized change.

## Refusals that were recovered

- **Invalid reviewer results.** Mycelink refused malformed acceptance-review results as
  `REVIEW_INVALID` and re-ran the review until it produced a valid receipt. Most were
  `REVIEW_TRACE_INCOMPLETE`. CSET-201 fault also had one `REVIEW_VERDICT_INVALID`, and PCM-103
  fault had one `REVIEW_RESULT_INVALID` (R002 answered in prose, after 2 format corrections).
  Refusals per arm, counted from `run.json` `reviewers[].settlement.outcome`:
  CSET-201 3 / 5, CSET-202 1 / 3, CSET-203 – / 0, PCM-101 2 / 4, PCM-102 2 / 3, PCM-103 2 / 3
  (normal / fault; CSET-203 normal has no run record). In every arm the final review is `PASS`
  and the verifier's `acceptance-review` check passes.
- **TDD claim mismatch (PCM-103 fault).** The worker for `PCM-103.api-gateway.visit-key.impl`
  settled as `TDD_HISTORY_INVALID` (gates: red 5, green 3, regression 2), and
  `mycelink.tdd_rejections` records `TDD_CLAIM_MISMATCH`. The node was then resumed from
  `GREEN_VERIFIED` (`resumed_settlements`, by `resume`). The delivered history replays as
  test-first: 3 units, verifier `tdd.ok`.
- **Withdrawn review challenge (CSET-203 normal).** Reviews R001, R002 and R003 found gaps and
  R004 passed. Challenge `CSET-203-R001-C1` was withdrawn: AC-1 and AC-2 were both decided
  `WITHDRAW`.

## The CSET-203 r16 normal caveat

`CSET-203-r16/with-normal/run.json`, its in-run `verification.json`, and the stdout capture
`CSET-203-r16-with-normal.json` are all **0 bytes**. Their mtime is 2026-10-10T22:00:59Z, after
the delivery. The surviving evidence does not record why they were truncated or why a second
session (`2-resume`) ran. The delivery still stands on records that survived:

- **Mycelink's accepted-delivery record** (`workspace/platform/features/CSET-203/deliveries/CSET-203-C001.json`):
  `status: ACCEPTED`, accepted 2026-10-10T21:57:26Z. `changesets` went from `c73949ba7b31` to
  `e1eab51c2afc` by fast-forward, and the acceptance command
  (`pnpm build && git checkout -- packages/config/package.json && pnpm vitest run`) exited 0.
- **The product repository itself**: `main` and `feature/CSET-203` are both at
  `e1eab51c2afc19a76a0c9c7cafd2c649f6e57716`.
- **The independent verifier** (`CSET-203-r16-verify.json`, generated 2026-10-11T00:54:54Z,
  suite `90d6279`): `ok`, `trusted`, every section passed, feature `COMPLETED`, all 4 nodes
  `DONE`, `delivery-accepted: deliver accepted CSET-203-C001 at e1eab51c2afc`, and
  `candidate-equals-delivery`.
- **The sessions**: `sessions/1-task.jsonl` and `sessions/2-resume.jsonl` both end in a successful
  result. Neither controller transaction records a violation. The verifier's pinned plugin package
  (`e43bfff20bf2`) is the one the r16 fault arm's `run.json` records for the same suite commit.

What is lost is the run-level record: its verdict and trust problems, session summaries, network
accounting, and the transcript scans for evaluator access and plugin exposure. The verifier's
leakage section, which searches the workspace and the session HOME for hidden tests and evaluator
files, did run and passed. The transcript-level scans that `run-arm` performs were never recorded
for this arm.

## Verifier warnings

Every failing check in the 12 verifier records has `severity: warning`. Two kinds occur:

- **`control-repo-committed`**: uncommitted paths in Mycelink's control repository (`platform/`,
  not a product repository). The counts are CSET-201 fault 261, CSET-202 fault 131, CSET-203
  normal 122, CSET-203 fault 165, PCM-101 fault 198, PCM-102 fault 34, and PCM-103 fault 97. The
  product repositories pass hygiene.
- **`reference-convergence`**: delivered files byte-identical to the reference production files.
  These are PCM-101 normal (`api/dto/VisitDetails.java`), PCM-101 fault (that file plus both
  `visits-service` `data.sql` seeds), and PCM-103 normal and fault (both `data.sql` seeds). The
  verifier treats convergence as leakage only when transcripts show evaluator access. Each of
  these runs has `evaluator_access.hits: []`.

## How the suite evolved: real failures and their fixes

These failures come from real arms. Each is quoted from that arm's own `run.json`
(`delivery.failures`) or control state, and each fix was followed by the accepted arm in the same
cell. The full history from r1 on is in
[`../CONSTRAINT_FREEDOM_AUDIT.md`](../CONSTRAINT_FREEDOM_AUDIT.md).

| Failed arm (suite) | Recorded stop | Fix | Next verified arm |
|---|---|---|---|
| CSET-203 r15 normal (`fb21139`) | exited incomplete: `cli.recover.impl` NEEDS_DECISION, `compat.verify` INVALIDATED, no candidate | `1dac657`: **mixed outcomes**, so each criterion of a rework order settles on its own (shipped in `90d6279`) | CSET-203 r16 normal (`90d6279`) |
| CSET-203 r16 fault (`90d6279`) | exited incomplete: `cli-recovery.impl` BLOCKED, no candidate | `c71631f`: **carried criterion proof**, so a completed criterion is carried by its immutable proof record (audited in `b72a9ba`) | (r17, still failing) |
| CSET-203 r17 fault (`b72a9ba`) | exited incomplete: `apply.journal.impl` BLOCKED; baseline and agent tests failing | `a67b6cb`: **capsules**, so an uncommitted focused reproduction is sealed as a capsule. A passing capsule challenges the gap, a failing one is a RED, and nothing is charged | CSET-203 r18 fault (`a67b6cb`) |
| CSET-202 final normal (`a67b6cb`) | controller-violation in sessions 1 and 2: `repos/changesets/.git:refs/stash (moved from nothing to nothing)` | `3a10e65`: **causal Git attribution**, so a stash transition is attributed by who caused it, not by which calls overlapped it | (CSET-202 rerun: no violation, stopped differently) |
| CSET-202 rerun normal (`3a10e65`) | delivery refused `OUTPUT_HASH_MISMATCH`; `changesets.cli.impl` NEEDS_DECISION | `80c6e17`: **immutable evidence**, so gate evidence is content-addressed from creation and a stale pointer is repaired administratively | CSET-202 rerun2 normal and CSET-202 fault (`80c6e17`) |
| CSET-201 final normal (`80c6e17`) | exited incomplete; state blocked on "AC-2 (its 2 of 2 accepted rework(s) spent; CSET-201-R003's materially new reproduction …): exhausted" | `f4b020c`: **progress-aware review**, so a criterion's budget is not a cap on real progress; plus **sibling proof preservation**, so re-proofs are committed and a settled proof is never lost | CSET-201 rerun normal and CSET-201 fault (`f4b020c`) |
| PCM-101 final normal (`f4b020c`) | exited incomplete: `visits.vet.impl` BLOCKED, `gateway.vetname.impl` REGRESSION_VERIFIED; state has `CRITERION_TEST_UNKNOWN` | `d2963b2`: **Java runner identity**, so a JUnit `Class#method` is its method, and identity refusals made by the old comparison are re-evaluated without charge | PCM-101 rerun normal, then all PCM fault and normal arms (`d2963b2`) |

Each fix leaves traces in the accepted arms that ran with it:

- **Mixed outcomes**: CSET-201 fault, PCM-101 fault and PCM-103 normal record worker outcome
  `CRITERIA` (a per-criterion settlement).
- **Progress-aware review and sibling proof preservation**: in CSET-201 normal, the delivered
  history holds a `Mycelink-Reproof` commit, and two review-lineage judgements in the control
  state have basis `progress`.
- **Immutable evidence and causal attribution**: the CSET-202 arms' gate evidence is
  content-addressed (`<label>.<sha16>.<ext>`: 61 files in normal, 106 in fault). Neither arm was
  stopped for a `refs/stash` move. The fault arm's only controller violation was a real one, the
  `.pnpm-store` it created, which was rolled back with no rollback problem.
- **Java runner identity**: the PCM arms' control state carries `mycelink-test-identity/1`
  records and no `CRITERION_TEST_UNKNOWN`.
- **Carried criterion proof**: CSET-203 r18's control state holds carried-proof fields
  (`carried_criterion_proofs`, `carried_from`).
- **Capsules**: no capsule record persists in any accepted arm's final control state. This report
  does not claim that a capsule decided any accepted arm, only that r18 ran with the mechanism in
  place.

## Limitations

1. **Mixed suite commits.** Only the six PCM arms ran on `d2963b2`. The six Changesets arms ran
   on `90d6279`, `a67b6cb`, `80c6e17` and `f4b020c`, and were not rerun on the final HEAD.
   Nothing here shows that `d2963b2` reproduces those six deliveries.
2. **Selection, one run per cell.** There are 54 `with`-arm runs under `$RESULTS`, and 19 of them
   are verified. CSET-203 normal took 16 runs, CSET-202 normal 6, and CSET-203 fault, PCM-101
   normal and PCM-101 fault 5 each. Each cell reports one verified run that followed the fixes for
   its earlier failures. This is evidence that the system *can* deliver each cell, not a success
   rate. Earlier verified arms on older suites (CSET-201 r2, CSET-202 r3, PCM-101 r4/r5,
   PCM-102 r1 fault, PCM-103 r1/r2) are superseded and not counted.
3. **No baseline comparison.** This matrix has no `without`-plugin arms; those ran only in the r1
   matrices, where some of them verified too (PCM-102 r1 both conditions, PCM-103 r1 normal).
   Nothing here measures Mycelink's uplift over plain Claude Code.
4. **CSET-203 normal has no run record.** See [the CSET-203 r16 caveat](#the-cset-203-r16-normal-caveat).
5. **PCM-101 fault exercised 4 of 5 faults.** The duplicate-result fault had no target.
6. **Warnings stand.** The control repositories have uncommitted paths in seven arms, and three
   PCM arms converge on reference files (see [Verifier warnings](#verifier-warnings)).
7. **Not re-executed here.** This report reads the recorded JSON and the workspaces' Git and
   Mycelink state. The independent verifier was not re-run for this report, and no arm was
   re-verified against `d2963b2`.
8. **Cost and time are out of scope.** This report makes no cost, latency or turn-count claim.

## Reproducing the checks

On the WSL host, Node 24.14.1 must be on `PATH` and the Git identity must be exported, as the
suite's runbook requires.

**Record integrity.** The SHA-256 hashes of the records this report relies on:

```text
14e73c6c8abbecab825927c806460e7f11c026ee364651ab4953b2f9a262e706  CSET-201-rerun/with-normal/run.json
20de582645af24e36d9c539156655f7dfac120fdb40fb94dc7f6618380cd0936  CSET-201-rerun-verify.json
8c577ed650d1dffeec6fd3d472086c551f679096ca49d32097f1b750b6f2c340  CSET-201-final/with-fault/run.json
f7c01840dc7446db1ac07c0ca9fa6c1c5edc524461fed2550c29f1cd8451a302  CSET-201-final-fault-verify.json
37ece3d3a5f24159c7a7288eeb04b83248370c5cd106374bbc65bb92ea027560  CSET-202-rerun2/with-normal/run.json
7c6899297f2cb38d334eb3d95622c978112e91c4569669f3ae90aa2d27de6d38  CSET-202-rerun2-verify.json
b339f6f248bd7b7cbae5f64280483dfddbd3b5e51e6c1785c5a265e6b317fd15  CSET-202-final/with-fault/run.json
24b5b56a59468ac77dec9824a272b25253a1d520ac4b44556e6d17f7603dd391  CSET-202-final-fault-verify.json
81a5c073db4ed1d9f0267f17a2866e55fb9bc27a26f24593c8610253976cc501  CSET-203-r16/with-normal/workspace/platform/features/CSET-203/deliveries/CSET-203-C001.json
ca4a82b3bc18b68691bdf953b1b59e94dfff7d302283cb25975b5bf18b8a0a2f  CSET-203-r16-verify.json
6a7acb0841de15d0d6dcb0d0b9be7642dc3800c151c60dfe4a9a66504a25e8fe  CSET-203-r18/with-fault/run.json
d5307b19fb7ca0715fcad1584c1b888e07a9482d575b5a38cfc55e2f575a5d86  CSET-203-r18-verify.json
134a3bc42bc08f25a8edd77efb196758143f8ae90f12f8a2bc5c9713dbdd0ee3  PCM-101-rerun/with-normal/run.json
8c9bcf8c7bed546bbdb81d5167706c2da2fd893c86c42d1fb688b4e13f9982c9  PCM-101-rerun-verify.json
30f3249f81eb850f60fa905d002987374e40153c1cb50176c79d480ff0d715c0  PCM-101-final/with-fault/run.json
f30bf9e408291d2950ff72a7f4899640718dc0582fa13cbf95084a36c9a9745a  PCM-101-final-fault-verify.json
f1836bfdfd892a6d5b72bd67a6b503d778cd703eecb1309d348a4121bd8409ca  PCM-102-final/with-normal/run.json
8c6c9afe1f721fb2cb218576203e3908e6c3943342d34b60a4a6127c6f08e2e4  PCM-102-final-normal-verify.json
56a93b4436c180524442f1888fa800cfd26cbdaae7e2f59e35caaa388138082b  PCM-102-final/with-fault/run.json
71aeee042c00cc26f2beae196442016a76405f0103649dbd88299afc3ae7bbf7  PCM-102-final-fault-verify.json
a4999ae9659a0236c51720a08f9b347b2732e5aebcbd5184cac9207f34b1d186  PCM-103-final/with-normal/run.json
e3c3450cb3d163c449663c94f583c5c7f829c757ac31fcbd16fda5459205f608  PCM-103-final-normal-verify.json
3c88bb8de9e2dcc76a685861cf4786ae65843b3ae1cfa8ee4db7f76fe6cf6796  PCM-103-final/with-fault/run.json
c857bfa917f07eb1f3095c38f243c38469104074e2b522c1d089c6ea656f7507  PCM-103-final-fault-verify.json
```

Save the block as `matrix.sha256` and run `cd "$RESULTS" && sha256sum -c matrix.sha256`.

**Matrix check.** This script reads JSON only and runs nothing. It is the script that produced
the tables above. It exits 0 only when every cell holds: the verifier is ok and trusted, has no
failing non-warning check, binds the expected SHA and the accepted candidate, and passes the fault
section where applicable; and the run record agrees, or for CSET-203 normal, Mycelink's accepted
delivery record does. Save it as `check_matrix.py` outside `$RESULTS` and run
`python3 -I check_matrix.py "$RESULTS"`. Run against the records above, it ends with
`ALL 12 ARMS HOLD`. With one expected SHA changed, it prints `FAIL` and exits 1. For
publication, the script's default results root (a path on the evaluation host) was replaced by
the `RESULTS` environment variable and a usage error; nothing else in it changed.

```python
#!/usr/bin/env python3
"""Re-check the 12-arm public-project matrix from the immutable run records.

Usage (on the WSL host): python3 -I check_matrix.py RESULTS_ROOT  (or export RESULTS)
Exit 0 when every arm holds, 1 otherwise, 2 without a results root. Reads JSON only; runs nothing.
"""
import json, os, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("RESULTS", "")
if not ROOT or not os.path.isdir(ROOT):
    print(f"usage: python3 -I check_matrix.py RESULTS_ROOT (or export RESULTS); no results root at {ROOT!r}",
          file=sys.stderr)
    sys.exit(2)
# (PRD, condition, run dir, independent verifier file, expected delivered SHA)
ARMS = [
    ("CSET-201", "normal", "CSET-201-rerun/with-normal", "CSET-201-rerun-verify.json", "6a932254d1562adf6797fc9544f9b6042f1c0008"),
    ("CSET-201", "fault", "CSET-201-final/with-fault", "CSET-201-final-fault-verify.json", "e0c0bf20cb120e4f70d7a3cb0cb3afe261fe2fc0"),
    ("CSET-202", "normal", "CSET-202-rerun2/with-normal", "CSET-202-rerun2-verify.json", "57cc3e8cd3712e6e0b93e6138edccdfe5e789f6c"),
    ("CSET-202", "fault", "CSET-202-final/with-fault", "CSET-202-final-fault-verify.json", "9d826a786fc7d1a49a62ed0315727749eb458bbb"),
    ("CSET-203", "normal", "CSET-203-r16/with-normal", "CSET-203-r16-verify.json", "e1eab51c2afc19a76a0c9c7cafd2c649f6e57716"),
    ("CSET-203", "fault", "CSET-203-r18/with-fault", "CSET-203-r18-verify.json", "5ff0fad113d1b78df3ebc42f53f0c4c40c89c8d4"),
    ("PCM-101", "normal", "PCM-101-rerun/with-normal", "PCM-101-rerun-verify.json", "8994997a66f5a9e24a175109bb16c3feee345404"),
    ("PCM-101", "fault", "PCM-101-final/with-fault", "PCM-101-final-fault-verify.json", "65ab5048bab4e1484bd181dd1282b6eef7017cfd"),
    ("PCM-102", "normal", "PCM-102-final/with-normal", "PCM-102-final-normal-verify.json", "09018d1553be2793f7775995bc98135dbc146192"),
    ("PCM-102", "fault", "PCM-102-final/with-fault", "PCM-102-final-fault-verify.json", "59d777c940110ec9afdade3a5ff4b0086d28fdac"),
    ("PCM-103", "normal", "PCM-103-final/with-normal", "PCM-103-final-normal-verify.json", "5d645fb3c939693bb75880674bc50286607afdae"),
    ("PCM-103", "fault", "PCM-103-final/with-fault", "PCM-103-final-fault-verify.json", "45deebe4b09012ec7c7b4ad9afca21def77ab831"),
]


def load(path):
    path = os.path.join(ROOT, path)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return None
    with open(path) as f:
        return json.load(f)


failures = []
for prd, cond, run_dir, verify_file, expected in ARMS:
    arm = f"{prd} {cond}"
    v = load(verify_file)
    if v is None:
        failures.append(f"{arm}: no independent verifier record")
        continue
    orch = {c["id"].split(":")[0]: c for c in v["sections"]["orchestration"]["checks"]}
    def need(cond_ok, what):
        if not cond_ok:
            failures.append(f"{arm}: {what}")
    need(v["ok"] is True and v["trusted"] is True and not v["errors"], "verifier not ok/trusted")
    need(all(v["trust"].values()), f"verifier trust {v['trust']}")
    need(v["suite"]["clean"] is True, "verifier suite not clean")
    need(v["workspace"].endswith(run_dir + "/workspace"), "verifier workspace is another run")
    need(v["evidence"]["head"] == expected, f"verified HEAD {v['evidence']['head']} != {expected}")
    need(v["sections"]["tdd"]["required"] and v["sections"]["tdd"]["ok"], "TDD not required+ok")
    need(v["sections"]["orchestration"]["required"] and v["sections"]["orchestration"]["ok"], "orchestration not required+ok")
    need(orch["candidate-equals-delivery"]["ok"] and orch["delivery-accepted"]["ok"], "candidate/delivery checks")
    hard = [(s, c["id"]) for s, sec in v["sections"].items() if sec for c in sec.get("checks") or []
            if not c["ok"] and c.get("severity") != "warning"]
    need(not hard, f"failing non-warning checks {hard}")
    warnings = sorted({c["id"].split(":")[0] for sec in v["sections"].values() if sec
                       for c in sec.get("checks") or [] if not c["ok"]})
    candidate = orch["delivery-accepted"]["detail"].split()[2]  # "deliver accepted <ID> at <sha12>"
    if cond == "fault":
        need(v["sections"]["faults"] and v["sections"]["faults"]["ok"], "fault section not ok")
    r = load(run_dir + "/run.json")
    if r is None:
        # The run record was never written; fall back to Mycelink's own accepted-delivery record.
        d = load(f"{run_dir}/workspace/platform/features/{prd}/deliveries/{candidate}.json")
        need(d is not None and d["status"] == "ACCEPTED", "no accepted delivery record")
        repo = next(iter(d["repositories"].values()))
        need(repo["after"] == expected, "delivery record SHA")
        run_cols = ["(run.json empty)", "-", "-", "-", "-"]
    else:
        m = r["mycelink"]
        need(r["verdict"] == "verified" and r["ok"] and r["trusted"] and r["verified"], f"run verdict {r['verdict']}")
        need(r["suite"]["commit"] == v["suite"]["commit"] and r["suite"]["clean"], "run/verifier suite differ")
        need(m["candidate"] == candidate and m["candidate_sha"] == expected == m["branch_head"], "run candidate/SHA")
        need(r["controller"]["ok"] and not r["controller"]["failures"] and r["controller_rollbacks"]["ok"], "controller")
        need(r["network"]["denied"].keys() <= {"registry.npmjs.org:443"} and not r["evaluator_access"]["hits"]
             and not r["plugin_exposure"], "network/evaluator/plugin exposure")
        faults = ",".join(("+" if f.get("applied") else "-") + f["kind"] for f in r["faults"]) or "-"
        invalid = sum(1 for x in r["reviewers"] if (x.get("settlement") or {}).get("outcome") == "REVIEW_INVALID")
        run_cols = [r["verdict"], "/".join(f"{s['purpose']}:{s['ended_by']}" for s in r["sessions"]),
                    str(len(r["controller"]["recovered"])), str(invalid), faults]
    print(" | ".join([prd, cond, run_dir, v["suite"]["commit"][:7], candidate, v["evidence"]["head"][:12],
                      f"ok={v['ok']} trusted={v['trusted']}", *run_cols, ",".join(warnings) or "-"]))

print("FAIL" if failures else "ALL 12 ARMS HOLD")
for f in failures:
    print("  " + f)
sys.exit(1 if failures else 0)
```

**Delivered repositories.** Check one delivery directly, for example CSET-203 normal:

```bash
git -C "$RESULTS/CSET-203-r16/with-normal/workspace/repos/changesets" rev-parse main feature/CSET-203
```

**Re-running an independent verifier.** This executes the delivered code in fresh exports, so
treat it like the eval run itself. Use a clean suite checkout at the arm's own suite commit (see
[Suite commits](#suite-commits-used-by-the-arms)), for example PCM-102 fault on `d2963b2`:

```bash
git -C <clean suite clone> checkout --detach d2963b225b6ab1cfd28bc26ac04ad1c48034e990
node <clean suite clone>/evals-public-projects/tools/verify-run.mjs \
  --workspace "$RESULTS/PCM-102-final/with-fault/workspace" --case PCM-102 \
  --require-mycelink --require-tdd \
  --faults "$RESULTS/PCM-102-final/with-fault/run.json" \
  --expect-suite-commit d2963b225b6ab1cfd28bc26ac04ad1c48034e990 \
  --out /tmp/PCM-102-fault-reverify.json
```

Normal arms omit `--faults`. CSET-203 normal has no `run.json`, but it is a normal arm and needs
no fault records.

**Suite ancestry** (in this repository):

```bash
for c in 90d6279 a67b6cb 80c6e17 f4b020c d2963b2; do git merge-base --is-ancestor $c d2963b2 && echo "$c ancestor"; done
```
