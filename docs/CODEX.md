# Codex plugin: experimental functional worker slice

**Status (local development branch, October 2026): experimental disposable worker slice, not a delivered Codex feature.** Claude Code remains the supported host described in the README. Explicit opt-in permits one Codex CLI worker orchestration cycle in registered repositories marked disposable; reviewer, resume, verification and delivery are still denied. A plugin install or model-free test is not real worker acceptance. See [functional acceptance ledger](CODEX_FUNCTIONAL_ACCEPTANCE.md). Nothing here advertises a published Codex listing.

Without explicit opt-in, runtime requests return `CODEX_RUNTIME_DENIED`. Opt-in never grants review or delivery.

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

## Plan, then opt in to a disposable single-node cycle

The installed skills `mycelink-init`, `mycelink-prd`, `mycelink-plan`, `mycelink-status` guide planning; `mycelink-run` permits one worker cycle only after explicit opt-in. `resume`, `verify` and `deliver` still refuse. Each skill resolves the **installed Codex plugin's own** launcher. For a new control path (not an existing Claude control):

```bash
node ./mycelink/codex-plugin/bin/mycelink.mjs codex init ../codex-control --json
node ./mycelink/codex-plugin/bin/mycelink.mjs doctor --control-root ../codex-control --json
# After writing an approved PRD and a reviewed graph using the skills:
node ./mycelink/codex-plugin/bin/mycelink.mjs graph validate FEAT-101 --control-root ../codex-control
node ./mycelink/codex-plugin/bin/mycelink.mjs codex status FEAT-101 --control-root ../codex-control --json
```

`codex init` is idempotent for an existing Codex control, refuses a Claude configuration or occupied Claude assets, and creates no `.claude/settings.json` hooks or `CLAUDE.md`. It does not generate or approve the PRD. `doctor` checks CLI version, login status (without printing credentials), isolated-profile plugin-list JSON, plugin/skill/launcher existence, hook emptiness and project `.codex/config.toml` syntax/policy warnings. Its overall exit is **not** a runtime grant and can be nonzero for missing repositories, login or denied runtime. A valid planning graph is not initialized execution state.

**Modes:** Claude interactive `/mycelink:run` dispatches host subagents; the standalone Claude adapter spawns `claude -p`. Codex's `mycelink-run` calls the packaged CLI and a standalone `codex exec` adapter, not host subagents. Opt in only on registered disposable Git repositories: set `experimental_codex` in the control config to `{"enabled":true,"disposable_repositories":["<all registered names>"]}`. Obtain controller authority with `controller open`, then call `codex run <feature> --authority <key> --control-root <control> --json`. It executes at most one orchestration cycle. It does not authorize review or delivery, and is not a migration path for a Claude feature.

For a graph worker model, `codex-default` delegates selection to the normal logged-in Codex profile (omits `--model`); other model strings are passed literally. The disposable ORD-101 attempt reached a real model turn, but the effective read-only policy denied command execution and the result-slot write, so the controller refused `RESULT_MISSING` and accepted no implementation. Do not disable policy to make that turn pass.

For a concrete model-free planning check, the ZIP-based test binds two approved PRD criteria to a compiled/validated graph and observes `runtime_enabled: false` without opt-in; it does **not** drive a worker. The missing **CSET-202 / PCM-101 PRD → dispatch → worker → settle → delivery** acceptance path and independent review remain unverified. A real Codex process was attempted, but no worker result, acceptance review, fresh verification or delivery was accepted.

## Permission and execution boundary

- The adapter constructs `codex exec --json --cd <worktree> --sandbox workspace-write --model <model> -` with bounded stdin; it does not override approval policy, add writable directories or accept extra flags. The plugin installs no Codex hooks or MCP server. Effective policy may be layered; use only disposable local repositories. No automatic network or push is configured by Mycelink; review declared gate commands for network effects before opt-in.
- Codex's native Windows MXC command-profile probe allowed a write through a pre-existing hardlink inside an allowed directory to a forbidden result file, despite denying direct forbidden writes. It does not prove the worker created the alias, but defeats file-object confinement for that setup. An AppContainer whole-Codex launch failed before tool execution; neither result validates a whole-process fence.
- A configured MCP server wrote to scratch during a read-only Codex turn with explicit approval. Local shell sandbox policy alone cannot fence MCP/apps or seal output. Codex `PreToolUse` lacks proven per-call worker/reviewer identity and covered hook denials are not a fail-closed boundary for omitted/failing callbacks. An observed JSONL thread/final message and an unattended result slot are not independently authenticated role or reviewer provenance.
- Custom `.codex/agents/<role>.toml` values for `sandbox_mode`, `approval_policy` and `mcp_servers` do **not** override the parent's corresponding policies in the tagged 0.163.0 role implementation. Separate worktrees and role labels are not independent OS identities. The source checkout's `docs/CODEX_ORCA_ROLE_MATRIX.md` distinguishes observed behavior from unsupported inferences.

The experiments above do not establish a hardened hostile-worker OS boundary and are not a prerequisite to the functional disposable-repository pilot. Worker results and reviewer verdicts still need end-to-end validation before a Codex delivery can be claimed. See [functional acceptance](CODEX_FUNCTIONAL_ACCEPTANCE.md), [Permission model](PERMISSION_MODEL.md), and [Adapters](ADAPTERS.md).

## Migration, update and removal

Do **not** repoint or overwrite an existing Claude control by changing `provider` to `codex`; `codex init` refuses that migration. Preserve the Claude control and create a separate new Codex planning control; manually re-review PRD/graph contents and repository registrations. There is no supported automatic state, claim, result, hook or feature migration. Claude's update/re-init procedure remains separate. The removed Windows-to-WSL/DPAPI experiment is not an alternative runtime.

To refresh an isolated evaluation, first attempt removal in that **same** isolated `CODEX_HOME`, verify with `plugin list`, then update/re-extract the local ZIP and reinstall. Check your installed CLI's help; remove is advertised on this 0.163.0 installation, but the lifecycle test conditionally skips a CLI-rejected remove, so do not assume it succeeded. The marketplace-remove command below is likewise not independently verified by that test:

```bash
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin remove mycelink@mycelink-codex-marketplace
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin marketplace remove mycelink-codex-marketplace
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin list
```

Only after confirming that the path is **your disposable isolated home**, remove it and the extracted ZIP directory manually. Uninstall does not delete control repositories, `features/`, Git worktrees/branches, or any manually authored project config. Codex init installs no project or plugin-owned runtime hooks, so there are no Codex Mycelink hooks to clean up; never delete unrelated `.codex` or `.claude` entries. For Claude hook cleanup, follow the README's Claude-specific *Update and uninstall* section. Review local evidence before sharing; never paste auth files or raw model transcripts into an issue.
