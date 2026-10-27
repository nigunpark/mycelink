# Threat model

This document describes what Mycelink protects, from whom, and how. It covers
`0.3.0-beta.2`. Each mitigation names the code that implements it and the
tests that prove it. The controller authority, claim capabilities and hook
fences that several mitigations rely on are specified in
[PERMISSION_MODEL.md](PERMISSION_MODEL.md).

**Experimental Codex dispatch is opt-in, not OS-certified confinement.** Without
an approved graph and explicit disposable-repository opt-in, Codex runtime
remains `CODEX_RUNTIME_DENIED`. The separate [Codex guide](CODEX.md) records
bounded worker/review/delivery pilots and the negative Windows MXC hardlink
counterexample (an allowed alias changed a forbidden file), failed whole-Codex
AppContainer launch, MCP side effects during a read-only turn and reviewer
provenance limits. The Claude hook, a custom Codex role TOML and a model-free
CI pass do not mitigate those OS/process boundaries. The table below describes
Claude controls unless a Codex-specific rule is named; opt-in functional
delivery must not be mistaken for hostile-worker protection.

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

### T1b. Criterion evidence that proves less than the criterion says

- A test id named for a criterion proves nothing about the clauses its
  assertions never reach (CSET-203 r2). An independent, read-only acceptance
  reviewer judges every criterion by its words before any candidate; its
  verdict is advisory, but its bindings (review, generation, inputs hash),
  coverage (every clause traced, every boundary covered, regression evidence
  for compatibility) and evidence ids are checked mechanically, its Write is
  attested by the fence, and its PASS receipt is bound to the repository
  heads, graph and criteria a candidate binds (`src/engine/acceptance-review.ts`;
  `tests/integration/acceptance-review.test.ts`,
  `tests/security/acceptance-reviewer-fence.test.ts`). A forged, stale,
  incomplete or unattested verdict is refused; hidden acceptance stays the
  final judge. Its prose is canonicalised where it enters (NFC, whitespace,
  a marked cut at its bound with the original's length and hash kept; never
  an id, hash, path, evidence reference or list), and refused when it
  carries control or bidirectional characters, invalid Unicode, credentials,
  Mycelink authority or embedded instructions, since a GAP's reproduction
  becomes a worker's rework reason; the receipt binds the canonical verdict
  and the attested original's hash
  (`tests/security/review-verdict-content.test.ts`). A worker's
  review-gap challenge is data checked against the claim, the red gate's
  own snapshot of the tests it ran, the review's pinned receipt and the
  repository (exact reason and reproduction hashes, tests added only, no
  production change, concrete assertions); its prose is canonicalised and
  refused on the same grounds, its archived evidence is Mycelink's alone
  (the fence refuses every writer), and nothing of it is integrated; a
  refinement is a reviewer verdict like any other, attested and judged
  (`src/engine/review-challenge.ts`;
  `tests/security/review-challenge-content.test.ts`,
  `tests/integration/review-challenge.test.ts`). A reviewer's final answer
  is taken as its verdict (CSET-203 r8) only as Claude Code recorded it,
  never from the controller's words: the fence records the host session's
  Agent call for the reviewer (call id, session, transcript, prompt hash,
  open generation, epoch) where only Mycelink writes, nobody writes a
  session or subagent transcript or meta, and no session runs the hook
  entrypoint itself; `review ingest` (and settle) prove the answer is the
  completed final message of exactly that launched reviewer, bound to the
  open generation's capability, epoch and inputs, accept it only when the
  whole answer is one JSON object (raw or one ```json fence; bounded bytes
  and depth, no duplicate key), write it to the generation's verdict file
  alone, exclusively and through no link, and attest it with the answer's
  and transcript's hashes; a written verdict and a different answer are
  refused (`REVIEW_OUTPUT_CONFLICT`) (`src/engine/review-transport.ts`;
  `tests/security/review-result-transport.test.ts`,
  `tests/integration/review-ingest.test.ts`). Residual: code running as the
  same OS user that bypasses the fence (not a tool call) can still forge
  transcripts, as it can forge any file.

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
- A repository's `worktree_setup` is operator configuration that Mycelink
  executes in every worktree it creates (worker, fresh verification,
  delivery acceptance). It is argv only (never a shell), runs with a
  hardened environment (the session's PATH, HOME and cache locations and
  its own declared `env`; no proxy, credential, loader or Mycelink
  variable), within a timeout, and is refused when it changes a tracked
  file, leaves untracked output, moves HEAD, changes git configuration or
  hooks (configuration it changed is restored), or leaves a link out of the
  worktree. Each run leaves a receipt bound to the worktree, its commit and
  the configuration's hash; claims, tickets, packs and evidence bind it, so
  a worker cannot change what prepared its worktree. Hooks block direct
  edits of the control repository's `repositories.yaml`. A setup may
  declare `inputs` (relative globs inside the worktree, never `..` or
  `.git`): the receipt binds their content (a symlinked input as the link,
  never followed), and a gate that finds them changed runs the same setup
  again before anything else, refusing the gate when it fails. A worker
  can thereby make the controller run the operator's setup over manifests
  it wrote; that runs nothing its own tests could not, under the same
  environment and receipt checks. Residual: a
  same-user process can still rewrite installed dependencies inside its own
  worktree; fresh verification sets up its own clean checkout.

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
