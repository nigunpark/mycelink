"""Opt-in Windows claim -> WSL snapshot/transport/broker tracer, not dispatch.

The opt-in Vitest caller holds a dedicated Codex lifecycle mutex across this
tracer's launch and broker seal. It revalidates the host claim before entering;
this script still uses test-only always-true predicates and is NOT production
broker authorization, gate/apply/settle, or revocation of a running model.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]

def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--claim', required=True)
    parser.add_argument('--generation', required=True)
    parser.add_argument('--expected-sha256', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or os.environ.get('MYCELINK_LIVE_WSL_WORKER') != '1':
        raise ValueError('explicit WSL root opt-in required')
    name = 'tests/run.mjs'
    source = Path(args.source)
    if hashlib.sha256((source / name).read_bytes()).hexdigest() != args.expected_sha256:
        raise ValueError('controller source byte hash differs before snapshot')
    with tempfile.TemporaryDirectory(prefix='mycelink-bound-claim-') as temp:
        base = Path(temp)
        base.chmod(0o700)
        manifest = base / 'manifest.json'
        manifest.write_text(json.dumps([name]))
        transport = base / 'transport'
        transport.mkdir(mode=0o700)
        broker_root = base / 'broker'
        broker_root.mkdir(mode=0o700)
        command = ('test ! -e /mnt/c && test ! -e /init && '
                   'test -f /work/tests/run.mjs && '
                   'mkdir -p /proposal/src && '
                   'printf JOB_RESULT_V2 > /proposal/src/publish.js && '
                   'printf \'{"outcome":"DONE"}\' > /proposal/result.json')
        launched = subprocess.run(['python3', str(ROOT / 'scripts' / 'wsl-codex-worker.py'),
            '--source', str(source), '--source-files', str(manifest),
            '--transport-dir', str(transport), '--claim', args.claim,
            '--generation', args.generation, '--role', 'worker',
            '--', '/bin/sh', '-c', command], text=True, capture_output=True, timeout=30)
        if launched.returncode != 0:
            raise ValueError('isolated launch failed: ' + launched.stderr[:300])
        broker = load(ROOT / 'scripts' / 'wsl-codex-broker.py', 'cross_claim_broker').PolicyBroker(
            broker_root, claim=args.claim, generation=args.generation,
            allowed_paths=frozenset({'src/publish.js'}),
            current=lambda: True, hook_ready=lambda: True)
        broker.consume_transport(transport, 'worker', expected_source_files=1,
            expected_source_hashes={name: args.expected_sha256})
        policy = load(ROOT / 'scripts' / 'wsl-codex-policy.py', 'cross_claim_policy')
        submission = policy.read_submission(broker_root / 'worker', claim=args.claim,
            generation=args.generation, role='worker')
        if submission != {'outcome': 'DONE'} or (broker_root / 'worker' / 'src' / 'publish.js').read_text() != 'JOB_RESULT_V2':
            raise ValueError('sealed proposal differs from isolated output')
        if (source / 'src' / 'publish.js').exists():
            raise ValueError('isolated worker modified the real claim worktree')
        print(json.dumps({'claim': args.claim, 'generation': args.generation,
                          'sealed': True, 'source_unchanged': True}))

if __name__ == '__main__':
    try:
        run()
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f'crossing refused: {exc}', file=sys.stderr)
        sys.exit(1)
