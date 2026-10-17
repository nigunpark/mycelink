#!/usr/bin/env python3
"""Root-owned, write-once anchor for an experimental controller receipt.

The journal lives on DrvFS and is not independently authenticatable. This
anchor is recorded while the host claim is live, BEFORE settlement clears it.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path('/var/lib/mycelink-codex/settlements')
TOKEN = re.compile(r'[A-Za-z0-9_-]{1,100}\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')


def owned_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('unsafe settlement directory')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--feature-token', required=True)
    parser.add_argument('--claim', required=True)
    parser.add_argument('--generation', required=True)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0 or not DIGEST.fullmatch(args.feature_token) or not TOKEN.fullmatch(args.claim) or not TOKEN.fullmatch(args.generation):
        raise ValueError('invalid settlement identity')
    if args.write:
        import importlib.util
        process_path = Path(__file__).with_name('wsl-codex-process.py')
        spec = importlib.util.spec_from_file_location('wsl_codex_process', process_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if module.result(args.feature_token, args.claim, args.generation) != {'exit_code': 0, 'revoked': False}:
            raise ValueError('generation not completed')
        for directory in (ROOT.parent, ROOT, ROOT / args.feature_token, ROOT / args.feature_token / args.claim):
            directory.mkdir(mode=0o700, exist_ok=True)
            owned_directory(directory)
        content = json.load(sys.stdin)
        if not isinstance(content, dict) or set(content) != {'receiptSha256', 'resultSha256'} or not all(
            isinstance(value, str) and DIGEST.fullmatch(value) for value in content.values()
        ):
            raise ValueError('invalid settlement anchor')
        path = ROOT / args.feature_token / args.claim / (args.generation + '.json')
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(content, output, sort_keys=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
    else:
        for directory in (ROOT.parent, ROOT, ROOT / args.feature_token, ROOT / args.feature_token / args.claim):
            owned_directory(directory)
        path = ROOT / args.feature_token / args.claim / (args.generation + '.json')
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError('unsafe settlement anchor')
        with path.open() as source:
            content = json.load(source)
        if not isinstance(content, dict) or set(content) != {'receiptSha256', 'resultSha256'} or not all(
            isinstance(value, str) and DIGEST.fullmatch(value) for value in content.values()
        ):
            raise ValueError('invalid settlement anchor')
        print(json.dumps(content, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print('WSL_CODEX_SETTLEMENT_ANCHOR_DENIED: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
