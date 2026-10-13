# CSET-203 r5: the reviewer's two refused verdicts of R001

Copied read-only from the CSET-203 r5 with-normal pilot artifact
(`workspace/platform/.mycelink/reviews/CSET-203/CSET-203-R001/<dispatch>/`
and `workspace/platform/features/CSET-203/PORTFOLIO-GRAPH.yaml`, a JSON
document); the artifact itself was not changed. The attestations' Claude
Code session, agent and tool-use ids are synthetic.

| file | what |
|---|---|
| `R001-g1.verdict.json`, `R001-g1.attest.json` | generation 1 (`49660e69-…`), byte for byte, and the fence's attestation of its Write. Refused `REVIEW_TRACE_INCOMPLETE`: AC-2.3 ("The journal's format is up to you.") was traced to the code alone |
| `R001-g2.verdict.json`, `R001-g2.attest.json` | generation 2 (`cde63478-…`), a fresh session that redid the review, byte for byte. Refused `REVIEW_VERDICT_INVALID`: `AC-1.clauses[0].trace` was 653 characters, over 600. The second refusal blocked the feature `REVIEW_INVALID` |
| `R001.packet.json` | both generations' review packet (they differ only in `dispatch_id`), reduced to what a verdict is judged against: the criteria verbatim with their clauses, the evidence ids the verdicts and the criterion evidence cite, the criterion evidence, and `files_at_head` — the `file:` locations the verdicts cite, each checked with `git cat-file -e` at the reviewed head. `packet_sha256` is each original packet's |
| `PORTFOLIO-GRAPH.json` | the graph: AC-5 (compatibility) served by both implementation nodes and proved by `CSET-203.changesets.compat.verify` |

Both verdicts found the same public gaps (AC-1, AC-3, AC-5 with AC-5.2
untested), and every implementation and verification node was DONE. No
rework and no candidate followed.

`tests/unit/review-verdict-canonical.test.ts` judges both again: each is a
valid GAPS verdict now — generation 2 with its 653-character trace cut and
marked at its bound (the original's length and SHA-256 kept), generation 1
because a clause that only grants latitude needs no test — and maps the
gaps to apply-release-plan (AC-1) and the cli (AC-3, AC-5).
`tests/integration/review-verdict-correction.test.ts` and
`tests/fixtures/cset203-r5-e2e.test.ts` settle r5's own 653-character trace
through the controller, to rework and (in the fixture) delivery.
