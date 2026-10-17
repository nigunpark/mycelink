#!/usr/bin/env python3
"""Experimental WSL worker transport. NOT a production Codex launch authorization.

Invoked by the trusted Windows controller as WSL root. The worker only receives
copied source in a read-only mount and a private proposal directory. A scoped
Unix broker may supply model API access without exposing host credentials.
This does not execute Mycelink gates or authorize production Codex dispatch.
"""
import argparse
import hashlib
import http.client
import json
import os
import pathlib
import pwd
import re
import select
import shlex
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading

BASE = pathlib.Path('/var/lib/mycelink-codex/claims')
BWRAP = pathlib.Path('/var/lib/mycelink-codex/pkg/bwrap-0.13.1/bin/bwrap')
MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
SOURCE_NAME = re.compile(r'^[A-Za-z0-9_./-]{1,240}$')
TOKEN = re.compile(r'^[A-Za-z0-9_-]{1,100}$')
ISOLATION_PREFIX = b'__MYCELINK_ISOLATION_V1__'
# Runs as a fixed root-selected prelude inside the *same* bwrap namespace,
# before the untrusted command. No worker file or model text supplies a verdict.
ISOLATION_PROBE = '''import json, os, pathlib, socket
mount = not pathlib.Path('/mnt/c/Windows').exists() and not pathlib.Path('/init').exists()
role = not pathlib.Path('/var/lib/mycelink-codex/transport').exists() and not pathlib.Path('/home/psh09/.codex/auth.json').exists()
try:
    with socket.create_connection(('1.1.1.1', 443), timeout=0.5):
        egress = False
except OSError:
    egress = True
print('__MYCELINK_ISOLATION_V1__' + json.dumps({'hostMountDenied': mount, 'directEgressDenied': egress, 'otherRoleSlotDenied': role}), flush=True)
if not (mount and role and egress):
    raise SystemExit(1)
'''


