#!/usr/bin/env python3
"""Fail-closed staging of a generation-bound WSL proposal (not worktree apply).

Controller supplies exact allowed file names; globs must be expanded by the
existing Mycelink matcher in the trusted controller, not by this worker.
Result and reviewer verdict slots require separate protocol/ownership checks.
"""
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import stat
import tempfile

SAFE = re.compile(r'^[A-Za-z0-9_./-]+$')
MAX_REPORT = 36 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
RESERVED = {'result.json', 'verdict.json'}


def safe_name(path):
    if (not isinstance(path, str) or len(path) > 240 or not SAFE.fullmatch(path) or
        path.startswith('/') or any(segment in ('', '.', '..') or segment.startswith('.') or
        segment.endswith(('.', ' ')) for segment in path.split('/'))):
        return False
    parts = path.casefold().split('/')
    return not any(part in RESERVED | {'_receipt.json', 'mycelink'} for part in parts)


def seal(report_path, slot, *, claim, generation, role, allowed_paths):
    if os.geteuid() != 0 or role not in ('worker', 'reviewer'):
        raise ValueError('trusted principal and exact role required')
    report_path, slot = pathlib.Path(report_path), pathlib.Path(slot)
    if not slot.is_absolute() or slot.exists() or slot.is_symlink():
        raise ValueError('sealed slot must be new and absolute')
    parent = slot.parent
    parent_info = parent.lstat()
    if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != 0 or parent_info.st_mode & 0o022:
        raise ValueError('sealed slot parent must be private and root-owned')
    fd = os.open(report_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or
            info.st_size > MAX_REPORT):
            raise ValueError('report must be a single root-owned regular inode')
        with os.fdopen(os.dup(fd), 'rb') as input_file:
            raw = input_file.read(MAX_REPORT + 1)
        if len(raw) > MAX_REPORT:
            raise ValueError('report exceeds budget')
        data = json.loads(raw)
    finally:
        os.close(fd)
    if not isinstance(data, dict) or {key: data.get(key) for key in ('claim', 'generation', 'role')} != {
        'claim': claim, 'generation': generation, 'role': role}:
        raise ValueError('stale or mismatched claim/generation/role')
    proposals = data.get('proposals')
    if not isinstance(proposals, dict) or len(proposals) > 4096:
        raise ValueError('invalid proposal set')
    if role == 'reviewer' and proposals:
        raise ValueError('reviewer has no file proposal authority')
    if not all(safe_name(name) and name in allowed_paths and isinstance(value, str)
               and len(value.encode('utf-8')) <= MAX_FILE for name, value in proposals.items()):
        raise ValueError('proposal outside exact allowed paths or reserved ownership slot')
    if len({name.casefold() for name in proposals}) != len(proposals):
        raise ValueError('case-aliased proposal paths')
    submission = data.get('submission')
    if not isinstance(submission, dict):
        raise ValueError('missing role-owned result or verdict')
    submission_bytes = json.dumps(submission, sort_keys=True, separators=(',', ':')).encode('utf-8')
    if len(submission_bytes) > MAX_FILE:
        raise ValueError('role-owned submission exceeds budget')
    submission_name = 'result.json' if role == 'worker' else 'verdict.json'
    temporary = pathlib.Path(tempfile.mkdtemp(prefix='sealed-', dir=parent))
    hashes = {}
    try:
        for name, value in proposals.items():
            contents = value.encode('utf-8')
            target = temporary / name
            target.parent.mkdir(parents=True, exist_ok=True)
            file_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(file_fd, 'wb') as file:
                file.write(contents)
                file.flush()
                os.fsync(file.fileno())
            hashes[name] = hashlib.sha256(contents).hexdigest()
        submission_fd = os.open(temporary / submission_name,
                                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(submission_fd, 'wb') as output:
            output.write(submission_bytes)
            output.flush()
            os.fsync(output.fileno())
        receipt = {'claim': claim, 'generation': generation, 'role': role, 'sha256': hashes,
                   'submission_sha256': hashlib.sha256(submission_bytes).hexdigest()}
        (temporary / '_receipt.json').write_text(json.dumps(receipt, sort_keys=True))
        if slot.exists() or slot.is_symlink():
            raise ValueError('slot became occupied')
        os.rename(temporary, slot)
        return receipt
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def apply(slot, destination, *, claim, generation, allowed_paths):
    """Copy validated staged bytes to fresh inodes via directory FDs.

    Never open a destination file for writing: replace a hardlink/symlink
    directory entry atomically instead. No worker sees destination mounts.
    """
    if os.geteuid() != 0:
        raise ValueError('trusted root apply required')
    slot = pathlib.Path(slot)
    receipt = json.loads((slot / '_receipt.json').read_text())
    if (receipt.get('claim'), receipt.get('generation'), receipt.get('role')) != (claim, generation, 'worker'):
        raise ValueError('stale or wrong-owner receipt')
    hashes = receipt.get('sha256')
    if not isinstance(hashes, dict) or any(not safe_name(p) or p not in allowed_paths for p in hashes):
        raise ValueError('unallowed staged path')
    root_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    open_dirs = [root_fd]
    prepared = []
    try:
        # Finish ALL validation before touching any destination inode.
        for name, digest in hashes.items():
            fd = os.open(slot / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > MAX_FILE:
                    raise ValueError('invalid staged inode')
                with os.fdopen(os.dup(fd), 'rb') as data:
                    contents = data.read(MAX_FILE + 1)
                if hashlib.sha256(contents).hexdigest() != digest:
                    raise ValueError('staged bytes changed')
            finally:
                os.close(fd)
            parent_fd = root_fd
            for segment in name.split('/')[:-1]:
                try:
                    next_fd = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                      dir_fd=parent_fd)
                except FileNotFoundError:
                    os.mkdir(segment, 0o755, dir_fd=parent_fd)
                    next_fd = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                      dir_fd=parent_fd)
                open_dirs.append(next_fd)
                parent_fd = next_fd
            prepared.append((parent_fd, name.split('/')[-1], contents))
        for parent_fd, leaf, contents in prepared:
            temporary = '.mycelink-stage-' + secrets.token_hex(12)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=parent_fd)
            try:
                with os.fdopen(fd, 'wb') as output:
                    output.write(contents)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, leaf, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            finally:
                try:
                    os.unlink(temporary, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
    finally:
        for fd in reversed(open_dirs):
            os.close(fd)
