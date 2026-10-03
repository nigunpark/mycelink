# Threat model

This document describes what Mycelink protects, from whom, and how. It covers
`0.2.0-beta.1`. Each mitigation names the code that implements it and the
tests that prove it.

## What Mycelink is

A local developer tool. The `mycelink` controller runs on the developer's
machine with the developer's privileges, reads a control repository, runs the
build/test commands the developer registered, creates Git worktrees and
branches in registered repositories, and starts Claude Code worker sessions.
It has no server component, opens no listening ports and sends no telemetry.

## Assets

1. **Integrity of feature state** — `STATE.json`, the graph, event log, run
   ledger, leases and candidate manifests. If these can be forged, "done" can
   be claimed without evidence.
2. **The developer's machine and repositories** — files outside the declared
   ownership fences, unrelated repositories, Git history and remotes.
3. **Secrets** in the environment (tokens, keys, passwords) that commands and
   sessions inherit.
4. **The integrity of release artifacts** — the ZIP, checksum and SBOM.

## Trust boundaries and actors

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Developer (operator) | everything they configure: `repositories.yaml`, `mycelink.config.json`, `.claude/settings.json` | — |
| Claude Code worker / orchestrating model | judgement and code inside one node's fence | changing state, widening fences, enabling shells, approving artifacts, editing configuration |
| PRD / plan / graph text | describing the work | authorization of anything (it may be model-written or copied from a tracker) |
| Registered repositories' own code and tests | running as the developer would run them | — (Mycelink runs them; it does not sandbox them) |
| Third-party plugins, other repositories on disk | nothing | — (never discovered or touched) |

## Threats and mitigations

### T1. A model advances state without evidence

- Only the controller transitions nodes, and only on recorded exit codes
  (`src/state/transition.ts`, `src/evidence/runner.ts`).
- The PreToolUse hook blocks model edits of `STATE.json`, the graph, event
  log, run ledger, leases, candidates, `mycelink.config.json` and
  `.claude/settings.json` (`src/hooks/entrypoint.ts`;
  `tests/integration/hooks.test.ts`,
  `tests/security/untrusted-content.test.ts`).
- TaskCompleted is blocked without evidence regardless of prose claims.

### T2. Prompt injection through PRD, plan or graph text

- Text is never used as authorization: approval comes only from front-matter
  `status: APPROVED`; node states, fences and shell mode come only from
  validated structured fields and operator configuration.
- Workers are told explicitly that requirement text is data
  (`WORKER_RULES` in `src/sessions/context-pack.ts`).
- Always-on hook context contains ids and counts, never titles or criteria
  text. (`tests/security/untrusted-content.test.ts`)

### T3. Escaping the ownership fence through paths

- Relative-path classification refuses traversal, absolute, drive-relative,
  UNC, `\\?\` extended-length, `\\.\` device paths, reserved device names and
  NTFS alternate data streams (`src/security/paths.ts`).
- Containment resolves symlinks and junctions on the deepest existing
  ancestor before deciding, so a link inside a worktree cannot lead outside
  it. (`tests/security/paths.test.ts`, hook junction test in
  `tests/security/untrusted-content.test.ts`)
- Post-hoc enforcement: `verifyChangedPaths` compares a real Git diff
  (committed, staged, unstaged and untracked) against the fence.

### T4. Malicious identifiers

- Feature ids, node ids, candidate ids, repository names, Git ref names and
  checkpoint file names are validated before use as directories, refs or
  Git argv; option-shaped refs (`--upload-pack=…`) are refused
  (`src/security/names.ts`; `tests/security/names.test.ts`).

### T5. Command injection

- All commands are argv arrays executed without a shell
  (`src/security/exec.ts`). Metacharacters are literal argument text.
- Shell mode requires `shell: true` on the verifier **and**
  `allow_shell_commands: true` in operator configuration; a graph cannot
  enable it. E2E runtime steps are argv-only.
- On Windows, batch shims run via `cmd.exe /d /s /c` with every argument
  quoted, and arguments containing `& | < > ^ " % !`, line breaks or a
  trailing backslash are refused.
- The configured Claude executable is a file name, never a script.
  (`tests/security/exec-policy.test.ts`)

### T6. Permission bypass for worker sessions

- Permission-bypass flags are refused unless
  `allow_dangerous_permission_bypass: true`
  (`tests/security/permission-bypass.test.ts`). Nested delegation is
  rejected by the graph validator and blocked by a hook.

### T7. Secret leakage into durable artifacts

- Values of secret-named environment variables and well-known credential
  shapes are redacted from evidence logs and records, event logs, the run
  ledger, context packs, worker session logs and E2E metadata
  (`src/security/redact.ts`; `tests/security/redaction.test.ts`).
  See [DATA_HANDLING.md](DATA_HANDLING.md).

### T8. Stale owners and PID reuse

- Locks carry a random token; a holder whose token was superseded cannot
  delete the new owner's lock. Liveness of a recorded PID never keeps a lock,
  lease or worker session alive past its TTL or session ceiling, because PIDs
  are reused (`tests/security/locks-sessions.test.ts`).

### T9. Candidate tampering

- The manifest hash is not a signature, so verification re-checks every bound
  SHA and contract hash against the repositories themselves; a manifest is
  also bound to its file name and feature
  (`tests/security/candidate-tamper.test.ts`,
  `tests/integration/candidate.test.ts`).

### T10. Unwanted repository or remote operations

- Mycelink operates only on repositories listed in `repositories.yaml`. It
  never pushes, force-pushes or fetches; hooks block raw `git push`, `git
  merge`, `git rebase`, `git cherry-pick` and worktree management in sessions.
  Destructive Git operations (`reset --hard`, `clean`) run only inside
  Mycelink's own integration worktrees.

### T11. Supply chain and release integrity

- Runtime dependencies are bundled from a lockfile and listed in
  `THIRD_PARTY_NOTICES.md` and the SPDX SBOM. Releases are reproducible
  (same commit ⇒ same bytes) and carry a SHA-256 checksum. CI pins third-party
  actions to commit SHAs and uses least-privilege tokens; ordinary PR jobs
  have read-only permissions and `pull_request_target` is not used.

## Out of scope / residual risks

- **Registered build and test commands run with your privileges.** Mycelink
  does not sandbox them; a malicious repository's test suite can do anything
  you can.
- **Claude Code's own behaviour and permission system.** Mycelink relies on
  it and adds hooks; it does not replace it.
- **Operator-enabled escape hatches.** `allow_shell_commands` and
  `allow_dangerous_permission_bypass` deliberately widen trust.
- **Redaction is pattern-based.** A secret with an unrecognised shape and a
  non-secret-looking variable name can still be printed by your own tools.
- **Local attackers with write access to the control repository** can edit
  state directly; Mycelink detects drift (graph hash, candidate verification)
  but is not a tamper-proof store.
- The release checksum proves integrity of a download, not authorship;
  signed releases are future work.
