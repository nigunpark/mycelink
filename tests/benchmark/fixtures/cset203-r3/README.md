# CSET-203 r3: the planner's graph and the reviewer's R001

Copied read-only from the CSET-203 r3 with-normal pilot artifact
(`features/CSET-203/PORTFOLIO-GRAPH.yaml`, a JSON document, and
`features/CSET-203/reviews/CSET-203-R001.json` with the verdict's criteria):

| file | what |
|---|---|
| `PORTFOLIO-GRAPH.json` | the graph r3's planner wrote: AC-5 (compatibility) on the verification node `CSET-203.changesets.compat.verify` alone |
| `R001.json` | R001's outcome, its three public gaps (AC-1, AC-3, AC-5, AC-5 naming the verification node as producer) and the verdict's per-criterion clauses and boundaries |

Every implementation node and the verification node were DONE; the reviewer's
GAPs were real. Settle found no product node for AC-5's gap, recorded the
review `REVIEW_GAPS` with `reworks: []` and `reworks_applied: true`, reworked
nothing (AC-1 and AC-3 included) and blocked the feature.

`tests/unit/criterion-ownership.test.ts` shows the graph refused now
(`CRITERION_NO_PRODUCER`, `VERIFICATION_CRITERION_UNOWNED`);
`tests/unit/acceptance-review.test.ts` keeps the verdict valid and maps its
gaps on r3's graph (AC-5 unowned, the others kept) and on the corrected one
(AC-3 and AC-5 to the cli, AC-1 to apply-release-plan).
