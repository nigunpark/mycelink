# Codex plugin: experimental functional worker slice

**Status (local development branch, October 2026): experimental disposable worker and review bridge, not an accepted delivered Codex feature.** Claude Code remains the supported host described in the README. Explicit opt-in permits bounded Codex CLI worker cycles in registered repositories marked disposable. An installed, fresh disposable ORD-101 pilot exercised two real read-only reviewer sessions: a reproduced AC-4 gap reopened web, and a test-first rework passed fresh re-review. This is bounded review acceptance, not reviewer OS-identity attestation or complete feature delivery. A test-first one-shot candidate/delivery component bridge is available only with a fresh held-authority `codex continue --review --deliver`; a new installed multi-repository delivery pilot has not passed. Resume, standalone verify and `codex deliver` remain denied. The source-only `docs/CODEX_FUNCTIONAL_ACCEPTANCE.md` ledger tracks the exact evidence. Nothing here advertises a published Codex listing.

Without explicit opt-in, runtime requests return `CODEX_RUNTIME_DENIED`. Opt-in alone does not establish review acceptance or grant delivery.

## Install and inspect in an isolated profile

The release ZIP contains a **separate** Codex marketplace (`.agents/plugins/marketplace.json`) and `codex-plugin/` with its own launcher/runtime and planning skills. The following is a local-ZIP evaluation, not an instruction to modify your real Codex profile. The commands shown use Git Bash; set `ISOLATED_CODEX_HOME` to a newly created **native absolute path outside any existing Codex profile or control repository**. Keep the extracted archive until after removal. Do not copy credentials into the isolated home.

```bash
npm ci && npm run package   # source checkout only; release ZIP needs no npm install
unzip artifacts/mycelink-0.3.0-beta.1.zip -d mycelink
mkdir -p "$ISOLATED_CODEX_HOME"  # set this variable to your disposable native absolute directory first
CODEX_HOME="$ISOLATED_CODEX_HOME" codex --version
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin marketplace add ./mycelink
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin list --available
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin add mycelink@mycelink-codex-marketplace
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin list
CODEX_HOME="$ISOLATED_CODEX_HOME" codex login status
```

The installed `codex-cli 0.163.0` was observed accepting marketplace add/list, plugin add/list and app-server `skills/list` against a disposable `CODEX_HOME`; eight enabled planning/denial skills were discovered. Its current `plugin --help` advertises remove, but the lifecycle test treats actual remove as conditional; a help entry is not proof that the uninstall completed. `codex doctor --json` checks its own configuration and may return exit 1 even when the plugin is present. `codex login status` in an unauthenticated isolated home is expected to fail; do not perform a Windows login or copy auth just for this guide. Version/command observations do not promise compatibility with other versions. The source checkout's `docs/CODEX_COMPATIBILITY.md` holds the bounded CLI probes; do not mistake a branch-local result for a published release.

## Plan, then opt in to disposable bounded worker cycles

The installed skills `mycelink-init`, `mycelink-prd`, `mycelink-plan`, `mycelink-status` guide planning; `mycelink-run` describes bounded worker cycles only after explicit opt-in. `resume`, `verify` and `deliver` still refuse. Each skill resolves the **installed Codex plugin's own** launcher. For a new control path (not an existing Claude control):

```bash
node ./mycelink/codex-plugin/bin/mycelink.mjs codex init ../codex-control --json
node ./mycelink/codex-plugin/bin/mycelink.mjs doctor --control-root ../codex-control --json
# After writing an approved PRD and a reviewed graph using the skills:
node ./mycelink/codex-plugin/bin/mycelink.mjs graph validate FEAT-101 --control-root ../codex-control
node ./mycelink/codex-plugin/bin/mycelink.mjs codex status FEAT-101 --control-root ../codex-control --json
```

