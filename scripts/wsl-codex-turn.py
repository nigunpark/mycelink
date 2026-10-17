#!/usr/bin/env python3
"""Experimental registered, isolated Codex + scoped bridge turn; never applies a proposal.

Only the trusted Windows claim controller may start this as the registered
WSL process. A successful process receipt is NOT broker seal or settlement.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path('/var/lib/mycelink-codex')
TOKEN = re.compile(r'[A-Za-z0-9_-]{1,100}\Z')
WORKER = ROOT / 'pkg/node_modules'
AUTH = Path('/home/psh09/.codex/auth.json')


def private_directory(path):
    if path.is_symlink():
        raise ValueError('replaceable private directory')
    if not path.exists():
        path.mkdir(mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError('private directory must be root-owned and inaccessible')


def run(args):
    if os.geteuid() != 0 or not TOKEN.fullmatch(args.claim) or not TOKEN.fullmatch(args.generation):
        raise ValueError('trusted root and generation identifiers required')
    if not 1 <= len(args.prompt.encode('utf-8')) <= 16_384:
        raise ValueError('prompt outside bounded turn')
    if len(args.proposal_path) > 16 or len(set(args.proposal_path)) != len(args.proposal_path) or len({p.casefold() for p in args.proposal_path}) != len(args.proposal_path):
        raise ValueError('duplicate or oversized proposal path grant')
    for path in args.proposal_path:
        if (not re.fullmatch(r'[A-Za-z0-9_./-]{1,240}', path) or
            any(not part or part.startswith('.') or part.endswith(('.', ' ')) or part.casefold() in ('mycelink', 'result.json', 'verdict.json', '_receipt.json')
                for part in path.split('/'))):
            raise ValueError('unsafe proposed source path')
    if not args.source.startswith(str(ROOT / 'claims/source-')) or not args.source.endswith('/snapshot'):
        raise ValueError('immutable staged source required')
    if args.manifest != args.source[:-len('/snapshot')] + '/manifest.json':
        raise ValueError('source manifest does not match staged source')
    # The supervisor signals the entire registered process group. Do not let
    # its SIGTERM take the default exit path: it would bypass the bridge/runtime
    # finally clause and strand root-owned sockets after a cancelled turn.
    def cancelled(_signal, _frame):
        raise InterruptedError('registered Codex generation revoked')
    signal.signal(signal.SIGTERM, cancelled)
    transport = ROOT / 'transport'
    private_directory(transport)
    # The worker launcher reserves the role slot; this directory is never
    # replaced/replayed by a second turn in the same generation.
    runtime = Path(tempfile.mkdtemp(prefix='turn-', dir=ROOT / 'claims'))
    runtime.chmod(0o711)
    principal = pwd.getpwnam('psh09')
    worker = pwd.getpwnam('mycelink-codex-worker')
    reviewer = pwd.getpwnam('mycelink-codex-reviewer')
    if reviewer.pw_uid == worker.pw_uid:
        raise ValueError('independent reviewer principal required')
    bridge = None
    try:
        def stop_bridge():
            nonlocal bridge
            if bridge is not None and bridge.poll() is None:
                bridge.terminate()
                try:
                    bridge.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    bridge.kill()
                    bridge.wait(timeout=3)
            bridge = None

        def start_bridge(role, identity):
            nonlocal bridge
            bridge_dir = runtime / role
            bridge_dir.mkdir(mode=0o700)
            os.chown(bridge_dir, principal.pw_uid, identity.pw_gid)
            bridge_dir.chmod(0o2711)
            socket = bridge_dir / 'bridge.sock'
            bridge = subprocess.Popen(['/usr/bin/python3', str(Path(__file__).with_name('wsl-codex-api-bridge.py')),
                '--socket', str(socket), '--auth', str(AUTH), '--worker-gid', str(identity.pw_gid),
                '--worker-uid', str(identity.pw_uid), '--role', role,
                '--claim', args.claim, '--generation', args.generation,
                '--model', 'gpt-6.1-sol', '--max-output-tokens', '4096', '--total-output-tokens', '131072',
                '--lease-seconds', '120'], preexec_fn=drop, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
            for _ in range(100):
                if socket.is_socket():
                    return socket
                if bridge.poll() is not None:
                    raise ValueError('scoped API bridge exited before readiness')
                time.sleep(.05)
            raise ValueError('scoped API bridge readiness timeout')

        def drop():
            os.setgroups([])
            os.setgid(principal.pw_gid)
            os.setuid(principal.pw_uid)
        socket = start_bridge('worker', worker)
        mcp_config = ('''-c 'mcp_servers.probe.command="/usr/bin/python3"' \\
  -c 'mcp_servers.probe.args=["/work/mcp.py"]' -c mcp_servers.probe.required=true \\
  -c 'mcp_servers.probe.default_tools_approval_mode="approve"' \\
  ''' if args.isolation_probe == 'mcp' else '')
        script = '''socat TCP-LISTEN:18547,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/bridge.sock &
proxy=$!
trap 'kill "$proxy" 2>/dev/null || true' EXIT
OPENAI_API_KEY=placeholder timeout 65s /usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js \\
  exec --ignore-user-config --ephemeral --skip-git-repo-check --json --cd /work \\
  --sandbox read-only -c approval_policy=never \\
  ''' + mcp_config + '''-c 'openai_base_url="http://127.0.0.1:18547/v1"' \\
  ''' + shlex.quote(args.prompt) + ''' >/proposal/codex-out 2>/proposal/codex-err
status=$?
if test "$status" -ne 0; then exit "$status"; fi
MYCELINK_PROPOSAL_PATHS=''' + shlex.quote(json.dumps(args.proposal_path)) + ''' /usr/bin/python3 - <<'PY' || exit 1
import json
import os
from pathlib import Path
root = Path('/proposal')
raw = (root / 'codex-out').read_bytes()
if len(raw) > 2 * 1024 * 1024:
    raise ValueError('Codex turn exceeds worker result budget')
transcript = [json.loads(line) for line in raw.splitlines() if line]
events = [item.get('type') for item in transcript]
if events.count('turn.completed') != 1 or 'turn.failed' in events:
    raise ValueError('Codex turn did not complete exactly once')
result = json.dumps({'status': '0', 'events': events, 'transcript': transcript}, ensure_ascii=False)
if len(result.encode()) > 2 * 1024 * 1024:
    raise ValueError('Codex result exceeds sealed submission budget')
names = json.loads(os.environ['MYCELINK_PROPOSAL_PATHS'])
if names:
    final = [item['item']['text'] for item in transcript
             if item.get('type') == 'item.completed' and
             isinstance(item.get('item'), dict) and item['item'].get('type') == 'agent_message']
    if len(final) != 1:
        raise ValueError('missing unique model proposal')
    proposal = json.loads(final[0])
    if not isinstance(proposal, dict) or set(proposal) != set(names) or any(not isinstance(proposal[name], str) for name in names):
        raise ValueError('model proposal exceeds exact controller path grant')
    for name in names:
        if len(proposal[name].encode()) > 2 * 1024 * 1024:
            raise ValueError('model proposal exceeds file budget')
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(proposal[name])
(root / 'result.json').write_text(result)
(root / 'codex-out').unlink()
(root / 'codex-err').unlink()
PY
'''
        command = ['/usr/bin/python3', str(Path(__file__).with_name('wsl-codex-worker.py')),
            '--source', args.source, '--source-files', args.manifest,
            '--transport-dir', str(transport), '--claim', args.claim,
            '--generation', args.generation, '--role', 'worker', '--timeout-sec', '80',
            '--attest-isolation', '--bridge-socket', str(socket), '--codex-install', str(WORKER),
            '--', '/bin/sh', '-c', script]
        completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=100, check=False)
        if completed.returncode != 0:
            raise ValueError('registered isolated Codex worker failed')
        # The root-owned launcher envelope is provisional. The trusted broker
        # still has to consume and seal it before any apply or settlement.
        envelope = transport / args.claim / args.generation / 'worker.json'
        data = json.loads(envelope.read_text())
        submission = data['submission']
        if (data['claim'], data['generation'], data['role']) != (args.claim, args.generation, 'worker'):
            raise ValueError('wrong generation transport')
        if (not isinstance(submission, dict) or
            set(data['proposals']) != set(args.proposal_path) or
            submission.get('status') != '0' or
            not isinstance(submission.get('transcript'), list) or
            [item.get('type') for item in submission['transcript']] != submission.get('events') or
            submission['events'].count('turn.completed') != 1 or 'turn.failed' in submission['events']):
            raise ValueError('Linux Codex turn did not complete as a role-owned submission')
        if args.proposal_path:
            final = [item['item']['text'] for item in submission['transcript']
                     if item.get('type') == 'item.completed' and
                     isinstance(item.get('item'), dict) and item['item'].get('type') == 'agent_message']
            if len(final) != 1 or json.loads(final[0]) != data['proposals']:
                raise ValueError('model proposal did not match role-owned source output')
        if args.review_prompt:
            # The reviewer receives only the immutable source and this bounded
            # copy of the sealed worker proposal, never its writable directory,
            # session, bridge socket, identity or worker result channel.
            proposed = json.dumps(data['proposals'], sort_keys=True, ensure_ascii=False)
            review_prompt = args.review_prompt + '\nProposed source files (read-only):\n' + proposed
            if len(review_prompt.encode()) > 16_384:
                raise ValueError('proposal exceeds independent review packet budget')
            stop_bridge()
            socket = start_bridge('reviewer', reviewer)
            review_script = '''socat TCP-LISTEN:18547,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/bridge.sock &
proxy=$!
trap 'kill "$proxy" 2>/dev/null || true' EXIT
OPENAI_API_KEY=placeholder timeout 65s /usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js \\
  exec --ignore-user-config --ephemeral --skip-git-repo-check --json --cd /work \\
  --sandbox read-only -c approval_policy=never \\
  -c 'openai_base_url="http://127.0.0.1:18547/v1"' \\
  ''' + shlex.quote(review_prompt) + ''' >/proposal/review-out 2>/proposal/review-err
status=$?
if test "$status" -ne 0; then exit "$status"; fi
/usr/bin/python3 - <<'PY' || exit 1
import json
from pathlib import Path
root = Path('/proposal')
raw = (root / 'review-out').read_bytes()
if len(raw) > 2 * 1024 * 1024:
    raise ValueError('reviewer turn exceeds submission budget')
transcript = [json.loads(line) for line in raw.splitlines() if line]
events = [item.get('type') for item in transcript]
if events.count('turn.completed') != 1 or 'turn.failed' in events:
    raise ValueError('independent reviewer turn did not complete')
final = [item['item']['text'] for item in transcript if item.get('type') == 'item.completed'
         and isinstance(item.get('item'), dict) and item['item'].get('type') == 'agent_message']
if len(final) != 1 or json.loads(final[0]).get('verdict') != 'PASS':
    raise ValueError('independent reviewer did not approve')
(root / 'verdict.json').write_text(json.dumps({'verdict': 'PASS', 'events': events, 'transcript': transcript}, ensure_ascii=False))
(root / 'review-out').unlink()
(root / 'review-err').unlink()
PY
'''
            review_command = ['/usr/bin/python3', str(Path(__file__).with_name('wsl-codex-worker.py')),
                '--source', args.source, '--source-files', args.manifest,
                '--transport-dir', str(transport), '--claim', args.claim,
                '--generation', args.generation, '--role', 'reviewer', '--timeout-sec', '80',
                '--attest-isolation', '--bridge-socket', str(socket), '--codex-install', str(WORKER),
                '--', '/bin/sh', '-c', review_script]
            reviewed = subprocess.run(review_command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, timeout=100, check=False)
            if reviewed.returncode != 0:
                raise ValueError('independent reviewer turn failed')
            verdict = json.loads((transport / args.claim / args.generation / 'reviewer.json').read_text())
            if (verdict.get('role') != 'reviewer' or verdict.get('proposals') != {} or
                verdict.get('source_hashes') != data['source_hashes'] or
                verdict.get('submission', {}).get('verdict') != 'PASS'):
                raise ValueError('independent reviewer transport is not bound to worker source')
    finally:
        stop_bridge()
        shutil.rmtree(runtime)


def main():
    parser = argparse.ArgumentParser()
    for name in ('source', 'manifest', 'claim', 'generation', 'prompt'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--proposal-path', action='append', default=[])
    parser.add_argument('--isolation-probe', choices=('mcp', 'builtin'))
    parser.add_argument('--review-prompt')
    run(parser.parse_args())


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(f'WSL Codex turn refused: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
