# Adapters

Mycelink has two kinds of extension points. Both are deliberately narrow so
that new integrations never touch graph, state, scheduling or evidence code.

## 1. Plan-source adapters (planning tools → draft graph)

The core consumes exactly one planning input: a **portfolio graph** that a
human reviewed and `mycelink graph validate` accepted. The primary,
tool-independent flow is to write that graph directly — usually with the
`/mycelink:prd` and `/mycelink:plan` commands — as Markdown + YAML in the
control repository.

A plan-source adapter turns some other planning artifact into a **draft**
graph. Adapters:

- never write `PORTFOLIO-GRAPH.yaml` or `STATE.json` (the CLI refuses to write
  a draft over the canonical graph);
- never approve anything — every result has `requires_review: true`;
- never invent repositories or commands; gaps are reported as problems;
- declare how far they are verified: `tested` (against real output of the
  source system) or `documented-shape-only`.

```bash
mycelink graph adapters                         # list adapters and their inputs
mycelink graph import <FEATURE> --adapter <name> --<input> <file> ... [--out <file>]
# default output: features/<FEATURE>/PORTFOLIO-GRAPH.draft.yaml
```

### Built-in: `ecc` (optional)

Converts an ECC-style Markdown PRD and plan into a draft graph.

- Inputs: `--prd`, `--plan`.
- Both files must carry YAML front-matter with `status: APPROVED`; approval
  text anywhere else (body, code blocks, later `---` blocks) is ignored.
- PRD: `AC-n` acceptance criteria. Plan: one `## <id> <title>` section per
  behaviour with `repository`, `capability`, `acceptance_criteria`, `files`
  (or `allowed_paths`), `depends_on`, `contract_inputs`/`contract_outputs`,
  `red_target`/`green_target`, `regression`, `resources`, `evidence`.
- **Verification status: documented-shape-only.** It has been tested against
  the documented artifact shape, not against output from a live ECC
  installation. A materially different format needs its field mapping
  extended in `src/adapters/ecc/plan-adapter.ts`.

ECC is not required for anything else in Mycelink.

### Writing a new adapter (Jira, Linear, GitHub Issues, ...)

Implement `PlanSourceAdapter` from `src/adapters/registry.ts`:

```ts
import type { PlanSourceAdapter } from '../registry.js';

export const linearAdapter: PlanSourceAdapter = {
  name: 'linear',                       // lowercase, digits, "-"
  description: 'Linear project export (JSON) to a draft graph',
  verification: 'documented-shape-only',
  inputs: ['export'],                   // becomes --export <file>
  draft({ files, repositories }) {
    const data = JSON.parse(files['export'] ?? '{}');
    // map issues -> acceptance criteria, capabilities and executable nodes;
    // report anything you cannot map as a Problem instead of guessing.
    return { graph, problems, requires_review: true, review_notes: [] };
  },
};
```

Register it in `src/adapters/registry.ts` next to `eccAdapter`, add unit tests
(including an unapproved/garbage input), document it here, and note its
verification status honestly. Adapters receive file *contents* only: they do
not perform network requests in the core; fetching an export is the user's
step, which keeps credentials out of Mycelink.

## 2. Session adapters (who runs a node)

Worker sessions sit behind `SessionAdapter` in `src/sessions/adapter.ts`:

- `ClaudeCliAdapter` — spawns real Claude Code print-mode sessions
  (`-p --output-format stream-json --verbose`), enforces wall-clock, stall and
  turn ceilings, redacts the session log and validates the structured result
  file.
- `FakeInProcessAdapter` — scripted, for loop tests.

The automated suite drives `ClaudeCliAdapter` with
`tests/fake-claude/claude.mjs`, so spawning, stream parsing, timeouts and
result validation are exercised with zero model usage.

## 3. Memory adapter (optional)

`src/knowledge/brain.ts` implements an LLM Wiki–style Brain: Markdown pages
with types, status, source anchors and supersession links, selected into a
bounded context pack. Memory is a retrieval aid and never advances a node.
An existing `.codewiki` directory is adopted by reference.
