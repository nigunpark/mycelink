# Changelog

All notable changes to Mycelink are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is 0, minor releases may contain breaking changes; they are called out
under **Breaking**.

## [Unreleased]

### Breaking

- Worker sessions receive their brief on stdin and write their result to
  `.mycelink-worker/result.json` in the worktree. Custom worker agents or
  skills that read `$MYCELINK_CONTEXT_PACK` or write `$MYCELINK_RESULT_PATH`
  must follow the bundled `module-worker` agent and `node-worker` skill
  instead; those variables are no longer set.

### Changed

- Repository metadata now points at the public GitHub repository
  `nigunpark/mycelink`: `homepage`, `repository` and `bugs` in `package.json`
  (also carried in the release archive's `package.json`), `homepage` and
  `repository` in the plugin manifest, the README's *From GitHub* install
  command, and the SECURITY/SUPPORT/issue-template links.
- `GOVERNANCE.md` lists `@nigunpark` as maintainer, and `.github/CODEOWNERS`
  assigns all paths to `@nigunpark`.
- `bin/mycelink.mjs` and `dist/mycelink.mjs` are tracked in git as executable
  (`100755`), matching the modes already used in the release archive, and
  `npm run build` sets the bundle's mode explicitly. Before this, rebuilding
  on Linux or macOS flipped the bundle's mode and failed the CI build check.

### Fixed

- **Real worker sessions could never start their node (beta blocker).** The
  worker prompt told Claude Code to read `$MYCELINK_CONTEXT_PACK` and write
  `$MYCELINK_RESULT_PATH`. In print mode Claude Code's permission checks deny
  shell expansion of variables, and the pack lived outside the worktree, so
  the first real-Claude pilot's worker was denied on every attempt and exited
  0 with no result (`RESULT_MISSING`, no RED/GREEN evidence). The worker
  transport no longer depends on the worker discovering anything:
  - the validated, redacted, byte-bounded context pack is inlined in the
    prompt, which is sent on **stdin** (no command-line length limit, no
    batch-shim expansion). Pack text is JSON with `<`, `>`, `&` and backticks
    `\u`-escaped, so it cannot close its data block or forge protocol lines.
    A pack that is schema-invalid, over its byte budget, or for another
    feature, node or claim fails the attempt (`CONTEXT_PACK_INVALID`) without
    starting a worker;
  - the worker writes `.mycelink-worker/result.json` inside its own worktree.
    The controller creates that slot with a self-ignoring `.gitignore`,
    pre-approves exactly that file (`--allowed-tools
    Edit(./.mycelink-worker/result.json)`), and after the session collects it
    with link, size (256 KiB), schema and node/claim identity checks
    (`RESULT_PATH_ESCAPE`, `RESULT_TOO_LARGE`, `RESULT_SCHEMA_INVALID`,
    `RESULT_IDENTITY_MISMATCH`), stores a redacted copy under the feature's
    `sessions/` directory, and removes the worker's copy;
  - the controller offers the node's `mycelink tdd red|green|regression`
    calls as exact command lines (no `--` passthrough, so each runs the
    declared verifier) and pre-approves only those exact lines;
  - `MYCELINK_CONTEXT_PACK` and `MYCELINK_RESULT_PATH` are no longer set for
    workers; the PreToolUse hook exempts exactly the result file from the
    ownership fence and the RED gate.
- The real-Claude pilot no longer passes on a non-result. It now requires a
  structured worker result plus either a behaviour-missing RED and a passing
  GREEN on the same command, or a `NEEDS_DECISION` with a real question and at
  least two options; `RESULT_MISSING`, `READY`, `BLOCKED` and the rest fail it.
- Windows: node and integration worktrees were matched against `git worktree
  list` by path text. When the configured location used an 8.3 short name
  (for example the `RUNNER~1` user directory on GitHub-hosted runners), the
  existing worktree was not recognized: its directory was deleted and
  re-adding it failed with "missing but already registered worktree".
  Worktrees are now matched by real location (8.3 names expanded,
  case-insensitive on Windows). Found by the first public CI run.
- CI: both fixes above are confirmed by a run that passes on Windows, Ubuntu
  and macOS with Node.js 22.12.0 and 24.

## [0.2.0-beta.1]

First public beta.

### Added

- Deterministic controller (`mycelink` CLI) and Claude Code plugin: one
  approved PRD becomes a four-layer portfolio graph, dependency-scheduled
  worker sessions in isolated git worktrees, per-repository
  `feature/<id>` integration branches, one immutable cross-repository
  candidate, and evidence-based completion.
- Strict TDD gates (RED must fail for a missing behaviour; GREEN re-runs the
  same command), bounded retries and budgets, failure fingerprints,
  capacity-bounded resource leases, E2E conflict scheduling, fresh
  verification and an optional LLM Wiki Brain memory adapter.
- Project-scoped enforcement hooks installed by `mycelink init`; `mycelink
  doctor` reports missing hooks or hooks that point at a moved installation
  (re-run `init` after a plugin update). Permission-bypass flags for worker
  sessions are refused unless explicitly allowed, and the hooks block model
  edits of `mycelink.config.json` and `.claude/settings.json`.
- Plan-source adapter registry (`mycelink graph adapters`,
  `mycelink graph import`); the ECC adapter is optional and validated against
  the documented artifact shape only.
- Security hardening: path containment with symlink/junction resolution;
  refusal of UNC, extended-length, device and reserved-name paths; validated
  feature/node/candidate ids and git ref names; argv-only command execution
  with an explicit, config-gated shell mode; Windows batch-shim argument
  checks; secret redaction in evidence, logs, ledgers, context packs and
  session logs; PID-reuse-safe session reconciliation; candidate manifests
  bound to their id and feature.
- Self-contained runtime bundle (`dist/mycelink.mjs`) so marketplace and
  release-ZIP installs need no `npm install` and no TypeScript build.
- Deterministic release packaging with SHA-256 checksum and SPDX 2.3 SBOM.

### Changed

- License: Apache-2.0.

[Unreleased]: #unreleased
[0.2.0-beta.1]: #020-beta1
