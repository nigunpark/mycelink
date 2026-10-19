# Codex 0.163.0 × Orca: bounded configuration/isolation matrix

Checked 2026-10-19 KST on installed **`codex-cli 0.163.0`**, native Windows, in this clean worktree. **Decision: DENY production Codex preflight; original PRD end-to-end is not done.** This is a configuration spike, not a Mycelink security certification.

## Important correction to the proposed correction

The task hypothesis says `.codex/agents/<role>.toml` can replace `sandbox_mode` and `mcp_servers` for a child. **The currently served OpenAI Subagents guide says the opposite:** custom agents inherit the parent's sandbox, approvals, provider, and MCP servers; `sandbox_mode`, `approval_policy`, `model_provider`, and `mcp_servers` in a custom role file do **not** override the parent. It says an instruction to avoid edits is not a separate read-only sandbox. This is corroborated by the tagged **0.163.0 source**: the role loader discovers standalone files under project/user `agents/`, but `apply_role_to_config` constructs a bounded `AgentRoleOverrides` containing instructions, model/effort, selected *disable-only* features, and skills—**not** sandbox, approvals, or MCP. Parsing/accepting a TOML key is not evidence that the role applies it. [1][2][3]

Supported shape (project-scoped; `name`, `description`, `developer_instructions` required; feature disables are capability reductions, **not** a filesystem boundary): [1][2][3]

```toml
# .codex/agents/reviewer.toml
name = "reviewer"
description = "Find correctness and security defects"
developer_instructions = "Review without edits; report findings with evidence."
[features]
shell_tool = false
apps = false
```

Parent-level settings belong in `.codex/config.toml` or in the CLI invocation, not a child role. A **separate** reviewer process can be launched with its own `-s read-only` and a distinct `-C <review-worktree>`; that is different from `spawn_agent(agent_type="reviewer")` in a workspace-write parent. The CLI advertises `codex exec -C <dir> -s read-only|workspace-write -c approval_policy=never --json --ephemeral`. Do not use `--dangerously-bypass-approvals-and-sandbox`. The CLI's `-p/--profile` layers a *user session config*, not a subagent role. [1][4]

## Disposable matrix (actual invocation and observations)

Reproduce with `python tests/security/codex-role-config-matrix.py`; optional authenticated branch: `MYCELINK_LIVE_CODEX_ROLE_MATRIX=1 python tests/security/codex-role-config-matrix.py`. The script creates two disposable roots and an isolated `CODEX_HOME` **inside this checkout**, uses app-server `initialize`, `config/read`, ephemeral `thread/start` and `debug prompt-input`, optionally copies existing auth **into the disposable home only**, and deletes that copy and the whole scratch tree. No real Codex config was modified. Only fixed scratch markers were offered; the script prints event *types* and file names, not credentials or model prose. Authenticated calls require the existing local login, consume provider usage, and are not necessary to reproduce the offline part.

| Case | Observed here | Boundary inference |
|---|---|---|
| Parser/project config in work-a and work-b | Both `config/read` replies succeeded; each returned 3 layers, `[agents].max_concurrent_threads_per_session = 2`, and zero **parent** MCP servers. The work-a role file includes `sandbox_mode="read-only"` and a disabled dummy `[mcp_servers.role_probe]`; work-b has a different `worker` role plus a deliberately malformed `invalid` negative control. `doctor`'s `config.load` was `ok`, but its **overall exit was 1** (do not count it as a pass). `debug prompt-input` succeeded but contained neither role name; no malformed-role warning reached app-server stderr. | Parent TOML parsing and per-directory layer resolution observed; role discovery / child override effectiveness **not established by these read-only RPCs**. Tagged parser/loader source establishes the intended role discovery and bounded override code path. |
| Requested workspace-write parent | Both app-server `thread/start` requests returned matching scratch `cwd`, `approvalPolicy=never`, but the returned effective sandbox was **`readOnly`, `networkAccess=false`**, despite a workspace-write request and user config. | This host has an enclosing/managed read-only effect; do not attribute this to role TOML or Codex's native sandbox. |
| Authenticated `codex exec -C work-a` with nested `reviewer` and shell/patch markers | Three bounded runs: first exit **1** with `turn.failed` after one agent message; later runs exit **0** with `turn.completed`. One later run emitted completed `collab_tool_call` items, but no shell/patch marker was created and no child role/sandbox identity was authenticated in the event summary. Stderr mentioned read-only. | Provider/host refusal/no-action response prevents the parent-vs-child sandbox test; **inconclusive**, not a passing reviewer boundary. |
| Authenticated benign custom-role discovery request | A separate read-only request to spawn `reviewer` and read the scratch marker produced `collab_tool_call` items whose recorded `tool` was `wait`, without an exposed agent-type field; no marker changed. | `wait`/model prose does not attest that the intended custom role was discovered or that it received any independent sandbox or MCP policy. |
| Authenticated separate `codex exec -C work-b` | Both runs exited **0** with `thread.started`, `turn.started`, two agent messages and `turn.completed`; **no marker created**, no tool event. The two pre-existing `marker.txt` files remained unchanged, and scratch cleanup succeeded. | Separate process/working-root launch observed; no writable-worktree success, cross-worktree denial, shell enforcement, or role provenance proved. An exit-0 model turn without a requested write is not a successful action. |
| MCP/app effect isolation | No new MCP/app tool call in this matrix. Previous isolated read-only Codex probe documented `tools/call` writing a scratch marker through a parent-configured stdio MCP server with explicit approval, while a shell write was rejected under the enclosing read-only policy. [5] | `read-only` shell policy is not a blanket restriction on MCP servers/apps. Permissions guide explicitly separates local command profiles from MCP, connectors, browser, web search and service traffic. [6] |
| Hooks / protected result slots | Not retested on protected files. Previous MXC test: direct forbidden write denied, **preexisting hardlink alias to forbidden result wrote through**; AppContainer whole Codex executable failed during startup before any tool call. [5][7] | A worktree or per-role config does not resolve aliases/TOCTOU, independent process identity, all-tool interception, or sealed result/reviewer provenance. Hooks may opt out and malformed/timed-out callbacks may fail without blocking the tool. [8] |

