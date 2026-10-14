# Benchmark fixtures

Evidence the benchmark and controller tests replay. None of it is a test
suite of this repository (`vitest.config.ts` never collects it).

- **Run state** (`cset201-final.tar`, `cset203-r11/`, `pcm101-final.tar`, the
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
- **Evaluated projects' files** (`repo/` and `**/reproof/` in
  `cset201-final.tar`, `cset203-r2/*.patch`, `repo/` in `pcm101-final.tar`):
  Changesets and Spring PetClinic test sources and patches at the heads the
  runs reviewed, under their projects' licenses
  (`evals-public-projects/THIRD_PARTY.md`).

## Archived trees and the path budget

`claude plugin marketplace add nigunpark/mycelink` clones this repository.
On Windows, Git refuses a path past MAX_PATH unless `core.longpaths` is set,
and an install from GitHub must not need it. Claude Code checks a marketplace
out into `<CLAUDE_CONFIG_DIR>\plugins\marketplaces\<staging>..clone\`. For a
CLAUDE_CONFIG_DIR of up to 80 characters, every tracked file must stay within
120 characters of the repository root, and every directory within 108
(`tests/release/marketplace-checkout.test.ts` derives these numbers and
checks them with a real clone on Windows).

The run trees `cset201-final` and `pcm101-final` held paths of up to 181
characters. Each is now kept as one archive beside its manifest:

- `<name>.tar`: uncompressed POSIX ustar, packed deterministically (regular
  files only, sorted, mode 0644, owner 0, time 0).
- `<name>.manifest.json`: the archive's size and SHA-256, and each file's
  path, size, SHA-256 and Git blob id. The blob ids are the ones these files
  had when they were tracked (`git ls-tree -r 675ac6f --
  tests/benchmark/fixtures/<name>`).

Tests read an archive through `fixtureTree('<name>')`
(`tests/helpers/fixture-archive.ts`). It verifies the archive against its
manifest, extracts it once per test file into a short temporary directory
outside the repository, and returns that directory. A recorded project's
`*.test.ts` never lands where Vitest or the constraint audit would collect
it. Extraction refuses anything unsafe before writing a byte: a path that
escapes, a link, a name Windows would alias, a destination that is not
empty (`tests/release/fixture-archives.test.ts`). The repository-hygiene
scan reads each archived file as `<archive>!/<path>`.

To inspect or change an archived tree, extract it somewhere short, outside
the repository, then pack the edited tree back:

```bash
node scripts/fixture-archive.mjs check                     # every archive against its manifest
node scripts/fixture-archive.mjs extract cset201-final /tmp/c201
node scripts/fixture-archive.mjs pack cset201-final /tmp/c201   # rewrites the .tar and its manifest
```

Never commit an extracted tree.
