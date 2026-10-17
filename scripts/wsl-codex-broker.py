#!/usr/bin/env python3
"""Experimental root-owned, generation-bound proposal broker; not dispatch authorization.

Only a trusted controller may construct this object and supply live claim/hook
predicates. A JSON role or path assertion from a worker is never an authority.
"""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import stat
import struct
import threading

POLICY_PATH = Path(__file__).with_name('wsl-codex-policy.py')
SPEC = importlib.util.spec_from_file_location('wsl_codex_policy', POLICY_PATH)
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
TOKEN = re.compile(r'[A-Za-z0-9_-]{1,100}\Z')
MAX_REQUEST = 36 * 1024 * 1024


class PolicyBroker:
    def __init__(self, root, *, claim, generation, allowed_paths, current, hook_ready):
        if os.geteuid() != 0 or not TOKEN.fullmatch(claim) or not TOKEN.fullmatch(generation):
            raise ValueError('root and safe claim tokens required')
        self.root = Path(root)
        if not self.root.is_absolute():
            raise ValueError('absolute broker root required')
        for part in (self.root, *self.root.parents):
            info = part.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or (
                info.st_mode & 0o022 and not (part != self.root and info.st_mode & stat.S_ISVTX)):
                raise ValueError('untrusted broker directory')
        if not callable(current) or not callable(hook_ready):
            raise ValueError('live trusted checks required')
        if not isinstance(allowed_paths, frozenset) or not all(POLICY.safe_name(p) for p in allowed_paths):
            raise ValueError('canonical exact path grant required')
        if len({p.casefold() for p in allowed_paths}) != len(allowed_paths):
            raise ValueError('aliased path grant')
        self.claim, self.generation = claim, generation
        self.allowed_paths = allowed_paths
        self.current, self.hook_ready = current, hook_ready
        self.uid_roles = {pwd.getpwnam('mycelink-codex-worker').pw_uid: 'worker',
                          pwd.getpwnam('mycelink-codex-reviewer').pw_uid: 'reviewer'}
        if len(self.uid_roles) != 2:
            raise ValueError('worker and reviewer must have different principals')
        self.socket_path = self.root / 'broker.sock'
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.server = None
        self.thread = None

    def _live(self):
        # Exceptions from either controller-side check deny; never fall back to
        # a worker-provided statement about claim state or hook registration.
        try:
            return self.current() is True and self.hook_ready() is True
        except Exception:
            return False

    def start(self):
        if self.server is not None or self.socket_path.exists() or self.socket_path.is_symlink():
            raise ValueError('broker endpoint occupied')
        server = socket.socket(socket.AF_UNIX)
        try:
            server.bind(str(self.socket_path))
            os.chmod(self.socket_path, 0o666)  # all peers can connect; SO_PEERCRED authenticates
            server.listen(8)
            server.settimeout(0.2)
        except BaseException:
            server.close()
            raise
        self.server = server
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def validate(self, data, role):
        if not isinstance(data, dict) or set(data) != {'claim', 'generation', 'role', 'proposals', 'submission'}:
            return False
        if (data['claim'], data['generation'], data['role']) != (self.claim, self.generation, role):
            return False
        proposals = data['proposals']
        if not isinstance(proposals, dict) or len(proposals) > 4096 or not isinstance(data['submission'], dict):
            return False
        if role == 'reviewer' and proposals:
            return False
        if len({p.casefold() for p in proposals if isinstance(p, str)}) != len(proposals):
            return False
        return all(POLICY.safe_name(p) and p in self.allowed_paths and isinstance(value, str)
                   and len(value.encode('utf-8')) <= POLICY.MAX_FILE for p, value in proposals.items())

    def _submit(self, data, role, *, isolation=None):
        with self.lock:
            if isolation is not None and isolation != {
                'hostMountDenied': True, 'directEgressDenied': True, 'otherRoleSlotDenied': True}:
                return {'ok': False}
            if not (self._live() and self.validate(data, role) and self._live()):
                return {'ok': False}
            slot = self.root / role
            if slot.exists() or slot.is_symlink():
                return {'ok': False}
            name = role + '.report'
            root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=root_fd)
                with os.fdopen(fd, 'wb') as output:
                    output.write(json.dumps(data).encode('utf-8'))
                    output.flush()
                    os.fsync(output.fileno())
                if self._live():
                    POLICY.seal(self.root / name, slot, claim=self.claim,
                        generation=self.generation, role=role, allowed_paths=self.allowed_paths,
                        isolation=isolation)
                    if self._live():
                        return {'ok': True}
                    shutil.rmtree(slot)
                return {'ok': False}
            finally:
                (self.root / name).unlink(missing_ok=True)
                os.close(root_fd)

    def consume_transport(self, transport_root, role, *, expected_source_files, expected_source_hashes):
        """Consume a root-only published launcher envelope, not a worker JSON assertion.

        The caller chooses the expected role from its own launch record. A
        pending-only or temporary generation is never a successful submission.
        """
        if (os.geteuid() != 0 or role not in ('worker', 'reviewer') or
            type(expected_source_files) is not int or not 0 <= expected_source_files <= 4096):
            raise ValueError('trusted role selection required')
        if (not isinstance(expected_source_hashes, dict) or
            len(expected_source_hashes) != expected_source_files or
            any(not isinstance(name, str) or not POLICY.safe_name(name) or
                not isinstance(digest, str) or re.fullmatch(r'[0-9a-f]{64}', digest) is None
                for name, digest in expected_source_hashes.items())):
            raise ValueError('trusted source hashes required')
        transport_root = Path(transport_root)
        if not transport_root.is_absolute():
            raise ValueError('absolute private transport required')
        root_fd = os.open(transport_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        opened = [root_fd]
        try:
            for token in (self.claim, self.generation):
                next_fd = os.open(token, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                  dir_fd=opened[-1])
                opened.append(next_fd)
            for directory in opened:
                info = os.fstat(directory)
                if info.st_uid != 0 or info.st_mode & 0o077:
                    raise ValueError('transport is not root-private')
            directory = opened[-1]
            def checked_read(name):
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                except OSError as error:
                    raise ValueError('launcher publication missing or unsafe') from error
                try:
                    info = os.fstat(fd)
                    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                        info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > MAX_REQUEST):
                        raise ValueError('untrusted launcher publication')
                    with os.fdopen(os.dup(fd), 'rb') as reader:
                        raw = reader.read(MAX_REQUEST + 1)
                    if len(raw) > MAX_REQUEST or os.fstat(fd).st_size != len(raw):
                        raise ValueError('publication changed while reading')
                    return json.loads(raw)
                finally:
                    os.close(fd)
            expected = {'claim': self.claim, 'generation': self.generation, 'role': role}
            if checked_read(role + '.pending') != expected:
                raise ValueError('wrong launch reservation')
            if os.path.lexists(transport_root / self.claim / self.generation / (role + '.tmp')):
                raise ValueError('partial launcher publication')
            envelope = checked_read(role + '.json')
            if (not isinstance(envelope, dict) or
                {key: envelope.get(key) for key in expected} != expected or
                type(envelope.get('source_files')) is not int or
                envelope['source_files'] != expected_source_files or
                envelope.get('source_hashes') != expected_source_hashes):
                raise ValueError('wrong launcher envelope')
            proposal = {key: envelope.get(key) for key in (*expected, 'proposals', 'submission')}
            answer = self._submit(proposal, role, isolation=envelope.get('isolation'))
            if not answer['ok']:
                raise ValueError('broker denied launcher envelope')
            return answer
        finally:
            for fd in reversed(opened):
                os.close(fd)

    def _serve(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                conn.settimeout(3)
                answer = {'ok': False}
                try:
                    _, uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    role = self.uid_roles.get(uid)
                    if role is not None:
                        raw = bytearray()
                        while len(raw) <= MAX_REQUEST and not raw.endswith(b'\n'):
                            chunk = conn.recv(min(65536, MAX_REQUEST + 1 - len(raw)))
                            if not chunk:
                                break
                            raw.extend(chunk)
                        if raw.endswith(b'\n') and len(raw) <= MAX_REQUEST:
                            data = json.loads(raw)
                            answer = self._submit(data, role)
                except (Exception, SystemExit):
                    pass
                try:
                    conn.sendall(json.dumps(answer).encode() + b'\n')
                except OSError:
                    pass

    def close(self):
        self.stop.set()
        if self.server is not None:
            self.server.close()
        if self.thread is not None:
            self.thread.join(timeout=3)
        if self.socket_path.is_socket():
            self.socket_path.unlink()