**Orca comparison:** Orca launches Codex in the selected worktree's cwd and displays nested Task subagents as *child rows in the parent terminal*; its supervised `worker-start --task ... --worktree new-child --agent codex` models Runs, Tasks, Dispatches, messages and decision gates. Worktrees provide separate checkouts/branches, not an OS security sandbox. Orca's documented **default launch uses Codex's `--dangerously-bypass-approvals-and-sandbox`**; choose Manual/custom arguments before any Mycelink experiment, but Manual does not by itself establish Mycelink's fence. Its per-workspace VM/remote modes could host a *separately verified* external identity/filesystem/network boundary; the Orca documentation does not attest the Mycelink result/reviewer contract. [9][10][11][12][13]

**Answer for Mycelink:** Orca-style separate worktree processes improve operational separation and give per-invocation config options, but neither Orca's UI/dispatch IDs nor Codex's nested role labels authenticate a claim/generation's output. This repo's JSONL/process-tagged record explicitly treats the worker slot as *unattested* and reviewer verdict as null; no production claim/result/reviewer provenance was proven. Keep `preflightAdapter` DENY. [5][8]

**Minimal next PoC:** In a truly independently isolated disposable host (not this read-only overlay), launch controller, worker, and reviewer as separately identified `codex exec -C` processes with isolated OS identities/mounts and isolated auth/config; default-deny shell, apply_patch, MCP/apps and network, expose only a constrained proposal broker, and seal claim/generation-scoped result/verdict channels outside model reach. First prove a writable positive control, then cross-worktree, preexisting/post-launch hardlink/junction/ADS/race attempts, unexpected tool paths, broker crash and hook failure, forbidden result/verdict writes, and interruption/replay. Retain transcript and filesystem/process readbacks. Do not activate the production adapter on a passing prompt or worktree test alone. [5][6][8]

## Sources

[1] OpenAI, [Subagents](https://developers.openai.com/codex/subagents) (current served page, checked 2026-10-19 KST).
[2] OpenAI, [0.163.0 role override implementation](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/agent/role.rs#L36-L126).
[3] OpenAI, [0.163.0 role loader/parser](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/agent-roles/src/loader.rs#L25-L115) and [parser](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/agent-roles/src/agent_role_config.rs#L38-L115).
[4] OpenAI, [CLI reference](https://developers.openai.com/codex/cli/reference) and installed `codex exec --help`, `codex --version`.
[5] Local [Codex compatibility decision record](CODEX_COMPATIBILITY.md), including reproducible negative tests and Task 8 provenance caveat.
[6] OpenAI, [Permissions](https://developers.openai.com/codex/permissions).
[7] Local [AppContainer startup probe](../tests/security/windows-appcontainer-codex-probe.md).
[8] OpenAI, [Hooks](https://developers.openai.com/codex/hooks).
[9] Orca official source, [Codex integration](https://github.com/stablyai/orca/blob/966832793b8611945aeb8deebe9f0e7cefeae9cb/docs/site/content/docs/agents/codex.mdx).
[10] Orca official source, [Supported agents and permission defaults](https://github.com/stablyai/orca/blob/966832793b8611945aeb8deebe9f0e7cefeae9cb/docs/site/content/docs/agents/supported.mdx).
[11] Orca official source, [Orchestration](https://github.com/stablyai/orca/blob/966832793b8611945aeb8deebe9f0e7cefeae9cb/docs/site/content/docs/cli/orchestration.mdx).
[12] Orca official source, [Worktrees](https://github.com/stablyai/orca/blob/966832793b8611945aeb8deebe9f0e7cefeae9cb/docs/site/content/docs/model/worktrees.mdx).
[13] Orca official source, [Ways to run](https://github.com/stablyai/orca/blob/966832793b8611945aeb8deebe9f0e7cefeae9cb/docs/site/content/docs/ways-to-run.mdx).

Orca's docs-site source was fetched at the pinned upstream commit because the requested website host was not resolvable from this environment; these are the project's official repository pages, not a third-party mirror. Verification on this checkout: model-free matrix exit 0 with scratch removed; opt-in authenticated matrix exit 0 with scratch removed (individual Codex turns above were mixed); `npx vitest run tests/security/codex-cli-contract.test.ts tests/security/codex-host-fence.test.ts --config vitest.config.ts` exited 0 (**10 passed, 1 skipped**). These are not E2E approval tests.
