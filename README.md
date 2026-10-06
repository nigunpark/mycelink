# Mycelink

**Connect repositories. Coordinate agents. Ship one feature.**

Mycelink is a Claude Code plugin plus a deterministic controller (`mycelink`)
that turns **one approved PRD** into dependency-aware work across **several
independent Git repositories**: isolated worker sessions in their own
worktrees, strict TDD gates, per-repository integration branches, **one
immutable cross-repository candidate**, and evidence-based end-to-end
completion.

Conversation history is never the source of truth. The PRD, the graph, the
state file, the event log, recorded command evidence and Git SHAs are.

> **Status: public beta (`0.2.0-beta.1`).** Interfaces may change before 1.0.
> Mycelink is an independent, third-party project. It is **not affiliated with
> or endorsed by Anthropic**. Licensed under [Apache-2.0](LICENSE). No telemetry.

---

## Contents

- [Why a controller and not just a prompt](#why-a-controller-and-not-just-a-prompt)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Examples](#examples)
- [Update and uninstall](#update-and-uninstall)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing, support and security](#contributing-support-and-security)

---

## Why a controller and not just a prompt

A model can judge and implement. It cannot be the thing that *guarantees*
state. Mycelink splits the two jobs:

| Claude Code (judgement) | `mycelink` controller (deterministic) |
|---|---|
| read the PRD, decompose, implement, attribute failures | READY computation, claims, dispatch |
| ask the user about product decisions | state transitions and evidence validation |
| write code inside one node's ownership fence | budgets, leases, candidates, E2E scheduling |

Project hooks make the split real: a model editing `STATE.json`, running a raw
`git merge` or `git push`, spawning a subagent from a worker, touching a file
outside its fence, or changing production code before a verified RED is
**blocked**, not discouraged.

---

## Architecture

```text
            approved PRD ──► portfolio graph (4 layers, validated)
                                   │
  feature ─► repository slice ─► capability ─► executable node
                                   │
                    mycelink controller (state machine, scheduler)
            ┌──────────────┬───────┴────────┬──────────────────┐
     worker session   worker session   candidate-build     e2e-scenario
     (worktree A)     (worktree B)     (controller)        (capacity-1 runtime)
            │                │                │                  │
   wip/<feature>/<node>  wip/...       feature/<id> in every repo │
            └──── integrate ─┴──► one immutable candidate manifest ┘
```

**What "one branch" means across repositories.** Separate Git repositories
cannot share a commit. Mycelink gives the honest equivalent: every repository
carries `feature/<feature-id>`, and one candidate manifest in the control
repository binds the exact SHA of each, plus contract hashes:

```text
core   feature/FEAT-101 @ sha-a
api    feature/FEAT-101 @ sha-b
web    feature/FEAT-101 @ sha-c

control-repo/features/FEAT-101/candidates/FEAT-101-C003.yaml
  repositories: { core: sha-a, api: sha-b, web: sha-c }
  contracts:    [{ path, sha256 }]
  manifest_sha256: ...
```

Candidates are immutable. Change any bound SHA and you get a **new** candidate
id. `mycelink candidate verify` re-checks every bound fact against the
repositories, so drift, contract edits and manifest tampering are detected.

**Node state machine.**

```text
PLANNED → READY → CLAIMED → RED_PENDING → RED_VERIFIED → GREEN_PENDING
→ GREEN_VERIFIED → REFACTOR_VERIFIED → REGRESSION_VERIFIED → REVIEW_VERIFIED
→ INTEGRATED → DONE        (plus BLOCKED, NEEDS_DECISION, BUDGET_EXHAUSTED, ...)
```

Refused by construction: a natural-language "done"; GREEN whose command
differs from the RED before it; a RED that failed for a missing module, a
syntax error or an unreachable service; DONE without every declared evidence
kind; leaving BLOCKED/NEEDS_DECISION without an approved decision. Failure
fingerprints are keyed on the normalised failure, not the actor, so retrying
under another model cannot disguise a repeat.

**Parallelism is derived, never chosen.** A node runs only when its
dependencies are DONE, its budget is intact, no other scheduled node owns
overlapping paths or the same contract, and every required resource has
capacity. Defaults:

```text
writer concurrency     2   (raise per feature after measuring)
full-runtime           1   (always)
deploy-slot            1   (always)
fixture-global-reset   1   (always)
browser-worker         2   (raise only with proven isolation)
nested delegation      0   (enforced by the validator and a hook)
```

**Generic by design.** The core consumes a Markdown PRD and a YAML/JSON
portfolio graph. Repository build/test commands come from your
`repositories.yaml`; nothing about languages or build tools is assumed.
Planning-tool integrations are adapters that only produce a **draft** graph
for review (`mycelink graph adapters`); the optional ECC adapter ships today,
and Jira/Linear/GitHub Issues adapters can be added without touching core
state machinery. See [docs/ADAPTERS.md](docs/ADAPTERS.md).

Source layout:

```text
.claude-plugin/   plugin + marketplace manifests
commands/ skills/ agents/   Claude Code components
bin/mycelink.mjs  launcher;  dist/mycelink.mjs  prebuilt runtime bundle
schemas/          JSON Schemas for every canonical artifact
src/              TypeScript sources (state, graph, scheduler, git, sessions,
                  evidence, e2e, loops, knowledge, adapters, security, hooks, cli)
templates/        control-repository template with worked examples
docs/             threat model, permission model, data handling, adapters, releasing
```

---

## Security model

Short version — details in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md),
[docs/PERMISSION_MODEL.md](docs/PERMISSION_MODEL.md) and
[docs/DATA_HANDLING.md](docs/DATA_HANDLING.md):

- **Graph and PRD text is data, never authorization.** It cannot change a node
  state, widen a fence, enable a shell or approve anything.
- **Commands are argv arrays, run without a shell.** Shell mode needs both
  `shell: true` on a verifier *and* `allow_shell_commands: true` in the
  control repository's `mycelink.config.json` (off by default).
- **No permission bypass by default.** `--dangerously-skip-permissions` and
  `bypassPermissions` in worker settings are refused unless you set
  `allow_dangerous_permission_bypass: true`.
- **Paths are contained.** Traversal, absolute, UNC, `\\?\`, `\\.\` and
  reserved device names are refused, and symlinks/junctions are resolved
  before any ownership decision.
- **Names are validated** before they become directories, Git refs or Git
  argv (no option-shaped branch names).
- **Secrets are redacted** from evidence, event logs, the run ledger, context
  packs, session logs and E2E metadata.
- **No automatic push, force-push, destructive cleanup outside Mycelink's own
  worktrees, or discovery of repositories you did not register.**
- **Hooks are project-scoped**: installed into a control repository by
  `mycelink init`, never always-on for unrelated projects.

---

## Requirements

| | Supported |
|---|---|
| Node.js | 22.12+ and 24.x |
| Git | 2.30+ recommended (worktrees) |
| Claude Code | a version with plugin marketplaces and `plugin validate --strict` |
| OS | Windows, Linux, macOS — each exercised by the CI matrix |

No Docker, WSL or VM is required. You do **not** need to run `npm install` or
build anything to use a release: the runtime ships prebuilt.

---

## Install

The repository is its own single-plugin marketplace (`mycelink-marketplace`).

### From GitHub

```bash
claude plugin marketplace add nigunpark/mycelink
claude plugin install mycelink@mycelink-marketplace
```

### From a release ZIP

```bash
# download mycelink-<version>.zip and mycelink-<version>.zip.sha256 from
# https://github.com/nigunpark/mycelink/releases
sha256sum -c mycelink-0.2.0-beta.1.zip.sha256        # PowerShell: Get-FileHash
unzip mycelink-0.2.0-beta.1.zip -d mycelink
claude plugin marketplace add ./mycelink
claude plugin install mycelink@mycelink-marketplace
```

Each release also carries an SPDX SBOM (`SBOM.spdx.json`).

### Try without installing

```bash
claude --plugin-dir ./mycelink        # session-scoped, nothing persisted
```

### Verify

```bash
claude plugin list                     # mycelink@mycelink-marketplace, enabled
node <install-path>/bin/mycelink.mjs --version
```

---

## Quickstart

Inside Claude Code (commands are namespaced by the plugin):

```text
/mycelink:init ../control
/mycelink:prd FEAT-101 Order status notifications
/mycelink:plan FEAT-101
/mycelink:run FEAT-101
/mycelink:verify FEAT-101
```

The same flow with the CLI (`node <plugin>/bin/mycelink.mjs`, shown as
`mycelink`):

```bash
# 1. Create and version a control repository, then register repositories.
mycelink init ../control && git -C ../control init
mycelink repo register --control-root ../control --name core --path ../core --base-branch main -- npm test
mycelink repo register --control-root ../control --name api  --path ../api  --base-branch main -- python -m pytest
mycelink repo audit  --control-root ../control
mycelink doctor      --control-root ../control

# 2. Write features/FEAT-101/PRD.md and PORTFOLIO-GRAPH.yaml
#    (/mycelink:prd and /mycelink:plan do this with you; see templates/).

# 3. Validate, initialise, inspect.
mycelink graph validate     FEAT-101 --control-root ../control
mycelink feature init       FEAT-101 --control-root ../control
mycelink orchestrate ready  FEAT-101 --control-root ../control

# 4. Run: the host loop /mycelink:run drives inside Claude Code.
mycelink dispatch FEAT-101 --control-root ../control --json
#    -> {"status": "DISPATCHED", "ticket": {...}}: give ticket.prompt to the
#       Agent tool (subagent mycelink:module-worker); it writes ticket.result_slot.
mycelink settle   FEAT-101 <node-id> --capability <ticket.capability> --control-root ../control --json
#    ... repeat dispatch/settle until dispatch reports ALL_SETTLED.

# 5. Prove and deliver.
mycelink feature verify     FEAT-101 --control-root ../control
mycelink candidate verify   FEAT-101 --control-root ../control
mycelink deliver            FEAT-101 --control-root ../control --json
```

Outside Claude Code, `mycelink orchestrate run FEAT-101 --json` drives the
same cycle with the standalone CLI adapter, which spawns `claude -p`
workers itself; `mycelink doctor` reports whether that executable can start.
Neither `dispatch` nor `deliver` ever pushes.

`--control-root` can be omitted when you run from inside the control
repository (it is found by walking up to `mycelink.config.json`) or when
`MYCELINK_CONTROL_ROOT` is set.

---

## Configuration

### `repositories.yaml` (control repository)

```yaml
schema_version: 1
repositories:
  - name: core                 # lowercase letters, digits, "-"
    path: ../core              # local relative or absolute path (no UNC/device paths)
    base_branch: main          # must be a safe git ref name
    baseline_failures: []      # tests already failing before the feature
    commands:                  # argv arrays only — never a shell string
      build: [npm, run, build]
      test: [npm, test]
      regression: [npm, test]
```

### `mycelink.config.json` (control repository)

| Key | Default | Meaning |
|---|---|---|
| `claude_executable` | `"claude"` | executable used for worker sessions (a file name, never a shell string) |
| `claude_extra_args` | `[]` | extra argv for worker sessions, e.g. `["--allowed-tools", "Edit", "Write", "Bash(npm test:*)"]` |
| `session_timeout_ms` | 2 700 000 | hard ceiling per worker session |
| `context_pack_max_bytes` | 16 384 | worker context-pack budget |
| `hook_session_start_max_bytes` / `hook_prompt_delta_max_bytes` | 4096 / 2048 | always-on hook context budgets |
| `brain_dir` | `null` | optional LLM Wiki Brain directory |
| `allow_shell_commands` | `false` | permit verifiers that declare `shell: true` (trusts graph authors with arbitrary commands) |
| `allow_dangerous_permission_bypass` | `false` | permit permission-bypass flags in `claude_extra_args` (only for disposable sandboxes) |

The PreToolUse hook blocks model edits to `mycelink.config.json` and
`.claude/settings.json`; change them yourself.

### Portfolio graph

See `templates/control-repo/features/FEATURE-TEMPLATE/PORTFOLIO-GRAPH.example.yaml`
and the schema in `schemas/portfolio-graph.schema.json`. Each node declares
its repository, `allowed_paths`, dependencies, contracts, required evidence,
verification commands (argv) and a worker budget.

---

## Examples

- `templates/control-repo/` — a complete control repository: manifest,
  `CLAUDE.md`, hook settings example, a three-repository graph and an E2E
  scenario.
- `tests/fixtures/three-repo-e2e.test.ts` — an executable end-to-end run over
  three real Git repositories with the fake Claude executable (no model
  usage): schedule, TDD gates, integration, candidate, E2E, invalidation and
  decisions.
- Import a draft graph from an approved ECC-style PRD/plan:

  ```bash
  mycelink graph adapters
  mycelink graph import FEAT-101 --adapter ecc --prd PRD.md --plan PLAN.md
  # review features/FEAT-101/PORTFOLIO-GRAPH.draft.yaml, then rename and validate
  ```

---

## Update and uninstall

```bash
claude plugin marketplace update mycelink-marketplace
claude plugin update mycelink@mycelink-marketplace
# then, for every control repository, refresh the hook paths:
node <new-install-path>/bin/mycelink.mjs init <control-repo>
node <new-install-path>/bin/mycelink.mjs doctor --control-root <control-repo>
```

`init` is idempotent: it rewrites only Mycelink's own hook entries and never
touches your other hooks, configuration or feature data. `doctor` reports
hooks that still point at an old installation.

```bash
claude plugin uninstall mycelink
claude plugin marketplace remove mycelink-marketplace
```

Uninstalling never deletes control repositories, feature state, evidence or
worktrees. To stop enforcement in a control repository, remove the Mycelink
entries from its `.claude/settings.json` by hand.

---

## Limitations

- **Beta.** Schemas and CLI flags may change before 1.0; changes are listed in
  [CHANGELOG.md](CHANGELOG.md).
- **Worker branches live under `wip/<feature>/<node>`**, not
  `feature/<feature>/<node>`: Git refs cannot nest under an existing ref.
- **The ECC adapter is validated against the documented artifact shape only**,
  not against a live ECC installation.
- **Real-model runs are opt-in.** The automated suite uses a fake Claude
  executable; `MYCELINK_REAL_CLAUDE_PILOT=1 npm run test:pilot` runs one node
  with a real session and incurs model usage.
- **Claude Code has no `--max-turns` flag**, so the controller enforces the
  turn ceiling itself by counting stream events.
- **Shell mode is unsupported for E2E runtime steps** (deploy, healthcheck,
  fixture-reset); they are argv-only.
- **On Windows, batch shims** (`npm.cmd` and similar) refuse arguments
  containing `& | < > ^ " % !` or a trailing backslash; call the underlying
  executable (for example `node script.js`) when you need such arguments.
- **Redaction is a safety net**: keep secrets in environment variables, not in
  command arguments or graph text.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Mycelink runtime bundle is missing` | you are in a source checkout without `dist/`; run `npm ci && npm run build`, or install a release |
| `doctor`: `hooks point at a missing launcher` | the plugin moved after an update; re-run `mycelink init <control-repo>` |
| `Unsafe feature id` / `Unsafe branch name` | ids are `UPPERCASE-123`; branch names must be valid Git refs and must not start with `-` |
| `SHELL_NOT_ALLOWED` | the verifier asks for a shell; use argv, or set `allow_shell_commands: true` knowingly |
| `BATCH_METACHARACTER` (Windows) | call the real executable instead of a `.cmd` shim, or drop the metacharacter |
| `PermissionPolicyError` | remove the bypass flag from `claude_extra_args`, or opt in only inside a sandbox |
| `PATH_ESCAPES_REPOSITORY` | `allowed_paths` must be repository-relative globs |
| worker session immediately fails | check `claude_executable`, and that `claude_extra_args` grants the tools a worker needs |
| a node is stuck `BLOCKED` | two identical failure fingerprints; read the evidence log path in `feature status`, fix the cause, then `decision record`/`apply` |

Run `mycelink doctor --json` and include its output (redact paths if you
prefer) when asking for help.

---

## Development

```bash
npm ci
npm run typecheck
npm run build          # dist/mycelink.mjs + THIRD_PARTY_NOTICES.md (commit both)
npm test               # unit, integration, security, fixture, release, plugin-e2e
npm run package        # artifacts/mycelink-<version>.zip, .sha256, SBOM.spdx.json
claude plugin validate --strict .
```

No test incurs model usage. Plugin-e2e tests use the real Claude Code CLI in
a throwaway isolated profile and are skipped (loudly) when it is not on PATH.

## Contributing, support and security

- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow, strict TDD, commit style
- [SUPPORT.md](SUPPORT.md) — where to ask questions
- [SECURITY.md](SECURITY.md) — report vulnerabilities privately via GitHub Security Advisories
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [GOVERNANCE.md](GOVERNANCE.md) — how decisions are made
- [docs/RELEASING.md](docs/RELEASING.md) — release process

Copyright 2026 Mycelink Contributors. Licensed under the Apache License 2.0;
see [LICENSE](LICENSE), [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
