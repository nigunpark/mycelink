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
    bridge_dir = runtime / 'bridge'
    bridge_dir.mkdir()
    principal = pwd.getpwnam('psh09')
    worker = pwd.getpwnam('mycelink-codex-worker')
    os.chown(bridge_dir, principal.pw_uid, worker.pw_gid)
    bridge_dir.chmod(0o2711)
    socket = bridge_dir / 'bridge.sock'
    bridge = None
    try:
        def drop():
            os.setgroups([])
            os.setgid(principal.pw_gid)
            os.setuid(principal.pw_uid)
        bridge = subprocess.Popen(['/usr/bin/python3', str(Path(__file__).with_name('wsl-codex-api-bridge.py')),
            '--socket', str(socket), '--auth', str(AUTH), '--worker-gid', str(worker.pw_gid),
            '--worker-uid', str(worker.pw_uid), '--claim', args.claim, '--generation', args.generation,
            '--model', 'gpt-6.1-sol', '--max-output-tokens', '4096', '--total-output-tokens', '131072',
            '--lease-seconds', '120'], preexec_fn=drop, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        for _ in range(100):
            if socket.is_socket():
                break
            if bridge.poll() is not None:
                raise ValueError('scoped API bridge exited before readiness')
            time.sleep(.05)
        else:
            raise ValueError('scoped API bridge readiness timeout')
        script = '''socat TCP-LISTEN:18547,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/bridge.sock &
proxy=$!
trap 'kill "$proxy" 2>/dev/null || true' EXIT
OPENAI_API_KEY=placeholder timeout 65s /usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js \\
  exec --ignore-user-config --ephemeral --skip-git-repo-check --json --cd /work \\
  --sandbox read-only -c approval_policy=never \\
  -c 'openai_base_url="http://127.0.0.1:18547/v1"' \\
  ''' + shlex.quote(args.prompt) + ''' >/proposal/codex-out 2>/proposal/codex-err
status=$?
printf '%s' "$status" > /proposal/status
exit "$status"
'''
        command = ['/usr/bin/python3', str(Path(__file__).with_name('wsl-codex-worker.py')),
            '--source', args.source, '--source-files', args.manifest,
            '--transport-dir', str(transport), '--claim', args.claim,
            '--generation', args.generation, '--role', 'worker', '--timeout-sec', '80',
            '--bridge-socket', str(socket), '--codex-install', str(WORKER),
            '--', '/bin/sh', '-c', script]
        completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=100, check=False)
        if completed.returncode != 0:
            raise ValueError('registered isolated Codex worker failed')
        # The root-owned launcher envelope is provisional. The trusted broker
        # still has to consume and seal it before any apply or settlement.
        envelope = transport / args.claim / args.generation / 'worker.json'
        data = json.loads(envelope.read_text())
        proposal = data['proposals']
        if (data['claim'], data['generation'], data['role']) != (args.claim, args.generation, 'worker'):
            raise ValueError('wrong generation transport')
        events = [json.loads(line).get('type') for line in proposal['codex-out'].splitlines()
                  if line.startswith('{')]
        if proposal['status'] != '0' or 'turn.completed' not in events:
            raise ValueError('Linux Codex turn did not complete')
    finally:
        if bridge is not None and bridge.poll() is None:
            bridge.terminate()
            try:
                bridge.wait(timeout=3)
            except subprocess.TimeoutExpired:
                bridge.kill()
                bridge.wait(timeout=3)
        shutil.rmtree(runtime)


def main():
    parser = argparse.ArgumentParser()
    for name in ('source', 'manifest', 'claim', 'generation', 'prompt'):
        parser.add_argument('--' + name, required=True)
    run(parser.parse_args())


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(f'WSL Codex turn refused: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
