#!/usr/bin/env python3
"""Experimental root-owned WSL proposal seal/apply/reconcile; not production dispatch.

Controller supplies exact allowed file names; globs must be expanded by the
existing Mycelink matcher in the trusted controller, not by this worker.
Root-owned result and reviewer verdict slots are distinct. A journal restores
an interrupted multi-file apply, but the real Orchestrator claim/gates/settle
protocol does not yet invoke this module; do not enable Codex preflight.
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


def seal(report_path, slot, *, claim, generation, role, allowed_paths, isolation=None):
    if isolation is not None and isolation != {
            'hostMountDenied': True, 'directEgressDenied': True, 'otherRoleSlotDenied': True}:
        raise ValueError('invalid root isolation observation')
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
        if isolation is not None:
            receipt['isolation'] = isolation
        (temporary / '_receipt.json').write_text(json.dumps(receipt, sort_keys=True))
        if slot.exists() or slot.is_symlink():
            raise ValueError('slot became occupied')
        os.rename(temporary, slot)
        return receipt
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def read_submission(slot, *, claim, generation, role):
    """Consume only a root-sealed, hash-matching result of this exact generation."""
    if role not in ('worker', 'reviewer'):
        raise ValueError('invalid submission role')
    name = 'result.json' if role == 'worker' else 'verdict.json'
    root = os.open(slot, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        root_info = os.fstat(root)
        if root_info.st_uid != 0 or root_info.st_mode & 0o022:
            raise ValueError('untrusted sealed slot')
        def read_checked(filename):
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > MAX_FILE:
                    raise ValueError('untrusted sealed file')
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    payload = stream.read(MAX_FILE + 1)
                if len(payload) > MAX_FILE:
                    raise ValueError('oversized sealed file')
                return payload
            finally:
                os.close(fd)
        receipt = json.loads(read_checked('_receipt.json'))
        if (receipt.get('claim'), receipt.get('generation'), receipt.get('role')) != (claim, generation, role):
            raise ValueError('stale or wrong-role sealed submission')
        payload = read_checked(name)
        if hashlib.sha256(payload).hexdigest() != receipt.get('submission_sha256'):
            raise ValueError('sealed submission hash mismatch')
        data = json.loads(payload)
        if not isinstance(data, dict):
            raise ValueError('sealed submission must be an object')
        return data
    finally:
        os.close(root)


def read_proposals(slot, *, claim, generation, allowed_paths, role='worker'):
    """Return exact root-sealed role bytes for trusted controller staging only.

    Pin every directory and file inode; never re-open a path following a link
    after verifying it. This is not an authorization to apply or settle.
    """
    root = os.open(slot, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(root)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('untrusted sealed slot')
        receipt_fd = os.open('_receipt.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        try:
            info = os.fstat(receipt_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > MAX_FILE:
                raise ValueError('untrusted sealed receipt')
            with os.fdopen(os.dup(receipt_fd), 'rb') as stream:
                receipt = json.loads(stream.read(MAX_FILE + 1))
        finally:
            os.close(receipt_fd)
        if role not in ('worker', 'reviewer') or (receipt.get('claim'), receipt.get('generation'), receipt.get('role')) != (claim, generation, role):
            raise ValueError('wrong generation or role')
        hashes = receipt.get('sha256')
        if (not isinstance(hashes, dict) or len(hashes) > 4096 or
            any(not safe_name(name) or name not in allowed_paths or
                not isinstance(digest, str) or re.fullmatch('[0-9a-f]{64}', digest) is None
                for name, digest in hashes.items())):
            raise ValueError('unallowed proposal receipt')
        proposals = {}
        for name, digest in hashes.items():
            directory = root
            opened = []
            try:
                for part in name.split('/')[:-1]:
                    directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    opened.append(directory)
                    info = os.fstat(directory)
                    if info.st_uid != 0 or info.st_mode & 0o022:
                        raise ValueError('untrusted proposal directory')
                fd = os.open(name.split('/')[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > MAX_FILE:
                        raise ValueError('untrusted proposal inode')
                    with os.fdopen(os.dup(fd), 'rb') as stream:
                        raw = stream.read(MAX_FILE + 1)
                    if len(raw) > MAX_FILE or len(raw) != info.st_size or hashlib.sha256(raw).hexdigest() != digest:
                        raise ValueError('sealed proposal changed')
                    proposals[name] = raw.decode('utf-8')
                finally:
                    os.close(fd)
            finally:
                for directory in reversed(opened):
                    os.close(directory)
        return proposals
    finally:
        os.close(root)


def read_root_receipt(slot, *, claim, generation, role):
    """Read only the root-generated receipt in the role-bound seal."""
    directory = os.open(slot, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.fstat(directory).st_uid != 0 or os.fstat(directory).st_mode & 0o022:
            raise ValueError('untrusted isolation slot')
        fd = os.open('_receipt.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > 512 * 1024:
                raise ValueError('untrusted isolation receipt')
            with os.fdopen(os.dup(fd), 'rb') as stream:
                receipt = json.loads(stream.read(512 * 1024 + 1))
            if (receipt.get('claim'), receipt.get('generation'), receipt.get('role')) != (claim, generation, role):
                raise ValueError('wrong isolation generation or role')
            return receipt
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def read_verified_turn(worker_slot, reviewer_slot, *, claim, generation, allowed_paths):
    """Both role-bound seals must agree before proposals enter controller memory."""
    worker = read_submission(worker_slot, claim=claim, generation=generation, role='worker')
    reviewer = read_submission(reviewer_slot, claim=claim, generation=generation, role='reviewer')
    if worker.get('status') != '0' or reviewer.get('verdict') != 'PASS':
        raise ValueError('worker or independent reviewer denied')
    proposals = read_proposals(worker_slot, claim=claim, generation=generation, allowed_paths=allowed_paths)
    if set(proposals) != set(allowed_paths):
        raise ValueError('worker proposal does not cover exact requested paths')
    if read_proposals(reviewer_slot, claim=claim, generation=generation, allowed_paths=allowed_paths, role='reviewer'):
        raise ValueError('reviewer proposed worker files')
    worker_receipt = read_root_receipt(worker_slot, claim=claim, generation=generation, role='worker')
    reviewer_receipt = read_root_receipt(reviewer_slot, claim=claim, generation=generation, role='reviewer')
    worker_isolation = worker_receipt.get('isolation')
    reviewer_isolation = reviewer_receipt.get('isolation')
    seals = {'worker': worker_receipt.get('submission_sha256'),
             'reviewer': reviewer_receipt.get('submission_sha256')}
    if any(not isinstance(value, str) or re.fullmatch('[0-9a-f]{64}', value) is None
           for value in seals.values()):
        raise ValueError('invalid root seal digest')
    if worker_isolation is None and reviewer_isolation is None:
        return {'proposals': proposals, 'worker': worker, 'reviewer': reviewer, 'seals': seals}
    expected = {'hostMountDenied': True, 'directEgressDenied': True, 'otherRoleSlotDenied': True}
    if worker_isolation != expected or reviewer_isolation != expected:
        raise ValueError('role isolation receipts disagree or do not deny access')
    return {'proposals': proposals, 'worker': worker, 'reviewer': reviewer, 'isolation': expected, 'seals': seals}


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def mark_apply(slot, name):
    fd = os.open(slot / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(slot)


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
    verified = []
    try:
        # Validate all staged bytes before creating even a destination directory.
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
            verified.append((name, contents))
        for name, contents in verified:
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
            try:
                prior_fd = os.open(name.split('/')[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                   dir_fd=parent_fd)
            except FileNotFoundError:
                prior = None
            else:
                try:
                    prior_info = os.fstat(prior_fd)
                    if not stat.S_ISREG(prior_info.st_mode) or prior_info.st_size > MAX_FILE:
                        raise ValueError('existing target cannot be safely restored')
                    with os.fdopen(os.dup(prior_fd), 'rb') as previous:
                        prior = previous.read(MAX_FILE + 1)
                    if len(prior) > MAX_FILE:
                        raise ValueError('existing target grew while staging')
                finally:
                    os.close(prior_fd)
            prepared.append((parent_fd, name.split('/')[-1], contents, prior))
        journal_file = slot / '_apply-journal.json'
        if journal_file.exists() or journal_file.is_symlink():
            raise ValueError('apply journal exists; reconcile before retrying')
        rollback_dir = slot / '_rollback'
        rollback_dir.mkdir(mode=0o700)
        journal = {'claim': claim, 'generation': generation, 'role': 'worker', 'entries': []}
        for index, (_, leaf, contents, prior) in enumerate(prepared):
            name = verified[index][0]
            old_digest = hashlib.sha256(prior).hexdigest() if prior is not None else None
            if prior is not None:
                fd = os.open(rollback_dir / str(index), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as backup:
                    backup.write(prior)
                    backup.flush()
                    os.fsync(backup.fileno())
            journal['entries'].append({'name': name, 'old_sha256': old_digest,
                                       'new_sha256': hashlib.sha256(contents).hexdigest(), 'index': index})
        staging = slot / ('_apply-journal-' + secrets.token_hex(12))
        with staging.open('x') as output:
            json.dump(journal, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.rename(staging, journal_file)
        sync_directory(slot)
        replaced = []
        try:
            for parent_fd, leaf, contents, prior in prepared:
                temporary = '.mycelink-stage-' + secrets.token_hex(12)
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=parent_fd)
                try:
                    with os.fdopen(fd, 'wb') as output:
                        output.write(contents)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, leaf, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                    replaced.append((parent_fd, leaf, prior))
                finally:
                    try:
                        os.unlink(temporary, dir_fd=parent_fd)
                    except FileNotFoundError:
                        pass
            mark_apply(slot, '_apply-committed')
        except OSError:
            # Only an in-process failure can be restored here. A crash between
            # replacements still requires a controller-owned journal/reconcile.
            for parent_fd, leaf, prior in reversed(replaced):
                if prior is None:
                    os.unlink(leaf, dir_fd=parent_fd)
                else:
                    temporary = '.mycelink-restore-' + secrets.token_hex(12)
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=parent_fd)
                    with os.fdopen(fd, 'wb') as output:
                        output.write(prior)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, leaf, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            mark_apply(slot, '_apply-restored')
            raise
    finally:
        for fd in reversed(open_dirs):
            os.close(fd)


def reconcile_apply(slot, destination, *, claim, generation, allowed_paths):
    """Restore a journaled but uncommitted apply after an interrupted controller."""
    if os.geteuid() != 0:
        raise ValueError('trusted root reconcile required')
    slot = pathlib.Path(slot)
    read_submission(slot, claim=claim, generation=generation, role='worker')
    if (slot / '_apply-committed').exists():
        return 'committed'
    if (slot / '_apply-restored').exists():
        return 'restored'
    path = slot / '_apply-journal.json'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > MAX_FILE:
            raise ValueError('invalid apply journal')
        with os.fdopen(os.dup(fd), 'rb') as journal_stream:
            journal = json.loads(journal_stream.read(MAX_FILE + 1))
    finally:
        os.close(fd)
    if (journal.get('claim'), journal.get('generation'), journal.get('role')) != (claim, generation, 'worker'):
        raise ValueError('stale apply journal')
    entries = journal.get('entries')
    if not isinstance(entries, list) or len(entries) > 4096:
        raise ValueError('invalid apply entries')
    receipt = json.loads((slot / '_receipt.json').read_text())
    hashes = receipt.get('sha256')
    if not isinstance(hashes, dict) or set(hashes) != {entry.get('name') for entry in entries}:
        raise ValueError('apply journal does not match sealed proposal')
    root_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    opened = [root_fd]
    restores = []
    try:
        # Preflight every backup and current destination before changing any.
        for position, entry in enumerate(entries):
            name = entry.get('name')
            if (not safe_name(name) or name not in allowed_paths or entry.get('index') != position or
                entry.get('new_sha256') != hashes.get(name)):
                raise ValueError('unsafe apply journal path or digest')
            prior_digest = entry.get('old_sha256')
            if prior_digest is not None and not isinstance(prior_digest, str):
                raise ValueError('invalid old digest')
            prior = None
            if prior_digest is not None:
                backup_fd = os.open(slot / '_rollback' / str(position), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    info = os.fstat(backup_fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > MAX_FILE:
                        raise ValueError('invalid rollback file')
                    with os.fdopen(os.dup(backup_fd), 'rb') as data:
                        prior = data.read(MAX_FILE + 1)
                    if hashlib.sha256(prior).hexdigest() != prior_digest:
                        raise ValueError('rollback bytes changed')
                finally:
                    os.close(backup_fd)
            parent_fd = root_fd
            for segment in name.split('/')[:-1]:
                parent_fd = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                opened.append(parent_fd)
            leaf = name.split('/')[-1]
            try:
                current_fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            except FileNotFoundError:
                current_digest = None
            else:
                try:
                    info = os.fstat(current_fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
                        raise ValueError('unsafe current destination')
                    with os.fdopen(os.dup(current_fd), 'rb') as data:
                        current_digest = hashlib.sha256(data.read(MAX_FILE + 1)).hexdigest()
                finally:
                    os.close(current_fd)
            if current_digest not in (prior_digest, entry['new_sha256']):
                raise ValueError('destination moved since interrupted apply')
            restores.append((parent_fd, leaf, prior, current_digest == prior_digest))
        for parent_fd, leaf, prior, already in reversed(restores):
            if already:
                continue
            if prior is None:
                os.unlink(leaf, dir_fd=parent_fd)
            else:
                temporary = '.mycelink-recover-' + secrets.token_hex(12)
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=parent_fd)
                with os.fdopen(fd, 'wb') as output:
                    output.write(prior)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, leaf, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        mark_apply(slot, '_apply-restored')
        return 'restored'
    finally:
        for fd in reversed(opened):
            os.close(fd)
