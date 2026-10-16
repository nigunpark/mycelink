"""Opt-in real launcher -> private transport -> root broker integration."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / 'scripts' / 'wsl-codex-worker.py'
BROKER = ROOT / 'scripts' / 'wsl-codex-broker.py'

@unittest.skipUnless(os.geteuid() == 0 and os.environ.get('MYCELINK_LIVE_WSL_WORKER') == '1', 'requires explicit WSL root opt-in')
class ClaimIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mycelink-claim-integration-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.source = self.root / 'source'
        (self.source / 'src').mkdir(parents=True)
        (self.source / 'src' / 'a.txt').write_text('ORIGINAL')
        self.manifest = self.root / 'source-files.json'
        self.manifest.write_text(json.dumps(['src/a.txt']))
        self.transport = self.root / 'transport'
        self.transport.mkdir(mode=0o700)
        self.broker_root = self.root / 'broker'
        self.broker_root.mkdir(mode=0o700)
        spec = importlib.util.spec_from_file_location('wsl_integration_broker', BROKER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.module = module
        self.current = True
        self.hook = True

    def launch(self, generation, command='mkdir -p /proposal/src; printf NEW > /proposal/src/a.txt; printf \'{"outcome":"DONE"}\' > /proposal/result.json', role='worker'):
        return subprocess.run(['python3', str(LAUNCHER), '--source', str(self.source), '--source-files', str(self.manifest),
            '--transport-dir', str(self.transport), '--claim', 'c1', '--generation', generation, '--role', role,
            '--', '/bin/sh', '-c', command], capture_output=True, text=True, timeout=30)

    def broker(self, generation='g1'):
        return self.module.PolicyBroker(self.broker_root, claim='c1', generation=generation,
            allowed_paths=frozenset({'src/a.txt'}), current=lambda: self.current,
            hook_ready=lambda: self.hook)

    def test_real_launcher_publication_has_expected_count_and_sealed_slot(self):
        run = self.launch('g1')
        self.assertEqual(run.returncode, 0, run.stderr)
        envelope = json.loads((self.transport / 'c1' / 'g1' / 'worker.json').read_text())
        self.assertEqual(envelope['source_files'], 1)
        expected_hashes = {'src/a.txt': hashlib.sha256(b'ORIGINAL').hexdigest()}
        broker = self.broker()
        self.assertEqual(broker.consume_transport(self.transport, 'worker', expected_source_files=1,
            expected_source_hashes=expected_hashes), {'ok': True})
        self.assertEqual((self.broker_root / 'worker' / 'src' / 'a.txt').read_text(), 'NEW')
        self.assertEqual((self.broker_root / 'worker' / 'result.json').read_text(), '{"outcome":"DONE"}')
        self.assertEqual((self.source / 'src' / 'a.txt').read_text(), 'ORIGINAL')
        self.assertFalse((self.broker_root / 'reviewer').exists())

    def test_failed_hook_and_stale_generation_do_not_seal_launcher_publication(self):
        run = self.launch('g1')
        self.assertEqual(run.returncode, 0, run.stderr)
        self.hook = False
        with self.assertRaises(ValueError):
            self.broker().consume_transport(self.transport, 'worker', expected_source_files=1,
                expected_source_hashes={'src/a.txt': hashlib.sha256(b'ORIGINAL').hexdigest()})
        self.assertFalse((self.broker_root / 'worker').exists())
        self.hook = True
        with self.assertRaises((ValueError, OSError)):
            self.broker('g2').consume_transport(self.transport, 'worker', expected_source_files=1,
                expected_source_hashes={'src/a.txt': hashlib.sha256(b'ORIGINAL').hexdigest()})
        self.assertFalse((self.broker_root / 'worker').exists())

    def test_manifest_count_mismatch_is_refused_before_sealing(self):
        run = self.launch('g1')
        self.assertEqual(run.returncode, 0, run.stderr)
        with self.assertRaises(ValueError):
            self.broker().consume_transport(self.transport, 'worker', expected_source_files=2,
                expected_source_hashes={'src/a.txt': hashlib.sha256(b'ORIGINAL').hexdigest(),
                                        'src/b.txt': hashlib.sha256(b'OTHER').hexdigest()})
        self.assertFalse((self.broker_root / 'worker').exists())

    def test_same_count_but_different_snapshot_bytes_cannot_be_sealed(self):
        run = self.launch('g1')
        self.assertEqual(run.returncode, 0, run.stderr)
        with self.assertRaises(ValueError):
            self.broker().consume_transport(self.transport, 'worker', expected_source_files=1,
                expected_source_hashes={'src/a.txt': hashlib.sha256(b'CHANGED').hexdigest()})
        self.assertFalse((self.broker_root / 'worker').exists())

    def test_reviewer_verdict_is_separately_launched_and_never_a_worker_proposal(self):
        source_hashes = {'src/a.txt': hashlib.sha256(b'ORIGINAL').hexdigest()}
        worker = self.launch('g1')
        self.assertEqual(worker.returncode, 0, worker.stderr)
        broker = self.broker()
        broker.consume_transport(self.transport, 'worker', expected_source_files=1,
            expected_source_hashes=source_hashes)
        reviewer = self.launch('g1', 'printf \'{"verdict":"PASS"}\' > /proposal/verdict.json', role='reviewer')
        self.assertEqual(reviewer.returncode, 0, reviewer.stderr)
        broker.consume_transport(self.transport, 'reviewer', expected_source_files=1,
            expected_source_hashes=source_hashes)
        self.assertEqual((self.broker_root / 'reviewer' / 'verdict.json').read_text(), '{"verdict":"PASS"}')
        self.assertFalse((self.broker_root / 'worker' / 'verdict.json').exists())
        self.assertFalse((self.broker_root / 'reviewer' / 'result.json').exists())
        self.assertFalse((self.broker_root / 'reviewer' / 'src' / 'a.txt').exists())

if __name__ == '__main__':
    unittest.main()
