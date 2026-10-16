#!/usr/bin/env python3
"""Experimental WSL worker transport. NOT a production Codex launch authorization.

Invoked by the trusted Windows controller as WSL root. The worker only receives
copied source in a read-only mount and a private proposal directory. A scoped
Unix broker may supply model API access without exposing host credentials.
This does not execute Mycelink gates or authorize production Codex dispatch.
"""
import argparse
import http.client
import json
import os
import pathlib
import pwd
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading

BASE = pathlib.Path('/var/lib/mycelink-codex/claims')
MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024


def copied_tree(source, dest):
    """Copy through pinned directory handles, never path-reopen a checked parent."""
    budget = 0
    count = 0
    root_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        def visit(directory_fd, target):
            nonlocal budget, count
            with os.scandir(directory_fd) as entries:
                names = sorted(entry.name for entry in entries)
            for name in names:
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                    try:
                        child_target = target / name
                        child_target.mkdir(mode=0o755)
                        visit(child_fd, child_target)
                    finally:
                        os.close(child_fd)
                elif stat.S_ISREG(info.st_mode):
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                    try:
                        actual = os.fstat(fd)
                        if not stat.S_ISREG(actual.st_mode) or actual.st_size > MAX_FILE:
                            raise ValueError('source file is not bounded regular data')
                        budget += actual.st_size
                        count += 1
                        if budget > MAX_TOTAL or count > 4096:
                            raise ValueError('source exceeds snapshot budget')
                        with os.fdopen(os.dup(fd), 'rb') as reader:
                            contents = reader.read(MAX_FILE + 1)
                        if len(contents) > MAX_FILE or budget + len(contents) - actual.st_size > MAX_TOTAL:
                            raise ValueError('source grew while copying')
                        with open(target / name, 'xb') as writer:
                            writer.write(contents)
                        (target / name).chmod(0o444)
                    finally:
                        os.close(fd)
                else:
                    raise ValueError('source contains a link or special file')
        visit(root_fd, dest)
    finally:
        os.close(root_fd)
    return count


