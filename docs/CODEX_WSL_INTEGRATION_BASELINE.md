# WSL Codex integration baseline (local-only, disabled)

This is a handoff for the next integration/test worker, not authorization to dispatch Codex or a claim of host parity. Reconciled on `feat/codex-support` at `3e72b94` (before this documentation commit). The original `.hermes/plans/2026-10-16_155306-mycelink-codex-support.md` states the desired parity and RED/GREEN/review/release gates, but its proposed `workspace-write` adapter and hook-based identity are superseded by the counterexamples in `docs/CODEX_COMPATIBILITY.md`. Do not edit the plan or turn on the adapter merely to make its initial task ordering pass.

## Git reconciliation

The four completed slices are **already direct, linear ancestors of HEAD**, not divergent worktrees requiring a cherry-pick or merge. Their exact parent chain is:

| Commit | Parent | Slice |
| --- | --- | --- |
| `0cb9743` | `adb22a8` | Dedicated WSL worker/reviewer identity and hardened launcher/Windows crossing |
| `ec86b6e` | `0cb9743` | Explicit-source copied snapshot, root-private reserved proposal transport |
| `b2b5323` | `ec86b6e` | Generation/role-bound root broker and sealed worker/reviewer slots |
| `a1a3797` | `b2b5323` | Credential-pinned, request/output-bounded scoped API bridge |

`git worktree list` showed only the current worktree. No merge/cherry-pick was performed: doing so would duplicate existing commits. Later integration experiments are also descendants in this branch, from `6a721c6` (source-hash transport binding) through `3e72b94` (broker denial test resilience), including `865e291` (experimental lifecycle mutex), `9484b50` (finite bridge admission lease), `630d00d` (WSL process registry/cancel), `5f6e0be` (registered readiness/resume), and `29a90b1` (refuse active settlement). All four slice commits and guard commits `e3af717`, `2229376`, `ba14e48`, `699793f` are reachable from HEAD. The working tree had only pre-existing untracked `.hermes/` and `scripts/__pycache__/`; neither is part of this documentation commit. No push or publication.

## Why the older negatives still matter

`9db205b` demonstrates a forbidden Windows result inode overwritten through a pre-existing hardlink to an MXC-allowed path. `4f80943` demonstrates a writable WSL bind hardlink alias into an unmounted protected inode and arbitrary outbound access under `--share-net`. `2713f2f` demonstrates a protected file changed through inherited FD 9 even behind read-only bwrap mounts. `ba42673` keeps **native Windows Codex** disabled: per-command profiles and fallible hooks cannot attest an entire process and all tools. These are negative evidence about unsafe boundaries, **not** a fresh no-go finding from the historical lack of a broker, auth, transport or login. Those components now exist as bounded experimental slices; read their contracts under `tests/spike/WSL_*` and `docs/CODEX_COMPATIBILITY.md`. WSL and Windows-native parity remain separate questions.

## Verified at this baseline

From Windows Git Bash, `npx vitest run tests/integration/adapter-preflight.test.ts tests/security/codex-host-fence.test.ts tests/integration/host-dispatch.test.ts tests/integration/wsl-codex-claim.test.ts --config vitest.config.ts`: **45 passed, 6 opt-in skips** (four files). Claude host dispatch includes the test-only RED commit, production-only GREEN commit and settle; Codex preflight and production host dispatch continue to refuse. `npm run typecheck` and `npm run build:check` passed with no tracked build delta. Earlier worker checkpoints recorded real Linux Codex/scoped bridge/MCP/built-in tests and WSL component suites separately; the above run did **not** rerun those live components, nor does their separate success establish an integrated production transaction.

## Exact next-worker gaps / safe order

1. Add failing end-to-end tests first, then bind the actual isolated Linux Codex **and** scoped bridge to the registered Windows claim/generation/process lifetime. Current registration tests launch `/bin/sleep`; admission expiry or in-process `revoke()` does not stop already admitted HTTP. Prove descendant/bridge kill and reconcile on cancel, resume, expiry and crash. Keep hook failure and MCP/built-in side-effect probes in scope.
2. Freeze explicit source bytes from immutable Git objects in controller-owned root-private staging, compute expected exact path-to-SHA-256 map independently, and compare with the copied snapshot. A mutable DrvFS worktree or the worker's own manifest/hash is not an attestation.
3. Run the model turn **outside** the short lifecycle critical section; re-enter the generation-bound gate for root-only broker consumption with real current-claim/hook predicates and separately sealed worker/reviewer slots. The existing tracer's Python `current=True` and `hook_ready=True` are test-only and cannot authorize execution. Reject cancellation, ambiguous pending generations, changed hashes and forged role/provenance.
4. Build a distinct trusted controller consumer, not a thin `ProcessSessionAdapter` switch. Implement/reconcile transactional allowed-path apply, controller-owned RED test commit then GREEN production commit, exact gate argv/regression, schema-checked `NodeResult`, independent reviewer verdict and settlement/usage. Inject crashes during apply and race cancel against seal/settle; fail closed on uncertain evidence.
5. Preserve existing Claude state-lock semantics, host behavior, and the Codex refusal in `src/sessions/preflight.ts` and CLI. Re-run WSL boundary/broker/bridge, Claude/security tests, typecheck and build. Independent adversarial acceptance is required before any production Codex activation; do not use the older mount-only findings or once-missing infrastructure as a new permission/login blocker.
