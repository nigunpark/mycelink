"""Opt-in real Windows -> WSL -> hostile worker channel check, not dispatch authorization."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == 'win32' and os.environ.get('MYCELINK_LIVE_WSL_WORKER') == '1',
                     'requires explicit Windows/WSL opt-in')
class WindowsCrossingTest(unittest.TestCase):
    def test_windows_secret_environment_and_host_paths_do_not_cross_worker(self):
        def linux_path(path):
            done = subprocess.run(['wsl.exe', '-d', 'Ubuntu', '-u', 'root', '--',
                                   'wslpath', '-u', str(path).replace('\\', '/')], capture_output=True, text=True, timeout=10)
            self.assertEqual(done.returncode, 0, done.stderr)
            return done.stdout.strip()

        scratch = pathlib.Path(os.environ['TMPDIR'])
        with tempfile.TemporaryDirectory(prefix='mycelink-windows-crossing-', dir=scratch) as temp:
            base = pathlib.Path(temp)
            source = base / 'source'
            source.mkdir()
            (source / 'public.txt').write_text('PUBLIC', encoding='utf-8')
            report = base / 'report.json'
            secret = 'CROSSING_' + uuid.uuid4().hex
            env = os.environ.copy()
            env['CROSSING_SECRET'] = secret
            env['WSLENV'] = (env.get('WSLENV', '') + ':CROSSING_SECRET/u').strip(':')
            probe = '''import json,os,pathlib,sys
p=pathlib.Path('/proposal/observation.json')
p.write_text(json.dumps({'secret':os.environ.get('CROSSING_SECRET'),
 'wslenv':os.environ.get('WSLENV'), 'interop':os.environ.get('WSL_INTEROP'),
 'host':pathlib.Path('/mnt/c').exists(), 'init':pathlib.Path('/init').exists(),
 'stdin':sys.stdin.buffer.read(1).decode(),
 'fds':[int(x.name) for x in pathlib.Path('/proc/self/fd').iterdir() if x.name.isdigit() and int(x.name)>2]}))'''
            launch = ['wsl.exe', '-d', 'Ubuntu', '-u', 'root', '--', 'python3',
                      linux_path(ROOT / 'scripts' / 'wsl-codex-worker.py'),
                      '--experimental-unrestricted-source', '--source', linux_path(source),
                      '--report', linux_path(report), '--claim', 'windows-crossing',
                      '--generation', 'g1', '--role', 'worker', '--', '/usr/bin/python3', '-c', probe]
            done = subprocess.run(launch, input=secret, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(done.returncode, 0, done.stderr.replace(secret, '<redacted>'))
            record = json.loads(report.read_text(encoding='utf-8'))
            observed = json.loads(record['proposals']['observation.json'])
            self.assertIsNone(observed['secret'])
            self.assertIsNone(observed['wslenv'])
            self.assertIsNone(observed['interop'])
            self.assertFalse(observed['host'])
            self.assertFalse(observed['init'])
            self.assertEqual(observed['stdin'], '')
            # Python may temporarily open its own /proc/self/fd enumerator; no inherited
            # Windows/WSL controller socket or high-numbered descriptor may survive.
            self.assertTrue(all(fd < 9 for fd in observed['fds']), observed['fds'])
            self.assertNotIn(secret, report.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
