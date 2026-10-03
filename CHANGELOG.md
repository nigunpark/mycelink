# Changelog

All notable changes to Mycelink are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is 0, minor releases may contain breaking changes; they are called out
under **Breaking**.

## [Unreleased]

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

- Windows: node and integration worktrees were matched against `git worktree
  list` by path text. When the configured location used an 8.3 short name
  (for example the `RUNNER~1` user directory on GitHub-hosted runners), the
  existing worktree was not recognized: its directory was deleted and
  re-adding it failed with "missing but already registered worktree".
  Worktrees are now matched by real location (8.3 names expanded,
  case-insensitive on Windows). Found by the first public CI run.

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