def proposals_from(directory):
    result = {}
    size = 0
    for root, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            item = pathlib.Path(root) / name
            if not (stat.S_ISDIR(item.lstat().st_mode) or stat.S_ISREG(item.lstat().st_mode)):
                raise ValueError('proposal contains link or special file')
        for name in files:
            item = pathlib.Path(root) / name
            fd = os.open(item, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE:
                    raise ValueError('proposal file has unsafe inode or size')
                size += info.st_size
                if size > MAX_TOTAL or len(result) >= 4096:
                    raise ValueError('proposal exceeds budget')
                with os.fdopen(os.dup(fd), 'rb') as reader:
                    result[str(item.relative_to(directory))] = reader.read(MAX_FILE + 1).decode('utf-8')
            finally:
                os.close(fd)
    return result


def bridge_identity(path, claim, generation, role, expected_uid):
    channel = socket.socket(socket.AF_UNIX)
    channel.settimeout(2)
    try:
        channel.connect(path)
        _, owner_uid, _ = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if owner_uid not in (0, pwd.getpwnam('psh09').pw_uid):
            raise PermissionError('untrusted bridge process')
        channel.sendall(b'GET /internal/identity HTTP/1.1\r\nHost: internal\r\nConnection: close\r\n\r\n')
        response = http.client.HTTPResponse(channel)
        response.begin()
        if response.status != 200:
            raise ValueError('broker identity unavailable')
        payload = response.read(513)
        if len(payload) > 512:
            raise ValueError('broker identity too large')
        identity = json.loads(payload)
        if identity != {'claim': claim, 'generation': generation, 'role': role, 'uid': expected_uid}:
            raise ValueError('broker identity does not match claim generation or role')
    finally:
        channel.close()


def run_bounded(command, identity, timeout_sec):
    """Drain hostile stdio with backpressure; never accumulate output in RAM."""
    def drop():
        os.setgroups([])
        os.setgid(identity.pw_gid)
        os.setuid(identity.pw_uid)

    child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={'PATH': '/usr/bin:/bin'}, close_fds=True, preexec_fn=drop)
    exceeded = threading.Event()
    def drain(stream):
        count = 0
        try:
            while chunk := stream.read(64 * 1024):
                count += len(chunk)
                if count > MAX_FILE:
                    exceeded.set()
                    child.kill()
                    break
        finally:
            stream.close()
    readers = [threading.Thread(target=drain, args=(stream,), daemon=True)
               for stream in (child.stdout, child.stderr)]
    for reader in readers:
        reader.start()
    try:
        child.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=3)
        raise
    finally:
        for reader in readers:
            reader.join(timeout=3)
    if any(reader.is_alive() for reader in readers) or exceeded.is_set():
        raise ValueError('isolated command exceeded stdio budget or retained a channel')
    if child.returncode != 0:
        raise RuntimeError(f'isolated command failed ({child.returncode})')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--claim', required=True)
    parser.add_argument('--generation', required=True)
    parser.add_argument('--role', choices=('worker', 'reviewer'), required=True)
    parser.add_argument('--bridge-socket')
    parser.add_argument('--codex-install')
    parser.add_argument('--timeout-sec', type=int, default=20)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if os.geteuid() != 0 or not args.command or args.command[0] != '--':
        parser.error('trusted root launch and explicit command required')
    if not 1 <= args.timeout_sec <= 120:
        parser.error('timeout must be bounded')
    identity = pwd.getpwnam('mycelink-codex-worker' if args.role == 'worker' else 'mycelink-codex-reviewer')
    if not BASE.is_dir() or BASE.stat().st_uid != 0:
        raise RuntimeError('root-owned claim base must be provisioned')
    source = pathlib.Path(args.source)
    if not source.is_dir() or source.is_symlink():
        raise ValueError('source must be a real directory')
    if args.bridge_socket:
        socket_info = os.stat(args.bridge_socket, follow_symlinks=False)
        if not stat.S_ISSOCK(socket_info.st_mode):
            raise ValueError('bridge must be a Unix socket')
        bridge_identity(args.bridge_socket, args.claim, args.generation, args.role, identity.pw_uid)
    if args.codex_install:
        package = pathlib.Path(args.codex_install)
        info = package.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or package.is_symlink():
            raise ValueError('Codex package must be a root-owned non-writable directory')
    stage = pathlib.Path(tempfile.mkdtemp(prefix='claim-', dir=BASE))
    try:
        stage.chmod(0o711)
        snapshot = stage / 'snapshot'
        proposal = stage / 'proposal'
        snapshot.mkdir(mode=0o755)
        count = copied_tree(source, snapshot)
        proposal.mkdir(mode=0o700)
        os.chown(proposal, identity.pw_uid, identity.pw_gid)

        command = [
            '/var/lib/mycelink-codex/pkg/bwrap-0.13.1/bin/bwrap',
            '--die-with-parent', '--unshare-all', '--new-session',
            '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
            '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
            '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--dir', '/home', '--dir', '/work',
            '--ro-bind', str(snapshot), '/work', '--bind', str(proposal), '/proposal',
        ]
        if args.bridge_socket:
            command.extend(['--dir', '/run', '--ro-bind', args.bridge_socket, '/run/bridge.sock'])
        if args.codex_install:
            command.extend(['--dir', '/opt', '--ro-bind', args.codex_install, '/opt/node_modules'])
        command.extend(['--clearenv', '--setenv', 'HOME', '/home',
                        '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
                        '--chdir', '/work', '--', *args.command[1:]])
        run_bounded(command, identity, args.timeout_sec)
        proposals = proposals_from(proposal)
        own_slot = 'result.json' if args.role == 'worker' else 'verdict.json'
        foreign_slot = 'verdict.json' if args.role == 'worker' else 'result.json'
        if foreign_slot in proposals:
            raise ValueError('wrong-role result channel')
        raw_submission = proposals.pop(own_slot, None)
        submission = None
        if raw_submission is not None:
            submission = json.loads(raw_submission)
            if not isinstance(submission, dict):
                raise ValueError('result channel requires a JSON object')
        record = {'claim': args.claim, 'generation': args.generation, 'role': args.role,
                  'source_files': count, 'proposals': proposals, 'submission': submission}
        # A pre-existing target (including a hardlink/symlink) must not be overwritten.
        fd = os.open(args.report, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(record, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
    finally:
        shutil.rmtree(stage)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f'WSL worker refused: {exc}', file=sys.stderr)
        sys.exit(1)
