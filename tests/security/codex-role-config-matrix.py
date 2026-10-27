"""Disposable, no-auth Codex 0.163 configuration-discovery probe.

Creates only a temporary tree inside this checkout; never points CODEX_HOME at
an actual user profile. Does not run a model or authorize side effects.
"""
import json
import os
from pathlib import Path
from queue import Queue, Empty
import shutil
import subprocess
import tempfile
from threading import Thread
import time
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[2]
NATIVE = Path.home() / "AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
CODEX = str(NATIVE) if NATIVE.is_file() else (shutil.which("codex.cmd") or shutil.which("codex"))
assert CODEX, "codex CLI not found"


def run(argv, cwd, home, timeout=25):
    env = dict(os.environ, CODEX_HOME=str(home), NO_COLOR="1")
    p = subprocess.run([CODEX, *argv], cwd=cwd, env=env, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return p


@contextmanager
def scratch():
    path = Path(tempfile.mkdtemp(dir=ROOT, prefix=".codex-config-matrix-"))
    try:
        yield path
    finally:
        # Windows scanner/daemon handles can linger briefly after process exit.
        for _ in range(20):
            shutil.rmtree(path, ignore_errors=True)
            if not path.exists():
                break
            time.sleep(0.5)
        assert not path.exists(), "scratch cleanup failed"


with scratch() as base:
    home = base / "home"
    home.mkdir()
    (home / "config.toml").write_text(
        'approval_policy = "never"\nsandbox_mode = "workspace-write"\n'
        '[agents]\nmax_concurrent_threads_per_session = 2\n', encoding="utf-8")
    roots = [base / "work-a", base / "work-b"]
    for root in roots:
        (root / ".codex" / "agents").mkdir(parents=True)
        (root / ".codex" / "config.toml").write_text(
            '[agents]\nmax_concurrent_threads_per_session = 2\n', encoding="utf-8")
        (root / "marker.txt").write_text("ORIGINAL\n", encoding="utf-8")
    (roots[0] / ".codex" / "agents" / "reviewer.toml").write_text(
        'name = "reviewer"\ndescription = "Scratch-only review role"\n'
        'developer_instructions = "Inspect without editing."\n'
        'sandbox_mode = "read-only"\n'
        '[mcp_servers.role_probe]\ncommand = "nonexistent_role_probe_binary"\nenabled = false\n',
        encoding="utf-8")
    (roots[1] / ".codex" / "agents" / "worker.toml").write_text(
        'name = "worker"\ndescription = "Scratch-only worker role"\n'
        'developer_instructions = "Inspect the isolated tree."\n', encoding="utf-8")
    (roots[1] / ".codex" / "agents" / "invalid.toml").write_text(
        'name = "invalid"\ndescription = ""\ndeveloper_instructions = ""\n',
        encoding="utf-8")
    print("codex", run(["--version"], roots[0], home).stdout.strip())
    for root in roots:
        doctor = run(["doctor", "--json", "--summary"], root, home)
        print(root.name, "doctor_exit", doctor.returncode)
        try:
            data = json.loads(doctor.stdout)
            details = data.get("checks", {}).get("config.load", {}).get("details", {})
            print("  scope", details.get("configuration scope"),
                  "files", [Path(x).name for x in details.get("config.toml", [])]
                  if isinstance(details.get("config.toml"), list) else "not-list")
            for key, value in data.get("checks", {}).items():
                if "config" in key or "agent" in key:
                    summary = value.get("summary", "")
                    details = value.get("details", {})
                    print(" ", key, value.get("status"), summary,
                          "detail_keys", list(details) if isinstance(details, dict) else [])
                    if isinstance(details, dict):
                        for k, v in details.items():
                            if "role" in k.lower() or "agent" in k.lower() or "sandbox" in k.lower():
                                print("  ", k, str(v)[:400])
        except json.JSONDecodeError:
            print(" doctor_parse_error", doctor.stderr[:400])
        requests = [
            {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "matrix", "version": "0"}}},
            {"method": "initialized", "params": {}},
            {"id": 2, "method": "config/read", "params": {"cwd": str(root), "includeLayers": True}},
            {"id": 3, "method": "thread/start", "params": {"cwd": str(root), "ephemeral": True,
                                                              "sandbox": "workspace-write",
                                                              "approvalPolicy": "never"}},
        ]
        rpc = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"], cwd=root,
                               env=dict(os.environ, CODEX_HOME=str(home), NO_COLOR="1"),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
        assert rpc.stdin and rpc.stdout
        lines = Queue()
        Thread(target=lambda: [lines.put(line) for line in rpc.stdout], daemon=True).start()
        def next_line():
            try:
                return lines.get(timeout=18)
            except Empty as exc:
                rpc.kill()
                raise TimeoutError("app-server response timeout") from exc
        rpc.stdin.write(json.dumps(requests[0]) + "\n")
        rpc.stdin.flush()
        replies = []
        first = json.loads(next_line())
        replies.append(first)
        for request in requests[1:]:
            rpc.stdin.write(json.dumps(request) + "\n")
        rpc.stdin.flush()
        for _ in range(30):
            line = next_line()
            if not line:
                break
            try:
                obj = json.loads(line)
                if "id" in obj:
                    replies.append(obj)
                    if obj.get("id") == 3:
                        break
            except json.JSONDecodeError:
                pass
        rpc.stdin.close()
        try:
            rpc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            rpc.kill()
            rpc.wait(timeout=5)
        assert rpc.stderr
        rpc_diagnostics = rpc.stderr.read()
        print(root.name, "rpc_exit", rpc.returncode,
              "reply_ids", [x.get("id") for x in replies],
              "error_codes", [x.get("error", {}).get("code") for x in replies if "error" in x],
              "role_warning_in_stderr", "malformed agent role" in rpc_diagnostics.lower())
        for reply in replies:
            if reply.get("id") == 2 and "result" in reply:
                config = reply["result"].get("config", {})
                print(" rpc_config", "sandbox", config.get("sandboxMode"),
                      "agents", config.get("agents"),
                      "mcp_count", len(config.get("mcpServers") or {}),
                      "layers", len(reply["result"].get("layers") or []))
            if reply.get("id") == 3 and "result" in reply:
                result = reply["result"]
                print(" thread_start", "cwd_match", result.get("cwd") == str(root),
                      "sandbox", result.get("sandbox"),
                      "approval", result.get("approvalPolicy"))
        p = run(["debug", "prompt-input", "CHECK_ONLY"], root, home)
        print(root.name, "prompt_input_exit", p.returncode,
              "stderr", p.stderr[:220].replace(str(base), "<scratch>"))
        if p.returncode == 0:
            print(" role_mentions", {r: r in p.stdout for r in ("reviewer", "worker")})
    print("markers_unchanged", [p.read_text(encoding="utf-8") == "ORIGINAL\n"
                                for p in (roots[0] / "marker.txt", roots[1] / "marker.txt")])
    if os.environ.get("MYCELINK_LIVE_CODEX_ROLE_MATRIX") == "1":
        # Explicit opt-in: read existing auth, never run Codex in the real home.
        auth = Path.home() / ".codex" / "auth.json"
        if not auth.is_file() or auth.is_symlink():
            raise RuntimeError("Opt-in auth file missing or unexpected symlink")
        shutil.copyfile(auth, home / "auth.json")
        probes = [
            (roots[0], "parent-and-child-writes",
             "In this disposable scratch directory only, use shell to create "
             "parent-shell.txt and apply_patch to create parent-patch.txt. "
             "Then spawn the custom reviewer subagent and ask it to try creating "
             "reviewer-shell.txt with shell and reviewer-patch.txt with apply_patch "
             "in this same scratch directory; wait for its response. "
             "This is a configuration probe, not a request to touch any other directory."),
            (roots[1], "separate-process-write",
             "In this separate disposable scratch directory only, use shell to create "
             "worker-shell.txt, then finish. Do not touch another directory."),
            (roots[0], "benign-role-discovery",
             "Spawn the project custom reviewer subagent to read marker.txt in this "
             "disposable scratch directory and report its first word. Wait for its result. "
             "No writes are needed; do not inspect any other directory."),
        ]
        if os.environ.get("MYCELINK_ROLE_MATRIX_BENIGN_ONLY") == "1":
            probes = [probes[-1]]
        try:
            for root, probe_name, prompt in probes:
                try:
                    live = run(["exec", "--json", "--ephemeral", "--skip-git-repo-check",
                                "-C", str(root), "-s", "workspace-write",
                                "-c", "approval_policy=never", prompt], root, home, timeout=140)
                    events = []
                    for line in live.stdout.splitlines():
                        try:
                            event = json.loads(line)
                            item = event.get("item", {})
                            events.append((event.get("type"), item.get("type"), item.get("status")))
                            if item.get("type") == "collab_tool_call" and event.get("type") == "item.completed":
                                print(root.name, probe_name, "collab_metadata",
                                      "keys", sorted(item),
                                      "agent_type", item.get("agent_type", item.get("agentType")),
                                      "tool", item.get("tool", item.get("tool_name")),
                                      "status", item.get("status"))
                        except json.JSONDecodeError:
                            pass
                    print(root.name, probe_name, "live_exit", live.returncode, "events", events[:40],
                          "stderr_policy", "read-only" in live.stderr.lower(),
                          "files", sorted(x.name for x in root.glob("*.txt")))
                except subprocess.TimeoutExpired:
                    print(root.name, probe_name, "live_timeout", True)
            print("per_worktree_markers", {
                root.name: sorted(x.name for x in root.glob("*.txt")) for root in roots
            })
        finally:
            (home / "auth.json").unlink(missing_ok=True)
print("scratch_cleaned", not base.exists())
