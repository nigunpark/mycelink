# Isolated Codex host fixture boundary

The plugin suite creates a GUID-scoped `tests/.work/MycelinkCodexPluginE2E/runs/` tree at runtime, including a separate `CODEX_HOME`, HOME/USERPROFILE, temporary directories, unrelated project, release artifact, and Codex-only control. No real profile, auth/config, user project or model request is used.

**Real CLI discovery:** with `MYCELINK_LIVE_CODEX_PLUGIN=1`, Codex CLI 0.163.0 installs the released marketplace into that isolated profile; `plugin list`, optional `plugin details`, and read-only app-server `skills/list` inspect the installed plugin. Hooks are absent by design (`hooks/hooks.json` must not exist). The ZIP launcher exercises planning-only init and fail-closed commands without source or node_modules.

**Runtime SKIP, not acceptance:** production Codex preflight is unconditionally denied before a worker claim, including when a fake-provider/Claude override is supplied (`tests/integration/adapter-preflight.test.ts`). Therefore RED→GREEN→settle, acceptance-review verdict, interruption/reconcile/resume cannot currently run as a Codex E2E. Fake/host lifecycle tests elsewhere prove core mechanics only; they do not prove Codex worker, result-slot or reviewer provenance. Do not convert the fake path into an execution grant. Changesets CSET-202 and Petclinic PCM-101 PRD→delivery acceptance remain unproven.
