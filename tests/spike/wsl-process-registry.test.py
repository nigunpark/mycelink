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

    def test_detached_start_returns_registered_ready_receipt_before_turn_finishes(self):
        token, claim, generation = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
        try:
            begun = time.monotonic()
            launched = subprocess.run(['python3', str(SCRIPT), 'start', token, claim, generation,
                                       '--', '/bin/sleep', '60'], text=True, capture_output=True, timeout=10)
            self.assertEqual(launched.returncode, 0, launched.stderr)
            self.assertLess(time.monotonic() - begun, 5)
            record = json.loads(launched.stdout)
            self.assertEqual((record['claim'], record['generation']), (claim, generation))
            self.assertTrue(Path(f"/proc/{record['pid']}").exists())
            queried = subprocess.run(['python3', str(SCRIPT), 'status', token, claim, generation],
                                     text=True, capture_output=True, timeout=10)
            self.assertEqual(queried.returncode, 0, queried.stderr)
            self.assertEqual(json.loads(queried.stdout), {'active': True})
            stopped = subprocess.run(['python3', str(SCRIPT), 'revoke', token], text=True, capture_output=True, timeout=12)
            self.assertEqual(stopped.returncode, 0, stopped.stderr)
            self.assertFalse(Path(f"/proc/{record['pid']}").exists())
            finished = subprocess.run(['python3', str(SCRIPT), 'status', token, claim, generation],
                                      text=True, capture_output=True, timeout=10)
            self.assertEqual(finished.returncode, 0, finished.stderr)
            self.assertEqual(json.loads(finished.stdout), {'active': False})
        finally:
            subprocess.run(['python3', str(SCRIPT), 'revoke', token], capture_output=True, timeout=12)

    def test_supervisor_records_terminated_command_exit_without_trusting_worker_report(self):
        token, claim, generation = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
        launched = subprocess.run(['python3', str(SCRIPT), 'start', token, claim, generation,
                                   '--', '/bin/sh', '-c', 'exit 17'], text=True, capture_output=True, timeout=10)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        for _ in range(100):
            observed = subprocess.run(['python3', str(SCRIPT), 'result', token, claim, generation],
                                      text=True, capture_output=True, timeout=10)
            if observed.returncode == 0:
                break
            time.sleep(.03)
        self.assertEqual(observed.returncode, 0, observed.stderr)
        self.assertEqual(json.loads(observed.stdout), {'exit_code': 17, 'revoked': False})
        self.assertEqual(json.loads(subprocess.check_output(['python3', str(SCRIPT), 'result', token, claim, generation])),
                         {'exit_code': 17, 'revoked': False})

    def test_supervisor_does_not_attest_success_while_background_group_child_survives(self):
        token, claim, generation = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
        marker = REGISTRY / token / 'background.pid'
        launched = subprocess.run(['python3', str(SCRIPT), 'start', token, claim, generation,
                                   '--', '/bin/sh', '-c', f'sleep 60 & echo $! > {marker}; exit 0'],
                                  text=True, capture_output=True, timeout=10)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        for _ in range(100):
            observed = subprocess.run(['python3', str(SCRIPT), 'result', token, claim, generation],
                                      text=True, capture_output=True)
            if observed.returncode == 0:
                break
            time.sleep(.03)
        try:
            self.assertEqual(observed.returncode, 0, observed.stderr)
            self.assertEqual(json.loads(observed.stdout), {'exit_code': 1, 'revoked': False})
            pid = int(marker.read_text())
            self.assertFalse(Path(f'/proc/{pid}').exists() and Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].strip().split()[0] != 'Z')
        finally:
            if marker.exists():
                pid = int(marker.read_text())
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                marker.unlink()

    def test_result_refuses_unfinished_and_unregistered_generation(self):
        token, claim, generation = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
        fresh = subprocess.run(['python3', str(SCRIPT), 'result', token, claim, generation], capture_output=True)
        self.assertNotEqual(fresh.returncode, 0)
        try:
            launched = subprocess.run(['python3', str(SCRIPT), 'start', token, claim, generation,
                                       '--', '/bin/sleep', '60'], text=True, capture_output=True, timeout=10)
            self.assertEqual(launched.returncode, 0, launched.stderr)
            running = subprocess.run(['python3', str(SCRIPT), 'result', token, claim, generation], capture_output=True)
            self.assertNotEqual(running.returncode, 0)
            self.assertEqual(subprocess.run(['python3', str(SCRIPT), 'revoke', token], capture_output=True).returncode, 0)
            ended = subprocess.run(['python3', str(SCRIPT), 'result', token, claim, generation],
                                   text=True, capture_output=True)
            self.assertEqual(ended.returncode, 0, ended.stderr)
            self.assertEqual(json.loads(ended.stdout), {'exit_code': 1, 'revoked': True})
        finally:
            subprocess.run(['python3', str(SCRIPT), 'revoke', token], capture_output=True, timeout=12)

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
