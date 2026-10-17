"""Live root process lifecycle; run in WSL with explicit opt-in."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time
import unittest
import uuid
from unittest import mock
import importlib.util
import signal

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-process.py'
REGISTRY = Path('/var/lib/mycelink-codex/processes')

@unittest.skipUnless(os.geteuid() == 0 and os.environ.get('MYCELINK_LIVE_WSL_WORKER') == '1',
                     'requires explicit WSL root opt-in')
class ProcessRegistryTest(unittest.TestCase):
    def test_generation_bound_run_cancel_kills_linux_process_and_refuses_replay(self):
        token = uuid.uuid4().hex
        claim, generation = uuid.uuid4().hex, uuid.uuid4().hex
        run = subprocess.Popen(['python3', str(SCRIPT), 'run', token, claim, generation,
                                '--', '/bin/sleep', '60'], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True)
        try:
            ready, _, _ = select.select([run.stdout], [], [], 12)
            self.assertTrue(ready, 'supervisor failed to register')
            line = run.stdout.readline()
            if not line:
                self.fail(run.stderr.read())
            record = json.loads(line)
            self.assertEqual((record['claim'], record['generation']), (claim, generation))
            pid = record['pid']
            self.assertTrue(Path(f'/proc/{pid}').exists())
            slot = REGISTRY / token / f'{claim}-{generation}.json'
            self.assertTrue(slot.exists())
            self.assertEqual(slot.stat().st_uid, 0)
            cancelled = subprocess.run(['python3', str(SCRIPT), 'revoke', token],
                                       text=True, capture_output=True, timeout=12)
            self.assertEqual(cancelled.returncode, 0, cancelled.stderr)
            self.assertEqual(run.wait(timeout=12), 1)
            self.assertFalse(Path(f'/proc/{pid}').exists())
            self.assertFalse(slot.exists())
            replay = subprocess.run(['python3', str(SCRIPT), 'run', token, claim, generation,
                                     '--', '/bin/true'], text=True, capture_output=True, timeout=12)
            self.assertNotEqual(replay.returncode, 0)
            self.assertIn('generation already used', replay.stderr)
        finally:
            if run.poll() is None:
                run.kill()
                run.wait(timeout=5)
            subprocess.run(['python3', str(SCRIPT), 'revoke', token], capture_output=True, timeout=12)
            run.stdout.close()
            run.stderr.close()

    def test_registration_failure_does_not_leave_an_unregistered_live_process(self):
        spec = importlib.util.spec_from_file_location('registry_under_test', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        token, claim, generation = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
        original = subprocess.Popen
        children = []
        def start(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        try:
            with mock.patch.object(module.subprocess, 'Popen', side_effect=start), mock.patch.object(module, 'proc_start', return_value=None):
                with self.assertRaises(ValueError):
                    module.run(token, claim, generation, ['/bin/sleep', '30'])
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].poll(), 'registration failed but detached worker remains alive')
        finally:
            for child in children:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)

    def test_revoke_rejects_tampered_root_slot_without_signalling_unrelated_process(self):
        token = uuid.uuid4().hex
        slot_dir = REGISTRY / token
        slot_dir.mkdir(mode=0o700, parents=True)
        sleeper = subprocess.Popen(['/bin/sleep', '30'])
        try:
            (slot_dir / 'forged.json').write_text(json.dumps({'pid': sleeper.pid, 'start': 'forged',
                                                              'pgid': sleeper.pid}))
            refused = subprocess.run(['python3', str(SCRIPT), 'revoke', token],
                                     text=True, capture_output=True, timeout=12)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIsNone(sleeper.poll())
        finally:
            sleeper.terminate()
            sleeper.wait(timeout=5)
            (slot_dir / 'forged.json').unlink(missing_ok=True)
            (slot_dir / '.lock').unlink(missing_ok=True)
            slot_dir.rmdir()

if __name__ == '__main__':
    unittest.main()