`codex init` is idempotent for an existing Codex control, refuses a Claude configuration or occupied Claude assets, and creates no `.claude/settings.json` hooks or `CLAUDE.md`. It does not generate or approve the PRD. `doctor` checks CLI version, login status (without printing credentials), isolated-profile plugin-list JSON, plugin/skill/launcher existence, hook emptiness and project `.codex/config.toml` syntax/policy warnings. Its overall exit is **not** a runtime grant and can be nonzero for missing repositories, login or denied runtime. A valid planning graph is not initialized execution state.

**Modes:** Claude interactive `/mycelink:run` dispatches host subagents; the standalone Claude adapter spawns `claude -p`. Codex's `mycelink-run` calls the packaged CLI and a standalone `codex exec` adapter, not host subagents. Opt in only on registered disposable Git repositories: set `experimental_codex` in the control config to `{"enabled":true,"disposable_repositories":["<all registered names>"]}`. On a fresh Codex control with no authority already open, `codex continue <feature> --max-nodes 2 --control-root <control> --json` opens a private key in the controller process, initializes the validated graph if needed, and runs up to two sequential worker cycles; it stops on a node failure or missing schedule. Bounds are 1–8. Optional `--review` holds the same private key for separate read-only reviews and, after GAPS, bounded producer rework and a fresh review. It defaults to three total worker invocations and two reviews; `--max-nodes` (1–8) and `--max-reviews` (1–3) are total budgets, not per-round allowances. GAPS with exhausted budget return nonzero, never PASS. The real-model review/rework path passed its bounded installed pilot; `--deliver` is a new, separately unaccepted one-shot extension that requires `--review` and a fresh PASS. Continuation never recovers, takes over or accepts an existing key. If the host already holds an authority key, `codex run <feature> --authority <key> --control-root <control> --json` runs one cycle; `codex review <feature> --authority <key>` requests a review only when the existing graph is ready. The host must retain that key for later cycles. Do not start a fresh one-shot caller that discards it.

For a graph worker model, `codex-default` delegates selection to the normal logged-in Codex profile (omits `--model`); other model strings are passed literally. The earlier native Windows MXC disposable ORD-101 attempt reached a model turn but could not run its toolchain or write its result slot; the later WSL standard `workspace-write` transport completed separate API and web worker nodes in fresh disposable clones. `codex continue ORD-101 --review --deliver` is a new one-shot path: only after a fresh PASS in the same held-authority call does the controller run the graph's candidate node and existing preflighted delivery engine, with independent post-delivery test commands. This path has passed a fake-review single-repository component fixture but **not** a newly installed real-model multi-repository pilot. Delivery across independent Git repositories is not atomic; on failure the engine journals rollback and explicit partial failure, never a push. Neither worker acceptance nor a `turn.completed` authorizes delivery; see the evidence ledger. Do not disable policy to force a worker turn.

The ZIP-based planning test binds approved PRD criteria to a validated graph and observes `runtime_enabled: false` without opt-in; it does **not** drive a worker. Separate installed WSL ORD-101 pilots accepted disposable implementation nodes with fresh verification and a real per-criterion GAP → producer rework → fresh PASS review. The controller-owned candidate/delivery component bridge still needs an installed multi-repository acceptance run; crash-resume and scale gates are independent. **CSET-202 / PCM-101** remain unverified.

## Permission and execution boundary

