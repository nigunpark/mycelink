# Benchmark fixtures

Evidence the benchmark and controller tests replay. None of it is a test
suite of this repository (`vitest.config.ts` never collects it).

- **Run state** (`cset201-final/`, `cset203-r11/`, `pcm101-final/`, the
  verdicts, packets and graphs of `cset203-r3/`, `cset203-r5/`, `cset203-r8/`):
  copied from public-project pilot runs. The evaluation host's paths are
  neutral (`/home/alice/...`), and Claude Code's session, subagent and
  tool-use ids are synthetic. Wherever that changed bytes a record hashes,
  the record is sealed again as Mycelink seals it: a content-addressed
  output takes its new name, every SHA-256 naming a changed file is the new
  one, and each criterion completion record is sealed again from its body.
- **Transcripts** (`transcripts/`, `cset203-r10/`, the `*.jsonl` of
  `cset203-r8/` and `plugin-eval/`): hand-authored reconstructions of what
  the tests read — a session's tool calls in order, their results where a
  test needs one, the provider failure records of a refused request, a
  reviewer's launch, brief and final answer. They hold no recorded model
  output beyond the verdicts the tests judge, no session, request or message
  ids, no environment or model metadata, and only dummy capabilities and
  keys.
- **Evaluated projects' files** (`cset201-final/repo/`, `cset201-final/**/reproof/`,
  `cset203-r2/*.patch`, `pcm101-final/repo/`): Changesets and Spring
  PetClinic test sources and patches at the heads the runs reviewed, under
  their projects' licenses (`evals-public-projects/THIRD_PARTY.md`).
