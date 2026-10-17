#!/usr/bin/env python3
"""Experimental root broker consume of a registered turn; never applies or settles.

Invoked synchronously by the trusted Windows controller while it owns the live
claim lifecycle lock. A direct host hook self-test is necessary here but does
NOT prove Codex invokes that hook: the Linux OS sandbox remains the boundary.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path('/var/lib/mycelink-codex')
TOKEN = re.compile(r'[A-Za-z0-9_-]{1,100}\Z')
FEATURE = re.compile(r'[0-9a-f]{64}\Z')


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name('wsl-codex-' + name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hook_ready(control_root):
    # Execute the real host fence, not a caller-provided boolean. The check is
    # deliberately a DENY probe; a missing/failed hook can never enable seal.
    script = str(Path(__file__).resolve().parents[1] / 'dist' / 'mycelink.mjs')
    path = subprocess.run(['/usr/bin/wslpath', '-w', script], capture_output=True, text=True, timeout=5)
    if path.returncode:
        return False
    payload = json.dumps({'session_id': 'wsl-seal-selftest', 'turn_id': 'turn-1',
        'hook_event_name': 'PreToolUse', 'cwd': control_root, 'tool_name': 'apply_patch',
        'tool_input': {'command': '*** Begin Patch\n*** Add File: features/forbidden/STATE.json\n+{}\n*** End Patch'}})
    result = subprocess.run(['/mnt/c/Program Files/nodejs/node.exe', path.stdout.strip(), 'hook', 'controller-fence'],
        input=payload, capture_output=True, text=True, timeout=7)
    return result.returncode == 2 and result.stdout == '' and 'Blocked:' in result.stderr


def run(args):
    if os.geteuid() != 0 or not FEATURE.fullmatch(args.feature_token) or not TOKEN.fullmatch(args.claim) or not TOKEN.fullmatch(args.generation):
        raise ValueError('trusted root generation required')
    request = json.load(sys.stdin)
    if not isinstance(request, dict) or set(request) != {'allowed_paths', 'source_hashes'}:
        raise ValueError('trusted controller manifest required')
    paths, hashes = request['allowed_paths'], request['source_hashes']
    if not isinstance(paths, list) or not isinstance(hashes, dict) or len(set(paths)) != len(paths):
        raise ValueError('invalid grant or source')
    process = load('process')
    broker_module = load('broker')
    sealed = ROOT / 'seals' / args.feature_token / args.claim / args.generation
    # Every component is a root-owned, non-replaceable directory. PolicyBroker
    # checks ownership and parents again before it opens any role slot.
    for directory in (ROOT / 'seals', sealed.parent.parent, sealed.parent, sealed):
        directory.mkdir(mode=0o700, exist_ok=True)
    def current():
        return process.result(args.feature_token, args.claim, args.generation) == {'exit_code': 0, 'revoked': False}
    broker = broker_module.PolicyBroker(sealed, claim=args.claim, generation=args.generation,
        allowed_paths=frozenset(paths), current=current, hook_ready=lambda: hook_ready(args.control_root))
    broker.consume_transport(ROOT / 'transport', 'worker', expected_source_files=len(hashes), expected_source_hashes=hashes)
    with (sealed / 'worker' / '_receipt.json').open() as receipt:
        print(json.dumps(json.load(receipt)))


def main():
    parser = argparse.ArgumentParser()
    for name in ('feature-token', 'claim', 'generation', 'control-root'):
        parser.add_argument('--' + name, required=True)
    run(parser.parse_args())


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        print('WSL_CODEX_BROKER_DENIED: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
