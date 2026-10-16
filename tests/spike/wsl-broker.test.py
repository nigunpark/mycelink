"""Root-owned policy broker: exercise the Unix peer identity, not prompt assertions."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

BROKER = Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-broker.py'
WORKER = pwd.getpwnam('mycelink-codex-worker').pw_uid
REVIEWER = pwd.getpwnam('mycelink-codex-reviewer').pw_uid


def module():
    spec = importlib.util.spec_from_file_location('codex_broker', BROKER)
    instance = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(instance)
    return instance


class BrokerTest(unittest.TestCase):
    def setUp(self):
        if os.geteuid() != 0:
            self.skipTest('requires trusted WSL root broker')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o711)
        self.assertTrue(BROKER.is_file(), 'generation-bound broker is not implemented')
        self.current = True
        self.hook = True
        self.broker = module().PolicyBroker(self.root, claim='c1', generation='g1',
            allowed_paths=frozenset({'src/a.txt'}), current=lambda: self.current,
            hook_ready=lambda: self.hook)
        self.broker.start()
        self.addCleanup(self.broker.close)

    def request(self, uid, data):
        # The server must obtain UID from SO_PEERCRED; the JSON never grants it.
        script = ('import json,socket,sys; s=socket.socket(socket.AF_UNIX); '
                  's.connect(sys.argv[1]); s.sendall(json.dumps(json.loads(sys.argv[2])).encode()+b"\\n"); '
                  'print(s.makefile("rb").readline().decode())')
        def drop():
            os.setgroups([])
            os.setgid(pwd.getpwuid(uid).pw_gid)
            os.setuid(uid)
        child = subprocess.run([sys.executable, '-c', script, str(self.broker.socket_path),
                                json.dumps(data)], text=True, capture_output=True,
                               preexec_fn=drop, timeout=5)
        self.assertEqual(child.returncode, 0, child.stderr)
        return json.loads(child.stdout)

    def test_worker_can_only_seal_exact_path_into_own_result_slot(self):
        answer = self.request(WORKER, {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
            'proposals': {'src/a.txt': 'NEW'}, 'submission': {'status': 'DONE'}})
        self.assertEqual(answer, {'ok': True})
        slot = self.root / 'worker'
        self.assertEqual((slot / 'src/a.txt').read_text(), 'NEW')
        self.assertEqual((slot / 'result.json').read_text(), '{"status":"DONE"}')
        self.assertFalse((slot / 'verdict.json').exists())
        self.assertEqual(self.request(WORKER, {'claim': 'c1', 'generation': 'g1',
            'role': 'worker', 'proposals': {}, 'submission': {}}), {'ok': False})

    def test_reviewer_slot_is_independent_and_role_is_not_self_asserted(self):
        forged = {'claim': 'c1', 'generation': 'g1', 'role': 'reviewer',
                  'proposals': {}, 'submission': {'verdict': 'PASS'}}
        self.assertEqual(self.request(WORKER, forged), {'ok': False})
        self.assertFalse((self.root / 'reviewer').exists())
        self.assertEqual(self.request(REVIEWER, forged), {'ok': True})
        self.assertTrue((self.root / 'reviewer' / 'verdict.json').exists())
        self.assertFalse((self.root / 'reviewer' / 'result.json').exists())
        self.assertEqual(self.request(0, {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
            'proposals': {}, 'submission': {}}), {'ok': False})

    def test_revoked_generation_and_failed_hook_deny_without_slot(self):
        request = {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                   'proposals': {}, 'submission': {}}
        for change in ('current', 'hook'):
            setattr(self, change, False)
            self.assertEqual(self.request(WORKER, request), {'ok': False})
            self.assertFalse((self.root / 'worker').exists())
            setattr(self, change, True)
        for key, value in (('generation', 'g0'), ('claim', 'other'), ('role', 'reviewer')):
            wrong = dict(request, **{key: value})
            self.assertEqual(self.request(WORKER, wrong), {'ok': False})
        self.assertFalse((self.root / 'worker').exists())

    def test_alias_and_parent_traversal_denied_even_if_allowlisted(self):
        request = {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                   'submission': {}, 'proposals': {'src/a.txt': 'OK', 'src/../a.txt': 'BAD'}}
        self.assertEqual(self.request(WORKER, request), {'ok': False})
        self.assertFalse((self.root / 'worker').exists())
        self.assertEqual(self.request(WORKER, dict(request, proposals={'SRC/A.TXT': 'BAD'})), {'ok': False})

    def test_broker_checks_live_generation_after_validation(self):
        request = {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                   'submission': {}, 'proposals': {}}
        original = self.broker.validate
        def revoke(data, role):
            result = original(data, role)
            self.current = False
            return result
        self.broker.validate = revoke
        self.assertEqual(self.request(WORKER, request), {'ok': False})
        self.assertFalse((self.root / 'worker').exists())
    def test_hook_exception_and_broker_shutdown_fail_closed(self):
        self.broker.hook_ready = lambda: (_ for _ in ()).throw(RuntimeError('hook absent'))
        request = {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                   'submission': {}, 'proposals': {}}
        self.assertEqual(self.request(WORKER, request), {'ok': False})
        self.assertFalse((self.root / 'worker').exists())
        self.broker.close()
        with self.assertRaises((ConnectionRefusedError, FileNotFoundError)):
            with socket.socket(socket.AF_UNIX) as channel:
                channel.connect(str(self.broker.socket_path))

    def test_parallel_worker_submissions_publish_at_most_one_slot(self):
        request = {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                   'submission': {'status': 'DONE'}, 'proposals': {'src/a.txt': 'NEW'}}
        answers = []
        threads = [threading.Thread(target=lambda: answers.append(self.request(WORKER, request)))
                   for _ in range(6)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=10)
        self.assertEqual(answers.count({'ok': True}), 1)
        self.assertEqual(answers.count({'ok': False}), 5)
        self.assertEqual((self.root / 'worker' / 'src/a.txt').read_text(), 'NEW')

    def test_generation_revoked_during_seal_does_not_publish_slot(self):
        actual = self.broker.__class__._serve.__globals__['POLICY']
        original = actual.seal
        def revoke_after_seal(*args, **kwargs):
            result = original(*args, **kwargs)
            self.current = False
            return result
        actual.seal = revoke_after_seal
        self.addCleanup(setattr, actual, 'seal', original)
        request = {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                   'submission': {}, 'proposals': {}}
        self.assertEqual(self.request(WORKER, request), {'ok': False})
        self.assertFalse((self.root / 'worker').exists())

    def test_private_transport_requires_pending_final_and_selected_role(self):
        transport = self.root / 'transport'
        transport.mkdir(mode=0o700)
        generation = transport / 'c1' / 'g1'
        generation.mkdir(parents=True, mode=0o700)
        (transport / 'c1').chmod(0o700)
        envelope = {'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                    'source_files': 0, 'source_hashes': {}, 'proposals': {'src/a.txt': 'TRANSPORT'},
                    'submission': {'status': 'DONE'}}
        with self.assertRaises(ValueError):
            self.broker.consume_transport(transport, 'worker', expected_source_files=0, expected_source_hashes={})
        (generation / 'worker.pending').write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': 'worker'}))
        (generation / 'worker.pending').chmod(0o600)
        with self.assertRaises(ValueError):
            self.broker.consume_transport(transport, 'worker', expected_source_files=0, expected_source_hashes={})
        (generation / 'worker.json').write_text(json.dumps(envelope))
        (generation / 'worker.json').chmod(0o600)
        self.assertEqual(self.broker.consume_transport(transport, 'worker', expected_source_files=0, expected_source_hashes={}), {'ok': True})
        self.assertEqual((self.root / 'worker' / 'src/a.txt').read_text(), 'TRANSPORT')
        with self.assertRaises(ValueError):
            self.broker.consume_transport(transport, 'worker', expected_source_files=0, expected_source_hashes={})
        with self.assertRaises(ValueError):
            self.broker.consume_transport(transport, 'reviewer', expected_source_files=0, expected_source_hashes={})

    def test_transport_symlink_and_case_alias_are_denied(self):
        transport = self.root / 'transport'
        generation = transport / 'c1' / 'g1'
        generation.mkdir(parents=True, mode=0o700)
        transport.chmod(0o700)
        (transport / 'c1').chmod(0o700)
        pending = generation / 'worker.pending'
        pending.write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': 'worker'}))
        pending.chmod(0o600)
        target = generation / 'other.json'
        target.write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': 'worker',
            'source_files': 0, 'source_hashes': {}, 'proposals': {'SRC/A.TXT': 'BAD'}, 'submission': {}}))
        target.chmod(0o600)
        (generation / 'worker.json').symlink_to(target)
        with self.assertRaises(ValueError):
            self.broker.consume_transport(transport, 'worker', expected_source_files=0, expected_source_hashes={})
        self.assertFalse((self.root / 'worker').exists())
        (generation / 'worker.json').unlink()
        target.rename(generation / 'worker.json')
        with self.assertRaises(ValueError):
            self.broker.consume_transport(transport, 'worker', expected_source_files=0, expected_source_hashes={})
        self.assertFalse((self.root / 'worker').exists())

    def test_root_rejects_case_aliased_grant_before_socket_creation(self):
        with self.assertRaises(ValueError):
            module().PolicyBroker(self.root, claim='c2', generation='g2',
                allowed_paths=frozenset({'src/a.txt', 'SRC/A.TXT'}),
                current=lambda: True, hook_ready=lambda: True)


if __name__ == '__main__':
    unittest.main()
