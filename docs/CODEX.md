# Codex planning plugin: discovery is not runtime support

**Status (local development branch, October 2026): planning-only.** Claude Code remains the executable host described in the README. Codex is **not** a supported worker, reviewer, verifier or delivery host. `CODEX_RUNTIME_DENIED` is unconditional for Codex controls, including generic CLI dispatch, session spawn, review settle, orchestration and delivery. A successful plugin install, `doctor`, graph validation or model-free test does not change that. Nothing here advertises a published Codex listing.

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

## Plan safely, then stop

The installed skills `mycelink-init`, `mycelink-prd`, `mycelink-plan`, `mycelink-status` guide the operator through planning; `mycelink-run`, `mycelink-resume`, `mycelink-verify`, `mycelink-deliver` explicitly refuse execution. Each skill resolves the **installed Codex plugin's own** `bin/mycelink.mjs`, not a launcher found on PATH or next to the Claude plugin. For a new, empty control path (not an existing Claude control):

```bash
node ./mycelink/codex-plugin/bin/mycelink.mjs codex init ../codex-control --json
node ./mycelink/codex-plugin/bin/mycelink.mjs doctor --control-root ../codex-control --json
# After writing an approved PRD and a reviewed graph using the skills:
node ./mycelink/codex-plugin/bin/mycelink.mjs graph validate FEAT-101 --control-root ../codex-control
node ./mycelink/codex-plugin/bin/mycelink.mjs codex status FEAT-101 --control-root ../codex-control --json
```

`codex init` is idempotent for an existing Codex control, refuses a Claude configuration or occupied Claude assets, and creates no `.claude/settings.json` hooks or `CLAUDE.md`. It does not generate or approve the PRD. `doctor` checks CLI version, login status (without printing credentials), isolated-profile plugin-list JSON, plugin/skill/launcher existence, hook emptiness and project `.codex/config.toml` syntax/policy warnings. Its overall exit is **not** a runtime grant and can be nonzero for missing repositories, login or denied runtime. A valid planning graph is not initialized execution state.

**Modes:** In Claude Code the interactive host-native `/mycelink:run` dispatches
host subagents, while the separate Claude standalone CLI adapter can spawn
`claude -p`. Codex's interactive plugin skills provide **planning and status
only**; they do not dispatch host subagents. The isolated `codex-cli` session
adapter has fake-executable tests but its production preflight denies. Neither
Codex mode is a migration target for a live Claude feature.

For a concrete model-free planning check, the ZIP-based test binds two approved PRD criteria to a compiled/validated graph and observes `runtime_enabled: false`; it does **not** drive a worker. The missing **CSET-202 / PCM-101 PRD → dispatch → worker → settle → delivery** acceptance path, independent reviewer/result provenance and actual cross-OS CI remain unverified. No real Codex worker, acceptance review, fresh verification or delivery is claimed.

## Permission and execution boundary

- The isolated adapter constructs `codex exec --json --cd <worktree> --sandbox workspace-write -c approval_policy=never --model <model> -` with a bounded prompt on stdin for **fake-executable tests only**. `codex exec -a never` was rejected by installed 0.163.0; the `-c` override is the observed form. The Codex non-interactive guide describes a read-only `codex exec` default, but effective policy may be layered by user/project/managed configuration; Mycelink sets **no** project sandbox or approval default. The adapter's explicit `workspace-write` and `approval_policy=never` are test invocation settings, **not safe production defaults**. The plugin installs no Codex hooks and ships no MCP server. Check the effective policy yourself; never use `danger-full-access`, extra writable directories or sandbox/approval bypass to turn on Mycelink execution.
- Codex's native Windows MXC command-profile probe allowed a write through a pre-existing hardlink inside an allowed directory to a forbidden result file, despite denying direct forbidden writes. It does not prove the worker created the alias, but defeats file-object confinement for that setup. An AppContainer whole-Codex launch failed before tool execution; neither result validates a whole-process fence.
- A configured MCP server wrote to scratch during a read-only Codex turn with explicit approval. Local shell sandbox policy alone cannot fence MCP/apps or seal output. Codex `PreToolUse` lacks proven per-call worker/reviewer identity and covered hook denials are not a fail-closed boundary for omitted/failing callbacks. An observed JSONL thread/final message and an unattended result slot are not independently authenticated role or reviewer provenance.
- Custom `.codex/agents/<role>.toml` values for `sandbox_mode`, `approval_policy` and `mcp_servers` do **not** override the parent's corresponding policies in the tagged 0.163.0 role implementation. Separate worktrees and role labels are not independent OS identities. The source checkout's `docs/CODEX_ORCA_ROLE_MATRIX.md` distinguishes observed behavior from unsupported inferences.

Activation would require a separately verified, mandatory whole-process/effect/filesystem boundary (including aliases and races), isolated MCP/apps/IPC, and generation-bound worker **and** reviewer channels across interruption and cleanup. These are not implemented. See [Permission model](PERMISSION_MODEL.md), [Threat model](THREAT_MODEL.md), and [Adapters](ADAPTERS.md).

## Migration, update and removal

Do **not** repoint or overwrite an existing Claude control by changing `provider` to `codex`; `codex init` refuses that migration. Preserve the Claude control and create a separate new Codex planning control; manually re-review PRD/graph contents and repository registrations. There is no supported automatic state, claim, result, hook or feature migration. Claude's update/re-init procedure remains separate. The removed Windows-to-WSL/DPAPI experiment is not an alternative runtime.

To refresh an isolated evaluation, first attempt removal in that **same** isolated `CODEX_HOME`, verify with `plugin list`, then update/re-extract the local ZIP and reinstall. Check your installed CLI's help; remove is advertised on this 0.163.0 installation, but the lifecycle test conditionally skips a CLI-rejected remove, so do not assume it succeeded. The marketplace-remove command below is likewise not independently verified by that test:

```bash
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin remove mycelink@mycelink-codex-marketplace
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin marketplace remove mycelink-codex-marketplace
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin list
```

Only after confirming that the path is **your disposable isolated home**, remove it and the extracted ZIP directory manually. Uninstall does not delete control repositories, `features/`, Git worktrees/branches, or any manually authored project config. Codex init installs no project or plugin-owned runtime hooks, so there are no Codex Mycelink hooks to clean up; never delete unrelated `.codex` or `.claude` entries. For Claude hook cleanup, follow the README's Claude-specific *Update and uninstall* section. Review local evidence before sharing; never paste auth files or raw model transcripts into an issue.