def private_transport(path, claim, generation, role):
    """Reserve one root-owned generation slot; a pending slot never replays.

    Only the trusted launcher can create these files. The broker must separately
    authorize and seal a proposal; this transport is not that authorization.
    """
    if not TOKEN.fullmatch(claim) or not TOKEN.fullmatch(generation):
        raise ValueError('unsafe claim or generation token')
    root = pathlib.Path(path)
    if not root.is_absolute():
        raise ValueError('transport must be absolute')
    # Refuse symlink components even above the private root. A root-owned
    # sticky /tmp is permitted for disposable opt-in probes, but the private
    # root itself must not be writable by another principal.
    for component in (root, *root.parents):
        info = component.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            raise ValueError('transport parent must be a root-owned directory')
        if component == root and info.st_mode & 0o077:
            raise ValueError('transport must be private')
        if component != root and info.st_mode & 0o022 and not (
            info.st_mode & stat.S_ISVTX and info.st_uid == 0):
            raise ValueError('transport parent is replaceable')
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for token in (claim, generation):
            try:
                os.mkdir(token, mode=0o700, dir_fd=root_fd)
                os.fsync(root_fd)
            except FileExistsError:
                pass
            next_fd = os.open(token, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            info = os.fstat(next_fd)
            if info.st_uid != 0 or info.st_mode & 0o077:
                os.close(next_fd)
                raise ValueError('transport slot is not private')
            os.close(root_fd)
            root_fd = next_fd
        pending = role + '.pending'
        fd = os.open(pending, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                     0o600, dir_fd=root_fd)
        with os.fdopen(fd, 'w') as output:
            json.dump({'claim': claim, 'generation': generation, 'role': role}, output)
            output.flush()
            os.fsync(output.fileno())
        os.fsync(root_fd)
        return root_fd
    except BaseException:
        os.close(root_fd)
        raise


def publish_transport(fd, role, record):
    """Publish complete fsynced JSON, never a partially written result."""
    temporary = role + '.tmp'
    final = role + '.json'
    output_fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                        0o600, dir_fd=fd)
    with os.fdopen(output_fd, 'w') as output:
        json.dump(record, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    os.link(temporary, final, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
    os.fsync(fd)
    os.unlink(temporary, dir_fd=fd)
    os.fsync(fd)

def trusted_executable(path):
    """Reject a replaceable sandbox executable or writable ancestor before launch."""
    path = pathlib.Path(path)
    for item in (path, *path.parents):
        info = item.lstat()
        expected = stat.S_ISREG if item == path else stat.S_ISDIR
        if not expected(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('sandbox executable or parent is not root-owned and immutable to worker')
    if not os.access(path, os.X_OK) or path.stat().st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise ValueError('sandbox executable must be non-setuid and executable')
    return str(path)


def source_manifest(path):
    """Accept only a bounded root-owned exact file list outside worker mounts."""
    parent = pathlib.Path(path).parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
        raise ValueError('source manifest parent must be trusted')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
            info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 512 * 1024):
            raise ValueError('source manifest is not a private regular file')
        with os.fdopen(os.dup(fd), 'rb') as reader:
            names = json.loads(reader.read(512 * 1024 + 1))
    finally:
        os.close(fd)
    if not isinstance(names, list) or len(names) > 4096 or any(
        not isinstance(name, str) or not SOURCE_NAME.fullmatch(name) or
        any(part == '' or part.startswith('.') or part.endswith(('.', ' '))
            for part in name.split('/')) for name in names
    ) or len(set(names)) != len(names) or len({name.casefold() for name in names}) != len(names):
        raise ValueError('source manifest has unsafe, duplicate or case-aliased names')
    return set(names)


def copied_tree(source, dest, selected=None, hashes=None):
    """Copy through pinned directory handles, never path-reopen a checked parent."""
    budget = 0
    count = 0
    root_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        seen = set()
        def visit(directory_fd, target, prefix=''):
            nonlocal budget, count
            with os.scandir(directory_fd) as entries:
                names = sorted(entry.name for entry in entries)
            for name in names:
                # The worker receives source bytes, never host metadata, auth,
                # control state or untracked dotfiles. A future controller must
                # explicitly stage any needed public dotfile from an allowlist.
                if name.startswith('.'):
                    continue
                relative = prefix + name
                if selected is not None and relative not in selected and not any(
                    item.startswith(relative + '/') for item in selected):
                    continue
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                    try:
                        child_target = target / name
                        child_target.mkdir(mode=0o755)
                        visit(child_fd, child_target, relative + '/')
                    finally:
                        os.close(child_fd)
                elif stat.S_ISREG(info.st_mode):
                    if selected is not None and relative not in selected:
                        raise ValueError('manifest names a directory as a file')
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                    try:
                        actual = os.fstat(fd)
                        if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                            raise ValueError('source changed during snapshot')
                        if not stat.S_ISREG(actual.st_mode) or actual.st_size > MAX_FILE:
                            raise ValueError('source file is not bounded regular data')
                        budget += actual.st_size
                        count += 1
                        if budget > MAX_TOTAL or count > 4096:
                            raise ValueError('source exceeds snapshot budget')
                        with os.fdopen(os.dup(fd), 'rb') as reader:
                            contents = reader.read(MAX_FILE + 1)
                        after = os.fstat(fd)
                        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (
                            actual.st_dev, actual.st_ino, actual.st_size, actual.st_mtime_ns, actual.st_ctime_ns):
                            raise ValueError('source changed during snapshot')
                        if len(contents) > MAX_FILE or budget + len(contents) - actual.st_size > MAX_TOTAL:
                            raise ValueError('source grew while copying')
                        with open(target / name, 'xb') as writer:
                            writer.write(contents)
                        (target / name).chmod(0o444)
                        seen.add(relative)
                        if hashes is not None:
                            hashes[relative] = hashlib.sha256(contents).hexdigest()
                    finally:
                        os.close(fd)
                else:
                    raise ValueError('source contains a link or special file')
        visit(root_fd, dest)
        if selected is not None and seen != selected:
            raise ValueError('source manifest names missing or unsafe files')
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


def run_bounded(command, identity, timeout_sec, attest_isolation=False):
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
    isolation = None
    if attest_isolation:
        if not select.select([child.stdout], [], [], min(timeout_sec, 5))[0]:
            child.kill()
            child.wait(timeout=3)
            raise ValueError('isolated prelude did not attest before model execution')
        first = child.stdout.readline(513)
        if not first.startswith(ISOLATION_PREFIX) or len(first) > 512 or not first.endswith(b'\n'):
            child.kill()
            child.wait(timeout=3)
            raise ValueError('isolated prelude was missing or malformed')
        try:
            isolation = json.loads(first[len(ISOLATION_PREFIX):])
        except (ValueError, UnicodeError):
            child.kill()
            child.wait(timeout=3)
            raise ValueError('isolated prelude verdict malformed')
        if isolation != {'hostMountDenied': True, 'directEgressDenied': True, 'otherRoleSlotDenied': True}:
            child.kill()
            child.wait(timeout=3)
            raise ValueError('isolated prelude detected a host escape')
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
    return isolation


def publish_failure(fd, role, reason, directory, expected_paths=(), phase='isolated-command'):
    """Root-only non-authorizing diagnostics: bounded event TYPES, never text."""
    events = []
    agent_messages = 0
    matching_proposals = 0
    for name in ('codex-out', 'review-out'):
        try:
            stream = os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            continue
        try:
            info = os.fstat(stream)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE:
                continue
            with os.fdopen(os.dup(stream), 'rb') as source:
                for line in source.read(MAX_FILE + 1).splitlines():
                    try:
                        event = json.loads(line)
                        kind = event.get('type')
                        if isinstance(kind, str) and re.fullmatch(r'[a-z.]{1,60}', kind):
                            events.append(kind)
                        item = event.get('item')
                        if (name == 'codex-out' and kind == 'item.completed' and
                                isinstance(item, dict) and item.get('type') == 'agent_message' and
                                isinstance(item.get('text'), str)):
                            agent_messages += 1
                            try:
                                proposal = json.loads(item['text'])
                                if (isinstance(proposal, dict) and set(proposal) == set(expected_paths) and
                                        all(isinstance(value, str) for value in proposal.values())):
                                    matching_proposals += 1
                            except ValueError:
                                pass
                    except (ValueError, AttributeError, TypeError):
                        continue
        finally:
            os.close(stream)
    match = re.fullmatch(r'isolated command failed \((-?\d+)\)', str(reason))
    record = {'phase': phase, 'exception': type(reason).__name__,
              'exitCode': int(match.group(1)) if match else None,
              'events': events[:512], 'agentMessages': agent_messages,
              'matchingProposals': matching_proposals}
    failure_fd = os.open(role + '.failure.json', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                         0o600, dir_fd=fd)
    with os.fdopen(failure_fd, 'w') as output:
        json.dump(record, output)
        output.flush()
        os.fsync(output.fileno())
    os.fsync(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--source-files')
    parser.add_argument('--experimental-unrestricted-source', action='store_true')
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument('--report')
    destination.add_argument('--transport-dir')
    parser.add_argument('--claim', required=True)
    parser.add_argument('--generation', required=True)
    parser.add_argument('--role', choices=('worker', 'reviewer'), required=True)
    parser.add_argument('--bridge-socket')
    parser.add_argument('--codex-install')
    parser.add_argument('--expected-proposal-path', action='append', default=[])
    parser.add_argument('--attest-isolation', action='store_true')
    parser.add_argument('--timeout-sec', type=int, default=20)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if os.geteuid() != 0 or not args.command or args.command[0] != '--':
        parser.error('trusted root launch and explicit command required')
    if not 1 <= args.timeout_sec <= 120:
        parser.error('timeout must be bounded')
    identity = pwd.getpwnam('mycelink-codex-worker' if args.role == 'worker' else 'mycelink-codex-reviewer')
    base_info = BASE.lstat()
    if (not stat.S_ISDIR(base_info.st_mode) or base_info.st_uid != 0 or
        base_info.st_mode & 0o022):
        raise RuntimeError('root-owned, non-writable claim base must be provisioned')
    source = pathlib.Path(args.source)
    if not source.is_dir() or source.is_symlink():
        raise ValueError('source must be a real directory')
    selected = source_manifest(args.source_files) if args.source_files else None
    if selected is None and not args.experimental_unrestricted_source:
        raise ValueError('source manifest required; unrestricted snapshot is experimental only')
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
    transport_fd = private_transport(args.transport_dir, args.claim, args.generation, args.role) if args.transport_dir else None
    stage = pathlib.Path(tempfile.mkdtemp(prefix='claim-', dir=BASE))
    try:
        stage.chmod(0o711)
        snapshot = stage / 'snapshot'
        proposal = stage / 'proposal'
        snapshot.mkdir(mode=0o755)
        source_hashes = {}
        count = copied_tree(source, snapshot, selected, source_hashes)
        proposal.mkdir(mode=0o700)
        os.chown(proposal, identity.pw_uid, identity.pw_gid)

        command = [
            trusted_executable(BWRAP),
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
        sandbox_command = args.command[1:]
        if args.attest_isolation:
            sandbox_command = ['/bin/sh', '-c',
                '/usr/bin/python3 -c ' + shlex.quote(ISOLATION_PROBE) + ' || exit 1; exec "$@"',
                'mycelink-isolation-prelude', *sandbox_command]
        command.extend(['--clearenv', '--setenv', 'HOME', '/home',
                        '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
                        '--chdir', '/work', '--', *sandbox_command])
        try:
            isolation = run_bounded(command, identity, args.timeout_sec, args.attest_isolation)
        except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            if transport_fd is not None:
                publish_failure(transport_fd, args.role, error, proposal, args.expected_proposal_path)
            raise
        try:
            proposals = proposals_from(proposal)
        except (ValueError, OSError) as error:
            if transport_fd is not None:
                publish_failure(transport_fd, args.role, error, proposal, args.expected_proposal_path,
                                phase='proposal-validation')
            raise
        try:
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
                      'source_files': count, 'source_hashes': source_hashes,
                      'proposals': proposals, 'submission': submission}
            if isolation is not None:
                record['isolation'] = isolation
            # A pre-existing target (including a hardlink/symlink) must not be overwritten.
            if transport_fd is not None:
                publish_transport(transport_fd, args.role, record)
            else:
                fd = os.open(args.report, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'w') as output:
                    json.dump(record, output, sort_keys=True)
                    output.flush()
                    os.fsync(output.fileno())
        except (OSError, ValueError, TypeError) as error:
            if transport_fd is not None:
                publish_failure(transport_fd, args.role, error, proposal, args.expected_proposal_path,
                                phase='submission-publication')
            raise
    finally:
        shutil.rmtree(stage)
        if transport_fd is not None:
            os.close(transport_fd)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f'WSL worker refused: {exc}', file=sys.stderr)
        sys.exit(1)