- The adapter constructs `codex exec --json --cd <worktree> --sandbox workspace-write --model <model> -` with bounded stdin; on Windows, *only after validated disposable-repository opt-in*, it adds the supported `-c windows.sandbox=mxc` setting. It does not override approval policy, add writable directories or accept extra flags. The plugin installs no Codex hooks or MCP server. Effective policy may be layered; use only disposable local repositories. No automatic network or push is configured by Mycelink; review declared gate commands for network effects before opt-in. The first real MXC worker still failed to start PowerShell commands (`0xC0000142`) and did not submit a result; see the acceptance ledger. This is not a successful worker or an OS confinement certificate.
- An experimental alternative on Windows is `experimental_codex.wsl: {"distribution":"Ubuntu","user":"psh09"}` alongside the normal disposable-repository registration. This starts `wsl.exe -d Ubuntu -u psh09 -- /usr/local/bin/npx --yes @openai/codex@0.163.0 exec` with the conventional `workspace-write` sandbox, mapped `C:\\...` worktree directory and stdin prompt. It does not copy credentials or alter a real profile. The first disposable ORD-101 run failed because Windows-created Git worktree `.git` pointers and Windows-absolute gate commands were not executable from Linux; later relative pointers and a controller-owned gate/Git mailbox passed an installed, fresh two-node disposable pilot. WSL Codex reviewer checkouts now use the same relative Git metadata; the real read-only reviewer used exact per-command repository trust, not global or wildcard trust. This is functional acceptance of the bounded worker/review slice, not proof of Linux child process-tree cancellation or OS confinement.
- Codex's native Windows MXC command-profile probe allowed a write through a pre-existing hardlink inside an allowed directory to a forbidden result file, despite denying direct forbidden writes. It does not prove the worker created the alias, but defeats file-object confinement for that setup. An AppContainer whole-Codex launch failed before tool execution; neither result validates a whole-process fence.
- A configured MCP server wrote to scratch during a read-only Codex turn with explicit approval. Local shell sandbox policy alone cannot fence MCP/apps or seal output. Codex `PreToolUse` lacks proven per-call worker/reviewer identity and covered hook denials are not a fail-closed boundary for omitted/failing callbacks. An observed JSONL thread/final message and an unattended result slot are not independently authenticated role or reviewer provenance.
- Custom `.codex/agents/<role>.toml` values for `sandbox_mode`, `approval_policy` and `mcp_servers` do **not** override the parent's corresponding policies in the tagged 0.163.0 role implementation. Separate worktrees and role labels are not independent OS identities. The source checkout's `docs/CODEX_ORCA_ROLE_MATRIX.md` distinguishes observed behavior from unsupported inferences.

The experiments above do not establish a hardened hostile-worker OS boundary and are not a prerequisite to the functional disposable-repository pilot. Worker results and reviewer verdicts still need end-to-end validation before a Codex delivery can be claimed. The source-only `docs/CODEX_FUNCTIONAL_ACCEPTANCE.md` records pilot results; see also [Permission model](PERMISSION_MODEL.md) and [Adapters](ADAPTERS.md).

## Migration, update and removal

Do **not** repoint or overwrite an existing Claude control by changing `provider` to `codex`; `codex init` refuses that migration. Preserve the Claude control and create a separate new Codex planning control; manually re-review PRD/graph contents and repository registrations. There is no supported automatic state, claim, result, hook or feature migration. Claude's update/re-init procedure remains separate. The removed Windows-to-WSL/DPAPI experiment is not an alternative runtime.

To refresh an isolated evaluation, first attempt removal in that **same** isolated `CODEX_HOME`, verify with `plugin list`, then update/re-extract the local ZIP and reinstall. Check your installed CLI's help; remove is advertised on this 0.163.0 installation, but the lifecycle test conditionally skips a CLI-rejected remove, so do not assume it succeeded. The marketplace-remove command below is likewise not independently verified by that test:

```bash
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin remove mycelink@mycelink-codex-marketplace
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin marketplace remove mycelink-codex-marketplace
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin list
```

Only after confirming that the path is **your disposable isolated home**, remove it and the extracted ZIP directory manually. Uninstall does not delete control repositories, `features/`, Git worktrees/branches, or any manually authored project config. Codex init installs no project or plugin-owned runtime hooks, so there are no Codex Mycelink hooks to clean up; never delete unrelated `.codex` or `.claude` entries. For Claude hook cleanup, follow the README's Claude-specific *Update and uninstall* section. Review local evidence before sharing; never paste auth files or raw model transcripts into an issue.
