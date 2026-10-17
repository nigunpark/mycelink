#!/usr/bin/env python3
"""Experimental root-owned WSL generation process registry; NOT dispatch authorization.

The Windows controller must hold the feature lifecycle mutex from live claim
inspection through the ready receipt. Revocation is synchronous and must finish
before cancellation returns. A supervisor failure is not proof of descendant
cleanup; no production dispatch can rely on this component alone.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import fcntl
import select

ROOT = Path('/var/lib/mycelink-codex/processes')
TOKEN = re.compile(r'^[0-9a-f]{32,64}$')
IDENT = re.compile(r'^[A-Za-z0-9_-]{1,100}$')


def directory(path, private=True):
    if path.is_symlink():
        raise ValueError('registry path is a symlink')
    if not path.exists():
        path.mkdir(mode=0o700)
    info = path.lstat()
    if private and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022:
        path.chmod(0o700)  # tighten a root-owned directory created under a permissive umask
        info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022):
        raise ValueError('registry directory is not root-private')


def location(token):
    if not TOKEN.fullmatch(token):
        raise ValueError('unsafe feature token')
    directory(ROOT.parent, private=False)
    directory(ROOT)
    path = ROOT / token
    directory(path)
    return path


def proc_start(pid):
    try:
        contents = Path(f'/proc/{pid}/stat').read_text()
        return contents.rsplit(')', 1)[1].strip().split()[19]
    except (FileNotFoundError, IndexError, ValueError):
        return None


def slot_name(claim, generation):
    if not IDENT.fullmatch(claim) or not IDENT.fullmatch(generation):
        raise ValueError('unsafe claim or generation')
    return f'{claim}-{generation}'


def lock(path):
    fd = os.open(path / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
        os.close(fd)
        raise ValueError('unsafe process registry lock')
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def record(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
        raise ValueError('unsafe process registry record')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if os.fstat(fd).st_ino != info.st_ino or os.fstat(fd).st_dev != info.st_dev:
            raise ValueError('process registry record replaced')
        data = json.loads(os.read(fd, 4097))
    finally:
        os.close(fd)
    if (not isinstance(data, dict) or set(data) != {'claim', 'generation', 'pid', 'start', 'pgid'} or
        not IDENT.fullmatch(data['claim']) or not IDENT.fullmatch(data['generation']) or
        path.name != slot_name(data['claim'], data['generation']) + '.json' or
        type(data['pid']) is not int or data['pid'] <= 1 or data['pgid'] != data['pid'] or
        not isinstance(data['start'], str) or not data['start'].isdigit()):
        raise ValueError('invalid process registry record')
    return data


def status(token, claim, generation):
    path = location(token)
    name = slot_name(claim, generation)
    guard = lock(path)
    try:
        slot = path / (name + '.json')
        if slot.exists() or slot.is_symlink():
            data = record(slot)
            if proc_start(data['pid']) != data['start'] or os.getpgid(data['pid']) != data['pgid']:
                raise ValueError('WSL process identity stale; reconciliation required')
            return {'active': True}
        used = path / (name + '.used')
        if not used.is_file() or used.is_symlink() or used.stat().st_uid != 0:
            raise ValueError('WSL generation was never registered')
        return {'active': False}
    finally:
        os.close(guard)


def revoke(token):
    path = location(token)
    guard = lock(path)
    try:
        slots = sorted(path.glob('*.json'))
        # Check every slot before signalling any process; a corrupt record must
        # never turn a partial revoke into a claimed successful cancellation.
        entries = [(slot, record(slot)) for slot in slots]
        for slot, data in entries:
            pid = data['pid']
            if proc_start(pid) != data['start']:
                raise ValueError('process identity stale; manual reconciliation required')
            if os.getpgid(pid) != data['pgid']:
                raise ValueError('process group identity changed')
        for _, data in entries:
            # The registered leader is in a dedicated process group. Signal
            # that group; its root supervisor reaps the leader and removes the
            # slot only after the child has exited.
            os.killpg(data['pgid'], signal.SIGTERM)
    finally:
        os.close(guard)
    deadline = time.monotonic() + 5
    while any(slot.exists() for slot, _ in entries):
        if time.monotonic() >= deadline:
            raise ValueError('WSL process did not acknowledge revocation')
        time.sleep(.02)


def run(token, claim, generation, command, ready_fd=None):
    path = location(token)
    name = slot_name(claim, generation)
    guard = lock(path)
    child = None
    slot = path / (name + '.json')
    try:
        # Keep an irrevocable per-generation tombstone: a failed/interrupted
        # launch must never be retried as the same trusted generation.
        used = os.open(path / (name + '.used'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(used)
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
        start = proc_start(child.pid)
        if start is None or os.getpgid(child.pid) != child.pid:
            raise ValueError('cannot identify WSL child process')
        data = {'claim': claim, 'generation': generation, 'pid': child.pid, 'pgid': child.pid, 'start': start}
        fd = os.open(slot, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.fsync(guard)
    except BaseException as exc:
        # Even a failure between Popen and durable registration must never
        # strand an untracked worker that the controller cannot revoke.
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
        if isinstance(exc, FileExistsError):
            raise ValueError('generation already used') from exc
        raise
    finally:
        os.close(guard)
    stopped = False
    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True
        # bwrap --die-with-parent handles descendants of the isolated worker;
        # termination of bridge processes is a separate acceptance criterion.
        if child.poll() is None and proc_start(child.pid) == start:
            os.killpg(child.pid, signal.SIGTERM)
    signal.signal(signal.SIGTERM, stop)
    try:
        if ready_fd is None:
            print(json.dumps(data), flush=True)
        else:
            os.write(ready_fd, (json.dumps(data) + '\n').encode())
            os.close(ready_fd)
    except BaseException:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
        guard = lock(path)
        try:
            if slot.exists() and record(slot) == data:
                slot.unlink()
        finally:
            os.close(guard)
        raise
    try:
        while child.poll() is None:
            try:
                child.wait(timeout=.05)
            except subprocess.TimeoutExpired:
                pass
        return 1 if stopped or child.returncode < 0 else child.returncode
    finally:
        if child.poll() is None:
            stop(None, None)
            child.wait(timeout=3)
        guard = lock(path)
        try:
            if slot.exists() and record(slot) == data:
                slot.unlink()
        finally:
            os.close(guard)


def start(token, claim, generation, command):
    """Return only a registered ready receipt, leaving the root supervisor alive."""
    # Validate before fork, so malformed tokens never create an invisible child.
    slot_name(claim, generation)
    location(token)
    read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            os.setsid()
            devnull = os.open('/dev/null', os.O_RDWR)
            for stream in (0, 1, 2):
                os.dup2(devnull, stream)
            os.close(devnull)
            code = run(token, claim, generation, command, ready_fd=write_fd)
        except BaseException as exc:
            try:
                os.write(write_fd, ('ERROR: ' + str(exc)[:200] + '\n').encode())
            except OSError:
                pass
            code = 1
        os._exit(code)
    os.close(write_fd)
    try:
        readable, _, _ = select.select([read_fd], [], [], 10)
        message = os.read(read_fd, 4096).decode() if readable else ''
    finally:
        os.close(read_fd)
    if not message.startswith('{') or not message.endswith('\n'):
        # Parent never attests readiness. Attempt fail-closed revocation of an
        # already-registered child, and refuse the generation in all cases.
        try:
            revoke(token)
        except (OSError, ValueError):
            pass
        raise ValueError('WSL process readiness not confirmed: ' + message[:200])
    print(message, end='', flush=True)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('run', 'start', 'status', 'revoke'):
        command = sub.add_parser(action)
        command.add_argument('token')
        if action in ('run', 'start', 'status'):
            command.add_argument('claim')
            command.add_argument('generation')
            if action in ('run', 'start'):
                command.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('root controller required')
    if args.action == 'revoke':
        revoke(args.token)
        return 0
    if args.action == 'status':
        print(json.dumps(status(args.token, args.claim, args.generation)))
        return 0
    command = args.command[1:] if args.command and args.command[0] == '--' else args.command
    if not command or not command[0].startswith('/'):
        raise ValueError('explicit absolute isolated worker command required')
    if args.action == 'start':
        start(args.token, args.claim, args.generation, command)
        return 0
    return run(args.token, args.claim, args.generation, command)

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f'WSL process refused: {exc}', file=sys.stderr)
        sys.exit(1)
