# Contributing to Mycelink

Thank you for helping. This document covers how to propose a change and what
a change needs before it can merge.

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE) (inbound = outbound, as described in section 5
of the license). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs:** open an issue with the bug template. Include `mycelink doctor
  --json` output, your OS, Node.js and Claude Code versions, and a minimal
  reproduction. Redact private paths and repository names if you prefer.
- **Features:** open a feature issue first for anything larger than a small
  fix, so the design can be agreed before you invest time.
- **Security problems:** do **not** open an issue. Follow
  [SECURITY.md](SECURITY.md).

## Development setup

```bash
npm ci
npm run typecheck
npm run build          # regenerates dist/mycelink.mjs and THIRD_PARTY_NOTICES.md
npm test
claude plugin validate --strict .
```

Node.js 22.12+ or 24.x and Git are required. The Claude Code CLI is optional
for development; without it the plugin-e2e suites skip with a warning.

## Strict TDD

Every behaviour change follows the same discipline Mycelink enforces on its
own workers:

1. **RED** — add or change a test that fails *because the behaviour is
   missing* (not because of a typo, missing module or setup error).
2. **GREEN** — make the smallest change that passes it.
3. **REFACTOR** — tidy with the suite still green.

Pull requests should make it possible to see the failing test before the
fix (for example as separate commits, or by describing how to reproduce the
RED). Do not delete or weaken a difficult test to get green; if a test is
wrong, explain why in the PR.

Tests must never incur model usage. Use `tests/fake-claude/claude.mjs` for
session behaviour; the real-model pilot is opt-in only.

## What a pull request needs

- [ ] Tests for the change, passing locally (`npm test`).
- [ ] `npm run typecheck` clean.
- [ ] `npm run build` run, and `dist/mycelink.mjs` plus
      `THIRD_PARTY_NOTICES.md` committed if they changed (CI fails on drift).
- [ ] `claude plugin validate --strict .` passes if plugin files changed.
- [ ] Documentation updated (README, `docs/`, command/skill text) when
      behaviour or flags change.
- [ ] A `CHANGELOG.md` entry under **Unreleased**.
- [ ] No secrets, personal paths, e-mail addresses, private repository names
      or organisation-specific procedures in code, tests, fixtures or docs.

## Design rules worth knowing

- The controller is the only thing that changes state. New behaviour that
  advances a node must be driven by recorded evidence, never by model text.
- Commands are argv arrays executed through `src/security/exec.ts`. Do not
  call `child_process` with `shell: true`.
- Every path or identifier from a graph, hook payload, CLI argument or config
  is untrusted; validate it with `src/security/paths.ts` /
  `src/security/names.ts`.
- Anything written to disk that could contain command output goes through
  `src/security/redact.ts`.
- Planning-tool integrations are adapters (`src/adapters/`) that produce a
  draft graph; they must not write canonical state. See
  [docs/ADAPTERS.md](docs/ADAPTERS.md).
- Prefer cross-platform code: Windows, Linux and macOS all run in CI.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) style
(`feat:`, `fix:`, `docs:`, `test:`, `chore:`, with an optional scope). Keep
each commit a coherent, passing slice.

## Dependencies

Runtime dependencies are bundled into `dist/mycelink.mjs` and listed in
`THIRD_PARTY_NOTICES.md` and the release SBOM. Adding one needs a clear
justification, a compatible permissive license (MIT, ISC, BSD, Apache-2.0),
and a regenerated bundle and notices file.
