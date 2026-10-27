# Native Windows whole-process Codex AppContainer probe — blocked

This is **not** a production wrapper or a passing security boundary. The adjacent Python script launches the actual installed native `codex.exe` (copied byte-for-byte into a disposable scratch directory) using a temporary, zero-capability AppContainer profile and `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` and an explicit inherited standard-handle list. It never uses the real Codex home or credentials. The only modified ACL belongs to the scratch directory. `DeleteAppContainerProfile` and scratch-directory removal run in `finally`.

## Reproduce on the tested host

Windows 11 build 26200.9711; native Codex CLI 0.163.0. Python with ctypes, `icacls`, and the installed global `@openai/codex` optional win32-x64 package are required. No admin, login, WSL, DPAPI, firewall change, or model request.

```bash
PROBE_EXE=C:/Windows/System32/cmd.exe PROBE_ARGS='/c echo control-ok' python tests/security/windows-appcontainer-codex-probe.py
python tests/security/windows-appcontainer-codex-probe.py
```

Observed on this host (fresh unique profile and scratch directory for **each** invocation):

| Check | Observed | Verdict |
| --- | --- | --- |
| AppContainer profile creation | HRESULT `0x00000000` | PASS |
| Scratch SID ACL grant | `icacls` exit 0 | PASS |
| Bounded inherited std-handle list | `UpdateProcThreadAttribute` succeeds; stdout/stderr only to scratch capture | PASS (configuration, not exfiltration test) |
| Whole `cmd.exe /c echo control-ok` control launch | `CreateProcessW=True`, GetLastError=0; exit `0x0`; captured `control-ok` | PASS |
| Whole native `codex.exe --version` launch | `CreateProcessW=True`, GetLastError=0; process exit `0xc0000142` (`STATUS_DLL_INIT_FAILED`); empty capture; assertion exit 1 | **FAIL (RED)** |
| Profile deletion and scratch removal | `DeleteAppContainerProfile` HRESULT `0x0`; `scratch_cleaned True` on both runs; 0 remaining `appcontainer-*` directories | PASS |
| Allowed workspace proposal; direct forbidden path; existing hardlink alias; inherited forbidden FD; descendant escape; network/fake MCP; result/reviewer files | **Not run** because the *whole Codex executable* fails at startup, before a tool/MCP or model-free proposal can run | NOT PROVEN |
| Authenticated API request | Not attempted; no credentials copied or brokered | NOT PROVEN |

The non-sandboxed native `codex.exe --version` copied into another clean scratch directory, with similarly minimal environment and redirected standard handles, exited 0 and printed `codex-cli 0.163.0`. The same copy without a console (`CREATE_NO_WINDOW`) also exited 0, ruling out those two basic setup differences, but **not identifying which DLL initialization fails in AppContainer**. `CreateProcessW` itself did not return an API error: the precise observed failure is the child NTSTATUS `0xc0000142`. Do not call this a working wrapper.

Microsoft documents AppContainer profile support from Windows 8 and the `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` launch attribute. AppContainer without network capability cannot establish the live Codex API connection; broad Internet capability would not, by itself, prove MCP egress restrictions. A restricted token's SID/privilege restrictions alone do not demonstrate per-endpoint network confinement. The `processmodel.dll` exports `Experimental_CreateProcessInSandbox` and `Experimental_CreateProcessAsUserInSandbox` exist on this host, but export presence is not a validated/documented callable contract, and they were not invoked. No global feature activation was attempted.

References: [CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile), [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation), [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken).

**Gate:** do not enable native Codex, do not run Changesets/Petclinic pilots, and do not claim PRD E2E. Further investigation requires a safe way to initialize the *actual Codex process* in a confined context plus an authenticated API/MCP egress contract; only then start RED→GREEN whole-process attack cases. The experiment is deliberately not imported by production or default test runners.
