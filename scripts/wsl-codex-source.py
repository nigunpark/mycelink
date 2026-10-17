#!/usr/bin/env python3
"""Experimental root-private staging of controller-supplied immutable Git bytes."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile

BASE = Path('/var/lib/mycelink-codex/claims')
TOKEN = re.compile(r'[A-Za-z0-9_-]{1,100}\Z')
NAME = re.compile(r'[A-Za-z0-9_./-]{1,240}\Z')


def stage():
    request = json.load(sys.stdin)
    if set(request) != {'claim', 'generation', 'files', 'hashes'} or not all(
            isinstance(request[t], str) and TOKEN.fullmatch(request[t]) for t in ('claim', 'generation')):
        raise ValueError('unsafe claim binding')
    files, hashes = request['files'], request['hashes']
    if not isinstance(files, dict) or not files or len(files) > 4096 or set(files) != set(hashes):
        raise ValueError('invalid exact source manifest')
    if len({name.casefold() for name in files}) != len(files):
        raise ValueError('case-aliased source')
    decoded = {}
    total = 0
    for name, payload in files.items():
        if not isinstance(name, str) or not NAME.fullmatch(name) or any(
                not p or p.startswith('.') or p.endswith(('.', ' ')) for p in name.split('/')):
            raise ValueError('unsafe source name')
        if not isinstance(payload, str):
            raise ValueError('invalid source encoding')
        raw = base64.b64decode(payload, validate=True)
        total += len(raw)
        if len(raw) > 2 * 1024 * 1024 or total > 32 * 1024 * 1024 or (
                not isinstance(hashes[name], str) or hashlib.sha256(raw).hexdigest() != hashes[name]):
            raise ValueError('source hash or budget mismatch')
        decoded[name] = raw
    info = BASE.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('untrusted WSL claim base')
    root = Path(tempfile.mkdtemp(prefix='source-', dir=BASE))
    try:
        root.chmod(0o700)
        source = root / 'snapshot'
        source.mkdir(mode=0o700)
        for name, raw in decoded.items():
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o400)
            with os.fdopen(fd, 'wb') as out:
                out.write(raw)
                out.flush()
                os.fsync(out.fileno())
        manifest = root / 'manifest.json'
        fd = os.open(manifest, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o400)
        with os.fdopen(fd, 'w') as out:
            json.dump(sorted(decoded), out)
            out.flush()
            os.fsync(out.fileno())
        for directory, _, _ in os.walk(source):
            handle = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            os.fsync(handle)
            os.close(handle)
        parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        os.fsync(parent_fd)
        os.close(parent_fd)
        print(json.dumps({'source': str(source), 'manifest': str(manifest)}))
    except BaseException:
        shutil.rmtree(root)
        raise


def remove(path):
    target = Path(path)
    if target.parent != BASE or not target.name.startswith('source-') or not TOKEN.fullmatch(target.name):
        raise ValueError('unsafe source cleanup target')
    info = target.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError('untrusted source cleanup target')
    shutil.rmtree(target)


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise ValueError('root controller only')
        if sys.argv[1:] == ['stage']:
            stage()
        elif len(sys.argv) == 3 and sys.argv[1] == 'remove':
            remove(sys.argv[2])
        else:
            raise ValueError('invalid source command')
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f'WSL source refused: {exc}', file=sys.stderr)
        sys.exit(1)
