# CSET-203 r8: a corrective reviewer's verdict, answered but never written

The verdicts, final answers, packet and graph are copied read-only from the
CSET-203 r8 with-normal pilot artifact
(`workspace/platform/.mycelink/reviews/CSET-203/CSET-203-R001/<dispatch>/` and
`workspace/platform/features/CSET-203/PORTFOLIO-GRAPH.yaml`); the artifact
itself was not changed. Claude Code's records of the host session and of the
reviewer are hand-authored reconstructions holding only what the transport
reads; every session, agent and tool-use id here is synthetic and the
evaluation host's paths are neutral (`/home/alice`). Every product and
verification node was DONE.

| file | what |
|---|---|
| `R001-g4.verdict.json`, `R001-g4.attest.json` | generation 4 (`01f1e1bf-…`), byte for byte, and the fence's attestation of its Write (synthetic ids). Refused `REVIEW_TRACE_INCOMPLETE` at `/criteria/4/clauses`: AC-5 was a compatibility GAP naming no material clause no test covers. Rightly corrected |
| `R001-g4.result.txt` | generation 4's final answer: the same verdict, compact (the agent wrote and answered it) |
| `R001-g3.result.txt` | generation 3's (`adbe2418-…`) final answer: a whole verdict JSON, never written. Settled `REVIEW_VERDICT_MISSING` |
| `R001-g5.result.txt` | generation 5's (`53bcb402-…`, the format correction) final answer: the corrected verdict, its `dispatch_id` and `inputs_sha256` set to its own generation, never written. Settled `REVIEW_VERDICT_MISSING`; the second such generation blocked the feature `REVIEW_INVALID` |
| `R001-g5.agent.jsonl`, `R001-g5.agent.meta.json` | generation 5's reviewer subagent (`a0000000000000805`), reconstructed: the prompt it was launched with, its read of the correction brief (the brief's identity lines) and its final answer, `R001-g5.result.txt`; the meta names its type and the Agent call |
| `R001-g5.main.jsonl` | the host session's record of that Agent call, reconstructed: the `tool_use`, its async-launch result naming the agent, and the completion notification carrying the answer |
| `R001.packet.json` | generations 3–5's review packet, reduced like r5's to what a verdict is judged against: the criteria with their clauses, the evidence the verdicts and the criterion evidence cite, the criterion evidence, generation 5's correction, and `files_at_head` — the `file:` locations the verdicts cite, each checked with `git cat-file -e` at the reviewed head. `dispatch_id` and `packet_sha256` per generation |
| `PORTFOLIO-GRAPH.yaml` | the graph, byte for byte |

`tests/unit/review-transport-r8.test.ts` replays it: generation 4's written
verdict is still refused for AC-5's trace (and its final answer is the same
verdict, so both transports agree); generation 5's final answer is taken
from its own transcript — proved to be the output of the reviewer the host
launched for that generation — and judged a valid GAPS verdict (AC-1, and
AC-5 with AC-5.2 untested) whose gaps rework the producers the graph names.
Generation 3's final answer would have been a format correction, not a
missing verdict. The historical r8 run stays failed.
